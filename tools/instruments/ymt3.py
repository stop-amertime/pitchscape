# YourMT3+ (Chang et al. 2024, arXiv 2407.04822; code GPL-3.0, github.com/mimbres/YourMT3) as a method for score.py:
# its best model, YPTF.MoE+Multi (noPS), on each song's mix; every instrument it writes (a MIDI program, or singing
# voice) is one part, with its notes and no audio. Runs from the model's Hugging Face Space checkout in its own venv,
# outside this repository (nothing of its code is copied here):
#   cd ~/.cache/pitchscape && GIT_LFS_SKIP_SMUDGE=1 git clone https://huggingface.co/spaces/mimbres/YourMT3 ymt3-space
#   (cd ymt3-space && git lfs pull --include "amt/logs/2024/mc13_256_g4_all_v7_mt3f_sqr_rms_moe_wf4_n8k2_silu_rope_rp_b36_nops/checkpoints/last.ckpt")
#   python -m venv ymt3-venv; ymt3-venv/Scripts/pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu128
#   ymt3-venv/Scripts/pip install "lightning>=2.2.1" deprecated librosa einops transformers==4.45.1 numpy==1.26.4 mido mir_eval soundfile pretty_midi
#   ~/.cache/pitchscape/ymt3-venv/Scripts/python tools/instruments/ymt3.py SET [song...]
import json, os, sys
REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
ROOT = os.path.join(REPO, 'testsongs', 'multitrack')
SPACE = os.path.join(os.path.expanduser('~'), '.cache', 'pitchscape', 'ymt3-space')
sys.path.insert(0, os.path.join(SPACE, 'amt', 'src')); sys.path.insert(0, SPACE)
os.chdir(SPACE); sys.stdout.reconfigure(encoding="utf-8")
import torch, torchaudio, pretty_midi, soundfile as sf
from model_helper import load_model_checkpoint, transcribe


def _load(uri):
    # torchaudio 2.9 hands load() to torchcodec (and FFmpeg's DLLs); the songs are wav, which soundfile reads
    y, sr = sf.read(uri, dtype='float32', always_2d=True)
    return torch.from_numpy(y.T.copy()), sr
torchaudio.load = _load

ARGS = ['mc13_256_g4_all_v7_mt3f_sqr_rms_moe_wf4_n8k2_silu_rope_rp_b36_nops@last.ckpt', '-p', '2024', '-tk', 'mc13_full_plus_256',
        '-dec', 'multi-t5', '-nl', '26', '-enc', 'perceiver-tf', '-sqr', '1', '-ff', 'moe', '-wf', '4', '-nmoe', '8', '-kmoe', '2',
        '-act', 'silu', '-epe', 'rope', '-rp', '1', '-ac', 'spec', '-hop', '300', '-atc', '1', '-pr', '16']   # as the Space's app.py runs it


def main():
    base = os.path.join(ROOT, sys.argv[1])
    songs = sys.argv[2:] or sorted(x for x in os.listdir(base) if os.path.exists(os.path.join(base, x, 'truth.json')))
    model = load_model_checkpoint(args=ARGS, device='cuda')
    for s in songs:
        d = os.path.join(base, s); T = json.load(open(os.path.join(d, 'truth.json')))
        name = f'ymt3-{os.path.basename(base)}-{s}'; midi = os.path.join(SPACE, 'model_output', name + '.mid')
        if not os.path.exists(midi): midi = transcribe(model, {'filepath': os.path.join(d, T['mix']), 'track_name': name})
        pm = pretty_midi.PrettyMIDI(midi)
        parts = []
        for ins in pm.instruments:
            name = ins.name or ('drums' if ins.is_drum else pretty_midi.program_to_instrument_name(ins.program))
            parts.append({'name': f"{ins.program}{' drums' if ins.is_drum else ''} {name}", 'program': int(ins.program), 'drum': bool(ins.is_drum),
                          'notes': [] if ins.is_drum else [[round(float(n.start), 3), round(float(n.end), 3), int(n.pitch)] for n in ins.notes]})
        json.dump({'parts': parts}, open(os.path.join(d, 'ymt3.json'), 'w'))
        print(s, [(p['name'], len(p['notes'])) for p in parts], flush=True)


if __name__ == '__main__':
    with torch.inference_mode():
        main()
