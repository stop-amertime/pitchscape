// librosa 0.11's constant-Q transform (librosa.cqt = vqt with gamma 0: Brown 1991, Schoerkhuber & Klapuri 2010's
// octave-by-octave recursive downsampling) and its harmonic-percussive separation (librosa.decompose.hpss: Fitzgerald
// 2010, with Driedger et al. 2014's margin), transcribed for the loudness stage. As librosa does it: the wavelet basis
// per octave (hann windows, L1-normalised, pad_center to a power of two, FFT, sparsified at the 1 % quantile), each
// octave's response as that basis times an STFT (window of ones, zero padded at the ends), the signal then halved
// with soxr_hq (scale=True) for the next octave down, the octaves stacked and divided by sqrt(filter length).
// Arithmetic in double where numpy works in float32 (complex64 basis and STFT): magnitudes agree with librosa to
// about 1e-6 of the stem's level (tools/parity.py loudness).
import FFT from './vendor/fft.mjs';
import {ready, resampleSync} from './resample.mjs';

const HANN_BANDWIDTH = 1.50018310546875;                     // filters.WINDOW_BANDWIDTHS['hann']

/** The bins' centre frequencies (interval_frequencies, 'equal', tuning 0). */
export function cqtFreqs(nBins, fmin, bpo) {
  const f = new Float64Array(nBins);
  for (let k = 0; k < nBins; k++) f[k] = 2 ** Math.floor(k / bpo) * 2 ** ((k % bpo) / bpo) * fmin;
  return f;
}

/** filters._relative_bandwidth */
function relBandwidth(freqs) {
  const n = freqs.length, lf = Array.from(freqs, Math.log2), a = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    const bpo = k === 0 ? 1 / (lf[1] - lf[0]) : k === n - 1 ? 1 / (lf[n - 1] - lf[n - 2]) : 2 / (lf[k + 1] - lf[k - 1]);
    a[k] = (2 ** (2 / bpo) - 1) / (2 ** (2 / bpo) + 1);
  }
  return a;
}

/** __vqt_filter_fft for one octave: rows of [bin indices, re, im] (the sparse basis) and n_fft. */
function octaveBasis(sr, freqs, alpha) {
  const lengths = Array.from(freqs, (f, i) => (1 / alpha[i]) * sr / f);
  const nfft = 2 ** Math.ceil(Math.log2(Math.max(...lengths)));
  const fft = new FFT(nfft), rows = [];
  for (let r = 0; r < freqs.length; r++) {
    const ilen = lengths[r], a = Math.floor(-ilen / 2), b = Math.floor(ilen / 2), n = Math.ceil(b - a);
    const re = new Float64Array(n), im = new Float64Array(n);
    let l1 = 0;
    for (let j = 0; j < n; j++) {
      const w = 0.5 - 0.5 * Math.cos(2 * Math.PI * j / n);    // scipy hann, fftbins=True
      const ph = (a + j) * 2 * Math.PI * freqs[r] / sr;
      re[j] = Math.cos(ph) * w; im[j] = Math.sin(ph) * w;
      l1 += Math.hypot(re[j], im[j]);
    }
    const sc = ilen / nfft / l1, lpad = Math.floor((nfft - n) / 2);
    const x = fft.createComplexArray(), X = fft.createComplexArray();
    for (let j = 0; j < n; j++) { x[2 * (lpad + j)] = re[j] * sc; x[2 * (lpad + j) + 1] = im[j] * sc; }
    fft.transform(X, x);
    // util.sparsify_rows(quantile 0.01): drop the smallest magnitudes that together make up 1 % of the row's sum
    const K = nfft / 2 + 1, mags = new Float64Array(K);
    let tot = 0;
    for (let k = 0; k < K; k++) { mags[k] = Math.hypot(X[2 * k], X[2 * k + 1]); tot += mags[k]; }
    const sorted = Float64Array.from(mags).sort();
    let cum = 0, j = 0;
    for (; j < K; j++) { cum += sorted[j] / tot; if (!(cum < 0.01)) break; }
    const th = sorted[Math.min(j, K - 1)], idx = [], br = [], bi = [];
    for (let k = 0; k < K; k++) if (mags[k] >= th) { idx.push(k); br.push(X[2 * k]); bi.push(X[2 * k + 1]); }
    rows.push([Int32Array.from(idx), Float64Array.from(br), Float64Array.from(bi)]);
  }
  return {rows, nfft};
}

/** |librosa.cqt(y, sr, hop_length, fmin, n_bins, bins_per_octave)| as frames x nBins (Float32Array, frame-major) and
 * the frame count (1 + len // hop). y: Float32Array (mono). */
export async function cqt(y, {sr = 22050, hop = 256, fmin = 27.5, nBins = 264, bpo = 36} = {}) {
  await ready();
  const freqs = cqtFreqs(nBins, fmin, bpo), alpha = relBandwidth(freqs);
  const nOct = Math.ceil(nBins / bpo), nFil = Math.min(bpo, nBins);
  const cutoff = Math.max(...Array.from(freqs, (f, i) => f * (1 + 0.5 * HANN_BANDWIDTH * alpha[i])));
  // __early_downsample
  let twos = 0; for (let h = hop; h > 0 && h % 2 === 0; h /= 2) twos++;
  const dc = Math.min(Math.max(0, Math.ceil(Math.log2(sr / 2 / cutoff)) - 1 - 1), Math.max(0, twos - nOct + 1));
  let my = y, mySr = sr, myHop = hop;
  if (dc > 0) {
    const fac = 2 ** dc;
    my = resampleSync(y, fac, 1, 'hq');
    for (let i = 0; i < my.length; i++) my[i] = Math.fround(my[i] / Math.sqrt(1 / fac));
    mySr = sr / fac; myHop = hop / fac;
  }
  const srTop = mySr, resp = [];
  for (let o = 0; o < nOct; o++) {
    const hiB = nBins - nFil * o, loB = Math.max(0, nBins - nFil * (o + 1));
    const {rows, nfft} = octaveBasis(mySr, freqs.subarray(loB, hiB), alpha.subarray(loB, hiB));
    const g = Math.sqrt(srTop / mySr), n = my.length, half = nfft / 2, T = 1 + Math.floor(n / myHop);
    const fft = new FFT(nfft), fr = new Float64Array(nfft), D = fft.createComplexArray();
    const out = new Float64Array(T * rows.length);
    for (let t = 0; t < T; t++) {
      const s0 = t * myHop - half;
      for (let j = 0; j < nfft; j++) { const s = s0 + j; fr[j] = s >= 0 && s < n ? my[s] : 0; }
      fft.realTransform(D, fr);
      for (let r = 0; r < rows.length; r++) {
        const [idx, br, bi] = rows[r];
        let re = 0, im = 0;
        for (let q = 0; q < idx.length; q++) {
          const k = idx[q], dr = D[2 * k], di = D[2 * k + 1];
          re += br[q] * dr - bi[q] * di; im += br[q] * di + bi[q] * dr;
        }
        out[t * rows.length + r] = Math.hypot(re, im) * g;
      }
    }
    resp.push({out, T, loB, hiB});
    if (myHop % 2 === 0) {
      myHop /= 2; mySr /= 2;
      const h = resampleSync(my, 2, 1, 'hq');
      for (let i = 0; i < h.length; i++) h[i] = Math.fround(h[i] / Math.SQRT1_2);
      my = h;
    }
  }
  const nF = Math.min(...resp.map(r => r.T)), C = new Float32Array(nF * nBins);
  for (const {out, loB, hiB} of resp) {
    const w = hiB - loB;
    for (let b = loB; b < hiB; b++) {
      const len = (1 / alpha[b]) * srTop / freqs[b], s = 1 / Math.sqrt(len);
      for (let t = 0; t < nF; t++) C[t * nBins + b] = out[t * w + (b - loB)] * s;
    }
  }
  return {C, nF};
}

/** The median of a[i0 + k*step] for k in a window of `size` around each position, scipy.ndimage.median_filter's
 * 'reflect' edges (d c b a | a b c d | d c b a), along one axis of a frame-major grid. */
function medianAxis(S, nF, nB, size, alongTime) {
  const out = new Float32Array(S.length), r = Math.floor(size / 2), buf = new Float32Array(size);
  const L = alongTime ? nF : nB, M = alongTime ? nB : nF;
  const at = (line, k) => alongTime ? S[k * nB + line] : S[line * nB + k];
  const refl = k => { while (k < 0 || k >= L) k = k < 0 ? -k - 1 : 2 * L - k - 1; return k; };
  // a sorted window slid along the line: one value out, one in, per step
  const del = (v, m) => { let i = 0; while (buf[i] !== v) i++; buf.copyWithin(i, i + 1, m); };
  const ins = (v, m) => { let i = m; while (i > 0 && buf[i - 1] > v) { buf[i] = buf[i - 1]; i--; } buf[i] = v; };
  for (let line = 0; line < M; line++) {
    for (let j = 0; j < size; j++) buf[j] = at(line, refl(j - r));
    buf.sort();
    for (let k = 0; k < L; k++) {
      if (k) { del(at(line, refl(k - r - 1)), size); ins(at(line, refl(k + r)), size - 1); }
      const v = buf[r];
      if (alongTime) out[k * nB + line] = v; else out[line * nB + k] = v;
    }
  }
  return out;
}

/** librosa.decompose.hpss(S, kernel_size=31, power=2, margin) on a magnitude grid (frames x bins): the harmonic and
 * percussive parts, and what neither takes (S - H - P, the residual: noise). */
export function hpss(S, nF, nB, {kernel = 31, margin = 2} = {}) {
  const harm = medianAxis(S, nF, nB, kernel, true), perc = medianAxis(S, nF, nB, kernel, false);
  const H = new Float32Array(S.length), P = new Float32Array(S.length), R = new Float32Array(S.length);
  const tiny = 1.1754943508222875e-38;
  const soft = (x, ref) => {                                    // util.softmask, power 2, split_zeros False
    const z = Math.max(x, ref);
    if (z < tiny) return 0;
    const m = (x / z) ** 2, rm = (ref / z) ** 2;
    return m / (m + rm);
  };
  for (let i = 0; i < S.length; i++) {
    H[i] = S[i] * soft(harm[i], perc[i] * margin);
    P[i] = S[i] * soft(perc[i], harm[i] * margin);
    R[i] = Math.max(0, S[i] - H[i] - P[i]);
  }
  return {H, P, R};
}
