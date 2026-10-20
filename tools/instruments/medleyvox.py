# Two singers apart, as a method for score.py: MedleyVox's iSRNet (Jeon et al., ICASSP 2023, arXiv 2211.07302: a
# Conv-TasNet on the STFT with iterative refinement, trained on mixtures of 2-4 singers made from solo singing and
# LibriSpeech), as Carson Evans retrained it (the authors kept their weights): huggingface.co/Cyru5/MedleyVox,
# singing_librispeech_ft_iSRNet, CC BY 4.0, run with his fork's code (github.com/CBeast25/MedleyVox) as its
# svs.inference runs it: 24 kHz mono, loudness to -24 LUFS, asteroid's LambdaOverlapAdd over the model's own window
# (singers kept in order across windows by the overlap), back to the input's loudness. Two outputs from the baseline's
# vocal stem; --deep splits each output again (four, for a quartet). Each output is a part with notes as notes.mjs
# reads it (--line: CREPE, one voice). The baseline's other stems stay. Writes <song>/medley[4][-line].json.
# --mix: separate the song's mix itself instead (a set of voices alone, as duets), with no other parts:
# <song>/medleymix[4][-line].json.
#   cd ~/.cache/pitchscape && git clone https://github.com/CBeast25/MedleyVox medleyvox
#   (from huggingface.co/Cyru5/MedleyVox: singing_librispeech_ft_iSRNet/vocals.json and vocals.pth into
#    ~/.cache/pitchscape/medleyvox-models/checkpoint/singing_librispeech_ft_iSRNet/)
#   pip install --no-deps asteroid asteroid-filterbanks pytorch-lightning torchmetrics==0.11.4 lightning-utilities \
#       pyloudnorm cached-property torch-optimizer pytorch-ranger           (asteroid's pesq does not build on Windows)
#   <venv python> tools/instruments/medleyvox.py [--deep] [--line] [--mix] SET [song...]   (after baseline.py, unless --mix)
import json, os, subprocess, sys, types
import numpy as np, soundfile as sf, librosa, torch

HERE = os.path.dirname(os.path.abspath(__file__)); REPO = os.path.join(HERE, '..', '..')
ROOT = os.path.join(REPO, 'testsongs', 'multitrack')
CACHE = os.path.join(os.path.expanduser('~'), '.cache', 'pitchscape')
EXP = os.path.join(CACHE, 'medleyvox-models', 'checkpoint', 'singing_librispeech_ft_iSRNet')
sys.path.insert(0, os.path.join(CACHE, 'medleyvox'))
# svs.functions imports its wav2vec variants, which need fairseq; only the plain overlap-add is used here
sys.modules['fairseq'] = types.ModuleType('fairseq')


def load():
    from svs.models import load_model_with_args
    args = types.SimpleNamespace(**json.load(open(os.path.join(EXP, 'vocals.json')))['args'])
    model = load_model_with_args(args)
    ck = torch.load(os.path.join(EXP, 'vocals.pth'), map_location='cuda')
    md = model.state_dict()                                                       # its EMA weights, as inference.py
    md.update({k.replace('ema_model.module.', ''): v for k, v in ck.items() if k.replace('ema_model.module.', '') in md})
    model.load_state_dict(md); model.eval().cuda()
    from asteroid.dsp.overlap_add import LambdaOverlapAdd
    ola = LambdaOverlapAdd(nnet=model, n_src=2, window_size=int(args.seq_dur * args.sample_rate),
                           hop_size=int(args.seq_dur * args.sample_rate // 4), window=None, reorder_chunks=True,
                           enable_grad=False).cuda()
    return ola, args.sample_rate


def separate(ola, sr, y):
    import pyloudnorm as pyln
    meter = pyln.Meter(sr)
    loud = meter.integrated_loudness(y)
    if not np.isfinite(loud): return [np.zeros_like(y), np.zeros_like(y)]
    g = 10 ** ((-24 - loud) / 20)
    with torch.inference_mode():
        out = ola.forward(torch.as_tensor(y * g, dtype=torch.float32).cuda()[None, None])
    return [out[0, k].cpu().numpy() / g for k in range(2)]


def main():
    argv = sys.argv[1:]; deep = '--deep' in argv; line = '--line' in argv; mix = '--mix' in argv
    argv = [a for a in argv if not a.startswith('--')]
    base = os.path.join(ROOT, argv[0]); tag = ('medleymix' if mix else 'medley') + ('4' if deep else '')
    songs = argv[1:] or sorted(x for x in os.listdir(base) if os.path.exists(os.path.join(base, x, 'truth.json' if mix else 'baseline.json')))
    ola = None
    for s in songs:
        d = os.path.join(base, s); od = os.path.join(d, 'stems-' + tag); os.makedirs(od, exist_ok=True)
        if mix: B = {'parts': []}; src = json.load(open(os.path.join(d, 'truth.json')))['mix']
        else: B = json.load(open(os.path.join(d, 'baseline.json'))); src = next(p for p in B['parts'] if p['name'] == 'vocals')['audio']
        names = ['a', 'b'] if not deep else ['aa', 'ab', 'ba', 'bb']
        outs = [os.path.join(od, n + '.wav').replace(os.sep, '/') for n in names]
        if not all(os.path.exists(f) for f in outs):
            if ola is None: ola, sr = load()
            y, _ = librosa.load(os.path.join(d, src), sr=sr, mono=True)
            ys = separate(ola, sr, y)
            if deep: ys = [z for x in ys for z in separate(ola, sr, x)]
            for f, z in zip(outs, ys): sf.write(f, z, sr, subtype='FLOAT')
        nj = os.path.join(od, 'notes-line.json' if line else 'notes.json')
        subprocess.run(['node', os.path.join(REPO, 'tools', 'instruments', 'notes.mjs'), *(['--line'] if line else []), nj, *outs],
                       check=True, cwd=REPO, stderr=subprocess.DEVNULL)
        N = json.load(open(nj))
        parts = [{'name': 'vocals:' + n, 'audio': os.path.relpath(f, d).replace(os.sep, '/'), 'notes': N[f]} for n, f in zip(names, outs)]
        parts += [p for p in B['parts'] if p['name'] != 'vocals']
        json.dump({'parts': parts}, open(os.path.join(d, tag + ('-line' if line else '') + '.json'), 'w'))
        print(s, [(p['name'], len(p['notes'])) for p in parts], flush=True)


if __name__ == '__main__':
    main()
