"""Compare the JavaScript pipeline (src/pipeline, run by tools/analyse.mjs) with the Python one (server/pipeline.py),
stage by stage, on the test songs (tools/fetch_test_songs.sh).

  python tools/parity.py stems [name-substring ...] [--device cuda]

Outputs go to testsongs/parity/<song>/ (git-ignored with testsongs/); a summary is printed and written there as
<stage>.json. Needs the Python pipeline's environment, Node, and the models from tools/export_models.py.

stems: Python's separate() with shifts=0 (no random shift, so both sides are deterministic) against the JS with
shifts=0, as SDR (dB) and correlation per stem. For scale, the pipeline's own run (shifts=1, as kept in
testsongs/stems/<song>/ by tools/analyse_test_songs.py) against the same reference: how much the random shift
alone moves each stem.

  python tools/parity.py drums [name-substring ...]

drums: Python's drum_hits and drum_details against the JS stage (src/pipeline/drums.mjs, ONNX Runtime's CPU
provider on both sides) on the same drum stem, Python's own (py-s0/drums.wav, made by `stems` above). Hits are
matched within 10 ms by kind: matched, missing (Python only) and extra (JS only), at the floor (0.6x the thresholds)
and at the authors' thresholds (margin >= 1); for matched hits, the differences in margin, strength, ring, kick Hz
and the 16-band profile, and how far the activations differ. The 22.05 kHz resample is measured alone: the JS
resample against librosa's (SDR), and the details again with Python's 22.05 kHz signal given to the JS.
"""
import json, os, subprocess, sys, time

import numpy as np

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
sys.path.insert(0, ROOT)
SONGS = os.path.join(ROOT, 'testsongs')
SOURCES = ('drums', 'bass', 'other', 'vocals', 'guitar', 'piano')


def compare(ref, est):
    """SDR (dB) of est against ref, their correlation, and the levels of ref and of the difference in dB full scale
    (a near-silent stem has a low SDR however small the difference is)."""
    ref, est = np.asarray(ref, np.float64).ravel(), np.asarray(est, np.float64).ravel()
    n = min(len(ref), len(est))
    ref, est = ref[:n], est[:n]
    e = np.sum((ref - est) ** 2)
    a = np.sum(ref ** 2)
    sdr = float(10 * np.log10(a / e)) if e > 0 else float('inf')
    corr = float(np.dot(ref, est) / np.sqrt(a * np.sum(est ** 2) + 1e-30))
    dbfs = lambda x: round(float(10 * np.log10(x / n + 1e-24)), 1)
    return {'sdr': round(sdr, 1), 'corr': round(corr, 6), 'ref_dbfs': dbfs(a), 'err_dbfs': dbfs(e)}


def read_stems(d):
    import soundfile as sf
    return {s: sf.read(os.path.join(d, s + '.wav'), dtype='float32')[0].T for s in SOURCES}


def py_separate(path, out, device, shifts):
    """server/pipeline.py separate(), with its shifts made a parameter (it always uses 1)."""
    import soundfile as sf
    import torch
    from demucs.apply import apply_model
    from demucs.pretrained import get_model
    from server import pipeline as P
    mix44 = P.decode(path, 44100)
    model = get_model('htdemucs_6s').to(device).eval()
    wav = torch.from_numpy(mix44)
    ref = wav.mean(0)
    m, s = ref.mean(), ref.std() + 1e-8
    t = time.time()
    with torch.no_grad():
        o = apply_model(model, ((wav - m) / s)[None].to(device), device=device, shifts=shifts, split=True,
                        overlap=0.25, progress=False)[0]
    secs = time.time() - t
    o = o.cpu() * s + m
    os.makedirs(out, exist_ok=True)
    for i, name in enumerate(model.sources):
        sf.write(os.path.join(out, name + '.wav'), o[i].numpy().T, 44100, subtype='FLOAT')
    json.dump({'seconds': mix44.shape[1] / 44100, 'device': device, 'shifts': shifts, 'stems_s': round(secs, 2)},
              open(os.path.join(out, 'timing.json'), 'w'))


def stems(song, path, outdir, device):
    py, js = os.path.join(outdir, 'py-s0'), os.path.join(outdir, 'js-s0')
    if not os.path.exists(os.path.join(py, 'timing.json')):
        py_separate(path, py, device, 0)
    if not os.path.exists(os.path.join(js, 'timing.json')):
        subprocess.run(['node', os.path.join(ROOT, 'tools', 'analyse.mjs'), path, '--stems', js, '--shifts', '0'],
                       check=True)
    ref, est = read_stems(py), read_stems(js)
    res = {'js_vs_python': {s: compare(ref[s], est[s]) for s in SOURCES},
           'timing': {'python': json.load(open(os.path.join(py, 'timing.json'))),
                      'js': json.load(open(os.path.join(js, 'timing.json')))}}
    kept = os.path.join(SONGS, 'stems', song)
    if os.path.exists(os.path.join(kept, 'piano.wav')):
        run = read_stems(kept)
        res['pipeline_shift_vs_python'] = {s: compare(ref[s], run[s]) for s in SOURCES}
    return res


def py_drums(stem, out):
    """server/pipeline.py drum_hits and drum_details on a stem file, as analyze() runs them (ADTOF on the CPU)."""
    import soundfile as sf
    import onnxruntime as ort
    from huggingface_hub import hf_hub_download
    from server import pipeline as P
    d44 = sf.read(stem, dtype='float32')[0].T
    model = hf_hub_download(P.ADTOF_REPO, P.ADTOF_FILE)
    t = time.time()
    d22 = P.to_rate(d44.mean(0), 44100, P.SR)
    t1 = time.time()
    real = ort.get_available_providers
    ort.get_available_providers = lambda: ['CPUExecutionProvider']   # as the JS: the CPU provider
    try:
        hits = P.drum_hits(d44, model)
    finally:
        ort.get_available_providers = real
    t2 = time.time()
    events = P.drum_details(hits, d22)
    t3 = time.time()
    sess = ort.InferenceSession(model, providers=['CPUExecutionProvider'])
    act = sess.run(None, {sess.get_inputs()[0].name: d44.mean(0).astype(np.float32)[None]})[0][0]
    os.makedirs(out, exist_ok=True)
    sf.write(os.path.join(out, 'drums22.wav'), d22, P.SR, subtype='FLOAT')
    act.astype('<f4').tofile(os.path.join(out, 'adtof.f32'))
    json.dump({'hits': hits, 'events': events}, open(os.path.join(out, 'drums.json'), 'w'))
    json.dump({'resample_s': round(t1 - t, 2), 'drum_hits_s': round(t2 - t1, 2), 'drum_details_s': round(t3 - t2, 2),
               'onnxruntime': ort.__version__}, open(os.path.join(out, 'timing.json'), 'w'))


def match_hits(a, b, tol=0.0105):
    """One-to-one matches between hit lists a and b (each [t, kind, ...]) of the same kind within tol seconds
    (10 ms: one ADTOF frame), nearest first. Returns [(i, j)...]."""
    near = {}
    for j, y in enumerate(b):
        near.setdefault((y[1], round(y[0] * 100)), []).append(j)
    pairs = []
    for i, x in enumerate(a):
        k = round(x[0] * 100)
        for kk in (k - 1, k, k + 1):
            pairs += [(abs(x[0] - b[j][0]), i, j) for j in near.get((x[1], kk), []) if abs(x[0] - b[j][0]) <= tol]
    pairs.sort()
    ua, ub, out = set(), set(), []
    for _, i, j in pairs:
        if i not in ua and j not in ub:
            ua.add(i)
            ub.add(j)
            out.append((i, j))
    return out


KINDS = ('kick', 'snare', 'tom', 'hat', 'cymbal')


def hit_counts(py, js):
    """Matched / missing / extra by kind, at the floor and at the authors' thresholds (margin >= 1)."""
    res = {}
    for label, keep in (('floor', lambda h: True), ('default', lambda h: h[3] >= 1)):
        a, b = [h for h in py if keep(h)], [h for h in js if keep(h)]
        m = match_hits(a, b)
        r = {}
        for k in KINDS:
            mk = sum(1 for i, _ in m if a[i][1] == k)
            r[k] = {'python': sum(1 for h in a if h[1] == k), 'js': sum(1 for h in b if h[1] == k), 'matched': mk}
            r[k]['missing'], r[k]['extra'] = r[k]['python'] - mk, r[k]['js'] - mk
        r['moved'] = sum(1 for i, j in m if a[i][0] != b[j][0])
        res[label] = r
    return res


def event_diffs(py_hits, js_hits, py_ev, js_ev):
    """For hits matched at the floor: the largest and median differences per field, and how many differ notably.
    An event: [t, type, strength, hz, ring, 16 bands..., margin]."""
    m = match_hits(py_hits, js_hits)
    if not m:
        return {}
    P, J = np.array([py_ev[i] for i, _ in m], float), np.array([js_ev[j] for _, j in m], float)
    kick = P[:, 1] == 0
    stat = lambda x, s=1: {'max': float(x.max() * s) if len(x) else 0.0,
                           'median': float(np.median(x) * s) if len(x) else 0.0}
    cents = np.abs(1200 * np.log2(J[kick, 3] / P[kick, 3]))
    other = np.abs(1200 * np.log2(J[~kick, 3] / P[~kick, 3]))
    ring, prof = np.abs(P[:, 4] - J[:, 4]), np.abs(P[:, 5:21] - J[:, 5:21]).max(1)
    return {'matched': len(m),
            'margin': stat(np.abs(P[:, 21] - J[:, 21])), 'strength': stat(np.abs(P[:, 2] - J[:, 2])),
            'ring_ms': dict(stat(ring, 1000), differ=int((ring > 1e-9).sum())),
            'kick_cents': dict(stat(cents), kicks=int(kick.sum()), over_1=int((cents > 1).sum()),
                               over_10=int((cents > 10).sum()), over_100=int((cents > 100).sum())),
            'other_hz_cents': dict(stat(other), over_1=int((other > 1).sum())),
            'profile': dict(stat(prof), over_1e3=int((prof > 1e-3).sum()), over_1e2=int((prof > 1e-2).sum()))}


def drums(song, path, outdir, device):
    import soundfile as sf
    stem = os.path.join(outdir, 'py-s0', 'drums.wav')
    if not os.path.exists(stem):
        stems(song, path, outdir, device)
    py, js, js22 = (os.path.join(outdir, d) for d in ('py-drums', 'js-drums', 'js-drums-py22'))
    if not os.path.exists(os.path.join(py, 'timing.json')):
        py_drums(stem, py)
    node = ['node', os.path.join(ROOT, 'tools', 'analyse.mjs'), '--stems-in', os.path.join(outdir, 'py-s0'),
            '--ep', 'cpu']
    if not os.path.exists(os.path.join(js, 'timing.json')):
        subprocess.run(node + ['--out', js], check=True)
    if not os.path.exists(os.path.join(js22, 'timing.json')):
        subprocess.run(node + ['--out', js22, '--drums22', os.path.join(py, 'drums22.wav')], check=True)
    P, J, J22 = (json.load(open(os.path.join(d, 'drums.json'))) for d in (py, js, js22))
    pa, ja = (np.fromfile(os.path.join(d, 'adtof.f32'), '<f4').reshape(-1, 5) for d in (py, js))
    r22, j22 = (sf.read(os.path.join(d, 'drums22.wav'), dtype='float32')[0] for d in (py, js))
    rs = compare(r22, j22)
    rs['max_abs'] = float(np.abs(r22.astype(float) - j22[:len(r22)]).max())
    rs['lengths'] = [len(r22), len(j22)]
    return {'hits': hit_counts(P['hits'], J['hits']),
            'activations': {'max_abs_diff': float(np.abs(pa - ja).max()) if pa.shape == ja.shape else None,
                            'frames': [len(pa), len(ja)]},
            'details': event_diffs(P['hits'], J['hits'], P['events'], J['events']),
            'details_with_python_22k': event_diffs(P['hits'], J22['hits'], P['events'], J22['events']),
            'resample': rs,
            'timing': {'python': json.load(open(os.path.join(py, 'timing.json'))),
                       'js': json.load(open(os.path.join(js, 'timing.json')))}}


def print_drums(song, res):
    for label in ('floor', 'default'):
        r = res['hits'][label]
        line = '  '.join('%s %d/%d -%d +%d' % (k, r[k]['matched'], r[k]['python'], r[k]['missing'], r[k]['extra'])
                         for k in KINDS)
        print('%-40s hits, %-7s matched/python -missing +extra: %s (moved %d)' % (
            song if label == 'floor' else '', label, line, r['moved']), flush=True)
    for key, name in (('details', 'own 22k'), ('details_with_python_22k', 'py 22k ')):
        d = res[key]
        if d:
            print('%-40s details (%s): margin %.1e  strength %.1e  ring %d/%d differ (max %.1f ms)  kick Hz %d/%d '
                  'over 1 cent (max %.2f)  profile max %.1e (%d over 1e-3)' % (
                      '', name, d['margin']['max'], d['strength']['max'], d['ring_ms']['differ'], d['matched'],
                      d['ring_ms']['max'], d['kick_cents']['over_1'], d['kick_cents']['kicks'], d['kick_cents']['max'],
                      d['profile']['max'], d['profile']['over_1e3']), flush=True)
    a, r = res['activations'], res['resample']
    print('%-40s activations max diff %s; resample SDR %.1f dB, max diff %.1e' % (
        '', '%.1e' % a['max_abs_diff'] if a['max_abs_diff'] is not None else 'frames %s' % a['frames'], r['sdr'],
        r['max_abs']), flush=True)


STAGES = {'stems': stems, 'drums': drums}

if __name__ == '__main__':
    args = sys.argv[1:]
    device = 'cuda'
    if '--device' in args:
        i = args.index('--device')
        device = args[i + 1]
        del args[i:i + 2]
    if not args or args[0] not in STAGES:
        sys.exit('usage: python tools/parity.py {%s} [name-substring ...] [--device cuda|cpu]' % '|'.join(STAGES))
    stage, names = args[0], args[1:]
    songs = sorted(f for f in os.listdir(SONGS) if f.endswith('.mp3') and (not names or any(a in f for a in names)))
    summary = {}
    for f in songs:
        song = f[:-4]
        outdir = os.path.join(SONGS, 'parity', song)
        os.makedirs(outdir, exist_ok=True)
        res = STAGES[stage](song, os.path.join(SONGS, f), outdir, device)
        json.dump(res, open(os.path.join(outdir, stage + '.json'), 'w'), indent=1)
        summary[song] = res
        if stage == 'drums':
            print_drums(song, res)
            continue
        line = '  '.join('%s %5.1f' % (s, r['sdr']) for s, r in res['js_vs_python'].items())
        print('%-40s JS vs Python SDR dB: %s' % (song, line), flush=True)
        line = '  '.join('%s %5.1f/%-6.1f' % (s, r['ref_dbfs'], r['err_dbfs']) for s, r in res['js_vs_python'].items())
        print('%-40s stem / difference dBFS: %s' % ('', line), flush=True)
        if 'pipeline_shift_vs_python' in res:
            line = '  '.join('%s %5.1f' % (s, r['sdr']) for s, r in res['pipeline_shift_vs_python'].items())
            print('%-40s the random shift alone:  %s' % ('', line), flush=True)
    json.dump(summary, open(os.path.join(SONGS, 'parity', stage + '.json'), 'w'), indent=1)
