const DSP = require('../src/dsp.js');
let t0 = Date.now();
const demo = DSP.synthDemo(44100);
console.log('synth ms', Date.now() - t0, 'dur', (demo.L.length / 44100).toFixed(1));
t0 = Date.now();
const res = DSP.analyze(demo.L, demo.R, 44100, () => {});
console.log('analyze ms', Date.now() - t0, 'frames', res.frames, 'stereo', res.stereo);
const T = demo.truth, dt = res.dt;
// drums
function evalHits(type, truth, tol = 0.05) {
  const EW = res.evW || 4, det = []; for (let i = 0; i < res.events.length; i += EW) if (res.events[i + 1] === type) det.push(res.events[i]);
  let tp = 0; truth.forEach(t => { if (det.some(d => Math.abs(d - t) < tol)) tp++; });
  let fp = det.filter(d => !truth.some(t => Math.abs(d - t) < tol)).length;
  return `${['kick', 'snare', 'hat'][type]}: truth ${truth.length} det ${det.length} recall ${(tp / truth.length).toFixed(2)} false ${fp}`;
}
console.log(evalHits(0, T.kick)); console.log(evalHits(1, T.snare)); console.log(evalHits(2, T.hat));
// lead
let inN = 0, inV = 0, pe = [], outN = 0, outV = 0;
for (let f = 0; f < res.frames; f++) {
  const t = f * dt; const note = T.notes.find(n => t >= n[0] + 0.06 && t < n[0] + n[1] - 0.03);
  const anyNote = T.notes.find(n => t >= n[0] - 0.05 && t < n[0] + n[1] + 0.1);
  if (note) { inN++; if (res.leadHz[f] > 0) { inV++; pe.push(Math.abs(DSP.ftom(res.leadHz[f]) - note[2])); } }
  else if (!anyNote) { outN++; if (res.leadHz[f] > 0) outV++; }
}
pe.sort((a, b) => a - b);
console.log(`lead: voiced-in-notes ${(inV / inN).toFixed(2)}  median pitch err ${pe[pe.length >> 1]?.toFixed(2)}  >0.5st ${(pe.filter(x => x > 0.5).length / pe.length).toFixed(2)}  false-voiced ${(outV / outN).toFixed(2)} (${outV}/${outN})`);
// where false voiced
const fv = []; for (let f = 0; f < res.frames; f++) { const t = f * dt; const anyNote = T.notes.find(n => t >= n[0] - 0.05 && t < n[0] + n[1] + 0.1); if (!anyNote && res.leadHz[f] > 0) fv.push(t.toFixed(1) + ':' + DSP.ftom(res.leadHz[f]).toFixed(0)); }
console.log('false voiced sample', fv.filter((_, i) => i % 6 === 0).slice(0, 30).join(' '));
// bass
let bN = 0, bOk = 0;
for (let f = 0; f < res.frames; f++) { const t = f * dt; const n = T.bass.find(n => t >= n[0] + 0.05 && t < n[0] + n[1] - 0.02); if (n) { bN++; if (res.bassHz[f] > 0 && Math.abs(DSP.ftom(res.bassHz[f]) - n[2]) < 0.6) bOk++; } }
console.log(`bass: pitch right ${(bOk / bN).toFixed(2)}`);
// segments
const W = res.segW || 6, segs = []; for (let i = 0; i < res.segs.length; i += W) segs.push(Array.from(res.segs.slice(i, i + W)));
console.log('segments', segs.length);
const pl = segs.filter(s => s[0] > 6 * 2.4 && s[2] > 67), pd = segs.filter(s => s[0] < 2.4 * 2 && s[2] < 66);
const avg = (a, k) => (a.reduce((x, y) => x + y[k], 0) / Math.max(1, a.length)).toFixed(2);
console.log(`pluck-ish segs ${pl.length} bright ${avg(pl, 4)} noise ${avg(pl, 5)} | pad-ish segs ${pd.length} bright ${avg(pd, 4)} noise ${avg(pd, 5)}`);
const famN = ['struck', 'swell', 'held']; console.log('families', famN.map((f, k) => f + ' ' + segs.filter(s => s[6] === k).length).join(', '), '| pluck segs struck', pl.filter(s => s[6] === 0).length + '/' + pl.length, '| pad segs swell', pd.filter(s => s[6] === 1).length + '/' + pd.length);
console.log('first segs', segs.slice(0, 8).map(s => `${s[0].toFixed(2)}-${s[1].toFixed(2)} m${s[2].toFixed(1)} a${s[3].toFixed(2)} b${s[4].toFixed(2)}`).join(' | '));
// lead timbre
let lb = [], lz = []; for (let f = 0; f < res.frames; f++) if (res.leadHz[f] > 0) { lb.push(res.leadBr[f]); lz.push(res.leadNz[f]); }
lb.sort((a, b) => a - b); lz.sort((a, b) => a - b);
console.log('lead bright p10/50/90', [0.1, 0.5, 0.9].map(q => lb[Math.floor(q * (lb.length - 1))].toFixed(2)).join('/'), 'noise ref', res.noiseRef.map(x => x.toFixed(2)).join('/'));
// onsets
const O = []; for (let i = 0; i < res.onsets.length; i += 4) O.push([res.onsets[i], res.onsets[i + 1]]);
console.log('onsets', O.length, O.map(o => o[0].toFixed(2) + (o[1] > 0.25 ? '*' : '')).join(' '));
console.log('truth syll', T.notes.map(n => n[0].toFixed(2)).join(' '));
// lyrics
const lines = DSP.parseLyrics(demo.lyrics);
const wt = DSP.alignLyrics(lines, res).flat();
const errs = wt.map((t, i) => Math.abs((t ?? -99) - T.words[i]));
console.log('lyrics auto: words', wt.length, 'truth', T.words.length, 'median err', errs.slice().sort((a, b) => a - b)[errs.length >> 1].toFixed(3), 'within 0.15s', errs.filter(e => e < 0.15).length);
console.log(wt.map((t, i) => `${t?.toFixed(2)}/${T.words[i].toFixed(2)}`).join(' '));
// anchors (tap-along) with 0.12s human error
const lineStarts = [0, 7, 12, 18].map(i => T.words[i] + 0.12);
const wt2 = DSP.alignToAnchors(lines, lineStarts, res).flat();
const e2 = wt2.map((t, i) => Math.abs(t - T.words[i]));
console.log('lyrics anchored: median err', e2.slice().sort((a, b) => a - b)[e2.length >> 1].toFixed(3), 'within 0.15s', e2.filter(e => e < 0.15).length, '/', e2.length);
// speed estimate for 4 min
