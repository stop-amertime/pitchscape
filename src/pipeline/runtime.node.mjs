// The pipeline's runtime under Node: ONNX Runtime for Node, models from models/ (tools/export_models.py), audio decoded
// by ffmpeg. The browser's counterpart is runtime.web.mjs; the stage modules see only what both provide:
//   session(name) -> {run(feeds) -> outputs}, feeds and outputs as {name: {data, dims}}; ep: the provider in use;
//   pool: worker threads for CPU work (pool.mjs); close() when done.
import {spawn} from 'node:child_process';
import os from 'node:os';
import {Worker} from 'node:worker_threads';
import {readFileSync, existsSync} from 'node:fs';
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
  const rt = {
    ep: null,
    manifest,
    pool: createPool(workers, () => {
      const w = new Worker(WORKER);
      return {post: (m, t) => w.postMessage(m, t), onMessage: f => w.on('message', f), terminate: () => w.terminate()};
    }),
    close() { rt.pool.terminate(); },
    async session(name) {
      if (cache[name]) return cache[name];
      const file = path.join(models, manifest[name].file);
      if (!existsSync(file)) throw new Error(`no ${file}: run python tools/export_models.py ${name}`);
      let sess, err;
      for (const p of order) {
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
      cache[name] = {
        async run(feeds) {
          const t = {};
          for (const [k, v] of Object.entries(feeds)) t[k] = new ort.Tensor('float32', v.data, v.dims);
          return sess.run(t);
        },
      };
      return cache[name];
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
