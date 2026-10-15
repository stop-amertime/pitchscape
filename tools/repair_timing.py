"""usage: python3 tools/repair_timing.py WORKDIR
Fixes the one failure seen in alignment: a word whose span reaches back across a silence (the aligner can glue a
line's first word to the tail of the previous line). Such words are moved to where the voice actually resumes.
Writes timing.json, the format the page reads."""
import json, os, sys, numpy as np, soundfile as sf
work = sys.argv[1]
T = json.load(open(os.path.join(work, 'ctc_timing.json')))
x, sr = sf.read(os.path.join(work, 'stems', 'vocals.wav')); x = x.mean(1); hop = int(sr * 0.02)
rms = np.array([np.sqrt(np.mean(x[i * hop:(i + 1) * hop] ** 2)) for i in range(len(x) // hop)])
db = 20 * np.log10(rms + 1e-9); voiced = db > np.percentile(db, 95) - 28
moved = 0
for o in T:
    for k in range(len(o['words'])):
        s, e = o['words'][k], o['ends'][k]; seg = voiced[int(s / 0.02):int(e / 0.02)]
        run, last_gap_end = 0, None
        for q, v in enumerate(seg):
            if not v: run += 1
            else:
                if run >= 20: last_gap_end = q      # a silence of 0.4 s or more inside the word
                run = 0
        if last_gap_end is not None and (len(seg) - last_gap_end) * 0.02 >= 0.1:
            o['words'][k] = round(s + last_gap_end * 0.02, 3); moved += 1
    o['t'] = o['words'][0]
json.dump({'format': 'song-overprint-timing', 'version': 2,
           'method': 'Demucs vocal stem + wav2vec2 CTC forced alignment',
           'lines': [{'h': o['h'], 't': o['t'], 'e': o['e'], 'words': o['words']} for o in T]},
          open(os.path.join(work, 'timing.json'), 'w'))
print('timing.json written; words moved past a silence:', moved)
