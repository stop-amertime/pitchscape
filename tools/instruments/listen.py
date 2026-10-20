# A listening page for the methods (the scores are only as good as their references; ears decide): short clips of
# each song, every method's parts and the true instruments, each part's audio and notes, played in sync with mute and
# solo (listen.html). Writes testsongs/multitrack/listen/ (git-ignored, as all audio): index.html, clips.json and
# the clips (16-bit WAV, 22.05 kHz, stereo where the part is).
#   <venv python> tools/instruments/listen.py SET/SONG[@START] [SET/SONG[@START] ...] [--dur 20] [--methods a,b,c]
#   python -m http.server 8831 --directory testsongs/multitrack/listen
import json, os, shutil, sys
import numpy as np, soundfile as sf, librosa

HERE = os.path.dirname(os.path.abspath(__file__)); REPO = os.path.join(HERE, '..', '..')
ROOT = os.path.join(REPO, 'testsongs', 'multitrack'); OUT = os.path.join(ROOT, 'listen')
SR = 22050
SKIP = {'truth', 'oracle', 'baseline'}            # oracle: the truth's audio again; methods listed in --methods win
DESC = {'baseline': "today's pipeline: its stems, Basic Pitch notes, the voice as one CREPE line",
        'lines': "today's pipeline as the page draws it by default (Lines)",
        'ymt3': 'YourMT3+: notes labelled by instrument, straight from the mix (no audio of its own)',
        'pan': 'stereo split of each stem, shared by closeness to each place', 'pan2': 'stereo split of each stem, solved exactly two at a time',
        'mf': 'voice stem split male / female (BS-RoFormer)', 'chorus': 'voice stem split male / female, choir model (BS-RoFormer)',
        'karaoke': 'voice stem split lead / backing (Mel-RoFormer)', 'medley': 'voice stem split into two singers (MedleyVox)',
        'medley4': 'voice stem split into four singers (MedleyVox twice)',
        'mvmix2': 'MedleyVox on the mix itself: two singers', 'mvmix4': 'MedleyVox on the mix itself, split twice: four singers',
        'septest-mf': 'male / female model on the mix itself', 'septest-chorus': 'choir male / female model on the mix itself',
        'septest-karaoke': 'lead / backing model on the mix itself',
        'oracle': 'PERFECT separation (each true track) read by Basic Pitch: what the note reader adds on its own',
        'oracle-line': 'PERFECT separation (each true track) read as one voice (CREPE): what the voice reader adds on its own'}


def desc(m):
    base = m[:-5] if m.endswith('-line') else m
    if m in DESC: return DESC[m]
    return DESC.get(base, m) + (', each part read as one voice (CREPE)' if m.endswith('-line') else '')


def clip(path, t0, dur):
    y, _ = librosa.load(path, sr=SR, mono=False, offset=t0, duration=dur)
    y = np.atleast_2d(y).T                                          # (n, channels)
    n = int(dur * SR)
    return np.pad(y, ((0, max(0, n - len(y))), (0, 0)))[:n]


def notes_in(notes, t0, dur):
    return [[round(max(0, a - t0), 3), round(min(dur, b - t0), 3), m] for a, b, m in notes if b > t0 and a < t0 + dur]


def main():
    argv = sys.argv[1:]; dur = 20.0; want = None
    if '--dur' in argv: i = argv.index('--dur'); dur = float(argv[i + 1]); del argv[i:i + 2]
    if '--methods' in argv: i = argv.index('--methods'); want = argv[i + 1].split(','); del argv[i:i + 2]
    os.makedirs(OUT, exist_ok=True); clips = []
    for spec in argv:
        ss, _, at = spec.partition('@'); st, song = ss.split('/')
        d = os.path.join(ROOT, st, song); T = json.load(open(os.path.join(d, 'truth.json')))
        mixlen = sf.info(os.path.join(d, T['mix'])).duration
        t0 = float(at) if at else max(0.0, mixlen / 2 - dur / 2)
        cid = f'{st}-{song}'; cd = os.path.join(OUT, cid); os.makedirs(cd, exist_ok=True)

        def save(name, path):
            f = f'{cid}/{name}.wav'; sf.write(os.path.join(OUT, f), clip(path, t0, dur), SR, subtype='PCM_16'); return f
        groups = [{'name': 'truth', 'parts': [{'name': i['name'], 'audio': save('truth-' + str(k), os.path.join(d, i['audio'])),
                                               'notes': notes_in(i.get('notes') or [], t0, dur)} for k, i in enumerate(T['instruments'])]}]
        methods = want or ['baseline'] + sorted(f[:-5] for f in os.listdir(d) if f.endswith('.json') and f[:-5] not in SKIP
                                                  and not f.startswith(('truth', 'pack-', 'score', 'oracle-', 'septest', 'mixnotes')))
        for m in methods:
            p = os.path.join(d, m + '.json')
            if not os.path.exists(p): continue
            M = json.load(open(p)); parts = []
            for k, q in enumerate(M['parts']):
                a = q.get('audio')
                parts.append({'name': q['name'], 'audio': save(f'{m}-{k}', os.path.join(d, a)) if a else None,
                              'notes': notes_in(q.get('notes') or [], t0, dur)})
            groups.append({'name': m, 'desc': desc(m), 'parts': parts})
        clips.append({'id': cid, 'set': st, 'song': song, 'start': round(t0, 2), 'dur': dur,
                      'mix': save('mix', os.path.join(d, T['mix'])), 'groups': groups})
        print(cid, [g['name'] for g in groups], flush=True)
    old = os.path.join(OUT, 'clips.json')
    keep = [c for c in (json.load(open(old)) if os.path.exists(old) else []) if c['id'] not in {c['id'] for c in clips}]
    json.dump(keep + clips, open(old, 'w'))
    shutil.copy(os.path.join(HERE, 'listen.html'), os.path.join(OUT, 'index.html'))


if __name__ == '__main__':
    main()
