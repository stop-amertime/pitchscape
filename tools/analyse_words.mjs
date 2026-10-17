// The words stage of the JavaScript pipeline (src/pipeline/words.mjs) on one song under Node, for tools/parity.py align.
//   node tools/analyse_words.mjs SONG.mp3 --vocals VOCALS.wav --out OUT_DIR [--aligner en|mms] [--ep webgpu|cuda|cpu]
// SONG gives the tags (songInfo) and the length; VOCALS.wav the vocal stem (44.1 kHz stereo, e.g. Python's, so it
// can be compared with the Whisper placement made from the same stem). Writes OUT_DIR/words.json {info, lyrics, found,
// aligned} (aligned: [[word, start s or null, mean log probability or null]], before untimed words are filled in) and
// OUT_DIR/timing.json.
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {decode, nodeRuntime} from '../src/pipeline/runtime.node.mjs';
import {songInfo, lyricsFor} from '../src/pipeline/words.mjs';

const args = process.argv.slice(2), opt = {}, pos = [];
for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith('--')) opt[args[i].slice(2)] = args[++i];
  else pos.push(args[i]);
}
if (!pos[0] || !opt.vocals || !opt.out) {
  console.error('usage: node tools/analyse_words.mjs SONG --vocals VOCALS.wav --out OUT_DIR [--aligner en|mms] [--ep ...]');
  process.exit(2);
}
const log = (...a) => console.error(new Date().toTimeString().slice(0, 8), ...a);
const rt = await nodeRuntime({ep: opt.ep, log});
mkdirSync(opt.out, {recursive: true});
const bytes = readFileSync(pos[0]);
const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length);
const t0 = performance.now();
const info = await songInfo(ab, pos[0], await rt.sha256(ab));
const vocals = await decode(opt.vocals, 44100);
const dur = vocals[0].length / 44100, stats = {};
let aligned = null;
const [lyrics, found] = await lyricsFor(info, dur, vocals, rt, {stats, log, aligner: opt.aligner || 'en',
  onAligned: (toks, al) => { aligned = toks.map(([, w], k) => [w, al.t[k], al.score[k]]); }});
const secs = ms => ms == null ? null : +(ms / 1000).toFixed(2);
const timing = {song: path.basename(pos[0]), aligner: opt.aligner || 'en', eps: rt.eps,
  words_s: secs(performance.now() - t0), lrclib_s: secs(stats.lrclib_ms), emission_s: secs(stats.emission_ms),
  align_s: secs(stats.align_ms)};
writeFileSync(path.join(opt.out, 'words.json'), JSON.stringify({info, lyrics, found, aligned}, null, 1));
writeFileSync(path.join(opt.out, 'timing.json'), JSON.stringify(timing, null, 1));
log(JSON.stringify({found, timing}));
rt.close();
