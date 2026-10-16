"""Convert the pipeline's trained models to ONNX for the JavaScript pipeline (src/pipeline), into models/ (git-ignored).

  python tools/export_models.py

Needs the Python pipeline's environment (server/requirements.txt) plus `onnx`. Each model is checked against PyTorch
on random input after export. models/manifest.json records each file's size and SHA-256.

htdemucs_6s: the network only, from just after HTDemucs._magnitude to just before _mask (its own normalisation
included). The STFT and iSTFT around it are done in JavaScript (src/pipeline/stems.mjs), as the browser's ONNX
Runtime cannot run torch's STFT ops on WebGPU. Inputs mix [1,2,343980] and mag [1,4,2048,336] (complex as channels);
outputs x [1,6,4,2048,336] (each source's spectrogram) and xt [1,6,2,343980] (the time branch).
"""
import hashlib, json, os, sys

import numpy as np
import torch
from torch import nn

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
OUT = os.path.join(ROOT, 'models')


class DemucsCore(nn.Module):
    """HTDemucs.forward (demucs 4.1.0) between _magnitude and _mask: (mix, mag) -> (x, xt), denormalised."""

    def __init__(self, m):
        super().__init__()
        self.m = m

    def forward(self, mix, mag):
        m = self.m
        x = mag
        B, C, Fq, T = x.shape
        mean = x.mean(dim=(1, 2, 3), keepdim=True)
        std = x.std(dim=(1, 2, 3), keepdim=True)
        x = (x - mean) / (1e-5 + std)
        xt = mix
        meant = xt.mean(dim=(1, 2), keepdim=True)
        stdt = xt.std(dim=(1, 2), keepdim=True)
        xt = (xt - meant) / (1e-5 + stdt)
        saved, saved_t, lengths, lengths_t = [], [], [], []
        for idx, encode in enumerate(m.encoder):
            lengths.append(x.shape[-1])
            inject = None
            if idx < len(m.tencoder):
                lengths_t.append(xt.shape[-1])
                tenc = m.tencoder[idx]
                xt = tenc(xt)
                if not tenc.empty:
                    saved_t.append(xt)
                else:
                    inject = xt
            x = encode(x, inject)
            if idx == 0 and m.freq_emb is not None:
                frs = torch.arange(x.shape[-2], device=x.device)
                emb = m.freq_emb(frs).t()[None, :, :, None].expand_as(x)
                x = x + m.freq_emb_scale * emb
            saved.append(x)
        if m.crosstransformer:
            if m.bottom_channels:
                b, c, f, t = x.shape
                x = m.channel_upsampler(x.reshape(b, c, f * t)).reshape(b, -1, f, t)
                xt = m.channel_upsampler_t(xt)
            x, xt = m.crosstransformer(x, xt)
            if m.bottom_channels:
                b, c, f, t = x.shape
                x = m.channel_downsampler(x.reshape(b, c, f * t)).reshape(b, -1, f, t)
                xt = m.channel_downsampler_t(xt)
        for idx, decode in enumerate(m.decoder):
            x, pre = decode(x, saved.pop(-1), lengths.pop(-1))
            offset = m.depth - len(m.tdecoder)
            if idx >= offset:
                tdec = m.tdecoder[idx - offset]
                length_t = lengths_t.pop(-1)
                if tdec.empty:
                    xt, _ = tdec(pre[:, :, 0], None, length_t)
                else:
                    xt, _ = tdec(xt, saved_t.pop(-1), length_t)
        S = len(m.sources)
        x = x.view(B, S, -1, Fq, T) * std[:, None] + mean[:, None]
        xt = xt.view(B, S, -1, mix.shape[-1]) * stdt[:, None] + meant[:, None]
        return x, xt


def export_demucs():
    from demucs.pretrained import get_model
    bag = get_model('htdemucs_6s')
    assert len(bag.models) == 1 and all(w == 1.0 for w in bag.weights[0]), 'htdemucs_6s is expected to be one model'
    model = bag.models[0].eval()
    L = int(model.segment * model.samplerate)
    core = DemucsCore(model).eval()
    torch.manual_seed(0)
    mix = torch.randn(1, 2, L) * 0.1
    z = model._spec(mix)
    mag = model._magnitude(z)
    path = os.path.join(OUT, 'htdemucs_6s.onnx')
    torch.onnx.export(core, (mix, mag), path, input_names=['mix', 'mag'], output_names=['x', 'xt'],
                      opset_version=17, dynamo=False, do_constant_folding=True)
    import onnxruntime as ort
    ox, oxt = ort.InferenceSession(path, providers=['CPUExecutionProvider']).run(None, {'mix': mix.numpy(), 'mag': mag.numpy()})
    with torch.no_grad():
        tx, txt = core(mix, mag)
        full = model(mix)
    err = max(np.abs(ox - tx.numpy()).max() / np.abs(tx.numpy()).max(), np.abs(oxt - txt.numpy()).max() / np.abs(txt.numpy()).max())
    recon = (model._ispec(model._mask(z, tx), L) + txt - full).abs().max().item()
    print('htdemucs_6s: ONNX vs PyTorch, largest error relative to the largest value %.1e; core + torch STFT vs the '
          'whole model %.1e' % (err, recon))
    assert err < 1e-3 and recon < 1e-5
    return path, {'sources': list(model.sources), 'segment': L, 'samplerate': model.samplerate,
                  'nfft': model.nfft, 'hop': model.hop_length}


def sha256(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for b in iter(lambda: f.read(1 << 20), b''):
            h.update(b)
    return h.hexdigest()


if __name__ == '__main__':
    os.makedirs(OUT, exist_ok=True)
    want = sys.argv[1:] or ['htdemucs_6s']
    mpath = os.path.join(OUT, 'manifest.json')
    manifest = json.load(open(mpath)) if os.path.exists(mpath) else {}
    for name in want:
        path, info = {'htdemucs_6s': export_demucs}[name]()
        manifest[name] = dict(info, file=os.path.basename(path), bytes=os.path.getsize(path), sha256=sha256(path))
    json.dump(manifest, open(mpath, 'w'), indent=1)
    print(json.dumps(manifest, indent=1))
