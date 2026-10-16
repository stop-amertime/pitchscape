// The CPU work of the drums stage (drums.mjs), apart so worker threads can run it (worker.mjs): madmom's peak
// picking, the band energies of server/pipeline.py drum_details (librosa.stft), and librosa 0.11's yin for the
// kick's pitch.
import FFT from './vendor/fft.mjs';

export const SR = 22050;
export const DB = 16;                                          // pipeline.py DRUM_BANDS: log-spaced 30 Hz .. 11 kHz
export const DRUM_BANDS = Array.from({length: DB + 1}, (_, i) => 30 * (SR / 2 / 30) ** (i / DB));
export const HOP = 256, NFFT = 2048;

const f32 = Math.fround;

/** madmom's NotePeakPickingProcessor for one class, as pipeline.py peak_pick does it with scipy.ndimage (moving
 * average: uniform_filter1d, summed in double, stored as float32; moving maximum: maximum_filter1d; both with zeros
 * beyond the ends). act: Float32Array at fps frames per second. Returns {idx: frame numbers, rise: how far
 * each rose above the moving average (float32, as numpy computes it)}. */
export function peakPick(act, threshold, {fps = 100, pre_avg = 0.1, post_avg = 0.01, pre_max = 0.02, post_max = 0.01,
                                          combine = 0.02} = {}) {
  const [pa, po, pm, pq] = [pre_avg, post_avg, pre_max, post_max].map(v => pyRound(fps * v));
  const n = act.length;
  const avg = new Float32Array(n);
  if (pa + po) {
    // scipy's uniform_filter1d, size pa + po + 1, origin floor((pa - po) / 2): output i is the mean of
    // input[i - size1 - origin .. + size - 1], size1 = size // 2, each window summed in double (scipy 1.17 sums every
    // window afresh: a running sum differs from it by an ulp on 1 frame in 80)
    const size = pa + po + 1, start = -(size >> 1) - Math.floor((pa - po) / 2);
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let l = 0; l < size; l++) { const j = start + i + l; if (j >= 0 && j < n) s += act[j]; }
      avg[i] = s / size;
    }
  }
  // numpy 2: float32 array + Python float is float32
  const thr = f32(threshold);
  const det = new Float32Array(n);
  for (let i = 0; i < n; i++) det[i] = act[i] >= f32(avg[i] + thr) ? act[i] : 0;
  let keep = det;
  if (pm + pq) {
    const size = pm + pq + 1, start = -(size >> 1) - Math.floor((pm - pq) / 2);
    keep = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      if (!det[i]) continue;
      let m = 0;
      for (let l = 0; l < size; l++) { const j = start + i + l; if (j >= 0 && j < n && det[j] > m) m = det[j]; }
      keep[i] = det[i] === m ? det[i] : 0;
    }
  }
  const idx = [], rise = [];
  let last = -1e9;
  for (let i = 0; i < n; i++) {
    if (!keep[i]) continue;
    if ((i - last) / fps > combine) {                          // combine events closer than `combine`, keeping the first
      idx.push(i);
      rise.push(f32(act[i] - avg[i]));
      last = i;
    }
  }
  return {idx, rise};
}

/** Python's round(): halves to even. */
export function pyRound(x) {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 && r % 2 ? r - 1 : r;
}

// librosa.fft_frequencies(sr=SR, n_fft=NFFT) (numpy's rfftfreq: k * (1 / (n * d))), and each bin's band
const FREQS = (() => {
  const val = 1 / (NFFT * (1 / SR)), f = new Float64Array(NFFT / 2 + 1);
  for (let k = 0; k <= NFFT / 2; k++) f[k] = k * val;
  return f;
})();
const BIN_BAND = Int8Array.from(FREQS, f => {
  for (let b = 0; b < DB; b++) if (f >= DRUM_BANDS[b] && f < DRUM_BANDS[b + 1]) return b;
  return -1;
});
const HANN = Float64Array.from({length: NFFT}, (_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / NFFT));
let fftN = null;

/** Band energies of frames f0..f1-1 of librosa.stft(y, n_fft=2048, hop_length=256, center=True) (zero padding, a
 * periodic Hann window): the power in each of the 16 drum bands. y: the samples frames f0..f1-1 need, starting at
 * sample `from` of the stem (padding beyond the stem's ends is zeros, n: the stem's length). Returns
 * Float32Array((f1 - f0) * 16), frame-major. */
export function bandEnergy(y, from, n, f0, f1) {
  fftN ??= new FFT(NFFT);
  const inp = new Float64Array(NFFT), out = fftN.createComplexArray(), E = new Float32Array((f1 - f0) * DB);
  const acc = new Float64Array(DB);
  for (let f = f0; f < f1; f++) {
    const s0 = f * HOP - NFFT / 2;                             // first sample of the frame in the stem
    for (let i = 0; i < NFFT; i++) {
      const k = s0 + i;
      inp[i] = k >= 0 && k < n ? y[k - from] * HANN[i] : 0;
    }
    fftN.realTransform(out, inp);
    acc.fill(0);
    for (let k = 0; k <= NFFT / 2; k++) {
      const b = BIN_BAND[k];
      if (b >= 0) acc[b] += out[2 * k] ** 2 + out[2 * k + 1] ** 2;
    }
    for (let b = 0; b < DB; b++) E[(f - f0) * DB + b] = acc[b];
  }
  return E;
}

const TINY32 = 1.1754943508222875e-38;                         // librosa util.tiny of float32
let fftY = null;

/** librosa.yin (0.11) of one signal: frames of frame_length centred (zero padding), every hop_length samples;
 * the cumulative mean normalised difference over the whole frame (0.11 dropped win_length); the first trough under
 * trough_threshold, else the global minimum; parabolic interpolation. Returns Float64Array of f0 per frame.
 * In double precision throughout (librosa computes in the input's float32). */
export function yin(y, {fmin, fmax, sr = SR, frame_length = 2048, hop_length = null, trough_threshold = 0.1} = {}) {
  hop_length ??= frame_length >> 2;
  const N = frame_length, half = N >> 1, len = y.length + 2 * half;
  const nFrames = 1 + Math.floor((len - N) / hop_length);
  const minP = Math.floor(sr / fmax), maxP = Math.min(Math.ceil(sr / fmin), N - 1);
  // autocorrelation by FFT, as librosa.autocorrelate (scipy.fft.next_fast_len(2N - 1) is 2N here)
  let P = 1;
  while (P < 2 * N - 1) P <<= 1;
  if (!fftY || fftY.size !== P) fftY = new FFT(P);
  const fin = new Float64Array(P), spec = fftY.createComplexArray(), back = fftY.createComplexArray();
  const x = new Float64Array(N), c = new Float64Array(N), d = new Float64Array(maxP + 1), cm = new Float64Array(maxP);
  const R = maxP - minP + 1, v = new Float64Array(R);
  const f0 = new Float64Array(nFrames);
  for (let j = 0; j < nFrames; j++) {
    const s0 = j * hop_length - half;
    for (let i = 0; i < N; i++) { const k = s0 + i; x[i] = k >= 0 && k < y.length ? y[k] : 0; }
    fin.fill(0);
    fin.set(x);
    fftY.realTransform(spec, fin);
    fftY.completeSpectrum(spec);
    for (let k = 0; k < P; k++) { spec[2 * k] = spec[2 * k] ** 2 + spec[2 * k + 1] ** 2; spec[2 * k + 1] = 0; }
    fftY.inverseTransform(back, spec);                         // fft.js scales the inverse by 1/P
    // energy terms and the difference function d(k) = 2 (r(0) - r(k)) - sum_{m<k} y(m)^2, as librosa writes it
    let s = 0;
    for (let i = 0; i < N; i++) { s += x[i] * x[i]; c[i] = s; }
    d[0] = 0;
    const r0 = back[0];
    for (let k = 1; k <= maxP; k++) d[k] = 2 * (r0 - back[2 * k]) - c[k - 1];
    s = 0;
    for (let k = 1; k <= maxP; k++) { s += d[k]; cm[k - 1] = s / k; }
    for (let r = 0; r < R; r++) v[r] = d[minP + r] / (cm[minP - 1 + r] + TINY32);
    // first trough under the threshold (librosa's localmin; the first lag a trough if under the second)
    let pick = -1, gmin = 0;
    for (let r = 0; r < R; r++) {
      if (v[r] < v[gmin]) gmin = r;
      if (pick >= 0) continue;
      const trough = r === 0 ? v[0] < v[1] : r === R - 1 ? v[r] < v[r - 1] : v[r] < v[r - 1] && v[r] <= v[r + 1];
      if (trough && v[r] < trough_threshold) pick = r;
    }
    if (pick < 0) pick = gmin;
    let shift = 0;
    if (pick > 0 && pick < R - 1) {
      const a = v[pick + 1] + v[pick - 1] - 2 * v[pick], b = (v[pick + 1] - v[pick - 1]) / 2;
      shift = Math.abs(b) >= Math.abs(a) ? 0 : -b / a;
    }
    f0[j] = sr / (minP + pick + shift);
  }
  return f0;
}

/** numpy's median. */
export function median(a) {
  const s = Float64Array.from(a).sort(), n = s.length;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

/** pipeline.py drum_details' pitch of each kick's boom: the median yin f0 (30-200 Hz, 2048-sample frames every 256)
 * of 40-250 ms after the hit; 52 Hz when that is under 2048 samples or not finite. segs: Float32Arrays. */
export function kickPitches(segs) {
  return segs.map(seg => {
    if (seg.length <= 2048) return 52.0;
    const f0 = yin(seg, {fmin: 30, fmax: 200, sr: SR, frame_length: 2048, hop_length: 256});
    return f0.every(Number.isFinite) ? median(f0) : 52.0;
  });
}
