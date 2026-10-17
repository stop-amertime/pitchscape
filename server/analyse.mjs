// The server's analysis: the JavaScript pipeline (src/pipeline) under Node on the GPU, for server/modal_app.py and
// server/local.py, which run it as a child process.
//   node server/analyse.mjs SONG OUT.json NAME [--ep cuda|webgpu|cpu] [--no-words]
//   node server/analyse.mjs SONG --info NAME      the song's song_info (tags, length, cover art...) as JSON on stdout
// NAME is the song's file name as it was sent (read as "Artist - Title" when the file has no tags). Each stage message
// goes to stdout as one line, "progress <message>", as the page expects them ('stems: 3/39', 'drums: ADTOF'...);
// the pack is written to OUT.json, and "done <seconds>" printed last. Errors go to stderr, with a non-zero exit.
import {readFileSync, writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {nodeRuntime} from '../src/pipeline/runtime.node.mjs';
import {analyze} from '../src/pipeline/index.mjs';
import {songInfo} from '../src/pipeline/tags.mjs';

const args = process.argv.slice(2), opt = {}, pos = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--no-words') opt.noWords = true;
  else if (args[i] === '--info') opt.info = true;
  else if (args[i].startsWith('--')) opt[args[i].slice(2)] = args[++i];
  else pos.push(args[i]);
}
if (opt.info && pos.length === 2) {
  const buf = readFileSync(pos[0]), bytes = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length);
  const sha = createHash('sha256').update(buf).digest('hex');
  process.stdout.write(JSON.stringify(await songInfo(bytes, pos[1], sha)) + '\n');
  process.exit(0);
}
if (pos.length !== 3) {
  console.error('usage: node server/analyse.mjs SONG OUT.json NAME [--ep cuda|webgpu|cpu] [--no-words]');
  process.exit(2);
}
const say = line => process.stdout.write(line.replace(/\n/g, ' ') + '\n');
const rt = await nodeRuntime({ep: opt.ep || null, log: m => console.error(m)});
try {
  const buf = readFileSync(pos[0]);
  const stats = {};
  const pack = await analyze(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length), pos[2], rt,
    {progress: m => say('progress ' + m), words: !opt.noWords, stats});
  writeFileSync(pos[1], JSON.stringify(pack));
  console.error('stage times (ms): ' + JSON.stringify(stats) + ' providers: ' + JSON.stringify(rt.eps));
  say('done ' + (stats.total / 1000).toFixed(1));
} finally {
  rt.close();
}
