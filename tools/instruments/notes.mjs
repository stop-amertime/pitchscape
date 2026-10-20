// Notes for a method's parts (score.py): Basic Pitch on each wav as the notes stage runs it on a stem (src/pipeline/
// notes.mjs: its mono mix at 22.05 kHz, the model, decodeStem's notes with bends joined), without the leak test
// between stems. Writes OUT.json: {"<wav as given>": [[t0, t1, midi], ...]}.
// --line: read each wav as one voice instead, as the pipeline reads the vocal stem (CREPE, voice.mjs) and the page
// prints it by default (certainty 0.45, level 4% of the stem's loud level, runs of 90 ms: voiceGate), a note per run
// of one rounded pitch.
//   node tools/instruments/notes.mjs [--line] OUT.json a.wav [b.wav ...]
import {writeFileSync} from 'node:fs';
import {nodeRuntime, decode} from '../../src/pipeline/runtime.node.mjs';
import {basicPitch} from '../../src/pipeline/notes.mjs';
import {voice, voiceGate} from '../../src/pipeline/voice.mjs';
import {frameCount} from '../../src/pipeline/pack.mjs';

const args = process.argv.slice(2), line = args[0] === '--line';
const [out, ...files] = line ? args.slice(1) : args;
const DT = 512 / 22050;                 // the page's frame

function lineNotes(hz, keep) {
  const out = []; let cur = null;
  for (let f = 0; f <= hz.length; f++) {
    const m = f < hz.length && keep[f] && hz[f] > 0 ? Math.round(69 + 12 * Math.log2(hz[f] / 440)) : null;
    if (cur && m !== cur[2]) { out.push([cur[0], +(f * DT).toFixed(3), cur[2]]); cur = null; }
    if (m !== null && !cur) cur = [+(f * DT).toFixed(3), null, m];
  }
  return out.filter(n => n[1] - n[0] >= 0.04);
}
if (!out || !files.length) { console.error('usage: node tools/instruments/notes.mjs OUT.json a.wav [b.wav ...]'); process.exit(2); }
const rt = await nodeRuntime({});
const res = {};
try {
  for (const f of files) {
    if (line) {
      const st = await decode(f, 44100), F = frameCount(st[0].length / 44100);
      const v = await voice(st, F, rt);
      res[f] = lineNotes(v.leadHz, voiceGate(v.leadP, v.leadL, v.leadHz, 0.45, 0.04, Math.round(0.09 / DT)));
      console.error(f, res[f].length, 'notes (line)');
      continue;
    }
    const y = (await decode(f, 22050, 1))[0];
    const {note, onset, contour, nF} = await basicPitch(y, rt);
    const {notes} = await rt.pool.call('./notes.dsp.mjs', 'decodeStem', [note, onset, contour, nF], [note.buffer, onset.buffer, contour.buffer]);
    res[f] = notes.map(n => [+n[0].toFixed(3), +n[1].toFixed(3), n[2]]);
    console.error(f, res[f].length, 'notes');
  }
  writeFileSync(out, JSON.stringify(res));
} finally { rt.close(); }
process.exit(0);
