// The pipeline's runtime in the browser: ONNX Runtime Web on WebGPU, models fetched once and kept in the Cache API,
// audio decoded by the browser, CPU work on module Workers. The Node counterpart is runtime.node.mjs; the stage
// modules see only what both provide (session, file, release, keeps, ep, eps, where, pool, decode, sha256, close; see
// runtime.node.mjs).
import {createPool} from './pool.mjs';

const ORT = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/';
const CACHE = 'pitchscape-models';
// tools/publish_models.py puts models/ here (public; Hugging Face allows cross-origin downloads)
export const MODELS = 'https://huggingface.co/stopamertime/pitchscape-models/resolve/main/';

/** models: the URL of the folder holding manifest.json and the .onnx files (default: the published ones).
 * ep: 'webgpu' (the default) or 'wasm'. progress(name, loaded bytes, total bytes) while a model downloads. */
export async function webRuntime({models = MODELS, ep = 'webgpu', log = () => {}, progress = () => {},
                                  workers = Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 4) - 2))} = {}) {
  const ort = await import(ORT + 'ort.webgpu.min.mjs');
  ort.env.wasm.wasmPaths = ORT;
  const base = new URL(models.endsWith('/') ? models : models + '/', location.href);
  const manifest = await (await fetch(new URL('manifest.json', base), {cache: 'no-cache'})).json();
  const cache = {};
  // every call into ONNX Runtime takes its turn: sessions share one wasm instance (the WebGPU provider lives in it too),
  // and two calls in flight at once corrupt its memory ("memory access out of bounds" while making a session)
  let ortq = Promise.resolve();
  const turn = f => { const r = ortq.then(f); ortq = r.catch(() => {}); return r; };
  const rt = {
    ep,
    eps: {},
    where: 'browser',
    manifest,
    pool: createPool(workers, () => {
      const w = new Worker(new URL('./worker.mjs', import.meta.url), {type: 'module'});
      return {post: (m, t) => w.postMessage(m, t), onMessage: f => { w.onmessage = e => f(e.data); }, terminate: () => w.terminate()};
    }),
    close() { rt.pool.terminate(); },
    keeps: ep === 'webgpu',
    /** A manifest file that is not a model (e.g. a tokenizer), as bytes. */
    file: name => model(base, manifest[name], (a, b) => progress(name, a, b), log),
    /** Frees outputs a session kept on the GPU. */
    release(...ts) { for (const t of ts) if (t && t.location === 'gpu-buffer') t.dispose(); },
    decode: (bytes, sr, channels) => decode(bytes, sr, channels),
    async sha256(bytes) {
      return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
    },
    /** keep: outputs to leave on the GPU (returned as they are, to feed back in and release; see keeps); ep: a provider
     * for this session instead of the runtime's ('cpu' runs on wasm). */
    async session(name, {keep = [], ep: want = null} = {}) {
      const key = [name, want, ...keep].join('|');
      if (cache[key]) return cache[key];
      const bytes = await model(base, manifest[name], (a, b) => progress(name, a, b), log);
      // a model the manifest says runs better on the CPU (tools/export_models.py says why) runs on wasm
      const use = want ? (want === 'cpu' ? 'wasm' : want) : manifest[name].ep === 'cpu' ? 'wasm' : ep;
      const opts = {executionProviders: [use], graphOptimizationLevel: 'all'};
      if (keep.length && use === 'webgpu') opts.preferredOutputLocation = Object.fromEntries(keep.map(k => [k, 'gpu-buffer']));
      const sess = await turn(() => ort.InferenceSession.create(bytes, opts));
      log(`${name}: running on ${use}`);
      rt.eps[name] = use;
      const call = async t => {
        const out = await sess.run(t), res = {};
        for (const [k, v] of Object.entries(out)) res[k] = v.location === 'gpu-buffer' ? v : {data: await v.getData(true), dims: v.dims};
        return res;
      };
      cache[key] = {
        run(feeds) {
          const t = {};
          for (const [k, v] of Object.entries(feeds)) t[k] = v instanceof ort.Tensor ? v : new ort.Tensor(v.type || 'float32', v.data, v.dims);
          return turn(() => call(t));
        },
      };
      return cache[key];
    },
  };
  return rt;
}

/** A model's bytes: from the Cache API when it holds this exact file (by SHA-256 in the URL), else downloaded (and
 * kept there, when the browser lets the page keep files). */
async function model(base, info, progress, log) {
  const url = new URL(info.file + '?sha256=' + info.sha256, base);
  let store = null;
  try { store = await caches.open(CACHE); } catch (e) { log(`${info.file}: not kept for next time (${e.message})`); }
  let res = store && await store.match(url);
  if (!res) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${info.file}: ${r.status}`);
    const total = +r.headers.get('content-length') || info.bytes, parts = [], reader = r.body.getReader();
    let got = 0;
    for (;;) {
      const {done, value} = await reader.read();
      if (done) break;
      parts.push(value);
      got += value.length;
      progress(got, total);
    }
    const blob = new Blob(parts);
    const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()))]
      .map(b => b.toString(16).padStart(2, '0')).join('');
    if (digest !== info.sha256) throw new Error(`${info.file}: downloaded file does not match its SHA-256`);
    if (!store) return new Uint8Array(await blob.arrayBuffer());
    await store.put(url, new Response(blob));
    // drop older copies of the same file
    for (const k of await store.keys()) if (new URL(k.url).pathname === url.pathname && k.url !== url.href) await store.delete(k);
    res = await store.match(url);
  }
  return new Uint8Array(await res.arrayBuffer());
}

/** A file's audio (ArrayBuffer) as Float32Arrays, one per channel, at sr Hz: the browser's decoder and resampler.
 * A mono file gives the same channel twice, as ffmpeg's -ac 2 does. */
export async function decode(bytes, sr, channels = 2) {
  const buf = await new OfflineAudioContext(channels, 1, sr).decodeAudioData(bytes);
  return Array.from({length: channels}, (_, c) => buf.getChannelData(Math.min(c, buf.numberOfChannels - 1)).slice());
}
