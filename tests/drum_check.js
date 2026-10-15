// Drum hit detail: ring time and spectrum peak per hit type, on the demo song and on a clip of closed vs open hats.
const DSP = require('../src/dsp.js');
const B = DSP.DRUM_BANDS, med = a => a.slice().sort((x, y) => x - y)[a.length >> 1] || 0;
function summary(res, label) {
  const W = res.evW, by = [[], [], []];
  for (let i = 0; i < res.events.length; i += W) by[res.events[i + 1]].push(res.events.subarray(i, i + W));
  console.log(label);
  ['kick', 'snare', 'hat'].forEach((n, k) => {
    const ev = by[k]; if (!ev.length) return;
    const peakHz = ev.map(e => { let bi = 0; for (let b = 1; b < W - 5; b++) if (e[5 + b] > e[5 + bi]) bi = b; return Math.sqrt(B[bi] * B[bi + 1]); });
    console.log(`  ${n.padEnd(5)} n ${String(ev.length).padStart(3)}  ring median ${med(ev.map(e => e[4])).toFixed(3)} s  spectrum peak median ${med(peakHz).toFixed(0)} Hz  pitch median ${med(ev.map(e => e[3])).toFixed(0)} Hz`);
  });
}
const demo = DSP.synthDemo(44100);
summary(DSP.analyze(demo.L, demo.R, 44100, () => {}), 'demo song (closed hats, kick boom ~46 Hz)');
// closed hats on the beat, open hats on the off-beat
const SR = 44100, n = 12 * SR, L = new Float32Array(n); let seed = 7; const rnd = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;
for (let b = 0; b < 24; b++) {
  const open = b % 2 === 1, s0 = Math.round(b * 0.5 * SR), len = Math.round((open ? 0.5 : 0.08) * SR); let h1 = 0, prev = 0;
  for (let i = 0; i < len && s0 + i < n; i++) { const x = rnd() * 2 - 1, hp = x - prev; prev = x; h1 = hp; L[s0 + i] += h1 * 0.5 * Math.exp(-i / SR * (open ? 7 : 60)); }
}
const res = DSP.analyze(L, L, SR, () => {}), W = res.evW, rings = [[], []];
for (let i = 0; i < res.events.length; i += W) { const t = res.events[i], b = Math.round(t / 0.5); if (Math.abs(t - b * 0.5) < 0.05) rings[b % 2].push(res.events[i + 4]); }
console.log(`hats clip: closed ring median ${med(rings[0]).toFixed(3)} s (n ${rings[0].length}), open ring median ${med(rings[1]).toFixed(3)} s (n ${rings[1].length})`);
