// The STFT and iSTFT around Demucs htdemucs_6s, for one segment: HTDemucs._spec / _magnitude and _mask / _ispec
// (demucs 4.1.0: torch.stft with a periodic Hann window, normalized, reflect padding; complex as channels). Apart
// from stems.mjs so worker threads can run them (worker.mjs).
import FFT from './vendor/fft.mjs';

export const SOURCES = ['drums', 'bass', 'other', 'vocals', 'guitar', 'piano'];
export const SEGMENT = 343980;            // htdemucs_6s's training segment, 7.8 s at 44.1 kHz
const S = SOURCES.length;
const N = 4096, HOP = 1024, FR = 2048, T = 336, L = SEGMENT, PAD = HOP / 2 * 3;
const PL = T * HOP + N;                    // one segment padded for its frames: index k <-> sample k - PAD

const fj = new FFT(N), fin = fj.createComplexArray(), fout = fj.createComplexArray();
const win = new Float64Array(N);
for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N);
let env = 0;
for (let k = 0; k < N / HOP; k++) env += win[k * HOP + 1] ** 2;    // overlap-added window squared: constant at 3/4 overlap
const envInv = 1 / env;
const reflect = (i, n) => i < 0 ? -i : i >= n ? 2 * (n - 1) - i : i;

/** One segment (left, right: Float32Array(SEGMENT)) -> the network's `mag` input [1,4,FR,T]: each channel's real and
 * imaginary parts as channels. Both channels go through one complex FFT (left real, right imaginary). */
export function spec(left, right) {
  const mag = new Float32Array(4 * FR * T), p0 = new Float64Array(PL), p1 = new Float64Array(PL);
  for (let k = 0; k < PL; k++) { const i = reflect(k - PAD, L); p0[k] = left[i]; p1[k] = right[i]; }
  const g = 1 / (2 * Math.sqrt(N));       // torch's normalized=True, and the 1/2 of separating the channels
  for (let j = 0; j < T; j++) {
    const s0 = j * HOP;
    for (let n = 0; n < N; n++) { fin[2 * n] = p0[s0 + n] * win[n]; fin[2 * n + 1] = p1[s0 + n] * win[n]; }
    fj.transform(fout, fin);
    for (let f = 0; f < FR; f++) {
      const r = (N - f) & (N - 1), r1 = fout[2 * f], i1 = fout[2 * f + 1], r2 = fout[2 * r], i2 = fout[2 * r + 1];
      mag[f * T + j] = (r1 + r2) * g; mag[(FR + f) * T + j] = (i1 - i2) * g;              // left = (Z + conj Z~) / 2
      mag[(2 * FR + f) * T + j] = (i1 + i2) * g; mag[(3 * FR + f) * T + j] = (r2 - r1) * g; // right = (Z - conj Z~) / 2i
    }
  }
  return mag;
}

const TILE = 16;                           // frames transposed at a time (the network's output is frequency-major)
const fr = new Float32Array(TILE * 4 * FR), y0 = new Float64Array(PL), y1 = new Float64Array(PL);

/** The network's outputs x [1,S,4,FR,T] and xt [1,S,2,L] -> each source's waveform, [S * 2] Float32Array(L) in the
 * order source 0 left, source 0 right, source 1 left... Left and right go through one inverse FFT (left + i right). */
export function ispec(x, xt) {
  const out = [], g = Math.sqrt(N) / N;
  for (let s = 0; s < S; s++) {
    y0.fill(0); y1.fill(0);
    for (let j = 0; j < T; j++) {
      const jt = j % TILE;
      if (!jt) {
        const n = Math.min(TILE, T - j);
        for (let p = 0; p < 4; p++) {
          const b = (s * 4 + p) * FR * T + j;
          for (let f = 0; f < FR; f++) {
            const src = b + f * T;
            for (let q = 0; q < n; q++) fr[(q * 4 + p) * FR + f] = x[src + q];
          }
        }
      }
      const o = jt * 4 * FR;
      // inverse = conj(FFT(conj(Y))) / N, Y = A + iB with A, B Hermitian (the Nyquist bin is zero, as in _ispec)
      for (let f = 0; f < FR; f++) {
        const ar = fr[o + f], ai = fr[o + FR + f], br = fr[o + 2 * FR + f], bi = fr[o + 3 * FR + f];
        fin[2 * f] = ar - bi; fin[2 * f + 1] = -(ai + br);
        if (f) { fin[2 * (N - f)] = ar + bi; fin[2 * (N - f) + 1] = ai - br; }
      }
      fin[2 * FR] = 0; fin[2 * FR + 1] = 0;
      fj.transform(fout, fin);
      const s0 = j * HOP;
      for (let n = 0; n < N; n++) { const w = win[n] * g; y0[s0 + n] += fout[2 * n] * w; y1[s0 + n] -= fout[2 * n + 1] * w; }
    }
    const o0 = new Float32Array(L), o1 = new Float32Array(L), x0 = s * 2 * L, x1 = x0 + L;
    for (let i = 0; i < L; i++) { o0[i] = y0[i + PAD] * envInv + xt[x0 + i]; o1[i] = y1[i + PAD] * envInv + xt[x1 + i]; }
    out.push(o0, o1);
  }
  return out;
}
