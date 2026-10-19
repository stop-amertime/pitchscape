# Drawing how it sounds (parked 2026-10-19)

Where the work on *how* things sound (character, not just pitch and loudness) stood when it was parked. The user's
verdict: lots of potential, but the baseline data comes first. Until each instrument is told apart (two guitars, two
voices, one guitar playing a chord, no voice leaking into other stems), drawing character is decoration on a muddle.
Come back to this once instrument separation is solid.

## The spike: a player with treatments to switch on and off

`spike-timbre/ten/` (untracked, like the rest of `spike-timbre/`; never commit it: the clips are cut from test songs,
some commercial). Nine 8 s clips: Glue, Bipolar and Haunted Soldier (metal), Noon (breathy voice), Hey Ruth, Trance
(Polar), Fluoride, Percorso (nylon), Style Funk. Serve the folder (`python -m http.server 8823 --directory
spike-timbre/ten`) and open `index.html`; treatments switch on and off independently (buttons or keys).

- `export.py`: per clip, from the clip's pack 16 (testsongs/packs/ or $TEMP/lp/) and its stems
  (testsongs/timbre/<song>/): lines through time with, per point, brightness (partials' centroid in harmonic number),
  noise (energy between the partials, fundamental to 8th), stereo side (a panning index after Avendano 2003, read at
  the line's own partials), the echo test and tail; the voice line with the leak fade; drum-stem band energies.
  Note: librosa's HPSS (scipy median_filter, and numpy's median) took minutes per clip on this laptop; dropped.
- `drums.py`: per hit, from the pack (ADTOF + drum_details: kind, detector strength, centre Hz, ring, 16-band
  profile) and its level measured in its own bands (so a hat on a kick does not get the kick's level).
- `breath.py`: the voice's cepstral peak prominence (CPP, Hillenbrand 1994) and high-band (2-8 kHz) noise share.

## What the user thought of each treatment

| Treatment | What it is | Verdict |
| --- | --- | --- |
| Chord body | per stem, one band spanning every pitch sounding, dark as loud, notes thin inside | most impactful; but needs real instrument separation to mean anything; never on the voice or bass |
| Ink is loudness | darkness from the line's level, not Basic Pitch's certainty | the user's idea; needed (see below) |
| Smoke | a breathy voice (low CPP) drawn diffuse, wider and fainter; NOT rising wisps | liked as an idea; wisps rejected |
| Splash | drops off loud, bright attacks | liked, but the first version was far too much: keep it small |
| Slash or mud | clean tone a crisp slash, noisy sound ragged offset stamps | in the "All together" set |
| Echo shadows | grey copies at the lag where the sound repeats its own shape after it ends; each repeat offset a few px down so it shows on held sounds | in the set |
| Rattle and boom | the print shivers with hat energy, heaves with kick energy, against the clip's own loudest drum moments, on the playback clock (still when paused) | in the set |
| Drums from their own measurements | size and ink from level in their own bands, blot (low) vs spray (high) from centre Hz, spread from spectral width, a trailing smear from ring | liked the direction ("a bit more inky, less tight, different drums look different"); a blurred bleed pass looked bad and cost most of the frame (35 -> 8 fps): removed |
| Overtone comb | partials as hairlines above the line | bad, off |
| Glow | fluorescent halo by brightness | unclear what it showed; off |
| Measured tail | the level at a line's pitch after it ends, as a grey wake | messy; off |
| Two sides / body per side | lines inked by stereo side | unclear; off. Stereo only separates players when they are panned apart AND play different notes: double-tracked metal guitars measure centred |

The user also said: every effect may apply to every instrument (the measurements switch themselves off where a
quality is absent), except chord bodies on things that cannot play chords.

## Measurements worth keeping

- Distorted guitars printed faint because line ink is mostly Basic Pitch's certainty: on loud guitar lines
  (duration-weighted) 0.27 on Fluoride, 0.50 on Haunted Soldier, 0.67 on the clean nylon guitar. Ink from loudness
  fixes it.
- Breathiness: CPP medians in the clips (dB): Hey Ruth 22.5 (clear), Noon 17.6 (not that breathy in this excerpt),
  Fluoride 15.0, Trance's "voice" (a supersaw in the vocal stem) 15.3, instrument leaks 12-14. CPP does not tell a
  supersaw from a voice.
- Echo test (a line's shape repeating after it ends, r > 0.6): Trance 14 of 33 lines, Hey Ruth 12 of 40, Glue 1.
- Stereo side medians: nearly all centred; Percorso's nylon +0.23; Style Funk all within 0.04 of centre.
- Trance: the voice separator (Mel-Band RoFormer) put much of the supersaw lead into the vocal stem; the leak test
  (is the line's stem the loudest at its pitch?) passes it there (349 of 357 frames kept in the clip; whole song median
  -5.9 dB). Needs a "is this singing" check, e.g. the wav2vec2 aligner's speech posteriors (untested).
- Bass bodies reach far too high: the bass stem carries high lines (bleed or overtones).

## Psychoacoustics (parked)

Whether each property is measured as the ear hears it. Already ear-based: line thickness (sones from a gammatone at
the ear's time resolution), masking within an ERB, CPP (validated against listeners' breathiness ratings), pitch.
Still raw signal: ink-is-loudness and drum size (dB of power, not loudness: a 60 Hz kick sounds far quieter than a
3 kHz hat at the same power), mud (energy between partials; the ear's grit is roughness, asper), glow (partial
centroid; the ear's shrillness is sharpness, acum), rattle and boom (raw band energy).

Options when we come back:
- MOSQITO 1.2.1 (installed in the venv): time-varying Zwicker loudness (ISO 532-1), DIN 45692 sharpness, Daniel &
  Weber roughness. Dropped from the pipeline for speed, not accuracy; tone.dsp.mjs already ports roughness and
  sharpness (stationary). Quickest way to test whether heard measures make guitars and drums look right.
- Our own: ear.dsp.mjs is the front end of Moore-Glasberg loudness (ISO 532-2 resolutions, roex excitation) but
  stops before specific loudness and sones; sharpness from that (Swift & Gee 2017) and roughness from the gammatone
  channels (lines.dsp.mjs, Daniel & Weber's method) would need writing and checking.
