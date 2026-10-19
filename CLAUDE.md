# Pitchscape: notes for agents

Read this before changing anything. README.md is the user-facing reference (data formats, measured results, setup);
this file is the why, the flow, and what has been learned the hard way.

## What it is

A phone-friendly music visualiser in a risograph print style. A song is analysed once by a server (stems, drums,
notes, bass, voice, tone, width, lyrics) into a **pack** (JSON); the page plays the song and draws the pack as a
scrolling print: time runs right to left past a "now" line, pitch runs up the screen, each instrument in its own ink.

- Page: `src/page/` (Vite + Svelte, + `src/dsp.js`), built to `docs/`, served by GitHub Pages
  (https://stop-amertime.github.io/pitchscape/ redirects to `docs/`).
- Cloud server: Modal (`server/modal_app.py`), GPU (L4), running the JavaScript pipeline (`src/pipeline/`) under Node
  (`server/js.py` → `server/analyse.mjs`, onnxruntime-node on CUDA). `server/pipeline.py` is no longer run: it is the
  Python reference the JavaScript was ported from and checked against (`tools/parity*.py`).
- Local server: `server/local.py` (`Pitchscape.bat` on Windows) runs the same pipeline and serves the page.

## The principle: it should look to the eye the way it sounds to the ear

Every visual property is a **measured property of the sound**, produced by an **established, published model or
library**, not a mapping or heuristic we made up. When a choice feels arbitrary, it probably is: find what the
sound (or the ear) actually does and draw that.

| What you see | What it is | Measured by |
| --- | --- | --- |
| height | pitch, on a log axis fitted to the song's range | CREPE (voice, guitar line), Basic Pitch (notes, bass), pYIN (bass line, a Lab option) |
| a note's path | its pitch through time, bends and vibrato included | Basic Pitch's per-frame pitch bends |
| colour | which instrument (stem), warm inks for what is out front | Demucs htdemucs_6s stems |
| thickness | thin by default (each note apart); Lab: how wide the sound spreads along the ear (excitation pattern; for notes and bass, a pure tone's at their pitch and level) | Glasberg & Moore roex filters, ISO 532-2 resolutions |
| ink density across the stroke | (ear thickness) solid within 1 dB of the excitation peak, lighter to 3 dB, haze to 10 dB | same |
| ink strength along the stroke | the note's own level along its path (its real fade) | librosa CQT on its stem |
| edge: smooth to torn, bristles across | noise heard on it (HPSS residual within 36 dB of the loudest sound within 3 semitones, where the stem is noisy) | librosa CQT + HPSS (Driedger 2014) |
| ticks through a note | a strike heard on it (HPSS percussive part) | same |
| which notes print | an overtone of a lower note or a still-ringing key re-read as new does not | partials 7 dB over the lower note's neighbours; partials rising 6 dB at the onset |
| drum marks | each hit, its kind, its own spectrum and ring | ADTOF drum transcription on the drum stem |
| words | the published lyrics, placed when and roughly where they are sung | LRCLIB text, Whisper word timings |

Corollaries the user has stated or endorsed:

- **No fallbacks or stand-ins.** If data is missing, show nothing (or say so), never a substitute that looks like data.
  An old pack is analysed again, not drawn with defaults; no lyrics from LRCLIB means no words, never Whisper's
  transcription.
- **Fade, don't cut.** Certainty and loudness never decide whether something prints: an unsure or quiet note prints
  fainter, fading smoothly to nothing, never vanishing at a step. Only decisions about *what a sound is* may remove
  it: an overtone of a lower note (the echo test), a leak from another stem. Even those fade near their margin. A hard
  threshold makes squared-off edges and drops real music (pipeline 11's page, 21 songs: the note-hold check at 0.3 plus
  a 100 ms shortest piece lost 17-23% of note-seconds; on a fast guitar solo 386 of 637 notes, though their median
  level was 17 dB below the guitar's loudest). No minimum lengths. Lab levers set how gradual a fade is, not where a
  cut falls; the server sends everything down to its floors and the page fades. (As of pipeline 11 the page still
  cuts by note hold, shortest note, voice certainty and loudness, shortest run, and "heard within": to be converted.)
- **Masking is the ear's, not ours.** What one sound hides of another is judged within the ear's bandwidth at that
  pitch (Glasberg & Moore's ERB), not a fixed number of semitones, and it fades with how far below the masker it is.
- **Character, not the analysis's texture.** Each instrument should look the way it sounds to a listener (distorted
  guitar gritty and continuous, a piano struck and fading, a pad a soft wide wash, a lead a crisp line) while staying
  readable as music. Drawing the raw transform (every CQT bin, every overtone, 72 dB of it) shows the measuring tool's
  grid and the stems' bleed and looks artificial; overtones of a note are not drawn as lines of their own. Character
  comes from measured qualities of each sound (noisy or pure, struck or held, its level and fade, wide or narrow in
  stereo, steady or wobbling), each drawn as a print would.
- **An instrument is a body, its notes are inside it (the tree).** What works to watch moves in time with what is
  heard: a drum hit appears, has a size and fades on the beat; a single voice is one line that moves with the melody.
  Notes drawn as thin lines of near-constant ink do not: they show what is played but not the instrument's life, the
  swell, the pluck and its decay, the pumping "wub", the fade, which the ear follows as closely as the pitches. So
  each instrument (stem) has a body with its own envelope through time, and its notes are drawn within it: the body
  spans the pitches it is playing at that moment (narrow for one note, tall for a chord), its ink and thickness follow
  the stem's measured loudness moment to moment, and its edge or texture its brightness (a filter opening and closing
  is much of a synth's swell and wub). A pluck is a burst that shrinks away, a pad a slow swell, a pumping synth a band
  that pulses in time, a fade-out thins to nothing; the notes stay readable inside. Pitch movement within a held synth
  note is small (Glue, held sounds: median 7-9 cents), so "it sounds alive but looks static" is usually dynamics, not
  pitch. Like everything else, the envelope is measured (each stem's level and spectral centroid), never animated for
  effect.
- **Judge by a viewer, measure against ground truth.** Whether it works is whether someone watching would want to see
  it, not whether it matches a score. But claims about what is found (notes, bleed, which instrument) are checked on
  multitracks where every instrument was recorded separately (`testsongs/multitrack/`, Cambridge-MT), never only by eye.
- **One problem at a time, the coarse ones first.** The voice bleeding into the guitar stem, and a pad and a lead synth
  drawn alike, come before telling two of the same instrument apart (the hardest case in source separation).
- **Prefer established libraries over hand-rolled heuristics**, and a model's own decision over a threshold we invent
  (pYIN's voicing is an HMM decision, so bass gets no "certainty" lever).
- Where a faithful rendering looks bad (distorted rhythm guitar really does excite 10+ semitones of the ear per strum),
  show the user and let them choose; give a Lab switch rather than quietly bending the measurement.

## How to work with this user

- **Talk before big changes.** Propose what you will do (and why), then do it once agreed. Small fixes are fine.
- **Measure, and report honestly.** Numbers, not adjectives. Say what you did not test. Correct yourself out loud when
  a measurement was wrong.
- **Test on real music**, not one track: `tools/fetch_test_songs.sh` (below). Never commit audio: commercial or not,
  audio stays out of the repo (`*.mp3`, `testsongs/` are git-ignored).
- Commit and push straight to `main` (no pull requests unless asked). Every push to `server/**` redeploys Modal.
- Never ask for secrets in chat. Repository secrets: `MODAL_TOKEN_ID`, `MODAL_TOKEN_SECRET`, `PITCHSCAPE_PASSPHRASE`.
- Plain copy in the UI: say what the user does not know and what they will do differently. Lab explanations live in
  the ⓘ bubbles (`data-tip`), each also as visually hidden text for screen readers.
- It opens on the splash (pick a song: from the device, by link, the demo or a tried-and-tested free song). Then the
  screen is only the print. Controls (play, seek, Change song) appear on tap and fade with a faint Lab cog in the top
  corner; the Lab opens as a panel below the print. No lyrics pasting: words come from the server or there are none.

## The flow, end to end

1. **Load** (`openSong` in src/page/legacy.js): the page hashes the file (SHA-256) and looks for its analysis: IndexedDB
   (`pack:<pipeline>:<sha>`), then `GET /packs/<sha>`. A link (`loadLink`) goes straight to `POST /analyze` with `url`:
   the server downloads it (`server/fetch.py`: public addresses only, checked at every redirect, 80 MB, 60 s; Drive and
   Dropbox share links become download links), keeps it in the library and answers with its `sha256`; the page then
   plays `GET /library/<sha>/audio`. The same file by link or upload is the same sha and the same pack.
2. **Analyse** (`analyse`): otherwise `POST /analyze` with the file; poll `GET /jobs/<job>?key=<version:sha>` and show
   each stage (`STAGES` maps the pipeline's progress messages to text). The page plays only once the analysis is in.
3. **Server** (`modal_app.py`): caches packs at `/cache/v<version>/<sha>.json` on a Modal Volume; keeps each song's
   audio and `song.json` under `/cache/library/<sha>/`; dedupes concurrent jobs (`running` Dict, ignores stuck ones);
   stage messages in the `progress` Dict. `server/local.py` does the same on one machine with a library folder.
4. **Pipeline** (`analyze` in `src/pipeline/index.mjs`; the stage names below are pipeline.py's, which the JS follows), in order (each `progress('<stage>: ...')`):
   - `stems` (pipeline 12): the voice first, by Kimberley Jensen's Mel-Band RoFormer (`vocals.mjs`), then Demucs
     htdemucs_6s on the song minus the voice → drums, bass, other, vocals (added to the voice), guitar, piano. Why:
     Demucs alone left the voice audible in the guitar and other stems (heard on Code Monkey, Fluoride and Denial; an
     energy measure at the voice's harmonics could not tell bleed from a guitar playing the singer's notes, so the
     user's ears decided). Then (pipeline 10) made to add up to the
     song: each stem takes its share of the leftover (mix minus their sum) in proportion to its power in each STFT bin
     (`consistent`, `mixture.dsp.mjs`: Wisdom et al. 2019's mixture-consistency projection). The leftover was about
     -23 dB below the mix; most stems change by -20 to -35 dB, the quiet ones gain most (other, piano), and sound that
     cancelled out across stems goes (the guitar solo's bass, other, piano). ~2% more notes. Full Wiener masking was
     tried and rejected (stems moved -8 to -14 dB to recover a -22 dB leftover). Not in server/pipeline.py.
   - `drums`: ADTOF (ONNX) activations → `peak_pick` (madmom's procedure, the authors' thresholds) down to 0.6x, each hit
     with its margin; `drum_details` adds its spectrum (16 bands), ring time, kick pitch.
   - `notes`: Basic Pitch on other / guitar / piano separately (`notes_from_stem`, followed down to 15% certainty, with
     per-frame activation); `join_bends` rejoins a bend Basic Pitch split across semitones; `note_details` measures
     family (struck / swell / held), attack, fade, vibrato, hollowness along the bent pitch; `notes_by_stem` drops
     leaks between stems.
   - `bass`: pYIN on the bass stem. `voice`: CREPE on the vocal stem (`voice_line`; `voice_gate` = the default cuts).
   - `tone`: MOSQITO roughness and sharpness: one 200 ms slice per note (shared per stem and slice) and every 0.5 s of
     voice and bass, in a spawn process pool, with the mix set to 70 dB SPL.
   - `width`: `Ear` excitation patterns per stem; widths (down, up) at 1 / 3 / 10 dB for every voice frame, bass frame
     and note sample (`ear_line`, `pack_curves`).
   - `lines` (pipeline 13, pack 16; `lines.mjs`, `lines.dsp.mjs`; JS only): each pitched stem's sounds followed as whole
     lines through time from Basic Pitch's contour (gaps of up to 5 frames bridged, so pads stay whole), each point's
     level from a gammatone at its pitch (the ear's time resolution, envelope to 20 Hz: the CQT's 0.93 s window at
     55 Hz averaged a wub away), its ring followed after Basic Pitch lets go, overtones faded by whole lives (a line
     at 2-8x a lower one that starts with it and whose level moves with it), masking within an ERB, and strikes from
     librosa's onsets on the stem (raw strength: a pad ~1, a Rhodes 4.5-7). The page (Lab > Instruments: Lines,
     the default) draws each line crisp-edged, as thick as it is loud (sones), with a darker head where struck.
     Designed in the Song Lab (spike-timbre/, untracked). Glue: 27 s alongside the other stages; +1.2 MB of pack.
   - `words`: `lyrics_for`: tags (`song_tags`/`song_info` via ffprobe, or an "Artist - Title" file name) → LRCLIB
     (`find_lyrics`: exact match, then search, preferring synced, within 3 s of the length; title-only if the tagged
     artist finds nothing and exactly one artist has it) → Whisper words → `place_words` (difflib match, LRC line
     times, global offset, interpolation).
   - The pack also records `song` (title, artist, album, ISRC, MusicBrainz ids, length, every tag) for matching the
     recording elsewhere later (e.g. following Spotify playback; see README).
5. **Page** (`packToRes` → `setAnalysis` → `applyCuts`): decodes arrays (`arrays` as base64 float32, `bytes` as
   quantised uint8), applies every Lab cutoff, eases ear widths, fits the pitch range (`fitRange`, `scaleY`).
6. **Draw** (`draw`, every frame), layers bottom to top: synths, piano, guitar (`drawSegs`), bass, voice (`frameTrack`),
   hats/cymbals, toms, snare (`drawHits`), kick (`drawKicks`), words (`drawWords`). Strokes are `ribbon` (filled band
   with edge wave from harshness), `smudge` (bass as soft dabs on their own layer), `pen` (dot at "now"); kicks are
   part-transparent splatters (or halftone). Snare, hats and cymbals print in a strip along the top (`BEAT_H`); toms
   and kicks on the sheet at their pitch.
   The print is a stack of elements the browser composites (`#sheet` in index.html): `#cv` (paper and pitch lines),
   the bass and kick glows (divs, opacity), `#stripView`/`#stripRow` (the finished print), `#liveCv` (the last
   moment), the head (a div) and the grain (a canvas, `mix-blend-mode: screen`). Tilt is the sheet's CSS transform,
   shake the inner `#shake`'s. While the Lab is closed the print is drawn ahead into strip canvases in the row
   (`printStrips`: 1024 px, a 128 px chunk at a time within 4 ms a frame, each drawn at a moment when every mark
   reaching into it has settled, `lag`); a frame moves the row with one transform, clips it where the live part
   starts, and draws only the last ~1.3 s (the kick's settling sets it) on `#liveCv`. Both multiply onto the paper
   (`mix-blend-mode: multiply`), as every ink does, and multiplying is the same in any order. With the Lab open
   everything is drawn live on `#cv` (with Misprint). A mark must stop changing once `lag` has passed, and stay put
   (a hat's trail specks have fixed places), or the strips go stale. Measured (bench, CPU 4x, Incoherent): raf frame
   interval 25.0 -> 16.7 ms median (p95 67 -> 58), JS per frame 14.0 -> 9.1 ms against everything live; stacked and
   live frames differ only on anti-aliased edges. Lab > Frame times shows the real numbers on a device; Lab > Speed
   test (`speedTest`, `SPEED`, the `DBG` switches) plays the next 10 s once per variant (blend modes, grain, glows,
   tilt, shake, all live, half resolution, nothing drawn) and gives a JSON to paste back.
   `node tools/bench_frames.cjs ... '{}' 'http://127.0.0.1:PORT/?live=1&x='` benches the all-live path.

## The JavaScript pipeline

One pipeline in JavaScript (`src/pipeline/`), ported stage by stage from `server/pipeline.py` and checked against it.
It runs in the page on the user's GPU (WebGPU, no key), and on Modal and `server/local.py` under Node. The Python is
kept only as the reference: a change to the analysis is made in the JavaScript alone. Whole-pack parity (pipeline 7,
`python tools/parity_pack.py`, all nine songs from Python's stems): every drum hit matched, notes all matched but one
extra (Invincible), the lyrics identical, bass, tone and widths to float noise, at most one voice or bass frame
different per song; the voice's ear width on the Goldberg aria and Hiroshima differs more (99th percentile 10.4 and
4.9, not traced).

- Plain ES modules with no DOM. `runtime.node.mjs` and `runtime.web.mjs` give them the same things: `session(name)`
  (ONNX Runtime: onnxruntime-node or onnxruntime-web), `pool` (worker threads, `worker.mjs` / `pool.mjs`) and
  `close()`. Nothing is imported by package name: module workers in the browser have no import map, so libraries are
  vendored under `vendor/` (fft.js).
- Models are converted to ONNX by `python tools/export_models.py` into `models/` (git-ignored) and published by
  `python tools/publish_models.py stopamertime/pitchscape-models` to https://huggingface.co/stopamertime/pitchscape-models
  (public, the user's account; `hf auth login` once). The browser runtime fetches from there by default.
  `models/manifest.json` has each file's SHA-256, and the browser keys its Cache API copy on it. Add each new model's
  source and licence to `SOURCES` in publish_models.py (it refuses one without).
- Browser decoding is not ffmpeg's: on a 44.1 kHz MP3 they agree to about -82 dBFS, but on a 22.05 kHz MP3 Chrome's
  output was one MP3 frame (1152 samples) shorter, and the stems then matched Python less closely (down to about
  -66 dBFS). The page plays with the browser's decoder, so a browser analysis matches what is heard.
- `node tools/analyse.mjs SONG --stems DIR [--shifts 0]` runs what exists so far (stems, then drums and notes;
  `--stages notes` picks); `--stems-in DIR --out DIR` starts from stems already made (Python's, to compare a stage on
  the same input). `python tools/parity.py stems|drums|notes|tone [song...]` compares each stage with Python on the test songs (stems: SDR, and
  levels in dBFS, since a near-silent stem has a low SDR however small the difference).
- A model's manifest entry can say `"ep": "cpu"` (set in export_models.py, with the measurement): both runtimes then
  run it on the CPU (Node: CPU provider; browser: wasm) whatever the GPU.
- `resample.mjs` is the shared sample-rate converter: libsoxr itself (the library under librosa's `soxr_hq`, vendored
  as WebAssembly from wasm-audio-resampler 2.0.0, `vendor/soxr.wasm.mjs`), with librosa's output length. On every
  test song's drum stem, 44.1 to 22.05 kHz: 131-133 dB SDR against librosa, largest sample difference 4.8e-7;
  0.2-0.4 s a song on a worker. Use it for every stage's 22.05 kHz signals (`pool.call('./resample.mjs', 'resample',
  [x, 44100, 22050])`).
- Drums (`drums.mjs`, `drums.dsp.mjs`): ADTOF's ONNX file as is (it takes 44.1 kHz audio; madmom's spectrogram is in
  the graph), madmom's peak picking as pipeline.py does it with scipy, drum_details' STFT bands and ring, and
  librosa 0.11's yin for the kick's pitch. Parity on all nine test songs, from Python's drum stem (py-s0): all 9029
  hits matched at the same frame and kind, none missing or extra (7 songs with drums; the piano aria and the guitar
  solo have none on either side); activations bit-identical (ONNX Runtime CPU on both sides); margin, strength and
  ring identical; profiles within 2.2e-5; kick pitch within 0.01 cent on 2161 of 2162 kicks. The one kick off (Nixsia
  126.06 s, 37.6 cents) is float32 noise in the reference: librosa computes yin in the input's float32, and on that
  segment's last frame (half zero padding) it picks 49.2 Hz where librosa in float64 picks 38.0 Hz, as the JS (in
  double) does; the median moves with it. Swapping in Python's 22.05 kHz signal changes nothing that counts (profiles
  within 1.7e-5, the same kick). 8138 of the hits pass the authors' thresholds, also all matched. Speed per song
  (200-240 s, this laptop): ADTOF 1.5-3.9 s on Node's CPU provider (Python's drum_hits 2.9-8.5 s), details 0.3-1.0 s
  on 8 workers (Python 0.2-2.5 s); Chrome, Nixsia: ADTOF 17 s on wasm, single-threaded, since the page is not
  cross-origin isolated (same 965 hits, activations within 2.3e-6).
- Learned: ADTOF's GRUs step one frame at a time, so the GPU is slower: Node's WebGPU provider 39 s, Chrome's
  WebGPU 32 s, against 3.7 s and 17 s on the CPU, for the same hits. scipy 1.17's uniform_filter1d sums each window
  afresh: emulating it with a running sum moved margins by an ulp.
  `python tools/browser_check.py`, then `tools/browser_check.html?song=NAME`, runs the same modules in Chrome.
- Tone (`tone.mjs`, `tone.dsp.mjs`): MOSQITO 1.2.1's roughness_dw and sharpness_din_freq (with loudness_zwst_freq
  and scipy's Butterworth third-octave bands) transcribed line by line, quirks kept; slices in batches of 16 on the
  workers. MOSQITO needs 9600-point FFTs, so `vendor/fft64.wasm` is rustfft 6.4.1 built by `tools/fft64/build.sh`
  (Rust here needs `cargo +stable-x86_64-pc-windows-gnu`: the MSVC linker is missing). `python tools/parity.py tone`:
  a slice every 0.5 s of vocals, bass, other, guitar and piano from Python's stems, all nine songs: 9327 measured
  slices (of 19680; the rest near-silent on both sides), harshness at the defaults (> 0.3) disagrees on 0 of 1900, the
  silence gate on 0, and no slice differs by 0.01 asper or acum. Roughness: median 1e-8 asper, 99th percentile under
  5e-6, largest 2.5e-3 (Fluoride bass at 60 s, 0.1122 against 0.1146, present with Python's own 48 kHz signal, so in
  the port; not traced). Sharpness: largest 4e-6 acum. With Python's 48 kHz stems as input (the port alone)
  sharpness agrees to 2e-12 and roughness to a median of 1e-16; resampling and level alone (JS's 48 kHz stems are
  131-139 dB SNR against librosa's; the gain differs by 1e-7 since numpy takes the mean square in float32) move
  roughness by up to 9e-4. pipeline.tone itself (made-up notes and pitch tracks, guitar solo): the same 541 slices,
  within 5e-6. Speed, 8 workers each: Python's process pool 942 s for the nine songs, JS 70 s (13x); 48 kHz
  resampling 0.8-2.5 s a song. Not yet run in Chrome.
- Notes (`notes.mjs`, `notes.dsp.mjs`): Basic Pitch's own ONNX file (`nmp.onnx` from basic-pitch 0.4.0, the one the
  Python runs) with run_inference's windowing; its note creation (onsets inferred from frames, the melodia trick with a
  tree over frames for the global argmax, pitch bends, model_frames_to_time); then notes_from_stem, raw_bends,
  smooth_bend (scipy's median and Gaussian filters, its summation order), join_bends, note_details (lazy STFT columns,
  runs of notes split over the workers) and the leak dropping. numpy's arithmetic is followed where it shows: means
  by pairwise summation (float32 for Basic Pitch's amplitude), percentile's lerp, interp, and numpy 2's float32
  `abs` of complex64 (`larger * sqrt(fma(r, r, 1))`, not the correctly rounded magnitude: a third of the bins differ)
  and float32 `log` (the AVX2 Remez polynomial, matched on 2M values). `python tools/parity.py notes`, all nine songs,
  Python's stems: with Python's 22.05 kHz signals and one window per model call (the port alone), all 72815 Basic
  Pitch events identical and all 36370 notes matched, 28594 bit-identical and every one within 1e-12 (fade and vibrato
  depth in the last bits: np.convolve's and log10's rounding). As the JS runs (its own resample, 8 windows a call:
  ONNX Runtime's output then moves by up to 1.8e-7), 36366 of 36370 matched, 4 missing and 3 extra, 2 changed family
  and 1 vibrato; 72801 of 72815 events have the same frames, pitch and bends. Those few come from the resample (131 dB),
  not the batching: with Python's signals and 8 a call, Fluoride matched every note and event. Speed on the CPU
  provider, a busy laptop: Python's notes_by_stem 700 s for the nine songs (19-139 s each), JS 126 s (9-20 s; the
  model 101 s of it; decoding and details overlap it on 8 workers). Basic Pitch on Fluoride (222 s): Node CPU 4.7 s
  a stem at 8 a call (12 s one at a time), Node WebGPU 4.1 s for all three (within 1.3e-6, the same notes); Chrome
  WebGPU 0.75 s a stem warm (the whole stage 4.8 s, 5915 notes as Python), wasm 17.4 s a stem. So no `"ep": "cpu"`: on the GPU everywhere.
- Vocals (`vocals.mjs`, `vocals.dsp.mjs`, `tools/export_vocals.py`; pipeline 12): Mel-Band RoFormer (Wang, Lu & Won
  2023), Kimberley Jensen's checkpoint (MIT, https://huggingface.co/KimberleyJSN/melbandroformer), run as its
  inference.py does (8 s chunks every 4 s, reflect-padded ends, linear fades over a tenth of a chunk). Only the network
  is exported: band gather, mask averaging over the bands sharing a bin, the STFT (2048 / 441, centred) and iSTFT
  (its window envelope varies: 441 does not divide 2048) are JS, as for Demucs. For WebGPU the export writes the
  band split, unbind and cat band by band (one op with 60 inputs needs more than a shader's 16 buffers), joined in
  groups of 8, and runs the time attention 10 bands at a time (all 60 at once needed one 2.5 GB buffer; WebGPU allows
  2 GB); the float16 file (462 MB, browser) normalises and counts rotary positions in float32 (RMSNorm's sum of squares
  overflowed float16 on WebGPU: the output came out at 15% of its level; a Range in float16 does not export). Parity on
  Fluoride: JS float32 (Node) against PyTorch float32 SDR 74.2 dB; Node float16 against float32 47.9 dB; Chrome
  float16 (RTX 5080, browser decoder) against Node float32 46.6 dB. Speed, 222 s song: PyTorch CUDA (autocast) 13-18
  s; Node WebGPU float32 55 s of GPU (110 s before grouping the attention), float16 53 s (so Node keeps float32);
  Chrome RTX 5080 float16 59 s. Two chunks a call were slower (147 s) and four ran out of memory: one a call. The
  whole pipeline under Node: Fluoride 160 s (vocals 65 s, Demucs 23 s), Code Monkey 139 s (56 s, 21 s). Speeding it
  up (ONNX Runtime's WebGPU kernels, as was done for Whisper) is open. `tools/browser_vocals.html?song=NAME&ref=DIR`
  runs it in a browser (served by browser_check.py). The Chrome under remote debugging on 9333 runs on the AMD
  integrated GPU: start one with `--force_high_performance_gpu` (and its own `--user-data-dir`) for the RTX.
- Stems so far (htdemucs_6s, all nine test songs, shifts=0 on both sides): 35-75 dB SDR against PyTorch on every
  audible stem, with the difference at or below -75 dBFS. For scale, the pipeline's own random shift moves stems by
  2-22 dB. Chrome on the RTX 5080: a 222 s song in 15 s with the shader cache warm (plus 2.5 s to create the session),
  or 27 s plus 6.5 s cold. The GPU is the limit: 0.34 s per 7.8 s segment, with the STFT on 5+ workers.
- Learned: ONNX Runtime's DirectML provider returns wrong numbers on htdemucs_6s (-32 dB against the CPU provider),
  so Node on Windows uses its WebGPU provider. Chrome with `--user-data-dir` on a Windows 8.3 short path
  (`ADMT9N~1`) cannot open CacheStorage. Port 8770 is refused on this laptop.
- Width (`ear.mjs`, `ear.dsp.mjs`): `ears(st22, gain, segs, leadHz, bassHz, rt)` is Ear, pack_curves and ear_line
  (notes and bass: tone_widths at Ear.level; voice: Ear.widths).
  Each ISO 532-2 band only reaches the grid bins its own coarser FFT lands on, 90 of the 2049, so a pattern is kept
  as those 90 bins (Python: 2049 x frames float32 per stem, enough to run this laptop out of memory once). Each stem
  is cut into runs of frames; a worker makes its run's pattern and measures every width asked for there, so no
  pattern is held whole. Float32 where numpy is (|X| in complex64, the grid's cumsum, the per-ERB level), double
  elsewhere. `python tools/parity.py ear` (Python's notes, voice and bass lines and 22.05 kHz stems as input, made
  once into py-ear-in/), pipeline 7, all nine songs: `where`, bends and holds identical; widths within 1.9e-5
  semitones; after the pack's u8, 1 byte of ~1.5 million differs by one step (0.06 semitones); every earWidth3dB
  median the same. Speed (same input): Python's width stage 9-25 s a song, the JS 0.7-1.4 s on 8 workers. Pipeline 5
  (every width measured on its stem), which the JS matched as closely: Python 85 s / JS 11.2 s on one worker / 1.9 s
  on 8 (Code Monkey); 219 s / 14.9 s / 2.7 s (Nixsia). The STFTs are most of the JS time (~1.3 s a stem on one core).
- Learned: `Math.hypot` allocates in V8 and doubled the pattern's time through GC; a direct DFT of only the kept
  bins was no faster than fft.js.
- Bass (`bass.mjs`, `bass.dsp.mjs`): librosa 0.11's pyin transcribed (YIN in librosa's float32 steps, beta thresholds,
  Boltzmann prior, the voicing HMM), rms, env_follow, Spec / brightness. bass.dsp.mjs also holds helpers the voice
  stage shares: numpy's pairwise sum (bit-identical to np.sum and librosa's rms), np.percentile in float32,
  `stftFrame`, and `viterbiBanded`: librosa.sequence.viterbi's exact decision (first argmax; out-of-band transitions
  log(tiny)) for banded matrices, skipping 16-state chunks whose bound cannot reach the best (rounding is monotonic),
  which takes the decode from 7 s to 3.3 s CPU. `python tools/parity.py bass`, all nine songs, 84631 frames: bassHz
  agrees on 84630 (63515 sounding), 0 cents everywhere except 15 frames of the guitar solo one 10-cent bin apart and
  one frame JS-only; pYIN's raw voicing agrees on 84583 (48 JS-only frames, all under the loudness floor), 32 frames a
  bin apart. bassN is bit-identical given Python's 22.05 kHz signal (3.6e-7 with our resampler). The differences are
  numpy's float32 FFT in the YIN autocorrelation (not reproducible bit for bit): on near-silent or high (near 400 Hz)
  frames a trough lands in the neighbouring bin, e.g. the guitar solo's frame 290 (bin 426 against 427). Speed:
  Python bass_line 29-87 s a song; JS 4.0-8.9 s on Node (machine loaded by other jobs), Chrome 4.2-7.0 s.
- Voice (`voice.mjs`, `voice.dsp.mjs`): CREPE 'full' (`crepe_full.onnx`, torchcrepe 0.0.24's weights; ONNX vs
  PyTorch 1.2e-7), torchcrepe.predict as called (16 kHz soxr, 1024-sample frames every 160, normalised; batches of
  1024 frames each decoded alone by torchcrepe's default decoder, which is Viterbi, not weighted argmax), filter
  median/mean, voice_gate, brightness, librosa onset_strength (mel, power_to_db, flux) and onset_detect. The network
  runs in chunks of 128 frames (256 and 512 were slower on Node WebGPU); frames, decoding, mel and rms on the workers.
  `python tools/parity.py voice`, nine songs, both sides without dither: against PyTorch in float32 (vs_fp32), heard
  frames agree on all 84631, leadHz within 0.001 cents, leadP/leadNz within 6e-6, leadN 2.4e-7, all 4091 librosa
  onsets and all 2754 onsets identical; of 196505 CREPE 10 ms frames 9 differ by a bin (one song, unheard frames).
  Against Python as the pipeline runs it (vs_tf32) heard frames agree on 84627 and 74 CREPE frames differ: PyTorch's
  default TF32 convolutions on the GPU; TF32 against float32 within PyTorch moves the same frames (hey-ruth: 14), and
  JS = PyTorch float32 GPU = PyTorch CPU there. Speed: CREPE network Node WebGPU 6.8-22 s a song vs PyTorch CUDA
  (TF32) 6.2-20 s; Chrome 155 on the RTX 5080 16.8 s (222 s song) and 16.9 s (240 s), stage 18 s; the Claude
  app's browser pane gets the AMD iGPU only: 109 s. `tools/browser_voice.html?song=NAME` runs both stages in a
  browser (served by browser_check.py). voice_line's own choice of 'tiny' on the CPU is not ported.
- Learned: torchcrepe 0.0.24 adds random triangular dither (+-20 cents) to every pitch, so Python's voice pitch is not
  repeatable; the JS dithers the same way by default (`stats.dither = false` to compare). numpy 2 keeps float32 when
  an array meets a Python float (env_follow, thresholds, percentile + 1e-9), so those run in float32 here too. On
  Windows, two servers can listen on the same port (another session's took half the requests): pick a free one.
- Loudness (`loudness.mjs`, `loud.dsp.mjs`, `cqt.dsp.mjs`; pipeline 11, pack 14): librosa 0.11's cqt (vqt with
  gamma 0: per-octave sparse wavelet basis, soxr_hq halving) and decompose.hpss (kernel 31, margin 2, a sliding sorted
  window for the medians) ported; on 30 s of Fluoride's guitar the CQT is within 3.6e-7 of librosa's peak (0.0005 dB
  above -60 dB) and HPSS within 6.3e-7 (not yet in tools/parity.py). Per stem (other, guitar, piano, bass, vocals; a
  worker each): levels in dB below the stem's 99.5th percentile of frame maxima over 72 dB; noise and strikes as heard
  against the loudest sound within +-9 bins (1 at its level, 0 at 36 dB below), smoothed (noise 3 bins x 2 frames,
  strikes 1 x 0.5); per note sample its level (max of 3 bins around the bent pitch) and noise; per frame the stem's
  noise share (+-0.25 s) and its strikes in 11 bands of 8 semitones (only where the loudest sound near is above
  0.4: the Lab's floor); the voice's and guitar's CREPE lines read the same way. `noteCues` (44.1 kHz STFT 4096/512)
  gives each note its echo dB (Klapuri's spectral smoothness: its partial against the lower note's k-1 and k+1, the
  loudest lower note sounding, harmonics 2-8, within half a semitone), rise dB (partials 1-2, frames f0..f0+4 against
  f0-8..f0-3) and the note still ringing at its pitch. Designed by eye in the Contour Lab (spike-timbre/, untracked):
  15 eight-second excerpts, one per instrument, and the Goldberg Aria against its aligned Mutopia score. Fluoride, no
  stems or words stage: 54 s in all; loudness 14 s, guitar CREPE 14 s; the pack 2.2 -> 4.0 MB (strikes 0.7 MB).
  Strikes drawn across their whole band rained across the sheet (drum bleed in every stem, in time with the hats):
  the page prints them only as ticks through notes and lines sounding then. The bass now also goes through Basic Pitch
  (NOTE_STEMS index 3), and CREPE runs on the guitar stem as well (`voice()` on it). MOSQITO's tone stage no longer
  runs (tone.mjs kept for parity_tone). pipeline.py has none of this: the page draws only pack 15 (14's format, pipeline 12's stems).
- Words (`words.mjs`, `tags.mjs`, `align.mjs`): `songInfo(bytes, name, sha)` is song_info with its own tag reader
  (ID3v1/v2, MP3 Xing/LAME/VBRI, MP4, FLAC, Ogg Vorbis/Opus, WAV; FFmpeg 9.0.2's key names and length arithmetic, no
  ffprobe); `lyricsFor(info, dur, vocals44, rt, {aligner = 'en', stats, fetch, log, onAligned})` finds the record as
  lyrics_for does (LRCLIB with header `Lrclib-Client` where a browser forbids User-Agent; find_lyrics, parse_lrc) and
  times each published word by CTC forced alignment to the vocal stem (no Whisper: there is no Python version of this).
  The model (`tools/export_align.py`): `align_en` = torchaudio's WAV2VEC2_ASR_BASE_960H (MIT, 189 MB float16 for the
  browser, `align_en_f32` 378 MB for Node), or `aligner: 'mms'` = MMS_FA (CC BY-NC 4.0, 631 MB / 1.26 GB; romanised
  letters, and text in other scripts needs uroman, not ported, so such words go untimed). Log probabilities per 20 ms
  frame over the whole stem in 25 s windows (20 s kept: one shape for the GPU); torchaudio.functional.forced_align's
  CPU kernel ported (`forcedAlign`; on 300 random cases with repeats and tight lengths every path and score is
  torchaudio's, bit for bit), merge_tokens, and each LRC line aligned in a window from 2 s before its time to 1 s
  after the next line's, between two star tokens (MMS_FA's with_star: a label with log probability 0 that takes the
  audio that is not this line); the median shift of the lines' first words is the LRC's offset, and each line is
  aligned again from 1 s before to 0.5 s after its shifted times. Unsynced lyrics are aligned over the whole song.
  Without the stars a line before a long instrumental spread its words over the whole gap (Dropping Out: 80 s).
  `python tools/parity.py words` (en, Node, against Python's lyrics_for: Whisper medium placed by place_words): the
  same songInfo and LRCLIB record on all nine. Word starts against Whisper's, on the words Whisper heard (the rest it
  interpolates): Dropping Out median 0.14 s, p90 0.60; Fluoride 0.09 / 0.20; Hey Ruth 0.08 / 0.26; Incoherent
  0.08 / 0.22; aligned about 0.04 s earlier. Whisper is not ground truth: to the nearest vocal onset (the voice stage's)
  the aligned starts are a median 0.059 s away (41 % within 50 ms), Whisper's 0.091 s (29 %), no closer than Whisper
  jittered by +-0.15 s (0.096 s). Worst on Dropping Out (parenthesised backing lines, which Whisper mostly did not
  hear either). MMS on the same songs: 0.066 s to the onsets (34 %), a little worse than en on English. Every word
  with a letter gets a time; 96.6-100 % keep it (the rest run backwards across overlapping windows and are spread
  between their neighbours). Speed: Node (WebGPU, float32) 5-6 s of model and 0.1 s of alignment a song (MMS 10-12 s);
  Chrome 155, RTX 5080, float16: 9-11 s warm (float32 15 s, with exactly Node's times; float16 moves 4-7 % of words,
  a few by seconds: Incoherent's worst 4.1 s). Whisper took 38-183 s under Node and 45-174 s in Chrome.
  MMS not yet run in Chrome. `tools/browser_words.html?song=NAME&aligner=en` runs the stage in a browser (served by
  browser_check.py).
- Whisper (`whisper.mjs`, `whisper.dsp.mjs`; no longer called by lyricsFor, kept to compare) is a port of faster-whisper 1.2.1's transcribe and the CTranslate2 parts it calls (Silero VAD v6,
  log-mel, language, the temperature fallback with CTranslate2's beam search and best_of sampling as one batch, the
  logits processors, align's median filter and DTW, word merging), on our own ONNX export (`tools/export_whisper.py`:
  one input per layer for the encoder's keys and values and the cache, and an `order` input that reorders the cache
  for the beams; the decoder graph built by hand, `build_decoder`, checked against a PyTorch transcription to 2.4e-6).
  Medium, as the pipeline: float16 for the browser (715 + 813 MB to download, cached once; cache in float16), float32
  for Node's CPU (ONNX Runtime's CPU provider has no float16 products; onnxruntime-node cannot keep tensors on the GPU,
  so its decoder runs on the CPU). Smaller models time words worse against medium: small and base 3-20 % within 0.1 s,
  0.16-0.3 s early, where medium against itself is 93-100 %.
  Measured while lyricsFor used it (parity.py words then compared Whisper with Whisper), all nine songs, Node:
  songInfo and the LRCLIB record or reason as Python's on all nine (Code Monkey: none at this length). Placed words within 0.1 s of
  Python's: Dropping Out 100 %, Incoherent 100 %, Hey Ruth 83 %, Fluoride 99 % (Python against its own second run:
  100, 100, 100, 95 %). faster-whisper is not repeatable where a window falls back to sampling (Fluoride: four Python
  runs heard 189, 243, 309 and 193 words). Where nothing samples, the port is CTranslate2's to the token: on Fluoride
  and Hey Ruth every greedy window has the same tokens and scores within 0.005 of CTranslate2 float32 on the CPU, and
  Hey Ruth's 4th window loops to 224 tokens and falls back in both, where CTranslate2 float16 on the GPU (the pipeline)
  decodes it cleanly; Chrome's float16 falls back there too. Chrome 155, RTX 5080: Dropping Out (no fallback) same
  record, same matched share, 98 % of heard words within 0.1 s; Hey Ruth and Fluoride the same records. Decoder step,
  medium, Chrome (median, old graph and new alternating in one page): 66-69 -> 43-52 ms for one row, 77-80 -> 44-52 ms
  for five; GPU time 44 -> 23 ms a step. The whole Whisper run on Dropping Out, both in one Chrome session with the
  laptop busy: 60 -> 45 s (decoder 122 -> 105 ms a call: a real call adds the prompt steps and reading the logits).
  Node: 38-183 s a song (decoder on the CPU, 85-107 ms a call; 47-235 s before).
- Learned: a step costs about the same for five rows as for one (beams and best_of go in one batch), but it is GPU
  arithmetic, not dispatch: fusing PyTorch's export into 521 dispatches from 1242 changed nothing. Chrome's profiler
  (session `enableProfiling`, Chrome with `--enable-webgpu-developer-features` or its GPU times are rounded) showed
  where it went: ONNX Runtime's WebGPU matrix product is slow when one token makes a 1024-wide output (1024 x 1024
  84 us, 4096 x 1024 285 us; split along the input into 8 or 4 batched products and summed, 48 and 137 us), casts
  between float32 and float16 (11 ms a step), and MultiHeadAttention's fast path copying the encoder's 1500 keys and
  values at every step (4 ms): so q, k, v come from one product, the cross-attention is plain products, and the cache is
  float16. On the CPU the split makes it slower, so the float32 graph does not split. Slicing one stacked [layers, ...] input copies it on every call (ONNX Runtime's CPU provider spent more on
  that than on the step). An empty cache ([b, heads, 0, dh]) works on WebGPU.

## Versions: bump them together

When the analysis output changes: bump `PIPELINE_VERSION` in `server/modal_app.py` (the deploy writes it into
`docs/config.json`; bump that file too so the page and server agree before the deploy runs), bump the pack `version`
in `src/pipeline/pack.mjs`, and make `current()` in src/page/legacy.js accept only the new pack version (and `segStride` if it
changed). The page draws only current packs; an older one is analysed again (cloud: re-uploaded; local:
`--update-library` re-analyses kept songs). Adding a field the page does not require (as `song` was) needs no bump.

## Editing the page

- The page is `src/page/`, built by Vite (`vite.config.mjs`) into `docs/` (`index.html`, `app/*`, and `pipeline/`
  copied from `src/pipeline`). `npm install` once; `node src/build.js` (= `npm run build`) builds, commit `docs/` with
  the source; `npm run dev` serves it with live reload. The local server builds once when it starts.
  - `index.html`: the static markup (print, controls, Lab). `app.scss`: global styles.
  - Svelte components (Svelte 5, `<style lang="scss">`): `Splash.svelte`, `Progress.svelte` (a song loading, with its
    analysis steps), `Where.svelte` (this computer or the server, and the key). They read `ui` and call `api` in
    `ui.svelte.js`.
  - `legacy.js`: the old page script as one module (drawing, player, Lab), which sets `ui` and fills `api`. It moves
    into components piece by piece.
  - Icons: unplugin-icons, any Iconify set (`import X from '~icons/lucide/x'`; `@iconify-json/lucide` installed).
  - Transitions: Svelte's (`svelte/transition`), with lengths through `motion()` (0 under reduced motion).
  - "This computer" (`analyseHere` in legacy.js) runs `src/pipeline` in a module Worker (`analyse.worker.mjs`); it is
    the default on a computer with a usable GPU that is not a phone or tablet. A first run downloads about 1.7 GB of
    models (Whisper medium is most of it), kept in the Cache API. Chrome, RTX 5080: a 276 s song in 186 s warm,
    Whisper 157 s of it. Every ONNX Runtime call in the browser takes its turn (`turn` in runtime.web.mjs): sessions
    share one wasm instance, and two calls at once corrupted it.
- `dsp.js` is the old in-browser analysis engine; the page now only uses its lyric helpers (`parseLyrics`,
  `alignLyrics`, `alignToAnchors`, `parseLRC`...), `mtof`/`ftom`, `DRUM_BANDS` and the demo song synthesis. Drawing
  always comes from a server pack. `tests/*.js` test that engine (`node tests/engine_test.js`).
- **Lab levers**: add the default to `LAB_DEF` (the model's own setting if it is a cutoff), a row in the right pane
  (copy an existing `.row`: `data-tip` text, the `vh` span, `data-key`), formatting in `labVal`, and add the key to
  `CUTS` if moving it must re-run `applyCuts`. Settings save as a diff from the defaults (`pitchscape:lab`).
- Must fit a 390 x 844 phone with no page scroll; check `prefers-reduced-motion`; system fonts plus self-hosted ones.
- `localStorage`: `pitchscape:key` (server passphrase), `pitchscape:lab`, `pitchscape:tab`. IndexedDB `pitchscape`/`packs`.

## Testing and checking

- Real songs: `tools/fetch_test_songs.sh` → `testsongs/` (nine freely licensed recordings, what each tests in
  `tools/test_songs.json`); `python tools/analyse_test_songs.py [name...]` (CPU; stems kept in `testsongs/stems/`, so
  reruns take ~4-5 min a song instead of ~6); `python tools/preview_server.py` (serves `docs/` with those packs as the
  "server"); `node tools/render_frames.cjs testsongs/X.mp3 OUT 30,60 ['{"thick":"loud"}']` saves phone frames.
- Speed: `node tools/bench_frames.cjs --gpu --mode=raf testsongs/X.mp3` times each layer and the frame (CPU slowed
  4x, about a phone). Use `--gpu`: plain headless Chromium paints the canvas in software, so painting swamps
  everything and points at the wrong layer. Finished strokes are built once and kept (`strokeCache`, `pc.st`); any
  input that shapes them must be in `strokeCacheCheck`'s signature or the print goes stale.
- Look at frames before claiming a visual change works. Measure what you can from the pack (widths, counts, overlaps),
  but check the measurement itself (decode `bytes` as float before arithmetic: uint8 overflows silently in numpy).
- `python tests/route_test.py` exercises the Modal routes with Modal stubbed (needs modal, fastapi, httpx).
- After a push to `server/**`, the deploy workflow's smoke test sends a generated clip through the live server; it
  waits until the server reports the new version (the old container answers for minutes after a deploy).
- Before committing: `node src/build.js`, `node tests/engine_test.js`, `python tests/route_test.py`,
  `python -m py_compile server/*.py tools/*.py`, and `node --check` on each
  `src/pipeline/*.mjs` (`npm install` once for the Node tools).

## Things learned the hard way

- **Basic Pitch**'s own bends are whole contour bins (thirds of a semitone): synthetic tones 15 cents sharp read as in
  tune, 25 cents as 33. Since pipeline 8, `fine_bends` reads the same contour peak to a fraction of a bin (CREPE's
  weighted mean over the peak and 2 bins either side): a median error of 1.5 cents on steady tones, 3 on vibrato; its
  whole bin is Basic Pitch's own on 99.99% of frames. On Fluoride 13-17% of notes sit 5 cents or more off the
  semitone. Basic Pitch reports an in-tune note's bend as +1 bin (1/3 semitone): `BP_BEND_BIAS` removes it. It ends a note
  when a bend crosses a semitone and starts another: `join_bends`. It transcribes distorted guitar as dense chords.
- **Demucs**: the piano stem is the least reliable; stems bleed (a guitar solo leaks into the bass stem). Notes found
  in two stems at the same pitch and time are kept only where much stronger.
- **LRCLIB** answers 503 "busy", sometimes for many seconds: `lrclib()` retries for about a minute, then raises
  `Unreachable` (the page says so). File tags are often wrong ("Code Monkey" tagged artist "spiffworld"); LRCLIB often
  has several records per song (unsynced, other lengths): prefer synced within 3 s.
- **MOSQITO** is slow per frame: measure one slice per note, in parallel. Sharpness is NaN on bass: treat as 0.
  Essentia's dissonance does not agree with MOSQITO roughness (r = 0.01); it was rejected.
- **Excitation widths**: a pure tone's 3 dB band is about one ERB; real voice ~4 semitones, bass ~8, distorted guitar 9+.
  The 186 ms single window smeared attacks into bars; ISO 532-2 multi-resolution windows fixed that.
- **Modal**: a CPU/memory reservation beside the L4 left jobs queued for 13 minutes: none is set. Old containers keep
  answering after a deploy. The tone process pool uses `spawn`, so any script that runs the pipeline needs an
  `if __name__ == '__main__':` guard (or the workers re-run it).
- **Agent shells**: `pkill -f <pattern>` matches your own command line and kills your shell (exit 144); anchor the
  pattern (`pkill -f "^python3 /path/..."`). Background servers started with a relative `cd` die when the shell's
  working directory resets; start them with `setsid nohup` and absolute paths.
- Word overlap and similar visual measurements: count once per frame, not per draw call (a double count once produced
  a false "1 in 20 overlap" claim).

## Open threads (as of pipeline 7)

- Ear widths are the default thickness. Notes (pipeline 6) and bass (pipeline 7) get a pure tone's width at their
  pitch and their stem's level within one ERB (`tone_widths`, `Ear.level`); only the voice is measured on its stem.
  Why: a polyphonic stem gave every note the chord's width (medians 12-15 semitones at 3 dB, now about 3). The bass
  measured 17-21: the ear model itself (6.5-12.5: at 35 Hz an ERB is about an octave), the analysis window's spread
  (3-6, a steady sine at 41 Hz measures 4.5 wider than the model) and the bass's octave, as loud as its note (5-8, up
  to the 16-semitone cap); the kick added ~2.5 on kick frames in one song, glides nothing. Now 7-9 (12.6 at 35 Hz).
  Pipeline 7 also reads every ISO band at least once per page frame: the 64 ms band's 705-sample hop left a quarter
  of the frames empty below 80 Hz.
- Discussed, not built: lead vs backing vocals via a karaoke separation model (e.g. Mel-Band RoFormer karaoke through
  `audio-separator`), backing harmonies via Basic Pitch on that stem, bracketed LRCLIB lines placed on the backing line;
  following Spotify playback by ISRC (the pack's `song`); AcoustID fingerprints for files without tags.
- Legacy: `tools/add_song.sh`, `align.py`, `build_pack.js` and friends built packs for songs published with the page
  (the page no longer loads them). They predate the server and are not part of the current flow; nor are dsp.js's
  pasted-lyrics, tap-along and LRC helpers, which the page stopped using when lyrics pasting went.
