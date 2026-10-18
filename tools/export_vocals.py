"""The stems stage's vocal model (src/pipeline/vocals.mjs): Kimberley Jensen's Mel-Band RoFormer vocals (MIT;
architecture: J.-C. Wang, W.-T. Lu, M. Won, "Mel-RoFormer for Vocal Separation and Vocal Melody Transcription", 2023),
the checkpoint at https://huggingface.co/KimberleyJSN/melbandroformer with the model code of
https://github.com/KimberleyJensen/Mel-Band-Roformer-Vocal-Model (commit 25f44ff), cloned into CACHE below.
Called by tools/export_models.py (`python tools/export_models.py vocals_mbr`).

Why it is there: Demucs alone left the voice audible in the guitar and other stems (heard on Code Monkey, Fluoride and
Denial); taking the vocals out with this model first and running Demucs on the rest left them clean.

vocals_mbr / vocals_mbr_f32: the network only, between its band gather and its mask scatter. Input x [1, 801,
2 * J] (an 8 s chunk at 44.1 kHz: torch.stft n_fft 2048, hop 441, hann 2048, centred, both channels; the bins listed in
`freq_indices` (stereo-interleaved: 2 * bin + channel) in that order, real and imaginary interleaved); output masks
[1, 801, 2 * J] (a complex mask per gathered bin). The STFT, the gather, the averaging of masks over the bands that
share a bin, the mask multiply and the iSTFT are done in JavaScript, as for Demucs: the browser's ONNX Runtime cannot
run torch's STFT on WebGPU. Float16 weights for the browser, float32 for ONNX Runtime's CPU provider; input and
output float32 either way.
"""
import os, subprocess, sys

import numpy as np
import torch

REPO = 'https://github.com/KimberleyJensen/Mel-Band-Roformer-Vocal-Model'
COMMIT = '25f44ffb55ee3c301281bba21b2d6d311cb69ae2'
CKPT = ('KimberleyJSN/melbandroformer', 'MelBandRoformer.ckpt')
CACHE = os.path.join(os.path.expanduser('~'), '.cache', 'pitchscape', 'Mel-Band-Roformer-Vocal-Model')
SOURCE = ("Mel-Band RoFormer vocal separation (architecture: J.-C. Wang, W.-T. Lu, M. Won, \"Mel-RoFormer for Vocal "
          "Separation and Vocal Melody Transcription\", 2023), trained by Kimberley Jensen: the checkpoint at "
          "https://huggingface.co/KimberleyJSN/melbandroformer with the model code of " + REPO + " (commit 25f44ff). "
          "Exported to ONNX without its STFT, band gather, mask scatter and iSTFT by tools/export_vocals.py.")


def model():
    if not os.path.exists(CACHE):
        subprocess.run(['git', 'clone', '-q', REPO, CACHE], check=True)
    subprocess.run(['git', '-C', CACHE, 'checkout', '-q', COMMIT], check=True)
    sys.path.insert(0, CACHE)
    import yaml
    from ml_collections import ConfigDict
    from huggingface_hub import hf_hub_download
    from models.mel_band_roformer import MelBandRoformer
    cfg = ConfigDict(yaml.load(open(os.path.join(CACHE, 'configs', 'config_vocals_mel_band_roformer.yaml')),
                               Loader=yaml.FullLoader))
    m = MelBandRoformer(**dict(cfg.model))
    m.load_state_dict(torch.load(hf_hub_download(*CKPT), map_location='cpu'))
    return m.eval(), cfg


GROUP = 10                    # sequences per time-attention call in the graph (the batch dimension must be 1)


class Core(torch.nn.Module):
    """MelBandRoformer.forward between its gather (x = stft_repr[:, freq_indices]) and its mask scatter."""

    def __init__(self, m, dtype):
        super().__init__()
        self.m, self.dtype = m, dtype
        if dtype == torch.float16:
            # RMSNorm (F.normalize) sums 384 squares, which overflows float16 on WebGPU (the output came out at 15% of
            # its level on Node's WebGPU provider, though right on the CPU): normalised in float32
            import torch.nn.functional as F
            for mod in m.modules():
                if type(mod).__name__ == 'RMSNorm' and not getattr(mod, '_f32', False):
                    mod.forward = lambda x, mod=mod: (F.normalize(x.float(), dim=-1) * mod.scale * mod.gamma.float()).to(x.dtype)
                    mod._f32 = True
            # the rotary position embedding counts positions in its own dtype (a Range ONNX has no float16 for): in
            # float32, as the reference runs it, then back to float16 for the attention
            for layer in m.layers:
                for tr in layer:
                    for attn, _ in tr.layers:
                        re = attn.rotary_embed
                        if getattr(re, '_f32', False): continue
                        re.float(); orig = re.rotate_queries_or_keys
                        re.rotate_queries_or_keys = lambda t, orig=orig: orig(t.float()).to(t.dtype)
                        re._f32 = True

    def forward(self, x):
        m = self.m
        b, t, _ = x.shape
        # BandSplit and MaskEstimator written out band by band: their 60-way split, stack, unbind and cat export as
        # single ops with 60 inputs or outputs, more than a WebGPU shader may bind (16); joined in groups of 8 instead
        x = x.to(self.dtype)
        dims, a, feats = m.band_split.dim_inputs, 0, []
        for d, net in zip(dims, m.band_split.to_features):
            feats.append(net(x[..., a:a + d]))
            a += d
        x = join([f.unsqueeze(-2) for f in feats], -2)
        for time_transformer, freq_transformer in m.layers:
            f, d = x.shape[2], x.shape[3]
            x = x.permute(0, 2, 1, 3).reshape(b * f, t, d)
            # attention along time for 10 bands at a time: all 60 at once needs one 2.5 GB buffer (WebGPU allows 2 GB)
            x = torch.cat([time_transformer(x[i:i + GROUP]) for i in range(0, b * f, GROUP)], 0)
            x = x.reshape(b, f, t, d).permute(0, 2, 1, 3).reshape(b * t, f, d)
            x = freq_transformer(x)
            x = x.reshape(b, t, f, d)
        est = m.mask_estimators[0]
        return join([mlp(x[:, :, i]) for i, mlp in enumerate(est.to_freqs)], -1).float()


def join(xs, dim, g=8):
    """torch.cat in groups of at most g inputs."""
    while len(xs) > 1:
        xs = [torch.cat(xs[i:i + g], dim) if len(xs[i:i + g]) > 1 else xs[i] for i in range(0, len(xs), g)]
    return xs[0]


def spec(m, audio):
    """What MelBandRoformer.forward does before the network: the STFT, gathered and flattened, [b, t, 2 * J]."""
    b = audio.shape[0]
    st = torch.stft(audio.reshape(b * 2, -1), **m.stft_kwargs, window=m.stft_window_fn(device=audio.device),
                    return_complex=True)
    st = torch.view_as_real(st).reshape(b, 2, st.shape[-2], st.shape[-1], 2)
    st = st.permute(0, 2, 1, 3, 4).reshape(b, -1, st.shape[-2], 2)          # b (f s) t c
    return st, st[:, m.freq_indices].permute(0, 2, 1, 3).reshape(b, st.shape[2], -1)


def apply(m, st, masks):
    """What it does after: the masks averaged over the bands sharing each bin, applied, and the iSTFT."""
    b, t = masks.shape[0], masks.shape[1]
    mk = torch.view_as_complex(masks.reshape(b, t, -1, 2).permute(0, 2, 1, 3).contiguous())   # b J t
    sm = torch.zeros(b, st.shape[1], t, dtype=mk.dtype).index_add_(1, m.freq_indices, mk)
    sm = sm / m.num_bands_per_freq.repeat_interleave(2)[None, :, None].clamp(min=1e-8)
    y = torch.view_as_complex(st.contiguous()) * sm
    y = y.reshape(b, -1, 2, t).permute(0, 2, 1, 3).reshape(b * 2, -1, t)
    return torch.istft(y, **m.stft_kwargs, window=m.stft_window_fn(device=y.device)).reshape(b, 2, -1)


def export(out, fp16):
    m, cfg = model()
    C = cfg.inference.chunk_size
    name = 'vocals_mbr' if fp16 else 'vocals_mbr_f32'
    path = os.path.join(out, name + '.onnx')
    torch.manual_seed(0)
    audio = torch.randn(2, 2, C) * 0.1
    st, x = spec(m, audio)
    core = Core(m.half() if fp16 else m, torch.float16 if fp16 else torch.float32).eval()
    with torch.no_grad():
        torch.onnx.export(core, (x[:1],), path, input_names=['x'], output_names=['masks'],
                          opset_version=17, dynamo=False,
                          do_constant_folding=True)
    m.float()
    import onnxruntime as ort
    sess = ort.InferenceSession(path, providers=['CPUExecutionProvider'])
    got = torch.cat([torch.tensor(sess.run(None, {'x': x[i:i + 1].numpy()})[0]) for i in range(x.shape[0])])
    with torch.no_grad():
        want = m(audio)                                             # the whole model, float32
        ours = apply(m, st, got)
        ref = apply(m, st, Core(m, torch.float32)(x))
    err = float((ours - want).abs().max() / want.abs().max())
    split = float((ref - want).abs().max() / want.abs().max())
    print('%s: ONNX + our STFT/scatter/iSTFT vs the whole float32 model on random audio, largest error relative to '
          'the largest value %.1e (float32 network with our cut alone: %.1e)' % (name, err, split))
    assert split < 1e-5 and err < (5e-2 if fp16 else 1e-4)
    return path, {'samplerate': 44100, 'chunk': C, 'overlap': cfg.inference.num_overlap, 'nfft': 2048, 'hop': 441,
                  'frames': x.shape[1], 'freq_indices': m.freq_indices.tolist(),
                  'source': REPO + ' @ ' + COMMIT[:7], 'licence': 'MIT'}
