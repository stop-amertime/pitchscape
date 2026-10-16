# Pitchscape: notes for agents

Read this before changing anything. README.md is the user-facing reference (data formats, measured results, setup);
this file is the why, the flow, and what has been learned the hard way.

## What it is

A phone-friendly music visualiser in a risograph print style. A song is analysed once by a server (stems, drums,
notes, bass, voice, tone, width, lyrics) into a **pack** (JSON); the page plays the song and draws the pack as a
scrolling print: time runs right to left past a "now" line, pitch runs up the screen, each instrument in its own ink.

- Page: `src/app.html` (+ `src/dsp.js`), built to `docs/index.html`, served by GitHub Pages
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
- The screen is only the print. Controls appear on tap and fade; Song / Lyrics / Lab open as panels below the print.

## The flow, end to end

1. **Load** (`openSong` in app.html): the page hashes the file (SHA-256) and looks for its analysis: IndexedDB
   (`pack:<pipeline>:<sha>`), then `GET /packs/<sha>`.
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
- Models are converted to ONNX by `python tools/export_models.py` into `models/` (git-ignored; where they are hosted
  is not settled yet). `models/manifest.json` has each file's SHA-256, and the browser keys its Cache API copy on it.
- `node tools/analyse.mjs SONG --stems DIR [--shifts 0]` runs what exists so far (stems).
  `python tools/parity.py stems [song...]` compares each stage with Python on the test songs (SDR, and levels in dBFS,
  since a near-silent stem has a low SDR however small the difference).
  `python tools/browser_check.py`, then `tools/browser_check.html?song=NAME`, runs the same modules in Chrome.
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
in `pipeline.analyze`, and make `current()` in app.html accept only the new pack version (and `segStride` if it
changed). The page draws only current packs; an older one is analysed again (cloud: re-uploaded; local:
`--update-library` re-analyses kept songs). Adding a field the page does not require (as `song` was) needs no bump.

## Editing the page

- Edit `src/app.html` / `src/dsp.js`, then `node src/build.js` (writes `docs/index.html`; commit both). The local
  server builds from `src/` on each load, so no build step there.
- `dsp.js` is the old in-browser analysis engine; the page now only uses its lyric helpers (`parseLyrics`,
  `alignLyrics`, `alignToAnchors`, `parseLRC`...), `mtof`/`ftom`, `DRUM_BANDS` and the demo song synthesis. Drawing
  always comes from a server pack. `tests/*.js` test that engine (`node tests/engine_test.js`).
- **Lab levers**: add the default to `LAB_DEF` (the model's own setting if it is a cutoff), a row in the right pane
  (copy an existing `.row`: `data-tip` text, the `vh` span, `data-key`), formatting in `labVal`, and add the key to
  `CUTS` if moving it must re-run `applyCuts`. Settings save as a diff from the defaults (`pitchscape:lab`).
- Must fit a 390 x 844 phone with no page scroll; check `prefers-reduced-motion`; system fonts plus self-hosted ones.
- `localStorage`: `pitchscape:key` (server passphrase), `pitchscape:lab`, `pitchscape:lyrics:<song>` (pasted lyrics
  win over the server's). IndexedDB `pitchscape`/`packs`.

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
  `python -m py_compile server/*.py tools/*.py`, a syntax check of the built script, and `node --check` on each
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
  (`SONGS` in app.html, now empty). They predate the server and are not part of the current flow.
