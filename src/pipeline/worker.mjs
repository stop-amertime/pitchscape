// A worker thread for the pipeline's CPU work, the same file in the browser (a module Worker) and in Node
// (worker_threads). A call: {id, module (a URL beside this file), fn, args}; the answer: {id, result} or {id, error}.
// Typed arrays in the result are transferred, not copied.
const node = typeof self === 'undefined' || typeof self.postMessage !== 'function';
const port = node ? (await import('node:worker_threads')).parentPort : self;
const modules = {};

function buffers(v, out = []) {
  if (ArrayBuffer.isView(v)) out.push(v.buffer);
  else if (Array.isArray(v)) v.forEach(x => buffers(x, out));
  else if (v && typeof v === 'object') Object.values(v).forEach(x => buffers(x, out));
  return out;
}

const onMessage = async ({id, module, fn, args}) => {
  try {
    modules[module] ??= import(new URL(module, import.meta.url).href);
    const result = await (await modules[module])[fn](...args);
    port.postMessage({id, result}, [...new Set(buffers(result))]);
  } catch (e) {
    port.postMessage({id, error: String(e && e.stack || e)});
  }
};
if (node) port.on('message', onMessage);
else port.onmessage = e => onMessage(e.data);
