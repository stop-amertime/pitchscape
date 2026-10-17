// The whole analysis, as server/pipeline.py analyze: a song's file in, a pack out. The stages run as soon as what
// they read exists, at the same time where they can (models take turns on the GPU; CPU work spreads over rt.pool):
//
//   decode + tags ─► stems ─► 22.05 kHz copies ─┬─► drums ─────────────────────────┐
//                                               ├─► notes (bass too) ┬─► loudness ─┤
//                                               ├─► bass (pYIN) ─────┤             ├─► pack
//                                               ├─► voice, guitar ───┴─► width ────┤
//                                               └─► words (LRCLIB, aligned) ───────┘
//
// progress(message) gets the same stage messages as the Python pipeline ('stems: ...', 'drums: ...'), which the page
// maps to text (STAGES in src/page/legacy.js).
import {separate, consistent, SOURCES} from './stems.mjs';
import {drums} from './drums.mjs';
import {notes} from './notes.mjs';
import {bass} from './bass.mjs';
import {voice, voiceGate} from './voice.mjs';
import {loudness} from './loudness.mjs';
import {ears} from './ear.mjs';
import {songInfo, lyricsFor} from './words.mjs';
import {frameCount, makePack, NOTE_STEMS} from './pack.mjs';

const mono = ([l, r]) => { const y = new Float32Array(l.length); for (let i = 0; i < l.length; i++) y[i] = (l[i] + r[i]) / 2; return y; };

/** bytes: the song file (ArrayBuffer); name: its file name (read as "Artist - Title" when it has no tags).
 * words: false to skip LRCLIB and the alignment; aligner: words.mjs's lyricsFor's ('en', or 'mms'). shifts: Demucs's (1, as the pipeline). stems: stems already made
 * ({name: [left, right]} at 44.1 kHz, e.g. Python's, to compare the later stages on the same input; Demucs is then
 * skipped, as pipeline.analyze's stems_dir). consistent: Demucs's stems made to add up to the mix (stems.mjs; not
 * applied to given stems). mix: the song already decoded ([left, right] at 44.1 kHz; the page
 * decodes it, as a Worker cannot). Returns the pack. */
export async function analyze(bytes, name, rt, {progress = () => {}, words = true, aligner = 'en', shifts = 1, consistent: mc = true, stats = {}, stems: given = null, mix: decoded = null} = {}) {
  const t0 = performance.now(), ms = {};
  const timed = async (key, p) => { const t = performance.now(); const v = await p; ms[key] = Math.round(performance.now() - t); return v; };
  const sha = await rt.sha256(bytes);
  const [song, mix] = await Promise.all([songInfo(bytes, name, sha), decoded || timed('decode', rt.decode(bytes, 44100))]);
  const dur = mix[0].length / 44100, F = frameCount(dur);

  if (given) progress('stems: given');
  else progress('stems: separating with Demucs');
  let stems = given || await timed('stems', separate(mix, rt, {shifts, progress: (k, n) => progress(`stems: ${k}/${n}`)}));
  if (!given && mc) stems = await timed('consistent', consistent(mix, stems, rt));
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
  progress('notes: Basic Pitch on guitar, piano, bass and the rest');
  const nt = timed('notes', notes({other: stems.other, guitar: stems.guitar, piano: stems.piano, bass: stems.bass}, st22, rt));
  progress('bass: pYIN');
  const bs = timed('bass', bass(st22.bass, F, rt));
  progress('voice: CREPE');
  const vc = timed('voice', voice(stems.vocals, F, rt));
  // the guitar's line too (a solo, a bend): CREPE on its stem, read as the voice is
  const gt = vc.then(() => timed('guitar_line', voice(stems.guitar, F, rt)));
  if (words) progress('words: LRCLIB, aligned to the vocal');
  const wd = words ? timed('words', lyricsFor(song, dur, stems.vocals, rt, {aligner})) : Promise.resolve([null, null]);

  const [segs, b, lead, gtr] = await Promise.all([nt, bs, vc, gt]);
  progress('loudness: how loud, how noisy');
  const mono44 = {};
  for (const s of ['other', 'guitar', 'piano', 'bass']) mono44[s] = mono(stems[s]);
  const ld = timed('loudness', loudness(st22, mono44, segs, {vocals: lead.leadHz, guitar: gtr.leadHz}, F, rt));
  progress('width: excitation patterns');
  const ew = timed('width', ears(st22, gain, segs, lead.leadHz, b.bassHz, rt));
  const [d, lo, e, [lyrics, found]] = await Promise.all([dr, ld, ew, wd]);

  const hzOrNaN = Float32Array.from(lead.leadHz, h => h > 0 ? h : NaN);
  const g = voiceGate(lead.leadP, lead.leadL, hzOrNaN, 0.45, 0.04, 4);
  let on = 0;
  for (let f = 0; f < g.length; f++) on += g[f] ? 1 : 0;
  const seconds = (performance.now() - t0) / 1000;
  Object.assign(stats, ms, {total: Math.round(seconds * 1000)});
  const pack = makePack({song, dur, words, title: name.replace(/\.[^.]*$/, ''), hits: d.hits, events: d.events, segs,
    bassN: b.bassN, bassHz: b.bassHz, bassBr: b.bassBr, lead, gtr, loud: lo,
    curves: e, leadEar: e.leadEar, bassEar: e.bassEar, lyrics, found, voiced: on / g.length, seconds,
    timing: {ms, ep: rt.ep, where: rt.where}});
  progress(`done in ${Math.round(seconds)} s`);
  return pack;
}

export {NOTE_STEMS};
