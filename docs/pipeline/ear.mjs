// width: how wide each sound spreads along the ear, as server/pipeline.py's width stage measures it (Ear, pack_curves,
// ear_line): Glasberg & Moore roex excitation patterns per stem, read at ISO 532-2's resolutions, and for every voice
// frame how far either side of the sound its excitation stays within 1, 3 and 10 dB of its peak. A note's stem may
// hold a whole chord, and a bass's octave merges with its note, so for every note sample (every other one measured,
// read between) and bass frame it is the same of a pure tone at its pitch and at the level its stem has there. Patterns are made only for the note stems that have
// notes, and for the vocals and bass.
//
// Each stem is cut into runs of frames; a worker (ear.dsp.mjs) makes the pattern of its run and measures every width
// asked for in it, so no pattern is ever held whole (Python: 2049 x frames float32 per stem).
import {EAR_DB, EAR_SPAN, HOP, SR, earChunk, pyRound} from './ear.dsp.mjs';

const DSP = './ear.dsp.mjs';
export {EAR_DB, EAR_SPAN};
export const NOTE_STEMS = ['other', 'guitar', 'piano'];      // a note's source: its index here (record[12])
const DT = HOP / SR, W = 2 * EAR_DB.length;
const REACH = 3072;                                           // samples beyond a run that its longest window reaches

/** numpy.interp(x, xp, fp) for one x. */
function interp(x, xp, fp) {
  const n = xp.length;
  if (n === 1) return fp[0];
  if (x > xp[n - 1]) return fp[n - 1];
  if (x < xp[0]) return fp[0];
  let lo = 0, hi = n;                                         // xp[lo] <= x < xp[lo + 1]
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (xp[m] <= x) lo = m; else hi = m; }
  if (lo === n - 1 || xp[lo] === x) return fp[lo];
  return (fp[lo + 1] - fp[lo]) / (xp[lo + 1] - xp[lo]) * (x - xp[lo]) + fp[lo];
}

/** Measure widths at many (frame, hz) on one stem (y: its mono samples at 22.05 kHz): Ear.widths, or with `tone`
 * tone_widths at Ear.level. Returns Float64Array(q * 6). */
async function measure(y, gain, frames, hz, rt, tone = false) {
  const n = y.length, F = 1 + Math.floor(n / HOP), q = frames.length;
  const out = new Float64Array(q * W);
  const order = Array.from({length: q}, (_, i) => i).filter(i => frames[i] < F).sort((a, b) => frames[a] - frames[b]);
  if (!order.length) return out;
  // runs of equal length, a few per worker so they even out
  const runs = Math.min(F, rt.pool.size * 4), per = Math.ceil(F / runs), jobs = [];
  for (let p0 = 0, k = 0; p0 < F; p0 += per) {
    const p1 = Math.min(F, p0 + per), ids = [];
    while (k < order.length && frames[order[k]] < p1) ids.push(order[k++]);
    if (!ids.length) continue;
    const from = Math.max(0, p0 * HOP - REACH), to = Math.min(n, p1 * HOP + REACH);
    const part = y.slice(from, to);
    const fr = Int32Array.from(ids, i => frames[i]), h = Float64Array.from(ids, i => hz[i]);
    jobs.push(rt.pool.call(DSP, 'earChunk', [part, from, n, gain, p0, p1, fr, h, tone], [part.buffer, fr.buffer, h.buffer])
      .then(w => ids.forEach((i, j) => out.set(w.subarray(j * W, j * W + W), i * W))));
  }
  await Promise.all(jobs);
  return out;
}

/** ear_line's frames: measured on every other frame that sounds. hz: Float32Array(F). */
const lineFrames = hz => {
  const on = [];
  for (let f = 0; f < hz.length; f++) if (hz[f] > 0) on.push(f);
  return {on, done: on.filter((_, i) => i % 2 === 0)};
};

/** ear_line: widths for a pitch line, frame by frame, measured every other frame while it sounds and read between.
 * Float32Array(F * 6). */
function earLine(hz, done, on, w) {
  const F = hz.length, out = new Float32Array(F * W);
  done.forEach((f, i) => { for (let k = 0; k < W; k++) out[f * W + k] = w[i * W + k]; });
  for (let i = 1; i < on.length; i += 2) {
    const f = on[i], a = f - 1, b = f + 1, src = hz[a] > 0 ? a : Math.min(b, F - 1);
    for (let k = 0; k < W; k++) {
      out[f * W + k] = b < F && hz[a] > 0 && hz[b] > 0 ? (out[a * W + k] + out[b * W + k]) / 2 : out[src * W + k];
    }
  }
  return out;
}

/** The width stage. st22: {stem: mono Float32Array at 22.05 kHz}; gain: 0.0632 / RMS of the mono mix (sets it to
 * 70 dB SPL); segs: the notes stage's records (stem index at 12, curve [times, offsets, holds] at 13); leadHz, bassHz:
 * Float32Array(F), 0 where silent. Returns {bends, holds, widths (Float64Array, flat: each note's samples, 6 per
 * sample), where ([start, count] per note), leadEar, bassEar (Float32Array(F * 6))}, as pipeline.analyze gets them
 * from pack_curves and ear_line. */
export async function ears(st22, gain, segs, leadHz, bassHz, rt, {stats = {}} = {}) {
  const t0 = performance.now();
  // pack_curves: each note on the frame grid, its bend and hold, and where its widths are measured
  const where = [];
  let total = 0;
  for (const r of segs) {
    const n = Math.max(2, pyRound((r[1] - r[0]) / DT) + 1);
    where.push([total, n]);
    total += n;
  }
  const bends = new Float64Array(total), holds = new Float64Array(total), widths = new Float64Array(total * W);
  const ask = {};                                             // stem -> {frames, hz, at: sample index}
  const hasEar = name => name in st22 && segs.some(r => NOTE_STEMS[r[12]] === name);
  const want = Object.fromEntries(NOTE_STEMS.map(s => [s, hasEar(s)]));
  segs.forEach((r, i) => {
    const [tb, off, ab] = r[13], [s0, n] = where[i], d = r[1] - r[0], stem = NOTE_STEMS[r[12]];
    const a = want[stem] ? (ask[stem] ??= {frames: [], hz: [], at: []}) : null;
    for (let j = 0; j < n; j++) {
      const tt = r[0] + d * j / (n - 1);
      const bv = interp(tt, tb, off);
      bends[s0 + j] = bv;
      holds[s0 + j] = interp(tt, tb, ab);
      if (a && j % 2 === 0) {
        a.frames.push(pyRound(tt / DT));
        a.hz.push(440 * 2 ** ((r[2] + bv - 69) / 12));
        a.at.push(s0 + j);
      }
    }
  });
  const lead = lineFrames(leadHz), bass = lineFrames(bassHz);
  const jobs = Object.entries(ask).map(([stem, a]) => measure(st22[stem], gain, a.frames, a.hz, rt, true).then(w => {
    a.at.forEach((s, i) => widths.set(w.subarray(i * W, i * W + W), s * W));
  }));
  let leadEar, bassEar;
  jobs.push(measure(st22.vocals, gain, lead.done, lead.done.map(f => leadHz[f]), rt)
    .then(w => { leadEar = earLine(leadHz, lead.done, lead.on, w); }));
  jobs.push(measure(st22.bass, gain, bass.done, bass.done.map(f => bassHz[f]), rt, true)
    .then(w => { bassEar = earLine(bassHz, bass.done, bass.on, w); }));
  await Promise.all(jobs);
  // the odd samples of each note read between their neighbours
  segs.forEach((r, i) => {
    if (!want[NOTE_STEMS[r[12]]]) return;
    const [s0, n] = where[i];
    for (let j = 1; j < n; j += 2) {
      for (let k = 0; k < W; k++) {
        const x = (s0 + j) * W + k;
        widths[x] = j + 1 < n ? (widths[x - W] + widths[x + W]) / 2 : widths[x - W];
      }
    }
  });
  stats.ear_ms = performance.now() - t0;
  stats.widths = Object.values(ask).reduce((s, a) => s + a.frames.length, 0) + lead.done.length + bass.done.length;
  return {bends, holds, widths, where, leadEar, bassEar};
}
