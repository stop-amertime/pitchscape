// Mixture consistency for Demucs's stems (Wisdom et al. 2019, "Differentiable consistency constraints for improved
// deep speech enhancement": the weighted projection). Demucs makes each stem's waveform outright, and the six do not
// add back up to the song: what is left over (the mix minus their sum) is in no stem. Here each stem keeps what
// Demucs made and takes a share of the leftover, in each time-frequency bin in proportion to its power there, so the
// stems add up to the song. STFT as librosa's (periodic Hann, 4096 points, hop 1024, centred with zero padding; the
// iSTFT divides by the window's summed square). Measured on the nine test songs before it went in (pipeline 10):
// most stems change by -20 to -35 dB, the quiet unsure ones gain most (other +0.4 to +1.0 dB, piano +1.4 to +2.2 dB),
// and sound Demucs put in two stems that cancelled out goes (the guitar solo's bass, other and piano drop 7-11 dB).
// One block of one channel at a time, so the workers share a song and no stem's whole STFT is ever held.
import FFT from './vendor/fft.mjs';

export const N = 4096, HOP = 1024;
const K = 6;
const fj = new FFT(N), zin = fj.createComplexArray(), zout = fj.createComplexArray();
const win = new Float64Array(N);
for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N);
const F2 = N / 2 + 1;
// each frame's spectra: the leftover's and the stems' (bins 0..N/2), and the stems' shares
const R = new Float64Array(2 * F2), S = Array.from({length: K}, () => new Float64Array(2 * F2)), P = new Float64Array(K * F2);

/** Two real frames a and b (Float64Array(N)) through one complex FFT: their spectra into A and B (bins 0..N/2). */
function fft2(a, b, A, B) {
  for (let n = 0; n < N; n++) { zin[2 * n] = a[n]; zin[2 * n + 1] = b ? b[n] : 0; }
  fj.transform(zout, zin);
  for (let f = 0; f < F2; f++) {
    const r = (N - f) & (N - 1), r1 = zout[2 * f], i1 = zout[2 * f + 1], r2 = zout[2 * r], i2 = zout[2 * r + 1];
    A[2 * f] = (r1 + r2) / 2; A[2 * f + 1] = (i1 - i2) / 2;
    if (B) { B[2 * f] = (i1 + i2) / 2; B[2 * f + 1] = (r2 - r1) / 2; }
  }
}
/** The inverse of two spectra (bins 0..N/2 of real signals) through one complex FFT: a + i b. */
function ifft2(A, B, a, b) {
  for (let f = 0; f < F2; f++) {
    const ar = A[2 * f], ai = A[2 * f + 1], br = B ? B[2 * f] : 0, bi = B ? B[2 * f + 1] : 0;
    zin[2 * f] = ar - bi; zin[2 * f + 1] = ai + br;
    if (f > 0 && f < N / 2) { zin[2 * (N - f)] = ar + bi; zin[2 * (N - f) + 1] = br - ai; }
  }
  fj.inverseTransform(zout, zin);
  for (let n = 0; n < N; n++) { a[n] = zout[2 * n]; if (b) b[n] = zout[2 * n + 1]; }
}

/** One channel's samples [b0, b1) of a song n samples long. res (the leftover) and stems (the six), each over samples
 * [a0, a0 + length) (at least [b0 - N, b1 + N) within the song). Returns the six stems' new samples over [b0, b1). */
export function projectBlock(res, stems, a0, b0, b1, n) {
  const frames = 1 + Math.floor(n / HOP), h = N / 2;
  const jlo = Math.max(0, Math.floor((b0 - h) / HOP) + 1), jhi = Math.min(frames - 1, Math.ceil((b1 + h) / HOP) - 1);
  const len = b1 - b0, acc = Array.from({length: K}, () => new Float64Array(len)), wss = new Float64Array(len);
  const fr = Array.from({length: K + 1}, () => new Float64Array(N)), out = Array.from({length: K}, () => new Float64Array(N));
  const at = (x, t) => t >= 0 && t < n ? x[t - a0] : 0;
  for (let j = jlo; j <= jhi; j++) {
    const t0 = j * HOP - h;
    for (let i = 0; i < N; i++) {
      const t = t0 + i, w = win[i];
      fr[0][i] = at(res, t) * w;
      for (let k = 0; k < K; k++) fr[k + 1][i] = at(stems[k], t) * w;
    }
    fft2(fr[0], fr[1], R, S[0]); fft2(fr[2], fr[3], S[1], S[2]); fft2(fr[4], fr[5], S[3], S[4]); fft2(fr[6], null, S[5], null);
    for (let f = 0; f < F2; f++) {
      let tot = 1e-12;
      for (let k = 0; k < K; k++) { const p = S[k][2 * f] ** 2 + S[k][2 * f + 1] ** 2; P[k * F2 + f] = p; tot += p; }
      for (let k = 0; k < K; k++) {
        const g = P[k * F2 + f] / tot;
        S[k][2 * f] = R[2 * f] * g; S[k][2 * f + 1] = R[2 * f + 1] * g;     // the stem's share of the leftover
      }
    }
    ifft2(S[0], S[1], out[0], out[1]); ifft2(S[2], S[3], out[2], out[3]); ifft2(S[4], S[5], out[4], out[5]);
    // overlap-add, windowed again, into the block
    const i0 = Math.max(0, b0 - t0), i1 = Math.min(N, b1 - t0);
    for (let i = i0; i < i1; i++) {
      const w = win[i], q = t0 + i - b0;
      wss[q] += w * w;
      for (let k = 0; k < K; k++) acc[k][q] += out[k][i] * w;
    }
  }
  return stems.map((s, k) => {
    const y = new Float32Array(len);
    for (let q = 0; q < len; q++) y[q] = s[b0 + q - a0] + (wss[q] > 1e-10 ? acc[k][q] / wss[q] : 0);
    return y;
  });
}
