// The whole JavaScript pipeline (src/pipeline/index.mjs) on a song under Node: a pack, as server/pipeline.py writes.
//   node tools/analyse_pack.mjs SONG.mp3 OUT.json [--stems-in DIR] [--no-words] [--shifts 1] [--ep cuda|webgpu|cpu]
// --stems-in: start from stems already made (DIR/<stem>.wav), as pipeline.py's --stems; tools/parity_pack.py uses it.
import {readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {nodeRuntime, decode} from '../src/pipeline/runtime.node.mjs';
import {analyze} from '../src/pipeline/index.mjs';
import {SOURCES} from '../src/pipeline/stems.mjs';

const args = process.argv.slice(2), opt = {}, pos = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--no-words') opt.noWords = true;
  else if (args[i].startsWith('--')) opt[args[i].slice(2)] = args[++i];
  else pos.push(args[i]);
}
if (pos.length !== 2) {
  console.error('usage: node tools/analyse_pack.mjs SONG OUT.json [--stems-in DIR] [--no-words] [--shifts 1] [--ep cuda|webgpu|cpu]');
  process.exit(2);
}
const log = (...a) => console.error(new Date().toTimeString().slice(0, 8), ...a);
const rt = await nodeRuntime({ep: opt.ep, log});
try {
  let stems = null;
  if (opt['stems-in']) {
    stems = {};
    for (const s of SOURCES) stems[s] = await decode(path.join(opt['stems-in'], s + '.wav'), 44100);
  }
  const buf = readFileSync(pos[0]);
  const bytes = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length);
  const stats = {};
  const pack = await analyze(bytes, path.basename(pos[0]), rt, {progress: m => log(m), words: !opt.noWords,
    shifts: +(opt.shifts ?? 1), stems, stats});
  writeFileSync(pos[1], JSON.stringify(pack));
  log('stage times (ms):', JSON.stringify(stats), 'providers:', JSON.stringify(rt.eps));
} finally {
  rt.close();
}
