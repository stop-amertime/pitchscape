import { ui, api } from './ui.svelte.js';

export function start() {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var cv = $('cv'), ctx = cv.getContext('2d'), liveCv = $('liveCv'), liveCtx = liveCv.getContext('2d'), grainCv = $('grainCv');
  var sheet = $('sheet'), shakeEl = $('shake'), stripView = $('stripView'), stripRow = $('stripRow'), headEl = $('head'), fpsEl = $('fps'), glowBass = $('glowBass'), glowKick = $('glowKick');
  var plate = $('plate'), audio = $('player');
  var playBtn = $('play'), seek = $('seek'), labSeek = $('labSeek'), tNow = $('tNow'), tDur = $('tDur'), msg = $('msg');
  var reduceMotion = !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);

  var css = getComputedStyle(document.documentElement);
  function tok(n, fb) { var v = css.getPropertyValue(n).trim(); return v || fb; }
  var C = { paper: tok('--paper', '#EEF0EA'), ink: tok('--ink', '#23211F'), blue: tok('--blue', '#3255A4'), pink: tok('--pink', '#FF48B0'), purple: tok('--purple', '#765BA7'), teal: tok('--teal', '#00838A'), orange: tok('--orange', '#FF6C2F'), sun: tok('--sun', '#FFB511'), green: tok('--green', '#00A95C'), crimson: tok('--crimson', '#E45D50') };
  function rgba(hex, a) { var h = hex.replace('#', ''); return 'rgba(' + parseInt(h.slice(0, 2), 16) + ',' + parseInt(h.slice(2, 4), 16) + ',' + parseInt(h.slice(4, 6), 16) + ',' + a + ')'; }
  var LABEL_FONT = '500 9.5px "DM Mono", ui-monospace, Menlo, monospace';

  var S = {
    ana: null, dur: 0, name: '', key: '', kicks: [], snares: [], hats: [], toms: [], cymbals: [], segs: [], segMax: 0, medHz: 330,
    lines: [], wt: [], words: [], lineStarts: [],
    vis: { bass: true, kick: true, snare: true, hats: true, toms: true, voice: true, guitar: true, piano: true, synths: true, words: true },
    dirty: true, neverPlayed: true, previewT: 0, tap: null, busy: false, timing: null, song: ''
  };
  var store = {
    get: function (k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage unavailable */ } },
    del: function (k) { try { localStorage.removeItem(k); } catch (e) { /* storage unavailable */ } }
  };

  /* ------------------------------------------------------------ lab settings (A/B switches, kept on this device) */
  var LAB_DEF = {
    colour: 'inst', drums: 'sound', kick: 'splat', bass: 'smudge', font: 'grotesque', wordSize: 'voice',
    shake: reduceMotion ? 0 : 0.25, tilt: reduceMotion ? 0 : 0.5, pulse: reduceMotion ? 0 : 0.6, slip: reduceMotion ? 0 : 0.35,
    secs: 0, ink: 1, weight: 1, grain: 0.5, thick: 'ear', edges: 1, guides: 'on', fps: 'off',
    /* cutoffs: the defaults are each model's own settings */
    vConf: 0.45, vFloor: 0.04, vRun: 90, bFloor: 0.08, hold: 0.3, noteMin: 100, drumK: 1, rough0: 0.1, sharp0: 1.75, leap: 4
  };
  /* only the settings changed from the defaults are kept, so a later change of default reaches everyone who left
     that setting alone. Settings saved in the older all-in-one form are dropped once. */
  var LAB_VERSION = 2, labSaved = store.get('pitchscape:lab');
  var L = Object.assign({}, LAB_DEF, labSaved && labSaved.v === LAB_VERSION ? labSaved.set : {});
  if (L.kick === 'smudge') L.kick = 'splat';   /* the kick's soft smudge became a splatter */
  function saveLab() { var d = {}; for (var k in L) if (L[k] !== LAB_DEF[k]) d[k] = L[k]; store.set('pitchscape:lab', { v: LAB_VERSION, set: d }); }

  var sayTimer = null;
  function say(text, isErr) {
    msg.textContent = text || ''; msg.classList.toggle('err', !!isErr); clearTimeout(sayTimer);
    if (text && !isErr) sayTimer = setTimeout(function () { if (msg.textContent === text) msg.textContent = ''; }, 4000);
  }
  function fmt(t) { t = Math.max(0, t || 0); var m = Math.floor(t / 60), s = Math.floor(t % 60); return m + ':' + (s < 10 ? '0' : '') + s; }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function hash(n) { n |= 0; n = Math.imul(n ^ (n >>> 16), 0x45d9f3b); n = Math.imul(n ^ (n >>> 16), 0x45d9f3b); n ^= n >>> 16; return (n >>> 0) / 4294967296; }
  function lowerBound(arr, t, key) { var lo = 0, hi = arr.length; while (lo < hi) { var mid = (lo + hi) >> 1; if (arr[mid][key] < t) lo = mid + 1; else hi = mid; } return lo; }

  /* ------------------------------------------------------------ geometry */
  var W = 0, H = 0, dpr = 1, nowX = 0, WIN = 4.2, pps = 100;
  /* the pitch axis runs from F_LO to F_HI (log2 Hz), fitted to each song by fitRange. Snare, hats and cymbals have no
     real pitch, so they print in a strip along the top, BEAT_H tall, and the pitched sheet runs below it. */
  var F_LO = Math.log2(28), F_HI = Math.log2(10000), BEAT_H = 60;
  function yOf(hz) { var top = BEAT_H + 12, bot = H - 12, u = (Math.log2(Math.max(hz, 20)) - F_LO) / (F_HI - F_LO); return bot - u * (bot - top); }
  function scaleY() { BEAT_H = Math.round(clamp(H * 0.15, 54, 116)); SEMI_PX = (H - BEAT_H - 24) / ((F_HI - F_LO) * 12); }
  function xOf(t, now) { return nowX - (now - t) * pps; }
  function rate(hz) { return 4 + 3.2 * Math.log2(Math.max(hz, 30) / 30); }

  function resize() {
    dpr = Math.min(DBG.dpr, window.devicePixelRatio || 1);
    W = Math.max(200, cv.clientWidth); H = Math.max(200, cv.clientHeight);
    cv.width = liveCv.width = Math.round(W * dpr); cv.height = liveCv.height = Math.round(H * dpr); liveLx = null;
    WIN = L.secs > 0 ? L.secs : W < 520 ? 4.2 : W < 900 ? 5.5 : 7;
    scaleY();
    nowX = Math.round(W * (W < 520 ? 0.82 : 0.86)); pps = nowX / WIN; headEl.style.left = nowX - 4.5 + 'px';
    makeGrain(); makeHeightLUT(); HT = {}; layoutWords(); S.dirty = true;
    if (labPanel) labUI();
  }
  function makeGrain() {
    var g = grainCv; g.width = cv.width; g.height = cv.height;
    var gx = g.getContext('2d'), img = gx.createImageData(g.width, g.height), d = img.data;
    for (var i = 0; i < d.length; i += 4) { var r = Math.random(); if (r < 0.055) { d[i] = d[i + 1] = d[i + 2] = 255; d[i + 3] = 70 + r * 2000; } }
    gx.putImageData(img, 0, 0);
  }

  /* ------------------------------------------------------------ analysis results */
  function setAnalysis(ana) {
    S.ana = ana; S.dur = ana.dur;
    /* drum hits: [time, type, strength, Hz, ring s, spectrum in DRUM_BANDS, margin]. Margin: the multiple of the
       drum detector's own threshold the hit passed at (it found hits down to 0.6x); the "drum certainty" lever cuts
       there. */
    var EW = ana.evW, ev = ana.events, i;
    S.hits = [];
    for (i = 0; i + EW <= ev.length; i += EW) {
      var e = { t: ev[i], k: ev[i + 1], s: ev[i + 2], hz: ev[i + 3], d: ev[i + 4], p: ev.subarray(i + 5, i + 5 + 16), mg: ev[i + EW - 1], id: i / EW };
      e.br = brightOf(e.p); e.mhz = markHz(e.k, e);
      S.hits.push(e);
    }
    S.segs = []; S.bends = ana.bends; S.holds = ana.holds;
    /* note records: [t0, t1, midi, amp, brightness, noise, family, attack s, fade dB/s, vibrato depth st, vibrato
       rate Hz, hollowness, stem, roughness asper, sharpness acum, curve start, curve count]. Family: 0 struck, 1
       swell, 2 held. Stem: 0 other, 1 guitar, 2 piano. The curve is the note every dt from t0 to t1, count values
       from start in ana.bends (its pitch, in semitones from midi) and ana.holds (how sure the note detector is that it
       still sounds, which the "note hold" lever cuts at). */
    var SW = ana.segW, q = ana.segs;
    for (i = 0; i + SW <= q.length; i += SW) {
      S.segs.push({ t0: q[i], t1: q[i + 1], m: q[i + 2], a: q[i + 3], b: q[i + 4], z: q[i + 5], f: q[i + 6], att: q[i + 7], dec: q[i + 8], vd: q[i + 9], vr: q[i + 10], h: q[i + 11], src: q[i + 12], ro: q[i + 13], sh: q[i + 14], bs: q[i + 15], bn: q[i + 16], id: i / SW });
    }
    /* the voice and bass as they came (every frame the models heard anything), before the cutoffs */
    ana.leadHz0 = ana.leadHz; ana.bassHz0 = ana.bassHz;
    ana.leadEar = easeEar(ana.leadEar, lineRuns(ana.leadHz0)); ana.bassEar = easeEar(ana.bassEar, lineRuns(ana.bassHz0));
    S.noteEar = easeEar(ana.noteEar, S.segs.map(function (sg) { return [sg.bs, sg.bs + sg.bn]; }));
    applyCuts();
  }
  /* how harsh a sound is, 0 (smooth) to 1: roughness above the "rough from" lever (clearly grating 0.3 asper past it)
     and sharpness above "sharp from" (1.25 acum past it), taken together */
  function harsh(ro, sh) { return Math.min(1, Math.hypot(clamp((ro - L.rough0) / 0.3, 0, 1), clamp((sh - L.sharp0) / 1.25, 0, 1))); }
  /* every cutoff, from the Lab's levers: what prints of the voice, bass, notes and drums, and how harsh each is */
  var cutsGen = 0;
  function applyCuts() {
    var ana = S.ana; if (!ana) return;
    cutsGen++;
    var F = ana.frames, i, k;
    /* voice: sung where the pitch tracker is sure enough and the voice loud enough, in long enough runs */
    var v = new Uint8Array(F), run = Math.max(1, Math.round(L.vRun / 1000 / ana.dt));
    for (i = 0; i < F; i++) v[i] = ana.leadHz0[i] > 0 && ana.leadP[i] >= L.vConf && ana.leadL[i] >= L.vFloor ? 1 : 0;
    for (i = 0; i < F;) { if (!v[i]) { i++; continue; } k = i; while (k < F && v[k]) k++; if (k - i < run) v.fill(0, i, k); i = k; }
    var lh = new Float32Array(F); for (i = 0; i < F; i++) lh[i] = v[i] ? ana.leadHz0[i] : 0;
    ana.leadHz = steadyVoice(lh);
    /* bass: where its tracker heard a note, if loud enough */
    var bh = new Float32Array(F); for (i = 0; i < F; i++) bh[i] = ana.bassN[i] >= L.bFloor ? ana.bassHz0[i] : 0;
    ana.bassHz = bh;
    /* how harsh the voice and bass are, measured every half second: eased over a quarter of a second each way */
    var hl = new Float32Array(F), hb = new Float32Array(F);
    for (i = 0; i < F; i++) { hl[i] = harsh(ana.leadRough[i], ana.leadSharp[i]); hb[i] = harsh(ana.bassRough[i], ana.bassSharp[i]); }
    ana.leadH = easeOut(hl, 11); ana.bassH = easeOut(hb, 11);
    /* drums */
    S.kicks = []; S.snares = []; S.hats = []; S.toms = []; S.cymbals = [];
    var lists = [S.kicks, S.snares, S.hats, S.toms, S.cymbals];
    S.hits.forEach(function (e) { if (e.mg >= L.drumK) lists[e.k].push(e); });
    /* notes: each prints while the note detector is at least "note hold" sure it still sounds, bridging dips
       shorter than Basic Pitch's own 11 frames (0.13 s); a stretch shorter than "shortest note" is dropped */
    S.pieces = []; S.segMax = 0;
    var tol = 11 * 256 / 22050, minLen = L.noteMin / 1000, H = S.holds;
    S.segs.forEach(function (sg) {
      sg.hs = harsh(sg.ro, sg.sh);
      var n = sg.bn, dtn = (sg.t1 - sg.t0) / Math.max(1, n - 1), a = -1, last = -1, first = true;
      function close() {
        var t0 = a === 0 ? sg.t0 : sg.t0 + a * dtn, t1 = Math.min(sg.t1, sg.t0 + last * dtn + dtn);
        if (t1 - t0 >= minLen) { S.pieces.push({ s: sg, t0: t0, t1: t1 }); if (t1 - t0 > S.segMax) S.segMax = t1 - t0; }
      }
      for (var j = 0; j < n; j++) {
        /* a note starts where it was struck, even if the detector takes a moment to be sure of it */
        if (H[sg.bs + j] >= L.hold) { if (a < 0) a = first && j * dtn <= tol ? 0 : j; last = j; }
        else if (a >= 0 && (j - last) * dtn > tol) { close(); a = -1; first = false; }
      }
      if (a >= 0) close();
    });
    S.pieces.sort(function (x, y) { return x.t0 - y.t0; });
    var hz = []; for (i = 0; i < ana.leadHz.length; i += 3) if (ana.leadHz[i] > 0) hz.push(ana.leadHz[i]);
    hz.sort(function (x, y) { return x - y; }); S.medHz = hz.length ? hz[hz.length >> 1] : 330;
    fitRange(ana); scaleY();
  }
  /* the sheet's pitch range, fitted to the song: from a little below its lowest notes to a little above its highest
     (bass, voice and every note, by how long each sounds; drums aside), and never less than three octaves */
  function fitRange(ana) {
    var hz = [], i;
    for (i = 0; i < ana.bassHz.length; i += 2) if (ana.bassHz[i] > 0) hz.push(ana.bassHz[i]);
    for (i = 0; i < ana.leadHz.length; i += 2) if (ana.leadHz[i] > 0) hz.push(ana.leadHz[i]);
    S.pieces.forEach(function (pc) { var f = DSP.mtof(pc.s.m); for (var k = Math.max(1, Math.round((pc.t1 - pc.t0) / (2 * ana.dt))); k > 0; k--) hz.push(f); });
    if (hz.length < 50) { F_LO = Math.log2(28); F_HI = Math.log2(10000); return; }
    hz.sort(function (a, b) { return a - b; });
    var lo = Math.log2(hz[Math.floor(hz.length * 0.01)]) - 0.25, hi = Math.log2(hz[Math.floor(hz.length * 0.995)]) + 0.33;
    if (hi - lo < 3) { var mid = (hi + lo) / 2; lo = mid - 1.5; hi = mid + 1.5; }
    F_LO = Math.max(Math.log2(24), lo); F_HI = Math.min(Math.log2(9000), hi);
  }
  /* a frame that leaps away from both its neighbours (which agree with each other) and straight back is the pitch
     tracker slipping, not singing: it takes their pitch. Slides and vibrato are untouched. */
  function easeOut(x, r) {
    var out = new Float32Array(x.length), acc = 0, i;
    for (i = 0; i < x.length + r; i++) {
      if (i < x.length) acc += x[i];
      if (i - 2 * r - 1 >= 0) acc -= x[i - 2 * r - 1];
      if (i - r >= 0 && i - r < x.length) out[i - r] = acc / (2 * r + 1);
    }
    return out;
  }
  function steadyVoice(hz) {
    var out = hz.slice();
    for (var i = 1; i < hz.length - 1; i++) {
      var a = hz[i - 1], b = hz[i], c = hz[i + 1];
      if (!(a > 0 && b > 0 && c > 0)) continue;
      var up = 12 * Math.log2(b / a), back = 12 * Math.log2(b / c);
      if (Math.abs(up) > 0.8 && Math.abs(back) > 0.8 && up * back > 0 && Math.abs(12 * Math.log2(a / c)) < 0.6) out[i] = Math.sqrt(a * c);
    }
    return out;
  }
  function brMap(b) { return clamp((b - 0.05) / 0.3, 0, 1); }
  function zLead(z) { var r = S.ana.noiseRef; return clamp(((z - r[0]) / Math.max(0.05, r[1] - r[0]) - 0.35) * 1.2, 0, 1); }
  function zSeg(z) { return clamp((z - 0.35) / 0.4, 0, 1); }
  function impulse(list, now, decay) {
    var v = 0;
    for (var i = lowerBound(list, now - 0.6, 't'); i < list.length && list[i].t <= now; i++) v += list[i].s * Math.exp(-(now - list[i].t) * decay);
    return Math.min(1.3, v);
  }
  /* the frame where a word's vowel is loudest, in the first quarter-second after it starts */
  function voiceAt(t) {
    var a = S.ana, f = Math.round(t / a.dt), best = -1, bv = 0;
    for (var d = 0; d <= 11; d++) { var g = f + d; if (g < a.frames && a.leadHz[g] > 0 && a.leadN[g] > bv) { bv = a.leadN[g]; best = g; } }
    if (best >= 0) return best;
    for (d = 1; d <= 4; d++) if (f - d >= 0 && a.leadHz[f - d] > 0) return f - d;
    return -1;
  }

  /* ------------------------------------------------------------ colour
     By instrument: each family of sound has one ink (drums share the drum ink, the tuned notes share warm inks).
     By height: colour follows the sheet's pitch axis, low blue to high pink, whatever made the sound.
     By note: tuned sounds take the colour of their note name (neighbours on the circle of fifths get neighbouring
     colours, so a chord reads as a family); drums have no note and keep the drum ink. */
  var NOTE_FIFTHS = ['#E4413A', '#FF6C2F', '#FFB511', '#C2B21A', '#6DB33F', '#00A95C', '#00838A', '#0078BF', '#3255A4', '#765BA7', '#B44C97', '#FF48B0'];
  var HLUT = [], HT = {};
  function hexRGB(h) { h = h.replace('#', ''); return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]; }
  function makeHeightLUT() {
    var stops = [C.blue, C.teal, C.green, C.sun, C.orange, C.pink].map(hexRGB);
    HLUT = [];
    for (var i = 0; i < 96; i++) {
      var u = i / 95 * (stops.length - 1), k = Math.min(stops.length - 2, Math.floor(u)), f = u - k, c = [0, 1, 2].map(function (j) { return Math.round(stops[k][j] + (stops[k + 1][j] - stops[k][j]) * f); });
      HLUT.push('#' + c.map(function (v) { return (v < 16 ? '0' : '') + v.toString(16); }).join(''));
    }
  }
  function heightHex(y) { return HLUT[Math.round(clamp((H - 12 - y) / Math.max(1, H - 28), 0, 1) * 95)] || C.ink; }
  /* colour = which instrument, fixed for the whole song (the stems say which), warmer the more it is out front. The
     notes of the "other" stem (synths, strings, brass, organ) share a teal, in three shades by how each is played:
     darkest held, middle struck, palest swelling. Words print in a deep wine from the voice's family, dark enough to
     read. All real riso inks. */
  var INKS = { voice: '#FF48B0', words: '#914E72', guitar: '#FF6C2F', piano: '#FFB511', lead: '#00838A', pluck: '#009DA5', pad: '#82D8D5', bass: '#3255A4', drum: '#23211F' };
  function drumHex() { return INKS.drum; }
  function tint(group, hz, y) {
    if (L.colour === 'height') return heightHex(y != null ? y : yOf(hz || 1000));
    if (L.colour === 'note' && group !== 'drum' && hz > 0) { var pc = ((Math.round(DSP.ftom(hz)) % 12) + 12) % 12; return NOTE_FIFTHS[(pc * 7) % 12]; }
    return INKS[group];
  }
  function inkA(a) { return Math.min(1, a * L.ink); }

  /* ------------------------------------------------------------ drawing */
  /* edge shape: a faint smooth ripple for a smooth sound, a sawtooth as it gets harsher (roughness and sharpness, as
     measured on its own stem), square steps (q) when hollow */
  function wave(ph, br, q) { var f = ph - Math.floor(ph), w = (1 - br) * Math.sin(6.2832 * ph) * 0.55 + br * (2 * f - 1); return q ? w * (1 - q) + q * (f < 0.5 ? 0.75 : -0.75) : w; }

  var inkPre = {};
  function inkPrefix(hex) { var c = inkPre[hex]; if (!c) { var h = hex.replace('#', ''); c = inkPre[hex] = 'rgba(' + parseInt(h.slice(0, 2), 16) + ',' + parseInt(h.slice(2, 4), 16) + ',' + parseInt(h.slice(4, 6), 16) + ','; } return c; }
  function smooth(e0, e1, x) { var u = clamp((x - e0) / (e1 - e0), 0, 1); return u * u * (3 - 2 * u); }

  /* A filled stroke whose edges follow the sound: sine ripple when pure, sawtooth when bright, speckle when noisy.
     Every point carries its own ink strength (a), so quiet passages print paler and thinner, and ends taper
     like a brush lifting off rather than stopping in a flat cut. openEnd: the stroke is still printing at the head. */
  /* ends: 'taper' (default), 'blunt' (hard start, tapered end) or 'square' (hard both ends). passes: the prints laid
     one over another, each {a: ink, s: width scale, band: which ear band's widths (or -1 for the points' own)}.
     A stroke is built once, in its own coordinates (x = 0 at its first point), and printed by paintStroke wherever
     it has scrolled to: a finished stroke never changes shape, so it is kept and only moved (strokeCache). */
  function buildStroke(pts, color, seed, openEnd, ends, passes) {
    var n = pts.length; if (n < 2) return null;
    var xs = [], ys = [], ts = [], al = [], cs = [], br = [], zs = [], ph = [], qs = [], lfs = [], i, s, P, TAPER = 12;
    var tFirst = pts[0].t, xLast = (pts[n - 1].t - tFirst) * pps;
    function lift(x) {
      if (ends === 'square') return 1;
      var r = ends === 'blunt' ? 1 : x / TAPER; if (!openEnd) r = Math.min(r, (xLast - x) / TAPER); return clamp(r, 0, 1);
    }
    /* each sample along the stroke: where it is, its ink, and where it reads its widths from (point j, u of the way
       to point j + 1) */
    var ja = [], ua = [];
    for (i = 0; i < n - 1; i++) {
      var a = pts[i], b = pts[i + 1], xa = (a.t - tFirst) * pps, xb = (b.t - tFirst) * pps;
      var steps = Math.max(1, Math.ceil(Math.abs(xb - xa) / 1.6));
      for (s = 0; s < steps; s++) {
        var u = s / steps, t = a.t + (b.t - a.t) * u, x = xa + (xb - xa) * u, lf = lift(x);
        xs.push(x); ys.push(a.y + (b.y - a.y) * u); ts.push(t); lfs.push(lf); ja.push(i); ua.push(u);
        al.push((a.a + (b.a - a.a) * u) * lf); cs.push(a.c || color); br.push(a.b + (b.b - a.b) * u);
        zs.push(a.z + (b.z - a.z) * u); ph.push(t * a.r); qs.push(a.q);
      }
    }
    var Lp = pts[n - 1], lfL = openEnd || ends === 'square' ? 1 : 0;
    xs.push(xLast); ys.push(Lp.y); ts.push(Lp.t); lfs.push(-1); ja.push(n - 1); ua.push(0);
    al.push(Lp.a * lfL); cs.push(Lp.c || color); br.push(Lp.b); zs.push(0); ph.push(Lp.t * Lp.r); qs.push(Lp.q);
    var m = xs.length, last = m - 1;
    /* ink strength runs along the stroke as a horizontal gradient, so one fill fades smoothly with no seams; each
       pass prints it at its own strength (globalAlpha) */
    var fill, span = xs[last];
    if (span < 1) fill = inkPrefix(cs[0]) + al[0].toFixed(3) + ')';
    else {
      fill = ctx.createLinearGradient(0, 0, span, 0);
      var stride = Math.max(1, Math.floor(m / Math.max(56, Math.ceil(span / 7))));
      for (i = 0; i < m; i += stride) fill.addColorStop(clamp(xs[i] / span, 0, 1), inkPrefix(cs[i]) + al[i].toFixed(3) + ')');
      fill.addColorStop(1, inkPrefix(cs[last]) + al[last].toFixed(3) + ')');
    }
    function width(p, band, k) { return band >= 0 ? p.e[2 * band + k] : k ? (p.wu != null ? p.wu : p.w) : (p.wd != null ? p.wd : p.w); }
    var out = { t0: tFirst, fill: fill, prints: [] };
    passes.forEach(function (P) {
      var path = new Path2D(), dots = null, botX = [], botY = [], wS = P.s;
      for (i = 0; i < m; i++) {
        var p = pts[ja[i]], q = pts[Math.min(n - 1, ja[i] + 1)], u = ua[i], lf = lfs[i];
        var sc = lf < 0 ? wS * (0.3 + 0.7 * lfL) : wS * (0.3 + 0.7 * Math.sqrt(lf));
        var wu = (width(p, P.band, 1) + (width(q, P.band, 1) - width(p, P.band, 1)) * u) * sc * L.weight;
        var wd = (width(p, P.band, 0) + (width(q, P.band, 0) - width(p, P.band, 0)) * u) * sc * L.weight;
        var amp = (wu + wd) / 2 * (0.03 + 0.8 * Math.max(br[i], 0.3 * (qs[i] || 0)));
        var x = xs[i], y = ys[i];
        if (i) path.lineTo(x, y - wu - amp * wave(ph[i], br[i], qs[i])); else path.moveTo(x, y - wu - amp * wave(ph[i], br[i], qs[i]));
        botX.push(x); botY.push(y + wd + amp * wave(ph[i] + 0.41, br[i], qs[i]));
        if (lf >= 0 && zs[i] > 0.02 && wS === 1 && al[i] > 0.05) {
          var k = Math.round(ts[i] * 300) + seed;
          if (hash(k) < zs[i] * 0.55) {
            var r = 0.45 + hash(k + 29) * 1.05, dx = x + (hash(k + 7) - 0.5) * 2, dy = y + (hash(k + 13) * 2 - 1) * (wu + wd) / 2 / L.weight * 1.6;
            dots = dots || new Path2D(); dots.moveTo(dx + r, dy); dots.arc(dx, dy, r, 0, 6.2832);
          }
        }
      }
      for (i = m - 1; i >= 0; i--) path.lineTo(botX[i], botY[i]);
      path.closePath();
      out.prints.push({ a: P.a, path: path, dots: dots });
    });
    return out;
  }
  function paintStroke(st, now) {
    if (!st) return;
    var dx = xOf(st.t0, now);
    ctx.translate(dx, 0); ctx.fillStyle = st.fill;
    for (var i = 0; i < st.prints.length; i++) {
      var p = st.prints[i]; ctx.globalAlpha = inkA(p.a); ctx.fill(p.path); if (p.dots) ctx.fill(p.dots);
    }
    ctx.translate(-dx, 0); ctx.globalAlpha = 1;
  }
  /* finished strokes, kept while on screen; dropped whenever anything that shapes them changes (a Lab lever, the
     screen's size, the analysis) */
  var strokeCache = new Map(), strokeSig = '', strokeGen = 0, drawCount = 0;
  function strokeCacheCheck() {
    var sig = W + '|' + H + '|' + dpr + '|' + F_LO + '|' + F_HI + '|' + BEAT_H + '|' + cutsGen + '|' + JSON.stringify(L);
    if (sig !== strokeSig) { strokeSig = sig; strokeCache.clear(); strokeGen++; }
    if (++drawCount % 120 === 0) strokeCache.forEach(function (v, k) { if (v.used < drawCount - 2) strokeCache.delete(k); });
  }
  function cachedStroke(key, make) {
    var e = strokeCache.get(key);
    if (!e) { e = { st: make() }; strokeCache.set(key, e); }
    e.used = drawCount; return e.st;
  }
  /* the prints a line or note gets: the ear's three bands (haze, lighter, solid) or, by loudness, a halo and a core */
  function earPasses(alpha) {
    var out = [];
    for (var band = 2; band >= 0; band--) { if (band > 0 && !(L.edges > 0)) continue; out.push({ a: alpha * (band === 0 ? 1 : EAR_INK[band] * L.edges), s: 1, band: band }); }
    return out;
  }

  /* the pen: a round tip where a line is being printed right now, sized by how loud it is there */
  function pen(y, w, col, a) {
    if (a <= 0.03) return;
    ctx.globalAlpha = inkA(0.95 * a); ctx.fillStyle = col; ctx.beginPath(); ctx.arc(nowX, y, w * L.weight + 1.6, 0, 6.2832); ctx.fill();
  }
  /* a soft smear: the line's path dabbed with a soft round brush, wide where it is loud, pale where it is quiet. The
     dabs pile up on a layer of their own, so the smear is one even ink however much they overlap, and that layer is
     then printed over the sheet like any other ink. */
  var DABS = {}, smudgeCv = null, smudgeCtx = null;
  function dabSprite(col) {
    var c = DABS[col]; if (c) return c;
    c = document.createElement('canvas'); c.width = c.height = 64;
    var g = c.getContext('2d'), rg = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    rg.addColorStop(0, rgba(col, 1)); rg.addColorStop(0.35, rgba(col, 0.7)); rg.addColorStop(0.7, rgba(col, 0.22)); rg.addColorStop(1, rgba(col, 0));
    g.fillStyle = rg; g.fillRect(0, 0, 64, 64); DABS[col] = c; return c;
  }
  function smudge(runs, now, alpha) {
    /* the smear's layer covers whatever canvas it prints on: the screen's, or a strip's */
    var tw = ctx.canvas.width, th = ctx.canvas.height;
    if (!smudgeCv || smudgeCv.width < tw || smudgeCv.height < th) {
      smudgeCv = document.createElement('canvas'); smudgeCv.width = Math.max(tw, cv.width); smudgeCv.height = Math.max(th, cv.height); smudgeCtx = smudgeCv.getContext('2d');
    }
    /* only the box the dabs cover is copied and then cleared (in user space x0..x1, y0..y1): a whole-screen copy every
       frame was most of the bass's time */
    var g = smudgeCtx, i, k, x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, m = ctx.getTransform();
    g.setTransform(m);
    runs.forEach(function (pts) { for (i = 0; i < pts.length - 1; i++) {
      var a = pts[i], b = pts[i + 1], xa = xOf(a.t, now), xb = xOf(b.t, now), steps = Math.max(1, Math.ceil(Math.abs(xb - xa) / 2));
      for (k = 0; k < steps; k++) {
        var u = k / steps, ink = a.a + (b.a - a.a) * u; if (ink < 0.02) continue;
        var x = xa + (xb - xa) * u, y = a.y + (b.y - a.y) * u, r;
        if (a.e) {
          /* as wide as the ear spreads it (within 3 dB of its peak), centred on the middle of that spread; the dab's
             soft edge stands for the fainter spread beyond */
          var wu = a.e[3] + (b.e[3] - a.e[3]) * u, wd = a.e[2] + (b.e[2] - a.e[2]) * u;
          y += (wd - wu) / 2; r = Math.max(1.5, (wu + wd) / 2) * L.weight;
        } else {
          var loud = clamp((a.w + (b.w - a.w) * u - 0.8) / 8, 0, 1); r = (SEMI_PX * 1.3 + 1.5) * (0.85 + 0.3 * loud) * L.weight;
        }
        if (x + r < clipL) continue;
        g.globalAlpha = Math.min(1, alpha * ink * 3.2 / r); g.drawImage(dabSprite(a.c), x - r, y - r, 2 * r, 2 * r);
        if (x - r < x0) x0 = x - r; if (x + r > x1) x1 = x + r; if (y - r < y0) y0 = y - r; if (y + r > y1) y1 = y + r;
      }
    } });
    if (x1 < x0) return;
    /* the box in the canvas's pixels (the transform may turn it a little: take all four corners) */
    var bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
    [[x0, y0], [x1, y0], [x0, y1], [x1, y1]].forEach(function (p) {
      var px = m.a * p[0] + m.c * p[1] + m.e, py = m.b * p[0] + m.d * p[1] + m.f;
      bx0 = Math.min(bx0, px); by0 = Math.min(by0, py); bx1 = Math.max(bx1, px); by1 = Math.max(by1, py);
    });
    bx0 = Math.max(0, Math.floor(bx0) - 2); by0 = Math.max(0, Math.floor(by0) - 2); bx1 = Math.ceil(bx1) + 2; by1 = Math.ceil(by1) + 2;
    var cx1 = Math.min(tw, bx1), cy1 = Math.min(th, by1);
    if (cx1 > bx0 && cy1 > by0) {
      ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = Math.min(1, L.ink);
      ctx.drawImage(smudgeCv, bx0, by0, cx1 - bx0, cy1 - by0, bx0, by0, cx1 - bx0, cy1 - by0); ctx.restore();
    }
    /* left clear for next time (the smear's canvas may be larger than this one) */
    g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(bx0, by0, Math.max(0, Math.min(smudgeCv.width, bx1) - bx0), Math.max(0, Math.min(smudgeCv.height, by1) - by0));
  }

  function frameTrack(now, getHz, getW, getA, getB, getZ, group, alpha, halo, seed) {
    var a = S.ana, dt = a.dt, f0 = Math.max(0, Math.floor((now - WIN - 0.3) / dt)), f1 = Math.min(a.frames - 1, Math.floor(now / dt));
    var head = null, soft = group === 'bass' && L.bass === 'smudge', smear = [], ear = L.thick === 'ear';
    var passes = ear ? earPasses(alpha) : (halo > 0 ? [{ a: halo, s: 1.9, band: -1 }] : []).concat([{ a: alpha, s: 1, band: -1 }]);
    function point(f) {
      var hz = getHz(f), y = yOf(hz), p = { t: f * dt, y: y, w: getW(f), a: getA(f), b: getB(f), z: getZ(f), r: rate(hz), c: tint(group, hz, y) };
      if (ear) { p.e = earAt(group === 'bass' ? a.bassEar : a.leadEar, f); p.wd = p.e[2]; p.wu = p.e[3]; }
      return p;
    }
    function pointsOf(s, e) { var pts = []; for (var f = s; f <= e; f++) pts.push(point(f)); return pts; }
    /* glides stay joined; a leap of more than the "line break" lever (a major third) starts a new stroke */
    function joined(f) { var hz = getHz(f), pv = getHz(f - 1); return hz > 0 && pv > 0 && !(Math.abs(12 * Math.log2(hz / pv)) > L.leap); }
    for (var f = f0; f <= f1;) {
      if (!(getHz(f) > 0)) { f++; continue; }
      var s = f; for (f++; f <= f1 && joined(f); f++);
      var e = f - 1, open = e === f1, pts;
      if (soft) { pts = pointsOf(s, e); if (pts.length > 1) smear.push(pts); if (open) head = pts[pts.length - 1]; }
      else if (open) { pts = pointsOf(s, e); head = pts[pts.length - 1]; if (pts.length > 1) paintStroke(buildStroke(pts, null, seed, true, undefined, passes), now); }
      else if (e > s || (s === f0 && s > 0 && joined(s))) {
        /* a finished stroke, built once from its true start (even if that has scrolled off) and kept */
        paintStroke(cachedStroke(group + ':' + e, function () {
          var s0 = s; while (s0 > 0 && joined(s0)) s0--;
          return buildStroke(pointsOf(s0, e), null, seed, false, undefined, passes);
        }), now);
      }
    }
    if (smear.length) smudge(smear, now, alpha);
    if (head) {
      /* the pen marks where the line is now: as wide as its solid core, but never a blot */
      if (head.e) pen(head.y + (head.e[0] - head.e[1]) / 2, soft ? SEMI_PX * 0.55 + 0.6 : Math.min(SEMI_PX * 0.8, (head.e[0] + head.e[1]) / 2), head.c, head.a);
      else pen(head.y, soft ? SEMI_PX * 0.55 + 0.6 : head.w, head.c, head.a);
    }
  }

  /* how far a sound spreads along the ear below and above its pitch, in px, at sample j of an array of ear widths:
     (down, up) where its excitation is within 1, 3 and 10 dB of its peak (the server's earDb) */
  function earAt(arr, j) {
    var b = j * 6, out = new Array(6);
    for (var i = 0; i < 6; i++) out[i] = arr[b + i] * SEMI_PX;
    return out;
  }
  /* the ear takes a moment to hear a sound's spread: widths are eased over about 160 ms (7 samples), within each run
     of a line (voice, bass) or each note, so a reading that flickers for a frame does not flicker the print */
  function easeEar(arr, runs) {
    var out = new Float32Array(arr.length), R = 3;
    runs.forEach(function (r) {
      for (var j = r[0]; j < r[1]; j++) {
        var lo = Math.max(r[0], j - R), hi = Math.min(r[1] - 1, j + R), n = hi - lo + 1;
        for (var c = 0; c < 6; c++) { var sum = 0; for (var k = lo; k <= hi; k++) sum += arr[k * 6 + c]; out[j * 6 + c] = sum / n; }
      }
    });
    return out;
  }
  function lineRuns(hz) { var r = [], i = 0, n = hz.length, k; while (i < n) { if (!(hz[i] > 0)) { i++; continue; } k = i; while (k < n && hz[k] > 0) k++; r.push([i, k]); i = k; } return r; }
  /* the ink of each band, as a share of the line's own: where the sound is within 1 dB of its peak prints solid */
  var EAR_INK = [1, 0.32, 0.1];
  /* a note's pitch at time t: its MIDI pitch plus its bend there (read between the bend's samples) */
  function bendAt(s, t) {
    if (s.bn < 2) return 0;
    var u = clamp((t - s.t0) / Math.max(1e-6, s.t1 - s.t0), 0, 1) * (s.bn - 1), k = Math.min(s.bn - 2, Math.floor(u)), f = u - k, b = S.bends, j = s.bs + k;
    return b[j] + (b[j + 1] - b[j]) * f;
  }
  /* the guitar, piano or other notes (src), each drawn along its pitch as it bends */
  var SEMI_PX = 1;
  function drawSegs(now, lv, src, key) {
    var t0w = now - WIN - 0.2, i = lowerBound(S.pieces, t0w - S.segMax, 't0');
    for (; i < S.pieces.length; i++) {
      var pc = S.pieces[i], s = pc.s; if (pc.t0 > now) break; if (pc.t1 < t0w || s.src !== src) continue;
      var end = Math.min(pc.t1, now); if (end - pc.t0 < 0.02) continue;
      if (pc.t1 >= now) lv[key] += s.a * 0.5;
      var hz = DSP.mtof(s.m), y0 = yOf(hz), open = pc.t1 > now;
      var col = tint(src === 1 ? 'guitar' : src === 2 ? 'piano' : s.f === 1 ? 'pad' : s.f === 2 ? 'lead' : 'pluck', hz, y0);
      /* a finished note never changes shape: built once and kept on its piece */
      if (!open) {
        if (pc.stG !== strokeGen) { pc.stG = strokeGen; pc.st = noteStroke(pc, end, col, false); }
        paintStroke(pc.st, now); continue;
      }
      var pts = notePoints(pc, end);
      paintStroke(noteStroke(pc, end, col, true, pts), now);
      var hd = pts[pts.length - 1]; if (hd.e) pen(hd.y + (hd.e[0] - hd.e[1]) / 2, Math.min(SEMI_PX * 0.8, (hd.e[0] + hd.e[1]) / 2), col, hd.a); else pen(hd.y, hd.w, col, hd.a);
    }
  }
  function noteStroke(pc, end, col, open, pts) {
    var s = pc.s, passes = L.thick === 'ear' ? earPasses(0.82) : s.f === 1 ? [{ a: 0.12, s: 1.45, band: -1 }, { a: 0.78, s: 1, band: -1 }] : [{ a: s.f === 0 ? 0.85 : 0.82, s: 1, band: -1 }];
    return buildStroke(pts || notePoints(pc, end), col, 101 + s.id * 7, open, s.f === 0 ? 'blunt' : s.f === 2 ? 'square' : undefined, passes);
  }
  /* the note's points from the start of this piece to end */
  function notePoints(pc, end) {
    var s = pc.s, hz = DSP.mtof(s.m), z = zSeg(s.z), r = rate(hz), a1 = Math.min(1, s.a), pts = [];
    var q = s.h > 0.5 ? clamp((s.h - 0.5) * 2.5, 0, 1) : 0;
    /* u: time since the note was struck (a later stretch of the same note carries on its fade) */
    for (var t = pc.t0; ; t += S.ana.dt) {
      var tt = Math.min(t, end), u = tt - s.t0, y = yOf(DSP.mtof(s.m + bendAt(s, tt))), w, ink;
      if (s.f === 0) {
        /* struck: full weight at the strike, thinning and paling at the fade rate measured for this note */
        var g = Math.pow(10, Math.max(-80, Math.min(0, s.dec)) * u / 20);
        w = (1.2 + 4.6 * s.a) * 1.3 * (0.22 + 0.78 * Math.pow(g, 0.7)) * Math.min(1, u / 0.012 + 0.6);
        ink = (0.5 + 0.5 * a1) * (0.35 + 0.65 * g);
      } else if (s.f === 1) {
        /* swell: grows in from a point over the attack it was heard to take */
        var A = Math.max(0.08, s.att);
        w = (1 + 4.2 * s.a) * 1.6 * (0.04 + 0.96 * smooth(0, A, u)) * Math.min(1, (pc.t1 - tt) / 0.25 + 0.25);
        ink = (0.45 + 0.55 * a1) * (0.3 + 0.7 * smooth(0, A, u));
      } else {
        /* held */
        w = (1 + 4.2 * s.a) * 1.15 * Math.min(1, (tt - pc.t0) / 0.02 + 0.5); ink = 0.5 + 0.5 * a1;
      }
      var pt = { t: tt, y: y, w: w, a: ink, b: s.hs, z: s.f === 1 ? z * 0.5 : z, r: r, q: q };
      if (L.thick === 'ear') {
        /* as wide as the ear spreads it; how it was struck, swelled or held shows in the ink alone */
        pt.e = earAt(S.noteEar, s.bs + Math.round((tt - s.t0) / Math.max(1e-6, s.t1 - s.t0) * (s.bn - 1)));
      }
      pts.push(pt);
      if (tt >= end) break;
    }
    return pts;
  }

  /* ---- drums: one compact mark per hit, printed where the hit is loudest (a tom at its note, a snare at its crack,
     hats and cymbals at their sizzle), each kind in its own shape. Snare: a spiky splat, spikier the brighter it
     cracked. Tom: a round drop. Hat: a tight fleck. Cymbal: a wider, finer spray. Hats and cymbals that ring trail
     flecks for as long as they ring. "All alike" keeps the shapes and drops what each hit's own sound adds. */
  var DBB = DSP.DRUM_BANDS, SPL = new Float32Array(36);
  /* how bright a hit is: its share of energy above 2.5 kHz */
  function brightOf(P) {
    if (!P) return 0.5;
    var hi = 0, all = 0;
    for (var b = 0; b < P.length; b++) { var w = P[b] * P[b]; all += w; if (DBB[b] >= 2500) hi += w; }
    return all > 0 ? hi / all : 0.5;
  }
  /* where a hit prints: a kick at its boom, a tom at its loudest low band, the rest at their centre of energy */
  function markHz(kind, e) {
    if (kind === 0) return clamp(e.hz || 52, 30, 180);
    if (kind === 3 && e.p) {
      var bb = -1; for (var b = 0; b < e.p.length; b++) if (DBB[b] >= 55 && DBB[b + 1] <= 760 && (bb < 0 || e.p[b] > e.p[bb])) bb = b;
      if (bb >= 0) return Math.sqrt(DBB[bb] * DBB[bb + 1]);
    }
    var lim = kind === 1 ? [350, 4000] : kind === 3 ? [60, 800] : [2200, 9500];
    return clamp(e.hz || lim[0], lim[0], lim[1]);
  }
  function drawHits(list, now, kind) {
    for (var i = lowerBound(list, now - WIN - 1.2, 't'); i < list.length && list[i].t <= now; i++) drumMark(list[i], now, kind);
  }
  /* where a hit prints: a tom at its note on the sheet; a snare, hat or cymbal in its own row of the strip along the
     top (cymbals highest, snares lowest), a little higher the brighter it is */
  function hitY(e, kind) {
    if (kind === 'tom') return clamp(yOf(e.mhz), BEAT_H + 12, H - 12);
    var span = BEAT_H - 12, row = kind === 'cymbal' ? 0.2 : kind === 'hat' ? 0.5 : 0.8;
    return 8 + span * row - (L.drums === 'sound' ? (e.br - 0.5) * span * 0.2 : 0);
  }
  function drumMark(e, now, kind) {
    var x = xOf(e.t, now), y = hitY(e, kind), age = now - e.t, grow = age < 0.05 ? 0.55 + 0.45 * age / 0.05 : 1;
    var own = L.drums === 'sound', br = own ? e.br : 0.35, sd = e.id * 977 + kind.length * 131;
    var trail = own && (kind === 'hat' || kind === 'cymbal') ? e.d * pps : 0;
    if (x + trail + 30 < clipL) return;
    ctx.fillStyle = tint('drum', e.mhz, y); ctx.beginPath();
    if (kind === 'snare') splat(x, y, (3.2 + 4.2 * e.s) * grow, br, e.s, sd);
    else if (kind === 'tom') drop(x, y, (2.8 + 3.6 * e.s) * grow, sd);
    else spray(x, y, e.s, grow, trail, Math.min(age, e.d) * pps, kind === 'cymbal', sd);
    ctx.globalAlpha = inkA(kind === 'snare' || kind === 'tom' ? 0.92 : 0.9); ctx.fill();
  }
  /* an ink splat: a ragged core, thin spikes (more and longer the brighter the hit) and a few loose drops */
  function splat(x, y, r0, br, s, sd) {
    var n = SPL.length, i, an, spikes = 3 + Math.round(6 * br);
    for (i = 0; i < n; i++) SPL[i] = r0 * (0.84 + 0.3 * hash(sd + i));
    for (i = 0; i < spikes; i++) SPL[Math.floor(hash(sd + 50 + i) * n)] = r0 * (1.45 + (0.7 + 1.6 * br) * hash(sd + 80 + i));
    for (i = 0; i < n; i++) { an = i / n * 6.2832; if (i) ctx.lineTo(x + Math.cos(an) * SPL[i], y + Math.sin(an) * SPL[i]); else ctx.moveTo(x + SPL[0], y); }
    ctx.closePath();
    for (i = 0; i < 2 + Math.round(2 * s + 2 * br); i++) dot(x, y, hash(sd + 120 + i) * 6.2832, r0 * (2 + 1.4 * hash(sd + 140 + i)), r0 * (0.12 + 0.16 * hash(sd + 160 + i)));
  }
  /* a round drop, slightly uneven, with a splash or two beside it */
  function drop(x, y, r0, sd) {
    var n = 18, i, an, r;
    for (i = 0; i < n; i++) { an = i / n * 6.2832; r = r0 * (0.92 + 0.16 * hash(sd + i)); if (i) ctx.lineTo(x + Math.cos(an) * r, y + Math.sin(an) * r); else ctx.moveTo(x + r, y); }
    ctx.closePath();
    for (i = 0; i < 2; i++) dot(x, y, hash(sd + 40 + i) * 6.2832, r0 * (1.5 + 0.7 * hash(sd + 60 + i)), r0 * (0.14 + 0.12 * hash(sd + 80 + i)));
  }
  /* a hat: a tight fleck of fine specks. A cymbal: a wider, finer spray. Either, while it rings, trails specks to the
     right that thin out as the sound dies: each speck has its place along the whole ring (trail px) and prints when
     the head reaches it (shown px), so a printed speck never moves */
  function spray(x, y, s, grow, trail, shown, wide, sd) {
    var n = wide ? 14 + Math.round(16 * s) : 6 + Math.round(6 * s), rx = (wide ? 6.5 + 8 * s : 4 + 4.5 * s) * grow, ry = rx * (wide ? 0.75 : 0.9), i, d;
    dot(x, y, 0, 0, (wide ? 1.1 : 1.9 + 1.2 * s) * grow);
    for (i = 0; i < n; i++) {
      d = Math.sqrt(hash(sd + 30 + i));
      var an = hash(sd + i) * 6.2832;
      dot(x + Math.cos(an) * d * rx, y + Math.sin(an) * d * ry, 0, 0, (wide ? 0.6 + 0.9 * hash(sd + 60 + i) : 0.8 + 1.1 * hash(sd + 60 + i)) * grow);
    }
    if (trail > 2) {
      var m = Math.min(28, Math.round(trail / (wide ? 2.5 : 3.5)));
      for (i = 0; i < m; i++) {
        var u = (i + hash(sd + 200 + i)) / m;
        if (u * trail > shown) continue;
        dot(x + u * trail, y + (hash(sd + 230 + i) - 0.5) * ry * (wide ? 2.4 : 1.6) * (1 - 0.5 * u), 0, 0, (wide ? 1 : 1.2) * (1 - 0.55 * u));
      }
    }
  }
  /* one round speck, at a distance and angle from (x, y), added to the current path */
  function dot(x, y, an, dist, r) { var px = x + Math.cos(an) * dist, py = y + Math.sin(an) * dist; ctx.moveTo(px + r, py); ctx.arc(px, py, r, 0, 6.2832); }

  /* ---- the kick: a big thud at the pitch of its boom. An ink splatter like the snare's but larger, rounder (a kick is
     a dark sound: few spikes) and part transparent, so what is under it shows through; or halftone (a riso screen of
     dots, densest at the centre). Each lands larger and settles, and a faint pressure bloom spreads out from it. */
  function halftone(col, R) {
    var key = col + '|' + R; if (HT[key]) return HT[key];
    var sz = Math.ceil(2 * R * dpr) + 2, c = document.createElement('canvas'); c.width = c.height = sz;
    var g = c.getContext('2d'), cx = sz / 2, sp = 4.2 * dpr, ca = Math.SQRT1_2, n = Math.ceil(R * dpr / sp) + 2, Rp = R * dpr, floor = Math.exp(-2.6);
    g.fillStyle = col; g.beginPath();
    for (var a = -n; a <= n; a++) for (var b = -n; b <= n; b++) {
      var px = cx + (a - b) * ca * sp, py = cx + (a + b) * ca * sp, d = Math.sqrt((px - cx) * (px - cx) + (py - cx) * (py - cx)) / Rp;
      if (d >= 1) continue;
      var v = (Math.exp(-d * d * 2.6) - floor) / (1 - floor), r = sp * 0.6 * Math.sqrt(v);
      if (r < 0.3) continue;
      g.moveTo(px + r, py); g.arc(px, py, r, 0, 6.2832);
    }
    g.fill(); HT[key] = c; return c;
  }
  function drawKicks(now) {
    for (var i = lowerBound(S.kicks, now - WIN - 0.4, 't'); i < S.kicks.length && S.kicks[i].t <= now; i++) kickMark(S.kicks[i], now);
  }
  function kickMark(e, now) {
    var hz = e.mhz, x = xOf(e.t, now), y = clamp(yOf(hz), BEAT_H + 12, H - 10), age = now - e.t, s = e.s, col = tint('drum', hz, y);
    var settle = Math.min(1, age / 0.28), R = (10 + 19 * s) * (1 + 0.4 * clamp(e.d / 0.25, 0, 1)), RR = R * (1 + 0.35 * (1 - settle)), rg;
    if (L.kick === 'halftone') {
      var Rq = Math.max(8, Math.round(R / 4) * 4);
      ctx.globalAlpha = inkA(0.36 + 0.34 * s); ctx.drawImage(halftone(col, Rq), x - RR, y - RR, 2 * RR, 2 * RR);
    } else {
      ctx.fillStyle = col; ctx.beginPath(); splat(x, y, RR * 0.42, 0.15, s, e.id * 977 + 7);
      ctx.globalAlpha = inkA(0.38 + 0.3 * s); ctx.fill();
    }
    if (age < 0.45) {
      var kb = age / 0.45, Rb = R * (1.5 + 2.4 * kb);
      rg = ctx.createRadialGradient(x, y, R * 0.4, x, y, Rb);
      rg.addColorStop(0, rgba(col, inkA(0.2 * s * (1 - kb) * (1 - kb)))); rg.addColorStop(1, rgba(col, 0));
      ctx.globalAlpha = 1; ctx.fillStyle = rg; ctx.beginPath(); ctx.arc(x, y, Rb, 0, 6.2832); ctx.fill();
    }
  }
  function drawWords(now) {
    if (!S.words.length) return;
    ctx.textBaseline = 'alphabetic';
    for (var i = lowerBound(S.words, now - WIN - 0.8, 't'); i < S.words.length && S.words[i].t <= now; i++) {
      var w = S.words[i], x = xOf(w.t, now); if (x + w.px < -4) continue;
      var age = now - w.t, k = age < 0.09 ? age / 0.09 : 1, y = w.yy;
      ctx.font = w.font; ctx.fillStyle = tint('words', w.hz, y);
      ctx.globalAlpha = inkA(0.4 + 0.58 * k);
      if (k < 1) { ctx.save(); ctx.translate(x, y); var sc = 1.25 - 0.25 * k; ctx.scale(sc, sc); ctx.fillText(w.text, 0, 0); ctx.restore(); }
      else ctx.fillText(w.text, x, y);
    }
  }
  function drawGuides() {
    if (L.guides === 'off') return;
    ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1; ctx.lineWidth = 1;
    ctx.font = LABEL_FONT; ctx.textBaseline = 'bottom';
    for (var o = 1; o <= 8; o++) {
      var hz = 440 * Math.pow(2, (12 * (o + 1) - 69) / 12), y = Math.round(yOf(hz)) + 0.5;
      if (y < BEAT_H + 22 || y > H - 4) continue;
      ctx.strokeStyle = 'rgba(35,33,31,0.075)'; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
      ctx.fillStyle = 'rgba(35,33,31,0.42)'; ctx.fillText('C' + o + ' ' + Math.round(hz), 6, y - 2);
    }
    var yb = BEAT_H + 4.5;
    ctx.strokeStyle = 'rgba(35,33,31,0.09)'; ctx.setLineDash([1, 5]); ctx.beginPath(); ctx.moveTo(0, yb); ctx.lineTo(W, yb); ctx.stroke(); ctx.setLineDash([]);
  }
  var DIRS = { guitar: [0.8, -0.6], synths: [-0.4, 0.75], piano: [0.65, 0.45], bass: [-0.9, 0.3], voice: [0.5, 0.85], hats: [-0.3, -0.95], toms: [0.7, -0.3], snare: [0.95, 0.2], kick: [-0.6, -0.7], words: [0.25, 0.6] };
  var meters = {};
  document.querySelectorAll('.ink').forEach(function (b) { meters[b.dataset.layer || b.dataset.toggle] = { el: b, v: -1 }; });
  function setMeter(name, v) { var m = meters[name]; if (!m) return; v = Math.round(clamp(v, 0, 1) * 20) / 20; if (v !== m.v) { m.v = v; m.el.style.setProperty('--lvl', v); } }

  /* ?bench: window.pitchscapeBench(times, mode) draws the print at each time and resolves to the ms each layer took
     (median and 95th percentile); tools/bench_frames.cjs drives it. mode 'paint': a pixel is read back after each
     layer, so the canvas finishes painting it and its time includes the painting. 'js': each layer's JavaScript
     alone. 'raf': one time per animation frame, as when playing; "frame" is then the time between frames, painting
     and all (at least the screen's refresh interval). */
  var BENCH = /[?&]bench\b/.test(location.search) ? {} : null, benchMode = 'paint';
  /* ?bench&live: draw everything live, as with the Lab open */
  var BENCH_LIVE = /[?&]live\b/.test(location.search);
  function benchFlush() { if (benchMode === 'paint') ctx.getImageData(0, 0, 1, 1); }
  function benchLayer(name, fn) { benchFlush(); var t = performance.now(); fn(); benchFlush(); (BENCH[name] = BENCH[name] || []).push(performance.now() - t); }
  if (BENCH) window.pitchscapeReady = function () { return !!S.ana; };
  if (BENCH) window.pitchscapeStrips = function () { var o = {}; strips.forEach(function (s, k) { o[k] = s.done; }); return { strips: o, pps: pps, nowX: nowX, W: W }; };
  if (BENCH) window.pitchscapeBench = function (times, mode) {
    benchMode = mode || 'paint';
    for (var k in BENCH) delete BENCH[k];
    var total = [];
    function stats() {
      BENCH.frame = total; var out = {};
      for (var k in BENCH) {
        var v = BENCH[k].slice().sort(function (a, b) { return a - b; });
        out[k] = { med: v[v.length >> 1], p95: v[Math.min(v.length - 1, Math.floor(v.length * 0.95))], n: v.length };
      }
      return out;
    }
    if (benchMode !== 'raf') {
      times.forEach(function (t) { benchFlush(); var t0 = performance.now(); draw(t); benchFlush(); total.push(performance.now() - t0); });
      return Promise.resolve(stats());
    }
    return new Promise(function (done) {
      var i = 0, last = 0;
      (function step(ts) {
        if (i > 0) total.push(ts - last);
        last = ts;
        if (i >= times.length) { total.shift(); return done(stats()); }
        draw(times[i++]); requestAnimationFrame(step);
      })(performance.now());
    });
  };

  /* each layer: its name and how to print it as it stands at time now (lv gathers how loud each kind of note is now) */
  var LAYERS = [
    ['synths', function (now, lv) { drawSegs(now, lv, 0, 'synths'); }],
    ['piano', function (now, lv) { drawSegs(now, lv, 2, 'piano'); }],
    ['guitar', function (now, lv) { drawSegs(now, lv, 1, 'guitar'); }],
    ['bass', function (now) {
      var a = S.ana;
      frameTrack(now, function (f) { return a.bassHz[f]; }, function (f) { return 0.8 + 12 * a.bassN[f]; }, function (f) { return smooth(0.015, 0.3, a.bassN[f]); }, function (f) { return a.bassH[f]; }, function () { return 0; }, 'bass', 0.86, 0.15, 11);
    }],
    ['voice', function (now) {
      var a = S.ana;
      frameTrack(now, function (f) { return a.leadHz[f]; }, function (f) { return 0.8 + 8.5 * a.leadN[f]; }, function (f) { return smooth(0.02, 0.4, a.leadN[f]); }, function (f) { return a.leadH[f]; }, function (f) { return zLead(a.leadNz[f]); }, 'voice', 0.9, 0.16, 37);
    }],
    ['hats', function (now) { drawHits(S.hats, now, 'hat'); drawHits(S.cymbals, now, 'cymbal'); }],
    ['toms', function (now) { drawHits(S.toms, now, 'tom'); }],
    ['snare', function (now) { drawHits(S.snares, now, 'snare'); }],
    ['kick', function (now) { drawKicks(now); }],
    ['words', function (now) { drawWords(now); }]
  ];
  /* ---- the print, drawn ahead. Time only slides the print left, and a mark stops changing soon after its time (a
     line's end tapers over 12 px, a kick settles and its bloom fades in 0.45 s, a word grows in 90 ms). So while the
     Lab is closed the print is drawn ahead into strips STRIP px wide, a CHUNK at a time in each frame's spare moments,
     by the layers' own drawing code at a moment late enough that every mark reaching into the chunk has settled (lag:
     how long a mark changes, and how far it reaches back from its time). The strips are canvases in a row that the
     browser slides left with one transform a frame (#stripRow, clipped at where the live part starts by #stripView);
     only the last moment before the head is drawn each frame, on #liveCv. Both multiply onto the paper beneath, as
     every ink does, and multiplying comes to the same in any order. Misprint (each colour slipping on its own) needs
     every layer apart, so it shows only while the Lab is open, when everything is drawn live on #cv so a lever shows
     at once. */
  /* the speed test's switches (Lab > Speed test): each piece of the stack, on unless a test turns it off */
  var DBG_DEF = { blend: true, grain: true, glows: true, tilt: true, shake: true, live: false, still: false, dpr: 2, narrow: false, nolive: false, nostrips: false, strip: 1024 }, DBG = Object.assign({}, DBG_DEF), liveLx = null;
  var STRIP = 1024, CHUNK = 128, PER = STRIP / CHUNK, strips = new Map(), stripsFor = '', stripsAna = null, stripPool = [], clipL = -Infinity;
  var SETTLE = { kick: 0.5, words: 0.15, hats: 0.1, toms: 0.1, snare: 0.1 }, REACH = { kick: 60, bass: 40 };
  /* how far back from a stretch of the print a mark can start and still reach into it: a word's text and a cymbal's
     ring run on to the right of their time */
  var LOOK = { words: 3, hats: 2.5 };
  function look(name) { return LOOK[name] || 0.3; }
  function lag(name) { return (SETTLE[name] || 0.3) + (REACH[name] || 30) / pps; }
  function stripLayers() { return LAYERS.filter(function (Ly) { return S.vis[Ly[0]]; }); }
  function stripLag(ls) { var m = 0; ls.forEach(function (Ly) { m = Math.max(m, lag(Ly[0])); }); return m; }
  function stripsCheck() {
    var sig = strokeGen + '|' + pps + '|' + JSON.stringify(S.vis);
    if (sig !== stripsFor || stripsAna !== S.ana) {
      strips.forEach(function (s) { dropStrip(s); }); strips.clear(); stripsFor = sig; stripsAna = S.ana;
    }
  }
  /* strip canvases are reused: making a canvas costs far more than clearing one */
  function dropStrip(s) { if (s.c.parentNode) s.c.parentNode.removeChild(s.c); if (stripPool.length < 3) stripPool.push(s.c); }
  function stripAt(k) {
    var s = strips.get(k); if (s) return s;
    var w = Math.ceil(STRIP * dpr), h = Math.ceil(H * dpr), c = null;
    for (var i = stripPool.length - 1; i >= 0; i--) if (stripPool[i].width === w && stripPool[i].height === h) { c = stripPool.splice(i, 1)[0]; break; }
    if (!c) { c = document.createElement('canvas'); c.width = w; c.height = h; }
    else { var g0 = c.getContext('2d'); g0.setTransform(1, 0, 0, 1, 0, 0); g0.globalCompositeOperation = 'source-over'; g0.clearRect(0, 0, w, h); }
    c.style.left = k * STRIP + 'px'; c.style.width = STRIP + 'px'; stripRow.appendChild(c);
    s = { c: c, done: 0 }; strips.set(k, s); return s;
  }
  /* chunk g of the whole print covers the time from g * CHUNK / pps; it is drawn once its strip has done it */
  function chunkReady(g) { var s = strips.get(Math.floor(g / PER)); return !!s && s.done > g % PER; }
  /* the next chunk of strip k, drawn as the print stands at nowV */
  function renderChunk(k, ls, lagS) {
    var s = stripAt(k), j = s.done, sa = k * STRIP / pps, ca = sa + j * CHUNK / pps, nowV = ca + CHUNK / pps + lagS;
    var g = s.c.getContext('2d'), keep = [ctx, nowX, WIN];
    ctx = g; nowX = (nowV - sa) * pps;
    g.save();
    try {
      g.setTransform(dpr, 0, 0, dpr, 0, 0); g.beginPath(); g.rect(j * CHUNK, 0, CHUNK, H); g.clip();
      g.globalCompositeOperation = 'multiply';
      ls.forEach(function (Ly) { WIN = nowV - ca + look(Ly[0]); Ly[1](nowV, { guitar: 0, piano: 0, synths: 0 }); });
    } finally { g.restore(); ctx = keep[0]; nowX = keep[1]; WIN = keep[2]; }
    s.done++;
  }
  /* draw what the screen needs and some way ahead, place the row, and say from what time on it must be drawn live */
  var rowX = null, viewW = null;
  function printStrips(now, ls) {
    var lagS = stripLag(ls), cutT = now - lagS, tL = Math.max(0, now - (nowX + 40) / pps), cpp = CHUNK / pps;
    var gL = Math.floor(tL / cpp), gC = Math.floor(cutT / cpp), gA = gC + PER / 2, g, k, t0 = performance.now();
    /* chunks in order from the left edge (the screen's first, then ahead), within 4 ms a frame; a strip is drawn from
       its start, so a chunk waits for those before it in its strip */
    for (g = gL; g <= gA; g++) {
      if (chunkReady(g)) continue;
      if (performance.now() - t0 > 4) break;
      k = Math.floor(g / PER);
      while (stripAt(k).done <= g % PER && performance.now() - t0 <= 4) renderChunk(k, ls, lagS);
    }
    /* the drawn part reaches from the left edge as far as its chunks are done, and never past cutT */
    var readyT = tL;
    for (g = gL; g <= gC && chunkReady(g); g++) readyT = Math.min(cutT, (g + 1) * cpp);
    var rx = Math.round(xOf(0, now) * dpr) / dpr, vw = readyT > tL ? Math.max(0, Math.round(xOf(readyT, now) * dpr) / dpr) : 0;
    if (rx !== rowX) { rowX = rx; stripRow.style.transform = 'translateX(' + rx + 'px)'; }
    if (vw !== viewW) { viewW = vw; stripView.style.width = vw + 'px'; }
    /* strips scrolled off, or far from here after a seek, are let go */
    var kL = Math.floor(gL / PER), kA = Math.floor(gA / PER);
    strips.forEach(function (s, kk) { if (kk < kL || kk > kA) { strips.delete(kk); dropStrip(s); } });
    return readyT;
  }

  /* what moves without repainting: the sheet's tilt and shake, and the bass and kick glows (CSS, composited) */
  var lastTf = '', lastSf = '', glowCol = ['', ''], glowA = [-1, -1], lastGrain = -1, baseFor = null, lastXr = null, liveMode = null;
  function setGlow(el, i, col, a) {
    a = Math.round(a * 200) / 200;
    if (a !== glowA[i]) { glowA[i] = a; el.style.visibility = a > 0 ? 'visible' : 'hidden'; if (a > 0) el.style.opacity = String(a); }
    if (a > 0 && col !== glowCol[i]) { glowCol[i] = col; el.style.background = 'linear-gradient(to top, ' + rgba(col, 1) + ' 0, ' + rgba(col, 1) + ' 30px, ' + rgba(col, 0) + ' 100%)'; }
  }
  /* the paper and pitch lines, drawn again only when they change */
  function drawBase() {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1;
    ctx.fillStyle = C.paper; ctx.fillRect(0, 0, W, H);
    drawGuides();
  }
  function draw(now) {
    var a = S.ana;
    var gr = DBG.grain ? L.grain : 0;
    if (gr !== lastGrain) { lastGrain = gr; grainCv.style.opacity = String(gr); grainCv.style.display = gr > 0 ? '' : 'none'; }
    if (!a) {
      drawBase(); baseFor = null; setMode(true);
      setGlow(glowBass, 0, '', 0); setGlow(glowKick, 1, '', 0);
      if (lastSf) { lastSf = ''; shakeEl.style.transform = ''; }
      if (lastTf) { lastTf = ''; sheet.style.transform = ''; }
      return;
    }
    strokeCacheCheck();
    var fi = clamp(Math.floor(now / a.dt), 0, a.frames - 1);
    var bassNow = a.bassN[fi] || 0, kickImp = impulse(S.kicks, now, 14), snImp = impulse(S.snares, now, 18), hatImp = impulse(S.hats, now, 22);
    var lv = { guitar: 0, piano: 0, synths: 0 };
    var amp = (DBG.shake ? L.shake : 0) * ((S.vis.bass ? bassNow * bassNow * 5 : 0) + (S.vis.kick ? kickImp * 9 : 0) + (S.vis.snare ? snImp * 2 : 0));
    var ox = amp * (Math.sin(now * 53.1) + 0.7 * Math.sin(now * 31.7 + 1.3)) / 1.7, oy = amp * (Math.sin(now * 47.3 + 2.1) + 0.7 * Math.sin(now * 29.9 + 0.4)) / 1.7, rot = amp * 0.0022 * Math.sin(now * 37.7 + 0.9);
    var sf = amp > 0.01 ? 'translate(' + ox.toFixed(2) + 'px,' + oy.toFixed(2) + 'px) rotate(' + rot.toFixed(5) + 'rad)' : '';
    if (sf !== lastSf) { lastSf = sf; shakeEl.style.transform = sf; }
    /* tilt: the sheet tips back on each kick and leans with the bass */
    var rx = L.tilt * (9 * Math.min(1, kickImp) + 3 * bassNow), rz = L.tilt * 1.4 * bassNow * Math.sin(now * 1.3), tf = L.tilt > 0 && DBG.tilt ? 'perspective(700px) rotateX(' + rx.toFixed(2) + 'deg) rotate(' + rz.toFixed(2) + 'deg)' : '';
    if (tf !== lastTf) { lastTf = tf; sheet.style.transform = tf; }
    setGlow(glowBass, 0, tint('bass', a.bassHz[fi] || 55, H), DBG.glows && S.vis.bass && bassNow > 0.05 ? inkA(0.2 * Math.pow(bassNow, 1.5)) : 0);
    /* the thud is felt as much as seen: the low end of the sheet darkens for a moment on each kick */
    setGlow(glowKick, 1, tint('drum', 50, H), DBG.glows && S.vis.kick && L.pulse > 0 && kickImp > 0.02 ? Math.min(0.3, 0.22 * L.pulse * kickImp) : 0);

    if (panelOpen() || DBG.live || (BENCH && BENCH_LIVE)) {
      /* the Lab is open: everything live on #cv, so a lever shows at once, with each colour's misprint slip */
      setMode(true); baseFor = null;
      var misAmt = L.slip * (kickImp * 2.4 + bassNow * 1.1);
      drawBase();
      ctx.globalCompositeOperation = 'multiply';
      LAYERS.forEach(function (Ly) {
        var name = Ly[0]; if (!S.vis[name]) return;
        ctx.save(); ctx.translate(DIRS[name][0] * misAmt, DIRS[name][1] * misAmt);
        if (BENCH) benchLayer(name, function () { Ly[1](now, lv); }); else Ly[1](now, lv);
        ctx.restore();
      });
      ctx.globalCompositeOperation = 'source-over';
    } else {
      setMode(false);
      if (baseFor !== strokeGen) { drawBase(); baseFor = strokeGen; }
      stripsCheck();
      var ls = stripLayers(), readyT = now, keepW = WIN;
      if (BENCH) benchLayer('strips', function () { readyT = printStrips(now, ls); }); else readyT = printStrips(now, ls);
      /* live: the stretch the strips do not cover yet, on its own canvas, cleared from wherever it began last time */
      var xr = Math.round(xOf(readyT, now) * dpr) / dpr;
      /* narrow: the live canvas only as wide as the live stretch (from a little left of it to the right edge) */
      var lx = DBG.narrow ? Math.max(0, Math.floor(Math.min(xr, nowX - stripLag(ls) * pps) - 8)) : 0;
      if (lx !== liveLx) {
        liveLx = lx; lastXr = null;
        liveCv.style.left = lx ? lx + 'px' : ''; liveCv.style.width = lx ? W - lx + 'px' : '';
        liveCv.width = Math.round((W - lx) * dpr); liveCv.height = Math.round(H * dpr);
      }
      var lxd = Math.round(lx * dpr), xc = Math.max(0, Math.floor(Math.min(xr, lastXr === null ? 0 : lastXr) * dpr) - 2 - lxd);
      lastXr = xr;
      liveCv.style.visibility = DBG.nolive ? 'hidden' : '';
      var cvs = ctx;
      ctx = liveCtx;
      try {
        ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1;
        ctx.clearRect(xc, 0, liveCv.width - xc, liveCv.height);
        if (DBG.nolive) ls = [];
        ctx.setTransform(dpr, 0, 0, dpr, -lxd, 0); ctx.globalCompositeOperation = 'multiply';
        ctx.save(); ctx.beginPath(); ctx.rect(xr, -80, W - xr + 80, H + 160); ctx.clip(); clipL = xr;
        ls.forEach(function (Ly) {
          WIN = Math.min(keepW, now - readyT + look(Ly[0]));
          if (BENCH) benchLayer('l:' + Ly[0], function () { Ly[1](now, lv); }); else Ly[1](now, lv);
        });
      } finally { WIN = keepW; clipL = -Infinity; ctx.restore(); ctx.globalCompositeOperation = 'source-over'; ctx = cvs; }
    }

    var lead = a.leadHz[fi] > 0 ? a.leadN[fi] : 0, wordHit = 0;
    if (S.words.length) { var wi = lowerBound(S.words, now - 0.3, 't'); if (wi < S.words.length && S.words[wi].t <= now) wordHit = 1 - (now - S.words[wi].t) / 0.3; }
    setMeter('bass', bassNow); setMeter('kick', kickImp); setMeter('snare', snImp); setMeter('hats', hatImp);
    setMeter('voice', lead); setMeter('guitar', lv.guitar); setMeter('piano', lv.piano); setMeter('synths', lv.synths); setMeter('words', wordHit);
  }
  /* all on #cv (the Lab open, or no song), or the strips and the live canvas over the paper */
  function setMode(onCv) {
    if (liveMode === !onCv) return;
    liveMode = !onCv; lastXr = null;
    stripView.style.display = liveCv.style.display = onCv ? 'none' : '';
    if (!onCv) { liveCtx.setTransform(1, 0, 0, 1, 0, 0); liveCtx.clearRect(0, 0, liveCv.width, liveCv.height); }
  }

  /* ------------------------------------------------------------ lyrics */
  /* singing fonts: each word is set in the chosen face, and (Follows voice) sized and weighted by how loudly it was
     sung, using the variable fonts' weight axis */
  var FONTS = {
    grotesque: { fam: '"Bricolage Grotesque", "Avenir Next", system-ui, sans-serif', w: [420, 800], sc: 1, st: '' },
    script: { fam: '"Caveat", "Segoe Print", cursive', css: 'Caveat:wght@400..700', w: [420, 700], sc: 1.38, st: '' },
    serif: { fam: '"Fraunces", Georgia, serif', css: 'Fraunces:ital,opsz,wght@1,9..144,300..900', w: [330, 860], sc: 1.08, st: 'italic ' },
    mono: { fam: '"DM Mono", ui-monospace, Menlo, monospace', w: [400, 500], sc: 0.94, st: '' }
  };
  function ensureFont(key) {
    var f = FONTS[key] || FONTS.grotesque;
    if (!f.css) return Promise.resolve();
    if (!f.ready) {
      f.ready = new Promise(function (resolve) {
        var l = document.createElement('link'); l.rel = 'stylesheet'; l.href = 'https://fonts.googleapis.com/css2?family=' + f.css + '&display=block';
        l.onload = function () { (document.fonts ? document.fonts.load(f.st + f.w[1] + ' 16px ' + f.fam.split(',')[0]) : Promise.resolve()).then(resolve, resolve); };
        l.onerror = resolve; document.head.appendChild(l);
      });
    }
    return f.ready;
  }
  function wordFont(n) {
    var f = FONTS[L.font] || FONTS.grotesque, v = L.wordSize === 'voice' ? clamp(n, 0, 1) : 0.45;
    var size = (L.wordSize === 'voice' ? 10.5 + 9 * v : 13) * f.sc, wt = Math.round(f.w[0] + (f.w[1] - f.w[0]) * v);
    return { css: f.st + wt + ' ' + size.toFixed(1) + 'px ' + f.fam, size: size };
  }
  function layoutWords() {
    if (!S.words.length || !S.ana || !H) return;
    ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0);
    var boxes = [], lastY = yOf(S.medHz) - 16, lastHz = S.medHz;
    /* (each word's box: its width and its ink above and below the baseline) */
    S.words.forEach(function (w) {
      var f = voiceAt(w.t), n = f >= 0 ? S.ana.leadN[f] : 0.35, ft = wordFont(n);
      w.font = ft.css; w.lh = ft.size + 1; ctx.font = w.font;
      var tm = ctx.measureText(w.text);
      w.px = tm.width; w.asc = tm.actualBoundingBoxAscent || ft.size * 0.75; w.desc = tm.actualBoundingBoxDescent || ft.size * 0.22;
      /* at the pitch it is sung: just above the voice line at the word's vowel */
      if (f >= 0) { w.hz = S.ana.leadHz[f]; w.y = yOf(w.hz) - (0.8 + 8.5 * S.ana.leadN[f]) * L.weight - 5; lastY = w.y; lastHz = w.hz; } else { w.y = lastY; w.hz = lastHz; }
      var top = BEAT_H + 6, bottom = H - 8;
      w.y = clamp(w.y, top + w.asc, bottom - w.desc);
      /* never print over another word: try the height it is sung at, then a step at a time upward, then downward,
         until it clears every word near it on the sheet */
      var X0 = w.t * pps, X1 = X0 + w.px, step = Math.max(6, w.lh * 0.55), yy, k;
      function clash(y) {
        for (var b = boxes.length - 1; b >= 0; b--) {
          var bx = boxes[b];
          if (bx.X0 < X0 - 600) break;
          if (bx.X1 + 4 > X0 && bx.X0 < X1 + 4 && bx.top < y + w.desc + 1 && bx.bot > y - w.asc - 1) return true;
        }
        return false;
      }
      var tries = [];
      for (yy = w.y; yy - w.asc >= top; yy -= step) tries.push(yy);
      for (yy = w.y + step; yy + w.desc <= bottom; yy += step) tries.push(yy);
      w.yy = w.y;
      for (k = 0; k < tries.length; k++) if (!clash(tries[k])) { w.yy = tries[k]; break; }
      boxes.push({ X0: X0, X1: X1, top: w.yy - w.asc, bot: w.yy + w.desc });
    });
    ctx.restore();
  }
  function applyWordTimes(lines, wt) {
    S.lines = lines; S.wt = wt; S.words = [];
    lines.forEach(function (ln, li) {
      ln.words.forEach(function (w, wi) { var t = wt[li] && wt[li][wi]; if (t != null && isFinite(t)) S.words.push({ t: t, text: w.text, li: li, wi: wi }); });
    });
    S.words.sort(function (a, b) { return a.t - b.t; });
    S.lineStarts = wt.map(function (l) { for (var i = 0; l && i < l.length; i++) if (l[i] != null) return l[i]; return null; });
    layoutWords(); S.dirty = true;
  }
  /* the demo song's words are placed on its voice here; every other song's words come from the server, timed */
  function placeLyrics(text) {
    var lines = DSP.parseLyrics(text);
    applyWordTimes(lines, lines.length ? DSP.alignLyrics(lines, S.ana) : []);
  }
  cv.addEventListener('click', function () {
    if (hud.classList.contains('away')) wakeHud(); else if (playing()) setAway(true);
  });

  /* ------------------------------------------------------------ audio + clock */
  var dispT = 0, lastA = -1, lastP = 0, seeking = false;
  function clock() {
    var a = audio.currentTime || 0, p = performance.now();
    if (audio.paused || audio.ended) { dispT = a; lastA = a; lastP = p; return a; }
    if (a !== lastA) { lastA = a; lastP = p; }
    var est = lastA + (p - lastP) / 1000 * (audio.playbackRate || 1);
    dispT = Math.abs(est - dispT) > 0.35 ? est : Math.max(dispT, est);
    return Math.min(dispT, S.dur || dispT);
  }
  function setIcons() { var playing = !audio.paused && !audio.ended; $('icoPlay').hidden = playing; $('icoPause').hidden = !playing; playBtn.setAttribute('aria-label', playing ? 'Pause' : 'Play'); $('labPlay').textContent = playing ? 'Pause' : 'Play'; }
  function setPlayable(on) { playBtn.disabled = !on; $('labPlay').disabled = !on; }
  function playAudio() {
    var p = audio.play();
    if (p && p.catch) p.catch(function () { say('Playback was blocked. Tap play again.', true); });
  }
  function togglePlay() {
    if (audio.paused || audio.ended) {
      if (S.neverPlayed) { S.neverPlayed = false; }
      if (audio.ended) audio.currentTime = 0;
      playAudio();
    } else audio.pause();
  }
  playBtn.addEventListener('click', togglePlay);
  var hud = $('hud'), cog = $('labBtn'), labPanel = $('labPanel'), hudTimer = null;
  function playing() { return !audio.paused && !audio.ended; }
  function panelOpen() { return !labPanel.hidden; }
  /* the controls and the cog come and go together */
  function setAway(on) { hud.classList.toggle('away', on); cog.classList.toggle('away', on); }
  function wakeHud() {
    clearTimeout(hudTimer);
    if (panelOpen()) { setAway(true); return; }
    setAway(false);
    if (playing()) hudTimer = setTimeout(function () { if (playing() && !keyboardIn(hud) && !keyboardIn(cog)) setAway(true); }, 2600);
  }
  /* a control reached from the keyboard keeps the controls up; one that was just tapped does not */
  function keyboardIn(el) {
    var a = document.activeElement;
    try { return !!a && el.contains(a) && a.matches(':focus-visible'); } catch (e) { return false; }
  }
  ['pointerdown', 'focusin', 'input'].forEach(function (ev) { hud.addEventListener(ev, wakeHud); cog.addEventListener(ev, wakeHud); });
  plate.addEventListener('mousemove', function (e) { if (e.movementX || e.movementY) wakeHud(); });
  ['play', 'pause', 'ended'].forEach(function (ev) { audio.addEventListener(ev, function () { setIcons(); S.dirty = true; wakeHud(); }); });
  audio.addEventListener('seeked', function () { S.dirty = true; });
  audio.addEventListener('error', function () { if (audio.src) say("Can't play that file here.", true); });
  /* two seek bars, the page's and the Lab drawer's, kept in step */
  [seek, labSeek].forEach(function (bar) {
    bar.addEventListener('pointerdown', function () { seeking = true; });
    bar.addEventListener('pointerup', function () { seeking = false; });
    bar.addEventListener('change', function () { seeking = false; });
    bar.addEventListener('input', function () {
      if (S.neverPlayed) { S.neverPlayed = false; }
      var v = parseFloat(bar.value); (bar === seek ? labSeek : seek).value = bar.value;
      audio.currentTime = v; dispT = v; tNow.textContent = fmt(dispT); S.dirty = true;
    });
  });
  document.addEventListener('keydown', function (e) {
    if (e.code !== 'Space' || /^(TEXTAREA|INPUT|BUTTON|SUMMARY)$/.test(e.target.tagName) || playBtn.disabled) return;
    e.preventDefault(); togglePlay();
  });
  var currentURL = null;
  function setAudioSrc(url) { audio.pause(); if (currentURL) URL.revokeObjectURL(currentURL); currentURL = url; audio.src = url; audio.load(); }

  /* Lab > Frame times: the time between frames while playing, and the part of it spent drawing, over the last 120 */
  var frameT = [], drawT = [], lastTs = 0, frameN = 0;
  function pct(v, q) { var o = v.slice().sort(function (x, y) { return x - y; }); return o[Math.min(o.length - 1, Math.floor(o.length * q))]; }
  function loop(ts) {
    var playing = !audio.paused && !audio.ended;
    if ((playing || S.dirty) && !speedRun) {
      var t = S.neverPlayed ? S.previewT : clock(), t0 = performance.now();
      draw(t); S.dirty = false;
      var dt = performance.now() - t0;
      if (!seeking && !S.neverPlayed) { seek.value = labSeek.value = String(t); tNow.textContent = fmt(t); }
      if (L.fps === 'on' && playing) {
        if (lastTs) { frameT.push(ts - lastTs); drawT.push(dt); if (frameT.length > 120) { frameT.shift(); drawT.shift(); } }
        lastTs = ts;
        if (++frameN % 30 === 0 && frameT.length >= 10) fpsEl.textContent = 'frame ' + pct(frameT, 0.5).toFixed(1) + ' ms, slowest 5% ' + pct(frameT, 0.95).toFixed(1) + '\ndrawing ' + pct(drawT, 0.5).toFixed(1) + ' ms, slowest 5% ' + pct(drawT, 0.95).toFixed(1);
      } else lastTs = 0;
    }
    if (!speedRun && fpsEl.hidden !== (L.fps !== 'on')) { fpsEl.hidden = L.fps !== 'on'; fpsEl.textContent = 'frame times show while it plays'; frameT = []; drawT = []; }
    requestAnimationFrame(loop);
  }

  /* ---- Lab > Speed test: the next 10 s of the song (from where it is), silent, drawn once through with each piece
     of the stack turned off in turn, then a JSON of the frame times to paste back. Every run plays the same 10 s, so
     the runs compare. */
  /* test 1 (Pixel 9 Pro): blend modes, grain, glows, tilt and shake made no difference; half resolution took it from
     66 ms a frame to 16.7. Test 2 looks for where the cliff is and which canvas is too big. */
  var SPEED = [
    ['as now', {}],
    ['resolution 1.75', { dpr: 1.75 }],
    ['resolution 1.5', { dpr: 1.5 }],
    ['resolution 1.25', { dpr: 1.25 }],
    ['resolution 1', { dpr: 1 }],
    ['narrow live canvas', { narrow: true }],
    ['no live canvas', { nolive: true }],
    ['strips not shown', { nostrips: true }],
    ['strips 512 wide', { strip: 512 }],
    ['narrow live, strips 512', { narrow: true, strip: 512 }],
    ['nothing drawn: the phone alone', { still: true }]
  ];
  var speedRun = false;
  /* the screen stays on while a song plays or the speed test runs (the browser lets go when the page is hidden) */
  var wake = null, waking = false;
  function holdScreen(on) {
    if (on && !wake && !waking && navigator.wakeLock && document.visibilityState === 'visible') {
      waking = true;
      navigator.wakeLock.request('screen').then(function (w) { waking = false; wake = w; w.addEventListener('release', function () { wake = null; }); }, function () { waking = false; });
    }
    if (!on && wake) { wake.release(); wake = null; }
  }
  ['play', 'pause', 'ended'].forEach(function (ev) { audio.addEventListener(ev, function () { holdScreen(speedRun || playing()); }); });
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') holdScreen(speedRun || playing()); });
  function setDbg(o) {
    var d = DBG.dpr;
    DBG = Object.assign({}, DBG_DEF, o);
    [stripView, liveCv, glowBass, glowKick].forEach(function (el) { el.style.mixBlendMode = DBG.blend ? '' : 'normal'; });
    stripView.style.visibility = DBG.nostrips ? 'hidden' : '';
    if (DBG.strip !== STRIP) { STRIP = DBG.strip; PER = STRIP / CHUNK; stripsFor = ''; }
    if (DBG.dpr !== d) resize();
    S.dirty = true;
  }
  function stats(v) {
    var o = v.slice().sort(function (x, y) { return x - y; }), q = function (f) { return +o[Math.min(o.length - 1, Math.floor(o.length * f))].toFixed(1); };
    return o.length ? { median: q(0.5), p95: q(0.95), p99: q(0.99), max: +o[o.length - 1].toFixed(1) } : null;
  }
  function speedTest() {
    if (!S.ana || speedRun) return;
    audio.pause(); closePanels(); clearTimeout(hudTimer); setAway(true);
    var T0 = Math.max(0, Math.min(clock(), (S.dur || 10) - 10)), i = -1, start = 0, last = 0, ft = [], dts = [];
    var diff = {}; for (var k in L) if (L[k] !== LAB_DEF[k]) diff[k] = L[k];
    var out = {
      test: 'pitchscape speed test 2', when: new Date().toISOString(),
      device: { ua: navigator.userAgent, dpr: window.devicePixelRatio, cores: navigator.hardwareConcurrency || null, memoryGB: navigator.deviceMemory || null },
      print: { css: W + 'x' + H, px: cv.width + 'x' + cv.height, secondsShown: +WIN.toFixed(2), from: +T0.toFixed(2), to: +(T0 + 10).toFixed(2), lab: diff,
        hidden: Object.keys(S.vis).filter(function (k) { return !S.vis[k]; }) },
      runs: []
    };
    speedRun = true; fpsEl.hidden = false; holdScreen(true);
    function next() {
      if (++i >= SPEED.length) return finish();
      setDbg(SPEED[i][1]); start = 0; last = 0; ft = []; dts = [];
      fpsEl.textContent = 'speed test ' + (i + 1) + ' of ' + SPEED.length + ': ' + SPEED[i][0];
      requestAnimationFrame(step);
    }
    function step(ts) {
      if (!start) start = ts;
      var el = (ts - start) / 1000, d = 0;
      if (!DBG.still) { var t0 = performance.now(); draw(T0 + Math.min(el, 10)); d = performance.now() - t0; }
      /* the first half second settles (strips drawn, layers made) and is not counted */
      if (el > 0.5 && last) { ft.push(ts - last); dts.push(d); }
      last = ts;
      if (el < 10.5) return requestAnimationFrame(step);
      var slow = ft.filter(function (x) { return x > 34; }).length;
      if (!i) { out.print.css = W + 'x' + H; out.print.px = cv.width + 'x' + cv.height; }
      out.runs.push({ run: SPEED[i][0], frames: ft.length, frameMs: stats(ft), drawMs: DBG.still ? null : stats(dts), over2frames: +(slow / Math.max(1, ft.length)).toFixed(3) });
      next();
    }
    function finish() {
      setDbg({}); speedRun = false; fpsEl.hidden = L.fps !== 'on'; S.dirty = true; wakeHud(); holdScreen(playing());
      showSpeed(JSON.stringify(out));
    }
    next();
  }
  function showSpeed(json) {
    var box = document.createElement('div'); box.className = 'speedout'; box.setAttribute('role', 'dialog'); box.setAttribute('aria-label', 'Speed test results');
    box.innerHTML = '<p>Speed test done. Copy this and paste it to Claude.</p><textarea readonly aria-label="Results"></textarea><div class="speedbtns"><button class="btn btn-small" type="button">Copy</button><button class="btn btn-small btn-quiet" type="button">Close</button></div>';
    var ta = box.querySelector('textarea'), bs = box.querySelectorAll('button');
    ta.value = json;
    bs[0].addEventListener('click', function () {
      var done = function () { bs[0].textContent = 'Copied'; };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(json).then(done, function () { ta.select(); });
      else { ta.select(); document.execCommand('copy'); done(); }
    });
    bs[1].addEventListener('click', function () { box.remove(); });
    plate.appendChild(box); bs[0].focus();
  }
  $('speedTest').addEventListener('click', speedTest);

  /* ------------------------------------------------------------ analysis jobs */
  var worker = null, workerReady = null, workerFailed = false;
  function ensureWorker() {
    if (workerFailed) return Promise.resolve(null);
    if (workerReady) return workerReady;
    workerReady = new Promise(function (resolve) {
      var w;
      try { w = new Worker(URL.createObjectURL(new Blob([$('dsp').textContent], { type: 'text/javascript' }))); }
      catch (e) { workerFailed = true; resolve(null); return; }
      var to = setTimeout(function () { try { w.terminate(); } catch (e) { /* ignore */ } workerFailed = true; resolve(null); }, 4000);
      w.onmessage = function (e) { if (e.data && e.data.type === 'pong') { clearTimeout(to); worker = w; resolve(w); } };
      w.onerror = function (e) { if (e && e.preventDefault) e.preventDefault(); clearTimeout(to); workerFailed = true; resolve(null); };
      w.postMessage({ cmd: 'ping' });
    });
    return workerReady;
  }
  function cancelJobs() { if (worker) { worker.terminate(); worker = null; workerReady = null; } }
  function runJob(msgData, transfer, onProgress) {
    return ensureWorker().then(function (w) {
      if (!w) {
        return new Promise(function (resolve) { setTimeout(resolve, 40); }).then(function () { var d = DSP.synthDemo(44100); return { L: d.L, R: d.R, sr: d.sr }; });
      }
      return new Promise(function (resolve, reject) {
        w.onmessage = function (e) {
          var d = e.data;
          if (d.type === 'progress') { if (onProgress) onProgress(d.label, d.p); }
          else if (d.type === 'error') reject(new Error(d.message));
          else if (d.type === 'demo' || d.type === 'done') resolve(d);
        };
        w.onerror = function (e) { reject(new Error((e && e.message) || 'The analysis stopped.')); };
        w.postMessage(msgData, transfer);
      });
    });
  }

  /* a song loading (Progress.svelte): what is happening, how far, a short note, and the analysis's steps so far */
  function showStatus(label, p, note) {
    var was = ui.status || { note: '', steps: null };
    ui.status = { label: label, p: clamp(p, 0, 1), note: note !== undefined ? note || '' : was.note, song: $('trackName').textContent || '', steps: was.steps };
  }
  function hideStatus() { ui.status = null; }
  /* each step inked once it has started, the latest turning; the model download is a step only when analysing here */
  var STEPS = [['models', 'models'], ['stems', 'stems'], ['drums', 'drums'], ['notes', 'notes'], ['bass', 'bass'], ['voice', 'voice'], ['words', 'lyrics'], ['tone', 'tone'], ['width', 'width']];
  function showStep(key, here) {
    if (!ui.status) return;
    var seen = {}, was = ui.status.steps || [];
    was.forEach(function (s) { if (s.state) seen[s.k] = true; });
    if (key) seen[key] = true;
    ui.status.steps = STEPS.filter(function (st) { return st[0] !== 'models' || here || seen.models; }).map(function (st) {
      return { k: st[0], label: st[1], state: st[0] === key ? 'now' : seen[st[0]] ? 'on' : '' };
    });
  }

  function wavBlob(L, R, sr) {
    var n = L.length, buf = new ArrayBuffer(44 + n * 4), v = new DataView(buf), o = 44, i;
    function w(off, s) { for (var k = 0; k < s.length; k++) v.setUint8(off + k, s.charCodeAt(k)); }
    w(0, 'RIFF'); v.setUint32(4, 36 + n * 4, true); w(8, 'WAVE'); w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 2, true);
    v.setUint32(24, sr, true); v.setUint32(28, sr * 4, true); v.setUint16(32, 4, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, n * 4, true);
    for (i = 0; i < n; i++, o += 4) { v.setInt16(o, clamp(L[i], -1, 1) * 32767, true); v.setInt16(o + 2, clamp(R[i], -1, 1) * 32767, true); }
    return new Blob([buf], { type: 'audio/wav' });
  }
  var loadSeq = 0;
  /* the sheet goes blank while a song loads: nothing is drawn until the server's analysis of it is in */
  function beginLoad(label, songId) {
    S.song = songId || ''; S.retry = null;
    if (S.busy) cancelJobs();
    S.busy = true; audio.pause(); setPlayable(false);
    S.ana = null; S.dur = 0; S.neverPlayed = true; S.previewT = 0; applyWordTimes([], []);
    seek.value = labSeek.value = '0'; tNow.textContent = '0:00'; tDur.textContent = '0:00'; S.dirty = true;
    say(''); hideStatus(); showStatus(label, 0.01);
    return ++loadSeq;
  }
  function finishLoad(res, name, key, lyrics, previewT) {
    setAnalysis(res); S.name = name; S.key = key;
    $('trackName').textContent = name; tDur.textContent = fmt(res.dur); seek.max = labSeek.max = String(res.dur); seek.value = labSeek.value = '0'; tNow.textContent = '0:00';
    S.neverPlayed = previewT > 0; S.previewT = previewT;
    if (lyrics) placeLyrics(lyrics); else applyWordTimes([], []);
    hideStatus(); setPlayable(true); S.busy = false; S.dirty = true;
  }
  function loadDemo() {
    var my = beginLoad('Rendering the demo song', 'demo');
    $('trackName').textContent = 'Demo song';
    runJob({ cmd: 'demo' }, [], null).then(function (d) {
      if (my !== loadSeq) return;
      openSong(wavBlob(d.L, d.R, d.sr), 'pitchscape-demo.wav', 'Demo song', my, loadDemo, true);
    }).catch(function (e) { if (my === loadSeq) fail('The demo failed to render: ' + e.message); });
  }
  function loadFile(file) {
    var my = beginLoad('Opening ' + file.name, '');
    $('trackName').textContent = file.name;
    openSong(file, file.name, file.name.replace(/\.[^.]+$/, ''), my, function () { loadFile(file); }, false);
  }
  /* a song that didn't open leaves nothing to print: back to picking one, with the reason */
  function fail(text) { S.busy = false; hideStatus(); setPlayable(false); showSplash(); say(text, true); }
  /* a song by link: the server downloads it (a browser may not read another site's files) and keeps it, so the
     audio is played from the server once the analysis is in */
  function linkName(url) {
    try { var u = new URL(url), f = decodeURIComponent(u.pathname.split('/').pop() || ''); return f.replace(/\.[^.]+$/, '') || u.hostname; }
    catch (e) { return url; }
  }
  function loadLink(url, title) {
    var my = beginLoad('Fetching the song', '');
    title = title || linkName(url);
    $('trackName').textContent = title;
    /* analysed here, the page fetches the file itself, which only works where its site allows other pages to */
    if (whereNow() === 'here') {
      fetch(url).then(function (r) {
        if (!r.ok) throw new Error('That link answered ' + r.status + '.');
        return r.blob();
      }, function () {
        throw new Error('This page can\u2019t read that link itself (its site doesn\u2019t allow other pages to). Choose the server, which can, or download the file and load it.');
      }).then(function (blob) {
        if (my !== loadSeq) return;
        openSong(blob, linkName(url) + '.mp3', title, my, function () { loadLink(url, title); }, false);
      }).catch(function (e) { if (my === loadSeq) fail(e.message); });
      return;
    }
    var fd = new FormData(); fd.append('url', url);
    analyse(fd, null, my, 'Fetching the song').then(function (got) {
      if (!got || my !== loadSeq) return null;
      showStatus('Loading the audio', 0.97);
      return fetch(API + '/library/' + got.sha + '/audio', { headers: { 'X-Pitchscape-Key': serverKey() } }).then(function (r) {
        if (!r.ok) throw new Error("The server didn't send the song's audio (" + r.status + '). Open it again.');
        return r.blob();
      }, function () { throw new Error("Couldn't reach the server. Check the connection and open the song again."); }).then(function (blob) {
        if (my !== loadSeq) return;
        setAudioSrc(URL.createObjectURL(blob));
        finishLoad(packToRes(got.pack), songName(got.pack, title), 'sha:' + got.sha, null, 0); useServerLyrics(got.pack);
      });
    }).catch(function (e) {
      if (my !== loadSeq) return;
      fail((e && e.message) || "Couldn't open that link.");
      if (e && e.needsKey) { S.retry = function () { loadLink(url, title); }; ui.askKey++; }
    });
  }

  /* ------------------------------------------------------------ the analysis server
     Every song is drawn from the server's analysis (stems, drum transcription, notes, words) named in config.json,
     and nothing plays until it is in. A song is known by the SHA-256 of its file: analysed before, on this device
     or on the server from any device, it opens at once. Otherwise it is uploaded and analysed, once. */
  /* LOCAL: the page is served by server/local.py on this computer, which needs no key */
  var API = null, PIPELINE = '', LOCAL = false, apiReady = Promise.resolve(null);
  function serverKey() { return store.get('pitchscape:key') || (LOCAL ? 'local' : null); }
  try {
    apiReady = fetch('config.json', { cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : null; }).then(function (c) {
      API = c && c.api ? String(c.api).replace(/\/$/, '') : null; PIPELINE = c && c.pipeline ? String(c.pipeline) : ''; LOCAL = !!(c && c.local); return API;
    }, function () { return null; });
  } catch (e) { /* no config */ }
  /* where a song's analysis is kept on the device: a new version of the server's analysis starts afresh */
  function packKey(sha) { return 'pack:' + PIPELINE + ':' + sha; }
  /* only an analysis from the current pipeline (5, which writes pack version 8) is drawn: an older one lacks what the
     drawing needs, so the song is analysed again rather than drawn with stand-ins */
  function current(pack) { return !!(pack && pack.version >= 12 && pack.segStride === 17 && pack.bytes); }
  var idb = (function () {
    var dbp = null;
    function open() {
      if (!dbp) dbp = new Promise(function (res, rej) {
        try { var r = indexedDB.open('pitchscape', 1); r.onupgradeneeded = function () { r.result.createObjectStore('packs'); }; r.onsuccess = function () { res(r.result); }; r.onerror = function () { rej(r.error); }; }
        catch (e) { rej(e); }
      });
      return dbp;
    }
    function run(mode, fn) {
      return open().then(function (db) {
        return new Promise(function (res, rej) { var t = db.transaction('packs', mode), q = fn(t.objectStore('packs')); t.oncomplete = function () { res(q && q.result); }; t.onerror = function () { rej(t.error); }; });
      });
    }
    return {
      get: function (k) { return run('readonly', function (st) { return st.get(k); }).catch(function () { return null; }); },
      put: function (k, v) { return run('readwrite', function (st) { return st.put(v, k); }).catch(function () {}); }
    };
  })();
  var STAGES = [['stems', 'Splitting the song into stems', 0.2], ['drums', 'Reading the drums', 0.45], ['notes', 'Reading the notes', 0.55], ['tone', 'Listening for harsh sounds', 0.8], ['width', 'Measuring how wide each sound is', 0.82],
    ['bass', 'Following the bass', 0.65], ['voice', 'Following the voice', 0.75], ['words', 'Finding the lyrics', 0.85], ['done', 'Finishing', 0.95]];
  function stageOf(st) { for (var i = 0; st && i < STAGES.length; i++) if (st.indexOf(STAGES[i][0]) === 0) return STAGES[i]; return ['', 'Starting the server', 0.12]; }
  function sha256hex(buf) {
    if (!(window.crypto && crypto.subtle)) return Promise.resolve(null);
    return crypto.subtle.digest('SHA-256', buf).then(function (d) {
      return Array.prototype.map.call(new Uint8Array(d), function (b) { return (b < 16 ? '0' : '') + b.toString(16); }).join('');
    }, function () { return null; });
  }
  /* the analysis of a song, if it exists: on this device first, then on the server */
  function findPack(sha) {
    if (!sha) return Promise.resolve(null);
    return apiReady.then(function () {
      return idb.get(packKey(sha)).then(function (p) {
        if (p && current(p)) return p;
        var key = serverKey();
        if (!API || !key) return null;
        // a server slow to answer the lookup is not waited on for long; once it answers, the download is not cut off
        var ctl = window.AbortController ? new AbortController() : null, timer = ctl && setTimeout(function () { ctl.abort(); }, 4000);
        return fetch(API + '/packs/' + sha, { headers: { 'X-Pitchscape-Key': key }, signal: ctl ? ctl.signal : undefined }).then(function (r) { clearTimeout(timer); return r.ok ? r.json() : null; }).then(function (j) {
          if (j && j.pack && current(j.pack)) { idb.put(packKey(sha), j.pack); return j.pack; }
          return null;
        }, function () { return null; });
      });
    });
  }
  /* retry: how to load this song again, kept when a server key is what it waits for */
  function openSong(blob, fileName, title, my, retry, demo) {
    var sha = null;
    showStatus('Looking for this song', 0.03);
    blob.arrayBuffer().then(sha256hex).then(function (h) {
      sha = h;
      return my === loadSeq ? findPack(sha) : null;
    }).then(function (pack) {
      if (pack || my !== loadSeq) return pack;
      if (whereNow() === 'here') return analyseHere(blob, fileName, sha, my).then(function (got) { return got && got.pack; });
      var fd = new FormData(); fd.append('file', blob, fileName);
      return analyse(fd, sha, my, 'Uploading').then(function (got) { return got && got.pack; });
    }).then(function (pack) {
      if (!pack || my !== loadSeq) return;
      setAudioSrc(URL.createObjectURL(blob));
      if (demo) finishLoad(packToRes(pack), title, 'demo', DSP.DEMO_LYRICS, 16.9);
      else { finishLoad(packToRes(pack), songName(pack, title), sha ? 'sha:' + sha : 'file:' + fileName, null, 0); useServerLyrics(pack); }
      say('');
    }).catch(function (e) {
      if (my !== loadSeq) return;
      fail((e && e.message) || "Couldn't open that file.");
      if (e && e.needsKey) { S.retry = retry; ui.askKey++; }
    });
  }
  /* the song's name from its tags (title and artist), or the file's name when it has none */
  function songName(pack, fallback) {
    var sg = pack.song || {};
    return sg.title ? sg.title + (sg.artist ? ' \u00b7 ' + sg.artist : '') : fallback;
  }
  function keyError(text) { var e = new Error(text); e.needsKey = true; return e; }
  /* the song (a file or a link, in fd) analysed by the server: {pack, sha} */
  function analyse(fd, sha, my, label) {
    return apiReady.then(function () {
      var key = serverKey();
      if (!API) throw new Error('This page has no analysis server set up.');
      if (!key) throw keyError('Add the server key below and this song will be analysed.');
      showStatus(label, 0.05, 'first time only, a few minutes');
      return fetch(API + '/analyze', { method: 'POST', headers: { 'X-Pitchscape-Key': key }, body: fd }).then(function (r) {
        if (r.status === 401) throw keyError('The server key is wrong. Fix it below and this song will be analysed.');
        /* a link the server would not or could not fetch: its reason, in words */
        if (r.status === 400 || r.status === 413 || r.status === 502) return r.json().catch(function () { return {}; }).then(function (j) { throw new Error(j.detail || (r.status === 413 ? 'That file is over 80 MB.' : 'The server said ' + r.status + '.')); });
        if (!r.ok) throw new Error('The server said ' + r.status + '. Try again in a minute.');
        return r.json();
      }, function () { throw new Error("Couldn't reach the server. Check the connection and try again."); }).then(function (j) {
        sha = j.sha256 || sha;
        if (j.status === 'done') return j.pack;
        return new Promise(function (resolve, reject) {
          var asked = Date.now(), lastStage = '';
          function poll() {
            if (my !== loadSeq) { resolve(null); return; }
            /* a job that has not reported a stage in 8 minutes is not going to: say so rather than wait for ever */
            if (!lastStage && Date.now() - asked > 8 * 60 * 1000) { reject(new Error('The server never started on this song. Load it again in a minute.')); return; }
            fetch(API + '/jobs/' + encodeURIComponent(j.job) + '?key=' + encodeURIComponent(j.key), { headers: { 'X-Pitchscape-Key': key } }).then(function (r) { return r.json(); }).then(function (p) {
              if (my !== loadSeq) { resolve(null); return; }
              if (p.status === 'done' && p.pack) resolve(p.pack);
              else if (p.status === 'failed') reject(new Error('The analysis failed: ' + String(p.error || 'no reason given').replace(/\.?\s*$/, '.')));
              else { if (p.stage) lastStage = p.stage; var st = stageOf(p.stage); showStatus(st[1], st[2]); showStep(st[0]); setTimeout(poll, 3000); }
            }, function () { setTimeout(poll, 6000); });
          }
          showStatus('Starting the server', 0.1); setTimeout(poll, 2500);
        });
      });
    }).then(function (pack) {
      /* in the minutes while a new server deploys, the old one may still answer */
      if (pack && !current(pack)) throw new Error('The server is being updated. Load the song again in a few minutes.');
      if (pack && sha) idb.put(packKey(sha), pack);
      return pack ? { pack: pack, sha: sha } : null;
    });
  }
  /* ------------------------------------------------------------ where a song is analysed: here or on the server
     Here: the same analysis (src/pipeline) on this computer's graphics card, in a Worker; nothing is uploaded and no
     key is needed. The person chooses, on the splash or in Lab; what this computer has is read and said plainly. */
  var MODELS = 'https://huggingface.co/stopamertime/pitchscape-models/resolve/main/';
  var HERE = { done: false, ok: false, gpu: '', why: '', phone: false, tablet: false, mem: 0, cores: 0, mb: 0 };
  var hereReady = (function () {
    var ua = navigator.userAgent || '';
    HERE.phone = navigator.userAgentData ? !!navigator.userAgentData.mobile : /Android|iPhone|iPod|Mobile/i.test(ua);
    HERE.tablet = /iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
    HERE.mem = navigator.deviceMemory || 0; HERE.cores = navigator.hardwareConcurrency || 0;
    var sizes = fetch(MODELS + 'manifest.json', { cache: 'no-cache' }).then(function (r) { return r.ok ? r.json() : null; }).then(function (m) {
      // what an analysis here downloads (the manifest also holds the server's float32 files and other aligners)
      var b = 0; ['htdemucs_6s', 'adtof_frame_rnn', 'basic_pitch', 'crepe_full', 'align_en'].forEach(function (k) { b += (m && m[k] && m[k].bytes) || 0; });
      HERE.mb = Math.round(b / 1e6);
    }, function () {});
    /* why not, short enough for the card */
    var gpu = !navigator.gpu ? Promise.resolve(HERE.why = 'No WebGPU: use Chrome or Edge')
      : navigator.gpu.requestAdapter({ powerPreference: 'high-performance' }).then(function (ad) {
        if (!ad) { HERE.why = 'No usable graphics card'; return; }
        var info = ad.info || {};
        if (info.isFallbackAdapter || ad.isFallbackAdapter) { HERE.why = 'Software graphics only: too slow'; return; }
        HERE.gpu = gpuName(info.vendor, info.architecture);
        HERE.ok = true;
      }, function () { HERE.why = 'WebGPU would not start'; });
    return Promise.all([gpu, sizes]).then(function () { HERE.done = true; });
  })();
  /* WebGPU names the card's maker and design in lower case ('nvidia', 'rdna-3'): written as people know them */
  function gpuName(vendor, arch) {
    var V = { nvidia: 'NVIDIA', amd: 'AMD', intel: 'Intel', apple: 'Apple', qualcomm: 'Qualcomm', arm: 'Arm', microsoft: 'Microsoft' };
    var v = V[vendor] || (vendor ? vendor.charAt(0).toUpperCase() + vendor.slice(1) : '');
    var a = (arch || '').replace(/^(rdna|gcn|cdna|xe|gen)-?(.*)$/i, function (m, f, r) { return f.toUpperCase() + (r ? ' ' + r : ''); });
    if (a && a === (arch || '')) a = a.charAt(0).toUpperCase() + a.slice(1);
    return (v + (a ? ' ' + a : '')).trim() || 'a graphics card';
  }
  /* the person's choice; until they make one, here when this computer can and is not a phone or tablet */
  function whereNow() {
    var w = store.get('pitchscape:where');
    if (w === 'here' || w === 'server') return w;
    return HERE.ok && !HERE.phone && !HERE.tablet ? 'here' : 'server';
  }
  /* how long this computer took last time, per second of song (for an estimate before a song starts) */
  function hereRate() { var r = store.get('pitchscape:hereRate'); return r && r > 0 ? r : 0; }
  function fmtSecs(s) { return s < 90 ? Math.max(5, Math.round(s / 5) * 5) + ' s' : Math.round(s / 60) + ' min'; }
  /* what the where-cards (Where.svelte) show */
  function whereUI() {
    ui.where = whereNow(); ui.local = LOCAL; ui.hasKey = !!store.get('pitchscape:key');
    ui.here = { done: HERE.done, ok: HERE.ok, gpu: HERE.gpu, why: HERE.why, small: HERE.phone || HERE.tablet, mem: HERE.mem, cores: HERE.cores, mb: HERE.mb };
  }
  api.setWhere = function (w) { store.set('pitchscape:where', w); whereUI(); };
  whereUI(); hereReady.then(whereUI);

  /* the song analysed here: decoded by the browser (as it is played), then src/pipeline in a Worker. {pack, sha} */
  function analyseHere(blob, fileName, sha, my) {
    return hereReady.then(function () {
      if (!HERE.ok) throw new Error('This computer can’t analyse songs (' + HERE.why.toLowerCase() + '). Choose the server instead.');
      showStatus('Reading the audio', 0.02, ''); showStep('', true);
      return blob.arrayBuffer();
    }).then(function (buf) {
      return new OfflineAudioContext(2, 1, 44100).decodeAudioData(buf.slice(0)).then(function (ab) {
        return { buf: buf, mix: [ab.getChannelData(0).slice(), ab.getChannelData(Math.min(1, ab.numberOfChannels - 1)).slice()], dur: ab.duration };
      }, function () { throw new Error('This browser couldn’t read that file as audio.'); });
    }).then(function (a) {
      return new Promise(function (resolve, reject) {
        var w = new Worker(new URL('pipeline/analyse.worker.mjs', location.href), { type: 'module' });
        // the stages after the stems start together, so the bar never goes back; after the stems it moves by the time
        // a song took here before (hereRate), when there is one. A model downloading mid-way only changes the note.
        var t0 = performance.now(), tStems = 0, tAfter = 0, got = {}, fetched = false, started = false, label = '', p = 0, tick = 0;
        var secs = function () { return (performance.now() - t0) / 1000; };
        function show(l, q, note) { label = l; p = Math.max(p, q); showStatus(label, p, note); }
        function after() {
          var total = hereRate() * a.dur;
          if (!total || fetched) return;
          var left = total - secs();
          show(label, 0.55 + 0.4 * Math.min(0.98, (secs() - tAfter) / Math.max(1, total - tAfter)), left > 5 ? 'about ' + fmtSecs(left) + ' left' : 'nearly done');
        }
        function stop(v, e) { clearInterval(tick); w.terminate(); if (e) reject(e); else resolve(v); }
        w.onerror = function (ev) { stop(null, new Error('The analysis here stopped: ' + (ev.message || 'its worker would not start') + '. Choose the server instead.')); };
        w.onmessage = function (ev) {
          var m = ev.data;
          if (my !== loadSeq) { stop(null); return; }
          if (m.download) {
            fetched = true;
            got[m.download.name] = m.download;
            var a2 = 0, b2 = 0; for (var k in got) { a2 += got[k].got; b2 += got[k].total; }
            var mb = 'fetching models: ' + Math.round(a2 / 1e6) + ' / ' + Math.round(b2 / 1e6) + ' MB · once';
            if (started) showStatus(label, p, mb);
            else { show('Fetching the models', 0.02 + 0.08 * a2 / Math.max(1, b2), mb.replace('fetching models: ', '')); showStep('models', true); }
          } else if (m.progress) {
            started = true;
            var st = stageOf(m.progress), k2 = /^stems: (\d+)\/(\d+)/.exec(m.progress), note = '';
            if (k2) {
              var done = +k2[1], all = +k2[2];
              if (!tStems) tStems = performance.now();
              if (done >= 2) {
                var per = (performance.now() - tStems) / 1000 / (done - 1), left = per * (all - done);
                var total = hereRate() * a.dur;
                note = (total > secs() && !fetched ? 'about ' + fmtSecs(Math.max(left, total - secs())) : 'about ' + fmtSecs(left) + ' for this step') + ' left';
                if (left > 180) note += ' · the server may be quicker';
              }
              show(st[1], 0.1 + 0.45 * done / all, note);
            } else {
              if (!tAfter && st[0] && st[0] !== 'stems') { tAfter = secs(); tick = setInterval(after, 1000); }
              show(st[1], Math.min(st[2], 0.6));
              after();
            }
            showStep(st[0], true);
          } else if (m.pack) {
            // a run that downloaded models is not a measure of how long a song takes here
            if (!fetched) store.set('pitchscape:hereRate', secs() / Math.max(1, a.dur));
            stop(m.pack);
          } else if (m.error) stop(null, new Error('The analysis here failed: ' + m.error + ' Choose the server to analyse it there.'));
        };
        w.postMessage({ bytes: a.buf, name: fileName, mix: a.mix, models: MODELS }, [a.buf, a.mix[0].buffer, a.mix[1].buffer]);
      });
    }).then(function (pack) {
      if (pack && sha) idb.put(packKey(sha), pack);
      return pack ? { pack: pack, sha: sha } : null;
    });
  }
  function packToRes(pack) {
    var res = { dur: pack.dur, dt: pack.dt, frames: pack.frames, stereo: pack.stereo, noiseRef: pack.noiseRef };
    for (var k in pack.arrays) res[k] = b64f32(pack.arrays[k]);
    for (k in pack.bytes) res[k] = b64u8(pack.bytes[k]);
    res.segW = pack.segStride; res.evW = pack.eventStride; res.earDb = pack.earDb;
    return res;
  }
  /* the song's published lyrics (from LRCLIB, each word timed to the voice by the server). If LRCLIB hasn't got the
     song there are no words, and a line says why. */
  function useServerLyrics(pack) {
    var st = (pack.stats && pack.stats.lyrics) || {}, has = pack.lyrics && pack.lyrics.lines && pack.lyrics.lines.length;
    if (has) {
      var lines = pack.lyrics.lines.map(function (l) { return { text: l.text, words: l.words.map(function (w) { return { text: w[0], syl: Math.max(1, DSP.syllableCount(w[0])) }; }) }; });
      applyWordTimes(lines, pack.lyrics.lines.map(function (l) { return l.words.map(function (w) { return w[1]; }); }));
    } else {
      layoutWords();
      say(st.why === 'instrumental' ? '' : st.why === 'LRCLIB could not be reached' ? 'No words: the lyrics site was down when this song was analysed.'
        : st.artist && st.title ? 'No words: no published lyrics were found for ' + st.title + ' by ' + st.artist + ' at this length.'
        : "No words: this file doesn't name its artist and title, so its lyrics couldn't be looked up.");
    }
  }
  /* an array sent as bytes: lo + byte * (hi - lo) / 255 */
  function b64u8(o) {
    var bin = atob(o.data), out = new Float32Array(bin.length), k = (o.hi - o.lo) / 255;
    for (var i = 0; i < bin.length; i++) out[i] = o.lo + bin.charCodeAt(i) * k;
    return out;
  }
  function b64f32(b64) { var bin = atob(b64), u = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return new Float32Array(u.buffer); }
  /* the splash: pick a song. It opens first, and again from Change song; Back returns to the song that was open */
  /* (Splash.svelte) */
  function showSplash() { audio.pause(); closePanels(); ui.hasSong = !!S.ana; ui.splash = true; }
  function hideSplash() { ui.splash = false; say(''); wakeHud(); }
  $('changeSong').addEventListener('click', showSplash);
  api.back = function () { hideSplash(); playBtn.focus({ preventScroll: true }); };
  api.demo = function () { hideSplash(); loadDemo(); };
  api.link = function (url, title) { hideSplash(); loadLink(url, title); };
  api.file = function (f) { hideSplash(); loadFile(f); };
  api.say = say;

  /* ink toggles */
  document.querySelectorAll('.ink').forEach(function (b) {
    b.addEventListener('click', function () {
      var l = b.dataset.layer; S.vis[l] = !S.vis[l]; b.setAttribute('aria-pressed', String(S.vis[l]));
      S.dirty = true;
    });
  });

  /* lab */
  function labVal(k, v) {
    return k === 'secs' ? v.toFixed(1) + ' s' : k === 'ink' || k === 'weight' || k === 'drumK' ? '×' + v.toFixed(2)
      : k === 'vRun' || k === 'noteMin' ? Math.round(v) + ' ms' : k === 'rough0' ? v.toFixed(2) + ' asper' : k === 'sharp0' ? v.toFixed(2) + ' acum'
      : k === 'leap' ? v + ' st' : Math.round(v * 100) + '%';
  }
  var CUTS = { vConf: 1, vFloor: 1, vRun: 1, bFloor: 1, hold: 1, noteMin: 1, drumK: 1, rough0: 1, sharp0: 1 };
  function labUI() {
    labPanel.querySelectorAll('.seg[data-key]').forEach(function (g) {
      var k = g.dataset.key;
      g.querySelectorAll('button').forEach(function (b) { b.setAttribute('aria-pressed', String(String(L[k]) === b.dataset.v)); });
    });
    labPanel.querySelectorAll('input[type="range"][data-key]').forEach(function (r) {
      var k = r.dataset.key, v = k === 'secs' ? (L.secs > 0 ? L.secs : WIN) : L[k];
      r.value = String(v); $('lab-' + k + '-v').textContent = labVal(k, v);
    });
    var root = document.documentElement.style;
    root.setProperty('--drum', INKS.drum); root.setProperty('--c-synth', INKS.pluck);
    ['bass', 'voice', 'guitar', 'piano', 'words'].forEach(function (k) { root.setProperty('--c-' + k, INKS[k]); });
  }
  function labApply(k) {
    saveLab();
    if (CUTS[k] || k === 'all') { applyCuts(); layoutWords(); }
    if (k === 'secs' || k === 'all') resize();
    if (k === 'font' || k === 'wordSize' || k === 'weight' || k === 'all') ensureFont(L.font).then(function () { layoutWords(); S.dirty = true; });
    labUI(); S.dirty = true;
  }
  labPanel.querySelectorAll('.seg[data-key] button').forEach(function (b) {
    b.addEventListener('click', function () { var k = b.parentNode.dataset.key; L[k] = b.dataset.v; labApply(k); });
  });
  labPanel.querySelectorAll('input[type="range"][data-key]').forEach(function (r) {
    r.addEventListener('input', function () { var k = r.dataset.key; L[k] = parseFloat(r.value); labApply(k); });
  });
  $('labReset').addEventListener('click', function () { L = Object.assign({}, LAB_DEF); labApply('all'); });
  /* every detector followed as far down as its slider goes (the edges and lines levers are not about what is found) */
  $('labAll').addEventListener('click', function () {
    ['vConf', 'vFloor', 'vRun', 'bFloor', 'hold', 'noteMin', 'drumK'].forEach(function (k) { L[k] = parseFloat($('lab-' + k).min); });
    labApply('all');
  });
  /* the Lab, below the print (the print shrinks to sit above it), opened from the cog */
  function openPanel() { labPanel.hidden = false; S.dirty = true; cog.setAttribute('aria-expanded', 'true'); hideBubble(); wakeHud(); }
  function closePanels() {
    var had = !labPanel.hidden && labPanel.contains(document.activeElement);
    labPanel.hidden = true; cog.setAttribute('aria-expanded', 'false'); S.dirty = true;
    hideBubble(); wakeHud();
    if (had) cog.focus({ preventScroll: true });
  }
  cog.addEventListener('click', function () { if (labPanel.hidden) openPanel(); else closePanels(); });
  document.querySelectorAll('[data-close]').forEach(function (b) { b.addEventListener('click', closePanels); });
  $('labPlay').addEventListener('click', togglePlay);
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && (panelOpen() || !bubble.hidden)) { if (!bubble.hidden) hideBubble(); else closePanels(); } });
  /* each setting's explanation pops up in a bubble from its label, above it when there is room */
  var bubble = $('bubble'), bubbleFor = null;
  function hideBubble() { if (bubbleFor) bubbleFor.setAttribute('aria-expanded', 'false'); bubble.hidden = true; bubbleFor = null; }
  labPanel.querySelectorAll('.k[data-tip]').forEach(function (k) {
    k.addEventListener('click', function () {
      if (bubbleFor === k) { hideBubble(); return; }
      hideBubble(); bubbleFor = k; k.setAttribute('aria-expanded', 'true');
      bubble.textContent = k.dataset.tip; bubble.hidden = false;
      var pr = labPanel.getBoundingClientRect(), kr = k.getBoundingClientRect(), head = labPanel.querySelector('.panel-head').getBoundingClientRect();
      var bh = bubble.offsetHeight, above = kr.top - bh - 12 > head.bottom, x = Math.max(12, kr.left - pr.left - 6);
      bubble.classList.toggle('above', above); bubble.classList.toggle('below', !above);
      bubble.style.left = x + 'px';
      bubble.style.top = (kr.top - pr.top + labPanel.scrollTop + (above ? -bh - 10 : kr.height + 10)) + 'px';
      bubble.style.setProperty('--tail', Math.max(12, Math.min(kr.width - 10, 24) + kr.left - pr.left - x - 6) + 'px');
    });
  });
  document.addEventListener('pointerdown', function (e) { if (bubbleFor && !bubble.contains(e.target) && !bubbleFor.contains(e.target)) hideBubble(); });
  /* lab tabs; the last one used is remembered on this device */
  var tabBtns = labPanel.querySelectorAll('[role="tab"]');
  function showTab(name) {
    tabBtns.forEach(function (t) { t.setAttribute('aria-selected', String(t.dataset.tab === name)); t.tabIndex = t.dataset.tab === name ? 0 : -1; });
    labPanel.querySelectorAll('.pane').forEach(function (p) { p.hidden = p.dataset.pane !== name; });
    hideBubble(); store.set('pitchscape:tab', name);
  }
  tabBtns.forEach(function (t) { t.addEventListener('click', function () { showTab(t.dataset.tab); }); });
  showTab(labPanel.querySelector('[data-tab="' + store.get('pitchscape:tab') + '"]') ? store.get('pitchscape:tab') : 'colour');
  labUI();
  /* the server key, typed on the splash (Where.svelte); a song waiting for it is loaded as soon as it is in */
  api.setKey = function (v) {
    if (v) store.set('pitchscape:key', v); else store.del('pitchscape:key');
    whereUI();
    if (v && S.retry) { var again = S.retry; S.retry = null; hideSplash(); again(); return; }
    say(v ? 'Server key saved.' : 'Server key removed.');
  };
  if (L.font !== 'grotesque') ensureFont(L.font).then(function () { layoutWords(); S.dirty = true; });

  if (window.ResizeObserver) new ResizeObserver(resize).observe(cv); else window.addEventListener('resize', resize);
  resize();
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { layoutWords(); S.dirty = true; });
  requestAnimationFrame(loop);
  /* this computer's own server needs no key */
  apiReady.then(whereUI);
}
