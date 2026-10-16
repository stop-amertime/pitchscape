// The page's analysis of a song on this computer, in a module Worker so the page stays responsive. The page sends
// {bytes (the file), name, mix ([left, right] at 44.1 kHz: the browser decodes audio only outside workers), models
// (where the models are)} and gets {download: {name, got, total}} while a model downloads, {progress: message} at
// each stage (the pipeline's own stage messages), then {pack} or {error}.
import {webRuntime} from './runtime.web.mjs';
import {analyze} from './index.mjs';

self.onmessage = async ({data: {bytes, name, mix, models}}) => {
  let rt = null;
  try {
    rt = await webRuntime({models, progress: (n, got, total) => self.postMessage({download: {name: n, got, total}})});
    const pack = await analyze(bytes, name, rt, {mix, progress: m => self.postMessage({progress: m})});
    self.postMessage({pack});
  } catch (e) {
    self.postMessage({error: String((e && e.message) || e).replace(/\.?\s*$/, '.')});
  } finally {
    if (rt) rt.close();
  }
};
