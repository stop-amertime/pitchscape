# The ceiling, as a method for score.py: perfect separation. Each true instrument's own track is a part, with Basic
# Pitch's notes on it (notes.mjs, as the pipeline reads a stem). Whatever this misses or adds is the note reader's,
# not the separation's: a method can do no better than this by separating alone. Writes <song>/oracle.json.
# --line: read each track as one voice (CREPE, as the pipeline reads the vocal stem; notes.mjs --line) instead, into
# <song>/oracle-line.json: the ceiling for singers, each of whom sings one note at a time.
#   <venv python> tools/instruments/oracle.py [--line] SET [song...]
import json, os, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__)); REPO = os.path.join(HERE, '..', '..')
ROOT = os.path.join(REPO, 'testsongs', 'multitrack')

if __name__ == '__main__':
    line = sys.argv[1] == '--line'; argv = sys.argv[2:] if line else sys.argv[1:]; tag = 'oracle-line' if line else 'oracle'
    base = os.path.join(ROOT, argv[0])
    for s in argv[1:] or sorted(x for x in os.listdir(base) if os.path.exists(os.path.join(base, x, 'truth.json'))):
        d = os.path.join(base, s); T = json.load(open(os.path.join(d, 'truth.json')))
        ins = [i for i in T['instruments'] if i.get('notes')]
        files = [os.path.join(d, i['audio']).replace('\\', '/') for i in ins]
        nj = os.path.join(d, tag + '-notes.json')
        subprocess.run(['node', os.path.join(REPO, 'tools', 'instruments', 'notes.mjs'), *(['--line'] if line else []), nj, *files], check=True, cwd=REPO, stderr=subprocess.DEVNULL)
        N = json.load(open(nj))
        parts = [{'name': i['name'], 'audio': i['audio'], 'notes': N[f]} for i, f in zip(ins, files)]
        json.dump({'parts': parts}, open(os.path.join(d, tag + '.json'), 'w'))
        print(s, [(p['name'], len(p['notes'])) for p in parts], flush=True)
