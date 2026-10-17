"""Publish models/ (tools/export_models.py) to a Hugging Face model repository, where the page and the server fetch
them (https://huggingface.co/<repo>/resolve/main/<file>).

  hf auth login                                # once, with a write token, in your own terminal
  python tools/publish_models.py OWNER/pitchscape-models [--private]

Uploads manifest.json, every file it lists, and a README (the model card) saying where each model comes from and
under what licence. A model with no entry in SOURCES below is refused: say what it is before it is published.
"""
import json, os, sys

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
MODELS = os.path.join(ROOT, 'models')

# what each published file is, who made it, and its licence (shown in the model card)
SOURCES = {
    'htdemucs_6s': ('Demucs htdemucs_6s (Hybrid Transformer Demucs, 6 sources), Meta AI, from '
                    'https://github.com/facebookresearch/demucs (demucs 4.1.0). Exported to ONNX without its STFT and '
                    'iSTFT by tools/export_models.py.', 'MIT'),
    'adtof_frame_rnn': ('ADTOF Frame_RNN drum transcription (M. Zehren, M. Alunno, P. Bientinesi, "High-Quality and '
                        'Reproducible Automatic Drum Transcription from Crowdsourced Data", Signals 2023), checkpoint '
                        'Frame_RNN_adtofAll_0 from https://github.com/MZehren/ADTOF, as converted to ONNX (with '
                        "madmom's spectrogram in the graph) at https://huggingface.co/thebluescreen/adtof-drums-onnx; "
                        'copied unchanged. Non-commercial use only.', 'CC BY-NC-SA 4.0'),
    'crepe_full': ('CREPE pitch tracker, model "full" (J. W. Kim, J. Salamon, P. Li, J. P. Bello, "CREPE: A '
                   'Convolutional Representation for Pitch Estimation", ICASSP 2018), with the weights torchcrepe '
                   '0.0.24 ships (https://github.com/maxrmorrison/torchcrepe). Exported to ONNX (frames in, the '
                   "network's 360 pitch-bin probabilities out) by tools/export_models.py.", 'MIT'),
    'basic_pitch': ('Basic Pitch ICASSP 2022 polyphonic note transcription (R. Bittner, J. J. Bosch, D. Rubinstein, '
                    'G. Meseguer-Brocal, S. Ewert, "A Lightweight Instrument-Agnostic Model for Polyphonic Note '
                    'Transcription and Multipitch Estimation", ICASSP 2022), Spotify, from '
                    'https://github.com/spotify/basic-pitch: the ONNX file the basic-pitch 0.4.0 package ships, copied '
                    'unchanged.', 'Apache-2.0'),
    'silero_vad': ('Silero VAD v6 voice activity detector (Silero Team, https://github.com/snakers4/silero-vad): the '
                   'ONNX file faster-whisper 1.2.1 ships and runs for vad_filter, copied unchanged.', 'MIT'),
}
for _size in ('base', 'small', 'medium'):
    _whisper = ('OpenAI Whisper %s (A. Radford, J. W. Kim, T. Xu, G. Brockman, C. McLeavey, I. Sutskever, "Robust '
                'Speech Recognition via Large-Scale Weak Supervision", 2022), the weights of '
                'https://huggingface.co/openai/whisper-%s, ' % (_size, _size))
    SOURCES.update({
        'whisper_%s_encoder' % _size: (_whisper + 'its encoder (and each decoder layer\'s cross-attention keys and '
                                       'values) exported to ONNX in float16 by tools/export_whisper.py.', 'MIT'),
        'whisper_%s_decoder' % _size: (_whisper + 'its decoder exported to ONNX in float16 by tools/export_whisper.py.',
                                       'MIT'),
        'whisper_%s_encoder_f32' % _size: (_whisper + 'its encoder exported to ONNX in float32 (for ONNX Runtime\'s CPU '
                                           'provider) by tools/export_whisper.py.', 'MIT'),
        'whisper_%s_decoder_f32' % _size: (_whisper + 'its decoder exported to ONNX in float32 by '
                                           'tools/export_whisper.py.', 'MIT'),
        'whisper_%s' % _size: (_whisper + 'its tokenizer and the tokens faster-whisper suppresses, as JSON (from '
                               'https://huggingface.co/Systran/faster-whisper-%s).' % _size, 'MIT'),
    })

for _name, _what, _lic in (
        ('en', 'wav2vec 2.0 base fine-tuned for English on LibriSpeech 960 h (A. Baevski, H. Zhou, A. Mohamed, M. Auli, '
               '"wav2vec 2.0", 2020; fairseq), as torchaudio 2.7.1 ships it (pipelines.WAV2VEC2_ASR_BASE_960H)', 'MIT'),
        ('mms', 'the MMS forced aligner (V. Pratap et al., "Scaling Speech Technology to 1,000+ Languages", 2023), as '
                'torchaudio 2.7.1 ships it (pipelines.MMS_FA)', 'CC BY-NC 4.0')):
    SOURCES.update({
        'align_%s' % _name: (_what + ', exported to ONNX in float16 with log_softmax by tools/export_align.py.', _lic),
        'align_%s_f32' % _name: (_what + ', exported to ONNX in float32 (for ONNX Runtime\'s CPU provider) with '
                                 'log_softmax by tools/export_align.py.', _lic),
    })


def card(repo, manifest):
    rows = '\n'.join('| `%s` | %s | %s | %.1f MB |' % (v['file'], SOURCES[k][0], SOURCES[k][1], v['bytes'] / 1e6)
                     for k, v in manifest.items())
    return f"""---
tags: [onnx, music, source-separation, pitchscape]
---
# Pitchscape's models

The trained models [Pitchscape](https://github.com/stop-amertime/pitchscape) runs, in the browser (ONNX Runtime Web
on WebGPU) and on its server, converted to ONNX. Each keeps its own authors' licence:

| file | what it is | licence | size |
| --- | --- | --- | --- |
{rows}

`manifest.json` lists each file with its size and SHA-256. Made by `tools/export_models.py` in that repository.
"""


if __name__ == '__main__':
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    if len(args) != 1 or '/' not in args[0]:
        sys.exit('usage: python tools/publish_models.py OWNER/REPO [--private]')
    repo = args[0]
    manifest = json.load(open(os.path.join(MODELS, 'manifest.json')))
    unknown = [k for k in manifest if k not in SOURCES]
    if unknown:
        sys.exit('no source and licence in tools/publish_models.py SOURCES for: ' + ', '.join(unknown))
    from huggingface_hub import HfApi
    api = HfApi()
    print('as', api.whoami()['name'])
    api.create_repo(repo, repo_type='model', private='--private' in sys.argv, exist_ok=True)
    for k, v in manifest.items():
        print('uploading', v['file'], '%.1f MB' % (v['bytes'] / 1e6), flush=True)
        api.upload_file(path_or_fileobj=os.path.join(MODELS, v['file']), path_in_repo=v['file'], repo_id=repo)
    api.upload_file(path_or_fileobj=os.path.join(MODELS, 'manifest.json'), path_in_repo='manifest.json', repo_id=repo)
    api.upload_file(path_or_fileobj=card(repo, manifest).encode(), path_in_repo='README.md', repo_id=repo)
    print('https://huggingface.co/%s' % repo)
