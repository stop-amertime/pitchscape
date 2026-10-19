// Lines through time (pipeline 13), the worker side. Each pitched sound in a stem is followed as one object over its
// whole life, so what is drawn at a moment knows what came before and after it (designed in the Song Lab,
// spike-timbre/contour-demo, and spike-timbre/DESIGN-instruments.md):
//  peaks   Basic Pitch's contour peaks at each page frame (two of its frames, the larger), where its note output hears
//          the semitone at all, read to a fraction of a bin (the weighted mean over the peak and 2 bins either side,
//          as fine_bends) less its one-bin bias.
//  link    a peak joins the line it continues (within 1.5 bins); a line survives a gap of up to GAP frames (a pumping
//          dip, the activation wavering) when it resumes at the same pitch, and the gap is filled in, so a pad is one
//          line however Basic Pitch's own note-making chopped it.
//  level   how loud each line is at each moment, at the ear's own time resolution: a 4th-order gammatone at its pitch
//          (Holdsworth et al. 1988: shifted to 0 Hz, four one-pole stages of 1.019 ERB, Glasberg & Moore), its
//          envelope smoothed to 20 Hz (Zwicker & Fastl: slower is heard as fluctuation, the wub; faster as
//          roughness), the largest of the three bins round its pitch. The CQT's window (0.93 s at 55 Hz) averaged a
//          4 Hz wub away; this reads a 9.5 dB one as 9.2 dB at 55 Hz.
//  tail    looking forward: where Basic Pitch stops hearing it but the same pitch keeps dying away (never rising
//          again by 1.5 dB), the line follows the ring down to 36 dB under its peak (3 s at most).
//  echo    by whole lives: a line at 2-8 times a lower line's pitch that starts with it, lies within its life and
//          rises and falls with it (correlation of their levels over the overlap) is that note's partial, and fades
//          the more the two move together; never one louder than the lower line by 3 dB.
//  strikes the stem's onsets (librosa's onset strength and peak picking) on the lines sounding then, by the onset's
//          own strength (the mean dB rise over mel bands: one scale for every stem: a pad ~1, a Rhodes 4.5-7).
import {median} from './notes.dsp.mjs';

export const NB = 264, GAP = 5, BIAS = 1;                   // contour bins (3 a semitone from 27.5 Hz); BP_BEND_BIAS
const SR = 22050, HOP = 512, TAIL = 129;                    // TAIL: 3 s of page frames
const smooth = x => x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x);
export const sureOf = n => smooth((n - 0.15) / 0.3);        // half at Basic Pitch's own note threshold (0.3)

/** Basic Pitch's output (Float32Arrays, nF of its frames x 88 / 264) -> each page frame's peaks, flat Float32Array
 * [f, fb, n]... (F page frames; fb in contour bins, 0 = 27.5 Hz). */
export function peaks(note, contour, nF, F) {
  const con = new Float32Array(NB), nt = new Float32Array(88), out = [];
  for (let f = 0; f < F; f++) {
    const k0 = 2 * f, k1 = 2 * f + 1; if (k0 >= nF) break;
    for (let b = 0; b < NB; b++) con[b] = Math.max(contour[k0 * NB + b], k1 < nF ? contour[k1 * NB + b] : 0);
    for (let p = 0; p < 88; p++) nt[p] = Math.max(note[k0 * 88 + p], k1 < nF ? note[k1 * 88 + p] : 0);
    for (let b = 2; b < NB - 2; b++) {
      const c = con[b]; if (c < 8 / 255 || c < con[b - 1] || c <= con[b + 1]) continue;
      const pn = Math.round((b - BIAS) / 3); if (pn < 0 || pn >= 88) continue;
      const n = nt[pn]; if (n < 0.02) continue;
      let sw = 0, sb = 0; for (let j = b - 2; j <= b + 2; j++) { sw += con[j]; sb += con[j] * j; }
      out.push(f, sb / sw - BIAS, n);
    }
  }
  return Float32Array.from(out);
}

/** Peaks -> lines: [{p: [{f, fb, n, gap}], f0, f1}], only those Basic Pitch is sure enough of to print at all. */
function link(pk) {
  const all = [], open = [];
  for (let i = 0; i < pk.length;) {
    const f = pk[i], cur = [];
    while (i < pk.length && pk[i] === f) { cur.push({f, fb: pk[i + 1], n: pk[i + 2]}); i += 3; }
    const pairs = [];
    cur.forEach((q, a) => open.forEach((t, b) => { const d = Math.abs(t.p[t.p.length - 1].fb - q.fb); if (d < 1.5 && f - t.last <= GAP + 1) pairs.push([d, a, b]); }));
    pairs.sort((x, y) => x[0] - y[0]);
    const ua = new Set(), ub = new Set();
    for (const [, a, b] of pairs) { if (ua.has(a) || ub.has(b)) continue; ua.add(a); ub.add(b);
      const t = open[b], q = cur[a], lp = t.p[t.p.length - 1];
      for (let g = t.last + 1; g < f; g++) { const w = (g - t.last) / (f - t.last); t.p.push({f: g, fb: lp.fb + (q.fb - lp.fb) * w, n: Math.min(lp.n, q.n) * 0.5, gap: 1}); }
      t.p.push(q); t.last = f; }
    cur.forEach((q, a) => { if (!ua.has(a)) { const t = {p: [q], last: f}; open.push(t); all.push(t); } });
    for (let j = open.length - 1; j >= 0; j--) if (f - open[j].last > GAP) open.splice(j, 1);
  }
  const kept = [];
  for (const t of all) {
    if (t.p.length < 2) continue;
    t.sure = sureOf(median(Float64Array.from(t.p, q => q.n)));
    if (t.sure < 0.02) continue;
    t.f0 = t.p[0].f; t.f1 = t.p[t.p.length - 1].f; delete t.last;
    kept.push(t);
  }
  return kept;
}

// ---- the gammatone envelope of one bin over a stretch of frames
const LP = (() => {                                           // Butterworth, 2nd order, 20 Hz (bilinear)
  const K = Math.tan(Math.PI * 20 / SR), nrm = 1 / (1 + Math.SQRT2 * K + K * K);
  const b0 = K * K * nrm;
  return {b0, b1: 2 * b0, b2: b0, a1: 2 * (K * K - 1) * nrm, a2: (1 - Math.SQRT2 * K + K * K) * nrm};
})();
function biquad(x, rev) {
  const {b0, b1, b2, a1, a2} = LP, n = x.length;
  let x1 = x[rev ? n - 1 : 0], x2 = x1, y1 = x1, y2 = x1;        // started settled at the first value
  for (let k = 0; k < n; k++) {
    const i = rev ? n - 1 - k : k, v = x[i], y = b0 * v + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = v; y2 = y1; y1 = y; x[i] = y;
  }
}
const WARM = 4096;                                           // samples before and after (0.19 s) for the filters to settle
/** dB (re full scale) of bin b's envelope at page frames f0..f1 (inclusive) of y (the whole stem at 22.05 kHz). */
function envelope(y, b, f0, f1) {
  const hz = 27.5 * 2 ** (b / 36), out = new Float32Array(f1 - f0 + 1);
  if (hz > SR * 0.45) return out.fill(-120);
  const a = Math.exp(-2 * Math.PI * 1.019 * 24.7 * (4.37 * hz / 1000 + 1) / SR), g = 1 - a;
  const s0 = Math.max(0, f0 * HOP - WARM), s1 = Math.min(y.length, f1 * HOP + WARM + 1);
  const env = new Float64Array(Math.max(1, s1 - s0));
  const w = 2 * Math.PI * hz / SR, cw = Math.cos(w), sw = Math.sin(w);
  let pr = Math.cos(w * s0), pi = -Math.sin(w * s0);           // e^{-i w t}, turned one sample at a time
  let r1 = 0, i1 = 0, r2 = 0, i2 = 0, r3 = 0, i3 = 0, r4 = 0, i4 = 0;
  for (let k = 0; k < env.length; k++) {
    const x = y[s0 + k];
    r1 = a * r1 + g * x * pr; i1 = a * i1 + g * x * pi;
    r2 = a * r2 + g * r1; i2 = a * i2 + g * i1;
    r3 = a * r3 + g * r2; i3 = a * i3 + g * i2;
    r4 = a * r4 + g * r3; i4 = a * i4 + g * i3;
    env[k] = 2 * Math.sqrt(r4 * r4 + i4 * i4);
    const nr = pr * cw + pi * sw; pi = pi * cw - pr * sw; pr = nr;
    if ((k & 4095) === 4095) { const m = Math.hypot(pr, pi); pr /= m; pi /= m; }
  }
  biquad(env, false); biquad(env, true);
  for (let f = f0; f <= f1; f++) { const k = Math.min(env.length - 1, Math.max(0, f * HOP - s0)); out[f - f0] = 20 * Math.log10(Math.max(1e-7, env[k])); }
  return out;
}

/** One stem: peaks (from peaks()), y (its mono signal at 22.05 kHz), onsets ([frame, strength]...), F. Returns lines
 * [{f0, sure, echo, peak, pts: Float32Array [fb, L dBFS, hit]... (its tail last), nTail}]. */
export function stemLines(pk, y, onsets, F) {
  const lines = link(pk);
  // the bins each needs, over its life and the 3 s after (for its tail), merged per bin
  const need = new Map();
  for (const t of lines) for (let i = 0; i < t.p.length; i++) {
    const q = t.p[i], b = Math.round(q.fb), last = i === t.p.length - 1;
    for (let k = b - 1; k <= b + 1; k++) { if (k < 0 || k >= NB) continue;
      (need.get(k) || need.set(k, []).get(k)).push([q.f, last ? Math.min(F - 1, q.f + TAIL) : q.f]); }
  }
  const lv = new Map();                                        // bin -> [{f0, f1, db}]
  for (const [b, spans] of need) {
    spans.sort((x, y) => x[0] - y[0]);
    const merged = [];
    for (const [a, z] of spans) { const m = merged[merged.length - 1]; if (m && a <= m[1] + 16) m[1] = Math.max(m[1], z); else merged.push([a, z]); }
    lv.set(b, merged.map(([a, z]) => ({f0: a, f1: z, db: envelope(y, b, a, z)})));
  }
  const at = (b, f) => { const r = lv.get(b); if (!r) return -120; for (const s of r) if (f >= s.f0 && f <= s.f1) return s.db[f - s.f0]; return -120; };
  const lvAt = (f, fb) => { const b = Math.round(fb); let v = -120; for (let k = b - 1; k <= b + 1; k++) v = Math.max(v, at(k, f)); return v; };
  for (const t of lines) {
    for (const q of t.p) q.L = lvAt(q.f, q.fb);
    t.peak = Math.max(...t.p.map(q => q.L));
    t.med = median(Float64Array.from(t.p, q => q.fb));
    t.echo = 0; t.tail = [];
    const q = t.p[t.p.length - 1]; let fl = q.L;
    for (let f = q.f + 1; f < Math.min(F, q.f + TAIL); f++) {
      const v = lvAt(f, q.fb);
      if (v > fl + 1.5 || v < t.peak - 36) break;
      fl = Math.min(fl, v); t.tail.push({f, fb: q.fb, L: v});
    }
  }
  // overtones, by whole lives
  const corr = (a, b) => { const n = a.length; let ma = 0, mb = 0; for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; } ma /= n; mb /= n;
    let sab = 0, saa = 0, sbb = 0; for (let i = 0; i < n; i++) { sab += (a[i] - ma) * (b[i] - mb); saa += (a[i] - ma) ** 2; sbb += (b[i] - mb) ** 2; }
    return saa && sbb ? sab / Math.sqrt(saa * sbb) : 0; };
  for (const t of lines) {
    if (t.p.length < 3) continue;
    for (const l of lines) {
      if (l === t || l.med >= t.med - 30) continue;
      const iv = t.med - l.med, k = Math.round(2 ** (iv / 36)); if (k < 2 || k > 8 || Math.abs(36 * Math.log2(k) - iv) > 1.2) continue;
      const a = Math.max(t.f0, l.f0), z = Math.min(t.f1, l.f1); if (z - a < 2) continue;
      const inside = (z - a + 1) / (t.f1 - t.f0 + 1); if (inside < 0.7 || t.f0 < l.f0 - 2) continue;
      if (t.peak > l.peak + 3) continue;
      const xa = [], xb = []; for (let f = a; f <= z; f++) { xa.push(t.p[f - t.f0].L); xb.push(l.p[f - l.f0].L); }
      const c = xa.length >= 5 ? corr(xa, xb) : (Math.abs(t.f0 - l.f0) <= 2 ? 0.8 : 0);
      t.echo = Math.max(t.echo, smooth((c - 0.4) / 0.4) * smooth(inside / 0.9));
    }
  }
  // strikes
  for (const t of lines) for (const q of t.p) q.hit = 0;
  for (const [fo, v] of onsets) { const h = smooth((v - 1.5) / 6); if (!h) continue;
    for (const t of lines) { if (fo < t.f0 - 2 || fo > t.f1) continue;
      for (let f = Math.max(fo, t.f0); f <= Math.min(fo + 2, t.f1); f++) { const q = t.p[f - t.f0]; if (!q.gap) { q.hit = Math.max(q.hit, h); break; } } } }
  return lines.map(t => {
    const pts = new Float32Array((t.p.length + t.tail.length) * 3);
    let o = 0;
    for (const q of t.p) { pts[o++] = q.fb; pts[o++] = q.L; pts[o++] = q.hit; }
    for (const q of t.tail) { pts[o++] = q.fb; pts[o++] = q.L; pts[o++] = 0; }
    return {f0: t.f0, n: t.p.length, nTail: t.tail.length, sure: t.sure, echo: t.echo, peak: t.peak, pts};
  });
}
