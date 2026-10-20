# Telling instruments apart (research, 2026-10-19)

The goal (the user): the data says "instrument X plays note Y", "A plays G#, B plays C". Two singers are two lines,
two guitars two instruments even in the same range, one guitar's chord one instrument; nothing leaks between
instruments (no voice in the guitar stem, no supersaw in the vocal stem). All of it matters; none of it is solved by
drawing. Today: six stems (RoFormer voice, then Demucs htdemucs_6s), Basic Pitch / CREPE / pYIN inside each stem.

## What exists

**Transcription that labels each note with its instrument**
- YourMT3+ (Chang et al. 2024, arXiv 2407.04822; code github.com/mimbres/YourMT3, GPL-3.0; checkpoints on Hugging
  Face mimbres/YourMT3; 45.8M parameters, PyTorch). MT3's token decoder with a time-frequency transformer encoder and
  mixture of experts. Trained vocabulary separates acoustic / clean electric / distorted guitar, acoustic / electric
  bass, singing main melody (program 100) and chorus (101); evaluated in 13 classes. Instrument-aware note F1
  (program, onset and offset must match): Slakh 74.0-74.8 (MT3 57.7-62), URMP ensembles 67.2-68.0. Per instrument:
  GuitarSet guitar onset F1 91.7, MIR-ST500 singing 71.6. Weak spots the paper reports: pop music (RWC-Pop) instruments
  other than piano, bass, vocals and drums under 10%; octave errors; singing onsets 50-100 ms off; trained mostly on
  synthetic audio. Not evaluated: two instruments of the same kind. About 36x real time on a T4 in float16.
  GPL-3.0: porting its code into src/pipeline would make that code GPL; running it as a separate step need not.
- Timbre clustering of notes into N parts: Tanaka et al. ISMIR 2020 (deep spherical clustering of spectrogram and
  pitchgram, N given) and Li & Zhu arXiv 2509.12712 (note-level timbre embeddings clustered, N not fixed, unseen
  timbres). These aim at "which notes belong together", the same-instrument case included in principle; untested
  on two players of one instrument.

**Separating more finely**
- Lead vs backing vocals ("karaoke" models): community BS-RoFormer / Mel-RoFormer models, lead-vocal SDR about
  9.5-10.1 dB on MVSEP's own test set (self-reported, not peer reviewed; mvsep.com/news/64).
- Two singers: MedleyVox (Jeon et al. ICASSP 2023): an evaluation set of 381 segments from 23 MedleyDB songs (unison,
  duet, main vs rest, N singers), and iSRNet, close to ideal masks on duets and unison. Code github.com/jeonchangbin49/MedleyVox.
- Two guitars: little that works. Moises sells a lead/rhythm split (closed). MVSEP has guitar-vs-rest and a 53-stem
  model (acoustic vs electric guitar, no lead/rhythm). Research: GuitarDuets (arXiv 2507.01172, classical guitar
  duets), score-informed guitar separation. Forum experience: works when the guitars are panned apart.
- Stereo position (measured in the player spike, notes/drawing-how-it-sounds.md): separates players only when panned
  apart and playing different notes; double-tracked guitars playing one riff measure centred.

**Ground truth to measure against** (audio stays out of the repo, as always)
- Cambridge-MT multitracks: real recordings, every instrument on its own track, 44.1 kHz WAV; free for educational
  use, research "within the spirit" but not formally agreed with contributors; no commercial use. Pick songs with two
  guitars, lead + backing vocals, duets.
- MedleyDB (196 songs, stems + instrument activations + melody; access by request), MedleyDB-Pitch (CC BY-NC-SA 4.0),
  MedleyVox (two-singer segments from it).
- MoisesDB (240 songs, 12 genres, fine-grained stems; licence "ncrlc", non-commercial; download from Moises' site).
- URMP (44 classical ensembles, each player recorded alone with note transcriptions; quartets have two violins: the
  same-instrument case with exact notes).
- Slakh2100 (synthesised from MIDI, exact notes per instrument; sounds synthetic).

## Proposed plan (not agreed yet)

1. **A test set with ground truth.** A dozen multitracks chosen for the cases that matter: two guitars (doubled, and
   different parts), lead + backing vocals, a duet, a synth lead over a pad, plus URMP's two violins. Mix the tracks;
   keep each true track.
2. **A score.** For any method: leakage (how much of each true instrument lands in each output, dB), and notes per
   instrument against the true tracks (onset F1 with the instrument right; reference notes from Basic Pitch / CREPE on
   each isolated true track, which is clean audio). One command, one table.
3. **Baseline**: today's pipeline on it.
4. **Candidates**, each scored the same way: YourMT3+ (labelled notes directly); a lead/backing vocal model after the
   voice; note-level timbre + stereo clustering within a stem; a two-singer separator (MedleyVox's).
5. Pick by the numbers, then show the user on real songs; the user's ears decide.

## What was done (2026-10-19/20)

The plan was followed (tools/instruments/: build.py makes the sets, score.py scores, baseline.py / oracle.py /
pan.py / voices.py / medleyvox.py / ymt3.py run the methods, listen.py makes a page to compare by ear). Sets
(testsongs/multitrack/, git-ignored): Slakh (20 songs, exact MIDI per instrument; 20 more with engineer-like pans),
Cantoria (14 four-part a cappella pieces, notes from each singer's own pYIN), duets (84 pairs of Cantoria singers,
first 60 s), MUSDB18-HQ test (50 real songs; notes only for vocals and bass, by pYIN on their stems).

**Separating, then transcribing**: nothing came close to good. Paired note F1 at 20 ms: today's pipeline 0.14 on
Slakh (46-60% of its stem notes are no one's); YourMT3+ 0.55 on Slakh (in its training set) and 0.10 on Cantoria (it
calls singers organ, brass, reed or strings and merges them); MedleyVox on two Cantoria singers 0.26-0.27; even CREPE
on each singer's own clean track scores 0.83 (the ceiling). Stereo can split two players only where panned apart
(exact 2x2 solve: perfect on two synthetic sources; Slakh-with-pans and MUSDB scored but not better). By ear (the
listening page) every method sounded wrong.

**Colouring by sound instead (the user's idea, spike-timbre/colour/, untracked)**: no separation; every note drawn,
coloured only by measured qualities, so two players look different because they sound different. The score: AUC of
hue distance, two players' notes sounding together against one player's notes within 3 s (0.5: no better than
chance; 1: always more different). The answer key (relabel.py) is taken from the separate recordings: whose own
recording is loudest at the note's pitch over it (a player on that pitch with 15%+ of the energy owns it), and a
partial of a lower note of theirs is an overtone. Matching by written notes alone failed: a palm-muted guitar's 33 ms
notes never cover half a Basic Pitch note (0 of 230 credited on Slakh Track00002; 65 now), and Slakh's "Lead 2"
patch sounds two octaves above its written notes (4.9 dB at its written pitch against the clavinet's 33.6), so it was
credited with 295 notes that were others'.

Measured on held-out pieces (5 folds; duets and Cantoria grouped by piece, since every duet reuses a quartet's
recordings; all voice material is the same four Cantoria singers, so voices are not tested on unknown singers):

- **Overtones**: Basic Pitch breaks overtones into pieces: 44% overlap their note under 0.15 s, too short for pitch
  wobble (common fate: r +0.17 for two singers, +0.92 for a note and its own overtone). The spectral echo test
  (Klapuri's smoothness) catches the short ones on voices but on instruments folded 46-62% of real notes (bands
  double in octaves and fifths). A classifier over every cue (keep.py: the note's own measures, its moment, and the
  note below it; gradient boosting): keeping 95% of players' notes it removes 94% of overtones and 82% of junk on
  voices, 28% and 43% on instruments (AUC 0.98 / 0.81). Its cues: spectral tilt, level against the song's loud notes,
  odd/even balance, harmonic centre, harmonicity, distance in sound to the note below; not pitch.
- **Which notes**: the pipeline's own lines (lines.json: each stem's lines with ink >= 0.25) carry far more of a
  player: of drawn note-seconds, 82% (Slakh) and 77% (MUSDB) are a player's, against 53% and 55% for Basic Pitch on
  the mix; overtones 6% and 11% (22%, 16%). But its voice is one CREPE line: two singers need Basic Pitch.
- **Colour**: every measure (spectral envelope at fixed Hz, harmonic MFCCs, tilt, singer's formant, harmonicity,
  jitter, shimmer, vibrato, pan, attack, onset sharpness, decay, odd/even, harmonic centre), standardised within the
  song, projected on the two directions along which players in other pieces differ most (LDA, classes = (song,
  player)); lines chained by sound; a line's mean as hue. Contrast, voices / Slakh / MUSDB: brightness + MFCC
  directions within the song (the first try) 0.785 / 0.721 / 0.598; learned 0.862 / 0.792 / 0.684; with lines
  sounding together nudged apart or together by how likely they are two players (distance, start and end together,
  pitch gap; logistic, learned) 0.877 / 0.813 / 0.704. Chords reading as one (one player's simultaneous notes
  against two players'): 0.863 / 0.758 / 0.682. On the pipeline's lines: Slakh 0.788, MUSDB 0.850.
- On the page songs (draw3.py): duets 0.69-0.91 (first try 0.62-0.79), ink on real singers 84-93% after fading by
  the classifier (49-71% before); Slakh from the pipeline's lines 0.78-0.84, MUSDB 0.85-0.92.
