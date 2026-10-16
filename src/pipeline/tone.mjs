// tone: roughness (Daniel & Weber, asper) and sharpness (DIN 45692, acum) of what is heard, measured with MOSQITO
// 1.2.1's models on 200 ms slices at 48 kHz, as server/pipeline.py `tone` does: one slice early in each note (shared by
// notes of the same stem in the same slice) and every half second of voice and bass while they sound. Stems are first
// set to the level of a 70 dB SPL mix. The slices run on the runtime's worker threads (tone.dsp.mjs); resampling to
// 48 kHz is libsoxr at librosa's 'soxr_hq' (resample.mjs), also on the workers.

export const TONE_SR = 48000, TONE_N = 9600;
export const NOTE_STEMS = ['other', 'guitar', 'piano'];    // a note's source: its index here (pipeline.NOTE_STEMS)
const DT = 512 / 22050;                                     // the frame grid's step (pipeline.DT)
const DSP = './tone.dsp.mjs';
const BATCH = 16;                                           // slices per call to a worker

/** Python's round(): halves to even. */
export function pyRound(x) {
  const r = Math.round(x);
  return r - x === 0.5 && r % 2 !== 0 ? r - 1 : r;
}
const mono = ([l, r]) => { const y = new Float32Array(l.length); for (let i = 0; i < y.length; i++) y[i] = Math.fround(Math.fround(l[i] + r[i]) / 2); return y; };

/** The stems set for tone: {name: Float32Array at 48 kHz, scaled so the mix of all stems is 70 dB SPL (RMS 0.0632 Pa)},
 * for the names asked for. stems: {name: [left, right] Float32Array at 44.1 kHz}. As pipeline.tone: the mix is the sum
 * of the stems' mono means, resampled; each stem's mono mean resampled and multiplied by the gain, in float32. */
export async function toneStems(stems, names, rt) {
  const all = Object.values(stems).map(mono);
  const mix = new Float32Array(all[0].length);
  for (const v of all) for (let i = 0; i < mix.length; i++) mix[i] = Math.fround(mix[i] + v[i]);
  const want = names.filter(n => n in stems);
  const rs = x => rt.pool.call('./resample.mjs', 'resample', [x, 44100, TONE_SR], [x.buffer]);
  const [mix48, ...outs] = await Promise.all([mix, ...want.map(n => mono(stems[n]))].map(rs));
  let e = 0;
  for (let i = 0; i < mix48.length; i++) e += mix48[i] * mix48[i];
  const gain = Math.fround(0.0632 / (Math.sqrt(e / mix48.length) + 1e-12));     // numpy: the float32 array times gain
  const res = {};
  want.forEach((n, k) => { const y = outs[k]; for (let i = 0; i < y.length; i++) y[i] = Math.fround(y[i] * gain); res[n] = y; });
  return {stems: res, gain};
}

/** Roughness and sharpness of the slices centred at times `keys` ([name, seconds]) of the 48 kHz stems: a Map from
 * "name|seconds" to [asper, acum]. Slices that do not fit the stem give zeros, as pipeline._tone_slice. */
export async function measure(stems48, keys, rt, {progress = () => {}} = {}) {
  const res = new Map(), jobs = [];
  for (const [name, t] of keys) {
    const x = stems48[name], a = pyRound(t * TONE_SR) - TONE_N / 2;
    if (a < 0 || a + TONE_N > x.length) res.set(name + '|' + t, [0, 0]);
    else jobs.push([name, t, a]);
  }
  let done = 0;
  const batches = [];
  for (let b = 0; b < jobs.length; b += BATCH) batches.push(jobs.slice(b, b + BATCH));
  await Promise.all(batches.map(async batch => {
    const segs = new Float32Array(batch.length * TONE_N);
    batch.forEach(([name, , a], i) => segs.set(stems48[name].subarray(a, a + TONE_N), i * TONE_N));
    const out = await rt.pool.call(DSP, 'slices', [segs], [segs.buffer]);
    batch.forEach(([name, t], i) => res.set(name + '|' + t, [out[2 * i], out[2 * i + 1]]));
    progress(done += batch.length, jobs.length);
  }));
  return res;
}

/** pipeline.tone: stems {name: [left, right] Float32Array at 44.1 kHz}; segs the notes (notes_by_stem rows: start [0],
 * end [1], stem index [12]); leadHz and bassHz the voice and bass pitch per frame (0 where silent), F frames. Returns
 * {noteRs: [[asper, acum]] per note, lead: [rough, sharp], bass: [rough, sharp] (Float32Array(F) each), slices: how
 * many were measured}, as pipeline.tone's (note_rs, lead, bass, slices). stats gets where the time went (ms). */
export async function tone(stems, segs, leadHz, bassHz, F, rt, {stats = {}, progress} = {}) {
  const t0 = performance.now();
  const noteKey = r => [NOTE_STEMS[r[12]], pyRound((r[0] + Math.min(0.3, 0.5 * (r[1] - r[0]))) / 0.2) * 0.2];
  const names = [...new Set(['vocals', 'bass', ...segs.map(r => NOTE_STEMS[r[12]])])];
  const {stems: s48} = await toneStems(stems, names, rt);
  stats.tone_resample_ms = Math.round(performance.now() - t0);
  const jobs = new Map();
  for (const r of segs) { const [n, t] = noteKey(r); if (n in s48) jobs.set(n + '|' + t, [n, t]); }
  const grid = {};
  for (const [name, hz] of [['vocals', leadHz], ['bass', bassHz]]) {
    for (let k = 0; k < Math.trunc(F * DT / 0.5) + 1; k++) {
      const f = pyRound(k * 0.5 / DT);
      if (f < F && hz[f] > 0 && name in s48) jobs.set(name + '|' + k * 0.5, [name, k * 0.5]);
    }
    grid[name] = hz;
  }
  const t1 = performance.now();
  const res = await measure(s48, [...jobs.values()], rt, {progress});
  stats.tone_slices_ms = Math.round(performance.now() - t1);
  stats.tone_slices = jobs.size;
  const get = (n, t) => res.get(n + '|' + t) || [0, 0];
  const noteRs = segs.map(r => get(...noteKey(r)));
  const lines = {};
  for (const name of ['vocals', 'bass']) {
    const rough = new Float32Array(F), sharp = new Float32Array(F);
    for (let f = 0; f < F; f++) if (grid[name][f] > 0) [rough[f], sharp[f]] = get(name, pyRound(f * DT / 0.5) * 0.5);
    lines[name] = [rough, sharp];
  }
  return {noteRs, lead: lines.vocals, bass: lines.bass, slices: jobs.size};
}

/** pipeline.harshness: 0 (smooth) to 1, roughness above 0.1 asper (grating by 0.4), sharpness above 1.75 acum to 3. */
export function harshness(rough, sharp) {
  const r = Math.min(1, Math.max(0, (rough - 0.1) / 0.3)), sh = Math.min(1, Math.max(0, (sharp - 1.75) / 1.25));
  return Math.min(1, Math.hypot(r, sh));
}
