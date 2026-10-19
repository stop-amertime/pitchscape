// The CPU work of the voice stage (voice.mjs), apart so worker threads can run it (worker.mjs): torchcrepe 0.0.24's
// framing and decoding around the CREPE network (its Viterbi over the 360 pitch bins, one batch of 1024 frames at a
// time, as torchcrepe.predict does), and librosa 0.11's onset_strength (the mel spectrogram's positive flux) and
// onset_detect (its peak picking). numpy and torch work in float32 here; their steps are followed with Math.fround
// where the order is known.
import {SR, HOP, stftFrame, viterbiBanded} from './bass.dsp.mjs';

const f32 = Math.fround;
export const CREPE_SR = 16000, WINDOW = 1024, BINS = 360, CENTS_PER_BIN = 20;
const TINY32 = 1.1754943508222875e-38;                       // np.finfo(float32).tiny (librosa util.tiny of float32)

/** torchcrepe.convert.frequency_to_bins(hz, floor | ceil), in torch's float32. */
export function frequencyToBins(hz, quantize = Math.floor) {
  const cents = f32(1200 * f32(Math.log2(f32(f32(hz) / 10))));
  return quantize(f32(f32(cents - f32(1997.3794084376191)) / CENTS_PER_BIN));
}

/** torchcrepe.preprocess: frames i0..i1 of the 16 kHz signal (padded with 512 zeros each side, every `hop` samples),
 * each made zero-mean and divided by its standard deviation (unbiased, at least 1e-10). x holds samples from `from`
 * on; n: the signal's length. Returns Float32Array((i1 - i0) * 1024). */
export function crepeFrames(x, from, n, i0, i1, hop = 160) {
  const out = new Float32Array((i1 - i0) * WINDOW);
  for (let i = i0; i < i1; i++) {
    const o = (i - i0) * WINDOW, s0 = i * hop - WINDOW / 2;
    let s = 0;
    for (let k = 0; k < WINDOW; k++) {
      const j = s0 + k, v = j >= 0 && j < n ? x[j - from] : 0;
      out[o + k] = v;
      s += v;
    }
    const mean = f32(s / WINDOW);
    let ss = 0;
    for (let k = 0; k < WINDOW; k++) { const d = f32(out[o + k] - mean); out[o + k] = d; ss += d * d; }
    const sd = Math.max(f32(1e-10), f32(Math.sqrt(ss / (WINDOW - 1))));
    for (let k = 0; k < WINDOW; k++) out[o + k] = f32(out[o + k] / sd);
  }
  return out;
}

// torchcrepe.decode.viterbi's transition: max(12 - |i - j|, 0), each row normalised; logs as librosa takes them
// (log(transition + tiny), tiny that of the float32 probabilities)
const H = 11, W = 2 * H + 1;
let crepeLT = null;
function crepeTransitions() {
  if (crepeLT) return crepeLT;
  const lt = new Float64Array(BINS * W).fill(Math.log(TINY32));
  for (let p = 0; p < BINS; p++) {
    let sum = 0;
    for (let q = 0; q < BINS; q++) sum += Math.max(12 - Math.abs(p - q), 0);
    for (let q = Math.max(0, p - H); q <= Math.min(BINS - 1, p + H); q++)
      lt[q * W + (p - q + H)] = Math.log(Math.max(12 - Math.abs(p - q), 0) / sum + TINY32);
  }
  return crepeLT = lt;
}

/** torchcrepe.postprocess for one batch (as predict calls it, with return_periodicity): probs, the network's output
 * for T frames (Float32Array(T * 360), frame-major); bins under fmin's and from fmax's (ceil) set to -inf; the
 * decoder (torchcrepe.decode.viterbi: softmax over bins, then librosa.sequence.viterbi with the transition above);
 * periodicity: the network's output at the chosen bin. Returns {bins: Int16Array(T), per: Float32Array(T)}. */
export function crepeDecode(probs, T, fmin = 65, fmax = 1100) {
  const lo = frequencyToBins(fmin), hi = frequencyToBins(fmax, Math.ceil);
  // softmax (torch, float32) of the masked probabilities, then librosa's log(prob + tiny) in float32
  const logp = new Float32Array(T * BINS);
  for (let t = 0; t < T; t++) {
    const o = t * BINS;
    let m = -Infinity;
    for (let b = lo; b < hi; b++) if (probs[o + b] > m) m = probs[o + b];
    let s = 0;
    const e = new Float64Array(BINS);
    for (let b = lo; b < hi; b++) { e[b] = f32(Math.exp(f32(probs[o + b] - m))); s += e[b]; }
    s = f32(s);
    for (let b = 0; b < BINS; b++) logp[o + b] = f32(Math.log(f32(f32(b >= lo && b < hi ? e[b] / s : 0) + TINY32)));
  }
  const state = viterbiBanded({T, B: 1, nB: BINS, h: H, LT: [crepeTransitions()],
    logObs: (t, lp) => { for (let b = 0; b < BINS; b++) lp[b] = logp[t * BINS + b]; },
    logInit: Math.log(1 / BINS + TINY32), logOut: Math.log(TINY32)});
  const bins = new Int16Array(T), per = new Float32Array(T);
  for (let t = 0; t < T; t++) {
    bins[t] = state[t];
    per[t] = state[t] >= lo && state[t] < hi ? probs[t * BINS + state[t]] : -Infinity;
  }
  return {bins, per};
}

/** torchcrepe.convert.bins_to_frequency in float32, with its dither (scipy.stats.triang(c=0.5, loc=-20, scale=40):
 * random, as torchcrepe adds it) unless dither is false. */
export function binsToFrequency(bins, dither = true) {
  const out = new Float32Array(bins.length), base = f32(1997.3794084376191);
  for (let i = 0; i < bins.length; i++) {
    let cents = f32(f32(CENTS_PER_BIN * bins[i]) + base);
    if (dither) {
      const u = Math.random();
      const noise = -CENTS_PER_BIN + 2 * CENTS_PER_BIN * (u < 0.5 ? Math.sqrt(u / 2) : 1 - Math.sqrt((1 - u) / 2));
      cents = f32(cents + f32(noise));
    }
    out[i] = f32(10 * f32(2 ** f32(cents / 1200)));
  }
  return out;
}

/** torchcrepe.filter.median(x, 3): the median of each frame and its neighbours (at the ends, the lower of the two
 * there are; NaN ignored). */
export function median3(x) {
  const n = x.length, out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const w = [];
    for (let k = i - 1; k <= i + 1; k++) if (k >= 0 && k < n && !Number.isNaN(x[k])) w.push(x[k]);
    w.sort((a, b) => a - b);
    out[i] = w.length ? w[(w.length - 1) >> 1] : NaN;
    if (!Number.isFinite(out[i]) && out[i] !== -Infinity) out[i] = NaN;
  }
  return out;
}

/** torchcrepe.filter.mean(x, 3): the mean of each frame and its neighbours (zero padding not counted, NaN ignored;
 * a mean of exactly 0 becomes NaN). */
export function mean3(x) {
  const n = x.length, out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0, c = 0;
    for (let k = i - 1; k <= i + 1; k++) if (k >= 0 && k < n && !Number.isNaN(x[k])) { s = f32(s + x[k]); c++; }
    const m = f32(s / Math.max(c, 1));
    out[i] = m === 0 ? NaN : m;
  }
  return out;
}

// ------------------------------------------------------------------ onsets
const N_FFT = 2048, N_MELS = 128;
let melBasis = null;

/** librosa.filters.mel(sr=22050, n_fft=2048, n_mels=128, fmax=sr/2, htk=False, norm='slaney') in float32: weights
 * computed in double, stored as float32, then scaled (in double, stored float32) by the Slaney norm. */
export function mel() {
  if (melBasis) return melBasis;
  const nb = N_FFT / 2 + 1, fmax = SR / 2;
  const fSp = 200 / 3, minLogHz = 1000, minLogMel = (minLogHz - 0) / fSp, logstep = Math.log(6.4) / 27;
  const hzToMel = f => f >= minLogHz ? minLogMel + Math.log(f / minLogHz) / logstep : (f - 0) / fSp;
  const melToHz = m => m >= minLogMel ? minLogHz * Math.exp(logstep * (m - minLogMel)) : 0 + fSp * m;
  const lo = hzToMel(0), hi = hzToMel(fmax), M = N_MELS + 2;
  const step = (hi - lo) / (M - 1);
  const melF = Float64Array.from({length: M}, (_, i) => melToHz(i === M - 1 ? hi : i * step + lo));
  const val = 1 / (N_FFT * (1 / SR)), fft = Float64Array.from({length: nb}, (_, k) => k * val);
  const w = new Float32Array(N_MELS * nb);
  for (let i = 0; i < N_MELS; i++) {
    const d0 = melF[i + 1] - melF[i], d1 = melF[i + 2] - melF[i + 1];
    const enorm = 2.0 / (melF[i + 2] - melF[i]);
    for (let k = 0; k < nb; k++) {
      const lower = -(melF[i] - fft[k]) / d0, upper = (melF[i + 2] - fft[k]) / d1;
      w[i * nb + k] = f32(f32(Math.max(0, Math.min(lower, upper))) * enorm);
    }
  }
  return melBasis = w;
}

/** The mel power spectrogram (librosa.feature.melspectrogram: |stft|^2 with n_fft 2048, hop 512, centred, zero
 * padding, through mel()) of frames f0..f1. y holds samples from `from` on; n: the signal's length. Returns
 * Float32Array((f1 - f0) * 128), frame-major. */
export function melFrames(y, from, n, f0, f1) {
  const W = mel(), nb = N_FFT / 2 + 1, mag = new Float32Array(nb), pw = new Float32Array(nb);
  const out = new Float32Array((f1 - f0) * N_MELS);
  for (let f = f0; f < f1; f++) {
    stftFrame(y, f, N_FFT, HOP, mag, from, n);
    for (let k = 0; k < nb; k++) pw[k] = f32(mag[k] * mag[k]);
    for (let m = 0; m < N_MELS; m++) {
      let s = 0;
      const o = m * nb;
      for (let k = 0; k < nb; k++) if (W[o + k]) s += W[o + k] * pw[k];
      out[(f - f0) * N_MELS + m] = s;
    }
  }
  return out;
}

/** librosa.onset.onset_strength (lag 1, max_size 1, centred) from the mel power frames (Float32Array(T * 128)):
 * power_to_db (ref 1, amin 1e-10, top_db 80), the positive difference from the previous frame, its mean over the
 * mels, delayed by 3 frames. Then onset_detect's peak picking (normalised to 0..1; pre_max 1, post_max 1, pre_avg 4,
 * post_avg 5, wait 1, delta 0.07 at 22.05 kHz, hop 512). Returns the onset frames (Int32Array); with strengths,
 * {peaks, strength}: also each onset's strength as onset_strength gives it (before onset_detect normalises it). */
export function onsetDetect(melPow, T, strengths = false) {
  const db = new Float32Array(T * N_MELS);
  let top = -Infinity;
  for (let i = 0; i < db.length; i++) {
    db[i] = f32(10 * f32(Math.log10(Math.max(f32(1e-10), melPow[i]))));
    if (db[i] > top) top = db[i];
  }
  const floor = f32(top - 80);
  for (let i = 0; i < db.length; i++) if (db[i] < floor) db[i] = floor;
  const env = new Float32Array(T);
  const pad = 1 + Math.floor(N_FFT / (2 * HOP));
  for (let t = 0; t + 1 < T && t + pad < T; t++) {
    let s = 0;
    for (let m = 0; m < N_MELS; m++) s = f32(s + Math.max(0, f32(db[(t + 1) * N_MELS + m] - db[t * N_MELS + m])));
    env[t + pad] = f32(s / N_MELS);
  }
  const raw = strengths ? env.slice() : null;
  const done = p => strengths ? {peaks: p, strength: Float32Array.from(p, f => raw[f])} : p;
  // onset_detect: normalise, then util.peak_pick (numba: means summed in float32)
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < T; i++) lo = Math.min(lo, env[i]);
  for (let i = 0; i < T; i++) { env[i] = f32(env[i] - lo); hi = Math.max(hi, env[i]); }
  const den = f32(hi + TINY32);
  let any = false;
  for (let i = 0; i < T; i++) { env[i] = f32(env[i] / den); if (env[i]) any = true; }
  if (!any) return done(new Int32Array(0));
  const preMax = Math.ceil(Math.floor(0.03 * SR / HOP)), postMax = Math.ceil(Math.floor(0.00 * SR / HOP) + 1);
  const preAvg = Math.ceil(Math.floor(0.10 * SR / HOP)), postAvg = Math.ceil(Math.floor(0.10 * SR / HOP) + 1);
  const wait = Math.ceil(Math.floor(0.03 * SR / HOP)), delta = f32(0.07);
  const mean = (a, b) => { let s = 0; for (let i = a; i < b; i++) s = f32(s + env[i]); return f32(s / (b - a)); };
  const peaks = [];
  let n = 0;
  if (env[0] >= Math.max(...env.subarray(0, Math.min(postMax, T))) && env[0] >= f32(mean(0, Math.min(postAvg, T)) + delta)) {
    peaks.push(0);
    n = wait + 1;
  } else n = 1;
  while (n < T) {
    let mx = -Infinity;
    for (let i = Math.max(0, n - preMax); i < Math.min(n + postMax, T); i++) if (env[i] > mx) mx = env[i];
    if (env[n] !== mx) { n++; continue; }
    if (!(env[n] >= f32(mean(Math.max(0, n - preAvg), Math.min(n + postAvg, T)) + delta))) { n++; continue; }
    peaks.push(n);
    n += wait + 1;
  }
  return done(Int32Array.from(peaks));
}
