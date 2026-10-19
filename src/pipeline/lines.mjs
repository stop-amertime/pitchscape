// Lines through time (pipeline 13): each pitched stem's sounds followed as whole lines, with how loud each is moment
// to moment (the ear's time resolution), its ring followed after Basic Pitch lets go, overtones faded by whole lives
// and strikes from the stem's onsets (lines.dsp.mjs says how). Here: each stem's onsets (librosa's onset strength and
// peak picking, voice.dsp.mjs, on the workers by frame range), its lines (a worker each), then what needs every stem
// at once: the song's level reference and masking.
import {frameRanges} from './bass.mjs';

const DSP = './lines.dsp.mjs', VDSP = './voice.dsp.mjs', HOP = 512;

/** The ear's bandwidth at contour bin b (Glasberg & Moore's ERB), in bins. */
const reach = b => { const f = 27.5 * 2 ** (b / 36), e = 24.7 * (4.37 * f / 1000 + 1); return Math.max(1, Math.round(36 * Math.log2((f + e) / f))); };

async function onsets(y, rt) {
  const n = y.length, nF = 1 + Math.floor(n / HOP);
  const parts = await Promise.all(frameRanges(nF, rt.pool.size, n, 2048).map(({f0, f1, from, to}) => {
    const part = y.slice(from, to);
    return rt.pool.call(VDSP, 'melFrames', [part, from, n, f0, f1], [part.buffer]);
  }));
  const all = new Float32Array(nF * 128);
  let o = 0;
  for (const p of parts) { all.set(p, o); o += p.length; }
  const {peaks, strength} = await rt.pool.call(VDSP, 'onsetDetect', [all, nF, true], [all.buffer]);
  return Array.from(peaks, (f, i) => [f, strength[i]]);
}

/** st22: {stem: mono at 22.05 kHz}; peaks: {stem: lines.dsp peaks()} (the notes stage makes them from Basic Pitch's
 * output); F: page frames. Returns {stem: [{f0, n, nTail, sure, echo, peak, below, pts}]}: peak and each point's
 * level in dB against the song's loudest line (its 99.5th percentile point); below: how far under the loudest line
 * of any stem within one ERB the line sits over its life (median dB, 0 if it is the loudest); pts as stemLines. */
export async function lines(st22, peaks, F, rt, stats = {}) {
  const t = performance.now();
  const per = await Promise.all(Object.keys(peaks).filter(s => s in st22).map(async s => {
    const ons = await onsets(st22[s], rt), y = st22[s].slice(), pk = peaks[s];
    return [s, await rt.pool.call(DSP, 'stemLines', [pk, y, ons, F], [pk.buffer, y.buffer])];
  }));
  stats.lines_ms = performance.now() - t;
  // the song's reference: its loudest line (99.5th percentile of every point's level)
  const levels = [];
  for (const [, ls] of per) for (const l of ls) for (let i = 1; i < l.pts.length; i += 3) levels.push(l.pts[i]);
  levels.sort((a, b) => a - b);
  const ref = levels.length ? levels[Math.min(levels.length - 1, Math.floor(levels.length * 0.995))] : 0;
  // masking: at each frame, every line's point; each line's median distance under the loudest other within an ERB
  const at = Array.from({length: F}, () => []);
  per.forEach(([, ls]) => ls.forEach(l => { for (let i = 0; i < l.n; i++) at[l.f0 + i]?.push([l.pts[3 * i], l.pts[3 * i + 1], l]); }));
  for (const [, ls] of per) for (const l of ls) {
    const d = [];
    for (let i = 0; i < l.n; i++) {
      const fb = l.pts[3 * i], L = l.pts[3 * i + 1], r = reach(Math.max(0, Math.min(263, Math.round(fb))));
      let m = -Infinity;
      for (const [ofb, oL, ol] of at[l.f0 + i] || []) if (ol !== l && Math.abs(ofb - fb) <= r && oL > m) m = oL;
      d.push(Math.max(0, m - L));
    }
    d.sort((a, b) => a - b);
    l.below = d.length ? d[d.length >> 1] : 0;
    l.peak -= ref;
    for (let i = 1; i < l.pts.length; i += 3) l.pts[i] -= ref;
  }
  return Object.fromEntries(per);
}
