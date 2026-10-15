// usage: node tools/build_pack.js WORKDIR OUT.pack.json "Title" "Artist" AUDIO_FILENAME
// Runs the page's own engine on each stem (voice from vocals, hits from drums, bass from bass, notes from other)
// and writes a song pack: analysis arrays as base64 Float32 + the word timing. No lyric text goes in the pack.
const DSP = require('../src/dsp.js'), fs = require('fs'), path = require('path'), { execFileSync } = require('child_process');
const [work, outFile, title, artist, audio] = process.argv.slice(2);
if (!audio) { console.error('usage: node tools/build_pack.js WORKDIR OUT.pack.json "Title" "Artist" AUDIO_FILENAME'); process.exit(1); }
function pcm(file) {
  const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'f32le', '-ac', '2', '-ar', '22050', '-'], { maxBuffer: 1 << 30 });
  const f = new Float32Array(raw.buffer, raw.byteOffset, raw.length / 4), n = f.length / 2, L = new Float32Array(n), R = new Float32Array(n);
  for (let i = 0; i < n; i++) { L[i] = f[2 * i]; R[i] = f[2 * i + 1]; }
  return [L, R];
}
const A = {};
for (const s of ['vocals', 'drums', 'bass', 'other']) { const [L, R] = pcm(path.join(work, 'stems', s + '.wav')); A[s] = DSP.analyze(L, R, 22050, null, s === 'vocals' || s === 'other' ? { isolated: s } : {}); }
const v = A.vocals, b64 = (a) => Buffer.from(a.buffer, a.byteOffset, a.byteLength).toString('base64');
const res = { bassN: A.bass.bassN, bassHz: A.bass.bassHz, bassBr: A.bass.bassBr, leadHz: v.leadHz, leadN: v.leadN, leadBr: v.leadBr, leadNz: v.leadNz,
  events: A.drums.events, segs: A.other.segs, onsets: v.onsets };
const arrays = {}; for (const k in res) arrays[k] = b64(res[k]);
const timingFile = path.join(work, 'timing.json');
const pack = { format: 'song-overprint-pack', version: 3, segStride: A.other.segW, eventStride: A.drums.evW, title, artist, audio, method: 'Stems separated with Demucs (htdemucs); each stem analysed with the page engine',
  dur: v.dur, dt: v.dt, frames: v.frames, stereo: true, noiseRef: v.noiseRef, arrays,
  timing: fs.existsSync(timingFile) ? JSON.parse(fs.readFileSync(timingFile, 'utf8')) : null };
fs.writeFileSync(outFile, JSON.stringify(pack));
console.log('pack written:', outFile, (fs.statSync(outFile).size / 1024).toFixed(0) + ' KB');
