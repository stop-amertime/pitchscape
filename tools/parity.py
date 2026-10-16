"""Compare the JavaScript pipeline (src/pipeline, run by tools/analyse.mjs) with the Python one (server/pipeline.py),
stage by stage, on the test songs (tools/fetch_test_songs.sh).

  python tools/parity.py stems|tone [name-substring ...] [--device cuda]

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

tone: roughness (asper) and sharpness (acum) of a slice every 0.5 s of vocals, bass, other, guitar and piano from
Python's stems (py-s0), Python (pipeline._tone_slice in its process pool) against JS (tools/parity_tone.mjs) three ways:
js_vs_python (JS resampling and level, as the JS pipeline runs), port_alone (JS on Python's own 48 kHz stems: MOSQITO's
port only) and resampling_alone (the two JS runs). Python's results are kept in tone/py.json; delete it to measure again.

  python tools/parity.py notes [name-substring ...]

notes: Python's notes_by_stem (Basic Pitch on ONNX Runtime's CPU provider, one window per call, as basic_pitch runs it)
against the JS stage (src/pipeline/notes.mjs, the CPU provider too) on the same stems (py-s0). Twice: as the JS runs
(its own 22.05 kHz resample, eight windows per model call), and with Python's 22.05 kHz signals and one window per
call, which is the port alone. Notes are matched by stem, within half a semitone and 12 ms at both ends: matched,
missing (Python only), extra (JS only), identical, and equal to 1e-12; for matched notes, the largest difference of
every field and of the bend curves (times, semitones, holds), and how many changed family or vibrato. Basic Pitch's
own events are compared too (frames, pitch and bends; amplitude). Python's run is kept in py-notes/ (its model
output as float32 files, its 22.05 kHz signals, its timing).

  python tools/parity.py ear [name-substring ...]

ear: the width stage (Ear, pack_curves, ear_line) on the same input on both sides, made once by server/pipeline.py
from Python's stems (py-ear-in/: the 22.05 kHz stems, notes_by_stem's records, the voice and bass lines, the gain).
Per drop (1, 3, 10 dB), the difference in semitones of note, voice and bass widths, raw and after the pack's u8
quantisation; bends, holds and each note's (start, count); the 3 dB medians pack stats report; timing.
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


TONE_NAMES = ('vocals', 'bass', 'other', 'guitar', 'piano')


def tone(song, path, outdir, device, workers=8):
    """pipeline.tone's measurements against src/pipeline/tone.mjs, slice by slice, on Python's stems (py-s0): a slice
    every 0.5 s of each stem the tone stage reads. Python: the pipeline's own resampling, level and process pool
    (_tone_init, _tone_slice). JS (tools/parity_tone.mjs): from the same 44.1 kHz stems with its own resampling, and
    from Python's 48 kHz stems (the MOSQITO port alone)."""
    import concurrent.futures, multiprocessing
    from server import pipeline as P
    py = os.path.join(outdir, 'py-s0')
    if not os.path.exists(os.path.join(py, 'timing.json')):
        py_separate(path, py, device, 0)
    d = os.path.join(outdir, 'tone')
    os.makedirs(os.path.join(d, 'py48'), exist_ok=True)
    pyres = os.path.join(d, 'py.json')
    if not os.path.exists(pyres):
        st = {k: v.astype(np.float32) for k, v in read_stems(py).items()}
        t0 = time.time()
        mix = P.to_rate(sum(v.mean(0) for v in st.values()), 44100, P.TONE_SR)
        gain = 0.0632 / (float(np.sqrt(np.mean(mix ** 2))) + 1e-12)
        paths = {}
        for name in TONE_NAMES:
            y = (P.to_rate(st[name].mean(0), 44100, P.TONE_SR) * gain).astype(np.float32)
            y.tofile(os.path.join(d, 'py48', name + '.f32'))
            paths[name] = os.path.join(d, 'py48', name + '.npy')
            np.save(paths[name], y)
        t1 = time.time()
        dur = st['vocals'].shape[1] / 44100
        keys = [(name, k * 0.5) for name in TONE_NAMES for k in range(int(dur / 0.5) + 1)]
        ctx = multiprocessing.get_context('spawn')
        with concurrent.futures.ProcessPoolExecutor(max_workers=workers, mp_context=ctx, initializer=P._tone_init,
                                                    initargs=(paths,)) as ex:
            res = list(ex.map(P._tone_slice, keys, chunksize=8))
        t2 = time.time()
        for p in paths.values():
            os.remove(p)
        json.dump({'names': TONE_NAMES, 'keys': keys}, open(os.path.join(d, 'keys.json'), 'w'))
        json.dump({'gain': gain, 'workers': workers, 'resample_s': round(t1 - t0, 2), 'slices_s': round(t2 - t1, 2),
                   'res': res}, open(pyres, 'w'))
    subprocess.run(['node', os.path.join(ROOT, 'tools', 'parity_tone.mjs'), d, py, '--workers', str(workers)],
                   check=True)
    p, j = json.load(open(pyres)), json.load(open(os.path.join(d, 'js.json')))
    keys = json.load(open(os.path.join(d, 'keys.json')))['keys']
    P_, J, Q = (np.array(x, np.float64) for x in (p['res'], j['full'], j['pyin']))

    def diff(a, b):
        """|a - b| over slices that either side measured (not near-silent): percentiles in asper and acum, how many
        differ by more than 0.01, how often harshness at the defaults (> 0.3) disagrees, and the largest."""
        live = (a != 0).any(1) | (b != 0).any(1)
        d_ = np.abs(a - b)[live]
        ha = np.array([P.harshness(*x) > 0.3 for x in a]); hb = np.array([P.harshness(*x) > 0.3 for x in b])
        gate = ((a == 0).all(1) != (b == 0).all(1))
        worst = np.argsort(-np.abs(a - b).max(1))[:5]
        q = lambda c, x: float('%.3g' % np.percentile(d_[:, c], x)) if len(d_) else 0.0
        return {'slices': len(a), 'measured': int(live.sum()),
                'asper': {'p50': q(0, 50), 'p95': q(0, 95), 'p99': q(0, 99), 'max': q(0, 100),
                          'over_0.01': int((d_[:, 0] > 0.01).sum())},
                'acum': {'p50': q(1, 50), 'p95': q(1, 95), 'p99': q(1, 99), 'max': q(1, 100),
                         'over_0.01': int((d_[:, 1] > 0.01).sum())},
                'harsh_disagree': int((ha != hb).sum()), 'harsh_slices': int(ha.sum()),
                'silence_gate_disagree': int(gate.sum()),
                'worst': [[keys[i][0], keys[i][1], [round(x, 4) for x in a[i]], [round(x, 4) for x in b[i]]]
                          for i in worst]}

    return {'js_vs_python': diff(P_, J), 'port_alone': diff(P_, Q), 'resampling_alone': diff(Q, J),
            'gain': {'python': p['gain'], 'js': j['gain']}, 'signal_48k': j['signal'],
            'timing': {'python': {k: p[k] for k in ('workers', 'resample_s', 'slices_s')},
                       'js': {k: j[k] for k in ('workers', 'warm_s', 'resample_s', 'slices_s', 'slices_pyin_s')}}}


def print_tone(song, res):
    for k in ('js_vs_python', 'port_alone', 'resampling_alone'):
        r = res[k]
        print('%-40s %-17s %5d/%-5d slices  asper p50 %.1e p99 %.1e max %.1e  acum p50 %.1e p99 %.1e max %.1e  '
              'harsh>0.3 disagree %d/%d  gate %d' % (
                  song if k == 'js_vs_python' else '', k, r['measured'], r['slices'], r['asper']['p50'],
                  r['asper']['p99'], r['asper']['max'], r['acum']['p50'], r['acum']['p99'], r['acum']['max'],
                  r['harsh_disagree'], r['harsh_slices'], r['silence_gate_disagree']), flush=True)
    t = res['timing']
    print('%-40s python %.1f s (+%.1f s resampling), js %.1f s (+%.1f s resampling), %d workers each' % (
        '', t['python']['slices_s'], t['python']['resample_s'], t['js']['slices_s'], t['js']['resample_s'],
        t['js']['workers']), flush=True)



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


def py_ear_inputs(stems_dir, out, device):
    """The width stage's inputs, made by server/pipeline.py from Python's own stems (py-s0) as analyze() makes them:
    every stem at 22.05 kHz (librosa soxr_hq), the notes (notes_by_stem), the voice and bass lines (CREPE, pYIN) and
    the gain that sets the mix to 70 dB SPL. Written as raw float32 / JSON for the JS to read."""
    from server import pipeline as P
    stems = read_stems(stems_dir)
    dur = stems['drums'].shape[1] / 44100
    F = max(16, int(np.ceil(dur * P.SR / P.HOP)))
    st22 = {k: P.to_rate(v.mean(0), 44100, P.SR) for k, v in stems.items()}
    t = time.time()
    segs = P.notes_by_stem(stems, st22)
    t1 = time.time()
    _, bassHz, _ = P.bass_line(st22['bass'], F)
    leadHz = P.voice_line(stems['vocals'], F, device)[0]
    gain = 0.0632 / (float(np.sqrt(np.mean(sum(v.mean(0) for v in stems.values()) ** 2))) + 1e-12)
    os.makedirs(out, exist_ok=True)
    for k, v in st22.items():
        np.asarray(v, '<f4').tofile(os.path.join(out, 'st22_%s.f32' % k))
    np.asarray(leadHz, '<f4').tofile(os.path.join(out, 'leadHz.f32'))
    np.asarray(bassHz, '<f4').tofile(os.path.join(out, 'bassHz.f32'))
    rec = [[float(x) for x in r[:13]] + [[np.asarray(c, np.float64).tolist() for c in r[13]]] for r in segs]
    types = sorted({type(x).__name__ for r in segs for x in r[:3]} | {np.asarray(c).dtype.name for r in segs for c in r[13]})
    json.dump(rec, open(os.path.join(out, 'segs.json'), 'w'))
    json.dump({'gain': gain, 'F': F, 'types': types, 'notes_s': round(t1 - t, 1)},
              open(os.path.join(out, 'inputs.json'), 'w'))


def py_ear(inp, out):
    """server/pipeline.py's width stage on those inputs, as analyze() runs it, timed."""
    from server import pipeline as P
    meta = json.load(open(os.path.join(inp, 'inputs.json')))
    gain = meta['gain']
    st22 = {k: np.fromfile(os.path.join(inp, 'st22_%s.f32' % k), '<f4') for k in SOURCES}
    segs = [r[:13] + [tuple(np.array(c) for c in r[13])] for r in json.load(open(os.path.join(inp, 'segs.json')))]
    leadHz, bassHz = (np.fromfile(os.path.join(inp, n + '.f32'), '<f4') for n in ('leadHz', 'bassHz'))
    t = time.time()
    ears = {}
    for name in P.NOTE_STEMS:
        if name in st22 and any(P.NOTE_STEMS[int(r[12])] == name for r in segs):
            ears[name] = P.Ear(st22[name], gain)
    names = list(ears)
    t1 = time.time()
    bends, holds, widths, where = P.pack_curves(segs, ears)
    t2 = time.time()
    ears = None
    vEar = P.Ear(st22['vocals'], gain)
    t3 = time.time()
    leadEar = P.ear_line(vEar, leadHz)
    t4 = time.time()
    vEar = None
    bEar = P.Ear(st22['bass'], gain)
    t5 = time.time()
    bassEar = P.ear_line(bEar, bassHz)
    t6 = time.time()
    os.makedirs(out, exist_ok=True)
    np.save(os.path.join(out, 'bends.npy'), np.array(bends, np.float64))
    np.save(os.path.join(out, 'holds.npy'), np.array(holds, np.float64))
    np.save(os.path.join(out, 'widths.npy'), np.array(widths, np.float64))
    np.save(os.path.join(out, 'leadEar.npy'), leadEar)
    np.save(os.path.join(out, 'bassEar.npy'), bassEar)
    json.dump(where, open(os.path.join(out, 'where.json'), 'w'))
    json.dump({'ear_s': round(t1 - t + t3 - t2 + t5 - t4, 2), 'widths_s': round(t2 - t1 + t4 - t3 + t6 - t5, 2),
               'total_s': round(t6 - t, 2), 'note_ears': names},
              open(os.path.join(out, 'timing.json'), 'w'))


def width_diffs(py, js, drops=(1, 3, 10)):
    """py, js: (rows, 6) widths, (down, up) at each drop. Per drop, the absolute difference in semitones (down and
    up together): its distribution, and the same after the pack's u8 quantisation (0..EAR_SPAN in 255 steps)."""
    from server import pipeline as P
    q = lambda a: np.clip(np.round((a - 0) / P.EAR_SPAN * 255), 0, 255)
    res = {}
    for i, d in enumerate(drops):
        a, b = py[:, 2 * i:2 * i + 2].ravel(), js[:, 2 * i:2 * i + 2].ravel()
        x = np.abs(a - b)
        qx = np.abs(q(a) - q(b)) * P.EAR_SPAN / 255
        pct = lambda v: {'median': float(np.median(v)), 'p99': float(np.percentile(v, 99)), 'p999': float(np.percentile(v, 99.9)),
                         'max': float(v.max()), 'over_0.01': int((v > 0.01).sum()), 'over_0.125': int((v > 0.125).sum()),
                         'over_1': int((v > 1).sum())} if len(v) else {}
        res['%ddB' % d] = {'n': int(len(x)), 'raw': pct(x), 'u8': dict(pct(qx), differ=int((qx > 0).sum()))}
    return res


def ear_median(e, hz=None):
    """pack stats' earWidth3dB: the median of down + up at 3 dB (over frames that sound, for a line)."""
    if hz is not None:
        e = e[hz > 0]
    return round(float(np.median(e[:, 2] + e[:, 3])), 2) if len(e) else 0


def ear(song, path, outdir, device):
    inp, py, js = (os.path.join(outdir, d) for d in ('py-ear-in', 'py-ear', 'js-ear'))
    if not os.path.exists(os.path.join(outdir, 'py-s0', 'timing.json')):
        stems(song, path, outdir, device)
    if not os.path.exists(os.path.join(inp, 'inputs.json')):
        py_ear_inputs(os.path.join(outdir, 'py-s0'), inp, device)
    if not os.path.exists(os.path.join(py, 'timing.json')):
        py_ear(inp, py)
    if not os.path.exists(os.path.join(js, 'timing.json')):
        subprocess.run(['node', os.path.join(ROOT, 'tools', 'analyse.mjs'), '--ear-in', inp, '--out', js], check=True)
    leadHz, bassHz = (np.fromfile(os.path.join(inp, n + '.f32'), '<f4') for n in ('leadHz', 'bassHz'))
    P = {k: np.load(os.path.join(py, k + '.npy')) for k in ('bends', 'holds', 'widths', 'leadEar', 'bassEar')}
    J = {k: np.fromfile(os.path.join(js, k + '.f64'), '<f8') for k in ('bends', 'holds', 'widths')}
    J.update({k: np.fromfile(os.path.join(js, k + '.f32'), '<f4').reshape(-1, 6) for k in ('leadEar', 'bassEar')})
    pw, jw = P['widths'].reshape(-1, 6), J['widths'].reshape(-1, 6)
    same_where = json.load(open(os.path.join(py, 'where.json'))) == json.load(open(os.path.join(js, 'where.json')))
    res = {'where_identical': same_where, 'samples': len(pw),
           'bends_max': float(np.abs(P['bends'] - J['bends']).max()) if len(pw) else 0.0,
           'holds_max': float(np.abs(P['holds'] - J['holds']).max()) if len(pw) else 0.0,
           'notes': width_diffs(pw, jw), 'voice': width_diffs(P['leadEar'][leadHz > 0], J['leadEar'][leadHz > 0]),
           'bass': width_diffs(P['bassEar'][bassHz > 0], J['bassEar'][bassHz > 0]),
           'medians_3dB': {'python': {'voice': ear_median(P['leadEar'], leadHz), 'bass': ear_median(P['bassEar'], bassHz),
                                      'notes': ear_median(pw)},
                           'js': {'voice': ear_median(J['leadEar'], leadHz), 'bass': ear_median(J['bassEar'], bassHz),
                                  'notes': ear_median(jw)}},
           'timing': {'python': json.load(open(os.path.join(py, 'timing.json'))),
                      'js': json.load(open(os.path.join(js, 'timing.json')))}}
    return res


def print_ear(song, res):
    print('%-40s %d note samples, where identical %s, bends max diff %.1e, holds %.1e' % (
        song, res['samples'], res['where_identical'], res['bends_max'], res['holds_max']), flush=True)
    for part in ('notes', 'voice', 'bass'):
        line = ('\n%-46s' % '').join('%s: n %d raw med %.0e p99.9 %.0e max %.1e >1/8 st %d | u8 differ %d max %.2f' % (
            d, r['n'], r['raw']['median'], r['raw']['p999'], r['raw']['max'], r['raw']['over_0.125'], r['u8']['differ'],
            r['u8']['max']) for d, r in res[part].items() if r['raw'])
        print('%-40s %-5s %s' % ('', part, line), flush=True)
    m, t = res['medians_3dB'], res['timing']
    print('%-40s 3 dB medians python %s js %s; python %.1f s (ears %.1f, widths %.1f), js %.1f s on %d workers' % (
        '', m['python'], m['js'], t['python']['total_s'], t['python']['ear_s'], t['python']['widths_s'],
        t['js']['ear_s'], t['js']['workers']), flush=True)



NOTE_STEMS = ('other', 'guitar', 'piano')


def py_notes(stemdir, out):
    """server/pipeline.py notes_by_stem on the stems in stemdir, as analyze() runs it (st22 by to_rate, Basic Pitch on
    ONNX Runtime's CPU provider), keeping what each step made: Basic Pitch's model output (note, onset, contour as
    float32 files), its note events, the 22.05 kHz signals, and the timing of each step."""
    import soundfile as sf
    import basic_pitch.inference as BI
    from server import pipeline as P
    stems = {s: sf.read(os.path.join(stemdir, s + '.wav'), dtype='float32')[0].T for s in NOTE_STEMS}
    os.makedirs(out, exist_ok=True)
    t = time.time()
    st22 = {k: P.to_rate(v.mean(0), 44100, P.SR) for k, v in stems.items()}
    timing = {'resample_s': round(time.time() - t, 2)}
    for k, v in st22.items():
        sf.write(os.path.join(out, k + '22.wav'), v, P.SR, subtype='FLOAT')
    seen, steps = [], {}
    real_predict, real_nfs, real_jb, real_nd = BI.predict, P.notes_from_stem, P.join_bends, P.note_details

    def predict(*a, **k):
        r = real_predict(*a, **k)
        seen.append(r)
        return r

    def timed(name, f):
        def g(*a, **k):
            t = time.time()
            r = f(*a, **k)
            steps[name] = steps.get(name, 0) + time.time() - t
            return r
        return g
    BI.predict = predict
    P.notes_from_stem, P.join_bends, P.note_details = (timed('notes_from_stem', real_nfs), timed('join_bends', real_jb),
                                                        timed('note_details', real_nd))
    try:
        t = time.time()
        segs = P.notes_by_stem(stems, st22)
        timing['notes_by_stem_s'] = round(time.time() - t, 2)
    finally:
        BI.predict, P.notes_from_stem, P.join_bends, P.note_details = real_predict, real_nfs, real_jb, real_nd
    timing.update({k + '_s': round(v, 2) for k, v in steps.items()})
    events = {}
    for name, (o, _, ev) in zip(NOTE_STEMS, seen):
        for k in ('note', 'onset', 'contour'):
            o[k].astype('<f4').tofile(os.path.join(out, '%s.%s.f32' % (name, k)))
        events[name] = [[float(a), float(b), int(p), float(v), [int(x) for x in bd] if bd is not None else None]
                        for a, b, p, v, bd in ev]
    recs = [r[:13] + [[np.asarray(c, float).tolist() for c in r[13]]] for r in segs]
    json.dump({'events': events, 'notes': recs}, open(os.path.join(out, 'notes.json'), 'w'))
    import onnxruntime as ort
    timing['onnxruntime'] = ort.__version__
    json.dump(timing, open(os.path.join(out, 'timing.json'), 'w'))


NOTE_FIELDS = ('t0', 't1', 'midi', 'amp', 'brightness', 'noise', 'family', 'attack', 'fade', 'vib_depth', 'vib_rate',
               'hollow')


def match_notes(a, b, tol=0.012):
    """One-to-one matches between note records a and b: the same stem, within half a semitone and tol seconds (about
    one Basic Pitch frame) at both ends, nearest first. Returns [(i, j)...]."""
    near = {}
    for j, y in enumerate(b):
        near.setdefault((y[12], round(y[2])), []).append(j)
    pairs = []
    for i, x in enumerate(a):
        for p in (round(x[2]) - 1, round(x[2]), round(x[2]) + 1):
            for j in near.get((x[12], p), []):
                y = b[j]
                if abs(x[2] - y[2]) <= 0.5 and abs(x[0] - y[0]) <= tol and abs(x[1] - y[1]) <= tol:
                    pairs.append((abs(x[0] - y[0]) + abs(x[1] - y[1]) + abs(x[2] - y[2]), i, j))
    pairs.sort()
    ua, ub, out = set(), set(), []
    for _, i, j in pairs:
        if i not in ua and j not in ub:
            ua.add(i)
            ub.add(j)
            out.append((i, j))
    return out


def near(a, b, tol=1e-12):
    """Two note records equal to within tol (relative) in every field and every point of the curve."""
    if len(a[13][0]) != len(b[13][0]):
        return False
    x = np.concatenate([np.asarray(a[:13], float)] + [np.asarray(c, float) for c in a[13]])
    y = np.concatenate([np.asarray(b[:13], float)] + [np.asarray(c, float) for c in b[13]])
    return bool(np.all(np.abs(x - y) <= tol * np.maximum(1, np.abs(x))))


def note_diffs(py, js):
    """Counts by stem (matched, missing: Python only, extra: JS only, identical: every field and the curve equal,
    within_1e-12: equal but for the last bits);
    for matched notes, the largest and median difference of each field and how many differ by more than 1e-6, how
    many changed family or vibrato, and the bend curves' differences (times, semitones, holds) where their lengths
    agree."""
    m = match_notes(py, js)
    res = {'stems': {}}
    for s, name in enumerate(NOTE_STEMS):
        mk = [(i, j) for i, j in m if py[i][12] == s]
        same = sum(1 for i, j in mk if py[i][:13] == js[j][:13] and py[i][13] == js[j][13])
        close = sum(1 for i, j in mk if near(py[i], js[j]))
        r = res['stems'][name] = {'python': sum(1 for x in py if x[12] == s), 'js': sum(1 for x in js if x[12] == s),
                                  'matched': len(mk), 'identical': same, 'within_1e-12': close}
        r['missing'], r['extra'] = r['python'] - len(mk), r['js'] - len(mk)
    if not m:
        return res
    P = np.array([py[i][:12] for i, _ in m], float)
    J = np.array([js[j][:12] for _, j in m], float)
    D = np.abs(P - J)
    res['fields'] = {f: {'max': float(D[:, k].max()), 'median': float(np.median(D[:, k])),
                         'over_1e-6': int((D[:, k] > 1e-6).sum())} for k, f in enumerate(NOTE_FIELDS)}
    res['family_changed'] = int((P[:, 6] != J[:, 6]).sum())
    res['vibrato_changed'] = int(((P[:, 9] > 0) != (J[:, 9] > 0)).sum())
    lens, worst = 0, [0.0, 0.0, 0.0]
    for i, j in m:
        a, b = py[i][13], js[j][13]
        if len(a[0]) != len(b[0]):
            lens += 1
            continue
        for k in range(3):
            if len(a[k]):
                worst[k] = max(worst[k], float(np.abs(np.subtract(a[k], b[k])).max()))
    res['curves'] = {'length_differs': lens, 'times_max': worst[0], 'semitones_max': worst[1], 'holds_max': worst[2]}
    return res


def event_counts(py, js):
    """Basic Pitch's own note events (before join_bends), per stem: how many; how many have the same start, end,
    pitch and bends (same); how many are identical, amplitude too; the largest amplitude difference of the same."""
    out = {}
    for name in NOTE_STEMS:
        a, b = py.get(name, []), js.get(name, [])
        left = {}
        for e in b:
            left.setdefault(json.dumps([e[0], e[1], e[2], e[4]]), []).append(e[3])
        same = ident = 0
        worst = 0.0
        for e in a:
            amps = left.get(json.dumps([e[0], e[1], e[2], e[4]]))
            if amps:
                v = min(amps, key=lambda x: abs(x - e[3]))
                amps.remove(v)
                same += 1
                ident += v == e[3]
                worst = max(worst, abs(v - e[3]))
        out[name] = {'python': len(a), 'js': len(b), 'same': same, 'identical': ident, 'amp_max_diff': worst}
    return out


def notes(song, path, outdir, device):
    stemdir = os.path.join(outdir, 'py-s0')
    if not os.path.exists(os.path.join(stemdir, 'piano.wav')):
        stems(song, path, outdir, device)
    py, js, js22 = (os.path.join(outdir, d) for d in ('py-notes', 'js-notes', 'js-notes-py22'))
    if not os.path.exists(os.path.join(py, 'timing.json')):
        py_notes(stemdir, py)
    node = ['node', os.path.join(ROOT, 'tools', 'analyse.mjs'), '--stems-in', stemdir, '--ep', 'cpu',
            '--stages', 'notes']
    if not os.path.exists(os.path.join(js, 'timing.json')):
        subprocess.run(node + ['--out', js], check=True)
    if not os.path.exists(os.path.join(js22, 'timing.json')):
        subprocess.run(node + ['--out', js22, '--st22', py, '--batch', '1'], check=True)
    P, J, J22 = (json.load(open(os.path.join(d, 'notes.json'))) for d in (py, js, js22))
    return {'notes': note_diffs(P['notes'], J['notes']), 'notes_with_python_22k': note_diffs(P['notes'], J22['notes']),
            'events': event_counts(P['events'], J['events']),
            'events_with_python_22k': event_counts(P['events'], J22['events']),
            'timing': {'python': json.load(open(os.path.join(py, 'timing.json'))),
                       'js': json.load(open(os.path.join(js, 'timing.json')))}}


def print_notes(song, res):
    for key, ekey, label in (('notes', 'events', 'own 22k, 8 windows a call'),
                             ('notes_with_python_22k', 'events_with_python_22k', 'py 22k, 1 window a call')):
        r, e = res[key], res[ekey]
        line = '  '.join('%s %d/%d -%d +%d =%d ~%d' % (s, v['matched'], v['python'], v['missing'], v['extra'],
                                                       v['identical'], v['within_1e-12'])
                         for s, v in r['stems'].items())
        ev = '  '.join('%s %d/%d/%d (amp %.0e)' % (s, v['identical'], v['same'], v['python'], v['amp_max_diff'])
                       for s, v in e.items())
        print('%-40s notes (%s) matched/python -missing +extra =identical ~within 1e-12: %s; Basic Pitch events '
              'identical/same but amplitude/python: %s' % (
            song if key == 'notes' else '', label, line, ev), flush=True)
        if 'fields' in r:
            f, c = r['fields'], r['curves']
            print('%-40s   max diff (count over 1e-6): %s; family changed %d, vibrato changed %d; curves: %d lengths '
                  'differ, max %.1e s %.1e st %.1e hold' % (
                      '', '  '.join('%s %.1e (%d)' % (k, v['max'], v['over_1e-6']) for k, v in f.items()),
                      r['family_changed'], r['vibrato_changed'], c['length_differs'], c['times_max'],
                      c['semitones_max'], c['holds_max']), flush=True)
    tp, tj = res['timing']['python'], res['timing']['js']
    print('%-40s time: Python notes_by_stem %.1f s (Basic Pitch + decoding %.1f, join %.1f, details %.1f), resample '
          '%.1f; JS notes %.1f s (model %.1f), resample %.1f' % (
              '', tp['notes_by_stem_s'], tp.get('notes_from_stem_s', 0), tp.get('join_bends_s', 0),
              tp.get('note_details_s', 0), tp['resample_s'], tj['notes_s'], tj.get('notes_model_s', 0),
              tj.get('resample_s', 0)), flush=True)


STAGES = {'stems': stems, 'drums': drums, 'notes': notes, 'tone': tone, 'ear': ear}

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
        if stage in ('drums', 'ear'):
            (print_drums if stage == 'drums' else print_ear)(song, res)
            continue
        if stage == 'notes':
            print_notes(song, res)
            continue
        if stage == 'tone':
            print_tone(song, res)
            continue
        line = '  '.join('%s %5.1f' % (s, r['sdr']) for s, r in res['js_vs_python'].items())
        print('%-40s JS vs Python SDR dB: %s' % (song, line), flush=True)
        line = '  '.join('%s %5.1f/%-6.1f' % (s, r['ref_dbfs'], r['err_dbfs']) for s, r in res['js_vs_python'].items())
        print('%-40s stem / difference dBFS: %s' % ('', line), flush=True)
        if 'pipeline_shift_vs_python' in res:
            line = '  '.join('%s %5.1f' % (s, r['sdr']) for s, r in res['pipeline_shift_vs_python'].items())
            print('%-40s the random shift alone:  %s' % ('', line), flush=True)
    json.dump(summary, open(os.path.join(SONGS, 'parity', stage + '.json'), 'w'), indent=1)
