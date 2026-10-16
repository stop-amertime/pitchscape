// The whole analysis, as server/pipeline.py analyze: a song's file in, a pack out. The stages run as soon as what
// they read exists, at the same time where they can (models take turns on the GPU; CPU work spreads over rt.pool):
//
//   decode + tags ─► stems ─► 22.05 kHz copies ─┬─► drums ─────────────────────────┐
//                                               ├─► notes ─┬─► tone (MOSQITO) ─────┤
//                                               ├─► bass ──┤                       ├─► pack
//                                               ├─► voice ─┴─► width (ear) ────────┤
//                                               └─► words (LRCLIB, Whisper) ───────┘
//
// progress(message) gets the same stage messages as the Python pipeline ('stems: ...', 'drums: ...'), which the page
// maps to text (STAGES in app.html).
import {separate, SOURCES} from './stems.mjs';
import {drums} from './drums.mjs';
import {notes} from './notes.mjs';
import {bass} from './bass.mjs';
import {voice, voiceGate} from './voice.mjs';
import {tone} from './tone.mjs';
import {ears} from './ear.mjs';
import {songInfo, lyricsFor} from './words.mjs';
import {frameCount, makePack, NOTE_STEMS} from './pack.mjs';

const mono = ([l, r]) => { const y = new Float32Array(l.length); for (let i = 0; i < l.length; i++) y[i] = (l[i] + r[i]) / 2; return y; };

/** bytes: the song file (ArrayBuffer); name: its file name (read as "Artist - Title" when it has no tags).
 * words: false to skip LRCLIB and Whisper. shifts: Demucs's (1, as the pipeline). stems: stems already made
 * ({name: [left, right]} at 44.1 kHz, e.g. Python's, to compare the later stages on the same input; Demucs is then
 * skipped, as pipeline.analyze's stems_dir). Returns the pack. */
export async function analyze(bytes, name, rt, {progress = () => {}, words = true, shifts = 1, stats = {}, stems: given = null} = {}) {
  const t0 = performance.now(), ms = {};
  const timed = async (key, p) => { const t = performance.now(); const v = await p; ms[key] = Math.round(performance.now() - t); return v; };
  const sha = await rt.sha256(bytes);
  const [song, mix] = await Promise.all([songInfo(bytes, name, sha), timed('decode', rt.decode(bytes, 44100))]);
  const dur = mix[0].length / 44100, F = frameCount(dur);

  if (given) progress('stems: given');
  else progress('stems: separating with Demucs');
  const stems = given || await timed('stems', separate(mix, rt, {shifts, progress: (k, n) => progress(`stems: ${k}/${n}`)}));
  // pipeline.analyze's st22: each stem's mono mix at 22.05 kHz (librosa soxr_hq), on the workers
  const st22 = {};
  await timed('resample', Promise.all(SOURCES.map(async s => {
    const m = mono(stems[s]);
    st22[s] = await rt.pool.call('./resample.mjs', 'resample', [m, 44100, 22050], [m.buffer]);
  })));
  // the 70 dB SPL gain the tone and width stages set the stems to
  let sq = 0;
  const n = stems.drums[0].length, sum = new Float64Array(n);
  for (const s of SOURCES) { const [l, r] = stems[s]; for (let i = 0; i < n; i++) sum[i] += (l[i] + r[i]) / 2; }
  for (let i = 0; i < n; i++) sq += sum[i] * sum[i];
  const gain = 0.0632 / (Math.sqrt(sq / n) + 1e-12);

  progress('drums: ADTOF');
  const dr = timed('drums', drums(stems.drums, st22.drums, rt));
  progress('notes: Basic Pitch on guitar, piano and the rest');
  const nt = timed('notes', notes({other: stems.other, guitar: stems.guitar, piano: stems.piano}, st22, rt));
  progress('bass: pYIN');
  const bs = timed('bass', bass(st22.bass, F, rt));
  progress('voice: CREPE');
  const vc = timed('voice', voice(stems.vocals, F, rt));
  if (words) progress('words: LRCLIB, timed by Whisper');
  const wd = words ? timed('words', lyricsFor(song, dur, stems.vocals, rt)) : Promise.resolve([null, null]);

  const [segs, b, lead] = await Promise.all([nt, bs, vc]);
  progress('tone: roughness and sharpness');
  const tn = timed('tone', tone(stems, segs, lead.leadHz, b.bassHz, F, rt));
  progress('width: excitation patterns');
  const ew = timed('width', ears(st22, gain, segs, lead.leadHz, b.bassHz, rt));
  const [d, t, e, [lyrics, found]] = await Promise.all([dr, tn, ew, wd]);

  const hzOrNaN = Float32Array.from(lead.leadHz, h => h > 0 ? h : NaN);
  const g = voiceGate(lead.leadP, lead.leadL, hzOrNaN, 0.45, 0.04, 4);
  let on = 0;
  for (let f = 0; f < g.length; f++) on += g[f] ? 1 : 0;
  const seconds = (performance.now() - t0) / 1000;
  Object.assign(stats, ms, {total: Math.round(seconds * 1000)});
  const pack = makePack({song, dur, words, title: name.replace(/\.[^.]*$/, ''), hits: d.hits, events: d.events, segs,
    noteRs: t.noteRs, bassN: b.bassN, bassHz: b.bassHz, bassBr: b.bassBr, lead,
    leadRough: t.lead[0], leadSharp: t.lead[1], bassRough: t.bass[0], bassSharp: t.bass[1], slices: t.slices,
    curves: e, leadEar: e.leadEar, bassEar: e.bassEar, lyrics, found, voiced: on / g.length, seconds,
    timing: {ms, ep: rt.ep, where: rt.where}});
  progress(`done in ${Math.round(seconds)} s`);
  return pack;
}

export {NOTE_STEMS};
