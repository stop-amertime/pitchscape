# The pipeline as it is, as a method for score.py: run the JS pipeline (tools/analyse_pack.mjs, no words) on each
# song's mix, keep its stems, and write <song>/baseline.json: one part per stem (vocals, guitar, piano, other, bass,
# drums) with the stem's audio and its notes. Notes: the notes stage's (Basic Pitch per stem, after its leak and echo
# tests: the pack's segs, by their stem), and for vocals the CREPE voice line cut into notes where it is voiced and
# heard (the page's default cuts: certainty 0.45, level 4%, runs of 90 ms; the leak test's fade over 0.5), a new note
# wherever the rounded pitch changes.
# Also <song>/lines.json: the same parts with the notes the page's default view draws (Lab > Instruments: Lines): each
# stem's lines through time whose ink (lineInk in legacy.js: certainty, peak level, echo, masking) is at least 0.25,
# a note per run of one rounded pitch along the line (its ringing tail included); the voice as above.
#   <venv python> tools/instruments/baseline.py SET [song...]
import base64, json, os, subprocess, sys
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__)); REPO = os.path.join(HERE, '..', '..')
ROOT = os.path.join(REPO, 'testsongs', 'multitrack')
f32 = lambda s: np.frombuffer(base64.b64decode(s), dtype=np.float32)
u8 = lambda d: d['lo'] + np.frombuffer(base64.b64decode(d['data']), np.uint8).astype(np.float64) / 255 * (d['hi'] - d['lo'])


def smoothstep(a, b, x):
    t = min(1.0, max(0.0, (x - a) / (b - a))); return t * t * (3 - 2 * t)


def gate(*conds_dt):
    """The page's default voice cuts (certainty 0.45, level 4%, runs of 90 ms) with the leak fade over half."""
    *conds, dt = conds_dt; v = np.logical_and.reduce(conds); run = max(1, round(0.09 / dt)); f = 0
    while f < len(v):
        if not v[f]: f += 1; continue
        g = f
        while g < len(v) and v[g]: g += 1
        if g - f < run: v[f:g] = False
        f = g
    return v


def line_notes(hz, keep, dt):
    out, cur = [], None
    for f, h in enumerate(hz):
        m = int(round(69 + 12 * np.log2(h / 440))) if h > 0 and keep[f] else None
        if cur and (m is None or m != cur[2]): out.append([cur[0], f * dt, cur[2]]); cur = None
        if m is not None and cur is None: cur = [f * dt, None, m]
    if cur: out.append([cur[0], len(hz) * dt, cur[2]])
    return [n for n in out if n[1] - n[0] >= 0.04]


def run(d):
    T = json.load(open(os.path.join(d, 'truth.json')))
    stems, pack = os.path.join(d, 'stems-baseline'), os.path.join(d, 'pack-baseline.json')
    if not os.path.exists(pack):
        subprocess.run(['node', os.path.join(REPO, 'tools', 'analyse_pack.mjs'), os.path.join(d, T['mix']), pack,
                        '--stems-out', stems, '--no-words'], check=True, cwd=REPO)
    pk = json.load(open(pack)); dt = pk['dt']
    segs = f32(pk['arrays']['segs']).reshape(-1, pk['segStride']); names = pk['noteStems']
    parts = []
    for s in ['vocals', 'guitar', 'piano', 'other', 'bass', 'drums']:
        p = {'name': s, 'audio': os.path.relpath(os.path.join(stems, s + '.wav'), d).replace('\\', '/'), 'notes': []}
        if s in names:
            k = names.index(s)
            p['notes'] = [[float(x[0]), float(x[1]), float(x[2])] for x in segs if int(x[12]) == k]
        if s == 'vocals':
            hz = f32(pk['arrays']['leadHz'])
            fade = u8(pk['bytes']['vocalsLeak']) if 'vocalsLeak' in pk['bytes'] else np.full(len(hz), 72.0)
            p['notes'] = line_notes(hz, gate(f32(pk['arrays']['leadP']) >= 0.45, f32(pk['arrays']['leadL']) >= 0.04, fade > -20, dt), dt)
        parts.append(p)
    json.dump({'parts': parts}, open(os.path.join(d, 'baseline.json'), 'w'))
    W = pk['lineStride']; lp = []
    for p in parts:
        q = dict(p)
        if p['name'] in pk.get('lines', {}):
            Ls = f32(pk['lines'][p['name']]['lines']).reshape(-1, W); P = f32(pk['lines'][p['name']]['pts']).reshape(-1, 3); o = 0; q['notes'] = []
            for f0, n, nt, sure, echo, peak, below in Ls:
                n = int(n + nt); fb = P[o:o + n, 0]; o += n
                ink = 0.9 * sure * smoothstep(-60, -24, peak) * (1 - echo) * np.exp(-0.5 * (2 * below / 30) ** 2)
                if ink < 0.25: continue
                hz = 27.5 * 2 ** (fb / 36)
                q["notes"] += [[float(a + f0 * dt), float(b + f0 * dt), m] for a, b, m in line_notes(hz, np.ones(n, bool), dt)]
        lp.append(q)
    json.dump({'parts': lp}, open(os.path.join(d, 'lines.json'), 'w'))
    print(os.path.basename(d), {p['name']: len(p['notes']) for p in parts}, flush=True)


if __name__ == '__main__':
    base = os.path.join(ROOT, sys.argv[1])
    for s in sys.argv[2:] or sorted(x for x in os.listdir(base) if os.path.exists(os.path.join(base, x, 'truth.json'))):
        run(os.path.join(base, s))
