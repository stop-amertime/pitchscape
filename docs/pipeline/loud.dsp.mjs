// The loudness stage's work on one stem (a worker each): how loud each note is along its path, how much noise is heard
// there and how much of the whole stem is noise, where it strikes, and whether a note is a harmonic echo of a lower
// note or the same key still ringing. Worked out by eye on 15 recordings in the Contour Lab (spike-timbre/), against
// the aligned score of the Goldberg Aria for the echo and ringing tests (Basic Pitch's notes on a harmonic of a lower
// note: its partial over that note's neighbouring partials, AUC 0.91; a re-struck key's partials rise at its onset).
//
// The grid: librosa.cqt (cqt.dsp.mjs) at Basic Pitch's own resolution (3 bins a semitone from 27.5 Hz, hop 256 at
// 22.05 kHz), in dB below the stem's loud level (the 99.5th percentile of its frames' maxima), over 72 dB: 0..1.
// librosa.decompose.hpss (margin 2) splits it into tone, strikes and what is left (noise). A bit of noise or strike
// is heard by how close it comes to the loudest sound within 3 semitones (simultaneous masking): 1 as loud, 0 at
// 36 dB below; smoothed a little so it prints as clouds, not specks.
import FFT from './vendor/fft.mjs';
import {cqt, hpss} from './cqt.dsp.mjs';
import {pyRound} from './ear.dsp.mjs';

const P = 264, CQT_FPS = 22050 / 256, RANGE = 72, SHARE_DB = 36, REACH = 9, LOUD = 0.4;
export const STRIKE_BANDS = 11;                          // strikes: 8-semitone bands (24 bins) across the grid
const DT = 512 / 22050;                                  // the page's frames: two of the grid's

function blur1(src, n, m, stride, inner, sigma) {        // a Gaussian along one axis of an n x m grid (the Lab's)
  if (sigma <= 0) return src;
  const r = Math.ceil(sigma * 2.5), w = [];
  for (let i = -r; i <= r; i++) w.push(Math.exp(-i * i / (2 * sigma * sigma)));
  const out = new Float32Array(src.length);
  for (let a = 0; a < n; a++) for (let b = 0; b < m; b++) {
    let acc = 0, ws = 0;
    for (let i = -r; i <= r; i++) { const bb = b + i; if (bb < 0 || bb >= m) continue; acc += src[a * stride + bb * inner] * w[i + r]; ws += w[i + r]; }
    out[a * stride + b * inner] = acc / ws;
  }
  return out;
}
const smooth = (D, nF, sp, st) => blur1(blur1(D, nF, P, P, 1, sp), P, nF, 1, P, st);

/** numpy.interp */
function interp(x, xp, fp) {
  if (x <= xp[0]) return fp[0];
  if (x >= xp[xp.length - 1]) return fp[fp.length - 1];
  let lo = 0, hi = xp.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (xp[mid] <= x) lo = mid; else hi = mid; }
  return fp[lo] + (fp[hi] - fp[lo]) * (x - xp[lo]) / (xp[hi] - xp[lo]);
}

/** One stem. y: its mono mix at 22.05 kHz; F: the page's frame count; notes: this stem's notes as
 * [t0, t1, midi, [times, semitone offsets]] (their samples are pack_curves', every DT from t0 to t1); line: a pitch
 * track on the page's frames (Hz, 0 where silent) or null. Returns per note sample {lvl, nz} (level and noise heard,
 * 0..1), per page frame the stem's noise share (noise power over all, +-0.25 s), the line's level and noise, and
 * strikes (F x STRIKE_BANDS: the most strike heard in each band). */
export async function stemLoudness(y, F, notes, line) {
  const {C, nF} = await cqt(y);
  const maxes = new Float64Array(nF);
  for (let t = 0; t < nF; t++) { let m = 0; for (let p = 0; p < P; p++) m = Math.max(m, C[t * P + p]); maxes[t] = m; }
  const sorted = Float64Array.from(maxes).sort(), k = (nF - 1) * 0.995, k0 = Math.floor(k);
  const ref = (sorted[k0] + (sorted[Math.min(nF - 1, k0 + 1)] - sorted[k0]) * (k - k0)) || 1;
  const {P: Pc, R} = hpss(C, nF, P);
  const u = x => Math.min(1, Math.max(0, (20 * Math.log10(x / ref + 1e-9) + RANGE) / RANGE));
  const A = Float32Array.from(C, u), Ur = Float32Array.from(R, u), Up = Float32Array.from(Pc, u);
  const M = new Float32Array(A.length);                       // the loudest sound within 3 semitones
  for (let t = 0; t < nF; t++) for (let p = 0; p < P; p++) {
    let m = 0; for (let d = -REACH; d <= REACH; d++) { const q = p + d; if (q >= 0 && q < P && A[t * P + q] > m) m = A[t * P + q]; }
    M[t * P + p] = m;
  }
  const heard = L => {
    const D = new Float32Array(L.length);
    for (let i = 0; i < L.length; i++) D[i] = M[i] > 0 ? Math.max(0, 1 + (L[i] - M[i]) * RANGE / SHARE_DB) : 0;
    return D;
  };
  const Dn = smooth(heard(Ur), nF, 3, 2), Dp = smooth(heard(Up), nF, 1, 0.5);

  // the stem's noise share: residual power over all power, over half a second
  const lin = v => v > 0 ? 10 ** ((v * RANGE - RANGE) / 10) : 0;
  const en = new Float64Array(nF), ea = new Float64Array(nF);
  for (let t = 0; t < nF; t++) for (let p = 0; p < P; p++) { en[t] += lin(Ur[t * P + p]); ea[t] += lin(A[t * P + p]); }
  const w = Math.round(0.25 * CQT_FPS), share = new Float32Array(F);
  for (let f = 0; f < F; f++) {
    const t = Math.min(nF - 1, 2 * f);
    let a = 0, b = 0;
    for (let g = Math.max(0, t - w); g <= Math.min(nF - 1, t + w); g++) { a += en[g]; b += ea[g]; }
    share[f] = b ? a / b : 0;
  }

  // strikes, by band, where the sound is above the floor the Lab drew from (0.4: 43 dB below the loud level)
  const strikes = new Float32Array(F * STRIKE_BANDS);
  for (let f = 0; f < F; f++) for (const t of [2 * f, 2 * f + 1]) {
    if (t >= nF) continue;
    for (let p = 0; p < P; p++) {
      const i = t * P + p;
      if (M[i] <= LOUD) continue;
      const b = Math.min(STRIKE_BANDS - 1, Math.floor(p / 24)), o = f * STRIKE_BANDS + b;
      if (Dp[i] > strikes[o]) strikes[o] = Dp[i];
    }
  }

  // a note sample: its level is the loudest of the three bins around its (bent) pitch, its noise the noise heard there
  const at = (t, midi) => {
    const fr = Math.min(nF - 1, Math.max(0, Math.round(t * CQT_FPS))), b = (midi - 21) * 3, p = Math.round(b);
    if (p < 0 || p >= P) return [0, 0];
    let l = 0; for (let d = -1; d <= 1; d++) { const q = p + d; if (q >= 0 && q < P) l = Math.max(l, A[fr * P + q]); }
    return [l, M[fr * P + p] > LOUD ? Dn[fr * P + p] : 0];
  };
  const lvl = [], nz = [];
  for (const [t0, t1, midi, [tb, off]] of notes) {
    const n = Math.max(2, pyRound((t1 - t0) / DT) + 1);
    for (let j = 0; j < n; j++) {
      const t = t0 + (t1 - t0) * j / (n - 1), [l, z] = at(t, midi + interp(t, tb, off));
      lvl.push(l); nz.push(z);
    }
  }
  let lineLvl = null, lineNz = null;
  if (line) {
    lineLvl = new Float32Array(F); lineNz = new Float32Array(F);
    for (let f = 0; f < F; f++) {
      if (!(line[f] > 0)) continue;
      const [l, z] = at(f * DT, 69 + 12 * Math.log2(line[f] / 440));
      lineLvl[f] = l; lineNz[f] = z;
    }
  }
  return {lvl: Float32Array.from(lvl), nz: Float32Array.from(nz), share, strikes, lineLvl, lineNz};
}

/** The echo and ringing tests for one stem's notes, on its mono mix at 44.1 kHz (an STFT of 4096 every 512, hann, as
 * librosa.stft, read only at the frames asked for). notes: [t0, t1, midi, amplitude]. Returns per note
 * [ex, k, rise, ring]: ex, how far (dB) its partial stands above the lower note's neighbouring partials when it is on
 * that note's k-th harmonic (NaN if it is on none: a played note stands out, an echo does not); rise, how much its own
 * first two partials jump at its onset (dB); ring, the index of a note at its pitch still sounding when it starts
 * (begun at least 30 ms before, ending no more than 100 ms before), or -1. */
export function noteCues(y, notes) {
  const SR = 44100, N = 4096, HOP = 512, K = N / 2 + 1, n = y.length, nT = 1 + Math.floor(n / HOP);
  const fft = new FFT(N), fr = new Float64Array(N), X = fft.createComplexArray(), win = new Float64Array(N), cache = new Map();
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N);
  const col = t => {
    let c = cache.get(t);
    if (c) return c;
    for (let i = 0; i < N; i++) { const s = t * HOP - N / 2 + i; fr[i] = s >= 0 && s < n ? y[s] * win[i] : 0; }
    fft.realTransform(X, fr);
    c = new Float32Array(K);
    for (let q = 0; q < K; q++) c[q] = Math.hypot(X[2 * q], X[2 * q + 1]);
    cache.set(t, c);
    return c;
  };
  const amp = (f, t) => {                                   // the peak within 1.5 % of f
    const b = f / SR * N, lo = Math.floor(b * 0.985), hi = Math.ceil(b * 1.015) + 1;
    if (!(hi < K) || t < 0 || t >= nT) return NaN;
    const c = col(t); let m = -Infinity; for (let q = lo; q < hi; q++) m = Math.max(m, c[q]); return m;
  };
  const nanmean = xs => { const v = xs.filter(Number.isFinite); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN; };
  const hz = m => 440 * 2 ** ((m - 69) / 12);
  const out = [];
  notes.forEach(([t0, , m], i) => {
    const f0 = Math.round(t0 * SR / HOP);
    let best = null;
    for (const q of notes) {
      if (!(q[2] < m - 11 && q[0] <= t0 + 0.05 && q[1] >= t0 + 0.05)) continue;
      for (let k = 2; k <= 8; k++) if (Math.abs(m - q[2] - 12 * Math.log2(k)) <= 0.5) { if (!best || q[3] > best[0]) best = [q[3], q, k]; break; }
    }
    let ex = NaN, kk = 0;
    if (best) {
      const [, q, k] = best, fp = hz(q[2]), t = f0 + 4;
      const nb = nanmean([amp((k - 1) * fp, t), amp((k + 1) * fp, t)]);
      ex = 20 * Math.log10((amp(k * fp, t) + 1e-9) / (nb + 1e-9)); kk = k;
    }
    const fc = hz(m), bef = [], aft = [];
    for (const h of [1, 2]) { for (let g = f0 - 8; g < f0 - 2; g++) bef.push(amp(h * fc, g)); for (let g = f0; g < f0 + 5; g++) aft.push(amp(h * fc, g)); }
    let rise = 20 * Math.log10((nanmean(aft) + 1e-9) / (nanmean(bef) + 1e-9));
    if (!Number.isFinite(rise)) rise = 0;
    let ring = -1;
    notes.forEach((q, j) => { if (j !== i && Math.abs(q[2] - m) < 0.5 && q[0] < t0 - 0.03 && q[1] >= t0 - 0.1) ring = j; });
    out.push([Number.isFinite(ex) ? ex : NaN, kk, rise, ring]);
  });
  return out;
}
