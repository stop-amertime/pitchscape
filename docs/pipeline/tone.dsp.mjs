// Roughness and sharpness of 200 ms slices at 48 kHz, as server/pipeline.py `_tone_slice` measures them with MOSQITO
// 1.2.1 (Green Forge Coop, Apache-2.0): roughness_dw(seg, 48000, overlap=0) (Daniel & Weber 1997) and
// sharpness_din_freq(spec, freqs) (DIN 45692, on loudness_zwst_freq: Zwicker loudness, ISO 532-1, from a spectrum).
// Transcribed from MOSQITO's source with its constants and tables, quirks included (they are noted where they look
// like slips, but kept: the point is to measure what the Python measures). numpy and scipy calls are written out as
// those libraries compute them. Apart from tone.mjs so worker threads can run it (worker.mjs).
import {buffer} from './vendor/fft64.mjs';

const FS = 48000, N = 9600, HALF = N / 2;           // TONE_SR, TONE_N: 200 ms

// ------------------------------------------------------------------ numpy, scipy
/** numpy.interp: linear interpolation, clamped to the end values. */
function interp(x, xp, fp) {
  const n = xp.length;
  if (x < xp[0]) return fp[0];
  if (x > xp[n - 1]) return fp[n - 1];
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (xp[m] <= x) lo = m; else hi = m; }
  const j = x >= xp[n - 1] ? n - 1 : lo;
  if (j === n - 1 || xp[j] === x) return fp[j];
  const slope = (fp[j + 1] - fp[j]) / (xp[j + 1] - xp[j]);
  let r = slope * (x - xp[j]) + fp[j];
  if (Number.isNaN(r)) { r = slope * (x - xp[j + 1]) + fp[j + 1]; if (Number.isNaN(r) && fp[j] === fp[j + 1]) r = fp[j]; }
  return r;
}
/** numpy.round(x, 8): scaled, rounded half to even, scaled back. */
function round8(x) {
  const y = x * 1e8;
  let r = Math.round(y);
  if (r - y === 0.5 && r % 2 !== 0) r -= 1;          // Math.round rounds halves up; numpy's rint to even
  return r / 1e8;
}
/** numpy.hanning(M) and numpy.blackman(M), in numpy's own form. */
function hanning(M) {
  const w = new Float64Array(M);
  for (let i = 0; i < M; i++) w[i] = 0.5 + 0.5 * Math.cos(Math.PI * (1 - M + 2 * i) / (M - 1));
  return w;
}
function blackman(M) {
  const w = new Float64Array(M);
  for (let i = 0; i < M; i++) {
    const n = 1 - M + 2 * i;
    w[i] = 0.42 + 0.5 * Math.cos(Math.PI * n / (M - 1)) + 0.08 * Math.cos(2.0 * Math.PI * n / (M - 1));
  }
  return w;
}
const sum = a => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]; return s; };
const db2amp = (db, ref = 1) => Math.pow(10, 0.05 * db) * ref;
const amp2db = (amp, ref = 1) => 20 * Math.log10((amp === 0 ? 2e-12 : amp) / ref);   // amp2db sets zeros to 2e-12

// complex numbers as [re, im]
const cadd = (a, b) => [a[0] + b[0], a[1] + b[1]], csub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const cmul = (a, b) => [a[0] * b[0] - a[1] * b[1], a[0] * b[1] + a[1] * b[0]];
const cdiv = (a, b) => { const d = b[0] * b[0] + b[1] * b[1]; return [(a[0] * b[0] + a[1] * b[1]) / d, (a[1] * b[0] - a[0] * b[1]) / d]; };
function csqrt([re, im]) {                            // principal square root, as numpy
  if (re === 0 && im === 0) return [0, im];
  const t = Math.sqrt((Math.abs(re) + Math.hypot(re, im)) / 2);
  return re >= 0 ? [t, im / (2 * t)] : [Math.abs(im) / (2 * t), im >= 0 ? t : -t];
}

/** |H|^2 of scipy.signal.butter(3, [w1, w2], 'bandpass', output='sos') at numpy.linspace(0, pi, n, endpoint=False), as
 * sosfreqz(sos, worN=n) evaluates it (buttap, lp2bp_zpk, bilinear_zpk; the response from the poles and zeros). */
function butterBandpassPower(w1, w2, n) {
  const order = 3, fs = 2.0;
  const warped = [2 * fs * Math.tan(Math.PI * w1 / fs), 2 * fs * Math.tan(Math.PI * w2 / fs)];
  const bw = warped[1] - warped[0], wo = Math.sqrt(warped[0] * warped[1]);
  const p = [];
  for (let m = -order + 1; m < order; m += 2) {      // buttap: -exp(1j * pi * m / (2 * N))
    const a = Math.PI * m / (2 * order);
    p.push([-Math.cos(a), -Math.sin(a)]);
  }
  const plp = p.map(c => [c[0] * bw / 2, c[1] * bw / 2]);
  const pbp = [...plp.map(c => cadd(c, csqrt(csub(cmul(c, c), [wo ** 2, 0])))),
               ...plp.map(c => csub(c, csqrt(csub(cmul(c, c), [wo ** 2, 0]))))];
  const kbp = bw ** order;                             // zeros: `order` at s = 0
  const fs2 = 2.0 * fs;
  const pz = pbp.map(c => cdiv([fs2 + c[0], c[1]], [fs2 - c[0], -c[1]]));
  let num = [1, 0], den = [1, 0];                      // k_z = k * real(prod(fs2 - z) / prod(fs2 - p))
  for (let i = 0; i < order; i++) num = cmul(num, [fs2, 0]);
  for (const c of pbp) den = cmul(den, [fs2 - c[0], -c[1]]);
  const kz = kbp * cdiv(num, den)[0];
  const out = new Float64Array(n), step = Math.PI / n;
  for (let k = 0; k < n; k++) {
    const w = k * step, zr = Math.cos(w), zi = Math.sin(w);
    let g = kz * kz;
    g *= ((zr - 1) ** 2 + zi * zi) ** order;           // zeros at z = 1 (from s = 0) and z = -1 (bilinear)
    g *= ((zr + 1) ** 2 + zi * zi) ** order;
    for (const c of pz) g /= (zr - c[0]) ** 2 + (zi - c[1]) ** 2;
    out[k] = g;
  }
  return out;
}

// ------------------------------------------------------------------ MOSQITO utils
const BARK_F = [0, 50, 100, 150, 200, 250, 300, 350, 400, 450, 510, 570, 630, 700, 770, 840, 920, 1000, 1080, 1170,
  1270, 1370, 1480, 1600, 1720, 1850, 2000, 2150, 2320, 2500, 2700, 2900, 3150, 3400, 3700, 4000, 4400, 4800, 5300,
  5800, 6400, 7000, 7700, 8500, 9500, 10500, 12000, 13500, 15500, 20000];
const BARK_Z = BARK_F.map((_, i) => i * 0.5);          // arange(0, 25, 0.5)
const freq2bark = f => interp(f, BARK_F, BARK_Z);
const bark2freq = z => interp(z, BARK_Z, BARK_F);
// LTQ(bark, reference="roughness")
const LTQ_X = [0, 0.01, 0.17, 0.8, 1, 1.5, 2, 3.3, 4, 5, 6, 8, 10, 12, 13.3, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24,
  24.5, 25];
const LTQ_Y = [130, 70, 60, 30, 25, 20, 15, 10, 8.1, 6.3, 5, 3.5, 2.5, 1.7, 0, -2.5, -4, -3.7, -1.5, 1.4, 3.8, 5, 7.5,
  15, 48, 60, 130];
// _ear_filter_coeff: Zwicker & Fastl fig. 8.18
const A0_X = [0, 10, 12, 13, 14, 15, 16, 16.5, 17, 18, 18.5, 19, 20, 21, 21.5, 22, 22.5, 23, 23.5, 24, 25, 26];
const A0_Y = [0, 0, 1.15, 2.31, 3.85, 5.62, 6.92, 7.38, 6.92, 4.23, 2.31, 0, -1.43, -2.59, -3.57, -5.19, -7.41, -11.3,
  -20, -40, -130, -999];

// ------------------------------------------------------------------ roughness_dw
const NCH = 47;
// _gzi_weighting(arange(1, 48) / 2): Aures
const GR_Y = [0.15, 0.26, 0.38, 0.47, 0.54, 0.65, 0.76, 0.83, 0.90, 0.98, 0.98, 0.90, 0.80, 0.70, 0.62, 0.54, 0.49,
  0.43, 0.39, 0.35, 0.30, 0.30, 0.30, 0.30, 0.30];
const GR_X = GR_Y.map((_, i) => i);
const gzi = Float64Array.from({length: NCH}, (_, i) => interp((i + 1) / 2, GR_X, GR_Y));

/** _H_weighting(n, fs): the 47 modulation weightings, nonzero only from bin 2 to bin `last` - 1; kept as [channel] ->
 * Float64Array of bins 0..HLEN-1. */
const HLEN = 101;
const H = (() => {
  const cut = 2, n = N, fs = FS;
  const h = Array.from({length: NCH}, () => new Float64Array(HLEN));
  const fill = (row, last, X, Y) => { for (let j = cut; j < last; j++) h[row][j] = interp(j * fs / n, X, Y); };
  const H2_X = [0, 17, 23, 25, 32, 37, 48, 67, 90, 114, 171, 206, 247, 294, 358];
  const H2_Y = [0, 0.8, 0.95, 0.975, 1, 0.975, 0.9, 0.8, 0.7, 0.6, 0.4, 0.3, 0.2, 0.1, 0];
  fill(1, Math.floor((358 / fs) * n), H2_X, H2_Y);
  const H5_X = [0, 32, 43, 56, 69, 92, 120, 142, 165, 231, 277, 331, 397, 502];
  const H5_Y = [0, 0.8, 0.95, 1, 0.975, 0.9, 0.8, 0.7, 0.6, 0.4, 0.3, 0.2, 0.1, 0];
  const last = Math.floor((502 / fs) * n);
  fill(4, last, H5_X, H5_Y);
  const H16_X = [0, 23.5, 34, 47, 56, 63, 79, 100, 115, 135, 159, 172, 194, 215, 244, 290, 348, 415, 500, 645];
  const H16_Y = [0, 0.4, 0.6, 0.8, 0.9, 0.95, 1, 0.975, 0.95, 0.9, 0.85, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.2, 0.1, 0];
  fill(15, last, H16_X, H16_Y);
  const H21_X = [0, 19, 44, 52.5, 58, 75, 101.5, 114.5, 132.5, 143.5, 165.5, 197.5, 241, 290, 348, 415, 500, 645];
  const H21_Y = [0, 0.4, 0.8, 0.9, 0.95, 1, 0.95, 0.9, 0.85, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.2, 0.1, 0];
  fill(20, last, H21_X, H21_Y);
  const H42_X = [0, 15, 41, 49, 53, 64, 71, 88, 94, 106, 115, 137, 180, 238, 290, 348, 415, 500, 645];
  const H42_Y = [0, 0.4, 0.8, 0.9, 0.965, 0.99, 1, 0.95, 0.9, 0.85, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.2, 0.1, 0];
  fill(41, last, H42_X, H42_Y);
  h[0] = h[2] = h[3] = h[1];
  for (let i = 5; i < 15; i++) h[i] = h[4];
  for (let i = 16; i < 20; i++) h[i] = h[15];
  for (let i = 21; i < 41; i++) h[i] = h[20];
  for (let i = 42; i < 47; i++) h[i] = h[41];
  return h;
})();

// what _roughness_dw_main_calc derives from the frequency axis alone
const freqAxis = Float64Array.from({length: HALF}, (_, k) => (k + 1) * (FS / N));   // arange(1, nperseg//2 + 1) * fs/n
const barkAxis = freqAxis.map(freq2bark);
const a0 = barkAxis.map(b => db2amp(interp(b, A0_X, A0_Y), 1));
const threshold = barkAxis.map(b => interp(b, LTQ_X, LTQ_Y));
const nZ = Float64Array.from({length: HALF}, (_, k) => k + 1);
const minExcitDB = Float64Array.from({length: NCH}, (_, i) => interp(bark2freq((i + 1) / 2) * N / FS, nZ, threshold));
const winB = (() => { const w = blackman(N), s = sum(w); return w.map(v => v / s); })();

const fb = buffer(N);

/** roughness_dw(sig, 48000, overlap=0) on one 200 ms slice (Float64Array(N)): R in asper. */
export function roughness(sig) {
  // comp_spectrum(sig, fs, nfft="default", window="blackman", db=False): fft(sig * window)[0:n//2] * 1.42
  let d = fb.data();
  for (let i = 0; i < N; i++) { d[2 * i] = sig[i] * winB[i]; d[2 * i + 1] = 0; }
  d = fb.forward();
  const sre = new Float64Array(HALF), sim = new Float64Array(HALF);
  for (let k = 0; k < HALF; k++) { sre[k] = d[2 * k] * 1.42; sim[k] = d[2 * k + 1] * 1.42; }
  // _roughness_dw_main_calc. The spectrum is made two-sided (spec, reversed), n = 9600; the ear filter a0 covers the
  // first half only, so the second half is zero from here on and only the first half is kept.
  const n = N;
  const module = new Float64Array(HALF), specDB = new Float64Array(HALF);
  for (let k = 0; k < HALF; k++) {
    sre[k] *= a0[k]; sim[k] *= a0[k];
    module[k] = Math.hypot(sre[k], sim[k]);
    if (module[k] === 0) module[k] = 2e-12;            // amp2db writes into `module`
    specDB[k] = amp2db(module[k], 2e-5);
  }
  const aud = [];
  for (let k = 0; k < HALF; k++) if (specDB[k] > threshold[k]) aud.push(k);
  const nAud = aud.length;
  // stage 1: excitation patterns, Terhardt's slopes
  const s1 = -27;
  const chLow = new Int32Array(nAud), chHigh = new Int32Array(nAud);
  const slopes = Array.from({length: nAud}, () => new Float64Array(NCH));
  for (let k = 0; k < nAud; k++) {
    const ind = aud[k], levDB = specDB[ind], b = barkAxis[ind];
    const s2 = Math.min(-24 - (230 / freqAxis[ind]) + (0.2 * levDB), 0);
    chLow[k] = Math.floor(2 * b) - 1;
    chHigh[k] = Math.ceil(2 * b) - 1;
    if (chLow[k] >= NCH) throw new Error('index 47 is out of bounds (as numpy raises)');   // only past 24 bark
    for (let j = 0; j < chLow[k] + 1; j++) {
      const sl = (s1 * (b - ((j + 1) * 0.5))) + levDB;
      if (sl > minExcitDB[j]) slopes[k][j] = db2amp(sl, 0.00002);
    }
    for (let j = chHigh[k]; j < NCH; j++) {
      const sl = (s2 * (((j + 1) * 0.5) - b)) + levDB;
      if (sl > minExcitDB[j]) slopes[k][j] = db2amp(sl, 0.00002);
    }
  }
  // stage 2: each channel's excitation in time, its envelope weighted by H, the modulation depth
  const hBP = new Array(NCH).fill(null), allNonzero = new Uint8Array(NCH), modDepth = new Float64Array(NCH);
  const te = new Float64Array(n);
  for (let i = 0; i < NCH; i++) {
    d = fb.data();
    d.fill(0);
    let any = false;
    for (let j = 0; j < nAud; j++) {
      const ind = aud[j];
      let ampl;
      if (chLow[j] === i) ampl = 1;
      else if (chHigh[j] === i) ampl = 1;
      else if (chHigh[j] > i) ampl = slopes[j][i + 1] / module[ind];
      else ampl = slopes[j][i - 1] / module[ind];
      d[2 * ind] = ampl * sre[ind]; d[2 * ind + 1] = ampl * sim[ind];
      if (d[2 * ind] !== 0 || d[2 * ind + 1] !== 0) any = true;
    }
    if (!any) { hBP[i] = new Float64Array(n); continue; }   // all zero: so is everything below (as numpy finds it)
    // temporal_excitation = abs(n * real(ifft(exc)))
    d = fb.inverse();
    let h0 = 0;
    for (let t = 0; t < n; t++) { te[t] = Math.abs(d[2 * t]); h0 += te[t]; }
    h0 /= n;
    // envelope_spec = fft(te - h0) * hWeight[i]; hBP = 2 * real(ifft(envelope_spec))
    for (let t = 0; t < n; t++) { d[2 * t] = te[t] - h0; d[2 * t + 1] = 0; }
    d = fb.forward();
    const w = H[i];
    for (let k = 0; k < n; k++) {
      const g = k < HLEN ? w[k] : 0;
      d[2 * k] *= g; d[2 * k + 1] *= g;
    }
    d = fb.inverse();
    const h = new Float64Array(n);
    let ss = 0, nz = 1;
    for (let t = 0; t < n; t++) { h[t] = 2 * (d[2 * t] / n); ss += h[t] * h[t]; if (h[t] === 0) nz = 0; }
    hBP[i] = h; allNonzero[i] = nz;
    const hBPrms = Math.sqrt(ss / n);
    if (h0 > 0) modDepth[i] = Math.min(hBPrms / h0, 1);
    else modDepth[i] = 0;
  }
  // stage 3: cross-correlation of channels i and i + 2 (1 bark apart)
  const ki = new Float64Array(NCH);
  for (let i = 0; i < 45; i++) if (allNonzero[i] && allNonzero[i + 2]) ki[i] = corrcoef(hBP[i], hBP[i + 2]);
  const Rs = new Float64Array(NCH);
  Rs[0] = gzi[0] * Math.pow(modDepth[0] * ki[0], 2);
  Rs[1] = gzi[1] * Math.pow(modDepth[1] * ki[1], 2);
  for (let i = 2; i < 45; i++) Rs[i] = gzi[i] * Math.pow(modDepth[i] * ki[i] * ki[i - 2], 2);
  Rs[45] = gzi[45] * Math.pow(modDepth[45] * ki[43], 2);
  Rs[46] = gzi[46] * Math.pow(modDepth[46] * ki[44], 2);
  return 0.25 * sum(Rs);
}

/** numpy.corrcoef(x, y)[0, 1]. */
function corrcoef(x, y) {
  const n = x.length;
  let mx = 0, my = 0;
  for (let i = 0; i < n; i++) { mx += x[i]; my += y[i]; }
  mx /= n; my /= n;
  let cxx = 0, cyy = 0, cxy = 0;
  for (let i = 0; i < n; i++) { const a = x[i] - mx, b = y[i] - my; cxx += a * a; cyy += b * b; cxy += a * b; }
  const r = cxy / (n - 1) / Math.sqrt(cxx / (n - 1)) / Math.sqrt(cyy / (n - 1));
  return Number.isNaN(r) ? r : Math.max(-1, Math.min(1, r));
}

// ------------------------------------------------------------------ loudness_zwst_freq
// noct_synthesis(spectrum, freqs, fmin=24, fmax=12600): third-octave levels through scipy Butterworth band filters
const BANDS = (() => {
  const n = 3, b = 1 / n, U = 10 ** (3 * b / 10), fr = 1000;
  const kmin = Math.round(Math.log10(24 / fr) / Math.log10(U)), kmax = Math.round(Math.log10(12600 / fr) / Math.log10(U));
  const out = [];
  for (let k = kmin; k <= kmax; k++) {
    const fc = fr * U ** k;
    const f1 = fc / (2 ** (b / 2)), f2 = fc * (2 ** (b / 2)), qr = fc / (f2 - f1);
    const qd = (Math.PI / 2 / 3) / (Math.sin(Math.PI / 2 / 3)) * qr;
    const alpha = (1 + Math.sqrt(1 + 4 * qd ** 2)) / 2 / qd;
    if (f2 > FS / 2) continue;
    const fs = FS;
    out.push(butterBandpassPower(fc / (fs / 2) / alpha, fc / (fs / 2) * alpha, HALF + 1));
  }
  return out;
})();

// _main_loudness (field_type "free")
const RAP = [45, 55, 65, 71, 80, 90, 100, 120];
const DLL = [
  [-32, -24, -16, -10, -5, 0, -7, -3, 0, -2, 0],
  [-29, -22, -15, -10, -4, 0, -7, -2, 0, -2, 0],
  [-27, -19, -14, -9, -4, 0, -6, -2, 0, -2, 0],
  [-25, -17, -12, -9, -3, 0, -5, -2, 0, -2, 0],
  [-23, -16, -11, -7, -3, 0, -4, -1, 0, -1, 0],
  [-20, -14, -10, -6, -3, 0, -4, -1, 0, -1, 0],
  [-18, -12, -9, -6, -2, 0, -3, -1, 0, -1, 0],
  [-15, -10, -8, -4, -2, 0, -3, -1, 0, -1, 0]];
const LTQ_Z = [30, 18, 12, 8, 7, 6, 5, 4, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3];
const A0_Z = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, -0.5, -1.6, -3.2, -5.4, -5.6, -4, -1.5, 2, 5, 12];
const DCB = [-0.25, -0.6, -0.8, -0.8, -0.5, 0, 0.5, 1.1, 1.5, 1.7, 1.8, 1.8, 1.7, 1.6, 1.4, 1.2, 0.8, 0.5, 0, -0.5];

function mainLoudness(third) {
  let mx = -Infinity;
  for (let b = 0; b < 11; b++) mx = Math.max(mx, third[b]);
  if (mx > 120.0) throw new Error('1/3 octave band value exceed 120 dB, for which the Zwicker method is no longer valid.');
  const nb = DLL[0].length;
  const logic = RAP.map((r, i) => Array.from({length: nb}, (_, b) => third[b] > r - DLL[i][b]));
  const dllRes = DLL[0].slice();
  for (let b = 0; b < nb; b++) if (logic[0][b]) dllRes[b] = 0;
  for (let i = 1; i < DLL.length - 1; i++) for (let b = 0; b < nb; b++) if (logic[i - 1][b] !== logic[i][b]) dllRes[b] = DLL[i][b];
  const ti = dllRes.map((v, b) => Math.pow(10, (v + third[b]) / 10));
  const gi = [ti.slice(0, 6), ti.slice(6, 9), ti.slice(9, 11)].map(sum);
  const lcb = gi.map(g => g > 0 ? 10 * Math.log10(g) : 0);
  const s = 0.25;
  const le = Array.from(third.slice(8));
  le[0] = lcb[0]; le[1] = lcb[1]; le[2] = lcb[2];
  const nm = new Float64Array(21);
  for (let k = 0; k < 20; k++) {
    le[k] -= A0_Z[k];
    const on = le[k] > LTQ_Z[k];
    if (on) le[k] -= DCB[k];
    const mp1 = on ? 0.0635 * Math.pow(10, 0.025 * LTQ_Z[k]) : 0;
    const mp2 = on ? Math.pow(1 - s + s * Math.pow(10, 0.1 * (le[k] - LTQ_Z[k])), 0.25) - 1 : 0;
    let v = on ? mp1 * mp2 : 0;
    if (v < 0) v = 0;
    nm[k] = v;
  }
  const korry = 0.4 + 0.32 * nm[0] ** 0.2;
  if (korry <= 1) nm[0] *= korry;
  return nm;
}

// _calc_slopes
const ZUP = [0.9, 1.8, 2.8, 3.5, 4.4, 5.4, 6.6, 7.9, 9.2, 10.6, 12.3, 13.8, 15.2, 16.7, 18.1, 19.3, 20.6, 21.8, 22.7,
  23.6, 24];
const RNS = [21.5, 18, 15.1, 11.5, 9, 6.1, 4.4, 3.1, 2.13, 1.36, 0.82, 0.42, 0.30, 0.22, 0.15, 0.10, 0.035, 0];
const USL = [
  [13, 8.2, 6.3, 5.5, 5.5, 5.5, 5.5, 5.5],
  [9, 7.5, 6, 5.1, 4.5, 4.5, 4.5, 4.5],
  [7.8, 6.7, 5.6, 4.9, 4.4, 3.9, 3.9, 3.9],
  [6.2, 5.4, 4.6, 4.0, 3.5, 3.2, 3.2, 3.2],
  [4.5, 3.8, 3.6, 3.2, 2.9, 2.7, 2.7, 2.7],
  [3.7, 3.0, 2.8, 2.35, 2.2, 2.2, 2.2, 2.2],
  [2.9, 2.3, 2.1, 1.9, 1.8, 1.7, 1.7, 1.7],
  [2.4, 1.7, 1.5, 1.35, 1.3, 1.3, 1.3, 1.3],
  [1.95, 1.45, 1.3, 1.15, 1.1, 1.1, 1.1, 1.1],
  [1.5, 1.2, 0.94, 0.86, 0.82, 0.82, 0.82, 0.82],
  [0.72, 0.67, 0.64, 0.63, 0.62, 0.62, 0.62, 0.62],
  [0.59, 0.53, 0.51, 0.50, 0.42, 0.42, 0.42, 0.42],
  [0.40, 0.33, 0.26, 0.24, 0.24, 0.22, 0.22, 0.22],
  [0.27, 0.21, 0.20, 0.18, 0.17, 0.17, 0.17, 0.17],
  [0.16, 0.15, 0.14, 0.12, 0.11, 0.11, 0.11, 0.11],
  [0.12, 0.11, 0.10, 0.08, 0.08, 0.08, 0.08, 0.08],
  [0.09, 0.08, 0.07, 0.06, 0.06, 0.06, 0.06, 0.05],
  [0.06, 0.05, 0.03, 0.02, 0.02, 0.02, 0.02, 0.02]];
const usl = (r, c) => USL[r][Math.min(c < 0 ? c + 21 : c, 7)];   // usl_reshaped: column 7 repeated to 21 columns
const RNS8 = RNS.map(round8);
/** _get_rns_index for one value: how many of RNS lie above it (or at it too), 18 counted as 17. */
function rnsIndex(a, equalToo = false) {
  const r = round8(a);
  let c = 0;
  for (let i = 0; i < RNS8.length; i++) if (equalToo ? r <= RNS8[i] : r < RNS8[i]) c++;
  return c === 18 ? 17 : c;
}
const ZUP_EA = [...ZUP.map(z => Math.trunc(z * 10)), 0];     // (zup * 10).astype(int32), then 0 appended
const ea = i => ZUP_EA[i < 0 ? ZUP_EA.length + i : i];

/** _calc_slopes(nm) for one spectrum: total loudness N (sone) and specific loudness on 240 bark steps. The numpy
 * original works on columns with masks; with one column every mask is a single yes or no. */
function calcSlopes(nm) {
  const L = 240, W = nm.length;                        // spec_length, nm_wide (21)
  const at = i => (i < 0 ? i + L : i);                 // numpy's negative row index
  const n2 = new Float64Array(L).fill(1), z2 = new Float64Array(L).fill(1), uslS = new Float64Array(L).fill(1);
  const dzS = new Float64Array(L).fill(1), rnsS = new Float64Array(L).fill(1);
  const Nspec = new Float64Array(L);
  for (let i = 0; i < W - 1; i++) for (let r = ea(i - 1); r < ea(i); r++) Nspec[r] = nm[i];
  let N = 0;
  const rnsInd = Array.from(nm, v => rnsIndex(v));
  const rnsValues = rnsInd.map(i => RNS[i]);
  const uslArr = rnsInd.map((r, i) => usl(r, i));
  const dz = ZUP.map((z, i) => z - ZUP[(i - 1 + W) % W]);
  dz[0] = ZUP[1]; dz[1] = ZUP[1];
  for (let i = 0; i < W; i++) for (let r = ea(i - 1); r < ea(i); r++) {
    n2[r] = nm[i]; dzS[r] = dz[i]; z2[r] = ZUP[i]; uslS[r] = uslArr[i]; rnsS[r] = rnsValues[i];
  }
  let n1 = 0, z1 = 0;
  for (let i = 0; i < W; i++) {
    let j = ea(i - 1);
    let idx = rnsIndex(n2[at(j - 1)]);
    rnsS[j] = RNS[idx];
    uslS[j] = usl(idx, i - 1);
    let big = round8(n2[at(j - 1)]) > round8(nm[i]);
    if (!big) { N += n2[j] * (z2[j] - z1); n1 = n2[j]; z1 = z2[j]; }
    if (big) {
      let mx = Math.max(rnsS[at(j - 1)], nm[i]);
      z2[j] = Math.min((n1 - mx) / uslS[j] + z1, ZUP[i]);
      dzS[j] = z2[j] - z1;
      n2[j] = n1 - dzS[j] * uslS[j];
      N += dzS[j] * (n1 + n2[j]) / 2;
      let zA = ZUP[(i - 1 + W) % W] + 0.1;
      let zb = false;
      for (j = ea(i - 1); j < ea(i); j++) {
        if (j !== ea(i - 1) && big) {
          z2[j] = z2[j - 1]; n2[j] = n2[j - 1]; dzS[j] = dzS[j - 1]; uslS[j] = uslS[j - 1]; rnsS[j] = rnsS[j - 1];
        }
        zb = big && round8(z2[j]) <= round8(zA);
        if (zb) {
          idx = rnsIndex(n2[j], true);
          rnsS[j] = RNS[idx]; uslS[j] = usl(idx, i - 1);
          n1 = n2[j]; z1 = z2[j];
          const b1 = round8(n1) <= round8(nm[i]);
          if (b1) { n2[j] = nm[i]; z2[j] = ZUP[i]; dzS[j] = z2[j] - z1; N += n2[j] * (z2[j] - z1); }
          mx = Math.max(rnsS[j], nm[i]);
          if (!b1) {
            z2[j] = Math.min((n1 - mx) / uslS[j] + z1, ZUP[i]);
            dzS[j] = z2[j] - z1;
            n2[j] = n1 - dzS[j] * uslS[j];
            N += dzS[j] * (n1 + n2[j]) / 2;
            Nspec[j] = n1 - (zA - z1) * uslS[j];
          }
          zA += 0.1;
          if (b1) big = false;                        // mask_n1_bigger_nm ^= mask_z_bigger_z2_1
        } else {
          if (big) Nspec[j] = n1 - (zA - z1) * uslS[j];
          zA += 0.1;
        }
        z1 = z2[j]; n1 = n2[j];
        if (!big) break;
      }
      if (j === ea(i)) j--;                             // the for loop's variable keeps its last value
      z1 = z2[ea(i) - 1]; n1 = n2[ea(i) - 1];
      if (zb) { idx = rnsIndex(n2[j], true); rnsS[j] = RNS[idx]; uslS[j] = usl(idx, i - 1); }
    }
  }
  if (N < 0) N = 0;
  N = N <= 16 ? Math.floor(N * 1000 + 0.5) / 1000 : Math.floor(N * 100 + 0.5) / 100;
  return [N, Nspec];
}

// sharpness_din_from_loudness, weighting "din"
const Z240 = (() => {                                   // numpy.linspace(0.1, 24, 240)
  const z = new Float64Array(240), step = (24 - 0.1) / 239;
  for (let k = 0; k < 240; k++) z[k] = k * step + 0.1;
  z[239] = 24;
  return z;
})();
const G240 = Z240.map(z => z > 15.8 ? 0.15 * Math.exp(0.42 * (z - 15.8)) + 0.85 : 1);

/** sharpness_din_freq(spec, freqs) for spec on freqs = rfftfreq(9600, 1 / 48000): S in acum (NaN if N is 0). */
export function sharpness(spec) {
  const third = BANDS.map(h2 => { let s = 0; for (let k = 0; k < h2.length; k++) s += h2[k] * spec[k] * spec[k]; return amp2db(Math.sqrt(s), 2e-5); });
  const [N, Nspec] = calcSlopes(mainLoudness(third));
  let s = 0;
  for (let k = 0; k < 240; k++) s += Nspec[k] * G240[k] * Z240[k] * 0.1;
  return 0.11 * s / N;
}

const winH = hanning(N), winHsum = sum(winH);

/** _tone_slice on slices already cut: segs is a Float32Array of k * 9600 samples (48 kHz, at the 70 dB SPL mix's
 * level). Returns a Float64Array of k (roughness asper, sharpness acum) pairs; 0 for near silence and for NaN. */
export function slices(segs) {
  const k = segs.length / N, out = new Float64Array(2 * k), seg = new Float64Array(N), spec = new Float64Array(HALF + 1);
  for (let s = 0; s < k; s++) {
    let e = 0;
    for (let i = 0; i < N; i++) { seg[i] = segs[s * N + i]; e += seg[i] * seg[i]; }
    if (Math.sqrt(e / N) < 2e-4) continue;             // about 20 dB SPL
    const r = roughness(seg);
    // spec = abs(rfft(seg * hanning)) * 2 / w.sum() / sqrt(2)
    let d = fb.data();
    for (let i = 0; i < N; i++) { d[2 * i] = seg[i] * winH[i]; d[2 * i + 1] = 0; }
    d = fb.forward();
    for (let f = 0; f <= HALF; f++) spec[f] = Math.hypot(d[2 * f], d[2 * f + 1]) * 2 / winHsum / Math.sqrt(2);
    const sh = sharpness(spec);
    out[2 * s] = Number.isFinite(r) ? r : 0;
    out[2 * s + 1] = Number.isFinite(sh) ? sh : 0;
  }
  return out;
}
