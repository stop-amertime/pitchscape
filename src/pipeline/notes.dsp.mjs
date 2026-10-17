// The CPU work of the notes stage (notes.mjs), apart so worker threads can run it (worker.mjs): Basic Pitch 0.4.0's
// note creation (basic_pitch.note_creation: output_to_notes_polyphonic with the melodia trick, get_pitch_bends,
// model_frames_to_time), then server/pipeline.py's notes_from_stem, raw_bends, smooth_bend (scipy.ndimage
// median_filter and gaussian_filter1d), join_bends and note_details (its Spec: librosa.stft, n_fft 4096, hop 256).
// numpy's own arithmetic is followed where it decides something: pairwise summation for means, float32 where numpy
// computes in float32, its interp, median and percentile.
import FFT from './vendor/fft.mjs';

export const SR = 22050;
const f32 = Math.fround;

// basic_pitch.constants and note_creation
export const FFT_HOP = 256, AUDIO_N_SAMPLES = SR * 2 - FFT_HOP, ANNOT_N_FRAMES = Math.floor(SR / FFT_HOP) * 2;
const ANNOTATIONS_FPS = Math.floor(SR / FFT_HOP);
export const N_OVERLAP = 30, OVERLAP_LEN = N_OVERLAP * FFT_HOP, HOP_SIZE = AUDIO_N_SAMPLES - OVERLAP_LEN;
const NP = 88, NC = 264, MIDI_OFFSET = 21, MAX_FREQ_IDX = 87;
const ENERGY_TOL = 11;

// server/pipeline.py
export const HOLD_FLOOR = 0.15, NOTE_MIN_MS = 50, BP_BEND_BIAS = 1;

/** Python's round(): halves to even. */
export function pyRound(x) {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 && r % 2 ? r - 1 : r;
}

/** numpy's sum of a contiguous array (pairwise summation, blocks of 8 below 128 elements); `r` rounds each step
 * (Math.fround for float32, identity for float64). a(i) gives element i. */
function pairwise(a, lo, n, r) {
  if (n < 8) {
    let s = -0;
    for (let i = 0; i < n; i++) s = r(s + a(lo + i));
    return s;
  }
  if (n <= 128) {
    const p = new Float64Array(8);
    for (let j = 0; j < 8; j++) p[j] = r(a(lo + j));
    let i = 8;
    for (; i < n - (n % 8); i += 8) for (let j = 0; j < 8; j++) p[j] = r(p[j] + a(lo + i + j));
    let s = r(r(r(p[0] + p[1]) + r(p[2] + p[3])) + r(r(p[4] + p[5]) + r(p[6] + p[7])));
    for (; i < n; i++) s = r(s + a(lo + i));
    return s;
  }
  let n2 = Math.floor(n / 2);
  n2 -= n2 % 8;
  return r(pairwise(a, lo, n2, r) + pairwise(a, lo + n2, n - n2, r));
}
const id = x => x;
// numpy 2.4's float32 log on AVX2 + FMA3 (simd_log_FLOAT, loops_exponent_log.dispatch.c.src): the mantissa m in
// [0.5, 1) and exponent e, doubled below 1/sqrt(2); a Remez rational polynomial for log(1 + x) in float32 with fused
// multiply-adds; up to 3.8 ulp from the true log. Positive normal inputs only (all this stage gives it).
const LOG_P = [0.0, 9.999999999999998702752e-01, 2.112677543073053063722e+00, 1.480000633576506585156e+00,
  3.808837741388407920751e-01, 2.589979117907922693523e-02].map(f32);
const LOG_Q = [1.0, 2.612677543073109236779e+00, 2.453006071784736363091e+00, 9.864942958519418960339e-01,
  1.546476374983906719538e-01, 5.875095403124574342950e-03].map(f32);
const LOGE2 = f32(Math.LN2), SQRT1_2 = f32(Math.SQRT1_2);
const lf = new Float32Array(1), lu = new Uint32Array(lf.buffer);
const fma32 = (a, b, c) => f32(a * b + c);                     // a * b is exact in float64 for float32 a, b
export function npLogf(v) {
  lf[0] = v;
  const bits = lu[0];
  let e = (bits >>> 23) - 126;
  lu[0] = (bits & 0x7fffff) | (126 << 23);
  let x = lf[0];
  if (x <= SQRT1_2) { x = f32(x + x); e -= 1; }
  x = f32(x - 1);
  let num = fma32(LOG_P[5], x, LOG_P[4]), den = fma32(LOG_Q[5], x, LOG_Q[4]);
  for (let k = 3; k >= 0; k--) { num = fma32(num, x, LOG_P[k]); den = fma32(den, x, LOG_Q[k]); }
  return fma32(e, LOGE2, f32(num / den));
}

/** np.mean of a float64 sequence. */
export function mean64(arr) { return pairwise(i => arr[i], 0, arr.length, id) / arr.length; }
/** np.mean of a float32 sequence given by element getter (float32 accumulation and result). */
function mean32(get, n) { return f32(pairwise(get, 0, n, f32) / n); }

/** np.median. */
export function median(a) {
  const s = Float64Array.from(a).sort(), n = s.length;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

/** np.percentile(a, q), method 'linear' (numpy's _lerp: from the upper value when the fraction is 0.5 or more). */
export function percentile(a, q) {
  const s = Float64Array.from(a).sort(), n = s.length;
  const v = q / 100 * (n - 1), lo = Math.floor(v), t = v - lo;
  if (lo + 1 >= n) return s[n - 1];
  const x = s[lo], y = s[lo + 1], d = y - x;
  return t >= 0.5 ? y - d * (1 - t) : x + d * t;
}

/** np.interp(x, xp, fp) for one x (numpy's compiled loop: exact hits take fp, NaN slopes fall back). */
export function interp(x, xp, fp) {
  const n = xp.length;
  if (n === 1) return fp[0];
  if (x > xp[n - 1]) return fp[n - 1];
  if (x < xp[0]) return fp[0];
  if (x === xp[n - 1]) return fp[n - 1];
  let lo = 0, hi = n - 1;                                       // xp[lo] <= x < xp[hi]
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (xp[m] <= x) lo = m; else hi = m; }
  const j = lo;
  if (xp[j] === x) return fp[j];
  const slope = (fp[j + 1] - fp[j]) / (xp[j + 1] - xp[j]);
  let r = slope * (x - xp[j]) + fp[j];
  if (Number.isNaN(r)) {
    r = slope * (x - xp[j + 1]) + fp[j + 1];
    if (Number.isNaN(r) && fp[j] === fp[j + 1]) r = fp[j];
  }
  return r;
}

/** basic_pitch.note_creation.model_frames_to_time. */
export function modelFramesToTime(n) {
  const off = (FFT_HOP / SR) * (ANNOT_N_FRAMES - (AUDIO_N_SAMPLES / FFT_HOP)) + 0.0018;
  const t = new Float64Array(n);
  for (let k = 0; k < n; k++) t[k] = (k * FFT_HOP) / SR - off * Math.floor(k / ANNOT_N_FRAMES);
  return t;
}

/** Basic Pitch's note creation from its model output (each Float32Array, frames x 88 / 88 / 264), as predict() runs
 * model_output_to_notes with infer_onsets, the melodia trick and pitch bends, no frequency limits. Returns events
 * [[start frame, end frame, MIDI pitch, amplitude (float32 mean), bends (thirds of a semitone)]...] in Basic Pitch's
 * order. */
export function outputToNotes(note, onset, contour, nF, {onsetThresh = 0.5, frameThresh = HOLD_FLOOR,
                                                       minNoteLen = pyRound(NOTE_MIN_MS / 1000 * (SR / FFT_HOP))} = {}) {
  // get_infered_onsets (n_diff 2), in float64 as numpy promotes it
  const fd = new Float64Array(nF * NP);
  let maxFd = -Infinity, maxOn = -Infinity;
  for (let i = 0; i < nF * NP; i++) if (onset[i] > maxOn) maxOn = onset[i];
  for (let t = 0; t < nF; t++) for (let p = 0; p < NP; p++) {
    const x = note[t * NP + p];
    const d1 = x - (t >= 1 ? note[(t - 1) * NP + p] : 0), d2 = x - (t >= 2 ? note[(t - 2) * NP + p] : 0);
    let d = Math.min(d1, d2);
    if (d < 0 || t < 2) d = 0;
    fd[t * NP + p] = d;
  }
  for (let i = 0; i < nF * NP; i++) if (fd[i] > maxFd) maxFd = fd[i];
  const on = new Float64Array(nF * NP);
  for (let i = 0; i < nF * NP; i++) on[i] = Math.max(onset[i], (maxOn * fd[i]) / maxFd);
  // scipy.signal.argrelmax along time (mode 'clip': never the first or last frame), at or over the threshold;
  // taken backwards in time (and in pitch), as np.where's order reversed
  const starts = [];
  for (let t = nF - 2; t >= 1; t--) for (let p = NP - 1; p >= 0; p--) {
    const x = on[t * NP + p];
    if (x > on[(t - 1) * NP + p] && x > on[(t + 1) * NP + p] && x >= onsetThresh) starts.push(t, p);
  }
  const E = Float32Array.from(note);                            // remaining_energy (float32 values, exact in float64)
  const events = [];
  const amp = (a, b, p) => mean32(i => note[(a + i) * NP + p], b - a);
  for (let s = 0; s < starts.length; s += 2) {
    const t0 = starts[s], p = starts[s + 1];
    if (t0 >= nF - 1) continue;
    let i = t0 + 1, k = 0;
    while (i < nF - 1 && k < ENERGY_TOL) {
      if (E[i * NP + p] < frameThresh) k++; else k = 0;
      i++;
    }
    i -= k;
    if (i - t0 <= minNoteLen) continue;
    for (let t = t0; t < i; t++) {
      E[t * NP + p] = 0;
      if (p < MAX_FREQ_IDX) E[t * NP + p + 1] = 0;
      if (p > 0) E[t * NP + p - 1] = 0;
    }
    events.push([t0, i, p + MIDI_OFFSET, amp(t0, i, p)]);
  }

  // the melodia trick: the strongest energy left, followed forwards and backwards. np.argmax over the whole matrix
  // (first in row-major order) is kept as each frame's maximum and a tree over frames.
  const rowMax = new Float32Array(nF), rowArg = new Int32Array(nF);
  const redo = t => {
    let m = -Infinity, a = 0;
    for (let p = 0; p < NP; p++) { const v = E[t * NP + p]; if (v > m) { m = v; a = p; } }
    rowMax[t] = m; rowArg[t] = a;
  };
  for (let t = 0; t < nF; t++) redo(t);
  let size = 1;
  while (size < nF) size <<= 1;
  const tree = new Int32Array(2 * size).fill(-1);
  const better = (a, b) => a < 0 ? b : b < 0 ? a : rowMax[b] > rowMax[a] ? b : rowMax[a] > rowMax[b] ? a : Math.min(a, b);
  for (let t = 0; t < nF; t++) tree[size + t] = t;
  for (let i = size - 1; i >= 1; i--) tree[i] = better(tree[2 * i], tree[2 * i + 1]);
  const dirty = new Set();
  const update = () => {
    for (const t of dirty) {
      redo(t);
      for (let i = (size + t) >> 1; i >= 1; i >>= 1) tree[i] = better(tree[2 * i], tree[2 * i + 1]);
    }
    dirty.clear();
  };
  const zero = (t, p) => {
    E[t * NP + p] = 0;
    if (p < MAX_FREQ_IDX) E[t * NP + p + 1] = 0;
    if (p > 0) E[t * NP + p - 1] = 0;
    dirty.add(t);
  };
  while (rowMax[tree[1]] > frameThresh) {
    const iMid = tree[1], p = rowArg[iMid];
    E[iMid * NP + p] = 0;
    dirty.add(iMid);
    let i = iMid + 1, k = 0;
    while (i < nF - 1 && k < ENERGY_TOL) {
      if (E[i * NP + p] < frameThresh) k++; else k = 0;
      zero(i, p);
      i++;
    }
    const iEnd = i - 1 - k;
    i = iMid - 1; k = 0;
    while (i > 0 && k < ENERGY_TOL) {
      if (E[i * NP + p] < frameThresh) k++; else k = 0;
      zero(i, p);
      i--;
    }
    const iStart = i + 1 + k;
    update();
    if (iEnd - iStart <= minNoteLen) continue;
    events.push([iStart, iEnd, p + MIDI_OFFSET, amp(iStart, iEnd, p)]);
  }

  // get_pitch_bends (n_bins_tolerance 25): the contour's peak near each note's pitch, weighted by a Gaussian
  const tol = 25, W = 2 * tol + 1;
  const gauss = Float64Array.from({length: W}, (_, i) => { const n = i - (W - 1) / 2; return Math.exp(-(n * n) / (2 * 5 * 5)); });
  for (const ev of events) {
    const [a, b, pitch] = ev;
    const hz = 440.0 * (2.0 ** ((pitch - 69.0) / 12.0));
    const fi = pyRound(12.0 * 3 * Math.log2(hz / 27.5));
    const lo = Math.max(fi - tol, 0), hi = Math.min(NC, fi + tol + 1);
    const g0 = Math.max(0, tol - fi), shift = tol - Math.max(0, tol - fi);
    // and server/pipeline.py fine_bends: the same peak read to a fraction of a bin, the salience-weighted mean over it
    // and 2 bins either side (CREPE's decoding), so a note is not snapped to thirds of a semitone
    const bends = [], fine = [];
    for (let t = a; t < b; t++) {
      let m = -Infinity, arg = 0;
      for (let c = lo; c < hi; c++) {
        const v = contour[t * NC + c] * gauss[g0 + c - lo];
        if (v > m) { m = v; arg = c - lo; }
      }
      bends.push(arg - shift);
      let sw = 0, sx = 0;
      for (let c = Math.max(0, arg - 2); c < Math.min(hi - lo, arg + 3); c++) { const s = contour[t * NC + lo + c]; sw += s; sx += c * s; }
      fine.push(sw > 0 ? sx / sw - shift : arg - shift);
    }
    ev.push(bends, fine);
  }
  return events;
}

/** server/pipeline.py notes_from_stem after predict(): each event as (t0, t1, pitch, amp, bends, act), act the note
 * activation at its pitch over its frames, amp the mean of act where it is 0.3 or more (else Basic Pitch's own). */
export function notesFromEvents(events, note, nF) {
  const times = modelFramesToTime(nF);
  return events.map(([a, b, p, v, bd, fine]) => {
    const n = bd.length, act = new Float64Array(n);
    for (let i = 0; i < n; i++) act[i] = note[(a + i) * NP + p - MIDI_OFFSET];
    const top = act.filter(x => x >= 0.3);
    return [times[a], times[b], p, top.length ? mean64(top) : v, fine, act];
  });
}

/** raw_bends: (times, semitones from the pitch, how sure it still sounds), one per model frame. */
function rawBends(t0, t1, bends, act) {
  if (!bends.length) return [[t0, t1], [0, 0], new Array(2).fill(act.length ? mean64(act) : 1.0)];
  const n = bends.length;
  const b = bends.map(x => (x - BP_BEND_BIAS) / 3);
  const a = Array.from(act.subarray(0, n));
  while (a.length < n) a.push(a.length ? a[a.length - 1] : 1);
  return [Array.from({length: n}, (_, i) => t0 + (t1 - t0) * (i + 0.5) / n), b, a];
}

/** scipy.ndimage.median_filter(size 3, mode 'nearest') then gaussian_filter1d(sigma 1.5, mode 'nearest',
 * truncate 4): scipy's correlate1d for a symmetric kernel (the centre, then each pair from the outside in). */
const RADIUS = Math.trunc(4.0 * 1.5 + 0.5);
const GW = (() => {
  const x = Array.from({length: 2 * RADIUS + 1}, (_, i) => i - RADIUS);
  const phi = x.map(v => Math.exp(-0.5 / (1.5 * 1.5) * v ** 2));
  const s = pairwise(i => phi[i], 0, phi.length, id);
  return phi.map(v => v / s);
})();
export function smoothBend(m) {
  const n = m.length;
  if (n >= 3) {
    const o = new Array(n);
    for (let i = 0; i < n; i++) {
      const a = m[Math.max(0, i - 1)], b = m[i], c = m[Math.min(n - 1, i + 1)];
      o[i] = Math.max(Math.min(a, b), Math.min(Math.max(a, b), c));
    }
    m = o;
  }
  if (n >= 4) {
    const o = new Array(n), at = i => m[Math.min(n - 1, Math.max(0, i))];
    for (let i = 0; i < n; i++) {
      let s = at(i) * GW[RADIUS];
      for (let j = -RADIUS; j < 0; j++) s += (at(i + j) + at(i - j)) * GW[RADIUS + j];
      o[i] = s;
    }
    m = o;
  }
  return m;
}

/** join_bends: a note that starts where one on another pitch ended, at the pitch that one had bent to, is the same
 * note still bending. Returns [t0, t1, pitch, amp, times, bend semitones (smoothed), holds]. */
export function joinBends(notes, gap = 0.15, near = 0.75) {
  const out = [];
  const sorted = notes.map((n, i) => [n, i]).sort((x, y) => x[0][0] - y[0][0] || x[1] - y[1]).map(x => x[0]);
  for (const [t0, t1, pitch, amp, bends, act] of sorted) {
    const [tb, cb, ab] = rawBends(t0, t1, bends, act);
    let best = null, bd = near;
    for (const a of out.slice(-200)) {
      if (a.t1 < t0 - gap || a.t1 > t0 + gap || a.t1 > t1 || a.last === pitch) continue;
      const d = Math.abs(a.m[a.m.length - 1] - (pitch + cb[0]));
      if (d <= bd) { best = a; bd = d; }
    }
    if (best === null) {
      out.push({t0, t1, pitch, last: pitch, amps: [[amp, t1 - t0]], t: tb, m: cb.map(c => pitch + c), a: ab});
      continue;
    }
    const keep = best.t.map(x => x < tb[0]);
    best.t = best.t.filter((_, i) => keep[i]).concat(tb);
    best.m = best.m.filter((_, i) => keep[i]).concat(cb.map(c => pitch + c));
    best.a = best.a.filter((_, i) => keep[i]).concat(ab);
    best.t1 = t1; best.last = pitch;
    best.amps.push([amp, t1 - t0]);
  }
  return out.map(a => {
    let w = 0, s = 0;
    for (const [, d] of a.amps) w += d;
    w = w || 1.0;
    for (const [v, d] of a.amps) s += v * d;
    return [a.t0, a.t1, a.pitch, s / w, a.t, smoothBend(a.m).map(v => v - a.pitch), a.a];
  });
}

/** Basic Pitch, decoded: model output (Float32Arrays) -> server/pipeline.py's join_bends(notes_from_stem(...)).
 * Returns {events (Basic Pitch's own), notes}. */
export function decodeStem(note, onset, contour, nF) {
  const events = outputToNotes(note, onset, contour, nF);
  return {events, notes: joinBends(notesFromEvents(events, note, nF))};
}

// ---- note_details: Spec (librosa.stft, n_fft 4096, hop 256, centred with zeros, periodic Hann), frames made as
// needed. librosa computes each frame in float64 and stores it as complex64; np.abs then gives float32 (not the
// correctly rounded magnitude: numpy's own formula, followed below, differs from it in about a third of the bins).
const NFFT = 4096, HOP = 256, NB = NFFT / 2 + 1, BINHZ = SR / NFFT, FPS = SR / HOP;
const HANN = Float64Array.from({length: NFFT}, (_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / NFFT));
let fft = null;

class Spec {
  constructor(y, from, n) {
    this.y = y; this.from = from; this.n = n;              // y: samples from `from` of a stem n samples long
    this.cols = 1 + Math.floor(n / HOP);
    this.cache = new Map();
    fft ??= new FFT(NFFT);
    this.inp = new Float64Array(NFFT); this.out = fft.createComplexArray();
  }
  col(f) {
    let c = this.cache.get(f);
    if (c) return c;
    const {y, from, n, inp, out} = this, s0 = f * HOP - NFFT / 2;
    for (let i = 0; i < NFFT; i++) { const k = s0 + i; inp[i] = k >= 0 && k < n ? HANN[i] * y[k - from] : 0; }
    fft.realTransform(out, inp);
    c = new Float32Array(NB);
    for (let k = 0; k < NB; k++) {
      // numpy 2's absolute of complex64 (its SIMD loop): larger * sqrt(fma(ratio, ratio, 1)), in float32
      const a = Math.abs(f32(out[2 * k])), b = Math.abs(f32(out[2 * k + 1]));
      const L = Math.max(a, b);
      if (L === 0) continue;
      const r = f32(Math.min(a, b) / L);
      c[k] = f32(f32(Math.sqrt(f32(r * r + 1))) * L);
    }
    this.cache.set(f, c);
    return c;
  }
  drop(below) { for (const f of this.cache.keys()) if (f < below) this.cache.delete(f); }
  at(f, hz, width = 1) {
    if (f >= this.cols || hz <= 0) return 0.0;
    const b = pyRound(hz / BINHZ);
    if (b < 1 || b >= NB - 1) return 0.0;
    const c = this.col(f);
    let m = -Infinity;
    for (let k = Math.max(1, b - width); k < b + width + 1; k++) if (c[k] > m) m = c[k];
    return m;
  }
  peakHz(f, hz, width = 2) {
    const b = pyRound(hz / BINHZ);
    if (b < 2 || b >= NB - 2 || f >= this.cols) return 0.0;
    const lo = Math.max(1, b - width), hi = Math.min(NB - 2, b + width), c = this.col(f);
    let k = lo;
    for (let j = lo + 1; j <= hi; j++) if (c[j] > c[k]) k = j;
    // numpy in float32: log(M + 1e-12), the parabola's offset
    const lg = j => npLogf(f32(c[j] + 1e-12));
    const a = lg(k - 1), cc = lg(k), d = lg(k + 1);
    const den = f32(f32(a - f32(2 * cc)) + d);
    let off = den < 0 ? f32(f32(f32(0.5) * f32(a - d)) / den) : 0.0;
    off = Math.min(0.5, Math.max(-0.5, off));
    return (k + off) * BINHZ;
  }
}

/** note_details for notes (as joinBends returns them) on a stem's 22.05 kHz signal: y holds samples from `from`
 * (enough for every frame the notes reach), n the stem's length. Returns the records [t0, t1, midi, amp, brightness,
 * noise, family, attack, fade, vibrato depth, vibrato rate, hollowness, strength, [times, offsets, holds]], in the
 * notes' order (the caller sorts). */
export function noteDetails(notes, y, from, n) {
  const spec = new Spec(y, from, n);
  const segs = [];
  let dropped = -Infinity;
  for (const [t0, t1, pitch, amp, tb, cb, ab] of notes) {
    const midi = pitch + median(cb);
    const off = cb.map(c => c - (midi - pitch));
    const fa = Math.trunc(t0 * FPS), fb = Math.max(Math.trunc(t0 * FPS) + 2, Math.trunc(t1 * FPS));
    if (fa > dropped + 256) { spec.drop(fa); dropped = fa; }      // notes come in time order: earlier frames are done
    const env = [], trk = [], br = [], nz = [];
    let ev = 0.0, od = 0.0;
    for (let f = fa; f < Math.min(fb, spec.cols); f++) {
      const fm = midi + interp(f / FPS, tb, off);
      const f0 = 440 * 2 ** ((fm - 69) / 12);
      const h = [];
      for (let k = 1; k <= 8; k++) h.push(spec.at(f, k * f0));
      const e4 = h[0] + h[1] + h[2] + h[3];
      env.push(e4);
      const tot = e4 + h[4] + h[5] + h[6] + h[7];
      br.push(tot > 0 ? (h[2] + h[3] + h[4] + h[5] + h[6] + h[7]) / tot : 0);
      let mid = 0;
      for (let k = 1; k <= 4; k++) mid += spec.at(f, (k + 0.5) * f0, 0);
      nz.push(mid / (e4 + 1e-12));
      ev += h[1] + h[3] + h[5];
      od += h[2] + h[4] + h[6];
      const k = (h[1] > h[0] ? (h[2] > h[1] ? 2 : 1) : (h[2] > h[0] ? 2 : 0)) + 1;
      const p = spec.peakHz(f, k * f0);
      trk.push(p > 0 ? 12 * Math.log2(p / k / 440) + 69 - fm : 0.0);
    }
    const E = env.length ? env : [1.0];
    let pk = 0;
    for (let i = 1; i < E.length; i++) if (E[i] > E[pk]) pk = i;
    let k75 = E.findIndex(v => v >= 0.75 * E[pk]);
    if (k75 < 0) k75 = 0;
    const attack = (k75 + 1) / FPS;
    let fade = 0.0;
    if (E.length - pk >= 5) {
      const k6 = pk + pyRound(0.6 * (E.length - 1 - pk));
      const lv = mean64(E.slice(Math.max(pk, k6 - 1), k6 + 2));
      fade = 20 * Math.log10(lv / E[pk] + 1e-9) / Math.max(1 / FPS, (k6 - pk) / FPS);
    }
    let vd = 0.0, vr = 0.0;
    if (trk.length >= 24) {
      const w = 9, N = trk.length, pad = new Float64Array(N + 2 * w);
      for (let i = 0; i < N + 2 * w; i++) pad[i] = trk[Math.min(N - 1, Math.max(0, i - w))];
      const r = [];
      for (let i = w; i < N - w; i++) {                       // np.convolve(..., mode='same')[w:-w], then [w:-w]
        let s = 0;
        for (let j = 0; j <= 2 * w; j++) s += pad[i + j] * (1 / (2 * w + 1));
        r.push(trk[i] - s);
      }
      const depth = Math.sqrt(mean64(r.map(v => v * v))) * Math.sqrt(2);
      let cross = 0;
      for (let i = 1; i < r.length; i++) if (r[i] * r[i - 1] < 0) cross++;
      const rate = cross / 2 / (r.length / FPS);
      if (depth >= 0.1 && depth < 1.5 && rate >= 3.5 && rate <= 8.5) { vd = depth; vr = rate; }
    }
    const dur = t1 - t0;
    let fam = attack >= 0.12 ? 1 : (fade < -9 || dur < 0.35) ? 0 : 2;
    if (fam === 0 && vd > 0) fam = 2;
    const hollow = ev + od > 0 ? 1 - Math.min(1.0, 2 * ev / (ev + od)) : 0.0;
    segs.push([t0, t1, midi, amp, br.length ? mean64(br) : 0.0, nz.length ? mean64(nz) : 0.0, fam, attack, fade,
               vd, vr, hollow, E[pk], [tb, off, ab]]);
  }
  return segs;
}
