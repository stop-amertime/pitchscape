// bass: pYIN (librosa 0.11, ISC) on the bass stem, as server/pipeline.py bass_line does it: the pitch and pYIN's own
// voicing decision (its HMM, decoded over the whole line), the stem's loudness (rms against its 98th percentile,
// followed by env_follow), and the brightness of each sounding frame (its upper harmonics' share, from Spec). The
// YIN frames, rms and brightness run on the runtime's worker threads by frame range; the HMM on one worker
// (bass.dsp.mjs).
import {HOP, envFollow, percentile} from './bass.dsp.mjs';

const DSP = './bass.dsp.mjs';
const f32 = Math.fround;
export const BASS_L_FLOOR = 0.02;       // bass down to 2% of the stem's loud level (the page's lever: default 8%)

/** Frames 0..nF split into `parts` ranges, each with the stretch of samples its frames reach (frame length `len`,
 * centred). */
export function frameRanges(nF, parts, n, len, hop = HOP) {
  const per = Math.ceil(nF / parts), out = [];
  for (let f0 = 0; f0 < nF; f0 += per) {
    const f1 = Math.min(nF, f0 + per);
    out.push({f0, f1, from: Math.max(0, f0 * hop - len / 2), to: Math.min(n, (f1 - 1) * hop + len / 2)});
  }
  return out;
}

/** The pYIN pitch of y (mono Float32Array, 22.05 kHz): {f0: Float64Array (NaN unvoiced), voiced: Uint8Array}, as
 * librosa.pyin(y, fmin=30, fmax=400, sr=22050, frame_length=4096, hop_length=512, center=True). */
export async function pyin(y, rt, {stats = {}} = {}) {
  const n = y.length, nF = 1 + Math.floor(n / HOP), pool = rt.pool;
  let t = performance.now();
  const parts = await Promise.all(frameRanges(nF, pool.size * 2, n, 4096).map(({f0, f1, from, to}) => {
    const part = y.slice(from, to);
    return pool.call(DSP, 'pyinObs', [part, from, n, f0, f1], [part.buffer]);
  }));
  stats.yin_ms = performance.now() - t;
  const nObs = parts.reduce((s, p) => s + p.bin.length, 0);
  const off = new Int32Array(nF + 1), bin = new Int16Array(nObs), prob = new Float64Array(nObs), vp = new Float64Array(nF);
  let f = 0, k = 0;
  for (const p of parts) {
    const m = p.vp.length;
    for (let i = 0; i < m; i++) off[f + i] = k + p.off[i];
    bin.set(p.bin, k); prob.set(p.prob, k); vp.set(p.vp, f);
    f += m; k += p.bin.length;
  }
  off[nF] = k;
  t = performance.now();
  const res = await pool.call(DSP, 'pyinDecode', [{off, bin, prob, vp}], [off.buffer, bin.buffer, prob.buffer, vp.buffer]);
  stats.viterbi_ms = performance.now() - t;
  return res;
}

/** librosa.feature.rms(y, frame_length=2048, hop_length=512, center=True) on the pool. */
export async function rmsPool(y, rt) {
  const n = y.length, nF = 1 + Math.floor(n / HOP), out = new Float32Array(nF);
  await Promise.all(frameRanges(nF, rt.pool.size, n, 2048).map(({f0, f1, from, to}) => {
    const part = y.slice(from, to);
    return rt.pool.call(DSP, 'rms', [part, {frame: 2048, hop: HOP, f0, f1, from, n}], [part.buffer])
      .then(r => out.set(r, f0));
  }));
  return out;
}

/** pipeline.py brightness(Spec(y), f, hz[f], nHarm, split) for every frame f with hz[f] > 0, on the pool; 0 elsewhere.
 * Returns Float32Array(hz.length). */
export async function brightnessPool(y, hz, nHarm, split, rt) {
  const n = y.length, F = hz.length, out = new Float32Array(F);
  await Promise.all(frameRanges(F, rt.pool.size, n, 4096).map(({f0, f1, from, to}) => {
    const fr = [], h = [];
    for (let f = f0; f < f1; f++) if (hz[f] > 0) { fr.push(f); h.push(hz[f]); }
    if (!fr.length) return null;
    const part = y.slice(Math.min(from, n), Math.max(Math.min(from, n), to));
    const frames = Int32Array.from(fr), hzs = Float32Array.from(h);
    return rt.pool.call(DSP, 'brightness', [part, Math.min(from, n), n, frames, hzs, nHarm, split], [part.buffer])
      .then(b => fr.forEach((f, i) => { out[f] = b[i]; }));
  }));
  return out;
}

/** server/pipeline.py bass_line: bass22 the bass stem's mono mix at 22.05 kHz (Float32Array), F the song's frames.
 * Returns {bassN, bassHz, bassBr}, Float32Array(F) each. */
export async function bass(bass22, F, rt, {stats = {}} = {}) {
  const y = bass22, t0 = performance.now();
  const [{f0, voiced}, rms] = await Promise.all([pyin(y, rt, {stats}), rmsPool(y, rt)]);
  if (stats.raw) Object.assign(stats, {f0, voiced});
  const n = Math.min(F, f0.length, rms.length);
  const ref = f32(percentile(rms.subarray(0, n), 98) + 1e-9);
  const lvl = new Float32Array(n), cap = f32(1.2);
  for (let i = 0; i < n; i++) lvl[i] = Math.min(cap, f32(rms[i] / ref));
  const bassN = new Float32Array(F);
  bassN.set(envFollow(lvl));
  // pYIN decides whether the bass sounds; how quiet a bass still prints is the page's lever
  const bassHz = new Float32Array(F), floor = f32(BASS_L_FLOOR);
  for (let i = 0; i < n; i++) if (voiced[i] && Number.isFinite(f0[i]) && bassN[i] >= floor) bassHz[i] = f0[i];
  const t1 = performance.now();
  const br = await brightnessPool(y, bassHz, 7, 3, rt);
  stats.brightness_ms = performance.now() - t1;
  const bassBr = new Float32Array(F), k = f32(0.2);
  let e = 0;
  for (let i = 0; i < F; i++) { e = f32(e + f32(k * f32(br[i] - e))); bassBr[i] = e; }
  stats.bass_ms = performance.now() - t0;
  return {bassN, bassHz, bassBr};
}
