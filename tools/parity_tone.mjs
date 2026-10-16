// The JavaScript side of `python tools/parity.py tone`: the tone stage (src/pipeline/tone.mjs) on slices chosen by the
// Python side, twice: from the 44.1 kHz stems (JS resampling and level, as the pipeline will run it) and from Python's
// own 48 kHz stems (MOSQITO's port alone).
//   node tools/parity_tone.mjs TONE_DIR STEMS_DIR [--workers 8]
// TONE_DIR has keys.json ({names, keys: [[stem, seconds]...]}) and py48/<stem>.f32; writes TONE_DIR/js.json.
import {readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {Worker} from 'node:worker_threads';
import {createPool} from '../src/pipeline/pool.mjs';
import {measure, toneStems} from '../src/pipeline/tone.mjs';

const args = process.argv.slice(2), opt = {}, pos = [];
for (let i = 0; i < args.length; i++) args[i].startsWith('--') ? opt[args[i].slice(2)] = args[++i] : pos.push(args[i]);
const [dir, stemDir] = pos;
const SOURCES = ['drums', 'bass', 'other', 'vocals', 'guitar', 'piano'];

/** A 32-bit float WAV file (as soundfile writes it) as one Float32Array per channel. */
function readWav(file) {
  const b = readFileSync(file);
  let p = 12, ch = 0, fmt = 0;
  while (p < b.length) {
    const id = b.toString('ascii', p, p + 4), size = b.readUInt32LE(p + 4);
    if (id === 'fmt ') { fmt = b.readUInt16LE(p + 8); ch = b.readUInt16LE(p + 10); if (b.readUInt16LE(p + 22) !== 32) throw new Error('not 32-bit'); }
    if (id === 'data') {
      if (fmt !== 3 && fmt !== 0xfffe) throw new Error('not float');
      const all = new Float32Array(b.buffer.slice(b.byteOffset + p + 8, b.byteOffset + p + 8 + size)), n = all.length / ch;
      return Array.from({length: ch}, (_, c) => { const y = new Float32Array(n); for (let i = 0; i < n; i++) y[i] = all[i * ch + c]; return y; });
    }
    p += 8 + size + (size & 1);
  }
  throw new Error('no data chunk in ' + file);
}
const readF32 = file => { const b = readFileSync(file); return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length)); };

const {names, keys} = JSON.parse(readFileSync(path.join(dir, 'keys.json'), 'utf8'));
const workers = +(opt.workers ?? 8);
const rt = {pool: createPool(workers, () => {
  const w = new Worker(new URL('../src/pipeline/worker.mjs', import.meta.url));
  return {post: (m, t) => w.postMessage(m, t), onMessage: f => w.on('message', f), terminate: () => w.terminate()};
})};
const now = () => performance.now();
// warm the workers (module and wasm loading), so the timings below are the work itself
let t = now();
await Promise.all(Array.from({length: workers}, () => rt.pool.call('./tone.dsp.mjs', 'slices', [new Float32Array(9600)])));
const warmS = (now() - t) / 1000;

const stems = {};
for (const s of SOURCES) stems[s] = readWav(path.join(stemDir, s + '.wav'));
t = now();
const {stems: s48, gain} = await toneStems(stems, names, rt);
const resampleS = (now() - t) / 1000;
t = now();
const full = await measure(s48, keys, rt);
const slicesS = (now() - t) / 1000;

const py48 = {};
for (const n of names) py48[n] = readF32(path.join(dir, 'py48', n + '.f32'));
t = now();
const pyin = await measure(py48, keys, rt);
const slicesPyinS = (now() - t) / 1000;

// how far the JS 48 kHz stems are from Python's: SNR (dB) and the difference's level (dB relative to 20 uPa)
const signal = {};
for (const n of names) {
  const a = py48[n], b = s48[n], m = Math.min(a.length, b.length);
  let e = 0, s = 0;
  for (let i = 0; i < m; i++) { e += (a[i] - b[i]) ** 2; s += a[i] ** 2; }
  signal[n] = {snr_db: +(10 * Math.log10(s / e)).toFixed(1), diff_db_spl: +(10 * Math.log10(e / m / 4e-10)).toFixed(1),
    len_py: a.length, len_js: b.length};
}
const pick = m => keys.map(([n, s]) => m.get(n + '|' + s));
writeFileSync(path.join(dir, 'js.json'), JSON.stringify({gain, workers, warm_s: +warmS.toFixed(2), resample_s: +resampleS.toFixed(2),
  slices_s: +slicesS.toFixed(2), slices_pyin_s: +slicesPyinS.toFixed(2), signal, full: pick(full), pyin: pick(pyin)}));
console.error(`js: ${keys.length} slices in ${slicesS.toFixed(1)} s on ${workers} workers (resampling ${resampleS.toFixed(1)} s)`);
rt.pool.terminate();
