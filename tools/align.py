"""usage: python3 tools/align.py WORKDIR
Forced alignment: every lyric word is placed on the isolated vocal (stems/vocals.wav) with wav2vec2 (CTC),
one global pass over the whole song in sung order. Writes ctc_timing.json. About 1 min for 3 min of audio on 2 cores.
The first run downloads the model (1.2 GB) from download.pytorch.org."""
import json, os, sys, subprocess, time, numpy as np, torch, torchaudio
work = sys.argv[1]
torch.set_num_threads(os.cpu_count() or 2)
written = json.load(open(os.path.join(work, 'written.json')))
words_by_line = json.load(open(os.path.join(work, 'page_words.json')))
bundle = torchaudio.pipelines.WAV2VEC2_ASR_LARGE_LV60K_960H
model = bundle.get_model().eval(); labels = bundle.get_labels(); lab = {c: i for i, c in enumerate(labels)}
raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', os.path.join(work, 'stems', 'vocals.wav'), '-f', 'f32le', '-ac', '1', '-ar', '16000', '-'], capture_output=True, check=True).stdout
wav = torch.from_numpy(np.frombuffer(raw, dtype=np.float32).copy())[None]
N = wav.shape[1]; SEG, CTX = 16000 * 20, 16000 * 1
t0 = time.time(); parts = []; pos = 0
with torch.inference_mode():
    while pos < N:   # 20 s chunks with 1 s of context each side, cropped back to the chunk
        a, b = max(0, pos - CTX), min(N, pos + SEG + CTX)
        e, _ = model(wav[:, a:b]); e = torch.log_softmax(e, -1)[0]
        fps = e.shape[0] / ((b - a) / 16000)
        f0 = int(round((pos - a) / 16000 * fps)); f1 = int(round((min(pos + SEG, N) - a) / 16000 * fps))
        parts.append(e[f0:f1]); pos += SEG
E = torch.cat(parts); fd = N / 16000 / E.shape[0]
toks, owner = [], []
for li, ws in enumerate(words_by_line):
    for wi, w in enumerate(ws):
        chars = [c for c in w.upper().replace('’', "'") if c in lab and c not in '-|'] or ["'"]
        for c in chars: toks.append(lab[c]); owner.append((li, wi))
        toks.append(lab['|']); owner.append(None)
toks, owner = toks[:-1], owner[:-1]
ali, scores = torchaudio.functional.forced_align(E[None], torch.tensor([toks], dtype=torch.int32), blank=0)
spans = torchaudio.functional.merge_tokens(ali[0], scores[0].exp())
res = [[None] * len(ws) for ws in words_by_line]
for sp, ow in zip(spans, owner):
    if ow is None: continue
    li, wi = ow; s, e = sp.start * fd, sp.end * fd; r = res[li][wi]
    res[li][wi] = [s, e, [sp.score]] if r is None else [min(r[0], s), max(r[1], e), r[2] + [sp.score]]
out = [{'h': written[li]['h'], 't': round(res[li][0][0], 3), 'e': round(res[li][-1][1], 3),
        'words': [round(r[0], 3) for r in res[li]], 'ends': [round(r[1], 3) for r in res[li]],
        'conf': [round(float(np.mean(r[2])), 3) for r in res[li]]} for li in range(len(words_by_line))]
json.dump(out, open(os.path.join(work, 'ctc_timing.json'), 'w'))
print('aligned %d lines in %.0fs; mean word confidence %.2f' % (len(out), time.time() - t0, np.mean([c for o in out for c in o['conf']])))
