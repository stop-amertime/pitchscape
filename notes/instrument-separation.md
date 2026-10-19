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
