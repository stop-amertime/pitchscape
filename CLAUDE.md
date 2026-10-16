# Pitchscape: notes for agents

Read this before changing anything. README.md is the user-facing reference (data formats, measured results, setup);
this file is the why, the flow, and what has been learned the hard way.

## What it is

A phone-friendly music visualiser in a risograph print style. A song is analysed once by a server (stems, drums,
notes, bass, voice, tone, width, lyrics) into a **pack** (JSON); the page plays the song and draws the pack as a
scrolling print: time runs right to left past a "now" line, pitch runs up the screen, each instrument in its own ink.

- Page: `src/page/` (Vite + Svelte, + `src/dsp.js`), built to `docs/`, served by GitHub Pages
  (https://stop-amertime.github.io/pitchscape/ redirects to `docs/`).
- Cloud server: Modal (`server/modal_app.py`), GPU (L4), running `server/pipeline.py`.
- Local server: `server/local.py` (`Pitchscape.bat` on Windows) runs the same pipeline and serves the page.

## The principle: it should look to the eye the way it sounds to the ear

Every visual property is a **measured property of the sound**, produced by an **established, published model or
library**, not a mapping or heuristic we made up. When a choice feels arbitrary, it probably is: find what the
sound (or the ear) actually does and draw that.

| What you see | What it is | Measured by |
| --- | --- | --- |
| height | pitch, on a log axis fitted to the song's range | CREPE (voice), pYIN (bass), Basic Pitch (notes) |
| a note's path | its pitch through time, bends and vibrato included | Basic Pitch's per-frame pitch bends |
| colour | which instrument (stem), warm inks for what is out front | Demucs htdemucs_6s stems |
| thickness | how wide the sound spreads along the ear (excitation pattern) | Glasberg & Moore roex filters, ISO 532-2 resolutions |
| ink density across the stroke | solid within 1 dB of the excitation peak, lighter to 3 dB, haze to 10 dB | same |
| ink strength along the stroke | loudness, and for struck notes their measured fade | stem RMS, measured decay |
| edge: smooth ripple to sawtooth | harshness = roughness + sharpness | MOSQITO (Daniel & Weber roughness, DIN 45692 sharpness) |
| drum marks | each hit, its kind, its own spectrum and ring | ADTOF drum transcription on the drum stem |
| words | the published lyrics, placed when and roughly where they are sung | LRCLIB text, Whisper word timings |

Corollaries the user has stated or endorsed:

- **No fallbacks or stand-ins.** If data is missing, show nothing (or say so), never a substitute that looks like data.
  An old pack is analysed again, not drawn with defaults; no lyrics from LRCLIB means no words, never Whisper's
  transcription.
- **No baked-in cutoffs.** Thresholds (detector certainty, quietest, shortest, where harshness starts...) are Lab
  levers whose defaults are the model's own settings; the server sends certainties down to a floor and the page cuts.
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
4. **Pipeline** (`pipeline.analyze`), in order (each `progress('<stage>: ...')`):
   - `stems`: Demucs htdemucs_6s → drums, bass, other, vocals, guitar, piano.
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
   with edge wave from harshness), `smudge` (bass and kick as soft dabs on their own layer), `pen` (dot at "now").
   Snare, hats and cymbals print in a strip along the top (`BEAT_H`); toms and kicks on the sheet at their pitch.

## The JavaScript pipeline (in progress)

Agreed direction: one pipeline in JavaScript (`src/pipeline/`) replaces `server/pipeline.py`. It runs in the page on
the user's GPU (WebGPU, no key), and on Modal under Node for phones. The Python stays only as the reference it is
checked against. Stages are ported one by one; until all are in, the Python pipeline is the one in use.

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
- Stems so far (htdemucs_6s, all nine test songs, shifts=0 on both sides): 35-75 dB SDR against PyTorch on every
  audible stem, with the difference at or below -75 dBFS. For scale, the pipeline's own random shift moves stems by
  2-22 dB. Chrome on the RTX 5080: a 222 s song in 15 s with the shader cache warm (plus 2.5 s to create the session),
  or 27 s plus 6.5 s cold. The GPU is the limit: 0.34 s per 7.8 s segment, with the STFT on 5+ workers.
- Learned: ONNX Runtime's DirectML provider returns wrong numbers on htdemucs_6s (-32 dB against the CPU provider),
  so Node on Windows uses its WebGPU provider. Chrome with `--user-data-dir` on a Windows 8.3 short path
  (`ADMT9N~1`) cannot open CacheStorage. Port 8770 is refused on this laptop.

## Versions: bump them together

When the analysis output changes: bump `PIPELINE_VERSION` in `server/modal_app.py` (the deploy writes it into
`docs/config.json`; bump that file too so the page and server agree before the deploy runs), bump the pack `version`
in `pipeline.analyze`, and make `current()` in src/page/legacy.js accept only the new pack version (and `segStride` if it
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
  - "This computer" is offered only once every stage is in `src/pipeline` (`HERE_READY` in legacy.js); `?here` turns
    it on to try.
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

- **Basic Pitch** reports an in-tune note's bend as +1 bin (1/3 semitone): `BP_BEND_BIAS` removes it. It ends a note
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

## Open threads (as of pipeline 5)

- Ear widths are the default thickness; the user is choosing between ear (with or without faint edges) and loudness
  after seeing comparisons across genres.
- Discussed, not built: lead vs backing vocals via a karaoke separation model (e.g. Mel-Band RoFormer karaoke through
  `audio-separator`), backing harmonies via Basic Pitch on that stem, bracketed LRCLIB lines placed on the backing line;
  following Spotify playback by ISRC (the pack's `song`); AcoustID fingerprints for files without tags.
- Legacy: `tools/add_song.sh`, `align.py`, `build_pack.js` and friends built packs for songs published with the page
  (the page no longer loads them). They predate the server and are not part of the current flow; nor are dsp.js's
  pasted-lyrics, tap-along and LRC helpers, which the page stopped using when lyrics pasting went.
