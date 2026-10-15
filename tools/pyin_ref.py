"""usage: python3 tools/pyin_ref.py work/<slug>/stems/bass.wav OUT.npy
Reference bass pitch (librosa pYIN) on the isolated bass stem, one value per engine frame (0 = no note).
Convert to raw float32 for tests/real_bass.js: numpy.load(OUT).tofile(REF.f32)."""
import sys, numpy as np, librosa, soundfile as sf
x, sr = sf.read(sys.argv[1]); x = x.mean(1) if x.ndim > 1 else x
x = librosa.resample(x, orig_sr=sr, target_sr=22050)
f0, vflag, vprob = librosa.pyin(x, fmin=30, fmax=280, sr=22050, frame_length=4096, hop_length=512, center=True)
np.save(sys.argv[2], np.nan_to_num(np.where(vflag, f0, 0.0)).astype(np.float32))
print('frames', len(f0), 'voiced', float(np.mean(vflag)))
