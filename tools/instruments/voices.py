# Splitting the voice into singers, as methods for score.py: a separation model (python-audio-separator, MIT; the
# models are the community's, trained on their own data) run on the baseline's vocal stem, each of its outputs one
# part with Basic Pitch notes (notes.mjs); the baseline's other stems stay as they are. Methods (MODELS): karaoke =
# lead vs backing (Mel-RoFormer, aufr33 & viperx, SDR 10.2 by its authors), mf = male vs female (BS-RoFormer, aufr33,
# 7.3), chorus = male vs female in a choir (BS-RoFormer, Sucial, 24.1). Writes <song>/<method>.json and the parts
# under <song>/stems-<method>/. The models download once into ~/.cache/pitchscape/sep-models.
# --line reads each output as one voice (CREPE, notes.mjs --line) into <song>/<method>-line.json instead.
# --mix: separate the song's mix itself (a set of voices alone, as duets), with no other parts: <song>/<method>mix.json.
#   <venv python> tools/instruments/voices.py [--line] [--mix] SET METHOD [song...]   (after baseline.py, unless --mix)
import glob, json, os, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__)); REPO = os.path.join(HERE, '..', '..')
ROOT = os.path.join(REPO, 'testsongs', 'multitrack')
MODELS = {'karaoke': 'mel_band_roformer_karaoke_aufr33_viperx_sdr_10.1956.ckpt',
          'mf': 'bs_roformer_male_female_by_aufr33_sdr_7.2889.ckpt',
          'chorus': 'model_chorus_bs_roformer_ep_267_sdr_24.1275.ckpt'}


def main():
    from audio_separator.separator import Separator
    argv = sys.argv[1:]; line = '--line' in argv; mix = '--mix' in argv; argv = [a for a in argv if not a.startswith('--')]
    st, method = argv[0], argv[1]
    base = os.path.join(ROOT, st); tag = method + ('mix' if mix else '')
    songs = argv[2:] or sorted(x for x in os.listdir(base) if os.path.exists(os.path.join(base, x, 'truth.json' if mix else 'baseline.json')))
    sep = None
    for s in songs:
        d = os.path.join(base, s); od = os.path.join(d, 'stems-' + tag)
        if mix: B = {'parts': []}; src = json.load(open(os.path.join(d, 'truth.json')))['mix']
        else: B = json.load(open(os.path.join(d, 'baseline.json'))); src = next(p for p in B['parts'] if p['name'] == 'vocals')['audio']
        outs = sorted(f.replace(os.sep, '/') for f in glob.glob(os.path.join(od, '*.wav')))
        if not outs:
            if sep is None:
                sep = Separator(output_dir=od, output_format='WAV', model_file_dir=os.path.join(os.path.expanduser('~'), '.cache', 'pitchscape', 'sep-models'))
                sep.load_model(model_filename=MODELS[method])
            sep.output_dir = od; os.makedirs(od, exist_ok=True)
            if getattr(sep, 'model_instance', None) is not None: sep.model_instance.output_dir = od
            sep.separate(os.path.join(d, src))
            outs = sorted(f.replace(os.sep, '/') for f in glob.glob(os.path.join(od, '*.wav')))
        nj = os.path.join(od, 'notes-line.json' if line else 'notes.json')
        subprocess.run(['node', os.path.join(REPO, 'tools', 'instruments', 'notes.mjs'), *(['--line'] if line else []), nj, *outs], check=True, cwd=REPO, stderr=subprocess.DEVNULL)
        N = json.load(open(nj))
        parts = [p for p in B['parts'] if p['name'] != 'vocals']
        for f in outs:
            name = os.path.basename(f).rsplit('(', 1)[-1].split(')')[0] if '(' in f else os.path.basename(f)
            parts.insert(0, {'name': 'vocals:' + name, 'audio': os.path.relpath(f, d).replace('\\', '/'), 'notes': N[f]})
        json.dump({'parts': parts}, open(os.path.join(d, tag + ('-line' if line else '') + '.json'), 'w'))
        print(s, [(p['name'], len(p['notes'])) for p in parts], flush=True)


if __name__ == '__main__':
    main()
