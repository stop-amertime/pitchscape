// loudness: each note's level along its path, the noise heard on it, each stem's noise share, its strikes, and the
// echo and ringing tests per note (loud.dsp.mjs), on the other, guitar, piano, bass and vocal stems at once (a worker
// each). Lines (the voice's CREPE track, the guitar's) get their level and noise per frame too.
import {NOTE_STEMS} from './notes.mjs';
import {pyRound} from './ear.dsp.mjs';

const DSP = './loud.dsp.mjs';
export const LOUD_STEMS = ['other', 'guitar', 'piano', 'bass', 'vocals'];

/** st22: {stem: mono at 22.05 kHz}; mono44: {stem: mono at 44.1 kHz}; segs: the notes stage's records; lines:
 * {stem: Hz per page frame}; F: page frames. Returns {lvl, nz} (Float32Array, every note sample in segs order, as
 * pack_curves lays them out), cues (per note [ex, k, rise, ring], ring as an index into segs), share and strikes
 * ({stem: per frame}), lineLvl and lineNz ({stem: per frame}), and lineLeak ({stem: per frame}): how far (dB) the
 * line's own stem stands above the loudest other pitched stem at its pitch then (the leak test: a voice line that is a
 * guitar or piano bleeding into the vocal stem sits 40-60 dB under it; the page fades it from 10 to 30 dB under). */
export async function loudness(st22, mono44, segs, lines, F, rt) {
  const byStem = {};
  segs.forEach((r, i) => { (byStem[NOTE_STEMS[r[12]]] ??= []).push(i); });
  const parts = await Promise.all(LOUD_STEMS.filter(s => s in st22).map(async s => {
    const idx = byStem[s] || [], y = st22[s].slice(), line = lines[s] ? Float32Array.from(lines[s]) : null;
    const probes = Object.fromEntries(Object.entries(lines).map(([k, v]) => [k, Float32Array.from(v)]));
    const notes = idx.map(i => [segs[i][0], segs[i][1], segs[i][2], [Array.from(segs[i][13][0]), Array.from(segs[i][13][1])]]);
    const [L, cues] = await Promise.all([
      rt.pool.call(DSP, 'stemLoudness', [y, F, notes, line, probes], [y.buffer]),
      idx.length && mono44[s] ? rt.pool.call(DSP, 'noteCues', [mono44[s], idx.map(i => segs[i].slice(0, 4))]) : []]);
    return {s, idx, L, cues};
  }));
  // each note's samples, back in segs order
  const count = segs.map(r => Math.max(2, pyRound((r[1] - r[0]) / (512 / 22050)) + 1)), start = [];
  let total = 0;
  for (const c of count) { start.push(total); total += c; }
  const lvl = new Float32Array(total), nz = new Float32Array(total), cues = segs.map(() => [NaN, 0, 0, -1]);
  const share = {}, strikes = {}, lineLvl = {}, lineNz = {};
  for (const {s, idx, L, cues: cs} of parts) {
    let o = 0;
    idx.forEach((i, k) => {
      lvl.set(L.lvl.subarray(o, o + count[i]), start[i]); nz.set(L.nz.subarray(o, o + count[i]), start[i]); o += count[i];
      if (cs[k]) cues[i] = [cs[k][0], cs[k][1], cs[k][2], cs[k][3] >= 0 ? idx[cs[k][3]] : -1];
    });
    share[s] = L.share; strikes[s] = L.strikes;
    if (L.lineLvl) { lineLvl[s] = L.lineLvl; lineNz[s] = L.lineNz; }
  }
  // the leak test: each line's stem against the loudest other at its pitch, frame by frame
  const lineLeak = {};
  for (const name of Object.keys(lines)) {
    const own = parts.find(q => q.s === name); if (!own) continue;
    const m = new Float32Array(F);
    for (let f = 0; f < F; f++) {
      let o = -200;
      for (const q of parts) if (q.s !== name) o = Math.max(o, q.L.probeDb[name][f]);
      m[f] = own.L.probeDb[name][f] > -200 ? Math.max(-72, Math.min(72, own.L.probeDb[name][f] - o)) : 72;
    }
    lineLeak[name] = m;
  }
  return {lvl, nz, cues, share, strikes, lineLvl, lineNz, lineLeak};
}
