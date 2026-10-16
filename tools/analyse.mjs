// Run the JavaScript pipeline (src/pipeline) on a song under Node. So far it has one stage, stems.
//   node tools/analyse.mjs SONG.mp3 --stems OUT_DIR [--shifts 1] [--ep cuda|webgpu|cpu]
// writes OUT_DIR/<stem>.wav (32-bit float, 44.1 kHz stereo) and OUT_DIR/timing.json.
import {mkdirSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {decode, nodeRuntime, wav} from '../src/pipeline/runtime.node.mjs';
import {separate} from '../src/pipeline/stems.mjs';

const args = process.argv.slice(2), opt = {};
const pos = [];
for (let i = 0; i < args.length; i++) args[i].startsWith('--') ? opt[args[i].slice(2)] = args[++i] : pos.push(args[i]);
if (!pos[0] || !opt.stems) {
  console.error('usage: node tools/analyse.mjs SONG --stems OUT_DIR [--shifts 1] [--ep cuda|webgpu|cpu]');
  process.exit(2);
}
const log = (...a) => console.error(new Date().toTimeString().slice(0, 8), ...a);
const t0 = performance.now();
const rt = await nodeRuntime({ep: opt.ep, log});
const mix = await decode(pos[0], 44100);
const tDecode = performance.now();
log(`decoded ${(mix[0].length / 44100).toFixed(1)} s`);
const st = {};
const stems = await separate(mix, rt, {stats: st, shifts: +(opt.shifts ?? 1), progress: (k, n) => k % 10 && k < n || log(`stems: ${k}/${n} segments`)});
const tStems = performance.now();
mkdirSync(opt.stems, {recursive: true});
for (const [name, ch] of Object.entries(stems)) writeFileSync(path.join(opt.stems, name + '.wav'), wav(ch, 44100));
const timing = {song: path.basename(pos[0]), seconds: mix[0].length / 44100, ep: rt.ep, shifts: +(opt.shifts ?? 1),
  decode_s: +((tDecode - t0) / 1000).toFixed(2), stems_s: +((tStems - tDecode) / 1000).toFixed(2),
  stems_gpu_s: +(st.gpu_ms / 1000).toFixed(2), workers: rt.pool.size};
writeFileSync(path.join(opt.stems, 'timing.json'), JSON.stringify(timing, null, 1));
log(JSON.stringify(timing));
rt.close();
