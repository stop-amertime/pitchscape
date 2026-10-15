// usage: node tests/drum_bench.js [WORKDIR]
// Drum detection accuracy.
// 1. Synthetic: a piano intro with high notes and hammer noise (no drums, so every hit there is false), then piano
//    over kick / snare / closed and open hats. Scored against the hits played.
// 2. Real song, if WORKDIR has Demucs stems (stems/{drums,other,vocals,bass}.wav) and the mix is docs/<name>.mp3:
//    hits found in stems that hold no drums are false by definition (piano read as hats, consonants read as
//    snares), and hits found in the full mix are compared with hits found in the isolated drum stem.
const DSP = require(process.env.DSP ? require('path').resolve(process.env.DSP) : '../src/dsp.js');
const fs = require('fs'), path = require('path'), { execFileSync } = require('child_process');
const SR = 44100, TOL = 0.035, NAMES = ['kick', 'snare', 'hat'];
function rng(seed) { return () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; }; }
const mtof = m => 440 * 2 ** ((m - 69) / 12);
function hits(res, type) { const W = res.evW || 4, out = []; for (let i = 0; i < res.events.length; i += W) if (res.events[i + 1] === type) out.push(res.events[i]); return out; }
function match(det, ref) {
  let tp = 0; const used = new Uint8Array(ref.length);
  det.forEach(d => { let bi = -1, bd = TOL; ref.forEach((r, i) => { const dd = Math.abs(d - r); if (!used[i] && dd < bd) { bd = dd; bi = i; } }); if (bi >= 0) { used[bi] = 1; tp++; } });
  return { tp, fp: det.length - tp, fn: ref.length - tp, p: det.length ? tp / det.length : 1, r: ref.length ? tp / ref.length : 1 };
}
const fmt = m => `precision ${m.p.toFixed(2)} recall ${m.r.toFixed(2)} (false ${m.fp}, missed ${m.fn})`;

function piano(out, t0, m, vel, rnd) {
  const f0 = mtof(m), s0 = Math.round(t0 * SR), len = Math.round(1.6 * SR), B = 0.0004 * 2 ** ((m - 60) / 12);
  const parts = []; for (let k = 1; k <= 40; k++) { const f = k * f0 * Math.sqrt(1 + B * k * k); if (f > 10500) break; parts.push([f, vel * (0.6 + 0.6 * vel) / Math.pow(k, 1.1 - 0.4 * vel), 1.2 + 0.9 * k * f0 / 1000]); }
  let hp = 0, prev = 0;
  for (let i = 0; i < len && s0 + i < out.length; i++) {
    const t = i / SR; let v = 0;
    for (const [f, a, d] of parts) v += a * Math.sin(2 * Math.PI * f * t) * Math.exp(-d * t);
    const x = rnd() * 2 - 1; hp = 0.6 * (hp + x - prev); prev = x;            // hammer: a few ms of bright noise
    v = v * Math.min(1, t / 0.002) + (t < 0.008 ? hp * 0.35 * vel * (1 - t / 0.008) : 0);
    out[s0 + i] += v * 0.25;
  }
}
function synthClip(seed) {
  const rnd = rng(seed), dur = 22, n = dur * SR, P = new Float32Array(n), D = new Float32Array(n), truth = [[], [], []];
  // piano: high melody in eighths with chords below, the whole clip; drums only from 8 s
  for (let t = 0.3, i = 0; t < dur - 1.5; t += 0.3, i++) {
    piano(P, t, 72 + [0, 4, 7, 12, 16, 12, 7, 4, 19, 14, 11, 7][i % 12] + (i % 24 < 12 ? 0 : 2), 0.6 + 0.4 * rnd(), rnd);
    if (i % 4 === 0) [48, 55, 60, 64].forEach(m => piano(P, t, m + (i % 16 < 8 ? 0 : 5), 0.5, rnd));
  }
  const beat = 0.6;
  for (let b = Math.ceil(8 / beat * 2) / 2; b * beat < dur - 0.5; b += 0.5) {
    const t = b * beat, s0 = Math.round(t * SR), on = b % 1 === 0, open = !on && Math.round(b * 2) % 8 === 7;
    if (on && b % 2 === 0) { let ph = 0; for (let i = 0; i < 0.35 * SR; i++) { const tt = i / SR; ph += (48 + 100 * Math.exp(-tt * 30)) / SR; D[s0 + i] += Math.sin(2 * Math.PI * ph) * Math.exp(-tt * 9); } truth[0].push(t); }
    if (on && b % 2 === 1) { for (let i = 0; i < 0.2 * SR; i++) { const tt = i / SR; D[s0 + i] += ((rnd() * 2 - 1) * 0.7 + 0.4 * Math.sin(2 * Math.PI * 190 * tt)) * Math.exp(-tt * 20); } truth[1].push(t); }
    { let p1 = 0, h1 = 0; const len = (open ? 0.45 : 0.06) * SR; for (let i = 0; i < len; i++) { const x = rnd() * 2 - 1; h1 = 0.5 * (h1 + x - p1); p1 = x; D[s0 + i] += h1 * 0.55 * Math.exp(-i / SR * (open ? 6 : 55)); } truth[2].push(t); }
  }
  const rms = a => Math.sqrt(a.reduce((s, v) => s + v * v, 0) / a.length) + 1e-9, gp = 0.12 / rms(P), gd = 0.2 / rms(D.subarray(8 * SR));
  const L = new Float32Array(n), R = new Float32Array(n);
  for (let i = 0; i < n; i++) { L[i] = P[i] * gp * 1.2 + D[i] * gd; R[i] = P[i] * gp * 0.8 + D[i] * gd; }
  return { L, R, truth };
}
function pcm(file) {
  const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'f32le', '-ac', '2', '-ar', '22050', '-'], { maxBuffer: 1 << 30 });
  const f = new Float32Array(raw.buffer, raw.byteOffset, raw.length / 4), m = f.length / 2, L = new Float32Array(m), R = new Float32Array(m);
  for (let i = 0; i < m; i++) { L[i] = f[2 * i]; R[i] = f[2 * i + 1]; }
  return [L, R];
}

console.log('synthetic: piano intro 0-8 s, then piano + drums');
for (const seed of [3, 9]) {
  const c = synthClip(seed), res = DSP.analyze(c.L, c.R, SR, () => {});
  const row = NAMES.map((nm, k) => { const d = hits(res, k), intro = d.filter(t => t < 7.8).length, m = match(d.filter(t => t >= 7.8), c.truth[k]); return `${nm}: ${intro} in intro, ${fmt(m)}`; });
  console.log(`  seed ${seed}\n    ` + row.join('\n    '));
}
const work = process.argv[2];
if (work && fs.existsSync(path.join(work, 'stems', 'drums.wav'))) {
  const mix = process.env.MIX || 'docs/made-in-the-dark.mp3', A = {};
  for (const s of ['drums', 'other', 'vocals', 'bass']) { const [L, R] = pcm(path.join(work, 'stems', s + '.wav')); A[s] = DSP.analyze(L, R, 22050, null); }
  { const [L, R] = pcm(mix); A.mix = DSP.analyze(L, R, 22050, null); }
  console.log(`real song (${path.basename(mix)}):`);
  console.log('  hits found in stems with no drums (all false):');
  for (const s of ['other', 'vocals', 'bass']) console.log(`    ${s.padEnd(6)} ` + NAMES.map((nm, k) => `${nm} ${hits(A[s], k).length}`).join(', '));
  console.log('  full mix against the isolated drum stem:');
  NAMES.forEach((nm, k) => console.log(`    ${nm.padEnd(5)} stem ${String(hits(A.drums, k).length).padStart(3)}  mix ${String(hits(A.mix, k).length).padStart(3)}  ${fmt(match(hits(A.mix, k), hits(A.drums, k)))}`));
}
