// The pipeline's runtime in the browser: ONNX Runtime Web on WebGPU, models fetched once and kept in the Cache API,
// audio decoded by the browser, CPU work on module Workers. The Node counterpart is runtime.node.mjs; the stage
// modules see only what both provide (session, ep, pool, close).
import {createPool} from './pool.mjs';

const ORT = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/';
const CACHE = 'pitchscape-models';

/** models: the URL of the folder holding manifest.json and the .onnx files (tools/export_models.py).
 * ep: 'webgpu' (the default) or 'wasm'. progress(name, loaded bytes, total bytes) while a model downloads. */
export async function webRuntime({models, ep = 'webgpu', log = () => {}, progress = () => {},
                                  workers = Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 4) - 2))} = {}) {
  const ort = await import(ORT + 'ort.webgpu.min.mjs');
  ort.env.wasm.wasmPaths = ORT;
  const base = new URL(models.endsWith('/') ? models : models + '/', location.href);
  const manifest = await (await fetch(new URL('manifest.json', base), {cache: 'no-cache'})).json();
  const cache = {};
  const rt = {
    ep,
    manifest,
    pool: createPool(workers, () => {
      const w = new Worker(new URL('./worker.mjs', import.meta.url), {type: 'module'});
      return {post: (m, t) => w.postMessage(m, t), onMessage: f => { w.onmessage = e => f(e.data); }, terminate: () => w.terminate()};
    }),
    close() { rt.pool.terminate(); },
    async session(name) {
      if (cache[name]) return cache[name];
      const bytes = await model(base, manifest[name], (a, b) => progress(name, a, b), log);
      const sess = await ort.InferenceSession.create(bytes, {executionProviders: [ep], graphOptimizationLevel: 'all'});
      log(`${name}: running on ${ep}`);
      cache[name] = {
        async run(feeds) {
          const t = {};
          for (const [k, v] of Object.entries(feeds)) t[k] = new ort.Tensor('float32', v.data, v.dims);
          const out = await sess.run(t), res = {};
          for (const [k, v] of Object.entries(out)) { res[k] = {data: await v.getData(true), dims: v.dims}; }
          return res;
        },
      };
      return cache[name];
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
