// The CPU work of the bass stage (bass.mjs), apart so worker threads can run it (worker.mjs): librosa 0.11's pyin
// (the YIN difference function, its beta-distributed thresholds and Boltzmann prior over troughs, the voicing HMM and
// librosa.sequence.viterbi), librosa.feature.rms, numpy's percentile, and server/pipeline.py's Spec / brightness /
// env_follow. The voice stage (voice.dsp.mjs) shares the librosa pieces.
//
// numpy computes much of this in float32 (the stems are float32): where its order of operations is known (sums,
// cumulative sums, the float32 arithmetic numpy 2's promotion rules give), it is reproduced with Math.fround and
// numpy's pairwise summation; FFTs are done in double (numpy's float32 FFT cannot be reproduced bit for bit).
import FFT from './vendor/fft.mjs';

export const SR = 22050, HOP = 512;
const f32 = Math.fround;
const TINY64 = 2.2250738585072014e-308;                       // np.finfo(float64).tiny (librosa util.tiny)
const LOG_TINY64 = Math.log(TINY64);

/** numpy's np.round / Python's round(): halves to even. */
export function roundEven(x) {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 && r % 2 ? r - 1 : r;
}

/** numpy's pairwise summation (np.sum / np.add.reduce along a contiguous axis) of a[i0..i1), in float32 (f = fround)
 * or double (f = identity). */
export function pairwiseSum(a, i0 = 0, i1 = a.length, f = f32) {
  const n = i1 - i0;
  if (n < 8) {
    let r = 0;
    for (let i = i0; i < i1; i++) r = f(r + a[i]);
    return r;
  }
  if (n <= 128) {
    const r = [a[i0], a[i0 + 1], a[i0 + 2], a[i0 + 3], a[i0 + 4], a[i0 + 5], a[i0 + 6], a[i0 + 7]];
    let i = i0 + 8;
    for (const end = i0 + n - n % 8; i < end; i += 8) for (let j = 0; j < 8; j++) r[j] = f(r[j] + a[i + j]);
    let res = f(f(f(r[0] + r[1]) + f(r[2] + r[3])) + f(f(r[4] + r[5]) + f(r[6] + r[7])));
    for (; i < i1; i++) res = f(res + a[i]);
    return res;
  }
  let n2 = n >> 1;
  n2 -= n2 % 8;
  return f(pairwiseSum(a, i0, i0 + n2, f) + pairwiseSum(a, i0 + n2, i1, f));
}

/** np.percentile(a, q) (method 'linear', q a Python number) of a float32 array: the result in float32, as numpy 2
 * interpolates (_lerp) in the array's dtype. */
export function percentile(a, q) {
  const s = Float32Array.from(a).sort(), n = s.length;
  const vi = (n - 1) * (q / 100), lo = Math.floor(vi), hi = Math.min(lo + 1, n - 1);
  const g = vi - lo, gf = f32(g);
  const A = s[lo], B = s[hi], d = f32(B - A);
  return g >= 0.5 ? f32(B - f32(d * f32(1 - g))) : f32(A + f32(d * gf));
}

/** librosa.feature.rms(y, frame_length, hop_length, center=True) (zero padding): float32, as librosa computes it
 * (the mean of float32 squares by numpy's pairwise sum). Frames f0..f1 (default all: 1 + len // hop). */
export function rms(y, {frame = 2048, hop = HOP, f0 = 0, f1 = 1 + Math.floor(y.length / hop), from = 0, n = y.length} = {}) {
  const half = frame >> 1, sq = new Float32Array(frame), out = new Float32Array(f1 - f0);
  for (let f = f0; f < f1; f++) {
    const s0 = f * hop - half;
    for (let i = 0; i < frame; i++) {
      const k = s0 + i, v = k >= 0 && k < n ? y[k - from] : 0;
      sq[i] = f32(v * v);
    }
    out[f - f0] = f32(Math.sqrt(f32(pairwiseSum(sq) / frame)));
  }
  return out;
}

/** pipeline.py env_follow on a float32 array: numpy 2 does it in float32 (e becomes a float32 scalar). */
export function envFollow(x, up = 0.6, down = 0.25) {
  const out = new Float32Array(x.length), U = f32(up), D = f32(down);
  let e = 0;
  for (let i = 0; i < x.length; i++) {
    const v = x[i];
    e = f32(e + f32((v > e ? U : D) * f32(v - e)));
    out[i] = e;
  }
  return out;
}

// ------------------------------------------------------------------ STFT magnitudes (librosa.stft, abs)
const windows = {};
/** scipy.signal.get_window('hann', N) (periodic), as scipy computes it: 0.5 + 0.5 cos(linspace(-pi, pi, N + 1)). */
export function hann(N) {
  if (windows[N]) return windows[N];
  const w = new Float64Array(N), step = (Math.PI - -Math.PI) / N;
  for (let i = 0; i < N; i++) w[i] = 0.5 + 0.5 * Math.cos(i * step + -Math.PI);
  return windows[N] = w;
}
const ffts = {};
const fftOf = N => ffts[N] ??= new FFT(N);

/** |librosa.stft(y, n_fft=N, hop_length=hop, center=True)| (zero padding) at frame f, into out (Float32Array, N/2 + 1
 * bins): librosa windows the float32 frame in double and stores the transform as complex64; numpy's abs of that is
 * float32. y holds samples from `from` on; n: the signal's length. */
export function stftFrame(y, f, N, hop, out, from = 0, n = y.length) {
  const fft = fftOf(N), w = hann(N), inp = stftFrame.inp?.length === N ? stftFrame.inp : (stftFrame.inp = new Float64Array(N));
  const spec = stftFrame.spec?.length === 2 * N ? stftFrame.spec : (stftFrame.spec = fft.createComplexArray());
  const s0 = f * hop - (N >> 1);
  for (let i = 0; i < N; i++) { const k = s0 + i; inp[i] = k >= 0 && k < n ? w[i] * y[k - from] : 0; }
  fft.realTransform(spec, inp);
  for (let k = 0; k <= N / 2; k++) {                          // (Math.hypot allocates in V8)
    const re = f32(spec[2 * k]), im = f32(spec[2 * k + 1]);
    out[k] = f32(Math.sqrt(re * re + im * im));
  }
  return out;
}

/** pipeline.py Spec(y) (n_fft 4096, hop 512) and brightness(spec, f, hz, n, split) at frames fr (with pitches hz,
 * float32), for frames whose samples y holds (from `from`; n: the signal's length). Returns Float32Array of
 * brightness per requested frame, as stored in the float32 arrays. */
export function brightness(y, from, n, fr, hz, nHarm, split, nFft = 4096, hop = HOP) {
  const M = new Float32Array(nFft / 2 + 1), out = new Float32Array(fr.length);
  const nFrames = 1 + Math.floor(n / hop), binhz = f32(SR / nFft), top = M.length - 1;
  const at = h => {                                           // Spec.at(f, h, width=1); h float32
    if (h <= 0) return 0;
    const b = roundEven(f32(h / binhz));
    if (b < 1 || b >= top) return 0;
    let m = -Infinity;
    for (let k = Math.max(1, b - 1); k <= b + 1; k++) if (M[k] > m) m = M[k];
    return m;
  };
  for (let i = 0; i < fr.length; i++) {
    if (fr[i] >= nFrames) continue;
    stftFrame(y, fr[i], nFft, hop, M, from, n);
    let tot = 0, part = 0;
    for (let k = 1; k <= nHarm; k++) {
      const a = at(f32(k * hz[i]));
      tot += a;
      if (k >= split) part += a;
    }
    out[i] = tot > 0 ? part / tot : 0;
  }
  return out;
}

// ------------------------------------------------------------------ pyin
/** pyin's constants as pipeline.py bass_line calls it (fmin 30, fmax 400, sr 22050, frame_length 4096, hop 512), with
 * librosa 0.11's defaults (100 thresholds, beta (2, 18), Boltzmann 2, resolution 0.1, max_transition_rate 35.92,
 * switch_prob 0.01, no_trough_prob 0.01). */
export function pyinParams({fmin = 30, fmax = 400, sr = SR, frame = 4096, hop = HOP} = {}) {
  const nThr = 100, binsPerSemi = Math.ceil(1 / 0.1);
  const nBins = Math.floor(12 * binsPerSemi * Math.log2(fmax / fmin)) + 1;
  const thresholds = Float64Array.from({length: nThr + 1}, (_, i) => i === nThr ? 1 : i * (1 / nThr));
  // scipy.stats.beta.cdf(thresholds, 2, 18): for whole a, b the regularised incomplete beta is a binomial tail
  const cdf = Array.from(thresholds, x => {
    const m = 2 + 18 - 1;
    let s = 0, c = 1;                                          // c: C(m, j)
    for (let j = 0; j <= m; j++) {
      if (j >= 2) s += c * x ** j * (1 - x) ** (m - j);
      c = c * (m - j) / (j + 1);
    }
    return s;
  });
  const betaProbs = Float64Array.from({length: nThr}, (_, i) => cdf[i + 1] - cdf[i]);
  const maxSemis = roundEven(35.92 * 12 * hop / sr);
  return {fmin, fmax, sr, frame, hop, nThr, binsPerSemi, nBins, thresholds, betaProbs,
          minP: Math.floor(sr / fmax), maxP: Math.min(Math.ceil(sr / fmin), frame - 1),
          width: maxSemis * binsPerSemi + 1, boltzmann: 2, noTrough: 0.01, switchProb: 0.01};
}

let acfFft = null;

/** pyin's observations for frames f0..f1 of y (centred, zero padding): per frame, the voiced pitch bins with their
 * probabilities (librosa's __pyin_helper, a later trough landing in the same bin overwriting an earlier one) and the
 * voiced probability. y holds samples from `from` on; n: the signal's length.
 * Returns {off: Int32Array(f1 - f0 + 1), bin: Int16Array, prob: Float64Array, vp: Float64Array(f1 - f0)}. */
export function pyinObs(y, from, n, f0, f1, opts = {}) {
  const P = pyinParams(opts), N = P.frame, half = N >> 1, {minP, maxP, nThr, thresholds, betaProbs, nBins} = P;
  let L = 1;
  while (L < 2 * N - 1) L <<= 1;                               // scipy.fft.next_fast_len(2N - 1, real=True): 2N here
  if (!acfFft || acfFft.size !== L) acfFft = new FFT(L);
  const fft = acfFft, fin = new Float64Array(L), spec = fft.createComplexArray(), back = fft.createComplexArray();
  const x = new Float32Array(N), c = new Float32Array(N), d = new Float32Array(maxP + 1);
  const R = maxP - minP + 1, v = new Float64Array(R), shift = new Float64Array(R);
  const fact = k => (1 - Math.exp(-P.boltzmann)) / (1 - Math.exp(-P.boltzmann * k));
  const off = new Int32Array(f1 - f0 + 1), vp = new Float64Array(f1 - f0), bins = [], probs = [];
  const obs = new Float64Array(nBins + 1), touched = [];
  for (let j = f0; j < f1; j++) {
    off[j - f0] = bins.length;
    const s0 = j * P.hop - half;
    for (let i = 0; i < N; i++) { const k = s0 + i; x[i] = k >= 0 && k < n ? y[k - from] : 0; }
    // librosa.autocorrelate: rfft, |.|^2, irfft (numpy computes them in float32; here in double, rounded to float32)
    fin.fill(0);
    fin.set(x);
    fft.realTransform(spec, fin);
    fft.completeSpectrum(spec);
    for (let k = 0; k < L; k++) { spec[2 * k] = spec[2 * k] ** 2 + spec[2 * k + 1] ** 2; spec[2 * k + 1] = 0; }
    fft.inverseTransform(back, spec);
    const a0 = f32(back[0]);
    // _cumulative_mean_normalized_difference, in librosa's float32 steps
    let s = 0;
    for (let i = 0; i < N; i++) { s = f32(s + f32(x[i] * x[i])); c[i] = s; }
    d[0] = 0;
    for (let k = 1; k <= maxP; k++) d[k] = f32(f32(2 * f32(a0 - f32(back[2 * k]))) - c[k - 1]);
    s = 0;
    const cm = v;                                              // reuse: cm[k - 1] for k = minP..maxP
    let cs = 0;
    for (let k = 1; k <= maxP; k++) {
      cs = f32(cs + d[k]);
      if (k >= minP) cm[k - minP] = cs / k;
    }
    for (let r = 0; r < R; r++) v[r] = d[minP + r] / (cm[r] + TINY64);
    // _parabolic_interpolation (0 at both ends)
    shift[0] = shift[R - 1] = 0;
    for (let r = 1; r < R - 1; r++) {
      const a = v[r + 1] + v[r - 1] - 2 * v[r], b = (v[r + 1] - v[r - 1]) / 2;
      shift[r] = Math.abs(b) >= Math.abs(a) ? 0 : -b / a;
    }
    // troughs: librosa.util.localmin, the first lag a trough if under the second
    const tr = [];
    if (v[0] < v[1]) tr.push(0);
    for (let r = 1; r < R - 1; r++) if (v[r] < v[r - 1] && v[r] <= v[r + 1]) tr.push(r);
    if (v[R - 1] < v[R - 2]) tr.push(R - 1);
    if (!tr.length) { vp[j - f0] = 0; continue; }
    const T = tr.length, pr = new Float64Array(T), pos = new Int32Array(T);
    let gmin = 0;
    for (let i = 1; i < T; i++) if (v[tr[i]] < v[tr[gmin]]) gmin = i;
    // each threshold: the troughs under it, numbered in order, weighted by the Boltzmann prior; times the beta weight
    for (let t = 0; t < nThr; t++) {
      const thr = thresholds[t + 1];
      let cnt = 0;
      for (let i = 0; i < T; i++) if (v[tr[i]] < thr) pos[i] = cnt++; else pos[i] = -1;
      if (!cnt) continue;
      const fa = fact(cnt);
      for (let i = 0; i < T; i++) if (pos[i] >= 0) pr[i] += fa * Math.exp(-P.boltzmann * pos[i]) * betaProbs[t];
    }
    let below = 0;
    for (let t = 0; t < nThr; t++) if (!(v[tr[gmin]] < thresholds[t + 1])) below++;
    pr[gmin] += P.noTrough * pairwiseSum(betaProbs, 0, below, z => z);
    // candidates in period order; a later one in the same bin overwrites (numpy fancy assignment)
    for (const b of touched) obs[b] = 0;
    touched.length = 0;
    for (let i = 0; i < T; i++) {
      if (pr[i] === 0) continue;
      const period = minP + tr[i] + shift[tr[i]];
      const hz = P.sr / period;
      let b = roundEven(12 * P.binsPerSemi * Math.log2(hz / P.fmin));
      b = Math.min(nBins, Math.max(0, b));
      if (obs[b] === 0) touched.push(b);
      obs[b] = pr[i];
    }
    touched.sort((p, q) => p - q);
    let sum = 0;
    for (const b of touched) {
      if (b >= nBins || obs[b] === 0) continue;
      sum += obs[b];
      bins.push(b);
      probs.push(obs[b]);
    }
    vp[j - f0] = Math.min(1, Math.max(0, sum));
  }
  off[f1 - f0] = bins.length;
  return {off, bin: Int16Array.from(bins), prob: Float64Array.from(probs), vp};
}

/** For librosa.sequence.viterbi's dense step over a banded transition matrix: every previous state outside a target's
 * band counts value + log(tiny) (one constant), so the best of them is a range maximum of those sums. A sparse table
 * of (sum, first index) answers each range in two lookups; ties go to the lower state, as numpy's argmax. */
export class RangeMax {
  constructor(n) {
    this.n = n;
    this.levels = [];
    for (let len = 1; len <= n; len <<= 1) this.levels.push({val: new Float64Array(n), idx: new Int32Array(n)});
    this.log = new Int8Array(n + 1);
    for (let i = 2; i <= n; i++) this.log[i] = this.log[i >> 1] + 1;
  }

  build(prev, c) {
    const n = this.n, L0 = this.levels[0];
    for (let i = 0; i < n; i++) { L0.val[i] = prev[i] + c; L0.idx[i] = i; }
    for (let k = 1; k < this.levels.length; k++) {
      const A = this.levels[k - 1], B = this.levels[k], half = 1 << (k - 1);
      for (let i = 0; i + (1 << k) <= n; i++) {
        const j = i + half;
        if (A.val[j] > A.val[i]) { B.val[i] = A.val[j]; B.idx[i] = A.idx[j]; }
        else { B.val[i] = A.val[i]; B.idx[i] = A.idx[i]; }
      }
    }
  }

  /** The maximum of [a, b) (b > a); its first index is left in this.at. */
  max(a, b) {
    const k = this.log[b - a], L = this.levels[k], j = b - (1 << k);
    if (L.val[j] > L.val[a]) { this.at = L.idx[j]; return L.val[j]; }
    this.at = L.idx[a];
    return L.val[a];
  }

  /** (this.best, this.arg) becomes the better of itself and the range [a, b)'s maximum: the higher value, or on a tie
   * the lower state. */
  take(a, b) {
    if (b <= a) return;
    const v = this.max(a, b), i = this.at;
    if (v > this.best || (v === this.best && i < this.arg)) { this.best = v; this.arg = i; }
  }
}

/** librosa.sequence.viterbi (librosa 0.11) for a transition matrix made of B x B blocks of nB states, each block
 * banded (|p - q| <= h), the same decision as its dense loop: for each state the first (lowest) previous state of the
 * highest value + log transition, where a transition outside the band is logOut (log(0 + tiny)).
 * LT[from-block * B + to-block][q * (2h + 1) + (p - q + h)]: log transitions p -> q, laid out by target.
 * logObs(t, lp): fills lp (Float64Array(B * nB)) with log(prob + tiny) at step t. Returns the states (Uint16Array).
 * The band is searched in chunks of 16 states, skipping a chunk when its largest previous value plus its largest
 * transition (rounding is monotonic, so no sum in it can be larger) is below the best so far: exact, and about four
 * chunks in five are skipped on pYIN's sparse observations. */
export function viterbiBanded({T, B, nB, h, LT, logObs, logInit, logOut}) {
  const S = B * nB, W = 2 * h + 1, C = 16 /* c0 >> 4 below */, NC = Math.ceil(nB / C);
  // the largest transition into q from each chunk of the band
  const maxLT = LT.map(lt => {
    const m = new Float64Array(nB * NC).fill(-Infinity);
    for (let q = 0; q < nB; q++) for (let p = Math.max(0, q - h); p <= Math.min(nB - 1, q + h); p++) {
      const k = q * NC + Math.floor(p / C), v = lt[q * W + p - q + h];
      if (v > m[k]) m[k] = v;
    }
    return m;
  });
  let prev = new Float64Array(S), cur = new Float64Array(S);
  const ptr = new Uint16Array(T * S), lp = new Float64Array(S);
  logObs(0, lp);
  for (let i = 0; i < S; i++) prev[i] = lp[i] + logInit;
  const out = new RangeMax(S), cmax = new Float64Array(B * NC);
  const cv = new Int32Array(2 * B * NC), cc = new Int32Array(2 * B * NC), cb = new Float64Array(2 * B * NC);
  for (let t = 1; t < T; t++) {
    logObs(t, lp);
    let M = -Infinity, built = false;
    for (let i = 0; i < S; i++) if (prev[i] > M) M = prev[i];
    const outTop = M + logOut;                                 // no state outside a band can sum to more
    for (let v = 0; v < B; v++) for (let c = 0; c < NC; c++) {  // each whole chunk's largest previous value
      let m = -Infinity;
      for (let p = v * nB + c * C, e = v * nB + Math.min(nB, (c + 1) * C); p < e; p++) if (prev[p] > m) m = prev[p];
      cmax[v * NC + c] = m;
    }
    for (let w = 0; w < B; w++) for (let q = 0; q < nB; q++) {
      const j = w * nB + q, lo = Math.max(0, q - h), hi = Math.min(nB - 1, q + h), o = q * W - q + h;
      let best = -Infinity, arg = 0, nb = 0, top = -Infinity, first = 0;
      // the band's chunks with their bounds; the most promising one is searched first
      for (let v = 0; v < B; v++) for (let c0 = lo - lo % C; c0 <= hi; c0 += C, nb++) {
        const k = c0 >> 4, bound = cmax[v * NC + k] + maxLT[v * B + w][q * NC + k];
        cv[nb] = v; cc[nb] = c0; cb[nb] = bound;
        if (bound > top) { top = bound; first = nb; }
      }
      for (let r = -1; r < nb; r++) {
        const x = r < 0 ? first : r;
        if (r === first || cb[x] < best) continue;
        const v = cv[x], c0 = cc[x], lt = LT[v * B + w], base = v * nB;
        for (let p = Math.max(lo, c0), b = Math.min(hi, c0 + C - 1); p <= b; p++) {
          const c = prev[base + p] + lt[o + p];
          if (c > best || (c === best && base + p < arg)) { best = c; arg = base + p; }
        }
      }
      // the states outside the band, [0, lo), (hi, nB + lo), ... in each block, when they could reach the best
      if (outTop >= best) {
        if (!built) { out.build(prev, logOut); built = true; }
        out.best = best; out.arg = arg;
        out.take(0, lo);
        for (let v = 0; v < B - 1; v++) out.take(v * nB + hi + 1, (v + 1) * nB + lo);
        out.take((B - 1) * nB + hi + 1, S);
        best = out.best; arg = out.arg;
      }
      ptr[t * S + j] = arg;
      cur[j] = lp[j] + best;
    }
    [prev, cur] = [cur, prev];
  }
  const state = new Uint16Array(T);
  let best = -Infinity;
  for (let i = 0; i < S; i++) if (prev[i] > best) { best = prev[i]; state[T - 1] = i; }
  for (let t = T - 2; t >= 0; t--) state[t] = ptr[(t + 1) * S + state[t + 1]];
  return state;
}

/** pyin's voicing HMM decoded as librosa.sequence.viterbi does (viterbiBanded). obs: concatenated pyinObs results.
 * Returns {f0: Float64Array (NaN when unvoiced), voiced: Uint8Array}. */
export function pyinDecode({off, bin, prob, vp}, opts = {}) {
  const P = pyinParams(opts), nB = P.nBins, S = 2 * nB, T = vp.length, W = P.width, h = W >> 1;
  // transition_local(nB, W, 'triangle'): row p holds scipy's triang(W) centred on p, cut at the edges, each row
  // normalised (numpy's pairwise row sums); np.kron with transition_loop(2, 1 - switch_prob)
  const tri = d => 2 * ((h + 1) - Math.abs(d)) / (W + 1);
  const rowL = new Float64Array(nB * W);                       // rowL[p * W + (q - p + h)]
  const row = new Float64Array(nB);
  for (let p = 0; p < nB; p++) {
    row.fill(0);
    for (let d = -h; d <= h; d++) if (p + d >= 0 && p + d < nB) row[p + d] = tri(d);
    const sum = pairwiseSum(row, 0, nB, z => z);
    for (let d = -h; d <= h; d++) if (p + d >= 0 && p + d < nB) rowL[p * W + d + h] = row[p + d] / sum;
  }
  const stay = 1 - P.switchProb, sw = (1.0 - stay) / (2 - 1);
  const LT = [0, 1, 2, 3].map(k => {
    const s = (k >> 1) === (k & 1) ? stay : sw, t = new Float64Array(nB * W).fill(LOG_TINY64);
    for (let p = 0; p < nB; p++) for (let d = -h; d <= h; d++) {
      const q = p + d, r = rowL[p * W + d + h];
      if (q >= 0 && q < nB && r > 0) t[q * W + (h - d)] = Math.log(s * r + TINY64);
    }
    return t;
  });
  const logObs = (t, lp) => {
    lp.fill(LOG_TINY64, 0, nB);
    for (let k = off[t]; k < off[t + 1]; k++) lp[bin[k]] = Math.log(prob[k] + TINY64);
    lp.fill(Math.log((1 - vp[t]) / nB + TINY64), nB, S);
  };
  const state = viterbiBanded({T, B: 2, nB, h, LT, logObs, logInit: Math.log(1 / S + TINY64), logOut: LOG_TINY64});
  const f0 = new Float64Array(T), voiced = new Uint8Array(T);
  for (let t = 0; t < T; t++) {
    voiced[t] = state[t] < nB;
    f0[t] = voiced[t] ? P.fmin * 2 ** ((state[t] % nB) / (12 * P.binsPerSemi)) : NaN;
  }
  return {f0, voiced};
}
