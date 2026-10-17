"""CTC acoustic models for the words stage's forced alignment (src/pipeline/align.mjs), from torchaudio's pipelines.
Called by tools/export_models.py (`python tools/export_models.py align_en`).

align_<name> / align_<name>_f32: the model as one graph, audio [1, samples] (float32, 16 kHz mono) in, log_probs
[1, frames, labels] (float32: log_softmax of the emission, what torchaudio.functional.forced_align takes) out, one
frame per 320 samples (20 ms). Weights in float16 for the browser (WebGPU), float32 for ONNX Runtime's CPU provider;
the input and output are float32 either way. The manifest entry has the labels (index 0 is CTC's blank) and whether
the bundle normalises the waveform (MMS_FA does: layer norm over the input, done in the graph, as the bundle's
model does it).

  en:  torchaudio.pipelines.WAV2VEC2_ASR_BASE_960H, wav2vec 2.0 base fine-tuned on LibriSpeech 960 h (fairseq, MIT):
       upper-case English letters and the apostrophe, '|' between words.
  mms: torchaudio.pipelines.MMS_FA, the MMS forced aligner (Pratap et al. 2023, CC BY-NC 4.0): romanised lower-case
       letters, for 1100+ languages after uroman; '*' (star) is not exported (with_star=False).
"""
import os

import numpy as np
import torch

BUNDLES = {'en': 'WAV2VEC2_ASR_BASE_960H', 'mms': 'MMS_FA'}
SOURCES = {'en': ('torchaudio 2.7.1 pipelines.WAV2VEC2_ASR_BASE_960H (wav2vec 2.0 base, LibriSpeech 960 h, fairseq)',
                  'MIT'),
           'mms': ('torchaudio 2.7.1 pipelines.MMS_FA (MMS forced aligner, Pratap et al. 2023)', 'CC-BY-NC-4.0')}


class Emission(torch.nn.Module):
    def __init__(self, model, normalize, dtype):
        super().__init__()
        self.model, self.normalize, self.dtype = model, normalize, dtype

    def forward(self, audio):
        if self.normalize:      # layer_norm(audio, audio.shape), written out (its shape argument does not export)
            mean = audio.mean(dim=-1, keepdim=True)
            audio = (audio - mean) / torch.sqrt(((audio - mean) ** 2).mean(dim=-1, keepdim=True) + 1e-5)
        emission, _ = self.model(audio.to(self.dtype))
        return torch.log_softmax(emission.float(), dim=-1)


def export(name, out):
    import torchaudio
    import onnxruntime as ort
    bundle = getattr(torchaudio.pipelines, BUNDLES[name])
    kw = {'with_star': False} if name == 'mms' else {}
    model = bundle.get_model(**kw).eval()
    # MMS_FA's bundle wraps the model (layer_norm and log_softmax); the inner Wav2Vec2Model is exported, with both
    # written out in Emission
    model = getattr(model, 'model', model) if hasattr(model, 'normalize_waveform') else model
    labels = list(bundle.get_labels(star=None) if name == 'mms' else bundle.get_labels())
    normalize = bool(getattr(bundle, '_normalize_waveform', False))
    torch.manual_seed(0)
    x = (torch.randn(1, 16000 * 6) * 0.1).float()
    with torch.no_grad():      # the reference: the bundle's own model (its layer_norm, log_softmax), no star
        ref = bundle.get_model(**kw).eval() if name == 'mms' else None
        want = (ref(x)[0] if ref is not None else Emission(model, normalize, torch.float32)(x)).numpy()
    res = {}
    for suffix, dt in (('_f32', torch.float32), ('', torch.float16)):
        m = Emission(model.to(dt), normalize, dt).eval()
        path = os.path.join(out, f'align_{name}{suffix}.onnx')
        torch.onnx.export(m, (x,), path, input_names=['audio'], output_names=['log_probs'],
                          dynamic_axes={'audio': {1: 'samples'}, 'log_probs': {1: 'frames'}}, opset_version=17,
                          dynamo=False, do_constant_folding=True)
        if dt == torch.float32:
            got = ort.InferenceSession(path, providers=['CPUExecutionProvider']).run(None, {'audio': x.numpy()})[0]
            err = float(np.abs(got - want).max())
            agree = float((got.argmax(-1) == want.argmax(-1)).mean())
            print(f'align_{name}: ONNX vs PyTorch on 6 s of noise, largest log-prob difference {err:.1e}, '
                  f'argmax agrees on {agree:.1%} of {want.shape[1]} frames')
            assert err < 1e-3
        res[f'align_{name}{suffix}'] = (path, {'source': SOURCES[name][0], 'licence': SOURCES[name][1],
                                              'samplerate': 16000, 'stride': 320, 'labels': labels,
                                              'blank': 0, 'normalize': normalize})
    return res
