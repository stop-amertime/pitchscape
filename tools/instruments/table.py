# Every method scored on a set, side by side (from score.py's testsongs/multitrack/SET/score-METHOD.json), as a
# markdown table: per class of instrument, mean F1 with its own part ("instrument X plays note Y"); then over all
# instruments that F1, found (its notes printed by any part), all notes F1 (whoever plays them), the share of the
# parts' note frames that are no instrument's, and the voice's notes in parts other than its own.
#   <venv python> tools/instruments/table.py SET [method ...]
import glob, json, os, sys
import numpy as np

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'testsongs', 'multitrack')


def main():
    st = sys.argv[1]; base = os.path.join(ROOT, st)
    methods = sys.argv[2:] or sorted(os.path.basename(f)[6:-5] for f in glob.glob(os.path.join(base, 'score-*.json')))
    R = {m: json.load(open(os.path.join(base, f'score-{m}.json'))) for m in methods}
    classes = sorted({i['class'] for r in R.values() for s in r for i in s['instruments']},
                     key=lambda c: -sum(1 for s in next(iter(R.values())) for i in s['instruments'] if i['class'] == c))
    n = {c: sum(1 for s in next(iter(R.values())) for i in s['instruments'] if i['class'] == c) for c in classes}
    print(f"{st}: {len(next(iter(R.values())))} songs\n")
    print('| method | ' + ' | '.join(f'{c} ({n[c]})' for c in classes) + ' | all | found | all notes | no one\'s | voice elsewhere |')
    print('|' + ' --- |' * (len(classes) + 6))
    for m, r in R.items():
        I = [i for s in r for i in s['instruments']]
        row = [f"{np.mean([i['f1'] for i in I if i['class'] == c]):.2f}" for c in classes]
        nf = sum(q['frames'] for s in r for q in s.get('note_parts', []))
        none = sum(q['none'] * q['frames'] for s in r for q in s.get('note_parts', [])) / max(1, nf)
        # the voice's notes in other parts: frames of parts not paired with a voice that are a voice's notes
        vel, vtot = 0.0, 0
        for s in r:
            voices = {i['instrument'] for i in s['instruments'] if i['class'] == 'voice'}
            own = {i['part'] for i in s['instruments'] if i['class'] == 'voice'}
            for q in s.get('note_parts', []):
                if q['part'] in own: continue
                vel += sum(v for k, v in q['share'].items() if k in voices) * q['frames']; vtot += q['frames']
        row += [f"{np.mean([i['f1'] for i in I]):.2f}", f"{np.mean([i['found'] for i in I]):.2f}",
                f"{np.mean([s['all_f1'] for s in r if 'all_f1' in s]):.2f}", f'{none:.0%}', f'{vel / max(1, vtot):.0%}' if vtot else '-']
        print(f'| {m} | ' + ' | '.join(row) + ' |')


if __name__ == '__main__':
    main()
