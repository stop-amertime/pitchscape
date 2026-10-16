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
}


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
