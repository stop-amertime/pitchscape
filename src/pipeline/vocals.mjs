// vocals: Kimberley Jensen's Mel-Band RoFormer (MIT; tools/export_vocals.py says what it is), as its inference.py
// runs it (utils.demix_track): the mix reflect-padded by a border, cut into 8 s chunks every 4 s, each separated, and
// the chunks blended back with linear fades over a tenth of a chunk (none at the song's two ends). Run before Demucs:
// Demucs alone left the voice audible in the guitar and other stems; separating it first, and Demucs on the rest,
// left them clean. The network is the ONNX export; its STFT and iSTFT (vocals.dsp.mjs) run on the worker threads.
import {CHUNK as C, T} from './vocals.dsp.mjs';

const DSP = './vocals.dsp.mjs';
const STEP = C / 2, FADE = C / 10, BORDER = C - STEP;

/** The vocals of a song. mix: [left, right] Float32Array at 44.1 kHz; rt: the runtime. Float16 on the browser's GPU,
 * float32 elsewhere (ONNX Runtime's CPU provider has no float16 products). Returns [left, right]. */
export async function separateVocals(mix, rt, {progress = () => {}, stats = {}, model = null} = {}) {
  const name = model || (rt.keeps ? 'vocals_mbr' : 'vocals_mbr_f32');
  const fidx = Int32Array.from(rt.manifest[name].freq_indices), J = fidx.length;
  const n0 = mix[0].length, pad = n0 > 2 * BORDER;
  // demix_track: reflect padding by the border either side (when the song is long enough)
  const n = pad ? n0 + 2 * BORDER : n0;
  const src = pad ? mix.map(ch => { const y = new Float32Array(n); for (let i = 0; i < n; i++) { let k = i - BORDER; if (k < 0) k = -k; else if (k >= n0) k = 2 * (n0 - 1) - k; y[i] = ch[k]; } return y; }) : mix;
  const fadeIn = new Float32Array(FADE), fadeOut = new Float32Array(FADE);
  for (let i = 0; i < FADE; i++) { fadeIn[i] = Math.fround(i / (FADE - 1)); fadeOut[i] = Math.fround(1 - i / (FADE - 1)); }
  const out = [new Float32Array(n), new Float32Array(n)], cnt = new Float32Array(n);
  const offs = []; for (let i = 0; i < n; i += STEP) offs.push(i);
  const sess = await rt.session(name), pool = rt.pool, now = () => performance.now(), t0 = now();
  stats.gpu_ms = 0;
  let done = 0;
  const prep = async i => {
    const length = Math.min(C, n - i), part = [new Float32Array(C), new Float32Array(C)];
    for (let c = 0; c < 2; c++) {
      part[c].set(src[c].subarray(i, i + length));
      // a short last chunk: reflect padding if over half a chunk, else silence
      if (length < C && length > C / 2 + 1) for (let k = length; k < C; k++) part[c][k] = src[c][i + 2 * (length - 1) - k];
    }
    return {i, length, ...await pool.call(DSP, 'spec', [part[0], part[1], fidx], [part[0].buffer, part[1].buffer])};
  };
  const finish = async ({i, length, st}, masks) => {
    const y = await pool.call(DSP, 'ispec', [st, masks, fidx], [st.buffer, masks.buffer]);
    for (let k = 0; k < length; k++) {
      let w = 1;
      if (k < FADE && i !== 0) w = fadeIn[k];
      if (k >= C - FADE && i + C < n) w = fadeOut[k - (C - FADE)];
      out[0][i + k] += y[0][k] * w; out[1][i + k] += y[1][k] * w; cnt[i + k] += w;
    }
    progress(++done, offs.length);
  };
  // one chunk per call to the network (several per call were slower on WebGPU: 2 took 147 s against 52 s for one, on
  // Fluoride), the next chunk's STFT made on the workers while this one runs
  const tail = [];
  let next = prep(offs[0]);
  for (let g = 0; g < offs.length; g++) {
    const it = await next;
    if (g + 1 < offs.length) next = prep(offs[g + 1]);
    const t = now();
    const res = await sess.run({x: {data: it.x, dims: [1, T, 2 * J]}});
    stats.gpu_ms += now() - t;
    tail.push(finish(it, res.masks.data.slice()));
  }
  await Promise.all(tail);
  stats.total_ms = now() - t0;
  const a = pad ? BORDER : 0;
  return out.map(ch => { const y = new Float32Array(n0); for (let i = 0; i < n0; i++) { const v = ch[a + i] / cnt[a + i]; y[i] = Number.isFinite(v) ? v : 0; } return y; });
}
