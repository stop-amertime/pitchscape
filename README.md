# Pitchscape

A phone-friendly music visualizer. It splits a song into layers (bass, kick, snare, hats, voice, other notes)
and prints each one in its own risograph-style ink on a scrolling sheet. Height is pitch. The shape of each stroke
follows the sound's tone: smooth edges for pure tones, sawtooth edges for bright or buzzy ones, speckle for breath and
noise. Ink strength follows loudness, so quiet passages print pale and thin. Lyrics can be pasted in and are printed
along the voice line, at the moment and pitch each word is sung.

It started life as a claude.ai artifact, where large models could not load, so it grew its own lightweight analysis
engine (`src/dsp.js`) that ran on the phone. Songs are now analysed on a server with established models (`server/`),
and the page draws nothing until that analysis is in: the in-browser engine was too often wrong to show. The page still
uses it for lyric placement and the demo song's audio; the tests and benches below still measure it.

## What's here

```
docs/                     the site (GitHub Pages can serve this folder as-is)
  index.html              built page: engine + renderer, no build step needed to view
src/
  dsp.js                  analysis engine (pure JS, no DOM). Runs in a Web Worker in the page and in Node for tools/tests
  app.html                page template: layout, canvas renderer, lyrics, playback
  build.js                inlines dsp.js into app.html and writes docs/index.html
tools/                    pipeline for adding a song with real stems and word timing (Python + Node)
tests/engine_test.js      renders the synthetic demo song and scores the engine against its ground truth
tests/bass_bench.js       bass line accuracy on synthetic clips: four bass sounds over drums and chord pads
tests/inst_bench.js       note families, vibrato and hollow tone on synthetic instruments
tests/real_bass.js        bass line accuracy on a real song against a pYIN reference (tools/pyin_ref.py)
tests/drum_bench.js       drum hit accuracy: a synthetic piano-intro clip, plus (given Demucs stems) false hits found
                          in stems with no drums and full-mix hits against the isolated drum stem
tests/drum_check.js       per-hit ring time and spectrum on the demo song and an open/closed hat clip
```

## Run it

The page fetches its song files, so serve it over HTTP rather than opening the file directly:

```
cd docs && python3 -m http.server 8000      # then open http://localhost:8000
```

After editing anything in `src/`, rebuild: `node src/build.js`.

## Host it on GitHub Pages

Push the repo, then in the repo settings under Pages choose "Deploy from a branch", branch `main`, folder `/docs`.
The site is fully static. Commercial audio stays out of this public repo (`.gitignore` blocks `*.mp3`, `*.m4a` and
`docs/*.pack.json`): the built-in song is the synthetic demo, and you load your own songs from your device.

## The analysis server

`server/pipeline.py` turns a song into a pack using established, trained models; `server/modal_app.py` runs it on a
GPU at [Modal](https://modal.com) behind a small upload API, and `.github/workflows/deploy-server.yml` deploys it on
every push to `main` that touches `server/`.

| Layer | Model | Licence |
| --- | --- | --- |
| stems | Demucs htdemucs (Meta) | MIT |
| drums: kick, snare, toms, hi-hat, cymbals | ADTOF Frame_RNN (Zehren, Alunno, Bientinesi), via `thebluescreen/adtof-drums-onnx` | CC BY-NC-SA 4.0, non-commercial |
| notes | Basic Pitch (Spotify) | Apache-2.0 |
| bass line | pYIN (librosa) | ISC |
| voice line | CREPE (torchcrepe) | MIT |
| words | Whisper (faster-whisper) | MIT |

The pipeline only wires these together and measures plain properties of what they found (loudness, brightness, how
long a hit rings, how a note starts and fades). On Made in the Dark, ADTOF found no drum hits at all in the stems that
hold no drums (the old in-browser detector found hundreds there: piano read as hats, voice read as snares), and on the
full mix 99% of its snares, 93% of its hats and 84% of its kicks matched the hits it found in the isolated drum stem.
Whisper's word starts landed within 0.3 s of the forced-alignment reference for 84% of words (small model, CPU).

Run it locally (Python 3.11, ffmpeg): `python -m server.pipeline SONG.mp3 OUT.json` (`--stems DIR` reuses Demucs stems).
Deploying needs three repository secrets: `MODAL_TOKEN_ID` and `MODAL_TOKEN_SECRET` (a token from
modal.com/settings/tokens) and `PITCHSCAPE_PASSPHRASE` (any phrase; the page asks for it once, so strangers cannot spend
the GPU credit). The workflow writes the server's address to `docs/config.json`, which the page reads.

In the page, put the passphrase in Lab → Server key once. A song is known by the SHA-256 of its file. If its analysis
exists, on the device (IndexedDB) or on the server (a JSON file per song in a Modal Volume, kept for good; the first TiB
a month is free), it loads at once. Otherwise it is uploaded, the sheet shows each stage of the analysis, and the song
plays once the analysis is in (with the words Whisper heard, unless you have placed lyrics for that song yourself).
The demo song goes the same way: rendered on the phone, then analysed once like any other song. Both stores are keyed by `PIPELINE_VERSION` in
`server/modal_app.py` as well: bump it when the analysis changes and songs are analysed afresh. The audio itself is
never kept. After each deploy the workflow sends a generated 12-second clip through the live server
(`server/smoke_test.py`).

## How it works

**In the browser (no longer drawn; kept for lyric placement and the benches):** `src/dsp.js`
1. Mid/side split and resample to 22,050 Hz. STFT with a 2048 window and 512 hop (23 ms per frame).
2. Harmonic/percussive separation by median filtering (time medians keep sustained tones, frequency medians keep hits).
3. Drums: onset detection on percussive energy in three bands (kick 35 to 140 Hz, snare 0.8 to 5 kHz with a noisiness
   check, hats above 5 kHz), with rules so one hit isn't counted in two bands.
4. Bass: the STFT's 10.8 Hz bins are coarser than a semitone below about 180 Hz, so the bass is tracked in the time
   domain instead: YIN's normalised difference on a copy low-passed at 420 Hz and decimated to 2,756 Hz. A song reuses
   one kick drum, and its boom is a low sine that reads as a bass note, so the boom's pitch is learned from the most
   common pitch just after strong kicks and notched out first. The line is then chosen across the whole song (Viterbi
   over semitones plus "no bass"), with frames under a kick trusted less and, among notes that fit almost equally
   well, the highest preferred, since anything periodic also repeats at 2x and 3x its period.
5. Voice / lead: harmonic-sum pitch tracking from 123 Hz to 1 kHz on the harmonic part, weighted toward the centre of
   the stereo image, with bass harmonics damped. Frames are grouped into runs and runs are judged as a whole (runs that
   follow the bass line's notes are rejected, octave slips repaired, short stray runs dropped). For display, short dips
   inside a phrase are bridged and line ends follow the voice as it fades.
6. Other notes: spectral peaks folded so overtones don't count as notes, followed frame to frame by nearest pitch (so
   vibrato stays one note), and walked back through quieter frames to where each note really began. Each note is then
   judged as a whole: attack time (to 75% of its peak), fade rate (dB/s, measured 60% of the way from peak to end so a
   release tail doesn't count), vibrato depth and rate, and hollowness (odd harmonics only). From those it gets a
   family: swell (attack 0.12 s or longer: pads, bowed strings), struck (fades faster than 9 dB/s, or shorter than
   0.35 s: piano, guitar, plucks, stabs), or held (organ, leads, brass). Each family prints in its own ink and shape.
7. Tone features for drawing: brightness (upper-harmonic share), noisiness (energy between harmonics).

**Song packs (tools/):** for songs that matter, the heavy lifting happens offline. Demucs separates real stems, the same
engine analyses each stem separately (voice from the vocal stem, hits from drums, bass from bass, notes from other), and
every lyric word is placed with wav2vec2 forced alignment on the isolated vocal. The page loads the result instantly.

**Lyrics:** paste plain lyrics or a whole lyrics web page (`cleanPastedLyrics` keeps just the lyric lines). Placement:
- Song pack with timing: each pasted line is matched to the timing by a fingerprint (`lineHash`), so stray lines and
  repeated choruses work. Exact.
- Otherwise `alignLyrics`: dynamic programming that places syllables on detected voice onsets, with line starts
  preferring pauses. Good on clean vocals, unreliable on dense mixes.
- Tap along: the user taps as each line starts, then words inside each line are placed with the same method.
- `.lrc` files (line stamps, and word stamps if present) and timing JSON files can be loaded.
Lyrics are saved per song in localStorage. The pack and the page contain no lyric text.

## Add a song with stems and word timing

Needs Python 3, Node 18+, ffmpeg, and about 3 GB disk for models:

```
pip install torch torchaudio --index-url https://download.pytorch.org/whl/cpu
pip install demucs soundfile
tools/add_song.sh path/to/song.mp3 path/to/lyrics.txt my-slug "Title" "Artist"
```

Steps (times measured on a 3-minute song, 2 CPU cores):
1. `separate.py`: Demucs htdemucs stems (about 2.5 min).
2. `prepare_lyrics.js`: cleans and splits the lyrics exactly the way the page does.
3. `check_line_order.py` (only if `OPENROUTER_API_KEY` is set): asks an audio model which line is sung when, and reports
   whether the sung order matches the written lyrics. Its timestamps were up to 3.4 s off on the test song, so they are
   used only as a check. If the order differs (extra chorus repeats, say), put the lyrics file in sung order and rerun.
4. `align.py`: wav2vec2 CTC forced alignment of all words in one pass (about 1 min, plus a one-time 1.2 GB model
   download).
5. `repair_timing.py`: moves any word whose span reaches back across a silence to where the voice resumes.
6. `build_pack.js`: writes `docs/<slug>.pack.json`. The script prints the two lines to add in `src/app.html`
   (an entry in `SONGS` and a shelf button); the first entry in `SONGS` loads when the page opens.

## The Lab

The screen shows nothing but the print. Its controls (play, seek, and Song, Lyrics and Lab) float over its foot
while they are wanted, fade a few seconds into playing, and come back with a tap. Song, Lyrics and Lab each open as a
panel below the print, which shrinks to sit above it; the page itself never scrolls. Song holds the file picker, the
demo and the server key, which shows as a line once saved, so the keyboard only comes up when you choose to change it.
The Lab's A/B switches sit in tabs (Colour, Shapes, Words, Motion, Print, Layers), each with an explanation that pops
up in a bubble from its label. Only settings changed from the defaults are kept on the device (`localStorage` key
`pitchscape:lab`), so a new default reaches anyone who left that setting alone. Colour by instrument (drums share one
ink, tuned notes share warm inks), by height (the pitch axis, low blue to high pink, whatever made the sound) or by
note name (circle-of-fifths colours; drums keep the drum ink). Palette, for colour by instrument, all real riso inks:
Rainbow (an ink each), Warm and cool (the tune in warm inks, the backing in cool), Three inks (pink voice, blue bass and
keys, sunflower pads, pale pink leads, black drums and words) or Two inks (the same with pale blue pads), where shared
inks overlap and mix as on a real print. Drum marks that follow each hit's sound (spikier when brighter, trailing
while it rings) or all alike. Kick as a soft smudge or a halftone thud; bass as a soft smear or a sharp line. Word face
(grotesque, script, serif, mono), sized and weighted by how loudly each word was sung, or fixed. Sliders for shake, tilt
(CSS 3D: the sheet tips back on kicks and sways with the bass), glow, misprint (each ink jumps out of register on
kicks), seconds on screen, ink strength, thickness and speckle (paper showing through the ink). Layers lifts any kind
of sound off the print.

Every line that is sounding has a round pen tip where it is being printed. Each drum prints one compact mark per hit,
where the hit is loudest: a kick as a soft thud at its boom, a tom as a round drop at its note, a snare as a spiky
splat at its crack, a hat as a tight fleck and a cymbal as a fine spray at their sizzle.

## Data formats

- **Pack** (`*.pack.json`): `{format: "song-overprint-pack", version, segStride, title, artist, audio, dur, dt, frames,
  stereo, noiseRef, arrays, timing}`. `arrays` holds base64 little-endian Float32Arrays: per-frame `bassN, bassHz, bassBr,
  leadHz, leadN, leadBr, leadNz`; `events` as `[time, type (0 kick, 1 snare, 2 hat), strength, Hz]` x n;
  `events` from version 3 as `[time, type, strength, Hz, ringSeconds, band0..band15]` x n (`eventStride` 21): the hit's own
  spectrum (what each of 16 log-spaced bands from 30 Hz to 11 kHz gained over the frames before it, each drum type
  limited to its own region), how long it rings (until its band falls 14 dB), and for kicks the pitch of the boom;
  `segs` as `[t0, t1, midi, amp, brightness, noise, family, attack, fadeDbPerS, vibratoDepth, vibratoHz, hollowness]` x n
  (version 2, `segStride` 12; version 1 packs have the first six only and print in the old single orange style); `onsets` as `[time, gapBefore, runEnd, strength]` x n.
- **Timing** (`song-overprint-timing`): `{lines: [{h, t, e, words: [startSeconds, ...]}]}`, one entry per sung line in
  sung order. `h` is `lineHash(line)`: FNV-1a 32-bit over the line lowercased with accents, punctuation and spaces
  removed, in base 36. Word lists follow the page's own word split (`parseLyrics`).

## Measured performance

- Demo song (synthetic, known ground truth): kicks 100% found, snares 100% found with some extras on sung consonants,
  hats about 79%, voice found in 99% of sung notes with a median pitch error of 0.05 semitones, bass pitch right in 94%
  of note frames (49% before the time-domain tracker), auto-placed lyrics median error 0.07 s. Run
  `node tests/engine_test.js`.
- Bass bench (synth, finger, square and 808 basses over drums and pads): pitch right in 79% of note frames, was 44%.
- Bass on Made in the Dark, against pYIN on the isolated bass stem: 86% agreement on the stem (was 29%, with 27% octave
  errors) and 74% on the full mix (was 16%). pYIN is a YIN-family tracker too, so treat this as agreement, not truth.
- Instrument bench (piano, guitar, organ, strings, pad, clarinet-like lead, each over drums and bass, as a separated
  stem): note family right for 95% of note time; vibrato and hollow tone right on every instrument except guitar
  (92% for vibrato). In a full mix a solo instrument carrying the main melody usually becomes the voice / lead line instead.
- Made in the Dark (real song, word timing as reference): on the isolated vocal stem the voice line covers about 70%
  of sung time with no false detections. On the full mix in the browser it covers only about 35% and auto-placement of
  lyrics fails. That gap is why packs exist.
- Analysis speed in the browser: about 0.6 s per 30 s of audio on a laptop; phones are a few times slower.

## What hosting outside claude.ai unlocks

- The file picker works in normal browsers (it may not inside the Claude app's viewer).
- The page can call OpenRouter directly (it allows browser requests) with a key the user pastes in and keeps in
  localStorage. Don't commit a key to a public repo, since anyone could read it from the page.
- A small backend (serverless function, Hugging Face Space, Modal) could run `tools/` on uploaded songs, so any song
  gets stems and word timing without the manual step.

## Ideas, roughly by impact

1. Chords: name the chord under each beat from the notes and bass, printed small along the top like a lead sheet.
2. Instrument identity within "other notes": a small audio-tagging model to tell guitar, keys, strings and synth apart,
   each with its own mark family.
3. Song structure: detect repeated sections and print repeats with the same layout; a poster mode that prints the whole
   song as one long sheet to save.
4. Beat grid: lock the scroll to the tempo with faint bar lines, land the shakes on downbeats.
5. Separation in the browser (an ONNX/WebGPU source separation model) for songs without a pack: a big download and slow
   on phones, so probably better as the backend above.
