// Run the JavaScript pipeline (src/pipeline) on a song under Node. So far: stems, then drums, notes, bass and voice
// (and the width stage alone).
//   node tools/analyse.mjs SONG.mp3 --stems OUT_DIR [--shifts 1] [--ep cuda|webgpu|cpu]
//        writes OUT_DIR/<stem>.wav (32-bit float, 44.1 kHz stereo), OUT_DIR/drums.json and OUT_DIR/timing.json.
//   node tools/analyse.mjs --stems-in DIR --out OUT_DIR [--drums22 FILE.wav]
//        starts from stems already made (DIR/<stem>.wav, e.g. Python's, to compare stages on the same input);
//        --drums22: the drum stem at 22.05 kHz to use instead of resampling it here (to measure the resampler alone).
//   node tools/analyse.mjs --ear-in DIR --out OUT_DIR [--workers N]
//        the width stage alone on inputs from tools/parity.py (DIR/st22_<stem>.f32, segs.json, leadHz.f32,
//        bassHz.f32, inputs.json with the gain): writes OUT_DIR/{bends,holds,widths}.f64, {leadEar,bassEar}.f32,
//        where.json and timing.json.
// drums.json: {hits: [[t, kind, activation, margin]...], events: [[t, type, strength, hz, ring, 16 bands..., margin]...]}
// as server/pipeline.py drum_hits and drum_details make them; OUT_DIR/adtof.f32 the activations (frames x 5) and
// OUT_DIR/drums22.wav the drum stem's mono mix at 22.05 kHz, as resampled here.
// --stages drums,notes (the default: both) picks the stages after stems. --st22 DIR: notes reads DIR/<stem>22.wav (e.g.
// Python's 22.05 kHz signals) instead of resampling here; --batch N: Basic Pitch windows per model call. notes.json: {notes: notes_by_stem's records, the curve as
// [times, semitones, holds]; events: {stem: Basic Pitch's own events [t0, t1, pitch, amp, bends]}}.
//   --stages also takes bass and voice.
//   --bass22 FILE.wav: the bass stem at 22.05 kHz to use instead of resampling it here. --no-dither: CREPE's pitch
//   without torchcrepe's random dither (to compare with Python run the same way).
// bass.json: {F, bassN, bassHz, bassBr, f0, voiced} (f0 / voiced: pYIN's own output, before the loudness floor);
// voice.json: {F, leadHz, leadP, leadL, leadN, leadBr, leadNz, noiseRef, onsets, pitch, per} (pitch / per: CREPE's
// filtered 10 ms frames).
import {mkdirSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {decode, nodeRuntime, wav} from '../src/pipeline/runtime.node.mjs';
import {separate, SOURCES} from '../src/pipeline/stems.mjs';
import {drums} from '../src/pipeline/drums.mjs';
import {notes, NOTE_STEMS} from '../src/pipeline/notes.mjs';
import {ears} from '../src/pipeline/ear.mjs';
import {existsSync, readFileSync} from 'node:fs';
import {bass} from '../src/pipeline/bass.mjs';
import {voice} from '../src/pipeline/voice.mjs';

const args = process.argv.slice(2), opt = {};
const pos = [];
const FLAGS = new Set(['--no-dither']);
for (let i = 0; i < args.length; i++) {
  if (FLAGS.has(args[i])) opt[args[i].slice(2)] = true;
  else args[i].startsWith('--') ? opt[args[i].slice(2)] = args[++i] : pos.push(args[i]);
}
const out = opt.out || opt.stems;
if (opt['ear-in'] && opt.out) {
  const dir = opt['ear-in'], f32 = n => { const b = readFileSync(path.join(dir, n)); return new Float32Array(b.buffer, b.byteOffset, b.length / 4).slice(); };
  const {gain} = JSON.parse(readFileSync(path.join(dir, 'inputs.json'), 'utf8'));
  const st22 = {};
  for (const s of SOURCES) if (existsSync(path.join(dir, `st22_${s}.f32`))) st22[s] = f32(`st22_${s}.f32`);
  const segs = JSON.parse(readFileSync(path.join(dir, 'segs.json'), 'utf8'));
  const rt = await nodeRuntime({ep: 'cpu', ...opt.workers && {workers: +opt.workers}});
  const st = {};
  const r = await ears(st22, gain, segs, f32('leadHz.f32'), f32('bassHz.f32'), rt, {stats: st});
  mkdirSync(opt.out, {recursive: true});
  const put = (n, a) => writeFileSync(path.join(opt.out, n), Buffer.from(a.buffer, a.byteOffset, a.byteLength));
  for (const k of ['bends', 'holds', 'widths']) put(k + '.f64', r[k]);
  for (const k of ['leadEar', 'bassEar']) put(k + '.f32', r[k]);
  writeFileSync(path.join(opt.out, 'where.json'), JSON.stringify(r.where));
  const timing = {ear_s: +(st.ear_ms / 1000).toFixed(2), widths: st.widths, workers: rt.pool.size};
  writeFileSync(path.join(opt.out, 'timing.json'), JSON.stringify(timing));
  console.error(JSON.stringify(timing));
  rt.close();
  process.exit(0);
}
if (!(pos[0] && opt.stems) && !(opt['stems-in'] && opt.out)) {
  console.error('usage: node tools/analyse.mjs SONG --stems OUT_DIR [--shifts 1] [--ep cuda|webgpu|cpu]\n' +
                '       node tools/analyse.mjs --stems-in DIR --out OUT_DIR [--drums22 FILE.wav] [--ep ...]\n' +
                '       [--stages drums,notes,bass,voice] [--bass22 FILE.wav] [--no-dither]');
  process.exit(2);
}
const log = (...a) => console.error(new Date().toTimeString().slice(0, 8), ...a);
const secs = ms => +(ms / 1000).toFixed(2);
const t0 = performance.now();
const rt = await nodeRuntime({ep: opt.ep, log});
mkdirSync(out, {recursive: true});
const timing = {song: path.basename(pos[0] || opt['stems-in']), workers: rt.pool.size};
const stages = (opt.stages || 'drums,notes').split(',');

let stems;
if (opt['stems-in']) {
  stems = {};
  for (const s of SOURCES) stems[s] = await decode(path.join(opt['stems-in'], s + '.wav'), 44100);
  timing.seconds = stems.drums[0].length / 44100;
  log(`stems: read from ${opt['stems-in']}`);
} else {
  const mix = await decode(pos[0], 44100);
  const tDecode = performance.now();
  log(`decoded ${(mix[0].length / 44100).toFixed(1)} s`);
  const st = {};
  stems = await separate(mix, rt, {stats: st, shifts: +(opt.shifts ?? 1), progress: (k, n) => k % 10 && k < n || log(`stems: ${k}/${n} segments`)});
  const tStems = performance.now();
  for (const [name, ch] of Object.entries(stems)) writeFileSync(path.join(opt.stems, name + '.wav'), wav(ch, 44100));
  Object.assign(timing, {seconds: mix[0].length / 44100, ep: rt.ep, shifts: +(opt.shifts ?? 1),
    decode_s: secs(tDecode - t0), stems_s: secs(tStems - tDecode), stems_gpu_s: secs(st.gpu_ms)});
}

const monoOf = ([l, r]) => { const m = new Float32Array(l.length); for (let i = 0; i < l.length; i++) m[i] = (l[i] + r[i]) / 2; return m; };
const to22 = async (stem, file) => {
  if (file) return (await decode(file, 22050, 1))[0];
  const m = monoOf(stem);
  return rt.pool.call('./resample.mjs', 'resample', [m, 44100, 22050], [m.buffer]);
};
const F = Math.max(16, Math.ceil(stems.drums[0].length / 44100 * 22050 / 512));
const list = (a, fn) => Array.from(a, fn);

if (stages.includes('drums')) {
  // the drum stem's mono mix at 22.05 kHz, as pipeline.analyze's st22 (librosa soxr_hq), on a worker
  const tDrums = performance.now();
  let drums22;
  if (opt.drums22) drums22 = (await decode(opt.drums22, 22050, 1))[0];
  else {
    const [l, r] = stems.drums, mono = new Float32Array(l.length);
    for (let i = 0; i < l.length; i++) mono[i] = (l[i] + r[i]) / 2;
    drums22 = await rt.pool.call('./resample.mjs', 'resample', [mono, 44100, 22050], [mono.buffer]);
  }
  timing.resample_s = secs(performance.now() - tDrums);
  const ds = {};
  const res = await drums(stems.drums, drums22, rt, {stats: ds});
  Object.assign(timing, {drums_s: secs(performance.now() - tDrums), adtof_s: secs(ds.adtof_ms),
    drum_details_s: secs(ds.details_ms), drums_ep: rt.ep, hits: res.hits.length});
  log(`drums: ${res.hits.length} hits`);
  writeFileSync(path.join(out, 'drums.json'), JSON.stringify({hits: res.hits, events: res.events}));
  writeFileSync(path.join(out, 'adtof.f32'), Buffer.from(res.act.buffer, res.act.byteOffset, res.act.byteLength));
  if (!opt.drums22) writeFileSync(path.join(out, 'drums22.wav'), wav([drums22], 22050));
}
if (stages.includes('bass')) {
  const t = performance.now();
  const bass22 = await to22(stems.bass, opt.bass22);
  const bs = {raw: true};
  const b = await bass(bass22, F, rt, {stats: bs});
  Object.assign(timing, {bass_s: secs(performance.now() - t), bass_yin_s: secs(bs.yin_ms),
    bass_viterbi_s: secs(bs.viterbi_ms), bass_brightness_s: secs(bs.brightness_ms), bass_stage_s: secs(bs.bass_ms)});
  log(`bass: ${b.bassHz.filter(h => h > 0).length} of ${F} frames sound`);
  writeFileSync(path.join(out, 'bass.json'), JSON.stringify({F, bassN: list(b.bassN), bassHz: list(b.bassHz),
    bassBr: list(b.bassBr), f0: list(bs.f0, x => Number.isFinite(x) ? x : null), voiced: list(bs.voiced)}));
}

if (stages.includes('voice')) {
  const t = performance.now();
  const vs = {raw: true, dither: !opt['no-dither']};
  const v = await voice(stems.vocals, F, rt, {stats: vs});
  Object.assign(timing, {voice_s: secs(performance.now() - t), voice_ep: rt.eps?.crepe_full ?? rt.ep,
    crepe_s: secs(vs.crepe_ms), crepe_decode_wait_s: secs(vs.decode_wait_ms), crepe_total_s: secs(vs.crepe_total_ms), voice_onsets_s: secs(vs.onsets_ms),
    voice_brightness_s: secs(vs.brightness_ms), voice_stage_s: secs(vs.voice_ms)});
  log(`voice: ${v.leadHz.filter(h => h > 0).length} of ${F} frames heard, ${v.onsets.length} onsets`);
  const o = {F};
  for (const k of ['leadHz', 'leadP', 'leadL', 'leadN', 'leadBr', 'leadNz']) o[k] = list(v[k]);
  Object.assign(o, {noiseRef: v.noiseRef, onsets: v.onsets, pitch: list(vs.pitch, x => Number.isFinite(x) ? x : null),
    per: list(vs.per, x => Number.isFinite(x) ? x : null), inner: vs.inner});
  writeFileSync(path.join(out, 'voice.json'), JSON.stringify(o));
}

if (stages.includes('notes')) {
  // each instrument stem's mono mix at 22.05 kHz (pipeline.analyze's st22), the three at once on the workers
  const tNotes = performance.now(), st22 = {};
  await Promise.all(NOTE_STEMS.map(async s => {
    if (opt.st22) return st22[s] = (await decode(path.join(opt.st22, s + '22.wav'), 22050, 1))[0];
    const [l, r] = stems[s], mono = new Float32Array(l.length);
    for (let i = 0; i < l.length; i++) mono[i] = (l[i] + r[i]) / 2;
    st22[s] = await rt.pool.call('./resample.mjs', 'resample', [mono, 44100, 22050], [mono.buffer]);
  }));
  const tStart = performance.now(), ns = {}, events = {};
  const res = await notes(null, st22, rt, {stats: ns, events, ...(opt.batch ? {batch: +opt.batch} : {})});
  const model = Math.max(...NOTE_STEMS.map(s => ns[s]?.model_end_ms || 0)) - tStart;
  Object.assign(timing, {notes_resample_s: secs(tStart - tNotes), notes_s: secs(performance.now() - tStart),
    notes_model_s: secs(NOTE_STEMS.reduce((a, s) => a + (ns[s]?.model_ms || 0), 0)), notes_model_done_s: secs(model),
    notes_decode_s: secs(NOTE_STEMS.reduce((a, s) => a + (ns[s]?.decode_ms || 0), 0)),
    notes_details_s: secs(NOTE_STEMS.reduce((a, s) => a + (ns[s]?.details_ms || 0), 0)),
    notes_ep: rt.eps?.basic_pitch ?? rt.ep, notes: res.length});
  log(`notes: ${res.length}`);
  writeFileSync(path.join(out, 'notes.json'), JSON.stringify({events,
    notes: res.map(r => [...r.slice(0, 13), r[13].map(c => Array.from(c))])}));
}
writeFileSync(path.join(out, 'timing.json'), JSON.stringify(timing, null, 1));
log(JSON.stringify(timing));
rt.close();
