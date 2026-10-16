// drums: ADTOF Frame_RNN (Zehren, Alunno and Bientinesi; CC BY-NC-SA 4.0) on the drum stem, as server/pipeline.py
// drum_hits and drum_details do it: the network's activations (the ONNX file takes 44.1 kHz audio; madmom's
// log-filtered spectrogram is part of its graph), madmom's peak picking down to DRUM_FLOOR of the authors'
// thresholds, then each hit's own spectrum, ring time, strength, and for kicks the pitch of the boom (librosa.yin).
// The STFT and yin run on the runtime's worker threads (drums.dsp.mjs).
import {DB, DRUM_BANDS, HOP, SR, peakPick, pyRound} from './drums.dsp.mjs';

const DSP = './drums.dsp.mjs';
// the network's output order: bass drum, snare, toms, hi-hat, cymbals + ride, with the authors' thresholds
export const ADTOF_OUT = [['kick', 0.22], ['snare', 0.24], ['tom', 0.32], ['hat', 0.22], ['cymbal', 0.30]];
export const DRUM_FLOOR = 0.6;          // hits found down to 0.6x the thresholds; each carries the multiple it passed at
export const TYPES = {kick: 0, snare: 1, hat: 2, tom: 3, cymbal: 4};
const FPS = 100;

/** drum_hits: drums44 [left, right] Float32Array at 44.1 kHz -> {hits: [[t, kind, activation, margin]...] sorted as
 * Python sorts the tuples, act: the activations (Float32Array, frames x 5)}. margin: the multiple of ADTOF's threshold
 * the hit still passes (1 or more: found at the default). */
export async function drumHits(drums44, rt, {stats = {}} = {}) {
  const [l, r] = drums44, n = l.length;
  const mono = new Float32Array(n);                            // numpy's mean(0) of float32: (l + r) / 2 in float32
  for (let i = 0; i < n; i++) mono[i] = (l[i] + r[i]) / 2;
  const sess = await rt.session('adtof_frame_rnn');
  const t = performance.now();
  const out = await sess.run({waveform: {data: mono, dims: [1, n]}});
  stats.adtof_ms = performance.now() - t;
  const act = out.activations.data, frames = out.activations.dims[1], C = ADTOF_OUT.length;
  const hits = [];
  ADTOF_OUT.forEach(([kind, thr], c) => {
    const a = new Float32Array(frames);
    for (let i = 0; i < frames; i++) a[i] = act[i * C + c];
    const {idx, rise} = peakPick(a, thr * DRUM_FLOOR);
    idx.forEach((i, k) => hits.push([i / FPS, kind, a[i], rise[k] / thr]));
  });
  hits.sort((x, y) => x[0] - y[0] || (x[1] < y[1] ? -1 : x[1] > y[1] ? 1 : 0) || x[2] - y[2] || x[3] - y[3]);
  return {hits, act: act instanceof Float32Array ? act : Float32Array.from(act), frames};
}

const REGION = {kick: [0, 22050], snare: [120, 22050], tom: [50, 22050], hat: [1400, 22050], cymbal: [1400, 22050]};
const RING_BAND = {kick: [30, 150], snare: [150, 6000], tom: [60, 1000], hat: [5000, 11025], cymbal: [3000, 11025]};
const CENTRES = Array.from({length: DB}, (_, b) => Math.sqrt(DRUM_BANDS[b] * DRUM_BANDS[b + 1]));

/** drum_details: per hit, [t, type, strength, hz, ring, ...16-band profile, margin], as pipeline.py makes them.
 * drums22: the drum stem's mono mix at 22.05 kHz (Float32Array). */
export async function drumDetails(hits, drums22, rt, {stats = {}} = {}) {
  const y = drums22, n = y.length, nF = 1 + Math.floor(n / HOP), pool = rt.pool;
  const t0 = performance.now();
  // band energies, frame ranges split over the workers, each sent only the samples its frames reach
  const E = new Float32Array(nF * DB);
  const per = Math.ceil(nF / pool.size), jobs = [];
  for (let f0 = 0; f0 < nF; f0 += per) {
    const f1 = Math.min(nF, f0 + per);
    const from = Math.max(0, f0 * HOP - 1024), to = Math.min(n, (f1 - 1) * HOP + 1024);
    const part = y.slice(from, to);
    jobs.push(pool.call(DSP, 'bandEnergy', [part, from, n, f0, f1], [part.buffer]).then(e => E.set(e, f0 * DB)));
  }
  // kicks' pitch, in as many batches as there are workers
  const kicks = hits.filter(h => h[1] === 'kick');
  const segs = kicks.map(([t]) => y.slice(Math.floor((t + 0.04) * SR), Math.floor((t + 0.25) * SR)));
  const kickHz = new Map();
  const batch = Math.max(1, Math.ceil(segs.length / pool.size));
  for (let i = 0; i < segs.length; i += batch) {
    const s = segs.slice(i, i + batch), ks = kicks.slice(i, i + batch);
    jobs.push(pool.call(DSP, 'kickPitches', [s], s.map(x => x.buffer)).then(hz => ks.forEach((k, j) => kickHz.set(k, hz[j]))));
  }
  await Promise.all(jobs);
  stats.details_ms = performance.now() - t0;

  const e = (f, b) => E[f * DB + b];
  const byKind = {};
  for (const [t, kind] of hits) (byKind[kind] ??= []).push(t);
  const ringIn = {};
  for (const [kind, [r0, r1]] of Object.entries(RING_BAND)) ringIn[kind] = CENTRES.map(c => c >= r0 && c <= r1);
  const events = [];
  for (const h of hits) {
    const [t, kind, a, margin] = h;
    const f = Math.min(nF - 1, pyRound(t * SR / HOP)), f1 = Math.min(nF - 1, f + 1);
    const gain = new Float64Array(DB);
    const [lo, hi] = REGION[kind];
    for (let b = 0; b < DB; b++) {
      const cur = Math.max(e(f, b), e(f1, b)), before = Math.max(e(Math.max(0, f - 1), b), e(Math.max(0, f - 2), b));
      gain[b] = CENTRES[b] < lo || CENTRES[b] > hi ? 0 : Math.sqrt(Math.max(cur - before, 0));
    }
    const gmax = Math.max(...gain);
    const prof = gmax > 0 ? gain.map(g => g / gmax) : gain;
    const inBand = ringIn[kind];
    const band = fr => { let s = 0; for (let b = 0; b < DB; b++) if (inBand[b]) s += e(fr, b); return s; };
    const peak = Math.max(band(f), band(f1));
    const later = byKind[kind].find(x => x > t + 0.01);
    const stop = Math.min(nF, later !== undefined ? pyRound(later * SR / HOP) : nF, f + Math.trunc(1.0 * SR / HOP));
    let u = f + 2;
    while (u < stop && band(u) > 0.04 * peak) u++;
    const ring = (u - f) * HOP / SR;
    let hz;
    if (kind === 'kick') hz = kickHz.get(h);
    else {
      let ps = 0, pc = 0;
      for (let b = 0; b < DB; b++) { ps += prof[b]; pc += prof[b] * CENTRES[b]; }
      hz = ps > 0 ? pc / ps : 1000.0;
    }
    const strength = Math.min(1, Math.max(0.15, (a - 0.12) / 0.7));
    events.push([t, TYPES[kind], strength, hz, ring, ...prof, margin]);
  }
  return events;
}

/** The whole stage: drums44 [left, right] at 44.1 kHz, drums22 its mono mix at 22.05 kHz. Returns {hits, events,
 * act, frames}. */
export async function drums(drums44, drums22, rt, {stats = {}} = {}) {
  const {hits, act, frames} = await drumHits(drums44, rt, {stats});
  const events = await drumDetails(hits, drums22, rt, {stats});
  return {hits, events, act, frames};
}
