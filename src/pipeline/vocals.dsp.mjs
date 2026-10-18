// The STFT, band gather, mask averaging and iSTFT around the Mel-Band RoFormer vocal model, for one 8 s chunk:
// MelBandRoformer.forward (KimberleyJensen/Mel-Band-Roformer-Vocal-Model) before and after its network, as
// tools/export_vocals.py cuts it (torch.stft / istft: n_fft 2048, hop 441, periodic Hann 2048, centred with reflect
// padding, not normalised, one-sided). Apart from vocals.mjs so worker threads can run them (worker.mjs).
import FFT from './vendor/fft.mjs';

export const CHUNK = 352800, N = 2048, HOP = 441, FR = N / 2 + 1, T = CHUNK / HOP + 1, PAD = N / 2;
const PL = CHUNK + 2 * PAD;                  // the chunk padded for its frames: index k <-> sample k - PAD

const fj = new FFT(N), fin = fj.createComplexArray(), fout = fj.createComplexArray();
const win = new Float64Array(N);
for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N);
// istft's window envelope: the squared window overlap-added at every sample (hop 441 does not divide 2048, so it varies)
const env = new Float64Array(PL);
for (let j = 0; j < T; j++) for (let n = 0; n < N; n++) env[j * HOP + n] += win[n] * win[n];
const reflect = (i, n) => i < 0 ? -i : i >= n ? 2 * (n - 1) - i : i;

/** One chunk (left, right: Float32Array(CHUNK)) and the model's freq_indices (stereo-interleaved: 2 * bin + channel)
 * -> {st: the whole spectrogram [2 channels][FR][T][re, im] as Float32Array, x: the network's input [T][J][re, im]}.
 * Both channels go through one complex FFT (left real, right imaginary). */
export function spec(left, right, fidx) {
  const st = new Float32Array(2 * FR * T * 2), p0 = new Float64Array(PL), p1 = new Float64Array(PL);
  for (let k = 0; k < PL; k++) { const i = reflect(k - PAD, CHUNK); p0[k] = left[i]; p1[k] = right[i]; }
  for (let j = 0; j < T; j++) {
    const s0 = j * HOP;
    for (let n = 0; n < N; n++) { fin[2 * n] = p0[s0 + n] * win[n]; fin[2 * n + 1] = p1[s0 + n] * win[n]; }
    fj.transform(fout, fin);
    for (let f = 0; f < FR; f++) {
      const r = (N - f) & (N - 1), r1 = fout[2 * f], i1 = fout[2 * f + 1], r2 = fout[2 * r], i2 = fout[2 * r + 1];
      const a = (f * T + j) * 2, b = ((FR + f) * T + j) * 2;
      st[a] = (r1 + r2) / 2; st[a + 1] = (i1 - i2) / 2;           // left = (Z + conj Z~) / 2
      st[b] = (i1 + i2) / 2; st[b + 1] = (r2 - r1) / 2;           // right = (Z - conj Z~) / 2i
    }
  }
  const J = fidx.length, x = new Float32Array(T * J * 2);
  for (let k = 0; k < J; k++) {
    const src = ((fidx[k] & 1) * FR + (fidx[k] >> 1)) * T * 2;
    for (let j = 0; j < T; j++) { x[(j * J + k) * 2] = st[src + 2 * j]; x[(j * J + k) * 2 + 1] = st[src + 2 * j + 1]; }
  }
  return {st, x};
}

/** The network's masks [T][J][re, im] averaged over the bands that share each bin, applied to the spectrogram st, and
 * the iSTFT -> [left, right] Float32Array(CHUNK). Left and right go through one inverse FFT (left + i right). */
export function ispec(st, masks, fidx) {
  const J = fidx.length, M = new Float64Array(2 * FR * T * 2), cnt = new Float64Array(FR);
  for (let k = 0; k < J; k++) cnt[fidx[k] >> 1] += fidx[k] & 1 ? 0 : 1;        // num_bands_per_freq
  for (let k = 0; k < J; k++) {
    const dst = ((fidx[k] & 1) * FR + (fidx[k] >> 1)) * T * 2;
    for (let j = 0; j < T; j++) { M[dst + 2 * j] += masks[(j * J + k) * 2]; M[dst + 2 * j + 1] += masks[(j * J + k) * 2 + 1]; }
  }
  const y0 = new Float64Array(PL), y1 = new Float64Array(PL);
  const at = (c, f, j) => {
    const i = ((c * FR + f) * T + j) * 2, d = Math.max(cnt[f], 1e-8), mr = M[i] / d, mi = M[i + 1] / d;
    return [st[i] * mr - st[i + 1] * mi, st[i] * mi + st[i + 1] * mr];
  };
  for (let j = 0; j < T; j++) {
    // irfft takes the real part of the DC and Nyquist bins; Y = A + iB with A, B Hermitian
    for (let f = 0; f < FR; f++) {
      let [ar, ai] = at(0, f, j), [br, bi] = at(1, f, j);
      if (f === 0 || f === FR - 1) { ai = 0; bi = 0; }
      fin[2 * f] = ar - bi; fin[2 * f + 1] = ai + br;
      if (f && f < FR - 1) { fin[2 * (N - f)] = ar + bi; fin[2 * (N - f) + 1] = br - ai; }
    }
    fj.inverseTransform(fout, fin);
    const s0 = j * HOP;
    for (let n = 0; n < N; n++) { y0[s0 + n] += fout[2 * n] * win[n]; y1[s0 + n] += fout[2 * n + 1] * win[n]; }
  }
  const o0 = new Float32Array(CHUNK), o1 = new Float32Array(CHUNK);
  for (let i = 0; i < CHUNK; i++) { const e = env[i + PAD]; o0[i] = y0[i + PAD] / e; o1[i] = y1[i + PAD] / e; }
  return [o0, o1];
}
