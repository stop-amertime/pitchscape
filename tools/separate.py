"""usage: python3 tools/separate.py SONG.mp3 OUTDIR
Splits a song into drums / bass / other / vocals stems with Demucs (htdemucs). About 2.5 min for a 3-min song on 2 CPU cores."""
import sys, os, subprocess, time, numpy as np, torch, soundfile as sf
from demucs.pretrained import get_model
from demucs.apply import apply_model
src, out = sys.argv[1], sys.argv[2]
os.makedirs(out, exist_ok=True)
raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', src, '-f', 'f32le', '-ac', '2', '-ar', '44100', '-'], capture_output=True, check=True).stdout
x = np.frombuffer(raw, dtype=np.float32).reshape(-1, 2).T.copy()
torch.set_num_threads(os.cpu_count() or 2)
model = get_model('htdemucs'); model.eval()
wav = torch.from_numpy(x); ref = wav.mean(0); m, s = ref.mean(), ref.std()
t0 = time.time()
with torch.no_grad():
    srcs = apply_model(model, ((wav - m) / s)[None], device='cpu', shifts=1, split=True, overlap=0.25, progress=False)[0]
srcs = srcs * s + m
for name, st in zip(model.sources, srcs):
    sf.write(os.path.join(out, f'{name}.wav'), st.numpy().T, 44100, subtype='FLOAT')
print('stems: %s in %.0fs' % (', '.join(model.sources), time.time() - t0))
