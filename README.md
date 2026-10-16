# Pitchscape

A phone-friendly music visualizer. It splits a song into instruments (voice, guitar, piano, bass, drums and the
rest) and prints each in its own risograph-style ink on a scrolling sheet. Height is pitch. Colour says which
instrument, warmer the more it is out front; shape says how each note is played (struck, swelling, held); the edge says
how it sounds, smooth unless it was measured harsh (rough or sharp), and speckle shows breath and noise. Ink strength follows loudness, so quiet passages print pale and thin. The song's published lyrics are printed
along the voice line, at the moment and pitch each word is sung.

It started life as a claude.ai artifact, where large models could not load, so it grew its own lightweight analysis
engine (`src/dsp.js`) that ran on the phone. Songs are now analysed on a server with established models (`server/`),
and the page draws nothing until that analysis is in: the in-browser engine was too often wrong to show. The page still
uses it for lyric placement and the demo song's audio; the tests and benches below still measure it.

## What's here

```
docs/                     the site (GitHub Pages can serve this folder as-is)
  index.html, app/        the built page (Vite); pipeline/ is src/pipeline copied beside it
src/
  page/                   the page: Vite + Svelte (Splash, Progress, Where), app.scss, legacy.js (renderer, player, Lab)
  pipeline/               the analysis in JavaScript (in progress), run in the page and under Node
  dsp.js                  old analysis engine (pure JS, no DOM); the page uses its lyric helpers and demo song
  build.js                builds the page into docs/ (same as npm run build)
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

To change the page: `npm install` once, then `npm run dev` (live reload) and `npm run build` (writes `docs/`).

## Host it on GitHub Pages

Push the repo, then in the repo settings under Pages choose "Deploy from a branch", branch `main`, folder `/docs`.
The site is fully static. Commercial audio stays out of this public repo (`.gitignore` blocks `*.mp3`, `*.m4a` and
`docs/*.pack.json`): the built-in song is the synthetic demo, the splash offers a few freely licensed songs by link (archive.org), and you
load your own from your device or a link to the audio file.

## The analysis server

`server/pipeline.py` turns a song into a pack using established, trained models; `server/modal_app.py` runs it on a
GPU at [Modal](https://modal.com) behind a small upload API, and `.github/workflows/deploy-server.yml` deploys it on
every push to `main` that touches `server/`.

| Layer | Model | Licence |
| --- | --- | --- |
| stems: vocals, drums, bass, guitar, piano, other | Demucs htdemucs_6s (Meta) | MIT |
| drums: kick, snare, toms, hi-hat, cymbals | ADTOF Frame_RNN (Zehren, Alunno, Bientinesi), via `thebluescreen/adtof-drums-onnx` | CC BY-NC-SA 4.0, non-commercial |
| notes, read from the guitar, piano and other stems separately | Basic Pitch (Spotify) | Apache-2.0 |
| bass line | pYIN (librosa) | ISC |
| voice line | CREPE (torchcrepe) | MIT |
| tone: roughness (Daniel & Weber) and sharpness (DIN 45692) | MOSQITO (Eomys) | Apache-2.0 |
| lyrics: the song's published words | LRCLIB (lrclib.net), found by the file's tags or an "Artist - Title" file name | free API, no key |
| when each of those words is sung | Whisper (faster-whisper), read from the vocal stem | MIT |

Colour by instrument comes from the stems, so an instrument keeps its ink for the whole song, warmer the more it is
out front: voice fluorescent pink, guitar orange, piano sunflower, the other stem's notes (synths, strings, brass,
organ) teal in three shades by how each is played (darkest held, middle struck, palest swelling), bass blue, drums
black, words a deep wine. Demucs' piano stem is the least reliable of the six. Notes that turn up in two stems at the
same pitch and time stay only where they are much stronger. Tone is measured with MOSQITO on each note's own stem
(one 200 ms slice early in the note, shared by notes of the same stem in the same slice) and on the voice and bass every
half second, after setting the whole mix to 70 dB SPL so harshness is absolute rather than relative to the song:
roughness counts above 0.1 asper, sharpness above 1.75 acum, and together they make a note's edge anything from a
faint smooth ripple to a sawtooth. The slices run in parallel on the server's eight CPU cores.

Every note is drawn along its own pitch as it bends, the way the voice is: Basic Pitch reports each note's bend frame
by frame (in thirds of a semitone; it reads an in-tune note one third high, which is taken off), and the pipeline keeps
that curve, smoothed, instead of one pitch per note. Basic Pitch ends a note when a bend carries it into the next
semitone and starts another there, sometimes after losing it for a few frames; a note that starts within 0.15 s of
where one on another pitch ended, within three quarters of a semitone of the pitch that one had bent to, is joined back
onto it, so a bent guitar note prints as one stroke. A plain step to the next semitone (a whole semitone) and a note
struck again at the same pitch stay separate notes. On a synthetic plucked note bent up a whole tone, held, released and
then wobbled, Basic Pitch gave 11 fragments; joined, they are one stroke within 0.35 semitone of the true bend
throughout. On Made in the Dark, whose guitar barely bends, 3 of 766 guitar notes were joined.

**Thickness is how wide the ear hears each sound**, not a choice of ours. For every voice frame the pipeline works
out the sound's excitation pattern on its own stem: the stem's spectrum, set to its level in a 70 dB SPL mix and read
at ISO 532-2's resolutions (windows from 64 ms below 80 Hz to 2 ms above 4 kHz, each read at least once per frame),
passed through Glasberg & Moore's roex auditory filters, whose lower skirts flatten as the level rises. It sends how
far below and above the sound's pitch the excitation stays within 1, 3 and 10 dB of its peak (stopping where it rises
again towards a neighbour). Notes and the bass are given the excitation of a pure tone at their pitch (bends
included) and at the level their stem has within one ERB of it: the textbook roex response, 0.9 ERB at 3 dB for 440 Hz
at 60 dB. A note's stem (guitar, piano, the rest) usually holds a whole chord, and its spectrum cannot say which part
is the note's: measured that way every note took the chord's width (a median of 12-15 semitones at 3 dB, walls of
spikes). A bass's octave is often as loud as its note, and so low the two merge along the ear; with the analysis
window's own spread its measured width filled 17-21 semitones, a fog. The page prints all of it as ink: solid within
1 dB, lighter to 3 dB, a faint haze to 10 dB, each band eased over about 160 ms. So low sounds are wide and high ones
narrow (at 35 Hz one auditory filter spans about an octave); loud sounds spread upward; a voice's breath, noise and
wavering pitch are wider, because its own spectrum is. On the test songs the 3 dB band's median is 4-6 semitones for
the voice, about 3 for notes, and 7-9 for bass guitar (12.6 for a 35 Hz synth bass). The Lab's Print tab can switch back to thickness from loudness, and set how strongly the faint bands print.

**No cutoff is baked in.** Every threshold that decides whether something prints is applied by the page, from the
Lab's Cutoffs tab, so it can be tried on a song without analysing it again. The server finds things down to a floor
(the far end of each lever) and sends how sure each detector was or how loud each sound was; each lever starts at the
detector's own setting:

| Lever | What it cuts | Default (the model's own) | Server floor |
| --- | --- | --- | --- |
| Voice certainty | CREPE periodicity per frame | 0.45 | 0.15 |
| Voice quietest | vocal loudness, share of its loud level | 4% | 1% |
| Voice shortest | runs of sung frames | 90 ms | none |
| Bass quietest | bass loudness (whether a bass note sounds at all is pYIN's own decision over the line) | 8% | 2% |
| Note hold | Basic Pitch's frame by frame certainty that a note still sounds; dips under 0.13 s are bridged, as Basic Pitch does | 30% | 15% |
| Note shortest | note length | 100 ms | 50 ms |
| Drum certainty | multiple of ADTOF's per-drum thresholds each hit passed | 1x | 0.6x |
| Rough from / Sharp from | where harshness starts (MOSQITO roughness, sharpness) | 0.1 asper / 1.75 acum | none |
| Line break | a voice or bass leap that starts a new stroke | 4 semitones | none |

At the defaults Made in the Dark prints as before: the same 146 kicks, 75 snares and 243 hats, the same voiced frames,
and 1280 note stretches holding 606 s of note ink (pipeline 3 drew 1338 notes, 637 s). Hold at 15% gives 1167 s.

Lyrics are the published ones, never a transcription. The pipeline reads the artist and title from the file's tags
(or an "Artist - Title" file name), asks LRCLIB for the song at that length (within 3 s, since another length is
another version), and times its words to the vocal stem: LRCLIB's words and Whisper's are matched in order, a matched
word takes the time Whisper heard it at (unless that is far from where the LRC's own line time puts it, as when a
chorus repeat is matched against the wrong repeat), and the words between are spread evenly. What Whisper hears is used
for nothing else. If LRCLIB hasn't got the song, the song has no words, and the page says why.

The pipeline only wires these together and measures plain properties of what they found (loudness, brightness, how
long a hit rings, how a note starts and fades). On Made in the Dark, ADTOF found no drum hits at all in the stems that
hold no drums (the old in-browser detector found hundreds there: piano read as hats, voice read as snares), and on the
full mix 99% of its snares, 93% of its hats and 84% of its kicks matched the hits it found in the isolated drum stem.
On Made in the Dark, LRCLIB's synced lyrics were found from the file's tags and 82% of their words were matched to
words Whisper heard (base model, CPU; the server uses medium); the rest were spread between them.

### Run it on your own computer

The whole thing, page and analysis, runs on a PC with no Modal and no passphrase. A CUDA GPU (NVIDIA) analyses a song in
a couple of minutes; on a CPU it takes several.

On Windows, double-click **`Pitchscape.bat`**. The first time it checks for Python 3.11 and ffmpeg (and says how to
install whichever is missing: `winget install Python.Python.3.11`, `winget install Gyan.FFmpeg`), makes its own Python
environment in `.venv` and installs everything, with the GPU build of PyTorch if there is an NVIDIA card (a few GB, once).
Every time, it starts the server and opens the page in the browser; close its window to stop it. It installs again only
when `server/requirements.txt` changes. Options go after it, e.g. `Pitchscape.bat --update-library`.

By hand (any system):

1. Install Python 3.11 and ffmpeg (on the PATH: `ffmpeg -version` should work in a new terminal).
2. In the repository folder, make a virtual environment and install the pipeline:
   ```
   python -m venv .venv
   .venv\Scripts\activate            (Windows; on macOS or Linux: source .venv/bin/activate)
   pip install torch==2.7.1 torchaudio==2.7.1 --index-url https://download.pytorch.org/whl/cu128
   pip install -r server/requirements.txt
   pip uninstall -y tensorflow tensorflow-cpu tensorflow-intel
   ```
   (Leave out `--index-url ...` for a CPU-only PyTorch. The last line removes TensorFlow, which Basic Pitch pulls in but
   Pitchscape does not use.)
3. `python -m server.local`, then open http://localhost:8000.

The first song downloads the models (Demucs, ADTOF, Whisper: about 2 GB, once). Every song sent to it is kept in a
library, `~/.pitchscape/library/<sha256>/`: the audio as it came, its cover art, `song.json` (what identifies the
recording: title, artist, album, track, year, ISRC, MusicBrainz ids, length, every tag) and one analysis per pipeline
version (`pack-v5.json`...). A song opens at once the second time, and `--update-library` brings every kept song up to a
new pipeline version without sending anything again. `GET /library` lists the songs kept; `/library/<sha256>/audio`
and `/cover` serve them. The cloud server keeps the same in its Modal volume (`library/<sha256>/`) and serves
`/library/<sha256>/audio` (with the key) for songs opened by link.

**Songs by link.** `POST /analyze` takes a `url` instead of a `file`: the server downloads the audio file itself
(`server/fetch.py`), because a browser may not read another site's files. It opens only http(s) links to public
addresses: the host name is looked up, every address must be public (no private, loopback, link-local or cloud
metadata addresses), the connection goes to the address that was checked, and each redirect (up to 5) is checked the
same way. 80 MB and 60 s at most; a web page (YouTube, Spotify, a Drive file that isn't public) is refused with the
reason. Google Drive and Dropbox share links are turned into their download links. The file is hashed like an upload,
so a song opened by link and the same file uploaded share one analysis.

The identity in `song.json` (also in each analysis, as `song`) is what a player for another source would match on.
For Spotify, say: its Web API finds a recording by ISRC (`isrc:` search) or by artist, title and length, and reports
what is playing and how far in, which the page could follow to draw the visuals while Spotify plays the sound. The
analysis must still come from a file of the same recording (Spotify's audio cannot be read), so the length is the
check that the two are the same version. The page is built
from `src/page` when the server starts (if Node and `npm install` are there; otherwise the committed `docs/` is served).
Options: `--device cpu|cuda`, `--whisper small` (a smaller model to time the lyrics), `--port`, `--library DIR`, `--open`, and
`--host 0.0.0.0` to open it from a phone on the same network (at the PC's address, port 8000).

The pipeline alone: `python -m server.pipeline SONG.mp3 OUT.json` (`--stems DIR` reuses Demucs stems).
Deploying needs three repository secrets: `MODAL_TOKEN_ID` and `MODAL_TOKEN_SECRET` (a token from
modal.com/settings/tokens) and `PITCHSCAPE_PASSPHRASE` (any phrase; the page asks for it once, so strangers cannot spend
the GPU credit). The workflow writes the server's address to `docs/config.json`, which the page reads.

In the page, put the passphrase in Lab → Server key once. A song is known by the SHA-256 of its file. If its analysis
exists, on the device (IndexedDB) or on the server (a JSON file per song in a Modal Volume, kept for good; the first TiB
a month is free), it loads at once. Otherwise it is uploaded, the sheet shows each stage of the analysis, and the song
plays once the analysis is in (with the song's lyrics from LRCLIB, unless you have placed lyrics for that song
yourself). Only an analysis from the current pipeline is drawn; an older one is analysed again rather than drawn with
stand-ins for what it lacks.
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

**Lyrics (the old in-browser engine; the page now only uses `alignLyrics`, for the demo):** paste plain lyrics or a
whole lyrics web page (`cleanPastedLyrics` keeps just the lyric lines). Placement:
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
6. `build_pack.js`: writes `docs/<slug>.pack.json`. (The page once loaded these from a `SONGS` list; it no longer
   does: songs are analysed by the server.)

## The Lab

The page opens on the splash, where a song is picked: from the device, by link, the demo, or one of a few freely
licensed songs. It also holds the server key, which shows as a line once saved, so the keyboard only comes up when you
choose to change it. Then the screen shows nothing but the print. Its controls (play, seek, Change song) float over
its foot while they are wanted, fade a few seconds into playing, and come back with a tap, with a faint cog in the top
corner for the Lab, which opens as a panel below the print (the print shrinks to sit above it; the page itself never
scrolls).
The Lab's A/B switches sit in tabs (Colour, Shapes, Words, Motion, Print, Layers), each with an explanation that pops
up in a bubble from its label. Only settings changed from the defaults are kept on the device (`localStorage` key
`pitchscape:lab`), so a new default reaches anyone who left that setting alone. Colour by instrument, by height (the
pitch axis, low blue to high pink, whatever made the sound) or by note name (circle-of-fifths colours; drums keep the
drum ink). Drum marks that follow each hit's sound (spikier when brighter, trailing
while it rings) or all alike. Kick as a soft smudge or a halftone thud; bass as a soft smear or a sharp line. Word face
(grotesque, script, serif, mono), sized and weighted by how loudly each word was sung, or fixed. Sliders for shake, tilt
(CSS 3D: the sheet tips back on kicks and sways with the bass), glow, misprint (each ink jumps out of register on
kicks), seconds on screen, ink strength, thickness and speckle (paper showing through the ink). Layers lifts any kind
of sound off the print.

The sheet's height is fitted to each song: from a little below its lowest notes to a little above its highest (bass,
voice and every note, by how long each sounds), never less than three octaves, so the music fills the screen. Every
line that is sounding has a round pen tip where it is being printed. Each drum prints one compact mark per hit: a kick
as a soft thud at the pitch of its boom and a tom as a round drop at its note, on the sheet; snares, hats and cymbals,
which have no real pitch, in their own rows of a strip along the top (a snare as a spiky splat, a hat as a tight fleck,
a cymbal as a fine spray), a little higher the brighter they are. The bass smudge stays about three semitones tall and
prints darker when louder. Words sit just above the voice line where they are sung and never print over each other:
one that would steps up, or down, until it is clear.

## Data formats

- **Testing on real music:** `tools/fetch_test_songs.sh` fetches nine freely licensed recordings (rock, pop, acoustic,
  solo piano, a guitar solo, electronic, rap; listed with licences and what each tests in `tools/test_songs.json`) into
  `testsongs/`, which git ignores. `python tools/analyse_test_songs.py` analyses them on the CPU (stems kept, so reruns
  skip Demucs); `python tools/preview_server.py` serves the built page with those analyses standing in for the server;
  `node tools/render_frames.cjs SONG OUT 30,60 ['{"hold":0.2}']` saves phone-sized frames, with Lab settings if given.
- **Pack** (`*.pack.json`): `{format: "song-overprint-pack", version, segStride, title, artist, audio, dur, dt, frames,
  stereo, noiseRef, arrays, timing}`. `arrays` holds base64 little-endian Float32Arrays: per-frame `bassN, bassHz, bassBr,
  leadHz, leadN, leadBr, leadNz`; `events` as `[time, type (0 kick, 1 snare, 2 hat), strength, Hz]` x n;
  `events` from version 3 as `[time, type, strength, Hz, ringSeconds, band0..band15]` x n (`eventStride` 21): the hit's own
  spectrum (what each of 16 log-spaced bands from 30 Hz to 11 kHz gained over the frames before it, each drum type
  limited to its own region), how long it rings (until its band falls 14 dB), and for kicks the pitch of the boom;
  `segs` as `[t0, t1, midi, amp, brightness, noise, family, attack, fadeDbPerS, vibratoDepth, vibratoHz, hollowness,
  stem (0 other, 1 guitar, 2 piano), roughness, sharpness, curveStart, curveCount]` x n (version 8, `segStride` 17, the
  only version the page draws); each note every `dt` from t0 to t1, `curveCount` values from `curveStart` in `bends`
  (its pitch in semitones from `midi`), `holds` (Basic Pitch's certainty it still sounds) and `noteEar` (six per
  sample: down and up, in semitones, at each of `earDb`); `leadEar`, `bassEar` the same per frame. These go in `bytes`
  as `{data, lo, hi}`, value = lo + byte x (hi - lo) / 255; `events` from version 7
  end with the hit's margin (`eventStride` 22); per frame `leadP` (CREPE periodicity) and `leadL` (vocal loudness
  share), `leadRough`, `leadSharp`, `bassRough`, `bassSharp`; voice and bass carry every frame down to the server's
  floors, uncut; `onsets` as `[time, gapBefore, runEnd, strength]` x n. `lyrics`: `{language, source, lines: [{text, words: [[word, seconds]]}]}`
  or null, with why in `stats.lyrics`.
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
2. Instrument identity within the "other" stem: a small audio-tagging model to tell strings, brass, organ and synth
   apart, each with its own ink.
3. Song structure: detect repeated sections and print repeats with the same layout; a poster mode that prints the whole
   song as one long sheet to save.
4. Beat grid: lock the scroll to the tempo with faint bar lines, land the shakes on downbeats.
5. Separation in the browser (an ONNX/WebGPU source separation model) for songs without a pack: a big download and slow
   on phones, so probably better as the backend above.
