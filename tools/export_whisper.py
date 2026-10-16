"""Whisper and Silero VAD for the JavaScript pipeline's words stage (src/pipeline/whisper.mjs), as faster-whisper runs
them in server/pipeline.py. Called by tools/export_models.py (`python tools/export_models.py whisper_medium`).

whisper_<size>_encoder / whisper_<size>_decoder: OpenAI's Whisper (MIT), the weights of openai/whisper-<size> on
Hugging Face (the ones faster-whisper's Systran/faster-whisper-<size> were converted from), in two graphs. The encoder
takes a log-mel window mel [1, n_mels, 3000] and gives each decoder layer i's cross-attention keys and values, once per
window: k<i> [heads, head width, 1500] (transposed for the product with the queries) and v<i> [heads, 1500, head width].
The decoder takes new tokens [batch, n] (int32; a batch of hypotheses, as CTranslate2 decodes a beam or samples best_of
at once), order [batch] (int32: which row of the cache each row continues, so a beam search reorders its beams and one
prompt's cache serves a whole batch), each layer's self-attention cache pk<i>, pv<i> [rows, heads, past, head width]
(past may be 0) and the k<i>, v<i>, and gives
the new tokens' logits [batch, n, vocab], the grown cache nk<i>, nv<i> [batch, heads, past + n, head width], and the
alignment heads' cross-attention before softmax, qk [batch, alignment heads, n, 1500], which word timing reads
(CTranslate2's align). One input per layer, not one stacked tensor: slicing a stacked input copies it, and on the CPU
copying the encoder's k and v at every step took more time than the step's arithmetic. Weights in float16 (as faster-whisper runs on a GPU); `_f32` copies in float32 for
ONNX Runtime's CPU provider, which has no float16 matrix products. Inputs and outputs are float32 either way.

whisper_<size> (JSON): each text token's bytes, the special tokens, the tokens faster-whisper suppresses, the alignment
heads and the language tokens, read from faster-whisper's own model files and tokenizer.

silero_vad: Silero VAD v6 (MIT), the ONNX file faster-whisper 1.2.1 ships and runs for vad_filter, copied unchanged.
"""
import json, os

import numpy as np
import torch
from torch import nn


class WAttn(nn.Module):
    """Whisper's attention projections, under Hugging Face's names: q, k (no bias), v, out."""
    def __init__(self, d):
        super().__init__()
        self.q_proj, self.k_proj = nn.Linear(d, d), nn.Linear(d, d, bias=False)
        self.v_proj, self.out_proj = nn.Linear(d, d), nn.Linear(d, d)


class WLayer(nn.Module):
    def __init__(self, d, ff, cross):
        super().__init__()
        self.self_attn, self.self_attn_layer_norm = WAttn(d), nn.LayerNorm(d)
        if cross:
            self.encoder_attn, self.encoder_attn_layer_norm = WAttn(d), nn.LayerNorm(d)
        self.fc1, self.fc2, self.final_layer_norm = nn.Linear(d, ff), nn.Linear(ff, d), nn.LayerNorm(d)


def heads_of(x, heads):
    """[..., n, d] -> [..., heads, n, d / heads]"""
    *b, n, d = x.shape
    return x.reshape(*b, n, heads, d // heads).transpose(-3, -2)


def attend(q, k, v, heads, mask=None):
    """q [n, d] (already scaled), k, v [m, d] -> ([n, d], the scores [heads, n, m] before softmax)."""
    n, d = q.shape
    m, dh = k.shape[0], d // heads
    q = q.reshape(n, heads, dh).transpose(0, 1)
    k = k.reshape(m, heads, dh).transpose(0, 1)
    v = v.reshape(m, heads, dh).transpose(0, 1)
    s = q @ k.transpose(1, 2)
    if mask is not None:
        s = s + mask
    o = torch.softmax(s.float(), -1).to(v.dtype) @ v
    return o.transpose(0, 1).reshape(n, d), s


class Encoder(nn.Module):
    """mel [1, n_mels, 3000] -> every decoder layer's cross-attention k, v [layers, 1500, d]."""
    def __init__(self, cfg, dec_layers):
        super().__init__()
        d, self.heads = cfg['d_model'], cfg['encoder_attention_heads']
        self.conv1 = nn.Conv1d(cfg['num_mel_bins'], d, 3, padding=1)
        self.conv2 = nn.Conv1d(d, d, 3, stride=2, padding=1)
        self.embed_positions = nn.Embedding(cfg['max_source_positions'], d)
        self.layers = nn.ModuleList(WLayer(d, cfg['encoder_ffn_dim'], False) for _ in range(cfg['encoder_layers']))
        self.layer_norm = nn.LayerNorm(d)
        self.dec = dec_layers                 # the decoder's layers, for their encoder_attn k and v projections

    def hidden(self, mel):
        dt = self.conv1.weight.dtype
        x = nn.functional.gelu(self.conv1(mel.to(dt)))
        x = nn.functional.gelu(self.conv2(x))[0].transpose(0, 1)
        x = x + self.embed_positions.weight
        scale = (x.shape[1] // self.heads) ** -0.5
        for L in self.layers:
            h = L.self_attn_layer_norm(x)
            a = L.self_attn
            o, _ = attend(a.q_proj(h) * scale, a.k_proj(h), a.v_proj(h), self.heads)
            x = x + a.out_proj(o)
            x = x + L.fc2(nn.functional.gelu(L.fc1(L.final_layer_norm(x))))
        return self.layer_norm(x)

    def forward(self, mel):
        x = self.hidden(mel)
        ks = [heads_of(L.encoder_attn.k_proj(x), self.heads).transpose(1, 2).float() for L in self.dec]
        vs = [heads_of(L.encoder_attn.v_proj(x), self.heads).float() for L in self.dec]
        return (*ks, *vs)


class Decoder(nn.Module):
    """tokens [b, n], order [b], then per layer pk<i>, pv<i> [rows, heads, past, dh], then per layer k<i> [heads, dh,
    1500], then v<i> [heads, 1500, dh] -> logits [b, n, vocab], nk<i>..., nv<i>... [b, heads, past + n, dh], qk [b, align, n, 1500]."""
    def __init__(self, cfg, align_heads):
        super().__init__()
        d, self.heads = cfg['d_model'], cfg['decoder_attention_heads']
        self.embed_tokens = nn.Embedding(cfg['vocab_size'], d)
        self.embed_positions = nn.Embedding(cfg['max_target_positions'], d)
        self.layers = nn.ModuleList(WLayer(d, cfg['decoder_ffn_dim'], True) for _ in range(cfg['decoder_layers']))
        self.layer_norm = nn.LayerNorm(d)
        self.align = align_heads

    def forward(self, tokens, order, *rest):
        L, dt, H = len(self.layers), self.embed_tokens.weight.dtype, self.heads
        pk, pv, k, v = (rest[i * L:(i + 1) * L] for i in range(4))
        b, n = tokens.shape
        past = pk[0].shape[2]
        pos = torch.arange(n) + past
        x = self.embed_tokens(tokens) + self.embed_positions(pos)
        scale = (x.shape[-1] // H) ** -0.5
        cols = torch.arange(past + n)
        mask = torch.where(cols[None, :] <= pos[:, None], 0.0, float('-inf')).to(dt)   # causal
        merge = lambda o: o.transpose(1, 2).reshape(b, n, -1)
        nk, nv, qks = [], [], []
        for li, Ly in enumerate(self.layers):
            h = Ly.self_attn_layer_norm(x)
            a = Ly.self_attn
            kk = torch.cat([pk[li].index_select(0, order).to(dt), heads_of(a.k_proj(h), H)], 2)
            vv = torch.cat([pv[li].index_select(0, order).to(dt), heads_of(a.v_proj(h), H)], 2)
            nk.append(kk.float())
            nv.append(vv.float())
            s = heads_of(a.q_proj(h) * scale, H) @ kk.transpose(2, 3) + mask
            x = x + a.out_proj(merge(torch.softmax(s.float(), -1).to(dt) @ vv))
            c = Ly.encoder_attn
            s = heads_of(c.q_proj(Ly.encoder_attn_layer_norm(x)) * scale, H) @ k[li].to(dt)
            x = x + c.out_proj(merge(torch.softmax(s.float(), -1).to(dt) @ v[li].to(dt)))
            qks += [s[:, hh] for hl, hh in self.align if hl == li]
            x = x + Ly.fc2(nn.functional.gelu(Ly.fc1(Ly.final_layer_norm(x))))
        x = self.layer_norm(x)
        logits = x @ self.embed_tokens.weight.t()
        return (logits.float(), *nk, *nv, torch.stack(qks, 1).float())


def load(size):
    """openai/whisper-<size> as (encoder, decoder, its config, faster-whisper's model folder, the alignment heads)."""
    from huggingface_hub import hf_hub_download, snapshot_download
    from safetensors.torch import load_file
    repo = 'openai/whisper-' + size
    cfg = json.load(open(hf_hub_download(repo, 'config.json')))
    w = load_file(hf_hub_download(repo, 'model.safetensors'))
    fw = snapshot_download('Systran/faster-whisper-' + size)
    heads = [tuple(h) for h in json.load(open(os.path.join(fw, 'config.json')))['alignment_heads']]
    dec = Decoder(cfg, heads).eval()
    enc = Encoder(cfg, dec.layers).eval()
    part = lambda p: {k[len(p):]: t.float() for k, t in w.items() if k.startswith(p)}
    dec.load_state_dict(part('model.decoder.'))
    res = enc.load_state_dict(part('model.encoder.'), strict=False)
    assert all(k.startswith('dec.') for k in res.missing_keys) and not res.unexpected_keys, res
    return enc, dec, cfg, fw, heads


def export(size, out):
    """{manifest name: (path, info)} for whisper_<size>_encoder, _decoder (float16), their _f32 copies, whisper_<size>."""
    import onnxruntime as ort
    enc, dec, cfg, fw, heads = load(size)
    L, d, n_mels, H = cfg['decoder_layers'], cfg['d_model'], cfg['num_mel_bins'], cfg['decoder_attention_heads']
    torch.manual_seed(0)
    mel = torch.randn(1, n_mels, 3000) * 0.5
    tokens = torch.tensor([[50258, 50259, 50359, 50364, 400, 401, 402]] * 2, dtype=torch.int32)
    tokens[1, 4:] = torch.tensor([500, 501, 502])
    rel = lambda a, b: float(np.abs(a - b).max() / (np.abs(b).max() + 1e-12))
    names = lambda p: [f'{p}{i}' for i in range(L)]
    enc_out = names('k') + names('v')
    dec_in = ['tokens', 'order'] + names('pk') + names('pv') + enc_out
    dec_out = ['logits'] + names('nk') + names('nv') + ['qk']
    with torch.no_grad():
        kv32 = enc(mel)
        z = [torch.zeros(2, H, 0, d // H)] * (2 * L)
        ref = dec(tokens, torch.arange(2, dtype=torch.int32), *z, *kv32)
    res = {}
    for prec, dt in (('f32', torch.float32), ('f16', torch.float16)):
        suffix = '_f32' if prec == 'f32' else ''
        enc.to(dt), dec.to(dt)
        epath = os.path.join(out, f'whisper_{size}_encoder{suffix}.onnx')
        dpath = os.path.join(out, f'whisper_{size}_decoder{suffix}.onnx')
        with torch.no_grad():
            torch.onnx.export(enc, (mel,), epath, input_names=['mel'], output_names=enc_out, opset_version=17,
                              dynamo=False, do_constant_folding=True)
            pk = [torch.zeros(2, H, 2, d // H)] * (2 * L)
            axes = {'tokens': {0: 'b', 1: 'n'}, 'order': {0: 'b'}, 'logits': {0: 'b', 1: 'n'}, 'qk': {0: 'b', 2: 'n'},
                    **{x: {0: 'rows', 2: 'past'} for x in names('pk') + names('pv')},
                    **{x: {0: 'b', 2: 'total'} for x in names('nk') + names('nv')}}
            torch.onnx.export(dec, (tokens[:, :3], torch.tensor([1, 0], dtype=torch.int32), *pk, *kv32), dpath, input_names=dec_in, output_names=dec_out,
                              dynamic_axes=axes, opset_version=17, dynamo=False, do_constant_folding=True)
        enc.to(torch.float32), dec.to(torch.float32)
        # checks: the encoder against PyTorch (float32), the decoder at once and in steps through its cache
        if prec == 'f32':
            se = ort.InferenceSession(epath, providers=['CPUExecutionProvider'])
            sd = ort.InferenceSession(dpath, providers=['CPUExecutionProvider'])
            kv = se.run(None, {'mel': mel.numpy()})
            feed = lambda t, o, cache: dict(zip(dec_in, [t.numpy(), np.array(o, np.int32)] + list(cache) + kv))
            z = [np.zeros((2, H, 0, d // H), np.float32)] * (2 * L)
            full = sd.run(None, feed(tokens, [0, 1], z))
            # the prompt once, then both rows from its cache (order [0, 0]), and a swap (order [1, 0]) undone
            z1 = [np.zeros((1, H, 0, d // H), np.float32)] * (2 * L)
            p = sd.run(None, feed(tokens[:1, :4], [0], z1))
            a = sd.run(None, feed(tokens[:, 4:5], [0, 0], p[1:1 + 2 * L]))
            sw = [x[::-1].copy() for x in a[1:1 + 2 * L]]
            b = sd.run(None, feed(tokens[:, 5:], [1, 0], sw))
            a = [np.concatenate([p[0], p[0]]), a[0]]
            b = [None, b[0]]
            kerr = max(rel(o, r.numpy()) for o, r in zip(kv, kv32))
            print(f'whisper {size}: encoder ONNX vs PyTorch {kerr:.1e}; decoder ONNX vs PyTorch '
                  f'{rel(full[0], ref[0].numpy()):.1e} (qk {rel(full[-1], ref[-1].numpy()):.1e}); in two steps vs at '
                  f'once {rel(np.concatenate([a[0], a[1], b[1]], 1), full[0]):.1e}', flush=True)
            assert kerr < 1e-3 and rel(full[0], ref[0].numpy()) < 1e-3
            assert rel(np.concatenate([a[0], a[1], b[1]], 1), full[0]) < 1e-4
        info = {'size': size, 'precision': prec, 'layers': L, 'width': d, 'heads': H, 'n_mels': n_mels,
                'source': 'https://huggingface.co/openai/whisper-' + size}
        res[f'whisper_{size}_encoder{suffix}'] = (epath, info)
        res[f'whisper_{size}_decoder{suffix}'] = (dpath, info)
    try:
        # the same window through faster-whisper's own model (CTranslate2, float32): the encoder's output
        import ctranslate2
        m = ctranslate2.models.Whisper(fw, device='cpu', compute_type='float32')
        ct = np.array(m.encode(ctranslate2.StorageView.from_array(np.ascontiguousarray(mel.numpy())), to_cpu=True))[0]
        with torch.no_grad():
            print(f'whisper {size}: encoder output vs CTranslate2 {rel(enc.hidden(mel).numpy(), ct):.1e}', flush=True)
    except Exception as e:
        print('whisper: not checked against CTranslate2:', e)
    res[f'whisper_{size}'] = (tokens_json(size, fw, heads, cfg, out), {'size': size, 'kind': 'tokenizer'})
    return res


def tokens_json(size, fw, heads, cfg, out):
    """The tokenizer as the pipeline needs it: each text token's bytes (hex), and faster-whisper's special tokens,
    suppressed tokens (get_suppressed_tokens(tokenizer, [-1])) and language tokens."""
    import tokenizers
    from faster_whisper.tokenizer import Tokenizer, _LANGUAGE_CODES
    from faster_whisper.transcribe import get_suppressed_tokens
    hf = tokenizers.Tokenizer.from_file(os.path.join(fw, 'tokenizer.json'))
    tk = Tokenizer(hf, True, task='transcribe', language='en')
    # GPT-2's byte-level alphabet, to turn token strings back into bytes
    bs = list(range(ord('!'), ord('~') + 1)) + list(range(ord('¡'), ord('¬') + 1)) + list(range(ord('®'), ord('ÿ') + 1))
    cs, n = bs[:], 0
    for b in range(256):
        if b not in bs:
            bs.append(b)
            cs.append(256 + n)
            n += 1
    byte_of = {chr(c): b for b, c in zip(bs, cs)}
    text = [None] * tk.eot
    for t, i in hf.get_vocab(with_added_tokens=False).items():
        if i < tk.eot:
            text[i] = bytes(byte_of[c] for c in t).hex()
    assert all(t is not None for t in text), 'a text token without bytes'   # (one, 50256, is empty)
    # check the bytes decode as the tokenizer does
    for ids in ([400, 401, 402, 1029], list(range(1000, 1100))):
        assert bytes.fromhex(''.join(text[i] for i in ids)).decode('utf-8', 'replace') == hf.decode(ids)
    fwcfg = json.load(open(os.path.join(fw, 'config.json')))
    j = {'size': size, 'vocab': cfg['vocab_size'], 'text': text,
         'eot': tk.eot, 'sot': tk.sot, 'sot_prev': tk.sot_prev, 'sot_lm': tk.sot_lm, 'transcribe': tk.transcribe,
         'translate': tk.translate, 'no_timestamps': tk.no_timestamps, 'no_speech': tk.no_speech,
         'timestamp_begin': tk.timestamp_begin,
         'suppress': list(get_suppressed_tokens(tk, [-1])), 'suppress_begin': fwcfg['suppress_ids_begin'],
         'languages': {c: hf.token_to_id('<|%s|>' % c) for c in _LANGUAGE_CODES},
         'lang_ids': fwcfg['lang_ids'], 'alignment_heads': heads,
         'max_length': cfg['max_target_positions'], 'n_mels': cfg['num_mel_bins'],
         'layers': cfg['decoder_layers'], 'width': cfg['d_model'], 'heads': cfg['decoder_attention_heads']}
    path = os.path.join(out, f'whisper_{size}.json')
    json.dump(j, open(path, 'w'), separators=(',', ':'))
    return path


def export_silero(out):
    import shutil
    from faster_whisper.utils import get_assets_path
    path = os.path.join(out, 'silero_vad_v6.onnx')
    shutil.copyfile(os.path.join(get_assets_path(), 'silero_vad_v6.onnx'), path)
    return path, {'source': 'faster-whisper 1.2.1 (https://github.com/snakers4/silero-vad)', 'ep': 'cpu'}
