// Sample-rate conversion with libsoxr, the library server/pipeline.py uses (librosa.resample, res_type='soxr_hq', by
// way of python-soxr). The library is vendored as WebAssembly (vendor/soxr.wasm.mjs); this file gives it the few
// system calls it imports and drives soxr_create / soxr_process as python-soxr's resample() does: the whole signal
// through one resampler in chunks, then flushed. Synchronous once ready(), so worker threads can run it (worker.mjs).
import WASM from './vendor/soxr.wasm.mjs';

const FLOAT32 = 0;
export const QUALITY = {qq: 0, lq: 1, mq: 2, hq: 4, vhq: 6};    // soxr.h: SOXR_HQ is SOXR_20_BITQ
const CHUNK = 1 << 16;                                           // input samples per soxr_process call

let lib = null, loading = null;

function bytes(b64) {
  if (typeof Buffer !== 'undefined') return Buffer.from(b64, 'base64');
  const s = atob(b64), u = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
  return u;
}

/** Compile and start the library (once per thread). */
export function ready() {
  return loading ??= (async () => {
    // emscripten 2.0's imports, by their minified names (wasm-audio-resampler's soxr_wasm.js, asmLibraryArg)
    const memory = new WebAssembly.Memory({initial: 1024, maximum: 32768});
    const table = new WebAssembly.Table({initial: 44, maximum: 44, element: 'anyfunc'});
    const u8 = () => new Uint8Array(memory.buffer), u32 = () => new Uint32Array(memory.buffer);
    const env = {
      a: memory, b: table,
      c: (fd, iov, n, pnum) => {                                 // fd_write: libsoxr logs nothing we need
        let len = 0;
        for (let i = 0; i < n; i++) len += u32()[(iov >> 2) + 2 * i + 1];
        u32()[pnum >> 2] = len;
        return 0;
      },
      d: () => 70,                                               // fd_seek: ESPIPE
      e: p => { const t = Math.floor(Date.now() / 1000); if (p) u32()[p >> 2] = t; return t; },
      f: () => 0,                                                // environ_get: no environment
      g: (pc, ps) => { u32()[pc >> 2] = 0; u32()[ps >> 2] = 0; return 0; },
      h: () => 0,                                                // fd_close
      i: (dst, src, n) => { u8().copyWithin(dst, src, src + n); },
      j: want => {                                               // emscripten_resize_heap
        const have = memory.buffer.byteLength;
        if (want > 32768 * 65536) return 0;
        try { memory.grow(Math.ceil((Math.max(want, 2 * have) - have) / 65536)); return 1; } catch { return 0; }
      },
    };
    const {instance} = await WebAssembly.instantiate(bytes(WASM), {a: env});
    const x = instance.exports;
    x.k();                                                       // ___wasm_call_ctors
    lib = {memory, quality_spec: x.l, io_spec: x.m, create: x.n, del: x.o, process: x.q,
           io_size: x.r(), q_size: x.s(), malloc: x.t, free: x.u};
  })();
}

/** x (Float32Array, one channel) from rate `from` to rate `to` with libsoxr at `quality` (librosa's 'soxr_hq' is
 * 'hq'). As librosa.resample: the result is ceil(len * to / from) samples long (librosa's fix_length: soxr's own
 * length, cut or padded with zeros). Call ready() first. */
export function resampleSync(x, from, to, quality = 'hq') {
  if (from === to) return Float32Array.from(x);
  const L = lib, n = x.length, want = Math.ceil(n * (to / from));
  const io = L.malloc(L.io_size), q = L.malloc(L.q_size), err = L.malloc(4), ctr = L.malloc(8);
  L.io_spec(io, FLOAT32, FLOAT32);
  L.quality_spec(q, QUALITY[quality], 0);
  const s = L.create(from, to, 1, err, io, q, 0);
  const e = new Uint32Array(L.memory.buffer)[err >> 2];
  L.free(io); L.free(q); L.free(err);
  if (e) throw new Error('soxr_create failed');
  const olen = Math.ceil(CHUNK * to / from) + 4096;
  const inP = L.malloc(CHUNK * 4), outP = L.malloc(olen * 4);
  const out = new Float32Array(want);
  let got = 0;
  const take = k => {                                            // copy k output samples from the library
    const src = new Float32Array(L.memory.buffer, outP, k);
    const m = Math.min(k, want - got);
    if (m > 0) out.set(src.subarray(0, m), got);
    got += k;
  };
  const run = (ptr, len) => {
    const r = L.process(s, ptr, len, ctr, outP, olen, ctr + 4);
    if (r) throw new Error('soxr_process failed');
    const c = new Uint32Array(L.memory.buffer, ctr, 2);
    return [c[0], c[1]];
  };
  for (let i = 0; i < n;) {
    const len = Math.min(CHUNK, n - i);
    new Float32Array(L.memory.buffer, inP, len).set(x.subarray(i, i + len));
    let off = 0;
    while (off < len) {
      const [used, made] = run(inP + off * 4, len - off);
      take(made);
      off += used;
      if (!used && !made) throw new Error('soxr_process made no progress');
    }
    i += len;
  }
  for (;;) {                                                     // flush: what is still in the filter
    const [, made] = run(0, 0);
    if (!made) break;
    take(made);
  }
  L.del(s); L.free(inP); L.free(outP); L.free(ctr);
  return out;
}

/** resampleSync, loading the library first if need be (what the pool calls: pool.call('./resample.mjs', 'resample',
 * [x, from, to])). */
export async function resample(x, from, to, quality = 'hq') {
  await ready();
  return resampleSync(x, from, to, quality);
}
