# How well a method tells the instruments of a song apart, against ground truth (notes/instrument-separation.md).
#
# Truth: testsongs/multitrack/<set>/<song>/truth.json (made by build.py): the mix, and each instrument as recorded or
# rendered on its own: {name, class, audio (wav), notes [[t0, t1, midi], ...]}.
# A method's answer: testsongs/multitrack/<set>/<song>/<method>.json: {parts: [{name, audio (wav, optional),
# notes [[t0, t1, midi], ...]}]}; a part is what the method says is one instrument (a stem, a cluster, a labelled
# group of notes).
#
# Two measures:
#  leaks   for each part with audio: how much of each true instrument is in it. The part is fitted, per frequency bin
#          and per 1 s, as a sum of the true instruments' spectra with complex gains (least squares; 22.05 kHz mono,
#          STFT 2048 / 512); each instrument's share of the part's energy is its fitted part's energy. Reported: the
#          part's main instrument, its share (dB, 0 = all of it), and the loudest other instrument in it (dB under
#          the part). A leak of the voice into a guitar part shows as the voice at, say, -15 dB in that part.
#  notes   piano rolls (20 ms frames, MIDI pitch): every part against every instrument, frame-level F1 (a pitch
#          sounding in both in the same frame). Parts are paired one-to-one with instruments (Hungarian, by F1), so
#          two guitars in one part credit only one of them. Reported per instrument: F1 with its paired part
#          ("instrument X plays note Y") and found: the share of its note frames that some part has (whoever plays
#          them). Per song, all F1: every instrument's notes merged against every part's (the notes are right at
#          all, ignoring who plays them). Instruments without notes (drums) are left out of this.
#          Note leaks, per part with notes: the share of its note frames that are each instrument's notes (that
#          pitch, that frame; a frame two instruments share counts for both), and the share that is no instrument's
#          (wrong notes: overtones, octave errors). The voice's notes printed in a guitar part show here.
#
#          Also per instrument, onset F1 with its paired part: the usual note score (mir_eval: a note matches if its
#          onset is within 50 ms and its pitch within 50 cents; how long it lasts is ignored).
#  Leniency (notes): --tol N counts a pitch within N semitones as the same; --octave counts any octave of it as the
#  same (an octave error is still the right note name). Both apply to the paired F1, found and all notes F1.
#   <venv python> tools/instruments/score.py [--frame SECONDS] [--tol N] [--octave] SET METHOD [song...]
#     -> table, and testsongs/multitrack/SET/score-METHOD.json (score-METHOD-f<ms>.json with another frame)
import json, os, sys, warnings; warnings.filterwarnings('ignore')
import numpy as np, librosa, mir_eval
from scipy.optimize import linear_sum_assignment

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'testsongs', 'multitrack')
SR, NFFT, HOP, CHUNK = 22050, 2048, 512, 43        # CHUNK frames = 1 s
FRAME = 0.02


def load(path, n=None):
    y, _ = librosa.load(path, sr=SR, mono=True)
    if n is not None: y = np.pad(y, (0, max(0, n - len(y))))[:n]
    return y


def leaks(part, srcs):
    """Energy of each source in `part` (fitted per bin and second), and what the fit leaves over."""
    P = librosa.stft(part, n_fft=NFFT, hop_length=HOP)
    S = np.stack([librosa.stft(s, n_fft=NFFT, hop_length=HOP) for s in srcs])     # (n, K, T)
    n, K, T = S.shape
    energy = np.zeros(n); total = float((np.abs(P) ** 2).sum()) + 1e-20
    for c0 in range(0, T, CHUNK):
        Sc, Pc = S[:, :, c0:c0 + CHUNK], P[:, c0:c0 + CHUNK]                       # (n, K, t), (K, t)
        A = np.einsum('ikt,jkt->kij', np.conj(Sc), Sc)                             # (K, n, n) Gram per bin
        b = np.einsum('ikt,kt->ki', np.conj(Sc), Pc)                               # (K, n)
        lam = 1e-6 * (np.einsum('kii->k', A).real[:, None, None] + 1e-12) * np.eye(n)
        g = np.linalg.solve(A + lam, b[..., None])[..., 0]                         # (K, n)
        energy += (np.abs(g.T[:, :, None] * Sc) ** 2).sum(axis=(1, 2))
    return energy / total


def roll(notes, nf):
    R = np.zeros((nf, 128), bool)
    for t0, t1, m in notes:
        m = int(round(m))
        if 0 <= m < 128: R[int(t0 / FRAME):max(int(t0 / FRAME) + 1, int(t1 / FRAME)), m] = True
    return R[:nf]


TOL, OCT = 0, False


def near(R):
    """R widened by TOL semitones either way, and folded over octaves if OCT (what counts as the same pitch)."""
    if OCT:
        C = np.zeros_like(R)
        for k in range(12): C[:, k::12] = R[:, k::12].any(axis=1, keepdims=True)
        R = C
    if TOL:
        W = R.copy()
        for d in range(1, TOL + 1): W[:, d:] |= R[:, :-d]; W[:, :-d] |= R[:, d:]
        R = W
    return R


def f1(a, b):
    """Truth a against answer b: precision is b's frames near some a, recall a's frames near some b."""
    if TOL or OCT: tp_p = (near(a) & b).sum(); tp_r = (a & near(b)).sum()
    else: tp_p = tp_r = (a & b).sum()
    p = tp_p / max(1, b.sum()); r = tp_r / max(1, a.sum())
    return 0.0 if tp_p == 0 or tp_r == 0 else 2 * p * r / (p + r)


def score_song(d, method):
    T = json.load(open(os.path.join(d, 'truth.json'))); M = json.load(open(os.path.join(d, method + '.json')))
    mix = load(os.path.join(d, T['mix'])); n = len(mix); dur = n / SR; nf = int(dur / FRAME) + 1
    out = {'song': os.path.basename(d), 'parts': [], 'instruments': []}
    # leaks
    srcs = [load(os.path.join(d, i['audio']), n) for i in T['instruments']]
    names = [i['name'] for i in T['instruments']]
    for p in M['parts']:
        if not p.get('audio'): continue
        e = leaks(load(os.path.join(d, p['audio']), n), srcs)
        o = np.argsort(-e)
        main, other = o[0], o[1] if len(o) > 1 else None
        db = lambda x: round(float(10 * np.log10(x + 1e-12)), 1)
        out['parts'].append({'part': p['name'], 'main': names[main], 'main_db': db(e[main]),
                             'next': names[other] if other is not None else None, 'next_db': db(e[other]) if other is not None else None,
                             'share_db': {names[i]: db(e[i]) for i in range(len(names)) if e[i] > 1e-4}})
    # notes
    tin = [i for i in T['instruments'] if i.get('notes')]
    TR = [roll(i['notes'], nf) for i in tin]
    PR = [roll(p.get('notes') or [], nf) for p in M['parts']]
    if tin and PR:
        F = np.array([[f1(t, p) for p in PR] for t in TR])
        ri, ci = linear_sum_assignment(-F)
        pair = dict(zip(ri, ci))
        pooled = np.any(PR, axis=0) if PR else np.zeros((nf, 128), bool)
        def onset_f1(a, b):
            if not a or not b: return 0.0
            A, B = np.array(a, float), np.array(b, float)
            A[:, 1] = np.maximum(A[:, 1], A[:, 0] + 1e-3); B[:, 1] = np.maximum(B[:, 1], B[:, 0] + 1e-3)
            return mir_eval.transcription.precision_recall_f1_overlap(A[:, :2], librosa.midi_to_hz(A[:, 2]), B[:, :2], librosa.midi_to_hz(B[:, 2]),
                                                                       offset_ratio=None)[2]
        for k, i in enumerate(tin):
            j = pair.get(k)
            out['instruments'].append({'instrument': i['name'], 'class': i.get('class'),
                                       'part': M['parts'][j]['name'] if j is not None else None,
                                       'f1': round(float(F[k, j]), 3) if j is not None else 0.0,
                                       'onset_f1': round(float(onset_f1(i['notes'], M['parts'][j]['notes'] or [])), 3) if j is not None else 0.0,
                                       'found': round(float((TR[k] & near(pooled)).sum() / max(1, TR[k].sum())), 3)})
        out['all_f1'] = round(f1(np.any(TR, axis=0), pooled), 3)
        anyT = np.any(TR, axis=0)
        for j, (p, P) in enumerate(zip(M['parts'], PR)):
            n = P.sum()
            if not n: continue
            sh = {tin[k]['name']: round(float((P & TR[k]).sum() / n), 3) for k in range(len(tin))}
            out['note_parts'] = out.get('note_parts', []) + [{'part': p['name'], 'frames': int(n), 'share': {k: v for k, v in sh.items() if v >= 0.01},
                                                             'none': round(float((P & ~anyT).sum() / n), 3)}]
    return out


def main():
    global FRAME, TOL, OCT
    argv = sys.argv[1:]; tag = ''
    while argv[0].startswith('--'):
        if argv[0] == '--frame': FRAME = float(argv[1]); argv = argv[2:]; tag += f'-f{round(FRAME * 1000)}'
        elif argv[0] == '--tol': TOL = int(argv[1]); argv = argv[2:]; tag += f'-t{TOL}'
        elif argv[0] == '--octave': OCT = True; argv = argv[1:]; tag += '-oct'
    st, method, songs = argv[0], argv[1], argv[2:]
    base = os.path.join(ROOT, st)
    songs = songs or sorted(s for s in os.listdir(base) if os.path.exists(os.path.join(base, s, method + '.json')))
    res = []
    for s in songs:
        r = score_song(os.path.join(base, s), method); res.append(r)
        print(f"\n{s}")
        for p in r['parts']:
            print(f"  part {p['part']:<14} main {p['main']:<22} {p['main_db']:>6} dB   next {str(p['next']):<22} {p['next_db']} dB")
        for q in r.get('note_parts', []):
            top = sorted(q['share'].items(), key=lambda x: -x[1])[:3]
            print(f"  notes {q['part']:<20} " + '  '.join(f'{k} {v:.0%}' for k, v in top) + f"   no one's {q['none']:.0%}")
        for i in r['instruments']:
            print(f"  inst {i['instrument']:<22} ({i['class']}) -> {str(i['part']):<14} F1 {i['f1']:.2f}   onset F1 {i['onset_f1']:.2f}   found {i['found']:.2f}")
        if 'all_f1' in r: print(f"  all notes, whoever plays them: F1 {r['all_f1']:.2f}")
    allI = [i for r in res for i in r['instruments']]
    if allI:
        byc = {}
        for i in allI: byc.setdefault(i['class'], []).append(i)
        print('\nby class: instruments, mean F1 paired / found')
        for c, v in sorted(byc.items(), key=lambda x: -len(x[1])):
            print(f"  {str(c):<16} {len(v):>3}   {np.mean([x['f1'] for x in v]):.2f} / {np.mean([x['onset_f1'] for x in v]):.2f} / {np.mean([x['found'] for x in v]):.2f}")
        print(f"  {'all':<16} {len(allI):>3}   {np.mean([x['f1'] for x in allI]):.2f} / {np.mean([x['onset_f1'] for x in allI]):.2f} / {np.mean([x['found'] for x in allI]):.2f}")
        print(f"  all notes, whoever plays them: mean F1 {np.mean([r['all_f1'] for r in res if 'all_f1' in r]):.2f}")
    json.dump(res, open(os.path.join(base, f'score-{method}{tag}.json'), 'w'), indent=1)


if __name__ == '__main__':
    main()
