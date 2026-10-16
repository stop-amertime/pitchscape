"""Compare the JavaScript pipeline (src/pipeline, run by tools/analyse.mjs) with the Python one (server/pipeline.py),
stage by stage, on the test songs (tools/fetch_test_songs.sh).

  python tools/parity.py stems [name-substring ...] [--device cuda]

Outputs go to testsongs/parity/<song>/ (git-ignored with testsongs/); a summary is printed and written there as
<stage>.json. Needs the Python pipeline's environment, Node, and the models from tools/export_models.py.

stems: Python's separate() with shifts=0 (no random shift, so both sides are deterministic) against the JS with
shifts=0, as SDR (dB) and correlation per stem. For scale, the pipeline's own run (shifts=1, as kept in
testsongs/stems/<song>/ by tools/analyse_test_songs.py) against the same reference: how much the random shift
alone moves each stem.
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


STAGES = {'stems': stems}

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
        line = '  '.join('%s %5.1f' % (s, r['sdr']) for s, r in res['js_vs_python'].items())
        print('%-40s JS vs Python SDR dB: %s' % (song, line), flush=True)
        line = '  '.join('%s %5.1f/%-6.1f' % (s, r['ref_dbfs'], r['err_dbfs']) for s, r in res['js_vs_python'].items())
        print('%-40s stem / difference dBFS: %s' % ('', line), flush=True)
        if 'pipeline_shift_vs_python' in res:
            line = '  '.join('%s %5.1f' % (s, r['sdr']) for s, r in res['pipeline_shift_vs_python'].items())
            print('%-40s the random shift alone:  %s' % ('', line), flush=True)
    json.dump(summary, open(os.path.join(SONGS, 'parity', stage + '.json'), 'w'), indent=1)
