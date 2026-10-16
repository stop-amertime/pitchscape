"""Run the pipeline over every song in testsongs/ (see tools/fetch_test_songs.sh), on this machine's CPU.

Stems are kept in testsongs/stems/<song>/ so a rerun after a pipeline change skips Demucs; packs go to
testsongs/packs/<song>.json. Usage: python tools/analyse_test_songs.py [name-substring ...]
"""
import json, os, sys, time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from server import pipeline as P  # noqa: E402

if __name__ == '__main__':
    import soundfile as sf
    root = os.path.join(os.path.dirname(__file__), '..', 'testsongs')
    os.makedirs(os.path.join(root, 'packs'), exist_ok=True)
    songs = sorted(f for f in os.listdir(root) if f.endswith('.mp3') and (len(sys.argv) < 2 or any(a in f for a in sys.argv[1:])))
    for f in songs:
        name, path = f[:-4], os.path.join(root, f)
        sd = os.path.join(root, 'stems', name)
        t0 = time.time()
        if not os.path.exists(os.path.join(sd, 'piano.wav')):
            os.makedirs(sd, exist_ok=True)
            for k, v in P.separate(P.decode(path, 44100), 'cpu').items():
                sf.write(os.path.join(sd, k + '.wav'), v.T, 44100, subtype='FLOAT')
        pk = P.analyze(path, stems_dir=sd, name=f)
        json.dump(pk, open(os.path.join(root, 'packs', name + '.json'), 'w'))
        print('%-40s %4.0f s  %s' % (name, time.time() - t0, json.dumps(pk['stats'])), flush=True)
