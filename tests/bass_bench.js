// Bass tracking bench: synthetic clips with several bass timbres over drums and pads, scored against the notes played.
const DSP = require('../src/dsp.js');
const SR = 44100;
function rng(seed) { return () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; }; }
const mtof = m => 440 * 2 ** ((m - 69) / 12);
function clip(timbre, seed, opts = {}) {
  const rnd = rng(seed), dur = 24, n = dur * SR, L = new Float32Array(n), R = new Float32Array(n), B = new Float32Array(n), D = new Float32Array(n), P = new Float32Array(n);
  const notes = []; let t = 0.5;
  while (t < dur - 1) {
    const d = [0.15, 0.3, 0.45, 0.6, 0.9][Math.floor(rnd() * 5)], m = 28 + Math.floor(rnd() * 24);
    notes.push([t, d, m]); t += d + (rnd() < 0.3 ? 0.15 + rnd() * 0.3 : 0.02);
  }
  for (const [t0, d, m] of notes) {
    const f = mtof(m), s0 = Math.round(t0 * SR), ln = Math.round((d + 0.05) * SR); let ph = 0, lp = 0;
    const amps = timbre === 'finger' ? [0.45, 1, 0.75, 0.5, 0.35, 0.2, 0.12] : timbre === 'square' ? [1, 0, 0.33, 0, 0.2, 0, 0.14] : null;
    for (let i = 0; i < ln; i++) {
      const tt = i / SR, rel = tt > d ? Math.max(0, 1 - (tt - d) / 0.05) : 1;
      let v = 0;
      if (timbre === 'synth') { ph += f / SR; ph -= Math.floor(ph); const saw = 2 * ph - 1; lp += 0.1 * (saw - lp); v = (lp + 0.7 * Math.sin(2 * Math.PI * ph)) * Math.min(1, tt / 0.006); }
      else if (timbre === '808') { const ff = f * (1 + 0.6 * Math.exp(-tt * 40)); ph += ff / SR; v = Math.sin(2 * Math.PI * ph) * Math.exp(-tt * 1.5) * Math.min(1, tt / 0.003); }
      else { const ph2 = f * tt; for (let h = 0; h < amps.length; h++) if (amps[h]) v += amps[h] * Math.sin(2 * Math.PI * (h + 1) * ph2 * (1 + 0.0004 * h * h)) * Math.exp(-tt * (timbre === 'finger' ? 2 + 1.5 * h : 0.5)); v *= Math.min(1, tt / 0.004); }
      if (s0 + i < n) B[s0 + i] += v * rel;
    }
  }
  const beat = 0.6;
  for (let b = 0; b * beat < dur; b++) {
    const t0 = b * beat;
    if (b % 2 === 0) { const s0 = Math.round(t0 * SR); let ph = 0; for (let i = 0; i < 0.35 * SR && s0 + i < n; i++) { const tt = i / SR; ph += (46 + 110 * Math.exp(-tt * 32)) / SR; D[s0 + i] += Math.sin(2 * Math.PI * ph) * Math.exp(-tt * 8); } }
    else { const s0 = Math.round(t0 * SR); for (let i = 0; i < 0.2 * SR && s0 + i < n; i++) D[s0 + i] += (rnd() * 2 - 1) * 0.6 * Math.exp(-i / SR * 20); }
    { const s0 = Math.round((t0 + beat / 2) * SR); for (let i = 0; i < 0.05 * SR && s0 + i < n; i++) D[s0 + i] += (rnd() * 2 - 1) * 0.2 * Math.exp(-i / SR * 80); }
  }
  const chords = [[57, 60, 64], [53, 57, 60], [55, 59, 62], [52, 55, 59]];
  for (let c = 0; c * 2.4 < dur; c++) for (const m of chords[c % 4]) { const f = mtof(m), s0 = Math.round(c * 2.4 * SR); for (let i = 0; i < 2.4 * SR && s0 + i < n; i++) { const tt = i / SR; P[s0 + i] += (Math.sin(2 * Math.PI * f * tt) + 0.3 * Math.sin(4 * Math.PI * f * tt)) * Math.min(1, tt / 0.2); } }
  const rms = a => Math.sqrt(a.reduce((s, v) => s + v * v, 0) / a.length) + 1e-9;
  const gb = (opts.bass ?? 0.2) / rms(B), gd = 0.3 / rms(D), gp = (opts.pad ?? 0.08) / rms(P);
  for (let i = 0; i < n; i++) { L[i] = B[i] * gb + D[i] * gd + P[i] * gp * 1.3; R[i] = B[i] * gb + D[i] * gd + P[i] * gp * 0.7; }
  return { L, R, notes };
}
function score(res, notes) {
  let N = 0, ok = 0, oct = 0, silent = 0, rest = 0, restOn = 0; const dt = res.dt;
  for (let f = 0; f < res.frames; f++) {
    const t = f * dt, nt = notes.find(b => t >= b[0] + 0.05 && t < b[0] + b[1] - 0.02);
    if (nt) { N++; const hz = res.bassHz[f]; if (!(hz > 0)) silent++; else { const d = DSP.ftom(hz) - nt[2]; const r=Math.round(d); hist[Math.abs(d-r)<0.6? r : 'x']=(hist[Math.abs(d-r)<0.6? r : 'x']||0)+1; if (Math.abs(d) < 0.6) ok++; else if (Math.abs(Math.abs(d) - 12) < 0.6 || Math.abs(Math.abs(d) - 24) < 0.6) oct++; } }
    else if (!notes.some(b => t >= b[0] - 0.05 && t < b[0] + b[1] + 0.25)) { rest++; if (res.bassHz[f] > 0) restOn++; }
  }
  return { ok: ok / N, oct: oct / N, silent: silent / N, restOn: rest ? restOn / rest : 0 };
}
const rows = []; let tot = 0, ms = 0; var hist = {};
for (const timbre of ['synth', 'finger', 'square', '808']) for (const seed of [1, 2]) {
  const c = clip(timbre, seed * 7 + timbre.length, { pad: process.env.PAD ? +process.env.PAD : 0.08 });
  const t0 = Date.now(); const res = DSP.analyze(c.L, c.R, SR, () => {}); ms += Date.now() - t0;
  const s = score(res, c.notes); tot += s.ok; rows.push(`${timbre.padEnd(7)} seed ${seed}: right ${s.ok.toFixed(2)}  octave ${s.oct.toFixed(2)}  silent ${s.silent.toFixed(2)}  on-in-rests ${s.restOn.toFixed(2)}`);
}
console.log(rows.join('\n')); console.log('offsets', JSON.stringify(Object.fromEntries(Object.entries(hist).sort((a,b)=>b[1]-a[1])))); console.log('mean right', (tot / rows.length).toFixed(3), 'analyze ms total', ms);
if (process.env.DUMP) {
  const [timbre, seed] = process.env.DUMP.split(':'); const c = clip(timbre, +seed * 7 + timbre.length, { pad: process.env.PAD ? +process.env.PAD : 0.08 });
  const res = DSP.analyze(c.L, c.R, SR, () => {}, {debug:true}); let k = 0; console.log('boom', res.dbgBass.boom);
  for (let f = 0; f < res.frames; f++) { const t = f * res.dt, nt = c.notes.find(b => t >= b[0] + 0.05 && t < b[0] + b[1] - 0.02); if (!nt) continue;
    const d = res.bassHz[f] > 0 ? DSP.ftom(res.bassHz[f]) - nt[2] : 99; if (Math.abs(d) < 0.6) continue;
    if (k++ < 50) console.log(t.toFixed(2), 'note', nt[2], 'start', nt[0].toFixed(2), 'dur', nt[1], 'off', d.toFixed(1), 'sinceKick', (t % 1.2).toFixed(2)); }
}
