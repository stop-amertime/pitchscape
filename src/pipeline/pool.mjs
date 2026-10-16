// A pool of worker threads (worker.mjs) for the pipeline's CPU work. spawn() makes one worker with the
// environment's Worker (the runtime supplies it) and returns {post(msg, transfer), onMessage(fn), terminate()}.
// call(module, fn, args, transfer) runs `fn` from `module` (a path relative to worker.mjs) on the least busy worker.

export function createPool(size, spawn) {
  const workers = [], pending = new Map();
  let next = 0;
  for (let i = 0; i < size; i++) {
    const w = spawn();
    w.busy = 0;
    w.onMessage(({id, result, error}) => {
      const p = pending.get(id);
      pending.delete(id);
      p.w.busy--;
      error ? p.reject(new Error(error)) : p.resolve(result);
    });
    workers.push(w);
  }
  return {
    size,
    call(module, fn, args, transfer = []) {
      const w = workers.reduce((a, b) => b.busy < a.busy ? b : a);
      const id = next++;
      w.busy++;
      return new Promise((resolve, reject) => {
        pending.set(id, {resolve, reject, w});
        w.post({id, module, fn, args}, transfer);
      });
    },
    terminate() { workers.forEach(w => w.terminate()); },
  };
}
