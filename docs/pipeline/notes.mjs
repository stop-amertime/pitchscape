// notes: Basic Pitch ICASSP 2022 (Bittner et al., Spotify, Apache-2.0) on the other, guitar and piano stems
// separately, as server/pipeline.py notes_by_stem does it: basic_pitch.inference.predict (onset threshold 0.5, notes
// followed down to HOLD_FLOOR, at least NOTE_MIN_MS, the melodia trick, pitch bends) on each stem's mono mix at
// 22.05 kHz, then notes_from_stem, join_bends, note_details, and the leaks between stems dropped. The network is the
// ONNX file basic-pitch 0.4.0 ships (the one the Python runs); its note creation and the rest run on the runtime's
// worker threads (notes.dsp.mjs), the three stems at once.
import {ANNOT_N_FRAMES, AUDIO_N_SAMPLES, HOP_SIZE, N_OVERLAP, OVERLAP_LEN, SR, modelFramesToTime,
        percentile} from './notes.dsp.mjs';

const DSP = './notes.dsp.mjs';
export const NOTE_STEMS = ['other', 'guitar', 'piano'];      // a note's source: its index here
const FPS = Math.floor(SR / 256);
// windows per model call. ONNX Runtime's CPU provider gives the Python's numbers exactly one window at a time (as
// basic_pitch.inference runs it), and within 2e-7 eight at a time, 2.5x faster.
const BATCH = 8;
const queue = new WeakMap();                                   // one model call at a time per session

function run(sess, feeds, stats) {
  const r = (queue.get(sess) || Promise.resolve()).then(async () => {
    const t = performance.now(), out = await sess.run(feeds);
    stats.model_ms = (stats.model_ms || 0) + performance.now() - t;
    stats.model_end_ms = performance.now();
    return out;
  });
  queue.set(sess, r.catch(() => {}));
  return r;
}

/** basic_pitch.inference.run_inference on one stem's mono signal at 22.05 kHz: half the overlap of silence first,
 * windows of AUDIO_N_SAMPLES every HOP_SIZE (zeros past the end), each window's first and last N_OVERLAP / 2 frames
 * dropped, cut to the signal's length. Returns {note, onset, contour} (Float32Array, frames x 88 / 88 / 264), nF. */
export async function basicPitch(y, rt, stats = {}, batch = BATCH) {
  const sess = await rt.session('basic_pitch');
  const n = y.length, len = n + OVERLAP_LEN / 2;
  const starts = [];
  for (let i = 0; i < len; i += HOP_SIZE) starts.push(i);
  const keep = ANNOT_N_FRAMES - N_OVERLAP, half = N_OVERLAP / 2;
  const nF = Math.min(starts.length * keep, Math.floor(n * (FPS / SR)));
  const out = {note: new Float32Array(nF * 88), onset: new Float32Array(nF * 88), contour: new Float32Array(nF * 264)};
  const names = {note: 'StatefulPartitionedCall:1', onset: 'StatefulPartitionedCall:2', contour: 'StatefulPartitionedCall:0'};
  for (let w0 = 0; w0 < starts.length; w0 += batch) {
    const B = Math.min(batch, starts.length - w0), x = new Float32Array(B * AUDIO_N_SAMPLES);
    for (let b = 0; b < B; b++) {
      const s = starts[w0 + b] - OVERLAP_LEN / 2;              // the window's first sample in y
      for (let i = Math.max(0, -s); i < AUDIO_N_SAMPLES && s + i < n; i++) x[b * AUDIO_N_SAMPLES + i] = y[s + i];
    }
    const r = await run(sess, {'serving_default_input_2:0': {data: x, dims: [B, AUDIO_N_SAMPLES, 1]}}, stats);
    for (const [k, name] of Object.entries(names)) {
      const C = k === 'contour' ? 264 : 88, d = r[name].data;
      for (let b = 0; b < B; b++) {
        const f0 = (w0 + b) * keep, m = Math.min(keep, nF - f0);
        if (m > 0) out[k].set(d.subarray((b * ANNOT_N_FRAMES + half) * C, (b * ANNOT_N_FRAMES + half + m) * C), f0 * C);
      }
    }
  }
  return {...out, nF};
}

/** One stem: Basic Pitch, its notes decoded and joined (a worker), then note_details over the workers in runs of
 * notes, each sent the samples its frames reach. */
async function stemNotes(y, rt, stats, events, batch) {
  const {note, onset, contour, nF} = await basicPitch(y, rt, stats, batch);
  const t = performance.now();
  const {notes, events: ev} = await rt.pool.call(DSP, 'decodeStem', [note, onset, contour, nF],
                                     [note.buffer, onset.buffer, contour.buffer]);
  stats.decode_ms = (stats.decode_ms || 0) + performance.now() - t;
  if (events) {
    const times = modelFramesToTime(nF);
    events.push(...ev.map(([a, b, p, v, bd]) => [times[a], times[b], p, v, bd]));
  }
  const t2 = performance.now();
  const per = Math.max(1, Math.ceil(notes.length / rt.pool.size)), n = y.length, jobs = [];
  for (let i = 0; i < notes.length; i += per) {
    const part = notes.slice(i, i + per);
    let fa = Infinity, fb = 0;
    for (const [t0, t1] of part) {
      fa = Math.min(fa, Math.trunc(t0 * SR / 256));
      fb = Math.max(fb, Math.trunc(t0 * SR / 256) + 2, Math.trunc(t1 * SR / 256));
    }
    const from = Math.max(0, fa * 256 - 2048), to = Math.min(n, fb * 256 + 2048);
    const ys = y.slice(from, to);
    jobs.push(rt.pool.call(DSP, 'noteDetails', [part, ys, from, n], [ys.buffer]));
  }
  const segs = (await Promise.all(jobs)).flat();
  stats.details_ms = (stats.details_ms || 0) + performance.now() - t2;
  return segs.sort((a, b) => a[0] - b[0]);
}

/** The stage. stems44: {other, guitar, piano: [left, right] at 44.1 kHz} (not used: Basic Pitch reads the 22.05 kHz
 * mono mix, which is st22's); st22: {name: mono Float32Array at 22.05 kHz}. Returns notes_by_stem's records:
 * [t0, t1, midi, amp, brightness, noise, family, attack, fade, vibrato depth, vibrato rate, hollowness, stem index,
 * [times, semitone offsets, holds]]. stats gets each stem's timing; events, if given ({}), each stem's Basic Pitch events
 * [t0, t1, pitch, amplitude, bends], as predict() returns them; batch: windows per model call. */
export async function notes(stems44, st22, rt, {stats = {}, events = null, batch = BATCH} = {}) {
  const found = [];
  await rt.session('basic_pitch');                             // made once, before the stems ask for it at once
  const per = await Promise.all(NOTE_STEMS.map((name, i) => name in st22
    ? stemNotes(st22[name], rt, stats[name] = {}, events && (events[name] = []), batch).then(r => r.map(s => [...s, i])) : []));
  for (const r of per) found.push(...r);
  if (!found.length) return [];
  // notes far below the song's level (bleed into a near-empty stem) go; a note also found, much weaker, at the same
  // pitch and time in another stem is that stem's leak
  const floor = 0.02 * percentile(found.map(r => r[12]), 95);
  const kept0 = found.filter(r => r[12] >= floor);
  kept0.sort((a, b) => a[0] - b[0]);
  const drop = new Set();
  for (let i = 0; i < kept0.length; i++) {
    const a = kept0[i];
    for (let j = i + 1; j < kept0.length; j++) {
      const b = kept0[j];
      if (b[0] >= a[1]) break;
      if (a[14] === b[14] || Math.abs(a[2] - b[2]) > 0.6) continue;
      const shared = Math.min(a[1], b[1]) - Math.max(a[0], b[0]);
      if (shared < 0.5 * Math.min(a[1] - a[0], b[1] - b[0])) continue;
      if (a[12] < 0.5 * b[12]) drop.add(i);
      else if (b[12] < 0.5 * a[12]) drop.add(j);
    }
  }
  const kept = kept0.filter((_, k) => !drop.has(k));
  const aref = percentile(kept.map(r => r[3]), 95) + 1e-9;
  return kept.map(r => [...r.slice(0, 3), Math.min(1.2, r[3] / aref), ...r.slice(4, 12), r[14], r[13]]);
}
