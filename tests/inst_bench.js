// Instrument bench: one synthetic instrument per clip over drums + bass. Scores how "other notes" segments are
// classified (struck / swell / sustained), and whether vibrato and hollow tone are spotted.
const DSP = require(process.env.DSP ? require('path').resolve(process.env.DSP) : '../src/dsp.js');
const SR = 44100, mtof = m => 440 * 2 ** ((m - 69) / 12);
function rng(seed) { return () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; }; }
const INST = {
  piano:   { fam: 0, vib: 0, hollow: 0, chord: true,  durs: [0.4, 0.8, 1.2] },
  guitar:  { fam: 0, vib: 0, hollow: 0, chord: false, durs: [0.25, 0.5, 0.9] },
  organ:   { fam: 2, vib: 0, hollow: 0, chord: true,  durs: [0.6, 1.0, 1.6] },
  strings: { fam: 1, vib: 1, hollow: 0, chord: false, durs: [1.0, 1.6, 2.2] },
  pad:     { fam: 1, vib: 0, hollow: 0, chord: true,  durs: [1.6, 2.4] },
  clar:    { fam: 2, vib: 1, hollow: 1, chord: false, durs: [0.5, 0.9, 1.4] },
};
function voice(name, f, d, rnd) {
  const ln = Math.round((d + 0.6) * SR), out = new Float32Array(ln);
  if (name === 'guitar') { // Karplus-Strong
    const p = Math.round(SR / f), buf = new Float32Array(p).map(() => rnd() * 2 - 1); let k = 0, prev = 0;
    for (let i = 0; i < ln; i++) { const v = buf[k]; const nv = 0.996 * 0.5 * (v + prev); prev = v; buf[k] = nv; k = (k + 1) % p; out[i] = v * (i / SR > d ? Math.max(0, 1 - (i / SR - d) / 0.05) : 1); }
    return out;
  }
  for (let i = 0; i < ln; i++) {
    const t = i / SR, rel = t > d ? Math.max(0, 1 - (t - d) / (name === 'pad' || name === 'strings' ? 0.4 : 0.06)) : 1;
    let v = 0;
    if (name === 'piano') { for (let h = 1; h <= 10; h++) v += Math.sin(2 * Math.PI * f * h * t * (1 + 0.0003 * h * h)) / h * Math.exp(-t * (0.8 + 0.7 * h)); v *= Math.min(1, t / 0.003); }
    else if (name === 'organ') { [[1, 1], [2, 0.8], [3, 0.6], [4, 0.5], [6, 0.3], [8, 0.25]].forEach(([h, a]) => { v += a * Math.sin(2 * Math.PI * f * h * t); }); v *= Math.min(1, t / 0.006); }
    else if (name === 'strings') { const vb = t > 0.2 ? Math.min(1, (t - 0.2) / 0.3) * 0.3 * Math.sin(2 * Math.PI * 5.5 * t) : 0, ff = f * 2 ** (vb / 12), P = phase(ff, i); for (let h = 1; h <= 12; h++) v += Math.sin(2 * Math.PI * h * P) / h; v *= Math.min(1, t / 0.3); }
    else if (name === 'pad') { v = (Math.sin(2 * Math.PI * f * t) + 0.25 * Math.sin(4 * Math.PI * f * t) + 0.1 * Math.sin(6 * Math.PI * f * t)) * Math.min(1, t / 0.45); }
    else if (name === 'clar') { const vb = t > 0.15 ? 0.25 * Math.sin(2 * Math.PI * 5 * t) : 0, ff = f * 2 ** (vb / 12), P = phase(ff, i); for (let h = 1; h <= 11; h += 2) v += Math.sin(2 * Math.PI * h * P) / h; v *= Math.min(1, t / 0.03); }
    out[i] = v * rel;
  }
  return out;
}
let phAcc = 0, phLast = -1; function phase(f, i) { if (i === 0) phAcc = 0; else phAcc += f / SR; return phAcc; }
function clip(name, seed) {
  const I = INST[name], rnd = rng(seed), dur = 20, n = dur * SR, X = new Float32Array(n), D = new Float32Array(n), B = new Float32Array(n), notes = [];
  let t = 0.4;
  while (t < dur - 2.5) {
    const d = I.durs[Math.floor(rnd() * I.durs.length)], root = 57 + Math.floor(rnd() * 14), ms = I.chord && rnd() < 0.6 ? [root, root + 4, root + 7] : [root];
    for (const m of ms) { notes.push([t, d, m]); const v = voice(name, mtof(m), d, rnd), s0 = Math.round(t * SR); for (let i = 0; i < v.length && s0 + i < n; i++) X[s0 + i] += v[i]; }
    t += d + 0.1 + rnd() * 0.3;
  }
  for (let b = 0; b * 0.5 < dur; b++) {
    const s0 = Math.round(b * 0.5 * SR);
    if (b % 2 === 0) { let ph = 0; for (let i = 0; i < 0.3 * SR && s0 + i < n; i++) { const tt = i / SR; ph += (48 + 100 * Math.exp(-tt * 30)) / SR; D[s0 + i] += Math.sin(2 * Math.PI * ph) * Math.exp(-tt * 9); } }
    else for (let i = 0; i < 0.18 * SR && s0 + i < n; i++) D[s0 + i] += (rnd() * 2 - 1) * 0.6 * Math.exp(-i / SR * 22);
    const bm = 33 + [0, 5, 7, 3][(b >> 2) % 4], f = mtof(bm); for (let i = 0; i < 0.45 * SR && s0 + i < n; i++) { const tt = i / SR; B[s0 + i] += (Math.sin(2 * Math.PI * f * tt) + 0.4 * Math.sin(4 * Math.PI * f * tt)) * Math.min(1, tt / 0.005) * Math.exp(-tt * 2); }
  }
  const rms = a => Math.sqrt(a.reduce((s, v) => s + v * v, 0) / a.length) + 1e-9, gx = 0.12 / rms(X), gd = 0.25 / rms(D), gb = 0.15 / rms(B);
  const L = new Float32Array(n), R = new Float32Array(n);
  for (let i = 0; i < n; i++) { const c = D[i] * gd + B[i] * gb; L[i] = c + X[i] * gx * 1.5; R[i] = c + X[i] * gx * 0.5; }
  return { L, R, notes };
}
const names = process.argv[2] ? [process.argv[2]] : Object.keys(INST);
let tot = 0;
for (const name of names) {
  const c = clip(name, 11 + name.length * 3), res = DSP.analyze(c.L, c.R, SR, () => {}, process.env.MIX ? {} : { isolated: 'other' }), W = res.segW || 6, I = INST[name];
  let tw = 0, famOk = 0, vibOk = 0, holOk = 0, hits = 0; const famT = [0, 0, 0];
  for (let i = 0; i < res.segs.length; i += W) {
    const s = res.segs.subarray(i, i + W), d = s[1] - s[0];
    if (!c.notes.some(nt => Math.abs(s[2] - nt[2]) < 0.7 && s[0] < nt[0] + nt[1] && s[1] > nt[0])) continue;
    hits++; tw += d;
    if (W > 6) { famT[s[6]] += d; if (s[6] === I.fam) famOk += d; if ((s[9] > 0) === !!I.vib) vibOk += d; if ((s[11] > 0.5) === !!I.hollow) holOk += d; }
  }
  const acc = famOk / Math.max(1e-9, tw); tot += acc;
  console.log(`${name.padEnd(8)} segs ${String(hits).padStart(3)}  family right ${acc.toFixed(2)} [struck ${(famT[0] / tw).toFixed(2)} swell ${(famT[1] / tw).toFixed(2)} sustained ${(famT[2] / tw).toFixed(2)}]  vibrato right ${(vibOk / tw).toFixed(2)}  hollow right ${(holOk / tw).toFixed(2)}`);
}
console.log('mean family right', (tot / names.length).toFixed(3));
