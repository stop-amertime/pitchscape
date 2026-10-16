// voice: CREPE (Kim et al. 2018; torchcrepe 0.0.24, MIT; model 'full') on the vocal stem, as server/pipeline.py
// voice_line does it: the pitch every 10 ms and how sure the network is of it (periodicity), decoded with torchcrepe's
// Viterbi and smoothed with its median and mean filters, read at the page's frames; the stem's loudness (rms against
// its 98th percentile); which frames are sung (voice_gate); the brightness of each heard frame; and syllable onsets
// (librosa's onset detection inside sung runs). The network runs on the GPU in chunks (models take turns there); the
// framing, decoding, spectra and onsets run on the runtime's worker threads (voice.dsp.mjs).
import {HOP, SR, percentile} from './bass.dsp.mjs';
import {brightnessPool, frameRanges, rmsPool} from './bass.mjs';
import {BINS, WINDOW, binsToFrequency, median3, mean3} from './voice.dsp.mjs';

const DSP = './voice.dsp.mjs';
const f32 = Math.fround;
export const VOICE_P_FLOOR = 0.15;      // voice frames down to CREPE periodicity 0.15 (the default cutoff: 0.45)
export const VOICE_L_FLOOR = 0.01;      // and down to 1% of the vocal stem's loud level (default 4%)
const BATCH = 1024;                     // torchcrepe.predict's batch_size in the pipeline: each is decoded on its own
const CHUNK = 128;                      // frames per call to the network (its first layer holds 1 MB a frame)
const HOP16 = 160;                      // 10 ms at 16 kHz
const DT = HOP / SR;                    // the page's frame

/** pipeline.py voice_gate: which frames are sung: hz finite, periodicity at least pMin, level at least lMin (both
 * compared in float32, as numpy 2 does), in runs of at least runMin frames. Returns Uint8Array. */
export function voiceGate(per, rel, hz, pMin, lMin, runMin) {
  const F = per.length, v = new Uint8Array(F), p = f32(pMin), l = f32(lMin);
  for (let f = 0; f < F; f++) v[f] = Number.isFinite(hz[f]) && per[f] >= p && rel[f] >= l ? 1 : 0;
  for (let f = 0; f < F;) {
    if (!v[f]) { f++; continue; }
    let g = f;
    while (g < F && v[g]) g++;
    if (g - f < runMin) v.fill(0, f, g);
    f = g;
  }
  return v;
}

/** torchcrepe.predict(v16, 16000, 160, fmin=65, fmax=1100, model='full', batch_size=1024, return_periodicity=True)
 * then filter.median(periodicity, 3) and filter.mean(pitch, 3): {pitch, per} (Float32Array each, one per 10 ms). */
export async function crepe(v16, rt, {stats = {}, dither = true} = {}) {
  const n = v16.length, total = 1 + Math.floor(n / HOP16), pool = rt.pool;
  const sess = await rt.session('crepe_full');
  const bins = new Int16Array(total), per = new Float32Array(total);
  let gpu = 0;
  const decodes = [];
  // frames for the next chunks are made on the workers while the network runs
  const framesOf = (i0, i1) => {
    const from = Math.max(0, i0 * HOP16 - WINDOW / 2), to = Math.min(n, (i1 - 1) * HOP16 + WINDOW / 2);
    const part = v16.slice(from, Math.max(from, to));
    return pool.call(DSP, 'crepeFrames', [part, from, n, i0, i1, HOP16], [part.buffer]);
  };
  const chunks = [];
  for (let i = 0; i < total; i += CHUNK) chunks.push([i, Math.min(total, i + CHUNK)]);
  const ahead = Math.max(2, pool.size), made = chunks.slice(0, ahead).map(([a, b]) => framesOf(a, b));
  let batch = new Float32Array(Math.min(BATCH, total) * BINS), b0 = 0;
  for (let c = 0; c < chunks.length; c++) {
    const [i0, i1] = chunks[c];
    if (c + ahead < chunks.length) made.push(framesOf(...chunks[c + ahead]));
    const frames = await made[c];
    made[c] = null;
    const t = performance.now();
    const out = await sess.run({frames: {data: frames, dims: [i1 - i0, WINDOW]}});
    gpu += performance.now() - t;
    const p = out.probabilities.data;
    batch.set(p instanceof Float32Array ? p : Float32Array.from(p), (i0 - b0) * BINS);
    // a whole batch of 1024 frames (or the last): decoded on a worker, as torchcrepe decodes each batch alone
    if (i1 - b0 === BATCH || i1 === total) {
      const T = i1 - b0, at = b0, probs = batch.subarray(0, T * BINS).slice();
      decodes.push(pool.call(DSP, 'crepeDecode', [probs, T], [probs.buffer]).then(r => {
        bins.set(r.bins, at);
        per.set(r.per, at);
      }));
      b0 = i1;
      batch = new Float32Array(Math.min(BATCH, total - i1) * BINS);
    }
  }
  const t = performance.now();
  await Promise.all(decodes);
  stats.crepe_ms = gpu;
  stats.decode_wait_ms = performance.now() - t;
  return {pitch: mean3(binsToFrequency(bins, dither)), per: median3(per)};
}

/** server/pipeline.py voice_line: vocals44 [left, right] (Float32Array) at 44.1 kHz, F the song's frames. Returns
 * {leadHz, leadP, leadL, leadN, leadBr, leadNz (Float32Array(F) each), noiseRef: [lo, hi], onsets: [[t, gap, end,
 * weight]...]}. stats.dither = false leaves out torchcrepe's random dither (to compare with Python run that way). */
export async function voice(vocals44, F, rt, {stats = {}} = {}) {
  const t0 = performance.now(), pool = rt.pool;
  const [l, r] = vocals44, n44 = l.length;
  const mono = new Float32Array(n44);
  for (let i = 0; i < n44; i++) mono[i] = (l[i] + r[i]) / 2;
  const m2 = mono.slice();
  const [v16, y] = await Promise.all([
    pool.call('./resample.mjs', 'resample', [mono, 44100, 16000], [mono.buffer]),
    pool.call('./resample.mjs', 'resample', [m2, 44100, 22050], [m2.buffer])]);
  const n = y.length, nF = 1 + Math.floor(n / HOP);
  // the 22.05 kHz work (rms; the mel spectrogram for the onsets) runs on the workers alongside the network
  const tOn = performance.now();
  const melP = Promise.all(frameRanges(nF, pool.size, n, 2048).map(({f0, f1, from, to}) => {
    const part = y.slice(from, to);
    return pool.call(DSP, 'melFrames', [part, from, n, f0, f1], [part.buffer]);
  })).then(parts => {
    const all = new Float32Array(nF * 128);
    let o = 0;
    for (const p of parts) { all.set(p, o); o += p.length; }
    return pool.call(DSP, 'onsetDetect', [all, nF], [all.buffer]);
  }).then(x => { stats.onsets_ms = performance.now() - tOn; return x; });
  const rmsP = rmsPool(y, rt);
  const tC = performance.now();
  const {pitch, per} = await crepe(v16, rt, {stats, dither: stats.dither !== false});
  stats.crepe_total_ms = performance.now() - tC;
  if (stats.raw) Object.assign(stats, {pitch, per});

  // read at the page's frames: the nearest 10 ms frame
  const hz = new Float32Array(F), pr = new Float32Array(F);
  for (let f = 0; f < F; f++) {
    const x = f * DT / 0.01, r0 = Math.round(x);
    const i = Math.min(pitch.length - 1, Math.max(0, Math.abs(x % 1) === 0.5 && r0 % 2 ? r0 - 1 : r0));
    hz[f] = pitch[i]; pr[f] = per[i];
  }
  const rms0 = await rmsP, rms = new Float32Array(F);
  rms.set(rms0.subarray(0, Math.min(F, rms0.length)));
  const ref98 = f32(percentile(rms, 98) + 1e-9);
  const rel = Float32Array.from(rms, v => f32(v / ref98));
  const voiced = voiceGate(pr, rel, hz, 0.45, 0.04, 4);       // the page's default cutoffs, for the reference levels
  const pF = f32(VOICE_P_FLOOR), lF = f32(VOICE_L_FLOOR);
  const heard = Uint8Array.from({length: F}, (_, f) => Number.isFinite(hz[f]) && pr[f] >= pF && rel[f] >= lF ? 1 : 0);
  const sung = [];
  for (let f = 0; f < F; f++) if (voiced[f]) sung.push(rms[f]);
  const ref = sung.length ? f32(percentile(sung, 95) + 1e-9) : 1.0;
  const leadHz = new Float32Array(F), leadP = new Float32Array(F), leadL = new Float32Array(F);
  const leadN = new Float32Array(F), leadNz = new Float32Array(F), cap = f32(1.2);
  for (let f = 0; f < F; f++) {
    if (!heard[f]) continue;
    leadHz[f] = hz[f]; leadP[f] = pr[f]; leadL[f] = rel[f];
    leadN[f] = Math.min(cap, f32(Math.sqrt(f32(rms[f] / ref))));
    leadNz[f] = f32(1 - pr[f]);
  }
  const tB = performance.now();
  const leadBr = await brightnessPool(y, leadHz, 10, 4, rt);
  stats.brightness_ms = performance.now() - tB;
  const nz = [];
  for (let f = 0; f < F; f++) if (voiced[f]) nz.push(leadNz[f]);
  const noiseRef = nz.length ? [percentile(nz, 20), percentile(nz, 90)] : [0, 1];
  // syllable-ish onsets: the start of each sung run, plus librosa's onsets inside runs
  const inner = new Set(await melP);
  if (stats.raw) stats.inner = [...inner];
  const onsets = [];
  let prevEnd = -1e9;
  for (let f = 0; f < F;) {
    if (!voiced[f]) { f++; continue; }
    let g = f;
    while (g < F && voiced[g]) g++;
    onsets.push([f * DT, Math.min(30.0, (f - prevEnd) * DT), g * DT, 1.0]);
    for (let k = f + 5; k < g - 3; k++) if (inner.has(k)) onsets.push([k * DT, 0.0, g * DT, 0.7]);
    prevEnd = g;
    f = g;
  }
  stats.voice_ms = performance.now() - t0;
  return {leadHz, leadP, leadL, leadN, leadBr, leadNz, noiseRef, onsets};
}
