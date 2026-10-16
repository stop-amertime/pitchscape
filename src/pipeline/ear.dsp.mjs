// The CPU work of the width stage (ear.mjs), apart so worker threads can run it (worker.mjs): server/pipeline.py's
// Ear, excitation patterns from one stem (Glasberg & Moore's roex auditory filters, the lower skirt flattening as the
// level rises; the spectrum read at the resolutions of ISO 532-2), and Ear.widths, how far either side of a sound
// its excitation stays within 1, 3 and 10 dB of its peak; and tone_widths, the same of a pure tone at a level the
// stem has there (Ear.level), for notes, whose stem may hold a whole chord.
//
// The Python keeps the pattern on librosa's 4097-point grid (2049 bins x frames, float32). Each ISO 532-2 band lands
// only on the grid bins its own, coarser FFT reaches (every 2nd bin below 80 Hz ... every 64th above 4050 Hz), about
// 90 bins in all, and every other bin stays zero; so here a pattern is just those bins, frame by frame. Sums over
// the grid skip zeros, which changes nothing but the order of additions.
import FFT from './vendor/fft.mjs';

export const SR = 22050, HOP = 512, N = 4096;
export const EAR_DB = [1, 3, 10];          // widths at these drops below the peak
export const EAR_SPAN = 16;                // semitones either side of a sound that its spread is followed to
// ISO 532-2: (from Hz, to Hz, window ms)
export const BANDS = [[0, 80, 64], [80, 500, 32], [500, 1250, 16], [1250, 2540, 8], [2540, 4050, 4], [4050, SR / 2, 2]];
const P_REF2 = 2e-5 * 2e-5;                // pipeline.py P_REF ** 2
const f32 = Math.fround;

/** Python's round(): halves to even. */
export function pyRound(x) {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 && r % 2 ? r - 1 : r;
}

/** The ear's filter bandwidth at f Hz (Glasberg & Moore 1990). */
export const erb = f => 24.7 * (4.37 * f / 1000 + 1);

/** numpy's rfftfreq(n, 1 / SR), as librosa.fft_frequencies. */
const freqs = n => { const v = 1 / (n * (1 / SR)), f = new Float64Array(n / 2 + 1); for (let k = 0; k <= n / 2; k++) f[k] = k * v; return f; };
const GRID = freqs(N);                     // Ear.f

/** numpy searchsorted(a, v) (side 'left'): the first index whose value is >= v. */
function searchsorted(a, v) {
  let lo = 0, hi = a.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] < v) lo = m + 1; else hi = m; }
  return lo;
}

// Each band's window and FFT, and which of its bins it keeps and where they land on the grid
export const LAYOUT = (() => {
  const bands = [], gi = [];
  for (const [lo, hi, ms] of BANDS) {
    const L = Math.floor(pyRound(ms / 1000 * SR) / 2) * 2;
    const n = 1 << Math.max(5, 32 - Math.clz32(L - 1));
    const hop = Math.max(1, Math.min(L >> 1, HOP));          // half a window, at least once per page frame
    const w = new Float64Array(n), lpad = (n - L) >> 1;    // np.hanning(L), centred in the frame (librosa pad_center)
    let wsum = 0;
    for (let i = 0; i < L; i++) { w[lpad + i] = 0.5 + 0.5 * Math.cos(Math.PI * (1 - L + 2 * i) / (L - 1)); wsum += w[lpad + i]; }
    const fb = freqs(n), keep = [];
    for (let k = 0; k < fb.length; k++) {
      if (fb[k] >= lo && fb[k] < hi) {
        keep.push(k);
        gi.push(Math.min(N / 2, Math.max(0, pyRound(fb[k] / (SR / N)))));
      }
    }
    bands.push({n, L, hop, w, wsum, keep, c0: gi.length - keep.length, scale: 1.5 * n / L});
  }
  const C = gi.length, GI = Int32Array.from(gi);
  for (let c = 1; c < C; c++) if (GI[c] <= GI[c - 1]) throw new Error('ear: grid bins out of order');
  // the last kept bin at or below each grid bin (-1: none), to read the grid's cumulative sum from the kept bins'
  const lastLE = new Int32Array(N / 2 + 1);
  for (let j = 0, c = -1; j <= N / 2; j++) { while (c + 1 < C && GI[c + 1] <= j) c++; lastLE[j] = c; }
  // each kept bin's frequency, and the grid bins either side of the ERB around it (Ear.widths' a and b)
  const fi = Float64Array.from(GI, g => GRID[g]);
  const ea = new Int32Array(C), eb = new Int32Array(C);
  for (let c = 0; c < C; c++) {
    const e = erb(fi[c]);
    ea[c] = Math.min(N / 2, Math.max(0, searchsorted(GRID, fi[c] - e / 2) - 1));
    eb[c] = Math.min(N / 2, Math.max(0, searchsorted(GRID, fi[c] + e / 2)));
  }
  return {bands, C, gi: GI, lastLE, fi, ea, eb};
})();

/** Frames from p0 to p1 of the excitation pattern of a stem: the kept bins' mean-square pressure, averaged over each
 * page frame. y: the stem's samples from sample `from` (already scaled to its level in a 70 dB SPL mix: y * gain in
 * float32), n: the stem's length. Returns Float32Array((p1 - p0) * C), frame-major. As Ear.__init__: librosa.stft
 * with each band's window (centred, zero padding), |X| in complex64. */
export function pattern(y, from, n, p0, p1) {
  const {bands, C} = LAYOUT, F = 1 + Math.floor(n / HOP), R = p1 - p0;
  const P = new Float32Array(R * C);
  for (const B of bands) {
    const {n: nf, L, hop, w, wsum, keep, c0, scale} = B, K = keep.length, lpad = (nf - L) >> 1;
    const fft = new FFT(nf), inp = new Float64Array(nf), out = fft.createComplexArray();
    const acc = new Float64Array(R * K), cnt = new Int32Array(R);
    const nfr = 1 + Math.floor(n / hop);
    const m = i => Math.min(F - 1, Math.max(0, pyRound(i * hop / HOP)));
    let i = Math.max(0, Math.floor((p0 * HOP - HOP) / hop) - 2);
    while (i > 0 && m(i) >= p0) i--;
    while (i < nfr && m(i) < p0) i++;
    for (let mi; i < nfr && (mi = m(i)) < p1; i++) {
      // the window's own samples (the frame's padding either side of it stays zero)
      const s0 = i * hop - nf / 2 + lpad;
      if (Math.max(s0, 0) < from || Math.min(s0 + L, n) > from + y.length) throw new Error('ear: chunk too short');
      if (s0 >= 0 && s0 + L <= n) {
        for (let k = 0, o = s0 - from; k < L; k++) inp[lpad + k] = y[o + k] * w[lpad + k];
      } else {
        for (let k = 0; k < L; k++) { const s = s0 + k; inp[lpad + k] = s >= 0 && s < n ? y[s - from] * w[lpad + k] : 0; }
      }
      fft.realTransform(out, inp);
      const r = mi - p0;
      cnt[r]++;
      for (let q = 0; q < K; q++) {
        const k = keep[q];
        // |X| as librosa stores it (complex64), then the power in float64 as numpy promotes it
        const re = f32(out[2 * k]), im = f32(out[2 * k + 1]);
        const a = f32(Math.sqrt(re * re + im * im)) * 2 / wsum;
        acc[r * K + q] += a * a / 2 / scale;
      }
    }
    for (let r = 0; r < R; r++) {
      const c = Math.max(1, cnt[r]);
      for (let q = 0; q < K; q++) P[r * C + c0 + q] = acc[r * K + q] / c;
    }
  }
  return P;
}

const MID = EAR_SPAN * 8, NK = 2 * MID + 1;
const P51K = 4 * 1000 / erb(1000);
const STEP = Float64Array.from({length: NK}, (_, k) => 2 ** ((k - MID) / 96));
const ZERO = [0, 0, 0, 0, 0, 0];

/** excitation_widths: (down, up) in semitones from hz at each drop in EAR_DB of the excitation of components c0..c1-1
 * at fi Hz with mean-square pressures P, each X[c] - 51 (float32) dB SPL per ERB around it. E: scratch, NK values. */
function excitationWidths(fi, P, X, c0, c1, hz, E) {
  E.fill(NaN);
  const level = k => {                                           // the excitation at the k-th filter, dB SPL
    if (E[k] === E[k]) return E[k];
    const fc = hz * STEP[k], p51 = 4 * fc / erb(fc), lowSlope = 0.38 * (p51 / P51K);
    let s = 0;
    for (let c = c0; c < c1; c++) {
      const Pc = P[c];
      if (!(Pc > 0)) continue;
      const f = fi[c];
      const p = f < fc ? Math.max(0.1 * p51, p51 - lowSlope * X[c]) : p51;
      const pg = p * (Math.abs(f - fc) / fc);
      s += (1 + pg) * Math.exp(-pg) * Pc;
    }
    return E[k] = 10 * Math.log10(s / P_REF2 + 1e-12);
  };
  let kp = MID - 8;                                              // the sound's own peak, within a semitone of it
  for (let k = MID - 7; k <= MID + 8; k++) if (level(k) > level(kp)) kp = k;
  const out = [];
  for (const d of EAR_DB) {
    const floor = level(kp) - d;
    let j = kp;
    while (j > 0 && level(j - 1) >= floor && level(j - 1) <= level(j) + 0.5) j--;
    let dn = (MID - j) / 8;
    if (j > 0 && level(j - 1) < floor && level(j) > level(j - 1)) dn += (level(j) - floor) / (level(j) - level(j - 1)) / 8;
    j = kp;
    while (j < NK - 1 && level(j + 1) >= floor && level(j + 1) <= level(j) + 0.5) j++;
    let up = (j - MID) / 8;
    if (j < NK - 1 && level(j + 1) < floor && level(j) > level(j + 1)) up += (level(j) - floor) / (level(j) - level(j + 1)) / 8;
    out.push(Math.max(0, dn), Math.max(0, up));
  }
  return out;
}

/** The float32 level in dB SPL of a float32 mean-square pressure p (numpy's 10 * log10(p / P_REF ** 2 + 1e-12)). */
const dB32 = p => f32(10 * f32(Math.log10(f32(f32(p / f32(P_REF2)) + f32(1e-12)))));

/** Ear.widths for one frame of a pattern: the stem's own spectrum. Pf: the frame's kept bins (C values), cum: their
 * running sum in float32 (the grid's np.cumsum). */
function widthsAt(Pf, cum, hz, E, X) {
  const {C, gi, lastLE, fi, ea, eb} = LAYOUT;
  const fc0 = hz * STEP[0], fcN = hz * STEP[NK - 1];
  const lo = searchsorted(GRID, fc0 / 1.6), hi = searchsorted(GRID, Math.min(fcN * 1.6, SR / 2 - 1));
  if (hi - lo < 2) return ZERO;
  // the kept bins inside the grid's [lo, hi) that carry power
  let c0 = 0;
  while (c0 < C && gi[c0] < lo) c0++;
  let c1 = c0, any = false;
  while (c1 < C && gi[c1] < hi) { if (Pf[c1] > 0) any = true; c1++; }
  if (!any) return ZERO;
  // each component's level in dB SPL per ERB around it (float32, as numpy computes it from the float32 cumsum)
  const at = j => lastLE[j] >= 0 ? cum[lastLE[j]] : 0;
  for (let c = c0; c < c1; c++) X[c] = f32(dB32(f32(at(eb[c]) - at(ea[c]))) - 51);
  return excitationWidths(fi, Pf, X, c0, c1, hz, E);
}

const ONE_F = new Float64Array(1), ONE_P = new Float64Array(1), ONE_X = new Float32Array(1);

/** tone_widths at Ear.level: a pure tone at hz, at the level the stem has within one ERB around it, alone. */
function toneAt(cum, hz, E) {
  const {lastLE} = LAYOUT, at = j => lastLE[j] >= 0 ? cum[lastLE[j]] : 0, e = erb(hz);
  const a = Math.min(N / 2, Math.max(0, searchsorted(GRID, hz - e / 2) - 1));
  const b = Math.min(N / 2, Math.max(0, searchsorted(GRID, hz + e / 2)));
  const p = f32(at(b) - at(a));
  if (!(p > 0)) return ZERO;
  const L = dB32(p);
  ONE_F[0] = hz;
  ONE_P[0] = P_REF2 * 10 ** (L / 10);
  ONE_X[0] = f32(L - 51);
  return excitationWidths(ONE_F, ONE_P, ONE_X, 0, 1, hz, E);
}

/** One chunk of the stage: the pattern of frames p0..p1-1 of a stem, and at each (frame, hz) asked for there the
 * widths: of the stem's own excitation (Ear.widths), or with `tone` of a pure tone at the stem's level there
 * (tone_widths at Ear.level). y: the stem's samples from sample `from` at 22.05 kHz (the frames' reach: see
 * ear.mjs), n: its length, gain: Ear's gain. Returns Float64Array(frames.length * 6). */
export function earChunk(y, from, n, gain, p0, p1, frames, hz, tone = false) {
  const g = f32(gain), ys = new Float32Array(y.length);
  for (let i = 0; i < y.length; i++) ys[i] = y[i] * g;           // (y22 * gain) in float32
  const P = pattern(ys, from, n, p0, p1), C = LAYOUT.C;
  const out = new Float64Array(frames.length * 6);
  const cum = new Float32Array(C), E = new Float64Array(NK), X = new Float32Array(C);
  let have = -1;
  for (let q = 0; q < frames.length; q++) {
    const f = frames[q];
    if (!(hz[q] > 0)) continue;
    const Pf = P.subarray((f - p0) * C, (f - p0 + 1) * C);
    if (f !== have) {
      let s = 0;
      for (let c = 0; c < C; c++) cum[c] = s = f32(s + Pf[c]);
      have = f;
    }
    out.set(tone ? toneAt(cum, hz[q], E) : widthsAt(Pf, cum, hz[q], E, X), q * 6);
  }
  return out;
}
