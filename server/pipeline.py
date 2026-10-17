"""Pitchscape analysis pipeline: a song in, a pack (the page's data format) out.

Every detector here is an established, trained model. This file wires them together and measures a few plain
properties of what they found (how loud, how bright, how long a hit rings, how a note starts and fades):

  stems   Demucs htdemucs_6s (Meta, MIT)                drums / bass / other / vocals / guitar / piano
  drums   ADTOF Frame_RNN (Zehren et al., CC BY-NC-SA)  kick, snare, toms, hi-hat, cymbals, read from the drum stem
  notes   Basic Pitch (Spotify, Apache-2.0)             note events with pitch bends, read from the guitar, piano
                                                        and other stems separately; each note keeps its stem and
                                                        its bend curve, and a bend split across notes is rejoined
  bass    pYIN (librosa, ISC)                           pitch contour of the bass stem
  voice   CREPE (torchcrepe, MIT)                       pitch contour and periodicity of the vocal stem
  tone    MOSQITO (Eomys, Apache-2.0)                   roughness (Daniel & Weber) and sharpness (DIN 45692) of
                                                        every note, and of the voice and bass, on their own stems
  width   Glasberg & Moore's auditory filters          how wide each sound spreads along the ear (its excitation
                                                        pattern), from its own stem's spectrum at 70 dB SPL
  words   LRCLIB (lrclib.net)                           the song's published lyrics, found by its tags or file name
          Whisper (faster-whisper, MIT)                 when each of those words is sung, read from the vocal stem;
                                                        what Whisper hears is never shown, only used for timing

Usage (local, CPU is fine for testing):
  python -m server.pipeline SONG.mp3 OUT.json [--stems DIR_WITH_drums.wav_etc] [--device cpu|cuda] [--no-words]
"""
import argparse, base64, difflib, hashlib, json, math, os, re, subprocess, sys, tempfile, time, unicodedata
import urllib.error, urllib.parse, urllib.request

import numpy as np

SR = 22050                      # analysis rate of the page's frame grid
HOP = 512                       # 23.2 ms per frame, the page's dt
DT = HOP / SR
DB = 16                         # drum spectrum bands, log-spaced 30 Hz .. 11 kHz (must match DSP.DRUM_BANDS)
DRUM_BANDS = [30 * (SR / 2 / 30) ** (i / DB) for i in range(DB + 1)]
EVW, SEGW = 6 + DB, 17
NOTE_STEMS = ('other', 'guitar', 'piano')   # a note's source: its index here
TYPES = {'kick': 0, 'snare': 1, 'hat': 2, 'tom': 3, 'cymbal': 4}

# Every cutoff that decides whether something prints is applied by the page, from a Lab lever, so it can be tried
# out without analysing the song again. The server finds things down to these floors (the far end of each lever)
# and sends how certain or how loud each one was. The levers' defaults are the models' own settings.
DRUM_FLOOR = 0.6        # hits found down to 0.6x ADTOF's thresholds; each carries the multiple it passed at
HOLD_FLOOR = 0.15       # notes followed until Basic Pitch is under 15% sure they still sound (its default: 30%)
NOTE_MIN_MS = 50        # notes down to 50 ms (Basic Pitch's default here: 100)
VOICE_P_FLOOR = 0.15    # voice frames down to CREPE periodicity 0.15 (the default cutoff: 0.45)
VOICE_L_FLOOR = 0.01    # and down to 1% of the vocal stem's loud level (default 4%)
BASS_L_FLOOR = 0.02     # bass down to 2% of the bass stem's loud level (default 8%)


def log(*a):
    print(time.strftime('%H:%M:%S'), *a, file=sys.stderr, flush=True)


# ------------------------------------------------------------------ audio
def decode(path, sr, channels=2):
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', path, '-f', 'f32le', '-ac', str(channels), '-ar', str(sr), '-'],
                         capture_output=True, check=True).stdout
    return np.frombuffer(raw, dtype=np.float32).reshape(-1, channels).T.copy()


def to_rate(x, src, dst):
    import librosa
    return x if src == dst else librosa.resample(x, orig_sr=src, target_sr=dst, res_type='soxr_hq')


def b64f32(a):
    return base64.b64encode(np.asarray(a, dtype='<f4').tobytes()).decode('ascii')


def u8(a, lo, hi):
    """An array as bytes: 0..255 spread evenly over lo..hi (the page reads value = lo + byte * (hi - lo) / 255)."""
    q = np.clip(np.round((np.asarray(a, np.float64) - lo) / (hi - lo) * 255), 0, 255).astype(np.uint8)
    return {'data': base64.b64encode(q.tobytes()).decode('ascii'), 'lo': lo, 'hi': hi}


# ------------------------------------------------------------------ stems
def separate(mix44, device):
    """Demucs htdemucs_6s: (2, n) at 44.1 kHz in, {'drums','bass','other','vocals','guitar','piano': (2, n)} out."""
    import torch
    from demucs.apply import apply_model
    from demucs.pretrained import get_model
    model = get_model('htdemucs_6s').to(device).eval()
    wav = torch.from_numpy(mix44)
    ref = wav.mean(0)
    m, s = ref.mean(), ref.std() + 1e-8
    with torch.no_grad():
        out = apply_model(model, ((wav - m) / s)[None].to(device), device=device, shifts=1, split=True, overlap=0.25,
                          progress=False)[0]
    out = out.cpu() * s + m
    return {name: out[i].numpy() for i, name in enumerate(model.sources)}


# ------------------------------------------------------------------ drums
ADTOF_REPO, ADTOF_FILE = 'thebluescreen/adtof-drums-onnx', 'adtof_frame_rnn.onnx'
# model output order: bass drum, snare, toms, hi-hat, cymbals + ride. Thresholds are the authors' (model card).
ADTOF_OUT = [('kick', 0.22), ('snare', 0.24), ('tom', 0.32), ('hat', 0.22), ('cymbal', 0.30)]


def peak_pick(act, threshold, fps=100, pre_avg=0.1, post_avg=0.01, pre_max=0.02, post_max=0.01, combine=0.02):
    """madmom's NotePeakPickingProcessor (the procedure ADTOF's thresholds were tuned with), for one class. Returns
    the peaks and how far each rose above the moving average (what the threshold is compared with)."""
    from scipy.ndimage import maximum_filter1d, uniform_filter1d
    pa, po, pm, pq = (int(round(fps * v)) for v in (pre_avg, post_avg, pre_max, post_max))
    mov_avg = uniform_filter1d(act, pa + po + 1, mode='constant', origin=int(np.floor((pa - po) / 2))) if pa + po else 0
    det = act * (act >= mov_avg + threshold)
    if pm + pq:
        det = det * (det == maximum_filter1d(det, pm + pq + 1, mode='constant', origin=int(np.floor((pm - pq) / 2))))
    idx, kept, last = np.nonzero(det)[0], [], -1e9
    for i in idx:                                     # combine events closer than `combine`, keeping the first
        if (i - last) / fps > combine:
            kept.append(i)
            last = i
    kept = np.array(kept, dtype=int)
    return kept, (act - mov_avg)[kept] if len(kept) else np.zeros(0)


def drum_hits(drums44, model_path):
    import onnxruntime as ort
    mono = drums44.mean(0).astype(np.float32)
    sess = ort.InferenceSession(model_path, providers=[p for p in ('CUDAExecutionProvider', 'CPUExecutionProvider')
                                                      if p in ort.get_available_providers()])
    act = sess.run(None, {sess.get_inputs()[0].name: mono[None]})[0][0]          # (frames, 5) at 100 fps
    hits = []
    for c, (kind, thr) in enumerate(ADTOF_OUT):
        idx, rise = peak_pick(act[:, c], thr * DRUM_FLOOR)
        for i, r in zip(idx, rise):
            # margin: the multiple of ADTOF's threshold this hit still passes (1 or more: found at the default)
            hits.append((i / 100.0, kind, float(act[i, c]), float(r) / thr))
    hits.sort()
    return hits


def drum_details(hits, drums22):
    """Per hit: its own spectrum (what each band gained over the frames just before it, limited to the region its
    kind of drum occupies), how long it rings, its strength, and for kicks the pitch of the boom."""
    import librosa
    y = drums22.mean(0) if drums22.ndim > 1 else drums22
    hop, nfft = 256, 2048
    S = np.abs(librosa.stft(y, n_fft=nfft, hop_length=hop, center=True)) ** 2
    freqs = librosa.fft_frequencies(sr=SR, n_fft=nfft)
    E = np.stack([S[(freqs >= DRUM_BANDS[b]) & (freqs < DRUM_BANDS[b + 1])].sum(0) for b in range(DB)])
    centres = np.sqrt(np.array(DRUM_BANDS[:-1]) * np.array(DRUM_BANDS[1:]))
    region = {'kick': (0, 22050), 'snare': (120, 22050), 'tom': (50, 22050), 'hat': (1400, 22050), 'cymbal': (1400, 22050)}
    ring_band = {'kick': (30, 150), 'snare': (150, 6000), 'tom': (60, 1000), 'hat': (5000, 11025), 'cymbal': (3000, 11025)}
    nF = E.shape[1]
    by_kind = {}
    for t, kind, a, m in hits:
        by_kind.setdefault(kind, []).append(t)
    events = []
    for t, kind, a, margin in hits:
        f = min(nF - 1, int(round(t * SR / hop)))
        cur = np.maximum(E[:, f], E[:, min(nF - 1, f + 1)])
        before = np.maximum(E[:, max(0, f - 1)], E[:, max(0, f - 2)])
        gain = np.sqrt(np.clip(cur - before, 0, None))
        lo, hi = region[kind]
        gain[(centres < lo) | (centres > hi)] = 0
        prof = gain / gain.max() if gain.max() > 0 else gain
        r0, r1 = ring_band[kind]
        band = E[(centres >= r0) & (centres <= r1)].sum(0)
        peak = max(band[f], band[min(nF - 1, f + 1)])
        later = [x for x in by_kind[kind] if x > t + 0.01]
        stop = min(nF, int(round(later[0] * SR / hop)) if later else nF, f + int(1.0 * SR / hop))
        u = f + 2
        while u < stop and band[u] > 0.04 * peak:
            u += 1
        ring = (u - f) * hop / SR
        if kind == 'kick':
            seg = y[int((t + 0.04) * SR):int((t + 0.25) * SR)]
            hz = 52.0
            if len(seg) > 2048:
                f0 = librosa.yin(seg, fmin=30, fmax=200, sr=SR, frame_length=2048, hop_length=256)
                hz = float(np.median(f0)) if np.all(np.isfinite(f0)) else 52.0
        else:
            hz = float((prof * centres).sum() / prof.sum()) if prof.sum() > 0 else 1000.0
        strength = float(np.clip((a - 0.12) / 0.7, 0.15, 1.0))
        events.append([t, TYPES[kind], strength, hz, ring] + [float(v) for v in prof] + [margin])
    return events


# ------------------------------------------------------------------ helpers on a stem's spectrum
class Spec:
    """Magnitude spectrogram of one stem, with harmonic lookups."""

    def __init__(self, y, n_fft=4096, hop=HOP):
        import librosa
        self.hop, self.n_fft = hop, n_fft
        self.M = np.abs(librosa.stft(y, n_fft=n_fft, hop_length=hop, center=True))
        self.binhz = SR / n_fft

    def at(self, f, hz, width=1):
        """Peak magnitude within +-width bins of hz at frame f."""
        if f >= self.M.shape[1] or hz <= 0:
            return 0.0
        b = int(round(hz / self.binhz))
        if b < 1 or b >= self.M.shape[0] - 1:
            return 0.0
        return float(self.M[max(1, b - width):b + width + 1, f].max())

    def peak_hz(self, f, hz, width=2):
        """Parabolic-interpolated frequency of the strongest bin near hz at frame f."""
        b = int(round(hz / self.binhz))
        if b < 2 or b >= self.M.shape[0] - 2 or f >= self.M.shape[1]:
            return 0.0
        lo, hi = max(1, b - width), min(self.M.shape[0] - 2, b + width)
        k = lo + int(np.argmax(self.M[lo:hi + 1, f]))
        a, c, d = np.log(self.M[k - 1:k + 2, f] + 1e-12)
        den = a - 2 * c + d
        off = 0.5 * (a - d) / den if den < 0 else 0.0
        return (k + float(np.clip(off, -0.5, 0.5))) * self.binhz


def brightness(spec, f, hz, n=8, split=3):
    amps = [spec.at(f, k * hz) for k in range(1, n + 1)]
    tot = sum(amps)
    return sum(amps[split - 1:]) / tot if tot > 0 else 0.0


def env_follow(x, up=0.6, down=0.25):
    out, e = np.zeros_like(x), 0.0
    for i, v in enumerate(x):
        e += (up if v > e else down) * (v - e)
        out[i] = e
    return out


# ------------------------------------------------------------------ the ear
P_REF = 2e-5                 # 0 dB SPL, in pascals
EAR_DB = (1, 3, 10)          # widths are sent at these drops below the peak; the page's "ear width" lever reads between
EAR_SPAN = 16                # semitones either side of a sound that its spread is followed to


def erb(f):
    """The ear's filter bandwidth at f Hz (Glasberg & Moore 1990)."""
    return 24.7 * (4.37 * f / 1000 + 1)


class Ear:
    """Excitation patterns from one stem (Glasberg & Moore's roex auditory filters, with the lower skirt flattening as
    the level rises, Moore & Glasberg 1987; the spectrum read at the resolutions of ISO 532-2): how strongly each place
    along the ear is driven at a moment. A pure tone
    excites a band about one ERB wide; noise, wavering pitch or a very short sound spread its spectrum and so its
    excitation; a loud sound spreads upward. The stem is first set to the level it has in a 70 dB SPL mix."""

    # ISO 532-2 (Moore, Glasberg & Schlittenlacher): the spectrum is read with a window that shortens as frequency
    # rises, as the ear's own filters respond faster there: (from Hz, to Hz, window ms)
    BANDS = ((0, 80, 64), (80, 500, 32), (500, 1250, 16), (1250, 2540, 8), (2540, 4050, 4), (4050, SR / 2, 2))
    N = 4096

    def __init__(self, y22, gain):
        import librosa
        y = (y22 * gain).astype(np.float32)
        F = 1 + len(y) // HOP
        self.f = librosa.fft_frequencies(sr=SR, n_fft=self.N)
        self.P = np.zeros((len(self.f), F), np.float32)
        for lo, hi, ms in self.BANDS:
            L = int(round(ms / 1000 * SR)) // 2 * 2
            n = 1 << max(5, (L - 1).bit_length())
            # half a window, but at least once per page frame: the 64 ms window's 705 samples left a quarter of the
            # frames with nothing below 80 Hz
            hop = max(1, min(L // 2, HOP))
            w = np.hanning(L)
            X = np.abs(librosa.stft(y, n_fft=n, hop_length=hop, win_length=L, window=w, center=True))
            fb = librosa.fft_frequencies(sr=SR, n_fft=n)
            keep = (fb >= lo) & (fb < hi)
            # mean-square pressure per bin, scaled so a sine's main lobe sums to its power (Hann: 1.5 bins wide at
            # the window's own resolution, which a longer FFT samples n / L times as finely)
            Pw = (X[keep] * 2 / w.sum()) ** 2 / 2 / (1.5 * n / L)
            # averaged over each page frame (HOP samples centred on it)
            t = np.arange(Pw.shape[1]) * hop
            m = np.clip(np.round(t / HOP).astype(int), 0, F - 1)
            acc = np.zeros((Pw.shape[0], F))
            np.add.at(acc.T, m, Pw.T)
            cnt = np.maximum(1, np.bincount(m, minlength=F))
            # each of these bins lands on the nearest bin of the common grid (its power kept whole)
            idx = np.clip(np.round(fb[keep] / (SR / self.N)).astype(int), 0, len(self.f) - 1)
            np.add.at(self.P, idx, (acc / cnt).astype(np.float32))
        self.cum = np.cumsum(self.P, axis=0)

    def widths(self, frame, hz):
        """(down, up) in semitones from hz for each drop in EAR_DB: how far either side of the sound its excitation
        stays within that many dB of its peak, stopping where it rises again towards a neighbouring sound."""
        if frame >= self.P.shape[1] or not hz > 0:
            return [0.0] * (2 * len(EAR_DB))
        k = np.arange(-EAR_SPAN * 8, EAR_SPAN * 8 + 1)
        fc = hz * 2 ** (k / 96)
        lo, hi = np.searchsorted(self.f, [fc[0] / 1.6, min(fc[-1] * 1.6, SR / 2 - 1)])
        fi, Pi = self.f[lo:hi], self.P[lo:hi, frame].astype(np.float64)
        if len(fi) < 2 or Pi.sum() <= 0:
            return [0.0] * (2 * len(EAR_DB))
        # each component's level in dB SPL per ERB around it, which sets how far its excitation reaches upward
        c = self.cum[:, frame]
        e = erb(fi)
        a = np.clip(np.searchsorted(self.f, fi - e / 2) - 1, 0, len(c) - 1)
        b = np.clip(np.searchsorted(self.f, fi + e / 2), 0, len(c) - 1)
        X = 10 * np.log10((c[b] - c[a]) / P_REF ** 2 + 1e-12)
        return excitation_widths(fi, Pi, X, hz)

    def level(self, frame, hz):
        """The stem's level in dB SPL within one ERB around hz at a frame (as widths() reads each component's), or
        None where it is silent there."""
        if frame >= self.P.shape[1] or not hz > 0:
            return None
        c = self.cum[:, frame]
        e = erb(hz)
        a = int(np.clip(np.searchsorted(self.f, hz - e / 2) - 1, 0, len(c) - 1))
        b = int(np.clip(np.searchsorted(self.f, hz + e / 2), 0, len(c) - 1))
        p = c[b] - c[a]
        return float(10 * np.log10(p / P_REF ** 2 + 1e-12)) if p > 0 else None


def tone_widths(hz, level):
    """excitation_widths of a pure tone at hz and `level` dB SPL alone: how a note would spread along the ear on its
    own, with nothing else in its stem counted (a polyphonic stem's spectrum holds the whole chord, and gave every
    note in it the chord's width). The textbook roex response, without the spectral analysis' window leakage."""
    if not hz > 0 or level is None:
        return [0.0] * (2 * len(EAR_DB))
    return excitation_widths(np.array([float(hz)]), np.array([P_REF ** 2 * 10 ** (level / 10)]),
                             np.array([level], np.float32), hz)


def excitation_widths(fi, Pi, X, hz):
    """(down, up) in semitones from hz for each drop in EAR_DB of the excitation pattern of components at fi Hz with
    mean-square pressures Pi, each X dB SPL per ERB around it: how far either side of the sound the excitation stays
    within that many dB of its peak, stopping where it rises again towards a neighbouring sound."""
    k = np.arange(-EAR_SPAN * 8, EAR_SPAN * 8 + 1)
    fc = hz * 2 ** (k / 96)
    p51 = (4 * fc / erb(fc))[:, None]
    p51k = 4 * 1000 / erb(1000)
    below = fi[None, :] < fc[:, None]
    pl = np.maximum(0.1 * p51, p51 - 0.38 * (p51 / p51k) * (X[None, :] - 51))
    p = np.where(below, pl, p51)
    g = np.abs(fi[None, :] - fc[:, None]) / fc[:, None]
    W = (1 + p * g) * np.exp(-p * g)
    E = 10 * np.log10(W @ Pi / P_REF ** 2 + 1e-12)
    mid = EAR_SPAN * 8
    kp = mid - 8 + int(np.argmax(E[mid - 8:mid + 9]))          # the sound's own peak, within a semitone of it
    out = []
    for d in EAR_DB:
        floor = E[kp] - d
        j = kp
        while j > 0 and E[j - 1] >= floor and E[j - 1] <= E[j] + 0.5:
            j -= 1
        dn = (mid - j) / 8
        if j > 0 and E[j - 1] < floor and E[j] > E[j - 1]:
            dn += (E[j] - floor) / (E[j] - E[j - 1]) / 8
        j = kp
        while j < len(E) - 1 and E[j + 1] >= floor and E[j + 1] <= E[j] + 0.5:
            j += 1
        up = (j - mid) / 8
        if j < len(E) - 1 and E[j + 1] < floor and E[j] > E[j + 1]:
            up += (E[j] - floor) / (E[j] - E[j + 1]) / 8
        out += [max(0.0, dn), max(0.0, up)]
    return out


def ear_line(ear, hz, every=2, tone=False):
    """Widths for a pitch line (voice or bass), frame by frame: measured every `every` frames while it sounds and
    read between. With `tone`, a pure tone's at the line's pitch and the level its stem has there (tone_widths), as
    for notes. (F, 2 * len(EAR_DB))."""
    F = len(hz)
    out = np.zeros((F, 2 * len(EAR_DB)), np.float32)
    on = np.nonzero(hz > 0)[0]
    done = on[::every]
    for f in done:
        out[f] = tone_widths(float(hz[f]), ear.level(int(f), float(hz[f]))) if tone else ear.widths(int(f), float(hz[f]))
    for f in np.setdiff1d(on, done):
        a, b = f - 1, f + 1
        out[f] = (out[a] + out[b]) / 2 if b < F and hz[a] > 0 and hz[b] > 0 else out[a] if hz[a] > 0 else out[min(b, F - 1)]
    return out


# ------------------------------------------------------------------ bass
def bass_line(bass22, F):
    import librosa
    y = bass22.mean(0) if bass22.ndim > 1 else bass22
    f0, vflag, _ = librosa.pyin(y, fmin=30, fmax=400, sr=SR, frame_length=4096, hop_length=HOP, center=True)
    rms = librosa.feature.rms(y=y, frame_length=2048, hop_length=HOP, center=True)[0]
    n = min(F, len(f0), len(rms))
    ref = np.percentile(rms[:n], 98) + 1e-9
    bassN = np.zeros(F, np.float32)
    bassN[:n] = env_follow(np.minimum(1.2, rms[:n] / ref))
    bassHz = np.zeros(F, np.float32)
    # pYIN decides whether the bass sounds (its voicing is a decision over the whole line, not a cutoff on one
    # frame); how quiet a bass still prints is the page's (it hides bass under its "quietest bass" lever, 8%)
    ok = vflag[:n] & np.isfinite(f0[:n]) & (bassN[:n] >= BASS_L_FLOOR)
    bassHz[:n][ok] = f0[:n][ok]
    spec = Spec(y)
    br = np.zeros(F, np.float32)
    for f in np.nonzero(bassHz)[0]:
        br[f] = brightness(spec, f, bassHz[f], n=7, split=3)
    bassBr = np.zeros(F, np.float32)
    e = 0.0
    for f in range(F):
        e += 0.2 * (br[f] - e)
        bassBr[f] = e
    return bassN, bassHz, bassBr


# ------------------------------------------------------------------ voice
def voice_gate(per, rel, hz, p_min, l_min, run_min):
    """Which frames are sung: CREPE at least p_min sure of the pitch (periodicity), the vocal at least l_min of its
    loud level, in runs of at least run_min frames. The page applies the same rule from its levers."""
    v = np.isfinite(hz) & (per >= p_min) & (rel >= l_min)
    f, F = 0, len(v)
    while f < F:
        if v[f]:
            g = f
            while g < F and v[g]:
                g += 1
            if g - f < run_min:
                v[f:g] = False
            f = g
        else:
            f += 1
    return v


def voice_line(vocals44, F, device):
    import librosa, torch, torchcrepe
    v16 = to_rate(vocals44.mean(0), 44100, 16000).astype(np.float32)
    pitch, per = torchcrepe.predict(torch.from_numpy(v16)[None], 16000, 160, fmin=65, fmax=1100,
                                    model='full' if device != 'cpu' else 'tiny', batch_size=1024, device=device,
                                    return_periodicity=True)
    per = torchcrepe.filter.median(per, 3)
    pitch = torchcrepe.filter.mean(pitch, 3)
    pitch, per = pitch[0].cpu().numpy(), per[0].cpu().numpy()
    tf = np.arange(F) * DT
    idx = np.clip(np.round(tf / 0.01).astype(int), 0, len(pitch) - 1)
    hz, pr = pitch[idx], per[idx]
    y = to_rate(vocals44.mean(0), 44100, SR)
    rms = librosa.feature.rms(y=y, frame_length=2048, hop_length=HOP, center=True)[0]
    rms = np.pad(rms, (0, max(0, F - len(rms))))[:F]
    rel = (rms / (np.percentile(rms, 98) + 1e-9)).astype(np.float32)
    voiced = voice_gate(pr, rel, hz, 0.45, 0.04, 4)          # the page's default cutoffs, for the reference levels
    heard = np.isfinite(hz) & (pr >= VOICE_P_FLOOR) & (rel >= VOICE_L_FLOOR)
    ref = np.percentile(rms[voiced], 95) + 1e-9 if voiced.any() else 1.0
    leadHz = np.where(heard, hz, 0).astype(np.float32)
    leadP = np.where(heard, pr, 0).astype(np.float32)
    leadL = np.where(heard, rel, 0).astype(np.float32)
    leadN = np.where(heard, np.minimum(1.2, np.sqrt(rms / ref)), 0).astype(np.float32)
    leadNz = np.where(heard, 1 - pr, 0).astype(np.float32)
    spec = Spec(y)
    leadBr = np.zeros(F, np.float32)
    for f in np.nonzero(heard)[0]:
        leadBr[f] = brightness(spec, f, leadHz[f], n=10, split=4)
    noiseRef = [float(np.percentile(leadNz[voiced], 20)), float(np.percentile(leadNz[voiced], 90))] if voiced.any() else [0, 1]
    # syllable-ish onsets for placing pasted lyrics: the start of each sung run, plus onsets inside runs
    on_env = librosa.onset.onset_strength(y=y, sr=SR, hop_length=HOP)
    inner = set(librosa.onset.onset_detect(onset_envelope=on_env, sr=SR, hop_length=HOP).tolist())
    onsets, prev_end, f = [], -1e9, 0
    while f < F:
        if not voiced[f]:
            f += 1
            continue
        g = f
        while g < F and voiced[g]:
            g += 1
        onsets.append([f * DT, min(30.0, (f - prev_end) * DT), g * DT, 1.0])
        for k in range(f + 5, g - 3):
            if k in inner:
                onsets.append([k * DT, 0.0, g * DT, 0.7])
        prev_end, f = g, g
    return leadHz, leadP, leadL, leadN, leadBr, leadNz, noiseRef, onsets


# ------------------------------------------------------------------ notes
BP_BEND_BIAS = 1         # Basic Pitch reports an in-tune note's bend as +1 bin (1/3 semitone): measured on synthetic
                         # notes at exact MIDI pitches and on every steady note of the test song; taken off here


def fine_bends(contour, i0, n, pitch, tol=25, w=2):
    """A note's pitch, frame by frame, from Basic Pitch's contour output, in contour bins (thirds of a semitone) from
    its MIDI pitch's bin, as get_pitch_bends finds it (the peak of the contour under a Gaussian of 5 bins around the
    note) but read to a fraction of a bin: the salience-weighted mean over the peak and `w` bins either side, as
    CREPE decodes its own output (Kim et al. 2018). Basic Pitch's whole bins snap a note to thirds of a semitone (on
    synthetic tones 15 cents sharp read as in tune, 25 as 33); this reads them to a median of 1.5 cents (steady), 3
    (vibrato). Same bias as the whole bins (+1 bin: BP_BEND_BIAS)."""
    from scipy.signal.windows import gaussian
    c0 = int(round((pitch - 21) * 3))
    lo, hi = max(0, c0 - tol), min(contour.shape[1], c0 + tol + 1)
    g = gaussian(2 * tol + 1, std=5)[lo - (c0 - tol):hi - (c0 - tol)]
    out = []
    for f in range(i0, min(i0 + n, contour.shape[0])):
        s = contour[f, lo:hi].astype(np.float64)
        k = int(np.argmax(s * g))
        a, b = max(0, k - w), min(hi - lo, k + w + 1)
        ww = s[a:b]
        out.append(float(np.sum(np.arange(a, b) * ww) / ww.sum()) + lo - c0 if ww.sum() > 0 else float(k + lo - c0))
    return out


def raw_bends(t0, t1, bends, act):
    """Basic Pitch's bends for one note as (times, semitones from its MIDI pitch, how sure it is the note still
    sounds), unsmoothed: one value per model frame, evenly spread over the note; bends in thirds of a semitone."""
    if not bends:
        return np.array([t0, t1]), np.zeros(2), np.full(2, float(np.mean(act)) if len(act) else 1.0)
    b = (np.asarray(bends, np.float64) - BP_BEND_BIAS) / 3
    a = np.asarray(act, np.float64)[:len(b)]
    if len(a) < len(b):
        a = np.pad(a, (0, len(b) - len(a)), mode='edge') if len(a) else np.ones(len(b))
    return t0 + (t1 - t0) * (np.arange(len(b)) + 0.5) / len(b), b, a


def smooth_bend(m):
    """Lone outlier frames removed and the third-semitone steps smoothed (~35 ms)."""
    from scipy.ndimage import gaussian_filter1d, median_filter
    if len(m) >= 3:
        m = median_filter(m, size=3, mode='nearest')
    if len(m) >= 4:
        m = gaussian_filter1d(m, 1.5, mode='nearest')
    return m


def join_bends(notes, gap=0.15, near=0.75):
    """Basic Pitch ends a note when a bend carries it into the next semitone and starts another there (sometimes
    after losing it for a few frames). A note that starts within `gap` s of where one on another pitch ended, at the
    pitch that one had bent to by its last frame (within `near` semitones: a plain step to the next semitone is a
    whole one), is the same note still bending: they become one note, its bend running on. A note struck again at
    the same pitch stays two notes. Returns (t0, t1, MIDI pitch, amp, times, bend semitones from that pitch, how sure
    Basic Pitch is the note still sounds)."""
    out = []
    for t0, t1, pitch, amp, bends, act in sorted(notes, key=lambda n: n[0]):
        tb, cb, ab = raw_bends(t0, t1, bends, act)
        best, bd = None, near
        for a in out[-200:]:
            if a['t1'] < t0 - gap or a['t1'] > t0 + gap or a['t1'] > t1 or a['last'] == pitch:
                continue
            d = abs(a['m'][-1] - (pitch + cb[0]))
            if d <= bd:
                best, bd = a, d
        if best is None:
            out.append({'t0': t0, 't1': t1, 'pitch': pitch, 'last': pitch, 'amps': [(amp, t1 - t0)], 't': tb, 'm': pitch + cb, 'a': ab})
            continue
        keep = best['t'] < tb[0]
        best['t'] = np.concatenate([best['t'][keep], tb])
        best['m'] = np.concatenate([best['m'][keep], pitch + cb])
        best['a'] = np.concatenate([best['a'][keep], ab])
        best['t1'], best['last'] = t1, pitch
        best['amps'].append((amp, t1 - t0))
    res = []
    for a in out:
        w = sum(d for _, d in a['amps']) or 1.0
        res.append((a['t0'], a['t1'], a['pitch'], sum(v * d for v, d in a['amps']) / w, a['t'], smooth_bend(a['m']) - a['pitch'], a['a']))
    return res


def note_details(notes, other22):
    """Notes (t0, t1, MIDI pitch, amp, bend times, bend semitones) -> the page's note records: [t0, t1, midi, amp,
    brightness, noise, family, attack s, fade dB/s, vibrato depth st, vibrato rate Hz, hollowness, strength, curve]
    where midi is the note's typical pitch and curve its bend: [times], [semitones from midi]. Family: 0 struck,
    1 swell, 2 held. The harmonics are read along the bent pitch, frame by frame."""
    y = other22.mean(0) if other22.ndim > 1 else other22
    spec = Spec(y, n_fft=4096, hop=256)
    fps = SR / 256
    segs = []
    for t0, t1, pitch, amp, tb, cb, ab in notes:
        midi = pitch + float(np.median(cb))
        off = cb - (midi - pitch)
        fa, fb = int(t0 * fps), max(int(t0 * fps) + 2, int(t1 * fps))
        env, trk, br, nz, ev, od = [], [], [], [], 0.0, 0.0
        for f in range(fa, min(fb, spec.M.shape[1])):
            fm = midi + float(np.interp(f / fps, tb, off))
            f0 = 440 * 2 ** ((fm - 69) / 12)
            h = [spec.at(f, k * f0) for k in range(1, 9)]
            env.append(sum(h[:4]))
            tot = sum(h)
            br.append(sum(h[2:]) / tot if tot > 0 else 0)
            mid = [spec.at(f, (k + 0.5) * f0, 0) for k in range(1, 5)]
            nz.append(sum(mid) / (sum(h[:4]) + 1e-12))
            ev += h[1] + h[3] + h[5]
            od += h[2] + h[4] + h[6]
            k = int(np.argmax(h[:3])) + 1
            p = spec.peak_hz(f, k * f0)
            trk.append(12 * math.log2(p / k / 440) + 69 - fm if p > 0 else 0.0)
        env = np.array(env) if env else np.array([1.0])
        pk = int(np.argmax(env))
        k75 = int(np.argmax(env >= 0.75 * env[pk]))
        attack = (k75 + 1) / fps
        fade = 0.0
        if len(env) - pk >= 5:
            k6 = pk + int(round(0.6 * (len(env) - 1 - pk)))
            lv = env[max(pk, k6 - 1):k6 + 2].mean()
            fade = 20 * math.log10(lv / env[pk] + 1e-9) / max(1 / fps, (k6 - pk) / fps)
        vd = vr = 0.0
        if len(trk) >= 24:
            tr = np.array(trk)
            w = 9
            mu = np.convolve(np.pad(tr, w, mode='edge'), np.ones(2 * w + 1) / (2 * w + 1), mode='same')[w:-w]
            r = (tr - mu)[w:-w]
            depth = float(np.sqrt(np.mean(r ** 2)) * math.sqrt(2))
            rate = float(np.sum(r[1:] * r[:-1] < 0) / 2 / (len(r) / fps))
            if 0.1 <= depth < 1.5 and 3.5 <= rate <= 8.5:
                vd, vr = depth, rate
        dur = t1 - t0
        fam = 1 if attack >= 0.12 else 0 if (fade < -9 or dur < 0.35) else 2
        if fam == 0 and vd > 0:
            fam = 2
        hollow = 1 - min(1.0, 2 * ev / (ev + od)) if ev + od > 0 else 0.0
        segs.append([t0, t1, midi, amp, float(np.mean(br)) if br else 0.0,
                     float(np.mean(nz)) if nz else 0.0, fam, attack, fade, vd, vr, hollow, float(env[pk]), (tb, off, ab)])
    segs.sort(key=lambda s: s[0])
    return segs


def notes_by_stem(stems, st22):
    """Basic Pitch on each instrument stem. A note also found, much weaker, at the same pitch and time in another stem
    is that stem's leak and is dropped there; notes far below the song's level (bleed into a near-empty stem) go too.
    Records gain their stem's index (NOTE_STEMS) in place of the strength used for this, and keep their bend curve
    last."""
    found = []
    for i, name in enumerate(NOTE_STEMS):
        if name in stems:
            found += [r + [i] for r in note_details(join_bends(notes_from_stem(stems[name])), st22[name])]
    if not found:
        return []
    energy = np.array([r[12] for r in found])
    floor = 0.02 * np.percentile(energy, 95)
    found = [r for r in found if r[12] >= floor]
    found.sort(key=lambda r: r[0])
    drop = set()
    for i, a in enumerate(found):
        for j in range(i + 1, len(found)):
            b = found[j]
            if b[0] >= a[1]:
                break
            if a[14] == b[14] or abs(a[2] - b[2]) > 0.6:
                continue
            shared = min(a[1], b[1]) - max(a[0], b[0])
            if shared < 0.5 * min(a[1] - a[0], b[1] - b[0]):
                continue
            if a[12] < 0.5 * b[12]:
                drop.add(i)
            elif b[12] < 0.5 * a[12]:
                drop.add(j)
    kept = [r for k, r in enumerate(found) if k not in drop]
    aref = np.percentile([r[3] for r in kept], 95) + 1e-9
    return [r[:3] + [min(1.2, r[3] / aref)] + r[4:12] + [r[14], r[13]] for r in kept]


def pack_curves(segs, ears):
    """Each note through time on the page's frame grid (every DT s from t0 to t1): its bend, in semitones from its
    pitch; how sure Basic Pitch is that it still sounds (which the page's "note hold" lever cuts at); and how wide it
    spreads along the ear: a pure tone's excitation at its pitch and at the level its stem has there (tone_widths;
    every other sample, read between). Flat lists, and each note's (start, count) in all of them."""
    bends, holds, widths, where = [], [], [], []
    for r in segs:
        tb, off, ab = r[13]
        n = max(2, int(round((r[1] - r[0]) / DT)) + 1)
        tt = r[0] + (r[1] - r[0]) * np.arange(n) / (n - 1)
        where.append((len(bends), n))
        bv = np.interp(tt, tb, off)
        bends += bv.tolist()
        holds += np.interp(tt, tb, ab).tolist()
        ear, w = ears.get(NOTE_STEMS[int(r[12])]), np.zeros((n, 2 * len(EAR_DB)))
        if ear is not None:
            for j in range(0, n, 2):
                hz = 440 * 2 ** ((r[2] + bv[j] - 69) / 12)
                w[j] = tone_widths(hz, ear.level(int(round(tt[j] / DT)), hz))
            for j in range(1, n, 2):
                w[j] = (w[j - 1] + w[j + 1]) / 2 if j + 1 < n else w[j - 1]
        widths += w.reshape(-1).tolist()
    return bends, holds, widths, where


def notes_from_stem(other44):
    """Basic Pitch's notes, followed down to HOLD_FLOOR, each with how sure the model is, frame by frame, that it still
    sounds (its note activation at that pitch). Its amplitude is the mean of that over the frames above Basic Pitch's
    own default (0.3), so a note's weight does not change with how far down it was followed."""
    import soundfile as sf
    from basic_pitch import ICASSP_2022_MODEL_PATH
    from basic_pitch.inference import predict
    from basic_pitch.note_creation import model_frames_to_time
    # a file in a temporary folder, not a NamedTemporaryFile: Windows will not open a file by name while it is held open
    with tempfile.TemporaryDirectory() as tmpdir:
        wav = os.path.join(tmpdir, 'stem.wav')
        sf.write(wav, other44.T, 44100, subtype='FLOAT')
        out, _, events = predict(wav, ICASSP_2022_MODEL_PATH, onset_threshold=0.5, frame_threshold=HOLD_FLOOR,
                                 minimum_note_length=NOTE_MIN_MS, melodia_trick=True)
    note = out['note']
    times = model_frames_to_time(note.shape[0])
    res = []
    for a, b, p, v, bd in events:
        i0 = int(np.argmin(np.abs(times - a)))
        n = len(bd) if bd is not None else max(1, int(np.argmin(np.abs(times - b))) - i0)
        act = note[i0:i0 + n, int(p) - 21].astype(np.float64)
        top = act[act >= 0.3]
        res.append((float(a), float(b), int(p), float(np.mean(top)) if len(top) else float(v),
                    fine_bends(out['contour'], i0, n, int(p)) if bd is not None else None, act))
    return res


# ------------------------------------------------------------------ tone
TONE_SR, TONE_N = 48000, 9600       # MOSQITO's models run at 48 kHz on 200 ms slices
_TONE = {}


def _tone_init(paths):
    import warnings
    warnings.filterwarnings('ignore')
    for name, path in paths.items():
        _TONE[name] = np.load(path, mmap_mode='r')


def _tone_slice(job):
    """(stem, centre s) -> (roughness asper, sharpness acum) of a 200 ms slice; zeros for near silence."""
    from mosqito.sq_metrics import roughness_dw, sharpness_din_freq
    name, t = job
    x = _TONE[name]
    a = int(round(t * TONE_SR)) - TONE_N // 2
    if a < 0 or a + TONE_N > len(x):
        return 0.0, 0.0
    seg = np.array(x[a:a + TONE_N], dtype=np.float64)
    if np.sqrt(np.mean(seg ** 2)) < 2e-4:          # about 20 dB SPL
        return 0.0, 0.0
    r = float(np.mean(roughness_dw(seg, TONE_SR, overlap=0)[0]))
    w = np.hanning(TONE_N)
    spec = np.abs(np.fft.rfft(seg * w)) * 2 / w.sum() / math.sqrt(2)
    sh = float(np.squeeze(sharpness_din_freq(spec, np.fft.rfftfreq(TONE_N, 1 / TONE_SR))))
    return (r if math.isfinite(r) else 0.0), (sh if math.isfinite(sh) else 0.0)


def harshness(rough, sharp):
    """How harsh a sound is, 0 (smooth) to 1, from the two measures of it: roughness counts above 0.1 asper (a
    clearly grating sound by 0.4), sharpness above 1.75 acum (where it starts to annoy in Zwicker's model) to 3.
    The page does this itself, from its levers; this is the same rule at their defaults, for the stats."""
    r = min(1.0, max(0.0, (rough - 0.1) / 0.3))
    sh = min(1.0, max(0.0, (sharp - 1.75) / 1.25))
    return min(1.0, math.hypot(r, sh))


def tone(stems, segs, leadHz, bassHz, F, workers=None):
    """Harshness of every note (one slice early in it, shared by notes of the same stem in the same slice) and of the
    voice and bass every half second while they sound. Stems are first set to the level of a 70 dB SPL mix."""
    import concurrent.futures, multiprocessing
    names = {'vocals', 'bass'} | {NOTE_STEMS[int(r[12])] for r in segs}
    mix = to_rate(sum(v.mean(0) for v in stems.values()), 44100, TONE_SR)
    gain = 0.0632 / (float(np.sqrt(np.mean(mix ** 2))) + 1e-12)
    tmp = tempfile.mkdtemp()
    paths = {}
    for name in names:
        if name in stems:
            paths[name] = os.path.join(tmp, name + '.npy')
            np.save(paths[name], (to_rate(stems[name].mean(0), 44100, TONE_SR) * gain).astype(np.float32))
    jobs = {}
    for r in segs:
        name = NOTE_STEMS[int(r[12])]
        if name in paths:
            jobs[(name, round((r[0] + min(0.3, 0.5 * (r[1] - r[0]))) / 0.2) * 0.2)] = None
    grid = {}
    for name, hz in (('vocals', leadHz), ('bass', bassHz)):
        on = hz > 0
        for k in range(int(F * DT / 0.5) + 1):
            f = int(round(k * 0.5 / DT))
            if f < F and on[f] and name in paths:
                jobs[(name, k * 0.5)] = None
        grid[name] = on
    keys = list(jobs)
    ctx = multiprocessing.get_context('spawn')
    with concurrent.futures.ProcessPoolExecutor(max_workers=workers or min(8, os.cpu_count() or 1), mp_context=ctx,
                                                initializer=_tone_init, initargs=(paths,)) as ex:
        for key, res in zip(keys, ex.map(_tone_slice, keys, chunksize=8)):
            jobs[key] = res
    for path in paths.values():
        os.remove(path)
    note_rs = [jobs.get((NOTE_STEMS[int(r[12])], round((r[0] + min(0.3, 0.5 * (r[1] - r[0]))) / 0.2) * 0.2)) or (0.0, 0.0) for r in segs]
    lines = {}
    for name in ('vocals', 'bass'):
        rough, sharp = np.zeros(F, np.float32), np.zeros(F, np.float32)
        for f in np.nonzero(grid[name])[0]:
            rough[f], sharp[f] = jobs.get((name, round(f * DT / 0.5) * 0.5)) or (0.0, 0.0)
        lines[name] = (rough, sharp)
    return note_rs, lines['vocals'], lines['bass'], len(keys)


# ------------------------------------------------------------------ words
LRCLIB = 'https://lrclib.net/api/'
UA = 'Pitchscape (https://github.com/stop-amertime/pitchscape)'


def probe(path):
    """ffprobe's view of an audio file: its format and streams, with every tag (names lowercased)."""
    try:
        out = subprocess.run(['ffprobe', '-v', 'error', '-show_format', '-show_streams', '-of', 'json', path],
                             capture_output=True, check=True, timeout=30).stdout
        j = json.loads(out or b'{}')
    except Exception as e:
        log('tags: none read', e)
        j = {}
    tags = {}
    for d in [j.get('format', {}).get('tags', {})] + [st.get('tags', {}) for st in j.get('streams', [])]:
        for k, v in (d or {}).items():
            tags.setdefault(k.lower(), str(v).strip())
    return j, tags


def song_tags(path, name, tags=None):
    """(artist, title, album) from the file's tags, the gaps filled from a file name of the form "Artist - Title"."""
    if tags is None:
        tags = probe(path)[1]
    artist, title = tags.get('artist') or tags.get('album_artist') or '', tags.get('title', '')
    stem = re.sub(r'^\s*\d{1,3}\s*[-._)]?\s+', '', os.path.splitext(os.path.basename(name or ''))[0].replace('_', ' '))
    if ' - ' in stem:
        a, t = stem.split(' - ', 1)
        artist, title = artist or a.strip(), title or t.strip()
    return artist, title, tags.get('album', '')


def song_info(path, name, sha=None):
    """What identifies this recording, for finding it again elsewhere (a streaming service, MusicBrainz): the usual
    tags under plain names, the identifiers taggers write (ISRC, MusicBrainz ids), the file's own facts, and every tag
    as it came. ISRC is the one code that names a recording across services; length tells versions apart."""
    j, tags = probe(path)
    fmt = j.get('format', {})
    audio = next((st for st in j.get('streams', []) if st.get('codec_type') == 'audio'), {})
    def tag(*names):
        for n in names:
            if tags.get(n):
                return tags[n]
        return None
    artist, title, album = song_tags(path, name, tags)
    info = {
        'title': title or None, 'artist': artist or None, 'album': album or None,
        'albumArtist': tag('album_artist', 'albumartist', 'album artist'), 'track': tag('track', 'tracknumber'),
        'disc': tag('disc', 'discnumber'), 'date': tag('date', 'year', 'originaldate', 'tdor'), 'genre': tag('genre'),
        'composer': tag('composer'), 'label': tag('label', 'publisher', 'organization'),
        'isrc': tag('isrc', 'tsrc'),
        'musicbrainz': {k: v for k, v in {
            'recording': tag('musicbrainz_trackid', 'musicbrainz track id', 'musicbrainz_recordingid'),
            'release': tag('musicbrainz_albumid', 'musicbrainz album id'),
            'artist': tag('musicbrainz_artistid', 'musicbrainz artist id'),
            'track': tag('musicbrainz_releasetrackid', 'musicbrainz release track id')}.items() if v},
        'duration': float(fmt['duration']) if fmt.get('duration') else None,
        'file': {'name': os.path.basename(name or path), 'sha256': sha, 'format': fmt.get('format_name'),
                 'codec': audio.get('codec_name'), 'bitrate': int(fmt['bit_rate']) if fmt.get('bit_rate') else None,
                 'sampleRate': int(audio['sample_rate']) if audio.get('sample_rate') else None,
                 'channels': audio.get('channels'),
                 'cover': any(st.get('disposition', {}).get('attached_pic') for st in j.get('streams', []))},
        'tags': tags,
    }
    return info


class Unreachable(Exception):
    pass


def lrclib(path_q, tries=10):
    """One LRCLIB API call: the JSON, or None for "not found". LRCLIB often answers "busy" (503), sometimes for many
    seconds, so a call is retried for about a minute before giving up (Unreachable)."""
    for k in range(tries):
        try:
            req = urllib.request.Request(LRCLIB + path_q, headers={'User-Agent': UA})
            with urllib.request.urlopen(req, timeout=15) as r:
                return json.loads(r.read())
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            log('lrclib:', e.code, path_q)
        except Exception as e:
            log('lrclib:', e, path_q)
        time.sleep(1 + k)
    raise Unreachable(path_q)


def find_lyrics(artist, title, album, dur):
    """The song's record on LRCLIB, within 3 s of the song's length (another length is another version, timed
    differently), preferring one with timed lines: an exact match on artist, title and length, then a search by artist
    and title. If the tagged artist finds nothing (tags are often wrong), a search by title alone, taking a record only
    if it has exactly this title, is within 2 s of this length, and every such record is by the same artist."""
    if not title:
        return None
    def fits(h, tol=3):
        return isinstance(h, dict) and abs(float(h.get('duration') or 0) - dur) <= tol and \
            bool(h.get('instrumental') or h.get('syncedLyrics') or h.get('plainLyrics'))
    def best(cands):
        cands = [h for h in cands if fits(h)]
        cands.sort(key=lambda h: (not h.get('instrumental') and not h.get('syncedLyrics'), abs(float(h.get('duration') or 0) - dur)))
        return cands[0] if cands else None
    found = []
    if artist:
        q = {'artist_name': artist, 'track_name': title, 'duration': str(int(round(dur)))}
        if album:
            found.append(lrclib('get?' + urllib.parse.urlencode(dict(q, album_name=album))))
        found.append(lrclib('get?' + urllib.parse.urlencode(q)))
        hit = best(found)
        if hit and (hit.get('syncedLyrics') or hit.get('instrumental')):
            return hit
        found += lrclib('search?' + urllib.parse.urlencode({'artist_name': artist, 'track_name': title})) or []
        hit = best(found)
        if hit:
            return hit
    same = [h for h in (lrclib('search?' + urllib.parse.urlencode({'track_name': title})) or [])
            if fits(h, 2) and norm(h.get('trackName') or '') == norm(title)]
    if same and len({norm(h.get('artistName') or '') for h in same}) == 1:
        return dict(best(same), byTitleOnly=True)
    return None


def parse_lrc(text):
    """Synced lyrics -> [(line time s, text)], in time order; a line stamped several times appears at each."""
    out = []
    for raw in (text or '').splitlines():
        stamps = re.findall(r'\[(\d+):(\d+(?:\.\d+)?)\]', raw)
        body = re.sub(r'<\d+:\d+(?:\.\d+)?>', '', re.sub(r'\[[^\]]*\]', '', raw)).strip()
        if body:
            out += [(int(m) * 60 + float(sec), body) for m, sec in stamps]
    out.sort(key=lambda x: x[0])
    return out


def norm(w):
    w = unicodedata.normalize('NFKD', w.lower())
    return ''.join(c for c in w if c.isalnum())


def heard_words(vocals44, device, size):
    """Whisper's words, with when each starts and ends: [(word, start, end)], and the language it heard."""
    from faster_whisper import WhisperModel
    v16 = to_rate(vocals44.mean(0), 44100, 16000).astype(np.float32)
    try:
        model = WhisperModel(size, device='cuda' if device != 'cpu' else 'cpu', compute_type='float16' if device != 'cpu' else 'int8')
    except Exception as e:
        # on a home PC faster-whisper sometimes cannot find CUDA's libraries; the CPU times the words the same, slower
        if device == 'cpu':
            raise
        log('words: Whisper could not start on the GPU (%s); timing the words on the CPU' % e)
        model = WhisperModel(size, device='cpu', compute_type='int8')
    segments, info = model.transcribe(v16, word_timestamps=True, vad_filter=True, condition_on_previous_text=False)
    words = [(w.word.strip(), float(w.start), float(w.end)) for seg in segments for w in (seg.words or []) if w.word.strip()]
    return words, info.language


def place_words(lines, heard):
    """Times for the published words. lines: [(LRC line time or None, text)]; heard: Whisper's [(word, start, end)].
    The two word lists are matched in order (difflib); a matched word takes the time Whisper heard it at, unless that
    is far from where the LRC puts its line (a match against a different repeat of a chorus). Words between matches
    are spread evenly between them, and a line starting on an unmatched word starts at its LRC time. Returns the
    lines with times and the share of words matched."""
    toks = [(li, w) for li, (_, text) in enumerate(lines) for w in text.split()]
    a = [norm(w) for _, w in toks]
    b = [norm(w) for w, _, _ in heard]
    t = [None] * len(toks)
    for blk in difflib.SequenceMatcher(None, a, b, autojunk=False).get_matching_blocks():
        for k in range(blk.size):
            if a[blk.a + k]:
                t[blk.a + k] = heard[blk.b + k][1]
    starts = [lt for lt, _ in lines]
    synced = all(x is not None for x in starts)
    first = {}
    for k, (li, _) in enumerate(toks):
        first.setdefault(li, k)
    if synced:
        # the LRC may be timed against a copy that starts a little earlier or later: one offset for the song
        d = [t[k] - starts[li] for li, k in first.items() if t[k] is not None]
        off = float(np.median(d)) if d else 0.0
        st = [x + off for x in starts]
        for k, (li, _) in enumerate(toks):
            hi = st[li + 1] if li + 1 < len(st) else st[li] + 15
            if t[k] is not None and not (st[li] - 1.5 <= t[k] <= hi + 1.0):
                t[k] = None
        for li, k in first.items():
            if t[k] is None or abs(t[k] - st[li]) > 1.0:
                t[k] = max(0.0, st[li])
    # keep only times that run forward
    last = -1.0
    for k in range(len(t)):
        if t[k] is not None:
            if t[k] <= last:
                t[k] = None
            else:
                last = t[k]
    known = [k for k in range(len(t)) if t[k] is not None]
    matched = sum(1 for x in t if x is not None) / max(1, len(t))
    if not known:
        return None, 0.0
    for k in range(len(t)):
        if t[k] is not None:
            continue
        lo = max([j for j in known if j < k], default=None)
        hi = min([j for j in known if j > k], default=None)
        if lo is not None and hi is not None:
            t[k] = t[lo] + (t[hi] - t[lo]) * (k - lo) / (hi - lo)
        elif lo is not None:
            t[k] = t[lo] + 0.3 * (k - lo)
        else:
            t[k] = max(0.0, t[hi] - 0.3 * (hi - k))
    out = []
    for li, (_, text) in enumerate(lines):
        ws = [[w, round(t[k], 3)] for k, (lj, w) in enumerate(toks) if lj == li]
        if ws:
            out.append({'text': text, 'words': ws})
    return out, matched


def lyrics_for(path, name, dur, vocals44, device, size):
    """The song's published lyrics with each word timed to the vocal, or None (with why) if LRCLIB hasn't got them.
    Whisper only times the words; what it hears is never shown."""
    artist, title, album = song_tags(path, name)
    info = {'artist': artist, 'title': title}
    if not title:
        return None, dict(info, found=False, why='no artist and title in the tags or the file name')
    try:
        hit = find_lyrics(artist, title, album, dur)
    except Unreachable:
        return None, dict(info, found=False, why='LRCLIB could not be reached')
    if not hit:
        return None, dict(info, found=False, why='not on LRCLIB at this length')
    info.update(found=True, lrclib=hit.get('id'), track=hit.get('trackName'), by=hit.get('artistName'),
                byTitleOnly=bool(hit.get('byTitleOnly')))
    if hit.get('instrumental'):
        return None, dict(info, why='instrumental')
    lines = parse_lrc(hit.get('syncedLyrics'))
    if not lines:
        lines = [(None, ln.strip()) for ln in (hit.get('plainLyrics') or '').splitlines() if ln.strip()]
    if not lines:
        return None, dict(info, why='no lyrics in the record')
    heard, lang = heard_words(vocals44, device, size)
    placed, matched = place_words(lines, heard)
    info.update(synced=lines[0][0] is not None, matched=round(matched, 3), heard=len(heard))
    if not placed:
        return None, dict(info, why='none of the words were heard')
    return {'language': lang, 'source': 'LRCLIB', 'lines': placed}, info


# ------------------------------------------------------------------ the whole thing
def analyze(path, device='cpu', stems_dir=None, words=True, whisper_size=None, progress=log, title=None, name=None):
    from huggingface_hub import hf_hub_download
    t_start = time.time()
    with open(path, 'rb') as fh:
        song = song_info(path, name or path, hashlib.sha256(fh.read()).hexdigest())
    mix44 = decode(path, 44100)
    dur = mix44.shape[1] / 44100
    F = max(16, math.ceil(dur * SR / HOP))
    if stems_dir:
        import soundfile as sf
        stems = {s: sf.read(os.path.join(stems_dir, s + '.wav'), dtype='float32')[0].T
                 for s in ('drums', 'bass', 'other', 'vocals', 'guitar', 'piano') if os.path.exists(os.path.join(stems_dir, s + '.wav'))}
        progress('stems: loaded from', stems_dir)
    else:
        progress('stems: separating with Demucs')
        stems = separate(mix44, device)
    st22 = {k: to_rate(v.mean(0), 44100, SR) for k, v in stems.items()}

    progress('drums: ADTOF')
    hits = drum_hits(stems['drums'], hf_hub_download(ADTOF_REPO, ADTOF_FILE))
    events = drum_details(hits, st22['drums'])

    progress('notes: Basic Pitch on guitar, piano and the rest')
    segs = notes_by_stem(stems, st22)

    progress('bass: pYIN')
    bassN, bassHz, bassBr = bass_line(st22['bass'], F)

    progress('voice: CREPE')
    leadHz, leadP, leadL, leadN, leadBr, leadNz, noiseRef, onsets = voice_line(stems['vocals'], F, device)

    progress('tone: roughness and sharpness')
    note_rs, (leadRough, leadSharp), (bassRough, bassSharp), slices = tone(stems, segs, leadHz, bassHz, F)

    progress('width: excitation patterns')
    gain = 0.0632 / (float(np.sqrt(np.mean(sum(v.mean(0) for v in stems.values()) ** 2))) + 1e-12)
    ears = {}
    for name in NOTE_STEMS:
        if name in st22 and any(NOTE_STEMS[int(r[12])] == name for r in segs):
            ears[name] = Ear(st22[name], gain)
    bends, holds, widths, where = pack_curves(segs, ears)
    ears = None
    leadEar = ear_line(Ear(st22['vocals'], gain), leadHz)
    # the bass as a pure tone: a bass's octave is often as loud as its note, and so low the two merge along the ear
    # (with the analysis window's own spread, the measured width filled 17-21 semitones)
    bassEar = ear_line(Ear(st22['bass'], gain), bassHz, tone=True)
    segs = [r[:13] + [rs[0], rs[1], w[0], w[1]] for r, rs, w in zip(segs, note_rs, where)]

    lyrics, found = None, None
    if words:
        progress('words: LRCLIB, timed by Whisper')
        lyrics, found = lyrics_for(path, name or path, dur, stems['vocals'], device,
                                   whisper_size or ('medium' if device != 'cpu' else 'base'))
        log('words:', json.dumps(found))

    ev = np.array(events, np.float32).reshape(-1) if events else np.zeros(0, np.float32)
    sg = np.array(segs, np.float32).reshape(-1) if segs else np.zeros(0, np.float32)
    on = np.array(onsets, np.float32).reshape(-1) if onsets else np.zeros(0, np.float32)
    pack = {
        'format': 'song-overprint-pack', 'version': 11, 'source': 'pitchscape-server',
        'models': {'stems': 'htdemucs_6s', 'drums': 'ADTOF Frame_RNN', 'notes': 'Basic Pitch ICASSP 2022',
                   'bass': 'pYIN', 'voice': 'CREPE', 'tone': 'MOSQITO roughness_dw, sharpness_din', 'width': 'Glasberg & Moore roex excitation patterns',
                   'words': 'LRCLIB, timed by Whisper' if words else None},
        'noteStems': list(NOTE_STEMS),
        'title': song['title'] or title or os.path.splitext(os.path.basename(path))[0], 'artist': song['artist'] or '',
        'audio': None, 'song': dict(song, lrclib=(found or {}).get('lrclib')),
        'dur': dur, 'dt': DT, 'frames': F, 'stereo': True, 'noiseRef': noiseRef,
        'segStride': SEGW, 'eventStride': EVW,
        'arrays': {'bassN': b64f32(bassN), 'bassHz': b64f32(bassHz), 'bassBr': b64f32(bassBr),
                   'leadHz': b64f32(leadHz), 'leadP': b64f32(leadP), 'leadL': b64f32(leadL), 'leadN': b64f32(leadN),
                   'leadBr': b64f32(leadBr), 'leadNz': b64f32(leadNz),
                   'events': b64f32(ev), 'segs': b64f32(sg), 'onsets': b64f32(on),
                   'leadRough': b64f32(leadRough), 'leadSharp': b64f32(leadSharp),
                   'bassRough': b64f32(bassRough), 'bassSharp': b64f32(bassSharp),
                   },
        # per-sample curves as bytes (see u8): each note's bend and hold every dt, and ear widths, (down, up) in
        # semitones at each drop in earDb, for every note sample, voice frame and bass frame
        'earDb': list(EAR_DB),
        'bytes': {'bends': u8(bends, -8, 8), 'holds': u8(holds, 0, 1), 'noteEar': u8(widths, 0, EAR_SPAN),
                  'leadEar': u8(leadEar.reshape(-1), 0, EAR_SPAN), 'bassEar': u8(bassEar.reshape(-1), 0, EAR_SPAN)},
        'timing': None, 'lyrics': lyrics,
        'floors': {'drums': DRUM_FLOOR, 'hold': HOLD_FLOOR, 'noteMs': NOTE_MIN_MS, 'voiceP': VOICE_P_FLOOR,
                   'voiceL': VOICE_L_FLOOR, 'bassL': BASS_L_FLOOR},
        'stats': {'seconds': round(time.time() - t_start, 1),
                  'hits': {k: sum(1 for h in hits if h[1] == k and h[3] >= 1) for k in TYPES},
                  'notes': len(segs), 'voiced': float(voice_gate(leadP, leadL, np.where(leadHz > 0, leadHz, np.nan), 0.45, 0.04, 4).mean()),
                  'notesByStem': {n: sum(1 for r in segs if int(r[12]) == i) for i, n in enumerate(NOTE_STEMS)},
                  'harshNotes': round(float(np.mean([harshness(r[13], r[14]) > 0.3 for r in segs])) if segs else 0.0, 3),
                  'toneSlices': slices, 'lyrics': found,
                  'earWidth3dB': {'voice': round(float(np.median(leadEar[leadHz > 0, 2] + leadEar[leadHz > 0, 3])), 2) if (leadHz > 0).any() else 0,
                                  'bass': round(float(np.median(bassEar[bassHz > 0, 2] + bassEar[bassHz > 0, 3])), 2) if (bassHz > 0).any() else 0,
                                  'notes': round(float(np.median(np.array(widths).reshape(-1, 6)[:, 2] + np.array(widths).reshape(-1, 6)[:, 3])), 2) if widths else 0}},
    }
    progress('done in %.0f s' % (time.time() - t_start))
    return pack


if __name__ == '__main__':
    ap = argparse.ArgumentParser(description='Analyse a song into a Pitchscape pack.')
    ap.add_argument('song')
    ap.add_argument('out')
    ap.add_argument('--stems', help='folder with drums.wav, bass.wav, other.wav, vocals.wav, guitar.wav, piano.wav (skips separation)')
    ap.add_argument('--device', default='cpu')
    ap.add_argument('--no-words', action='store_true')
    ap.add_argument('--whisper', help='Whisper model size (default: medium on GPU, base on CPU)')
    ap.add_argument('--name', help="the uploaded file's name, read as \"Artist - Title\" when the file has no tags")
    a = ap.parse_args()
    pk = analyze(a.song, device=a.device, stems_dir=a.stems, words=not a.no_words, whisper_size=a.whisper, name=a.name)
    with open(a.out, 'w') as fh:
        json.dump(pk, fh)
    log('wrote', a.out, '%.0f KB' % (os.path.getsize(a.out) / 1024), json.dumps(pk['stats']))
