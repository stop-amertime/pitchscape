// stems: Demucs htdemucs_6s (Meta, MIT), as demucs 4.1.0's apply_model runs it in server/pipeline.py `separate`:
// the mix normalised, padded and shifted by a random offset, cut into overlapping segments, each separated, and the
// segments blended back with triangle weights. The network is the ONNX export from tools/export_models.py; its STFT
// and iSTFT (stems.dsp.mjs) run on the runtime's worker threads, so the GPU always has the next segment waiting.
import {SEGMENT as L, SOURCES} from './stems.dsp.mjs';

export {SOURCES};
const S = SOURCES.length;
const SHIFT = 22050;                       // apply_model: shifts of up to half a second
const DSP = './stems.dsp.mjs';

/** Separate a song. mix: [left, right] Float32Array at 44.1 kHz. rt: the runtime (runtime.node.mjs / runtime.web.mjs).
 * shifts: apply_model's (the pipeline uses 1: one pass at a random offset of up to 0.5 s; 0 for none, to compare).
 * progress(done, total) after each segment; stats gets where the time went. Returns {drums: [left, right], bass,
 * other, vocals, guitar, piano}. */
export async function separate(mix, rt, {shifts = 1, random = Math.random, progress = () => {}, stats = {}} = {}) {
  const n = mix[0].length;
  // pipeline.separate: normalised by the mono mix's mean and (unbiased) standard deviation, restored after
  let m = 0;
  for (let i = 0; i < n; i++) m += (mix[0][i] + mix[1][i]) / 2;
  m /= n;
  let v = 0;
  for (let i = 0; i < n; i++) v += ((mix[0][i] + mix[1][i]) / 2 - m) ** 2;
  const sd = Math.sqrt(v / (n - 1)) + 1e-8;
  // apply_model with shifts: the mix padded by SHIFT of silence either side and read from a random offset into it;
  // split: segments of L every 3/4 L, each padded from its neighbours (silence beyond the ends), weighted by a triangle
  const offset = shifts ? Math.floor(random() * (SHIFT + 1)) : 0;
  const start0 = shifts ? offset - SHIFT : 0;                 // sample of the mix at position 0 of what is split
  const len = shifts ? n + SHIFT - offset : n;
  const stride = Math.floor(0.75 * L), half = Math.floor(L / 2);
  const weight = new Float32Array(L);
  for (let i = 0; i < L; i++) weight[i] = (i < half ? i + 1 : L - i) / half;
  const out = Array.from({length: 2 * S}, () => new Float32Array(len)), sumW = new Float32Array(len);
  const offs = [];
  for (let o = 0; o < len; o += stride) offs.push(o);
  const sess = await rt.session('htdemucs_6s');
  const pool = rt.pool;
  const now = () => performance.now();
  const t0 = now();
  stats.gpu_ms = 0;
  let gpu = Promise.resolve(), done = 0;

  const segment = async o => {
    const l = Math.min(len - o, L), st = o - Math.floor((L - l) / 2);
    const left = new Float32Array(L), right = new Float32Array(L);
    for (let i = 0; i < L; i++) {
      const k = start0 + st + i;
      if (k >= 0 && k < n) { left[i] = (mix[0][k] - m) / sd; right[i] = (mix[1][k] - m) / sd; }
    }
    const mixT = new Float32Array(2 * L);
    mixT.set(left, 0); mixT.set(right, L);
    const mag = await pool.call(DSP, 'spec', [left, right], [left.buffer, right.buffer]);
    // one segment on the GPU at a time (ONNX Runtime runs one session call at a time)
    const res = await (gpu = gpu.then(async () => {
      const t = now();
      const r = await sess.run({mix: {data: mixT, dims: [1, 2, L]}, mag: {data: mag, dims: [1, 4, 2048, 336]}});
      stats.gpu_ms += now() - t;
      return r;
    }));
    const x = res.x.data.slice(), xt = res.xt.data.slice();
    const so = await pool.call(DSP, 'ispec', [x, xt], [x.buffer, xt.buffer]);
    const trim = Math.floor((L - l) / 2);
    for (let c = 0; c < 2 * S; c++) {
      const dst = out[c], src = so[c];
      for (let i = 0; i < l; i++) dst[o + i] += weight[i] * src[trim + i];
    }
    for (let i = 0; i < l; i++) sumW[o + i] += weight[i];
    progress(++done, offs.length);
  };
  // a few segments in flight: enough to keep every worker and the GPU busy, few enough to bound memory
  const inFlight = pool.size + 2;
  let k = 0;
  await Promise.all(Array.from({length: Math.min(inFlight, offs.length)}, async () => {
    while (k < offs.length) await segment(offs[k++]);
  }));
  stats.total_ms = now() - t0;

  const lead = shifts ? SHIFT - offset : 0;                   // where the mix starts in what was split
  const stems = {};
  SOURCES.forEach((name, s) => {
    stems[name] = [0, 1].map(c => {
      const ch = out[s * 2 + c], y = new Float32Array(n);
      for (let i = 0; i < n; i++) y[i] = ch[lead + i] / sumW[lead + i] * sd + m;
      return y;
    });
  });
  return stems;
}
