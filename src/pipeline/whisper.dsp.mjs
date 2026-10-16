// Whisper's log-mel spectrogram, as faster-whisper's FeatureExtractor makes it (feature_extractor.py): a 400-point
// STFT every 160 samples of 16 kHz audio (periodic Hann window, reflected at both ends), power, the Slaney-style mel
// filters, log10. This file does the power spectra and filters on a worker (a 400-point DFT, in double precision);
// whisper.mjs takes the log and the song-wide maximum.
export const N_FFT = 400, HOP = 160, BINS = N_FFT / 2 + 1;

let tables = null;
function trig() {
  if (tables) return tables;
  const cos = new Float64Array(N_FFT), sin = new Float64Array(N_FFT);
  for (let i = 0; i < N_FFT; i++) { cos[i] = Math.cos(2 * Math.PI * i / N_FFT); sin[i] = Math.sin(2 * Math.PI * i / N_FFT); }
  // np.hanning(401)[:-1] in float32
  const win = new Float32Array(N_FFT);
  for (let n = 0; n < N_FFT; n++) win[n] = 0.5 - 0.5 * Math.cos(2 * Math.PI * n / N_FFT);
  return tables = {cos, sin, win};
}

/** get_mel_filters(16000, 400, n_mels) as float32 [n_mels * 201]. */
export function melFilters(nMels, sr = 16000) {
  const fft = Float64Array.from({length: BINS}, (_, i) => i * sr / N_FFT);
  const maxMel = 45.245640471924965, fSp = 200 / 3, minLogHz = 1000, minLogMel = minLogHz / fSp, logstep = Math.log(6.4) / 27;
  const freqs = new Float64Array(nMels + 2);
  for (let i = 0; i < nMels + 2; i++) {
    const m = maxMel * i / (nMels + 1);                          // np.linspace(0, max_mel, n_mels + 2)
    freqs[i] = m >= minLogMel ? minLogHz * Math.exp(logstep * (m - minLogMel)) : fSp * m;
  }
  const out = new Float32Array(nMels * BINS);
  for (let m = 0; m < nMels; m++) {
    const enorm = 2 / (freqs[m + 2] - freqs[m]);
    for (let b = 0; b < BINS; b++) {
      const lower = -(freqs[m] - fft[b]) / (freqs[m + 1] - freqs[m]);
      const upper = (freqs[m + 2] - fft[b]) / (freqs[m + 2] - freqs[m + 1]);
      out[m * BINS + b] = Math.max(0, Math.min(lower, upper)) * enorm;
    }
  }
  return out;
}

/** Mel power of frames f0..f1 of the padded signal x (x[0] is sample (from) of the reflected, padded waveform):
 * Float32Array [n_mels * (f1 - f0)], mel-major. */
export function melPower(x, from, f0, f1, filters, nMels) {
  const {cos, sin, win} = trig();
  const nf = f1 - f0, out = new Float32Array(nMels * nf), frame = new Float32Array(N_FFT), pw = new Float32Array(BINS);
  for (let f = f0; f < f1; f++) {
    const o = f * HOP - from;
    for (let n = 0; n < N_FFT; n++) frame[n] = Math.fround(x[o + n] * win[n]);
    for (let k = 0; k < BINS; k++) {
      let re = 0, im = 0;
      for (let n = 0, idx = 0; n < N_FFT; n++, idx += k) {
        if (idx >= N_FFT) idx -= N_FFT;
        re += frame[n] * cos[idx];
        im -= frame[n] * sin[idx];
      }
      // complex64, then |z|**2 in float32
      const a = Math.fround(Math.hypot(Math.fround(re), Math.fround(im)));
      pw[k] = Math.fround(a * a);
    }
    for (let m = 0; m < nMels; m++) {
      let s = 0;
      const row = m * BINS;
      for (let k = 0; k < BINS; k++) s += filters[row + k] * pw[k];
      out[m * nf + (f - f0)] = s;
    }
  }
  return out;
}
