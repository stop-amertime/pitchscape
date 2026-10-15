"""Pitchscape analysis pipeline: a song in, a pack (the page's data format) out.

Every detector here is an established, trained model. This file wires them together and measures a few plain
properties of what they found (how loud, how bright, how long a hit rings, how a note starts and fades):

  stems   Demucs htdemucs_6s (Meta, MIT)                drums / bass / other / vocals / guitar / piano
  drums   ADTOF Frame_RNN (Zehren et al., CC BY-NC-SA)  kick, snare, toms, hi-hat, cymbals, read from the drum stem
  notes   Basic Pitch (Spotify, Apache-2.0)             note events with pitch bends, read from the guitar, piano
                                                        and other stems separately; each note keeps its stem
  bass    pYIN (librosa, ISC)                           pitch contour of the bass stem
  voice   CREPE (torchcrepe, MIT)                       pitch contour and periodicity of the vocal stem
  tone    MOSQITO (Eomys, Apache-2.0)                   roughness (Daniel & Weber) and sharpness (DIN 45692) of
                                                        every note, and of the voice and bass, on their own stems
  words   Whisper (faster-whisper, MIT)                 words with timestamps, read from the vocal stem

Usage (local, CPU is fine for testing):
  python -m server.pipeline SONG.mp3 OUT.json [--stems DIR_WITH_drums.wav_etc] [--device cpu|cuda] [--no-words]
"""
import argparse, base64, json, math, os, subprocess, sys, tempfile, time

import numpy as np

SR = 22050                      # analysis rate of the page's frame grid
HOP = 512                       # 23.2 ms per frame, the page's dt
DT = HOP / SR
DB = 16                         # drum spectrum bands, log-spaced 30 Hz .. 11 kHz (must match DSP.DRUM_BANDS)
DRUM_BANDS = [30 * (SR / 2 / 30) ** (i / DB) for i in range(DB + 1)]
EVW, SEGW = 5 + DB, 14
NOTE_STEMS = ('other', 'guitar', 'piano')   # a note's source: its index here
TYPES = {'kick': 0, 'snare': 1, 'hat': 2, 'tom': 3, 'cymbal': 4}


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
    """madmom's NotePeakPickingProcessor (the procedure ADTOF's thresholds were tuned with), for one class."""
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
    return np.array(kept, dtype=int)


def drum_hits(drums44, model_path):
    import onnxruntime as ort
    mono = drums44.mean(0).astype(np.float32)
    sess = ort.InferenceSession(model_path, providers=[p for p in ('CUDAExecutionProvider', 'CPUExecutionProvider')
                                                      if p in ort.get_available_providers()])
    act = sess.run(None, {sess.get_inputs()[0].name: mono[None]})[0][0]          # (frames, 5) at 100 fps
    hits = []
    for c, (kind, thr) in enumerate(ADTOF_OUT):
        for i in peak_pick(act[:, c], thr):
            hits.append((i / 100.0, kind, float(act[i, c])))
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
    for t, kind, a in hits:
        by_kind.setdefault(kind, []).append(t)
    events = []
    for t, kind, a in hits:
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
        events.append([t, TYPES[kind], strength, hz, ring] + [float(v) for v in prof])
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
    ok = vflag[:n] & np.isfinite(f0[:n]) & (bassN[:n] >= 0.08)
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
    loud = rms > 0.04 * (np.percentile(rms, 98) + 1e-9)
    voiced = (pr > 0.45) & loud & np.isfinite(hz)
    # drop flickers: voiced runs shorter than 4 frames (~90 ms)
    f = 0
    while f < F:
        if voiced[f]:
            g = f
            while g < F and voiced[g]:
                g += 1
            if g - f < 4:
                voiced[f:g] = False
            f = g
        else:
            f += 1
    ref = np.percentile(rms[voiced], 95) + 1e-9 if voiced.any() else 1.0
    leadHz = np.where(voiced, hz, 0).astype(np.float32)
    leadN = np.where(voiced, np.minimum(1.2, np.sqrt(rms / ref)), 0).astype(np.float32)
    leadNz = np.where(voiced, 1 - pr, 0).astype(np.float32)
    spec = Spec(y)
    leadBr = np.zeros(F, np.float32)
    for f in np.nonzero(voiced)[0]:
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
    return leadHz, leadN, leadBr, leadNz, noiseRef, onsets


# ------------------------------------------------------------------ notes
def note_details(notes, other22):
    """Basic Pitch notes -> the page's note records: [t0, t1, midi, amp, brightness, noise, family, attack s,
    fade dB/s, vibrato depth st, vibrato rate Hz, hollowness]. Family: 0 struck, 1 swell, 2 held."""
    y = other22.mean(0) if other22.ndim > 1 else other22
    spec = Spec(y, n_fft=4096, hop=256)
    fps = SR / 256
    amps = np.array([n[3] for n in notes]) if notes else np.array([1.0])
    aref = np.percentile(amps, 95) + 1e-9
    segs = []
    for t0, t1, pitch, amp, bends in notes:
        midi = pitch + (float(np.mean(bends)) / 3 if bends else 0.0)
        f0 = 440 * 2 ** ((midi - 69) / 12)
        fa, fb = int(t0 * fps), max(int(t0 * fps) + 2, int(t1 * fps))
        env, trk, br, nz, ev, od = [], [], [], [], 0.0, 0.0
        for f in range(fa, min(fb, spec.M.shape[1])):
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
            trk.append(12 * math.log2(p / k / 440) + 69 if p > 0 else midi)
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
                     float(np.mean(nz)) if nz else 0.0, fam, attack, fade, vd, vr, hollow, float(env[pk])])
    segs.sort(key=lambda s: s[0])
    return segs


def notes_by_stem(stems, st22):
    """Basic Pitch on each instrument stem. A note also found, much weaker, at the same pitch and time in another stem
    is that stem's leak and is dropped there; notes far below the song's level (bleed into a near-empty stem) go too.
    Records gain their stem's index (NOTE_STEMS) and lose the strength used for this."""
    found = []
    for i, name in enumerate(NOTE_STEMS):
        if name in stems:
            found += [r + [i] for r in note_details(notes_from_stem(stems[name]), st22[name])]
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
            if a[13] == b[13] or abs(a[2] - b[2]) > 0.6:
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
    return [r[:3] + [min(1.2, r[3] / aref)] + r[4:12] + [r[13]] for r in kept]


def notes_from_stem(other44):
    import soundfile as sf
    from basic_pitch import ICASSP_2022_MODEL_PATH
    from basic_pitch.inference import predict
    with tempfile.NamedTemporaryFile(suffix='.wav') as tmp:
        sf.write(tmp.name, other44.T, 44100, subtype='FLOAT')
        _, _, events = predict(tmp.name, ICASSP_2022_MODEL_PATH, onset_threshold=0.5, frame_threshold=0.3,
                               minimum_note_length=100, melodia_trick=True)
    return [(float(a), float(b), int(p), float(v), list(bd) if bd is not None else None) for a, b, p, v, bd in events]


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
    clearly grating sound by 0.4), sharpness above 1.75 acum (where it starts to annoy in Zwicker's model) to 3."""
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
            jobs[key] = harshness(*res)
    for path in paths.values():
        os.remove(path)
    note_h = [jobs.get((NOTE_STEMS[int(r[12])], round((r[0] + min(0.3, 0.5 * (r[1] - r[0]))) / 0.2) * 0.2), 0.0) or 0.0 for r in segs]
    lines = {}
    for name in ('vocals', 'bass'):
        h = np.zeros(F, np.float32)
        for f in np.nonzero(grid[name])[0]:
            h[f] = jobs.get((name, round(f * DT / 0.5) * 0.5), 0.0) or 0.0
        lines[name] = h
    return note_h, lines['vocals'], lines['bass'], len(keys)


# ------------------------------------------------------------------ words
def words_from_vocals(vocals44, device, size):
    from faster_whisper import WhisperModel
    v16 = to_rate(vocals44.mean(0), 44100, 16000).astype(np.float32)
    model = WhisperModel(size, device='cuda' if device != 'cpu' else 'cpu', compute_type='float16' if device != 'cpu' else 'int8')
    segments, info = model.transcribe(v16, word_timestamps=True, vad_filter=True, condition_on_previous_text=False)
    words = [[w.word.strip(), round(float(w.start), 3), round(float(w.end), 3)]
             for seg in segments for w in (seg.words or []) if w.word.strip()]
    # Whisper's segments run long; a sung line ends at a pause (or after ~9 words)
    lines, cur = [], []
    for i, w in enumerate(words):
        cur.append(w)
        nxt = words[i + 1] if i + 1 < len(words) else None
        if nxt is None or nxt[1] - w[2] > 0.45 or len(cur) >= 9:
            lines.append({'text': ' '.join(x[0] for x in cur), 'words': [[x[0], x[1]] for x in cur]})
            cur = []
    return {'language': info.language, 'lines': lines}


# ------------------------------------------------------------------ the whole thing
def analyze(path, device='cpu', stems_dir=None, words=True, whisper_size=None, progress=log, title=None):
    from huggingface_hub import hf_hub_download
    t_start = time.time()
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
    leadHz, leadN, leadBr, leadNz, noiseRef, onsets = voice_line(stems['vocals'], F, device)

    progress('tone: roughness and sharpness')
    note_h, leadHarsh, bassHarsh, slices = tone(stems, segs, leadHz, bassHz, F)
    segs = [r + [h] for r, h in zip(segs, note_h)]

    lyrics = None
    if words:
        progress('words: Whisper')
        lyrics = words_from_vocals(stems['vocals'], device, whisper_size or ('medium' if device != 'cpu' else 'base'))

    ev = np.array(events, np.float32).reshape(-1) if events else np.zeros(0, np.float32)
    sg = np.array(segs, np.float32).reshape(-1) if segs else np.zeros(0, np.float32)
    on = np.array(onsets, np.float32).reshape(-1) if onsets else np.zeros(0, np.float32)
    pack = {
        'format': 'song-overprint-pack', 'version': 5, 'source': 'pitchscape-server',
        'models': {'stems': 'htdemucs_6s', 'drums': 'ADTOF Frame_RNN', 'notes': 'Basic Pitch ICASSP 2022',
                   'bass': 'pYIN', 'voice': 'CREPE', 'tone': 'MOSQITO roughness_dw, sharpness_din',
                   'words': 'Whisper' if words else None},
        'noteStems': list(NOTE_STEMS),
        'title': title or os.path.splitext(os.path.basename(path))[0], 'artist': '', 'audio': None,
        'dur': dur, 'dt': DT, 'frames': F, 'stereo': True, 'noiseRef': noiseRef,
        'segStride': SEGW, 'eventStride': EVW,
        'arrays': {'bassN': b64f32(bassN), 'bassHz': b64f32(bassHz), 'bassBr': b64f32(bassBr),
                   'leadHz': b64f32(leadHz), 'leadN': b64f32(leadN), 'leadBr': b64f32(leadBr), 'leadNz': b64f32(leadNz),
                   'events': b64f32(ev), 'segs': b64f32(sg), 'onsets': b64f32(on),
                   'leadHarsh': b64f32(leadHarsh), 'bassHarsh': b64f32(bassHarsh)},
        'timing': None, 'lyrics': lyrics,
        'stats': {'seconds': round(time.time() - t_start, 1), 'hits': {k: sum(1 for h in hits if h[1] == k) for k in TYPES},
                  'notes': len(segs), 'voiced': float((leadHz > 0).mean()),
                  'notesByStem': {n: sum(1 for r in segs if int(r[12]) == i) for i, n in enumerate(NOTE_STEMS)},
                  'harshNotes': round(float(np.mean([r[13] > 0.3 for r in segs])) if segs else 0.0, 3), 'toneSlices': slices},
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
    a = ap.parse_args()
    pk = analyze(a.song, device=a.device, stems_dir=a.stems, words=not a.no_words, whisper_size=a.whisper)
    with open(a.out, 'w') as fh:
        json.dump(pk, fh)
    log('wrote', a.out, '%.0f KB' % (os.path.getsize(a.out) / 1024), json.dumps(pk['stats']))
