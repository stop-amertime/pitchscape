# A stereo split as a method for score.py: each of the baseline's pitched stems (stems-baseline/, stereo) split by
# where its sound sits between the speakers. Per STFT bin (4096 / 1024 at 44.1 kHz) the pan an amplitude-panned
# source in it would have, from the two channels' magnitudes (as ADRess, Barry et al. 2004, and Avendano's panning
# index, 2003, read it: p = 4/pi atan2(|R|, |L|) - 1, -1 left .. 1 right); the stem's energy over p (101 bins,
# smoothed by 0.04) has a peak per place a source sits (scipy find_peaks, prominence 10% of the highest, at least 0.15
# apart); each bin goes to the peaks by a Gaussian in p (sd 0.08), so every part is a soft mask of the stem. A stem
# with one peak stays as it is (its baseline notes); split parts get Basic Pitch notes (notes.mjs). Writes
# <song>/pan.json and the parts as <song>/stems-pan/<stem>-<k>.wav.
# --exact (method pan2): a bin is shared by solving, not by closeness. Two channels are two equations: a bin taken to
# hold one source at each of two places c1, c2 gives L = gL(c1) s1 + gL(c2) s2 and R = gR(c1) s1 + gR(c2) s2 with the
# constant-power pan's gains (gL = cos, gR = sin of (c + 1) pi / 4), solved exactly for s1 and s2 (complex). Any pair
# solves exactly, so with three or more places the pair needing the least signal is taken (sparse component
# analysis: Bofill & Zibulevsky 2001). The parts add up to the stem exactly. Three or more sources
# in one bin, or two at one place, cannot be told apart this way.
#   <venv python> tools/instruments/pan.py [--exact] SET [song...]       (after baseline.py on that set)
import json, os, subprocess, sys
import numpy as np, soundfile as sf, librosa
from scipy.signal import find_peaks
from scipy.ndimage import gaussian_filter1d

HERE = os.path.dirname(os.path.abspath(__file__)); REPO = os.path.join(HERE, '..', '..')
ROOT = os.path.join(REPO, 'testsongs', 'multitrack')
NFFT, HOP, SD = 4096, 1024, 0.08
EDGES = np.linspace(-1, 1, 102); MID = (EDGES[1:] + EDGES[:-1]) / 2


def solve(L, R, p, pans):
    """Each place's share of the bins: per bin, the pair of places whose exact 2x2 solve needs the least signal
    (|s1| + |s2|, the shortest path of Bofill & Zibulevsky 2001: few sources sound in any one bin)."""
    k = len(pans); a = (pans + 1) * np.pi / 4; gL, gR = np.cos(a), np.sin(a)
    best, cost = None, np.full(L.shape, np.inf)
    for i in range(k):
        for j in range(i + 1, k):
            det = gL[i] * gR[j] - gL[j] * gR[i]
            s1 = (gR[j] * L - gL[j] * R) / det; s2 = (gL[i] * R - gR[i] * L) / det
            c = np.abs(s1) + np.abs(s2); m = c < cost; cost = np.where(m, c, cost)
            best = [(i, j, s1, s2, m)] if best is None else best + [(i, j, s1, s2, m)]
    pick = np.full(L.shape, -1)
    for n, (*_, m) in enumerate(best): pick = np.where(m, n, pick)          # the last improvement per bin is the least
    out = [[np.zeros_like(L), np.zeros_like(R)] for _ in range(k)]
    for n, (i, j, s1, s2, _) in enumerate(best):
        m = pick == n
        for c, sc in ((i, s1), (j, s2)):
            out[c][0] += np.where(m, gL[c] * sc, 0); out[c][1] += np.where(m, gR[c] * sc, 0)
    return out


def split(path, exact=False):
    """The stem's places (pans) and, if more than one, each place's part as stereo audio."""
    x, sr = sf.read(path, dtype='float32')
    L, R = (librosa.stft(np.ascontiguousarray(x[:, c]), n_fft=NFFT, hop_length=HOP) for c in (0, 1))
    aL, aR = np.abs(L), np.abs(R)
    p = 4 / np.pi * np.arctan2(aR, aL) - 1
    e = aL ** 2 + aR ** 2
    h, _ = np.histogram(p, EDGES, weights=e)
    h = gaussian_filter1d(h, 0.04 / (EDGES[1] - EDGES[0]))
    pk, _ = find_peaks(np.r_[0, h, 0], prominence=0.1 * h.max(), distance=int(0.15 / (EDGES[1] - EDGES[0])))
    pans = MID[pk - 1]
    if len(pans) < 2: return list(pans), None, sr
    n = x.shape[0]
    if exact: specs = solve(L, R, p, np.asarray(pans))
    else:
        w = np.exp(-(p[None] - pans[:, None, None]) ** 2 / (2 * SD ** 2)); w /= w.sum(0, keepdims=True) + 1e-12
        specs = [(wk * L, wk * R) for wk in w]
    parts = [np.stack([librosa.istft(a, hop_length=HOP, length=n), librosa.istft(b, hop_length=HOP, length=n)], 1) for a, b in specs]
    return list(pans), parts, sr


def run(d, exact=False):
    B = json.load(open(os.path.join(d, 'baseline.json'))); tag = 'pan2' if exact else 'pan'
    od = os.path.join(d, 'stems-' + tag); os.makedirs(od, exist_ok=True)
    parts, todo = [], []
    for bp in B['parts']:
        if bp['name'] == 'drums': parts.append(bp); continue
        pans, ys, sr = split(os.path.join(d, bp['audio']), exact)
        if ys is None: parts.append(dict(bp, pan=round(float(pans[0]), 2) if pans else None)); continue
        for k, (pn, y) in enumerate(zip(pans, ys)):
            f = os.path.join(od, f"{bp['name']}-{k}.wav"); sf.write(f, y, sr, subtype='FLOAT')
            parts.append({'name': f"{bp['name']}@{pn:+.2f}", 'audio': os.path.relpath(f, d).replace('\\', '/'), 'pan': round(float(pn), 2), 'notes': None})
            todo.append(f)
    if todo:
        nj = os.path.join(od, 'notes.json')
        subprocess.run(['node', os.path.join(REPO, 'tools', 'instruments', 'notes.mjs'), nj, *todo], check=True, cwd=REPO,
                       stderr=subprocess.DEVNULL)
        N = json.load(open(nj))
        for p in parts:
            if p.get('notes') is None: p['notes'] = N[os.path.join(d, p['audio'])]
    json.dump({'parts': parts}, open(os.path.join(d, tag + '.json'), 'w'))
    print(os.path.basename(d), [(p['name'], len(p['notes'])) for p in parts], flush=True)


if __name__ == '__main__':
    exact = sys.argv[1] == '--exact'; argv = sys.argv[2:] if exact else sys.argv[1:]
    base = os.path.join(ROOT, argv[0])
    for s in argv[1:] or sorted(x for x in os.listdir(base) if os.path.exists(os.path.join(base, x, 'baseline.json'))):
        run(os.path.join(base, s), exact)
