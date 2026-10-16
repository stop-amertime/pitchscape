// The words stage of the JavaScript pipeline (src/pipeline/words.mjs) on one song under Node, for tools/parity.py words.
//   node tools/analyse_words.mjs SONG.mp3 --vocals VOCALS.wav --out OUT_DIR [--size medium] [--ep webgpu|cuda|cpu]
// SONG gives the tags (songInfo) and the length; VOCALS.wav the vocal stem (44.1 kHz stereo, e.g. Python's, so both
// sides time the same stem). Writes OUT_DIR/words.json {info, lyrics, found, heard, language} and OUT_DIR/timing.json.
// heard: Whisper's own words and times, kept here only to compare them with faster-whisper's (never in a pack).
// --heard-only: Whisper on the stem whether or not LRCLIB has the song (to compare the timings on every song).
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {decode, nodeRuntime} from '../src/pipeline/runtime.node.mjs';
import {songInfo, lyricsFor} from '../src/pipeline/words.mjs';
import {heardWords} from '../src/pipeline/whisper.mjs';

const args = process.argv.slice(2), opt = {}, pos = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--heard-only') opt['heard-only'] = true;
  else if (args[i].startsWith('--')) opt[args[i].slice(2)] = args[++i];
  else pos.push(args[i]);
}
if (!pos[0] || !opt.vocals || !opt.out) {
  console.error('usage: node tools/analyse_words.mjs SONG --vocals VOCALS.wav --out OUT_DIR [--size medium] [--ep ...] [--heard-only]');
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
let lyrics = null, found = null, heard = null, language = null;
if (opt['heard-only']) {
  const [l, r] = vocals, mono = new Float32Array(l.length);
  for (let i = 0; i < l.length; i++) mono[i] = (l[i] + r[i]) / 2;
  const v16 = await rt.pool.call('./resample.mjs', 'resample', [mono, 44100, 16000], [mono.buffer]);
  const ws = {};
  [heard, language] = await heardWords(v16, rt, {size: opt.size || 'medium', stats: ws});
  stats.whisper = ws;
} else {
  [lyrics, found] = await lyricsFor(info, dur, vocals, rt, {stats, log, size: opt.size || 'medium',
                                                            onHeard: (h, lang) => { heard = h; language = lang; }});
}
const secs = ms => ms == null ? null : +(ms / 1000).toFixed(2);
const w = stats.whisper || {};
const timing = {song: path.basename(pos[0]), size: opt.size || 'medium', eps: rt.eps, words_s: secs(performance.now() - t0),
  lrclib_s: secs(stats.lrclib_ms), vad_s: secs(w.vad_ms), features_s: secs(w.features_ms), whisper_s: secs(w.whisper_ms),
  speech_s: w.speech_s, windows: w.windows, tokens: w.tokens, decoder_calls: w.decoder_calls, decoder_s: secs(w.decoder_ms),
  encoder_s: secs(w.encoder_ms), temperatures: w.temperatures};
writeFileSync(path.join(opt.out, 'words.json'), JSON.stringify({info, lyrics, found, heard, language}, null, 1));
writeFileSync(path.join(opt.out, 'timing.json'), JSON.stringify(timing, null, 1));
log(JSON.stringify({found, timing}));
rt.close();
