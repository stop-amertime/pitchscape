// usage: node tests/real_bass.js src/dsp.js SONG_OR_STEM REF.f32
// Scores the bass line against a reference pitch track (tools/pyin_ref.py, run on the isolated bass stem).
const fs = require('fs'), { execFileSync } = require('child_process');
const [mod, file, refFile] = process.argv.slice(2);
const DSP = require(require('path').resolve(mod));
const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'f32le', '-ac', '2', '-ar', '22050', '-'], { maxBuffer: 1 << 30 });
const f = new Float32Array(raw.buffer, raw.byteOffset, raw.length / 4), n = f.length / 2, L = new Float32Array(n), R = new Float32Array(n);
for (let i = 0; i < n; i++) { L[i] = f[2 * i]; R[i] = f[2 * i + 1]; }
const t0 = Date.now(); const res = DSP.analyze(L, R, 22050, null); const ms = Date.now() - t0;
const rb = fs.readFileSync(refFile), ref = new Float32Array(rb.buffer, rb.byteOffset, rb.length / 4);
let N = 0, ok = 0, oct = 0, semi = 0, sil = 0, F = Math.min(ref.length, res.frames);
for (let t = 0; t < F; t++) { if (!(ref[t] > 0)) continue; N++; const h = res.bassHz[t]; if (!(h > 0)) { sil++; continue; } const d = DSP.ftom(h) - DSP.ftom(ref[t]); if (Math.abs(d) < 0.6) ok++; else if (Math.abs(Math.abs(d) - 12) < 0.6) oct++; else if (Math.abs(d) < 1.6) semi++; }
console.log(`${mod.split('/').pop()} on ${file.split('/').pop()}: right ${(ok / N).toFixed(3)} octave ${(oct / N).toFixed(3)} 1-semitone ${(semi / N).toFixed(3)} silent ${(sil / N).toFixed(3)}  (${ms} ms)`);
