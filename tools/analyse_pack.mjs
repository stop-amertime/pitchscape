// The whole JavaScript pipeline (src/pipeline/index.mjs) on a song under Node: a pack, as server/pipeline.py writes.
//   node tools/analyse_pack.mjs SONG.mp3 OUT.json [--stems-in DIR] [--stems-out DIR] [--no-words] [--shifts 1] [--ep cuda|webgpu|cpu]
// --stems-in: start from stems already made (DIR/<stem>.wav), as pipeline.py's --stems; tools/parity_pack.py uses it.
import {readFileSync, writeFileSync, mkdirSync} from 'node:fs';
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
// --stems-out DIR: the finished stems as DIR/<stem>.wav (stereo, 32-bit float, 44.1 kHz)
function writeStems(dir, st) {
  mkdirSync(dir, {recursive: true});
  for (const [name, [l, r]] of Object.entries(st)) {
    const n = l.length, b = Buffer.alloc(44 + n * 8);
    b.write('RIFF', 0); b.writeUInt32LE(36 + n * 8, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(3, 20);
    b.writeUInt16LE(2, 22); b.writeUInt32LE(44100, 24); b.writeUInt32LE(44100 * 8, 28); b.writeUInt16LE(8, 32); b.writeUInt16LE(32, 34);
    b.write('data', 36); b.writeUInt32LE(n * 8, 40);
    for (let i = 0; i < n; i++) { b.writeFloatLE(l[i], 44 + i * 8); b.writeFloatLE(r[i], 48 + i * 8); }
    writeFileSync(path.join(dir, name + '.wav'), b);
  }
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
    shifts: +(opt.shifts ?? 1), stems, stats, onStems: opt['stems-out'] ? st => writeStems(opt['stems-out'], st) : null});
  writeFileSync(pos[1], JSON.stringify(pack));
  log('stage times (ms):', JSON.stringify(stats), 'providers:', JSON.stringify(rt.eps));
} finally {
  rt.close();
}
