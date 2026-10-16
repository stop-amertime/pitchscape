// rustfft 6.4.1 (https://github.com/ejmahler/RustFFT, MIT / Apache-2.0) compiled to fft64.wasm by tools/fft64: complex
// f64 FFTs of any length (MOSQITO's roughness needs 9600 points; fft.js does powers of two only).
const url = new URL('./fft64.wasm', import.meta.url);
const bytes = url.protocol === 'file:' ? (await import('node:fs')).readFileSync(url) : await (await fetch(url)).arrayBuffer();
const {instance} = await WebAssembly.instantiate(bytes, {});
const w = instance.exports;

/** A complex buffer of n points for transforms of length n: data() is a Float64Array(2n) of (re, im) pairs (fetch it
 * again after any call to fft: the module's memory may move when it grows), forward() and inverse() transform it in
 * place, unnormalised (numpy.fft.ifft is inverse() / n). */
export function buffer(n) {
  const ptr = w.alloc(n);
  let view = null;
  const data = () => (view && view.buffer === w.memory.buffer) ? view : (view = new Float64Array(w.memory.buffer, ptr, 2 * n));
  return {data, forward() { w.fft(ptr, n, 0); return data(); }, inverse() { w.fft(ptr, n, 1); return data(); }};
}
