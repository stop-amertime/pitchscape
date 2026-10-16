// The pipeline's runtime under Node: ONNX Runtime for Node, models from models/ (tools/export_models.py), audio decoded
// by ffmpeg. The browser's counterpart is runtime.web.mjs; the stage modules see only what both provide:
//   session(name) -> {run(feeds) -> outputs}, feeds and outputs as {name: {data, dims}}; ep: the provider in use;
//   pool: worker threads for CPU work (pool.mjs); decode(bytes, sr, channels); sha256(bytes); where ('node' or
//   'browser'); eps ({model: provider}); close() when done. Feeds may give a `type` ('int64'...; float32 if none).
//   session(name, {keep, ep}): keep names outputs the browser leaves on the GPU between calls (keeps: whether it can;
//   such outputs go back in as feeds as they are, and release() frees them); ep picks a provider for that session.
//   file(name): a manifest file that is not a model, as bytes.
//   Calls to models on the GPU take turns (one at a time across sessions); CPU models run alongside them.
import {spawn} from 'node:child_process';
import os from 'node:os';
import {Worker} from 'node:worker_threads';
import {createHash} from 'node:crypto';
import {readFileSync, existsSync, mkdtempSync, writeFileSync, rmSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import ort from 'onnxruntime-node';
import {createPool} from './pool.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const WORKER = new URL('./worker.mjs', import.meta.url);

/** ep: an ONNX Runtime execution provider ('cuda', 'webgpu', 'cpu'), or the first of them this machine runs. Not
 * DirectML: on htdemucs_6s it returns wrong numbers (x at -32 dB SDR against the CPU provider; WebGPU +73 dB). */
export async function nodeRuntime({ep = null, models = path.join(ROOT, 'models'), log = () => {},
                                   workers = Math.max(1, Math.min(8, os.availableParallelism() - 2))} = {}) {
  const manifest = JSON.parse(readFileSync(path.join(models, 'manifest.json'), 'utf8'));
  const order = ep ? [ep] : process.platform === 'win32' ? ['webgpu', 'cpu'] : ['cuda', 'cpu'];
  const cache = {};
  let gpu = Promise.resolve();
  const rt = {
    ep: null,
    eps: {},
    where: 'node',
    manifest,
    pool: createPool(workers, () => {
      const w = new Worker(WORKER);
      return {post: (m, t) => w.postMessage(m, t), onMessage: f => w.on('message', f), terminate: () => w.terminate()};
    }),
    close() { rt.pool.terminate(); },
    keeps: false,                  // onnxruntime-node gives every output back in CPU memory
    file: async name => new Uint8Array(readFileSync(path.join(models, manifest[name].file))),
    release() {},
    sha256: async bytes => createHash('sha256').update(new Uint8Array(bytes)).digest('hex'),
    async decode(bytes, sr, channels = 2) {
      // ffmpeg reads a file (an MP4 may keep its index at the end, which a pipe cannot seek to)
      const dir = mkdtempSync(path.join(os.tmpdir(), 'pitchscape-'));
      try {
        writeFileSync(path.join(dir, 'song'), new Uint8Array(bytes));
        return await decode(path.join(dir, 'song'), sr, channels);
      } finally { rmSync(dir, {recursive: true, force: true}); }
    },
    async session(name, {ep: want = null} = {}) {
      const key = want ? name + '|' + want : name;
      if (cache[key]) return cache[key];
      const file = path.join(models, manifest[name].file);
      if (!existsSync(file)) throw new Error(`no ${file}: run python tools/export_models.py ${name}`);
      let sess, err;
      // a model the manifest says runs better on the CPU (tools/export_models.py says why) is not put on the GPU
      for (const p of want ? [want] : manifest[name].ep === 'cpu' ? ['cpu'] : order) {
        try {
          sess = await ort.InferenceSession.create(file, {executionProviders: [p], graphOptimizationLevel: 'all'});
          rt.ep = p;
          break;
        } catch (e) {
          err = e;
          log(`${name}: ONNX Runtime could not use ${p} (${String(e.message || e).split('\n')[0]})`);
        }
      }
      if (!sess) throw err;
      log(`${name}: running on ${rt.ep}`);
      rt.eps[name] = rt.ep;
      const onGpu = rt.ep !== 'cpu';
      cache[key] = {
        run(feeds) {
          const t = {};
          for (const [k, v] of Object.entries(feeds)) t[k] = v instanceof ort.Tensor ? v : new ort.Tensor(v.type || 'float32', v.data, v.dims);
          if (!onGpu) return sess.run(t);
          const r = gpu.then(() => sess.run(t));
          gpu = r.catch(() => {});
          return r;
        },
      };
      return cache[key];
    },
  };
  return rt;
}

/** A file's audio as Float32Arrays, one per channel, at sr Hz (ffmpeg's decoder and resampler, as pipeline.decode). */
export function decode(file, sr, channels = 2) {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', ['-v', 'error', '-i', file, '-f', 'f32le', '-ac', String(channels), '-ar', String(sr), '-']);
    const parts = [], errs = [];
    p.stdout.on('data', b => parts.push(b));
    p.stderr.on('data', b => errs.push(b));
    p.on('error', reject);
    p.on('close', code => {
      if (code) return reject(new Error('ffmpeg: ' + Buffer.concat(errs).toString()));
      const buf = Buffer.concat(parts), all = new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4);
      const n = all.length / channels, out = [];
      for (let c = 0; c < channels; c++) {
        const y = new Float32Array(n);
        for (let i = 0; i < n; i++) y[i] = all[i * channels + c];
        out.push(y);
      }
      resolve(out);
    });
  });
}

/** Channels (Float32Arrays) as a 32-bit float WAV file's bytes. */
export function wav(channels, sr) {
  const n = channels[0].length, C = channels.length, data = n * C * 4;
  const b = Buffer.alloc(44 + data);
  b.write('RIFF', 0); b.writeUInt32LE(36 + data, 4); b.write('WAVE', 8); b.write('fmt ', 12);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(3, 20); b.writeUInt16LE(C, 22); b.writeUInt32LE(sr, 24);
  b.writeUInt32LE(sr * C * 4, 28); b.writeUInt16LE(C * 4, 32); b.writeUInt16LE(32, 34); b.write('data', 36);
  b.writeUInt32LE(data, 40);
  for (let i = 0, o = 44; i < n; i++) for (let c = 0; c < C; c++, o += 4) b.writeFloatLE(channels[c][i], o);
  return b;
}
