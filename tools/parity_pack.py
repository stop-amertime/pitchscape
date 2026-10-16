"""Compare a whole pack from the JavaScript pipeline (tools/analyse_pack.mjs) with Python's (server/pipeline.py analyze),
both made from the same stems: Python's Demucs output in testsongs/parity/<song>/py-s0 (tools/parity.py stems).

  python tools/parity_pack.py [name-substring ...] [--device cuda] [--no-words] [--fresh] [--python-only]

Writes testsongs/parity/<song>/py-pack.json and js-pack.json (kept: --fresh makes them again) and pack.json (the
comparison), and prints a line per field: frame arrays as the share of frames where both are on (non-zero) or off,
and how far apart they are where both are on (cents for pitch); events and notes as matched counts and field
differences; the per-sample curves after decoding their bytes; stats side by side.
"""
import base64, json, os, subprocess, sys, time

import numpy as np

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
sys.path.insert(0, ROOT)
SONGS = os.path.join(ROOT, 'testsongs')


def f32(s):
    return np.frombuffer(base64.b64decode(s), '<f4').astype(np.float64)


def unbytes(b):
    q = np.frombuffer(base64.b64decode(b['data']), np.uint8).astype(np.float64)
    return b['lo'] + q * (b['hi'] - b['lo']) / 255


def frames(py, js, name):
    a, b = f32(py['arrays'][name]), f32(js['arrays'][name])
    n = min(len(a), len(b))
    a, b = a[:n], b[:n]
    on_a, on_b = a != 0, b != 0
    both = on_a & on_b
    r = {'agree_on_off': round(float(np.mean(on_a == on_b)), 4), 'on_py': int(on_a.sum()), 'on_js': int(on_b.sum())}
    if both.any():
        if name.endswith('Hz'):
            c = np.abs(1200 * np.log2(b[both] / a[both]))
            r.update(cents_median=round(float(np.median(c)), 2), cents_p99=round(float(np.percentile(c, 99)), 2))
        else:
            d = np.abs(a[both] - b[both])
            r.update(diff_median=float('%.3g' % np.median(d)), diff_max=float('%.3g' % d.max()),
                     scale=float('%.3g' % np.median(np.abs(a[both]))))
    return r


def rows(py, js, name, stride):
    a, b = f32(py['arrays'][name]).reshape(-1, stride), f32(js['arrays'][name]).reshape(-1, stride)
    # match by start time (and kind / pitch): each Python row to the nearest unused JS row within 15 ms
    used, pairs = set(), []
    order = np.argsort(b[:, 0])
    bt = b[order, 0]
    for i, row in enumerate(a):
        lo = np.searchsorted(bt, row[0] - 0.015)
        best = None
        for k in range(lo, len(bt)):
            if bt[k] > row[0] + 0.015:
                break
            j = order[k]
            same = row[1] == b[j, 1] if name == 'events' else (row[12] == b[j, 12] and abs(row[2] - b[j, 2]) < 0.6)
            if j not in used and same and (best is None or abs(bt[k] - row[0]) < abs(b[best, 0] - row[0])):
                best = j
        if best is not None:
            used.add(best)
            pairs.append((i, best))
    r = {'py': len(a), 'js': len(b), 'matched': len(pairs)}
    if pairs:
        ia, ib = zip(*pairs)
        d = np.abs(a[list(ia)] - b[list(ib)])
        r['field_diff_max'] = [float('%.3g' % x) for x in d.max(0)]
    return r


def compare(py, js):
    out = {'dur': [py['dur'], js['dur']], 'frames': [py['frames'], js['frames']]}
    for k in py['arrays']:
        if k in ('events', 'segs', 'onsets'):
            continue
        out[k] = frames(py, js, k)
    out['events'] = rows(py, js, 'events', py['eventStride'])
    out['segs'] = rows(py, js, 'segs', py['segStride'])
    on_a, on_b = f32(py['arrays']['onsets']).reshape(-1, 4), f32(js['arrays']['onsets']).reshape(-1, 4)
    out['onsets'] = {'py': len(on_a), 'js': len(on_b)}
    for k in py['bytes']:
        a, b = unbytes(py['bytes'][k]), unbytes(js['bytes'][k])
        n = min(len(a), len(b))
        out['bytes.' + k] = {'len': [len(a), len(b)], 'diff_median': float('%.3g' % np.median(np.abs(a[:n] - b[:n]))) if n else None,
                             'diff_p99': float('%.3g' % np.percentile(np.abs(a[:n] - b[:n]), 99)) if n else None}
    out['noiseRef'] = [py['noiseRef'], js['noiseRef']]
    out['stats'] = {k: [py['stats'].get(k), js['stats'].get(k)] for k in py['stats'] if k != 'seconds'}
    lp, lj = py.get('lyrics'), js.get('lyrics')
    if lp or lj:
        wp = [w for ln in (lp or {}).get('lines', []) for w in ln['words']]
        wj = [w for ln in (lj or {}).get('lines', []) for w in ln['words']]
        d = [abs(a[1] - b[1]) for a, b in zip(wp, wj) if a[0] == b[0]]
        out['lyrics'] = {'words': [len(wp), len(wj)], 'same_word_share': round(len(d) / max(1, len(wp)), 3),
                         'time_diff_median': round(float(np.median(d)), 3) if d else None}
    out['song'] = {k: [py['song'].get(k), js['song'].get(k)] for k in ('title', 'artist', 'album', 'isrc', 'duration')}
    return out


if __name__ == '__main__':
    args = sys.argv[1:]
    device = 'cuda'
    if '--device' in args:
        i = args.index('--device')
        device = args[i + 1]
        del args[i:i + 2]
    words = '--no-words' not in args
    fresh = '--fresh' in args
    python_only = '--python-only' in args
    names = [a for a in args if not a.startswith('--')]
    from server import pipeline as P
    songs = sorted(f for f in os.listdir(SONGS) if f.endswith('.mp3') and (not names or any(a in f for a in names)))
    for f in songs:
        song, path = f[:-4], os.path.join(SONGS, f)
        d = os.path.join(SONGS, 'parity', song)
        stems = os.path.join(d, 'py-s0')
        if not os.path.exists(os.path.join(stems, 'piano.wav')):
            print(song, ': no Python stems; run python tools/parity.py stems', song)
            continue
        pyp, jsp = os.path.join(d, 'py-pack.json'), os.path.join(d, 'js-pack.json')
        if fresh or not os.path.exists(pyp):
            t = time.time()
            pk = P.analyze(path, device=device, stems_dir=stems, words=words, name=f)
            pk['stats']['wall_s'] = round(time.time() - t, 1)
            json.dump(pk, open(pyp, 'w'))
        if python_only:
            continue
        if fresh or not os.path.exists(jsp):
            t = time.time()
            subprocess.run(['node', os.path.join(ROOT, 'tools', 'analyse_pack.mjs'), path, jsp, '--stems-in', stems]
                           + ([] if words else ['--no-words']), check=True)
            print('JS pack in %.1f s' % (time.time() - t))
        py, js = json.load(open(pyp)), json.load(open(jsp))
        res = compare(py, js)
        json.dump(res, open(os.path.join(d, 'pack.json'), 'w'), indent=1)
        print('==', song, '(Python %s s, JS %s s, after stems)' % (py['stats'].get('wall_s', py['stats']['seconds']),
                                                                 js['stats']['seconds']))
        for k, v in res.items():
            print('  %-14s %s' % (k, json.dumps(v)))
