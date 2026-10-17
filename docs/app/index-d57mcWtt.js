var e=(e,t,n)=>()=>{if(n)throw n[0];try{return e&&(t=e(e=0)),t}catch(e){throw n=[e],e}},t=(e,t)=>()=>(t||(e((t={exports:{}}).exports,t,t.exports),e=null),t.exports);(function(){let e=document.createElement(`link`).relList;if(e&&e.supports&&e.supports(`modulepreload`))return;for(let e of document.querySelectorAll(`link[rel="modulepreload"]`))n(e);new MutationObserver(e=>{for(let t of e)if(t.type===`childList`)for(let e of t.addedNodes)e.tagName===`LINK`&&e.rel===`modulepreload`&&n(e)}).observe(document,{childList:!0,subtree:!0});function t(e){let t={};return e.integrity&&(t.integrity=e.integrity),e.referrerPolicy&&(t.referrerPolicy=e.referrerPolicy),t.credentials=e.crossOrigin===`use-credentials`?`include`:e.crossOrigin===`anonymous`?`omit`:`same-origin`,t}function n(e){if(e.ep)return;e.ep=!0;let n=t(e);fetch(e.href,n)}})();var n=e((()=>{})),r,i=e((()=>{r=`/* Pitchscape: analysis engine.\r
   Pure JS, no DOM. Runs inside a Web Worker (or on the main thread as a fallback).\r
   - analyze(L, R, sampleRate, progress) splits a song into layers and returns compact feature tracks\r
   - synthDemo() renders an original demo song (drums, bass, pads, pluck, sung melody)\r
   - parseLyrics / alignLyrics / alignToAnchors place pasted lyrics against the detected singing */\r
var DSP = (function () {\r
  'use strict';\r
  var SR = 22050, N = 2048, HOP = 512, K = 800, BIN = SR / N, NP = 6, SEGW = 12;\r
  /* drum hits carry a coarse spectrum: DB bands, log-spaced from 30 Hz to 11 kHz, so each hit can be printed at the\r
     frequencies where its energy actually is. Event record: [time, type, strength, Hz, ring s, band 0..DB-1]. */\r
  var DB = 16, DRUM_BANDS = [], EVW = 5 + DB;\r
  for (var di = 0; di <= DB; di++) DRUM_BANDS.push(30 * Math.pow(SR / 2 / 30, di / DB));\r
\r
  function mtof(m) { return 440 * Math.pow(2, (m - 69) / 12); }\r
  function ftom(f) { return 69 + 12 * Math.log2(f / 440); }\r
\r
  function biquad(type, fc, Q, sr) {\r
    var w0 = 2 * Math.PI * fc / sr, c = Math.cos(w0), s = Math.sin(w0), a = s / (2 * Q);\r
    var b0, b1, b2, a0 = 1 + a, a1 = -2 * c, a2 = 1 - a;\r
    if (type === 'lp') { b0 = (1 - c) / 2; b1 = 1 - c; b2 = b0; }\r
    else if (type === 'hp') { b0 = (1 + c) / 2; b1 = -(1 + c); b2 = b0; }\r
    else if (type === 'notch') { b0 = 1; b1 = -2 * c; b2 = 1; }\r
    else { b0 = a; b1 = 0; b2 = -a; }\r
    b0 /= a0; b1 /= a0; b2 /= a0; a1 /= a0; a2 /= a0;\r
    var x1 = 0, x2 = 0, y1 = 0, y2 = 0;\r
    return function (x) {\r
      var y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;\r
      x2 = x1; x1 = x; y2 = y1; y1 = y;\r
      return y;\r
    };\r
  }\r
\r
  function resample(x, from, to) {\r
    if (Math.abs(from - to) < 1) return x;\r
    var src = x, i;\r
    if (from > to) {\r
      src = new Float32Array(x.length);\r
      var f1 = biquad('lp', to * 0.42, 0.5412, from), f2 = biquad('lp', to * 0.42, 1.3066, from);\r
      for (i = 0; i < x.length; i++) src[i] = f2(f1(x[i]));\r
    }\r
    var ratio = from / to, n = Math.floor(src.length / ratio), out = new Float32Array(n), last = src.length - 1;\r
    for (var j = 0; j < n; j++) {\r
      var p = j * ratio, i0 = p | 0, fr = p - i0, a = src[i0], b = i0 < last ? src[i0 + 1] : a;\r
      out[j] = a + (b - a) * fr;\r
    }\r
    return out;\r
  }\r
\r
  function makeFFT(n) {\r
    var bits = Math.round(Math.log2(n)), rev = new Uint32Array(n), cos = new Float64Array(n / 2), sin = new Float64Array(n / 2), i;\r
    for (i = 0; i < n; i++) { var r = 0; for (var b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b); rev[i] = r; }\r
    for (i = 0; i < n / 2; i++) { cos[i] = Math.cos(2 * Math.PI * i / n); sin[i] = Math.sin(2 * Math.PI * i / n); }\r
    return function (re, im) {\r
      var i, j, t;\r
      for (i = 0; i < n; i++) { j = rev[i]; if (j > i) { t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }\r
      for (var size = 2; size <= n; size <<= 1) {\r
        var half = size >> 1, step = n / size;\r
        for (i = 0; i < n; i += size) {\r
          for (j = i, t = 0; j < i + half; j++, t += step) {\r
            var l = j + half, c = cos[t], s = sin[t];\r
            var tr = re[l] * c + im[l] * s, ti = im[l] * c - re[l] * s;\r
            re[l] = re[j] - tr; im[l] = im[j] - ti; re[j] += tr; im[j] += ti;\r
          }\r
        }\r
      }\r
    };\r
  }\r
\r
  function pct(arr, q) {\r
    var n = arr.length; if (!n) return 0;\r
    var c = Float32Array.from(arr); c.sort();\r
    return c[Math.min(n - 1, Math.max(0, Math.round(q * (n - 1))))];\r
  }\r
\r
  function med9(b) {\r
    for (var a = 1; a < 9; a++) { var v = b[a], j = a - 1; while (j >= 0 && b[j] > v) { b[j + 1] = b[j]; j--; } b[j + 1] = v; }\r
    return b[4];\r
  }\r
\r
  /* Onset detection on a band-energy envelope: log compression, positive flux, adaptive threshold. */\r
  function onsetDetect(E, minGap) {\r
    var F = E.length, ref = pct(E, 0.95) + 1e-20, e = new Float32Array(F), d = new Float32Array(F), i;\r
    for (i = 0; i < F; i++) e[i] = Math.log(1 + 30 * E[i] / ref);\r
    for (i = 1; i < F; i++) { var v = e[i] - e[i - 1]; d[i] = v > 0 ? v : 0; }\r
    var p99 = pct(d, 0.99) + 1e-9, W = 12, cs = new Float64Array(F + 1), dn = new Float32Array(F);\r
    for (i = 0; i < F; i++) { cs[i + 1] = cs[i] + d[i]; dn[i] = Math.min(1.5, d[i] / p99); }\r
    var hits = [], last = -1e9;\r
    for (i = 1; i < F - 1; i++) {\r
      if (d[i] < d[i - 1] || d[i] < d[i + 1]) continue;\r
      var a = Math.max(0, i - W), b = Math.min(F, i + W + 1), mean = (cs[b] - cs[a]) / (b - a);\r
      if (d[i] > 1.5 * mean + 0.18 * p99 && i - last >= minGap) { hits.push(i); last = i; }\r
    }\r
    return { hits: hits, dn: dn };\r
  }\r
\r
  function nearMax(arr, i, r) { var m = 0; for (var j = Math.max(0, i - r); j <= Math.min(arr.length - 1, i + r); j++) if (arr[j] > m) m = arr[j]; return m; }\r
\r
\r
  /* Bass pitch in the time domain. The STFT's 10.8 Hz bins are coarser than a semitone below ~180 Hz, so low notes\r
     read flat. Periodicity (YIN's normalised difference) on a low-passed, decimated copy resolves them to a few cents.\r
     Returns the difference curve for every frame so the line can be chosen across time (bassPath). */\r
  var BD = 8, BSR = SR / BD, BW = 176, BM0 = 23, BM1 = 60, NB = BM1 - BM0 + 1, TMAX = Math.ceil(BSR / mtof(BM0 - 0.6)) + 1;\r
  function lowBand(x) {\r
    var f1 = biquad('lp', 420, 0.5412, SR), f2 = biquad('lp', 420, 1.3066, SR), n = Math.floor(x.length / BD), y = new Float32Array(n), i, j;\r
    for (i = 0, j = 0; i < x.length; i++) { var v = f2(f1(x[i])); if (i % BD === 0 && j < n) y[j++] = v; }\r
    return y;\r
  }\r
  /* normalised difference d'(tau) of y over BW samples from s0, written to out[o + tau] */\r
  function yinAt(y, s0, out, o, TS) {\r
    var e0 = 0, j, run = 0, tau, acc, df;\r
    for (j = 0; j < BW; j++) e0 += y[s0 + j] * y[s0 + j];\r
    if (e0 < 1e-10) return false;\r
    for (tau = 1; tau < TS; tau++) {\r
      acc = 0; for (j = 0; j < BW; j++) { df = y[s0 + j] - y[s0 + j + tau]; acc += df * df; }\r
      run += acc; out[o + tau] = acc * tau / (run + 1e-20);\r
    }\r
    return true;\r
  }\r
  function bestTau(d, o, a, z) { var bt = a; for (var q = a + 1; q <= z; q++) if (d[o + q] < d[o + bt]) bt = q; return bt; }\r
  /* A song reuses one kick drum, and its boom is a low sine. Each hit's boom pitch is read just after the hit; the\r
     song's boom is the most common of those on strong hits (the bass under them changes; the boom doesn't).\r
     Returns { hz: per-hit Hz (0 if unclear), boom: Hz or 0 if no consistent boom }. */\r
  function kickPitches(y, hits, dn) {\r
    var TS = TMAX + 2, d = new Float32Array(TS).fill(1), hist = new Float32Array(NB), n = 0, hop = HOP / BD, hz = new Float32Array(hits.length);\r
    hits.forEach(function (h, i) {\r
      var s0 = Math.round((h + 4) * hop);\r
      if (s0 + BW + TS >= y.length || !yinAt(y, s0, d, 0, TS)) return;\r
      var bt = bestTau(d, 0, Math.floor(BSR / mtof(BM0 + 25)), Math.ceil(BSR / mtof(BM0 - 0.5)));\r
      if (d[bt] > 0.3) return;\r
      hz[i] = BSR / bt;\r
      if (dn[h] < 0.35) return;\r
      var mi = Math.round(ftom(BSR / bt)) - BM0; if (mi >= 0 && mi <= 13) { hist[mi] += 1; n++; }\r
    });\r
    var boom = 0;\r
    if (n >= 6) {\r
      var bi = 0; for (var i = 1; i < NB; i++) if (hist[i] > hist[bi]) bi = i;\r
      var near = hist[bi] + (bi > 0 ? hist[bi - 1] : 0) + (bi < NB - 1 ? hist[bi + 1] : 0);\r
      if (near >= 0.45 * n) boom = mtof(BM0 + bi);\r
    }\r
    return { hz: hz, boom: boom };\r
  }\r
  function bassYin(y, F) {\r
    var TS = TMAX + 2, dp = new Float32Array(F * TS).fill(1), hop = HOP / BD;\r
    for (var t = 0; t < F; t++) {\r
      var s0 = Math.round(t * hop - (BW + TMAX) / 2);\r
      if (s0 >= 0 && s0 + BW + TS < y.length) yinAt(y, s0, dp, t * TS, TS);\r
    }\r
    return { dp: dp, TS: TS };\r
  }\r
  /* Choose the bass line through time (Viterbi over semitones plus "no bass"). Each frame scores a note by how\r
     periodic the low band is at that period; a note whose octave above scores as well is probably a subharmonic.\r
     Frames under a kick are trusted less (a kick's boom is a pitched sweep), so the line there follows the note\r
     heard once the kick fades. Returns f0 per frame, refined to the exact dip. */\r
  function bassPath(Y, F, kickW) {\r
    var TS = Y.TS, dp = Y.dp, S = NB + 1, cost = new Float32Array(S), prev = new Float32Array(S), back = new Uint8Array(F * S), c = new Float32Array(NB);\r
    var UNV = 0.42, t, m, q;\r
    function dAt(o, tau) { var i0 = Math.floor(tau), fr = tau - i0; return dp[o + i0] * (1 - fr) + dp[o + i0 + 1] * fr; }\r
    for (t = 0; t < F; t++) {\r
      var o = t * TS;\r
      for (m = 0; m < NB; m++) {\r
        var tc = BSR / mtof(BM0 + m), lo = BSR / mtof(BM0 + m + 0.5), hi = BSR / mtof(BM0 + m - 0.5), best = dAt(o, tc);\r
        for (q = Math.ceil(lo); q <= hi; q++) if (dp[o + q] < best) best = dp[o + q];\r
        c[m] = best;\r
      }\r
      /* a periodic sound also repeats at 2x and 3x its period: among near-best notes, keep the highest */\r
      var g = 1; for (m = 0; m < NB; m++) if (c[m] < g) g = c[m];\r
      var gate = g + 0.3;\r
      for (m = 0; m < NB; m++) if (c[m] <= gate && ((m + 12 < NB && c[m + 12] <= gate) || (m + 19 < NB && c[m + 19] <= gate) || (m + 24 < NB && c[m + 24] <= gate))) c[m] += 0.2;\r
      var w = 1 - 0.75 * kickW[t];\r
      for (m = 0; m < NB; m++) cost[m] = UNV + (c[m] - UNV) * w;\r
      cost[NB] = UNV;\r
      if (t === 0) { prev.set(cost); continue; }\r
      var bo = t * S, minP = 1e9, minI = 0;\r
      for (q = 0; q < S; q++) if (prev[q] < minP) { minP = prev[q]; minI = q; }\r
      for (m = 0; m < S; m++) {\r
        var b = prev[m], bi = m, jump = m === NB ? 0.25 : 0.3;\r
        if (minP + jump < b) { b = minP + jump; bi = minI; }\r
        if (m < NB) for (q = Math.max(0, m - 2); q <= Math.min(NB - 1, m + 2); q++) if (q !== m && prev[q] + 0.12 < b) { b = prev[q] + 0.12; bi = q; }\r
        back[bo + m] = bi; cost[m] += b;\r
      }\r
      for (q = 0; q < S; q++) prev[q] = cost[q];\r
    }\r
    var st = 0, mv = 1e9; for (q = 0; q < S; q++) if (prev[q] < mv) { mv = prev[q]; st = q; }\r
    var hz = new Float32Array(F);\r
    for (t = F - 1; t >= 0; t--) {\r
      if (st < NB) {\r
        var o2 = t * TS, a = Math.floor(BSR / mtof(BM0 + st + 0.6)), z = Math.ceil(BSR / mtof(BM0 + st - 0.6)), bt = a;\r
        for (q = a; q <= z; q++) if (dp[o2 + q] < dp[o2 + bt]) bt = q;\r
        var A = dp[o2 + bt - 1], B = dp[o2 + bt], C = dp[o2 + bt + 1], den = A - 2 * B + C, off = den > 0 ? 0.5 * (A - C) / den : 0;\r
        off = off > 0.5 ? 0.5 : off < -0.5 ? -0.5 : off;\r
        var f = BSR / (bt + off);\r
        hz[t] = Math.abs(ftom(f) - (BM0 + st)) < 0.6 ? f : mtof(BM0 + st);\r
      }\r
      if (t > 0) st = back[t * S + st];\r
    }\r
    return hz;\r
  }\r
\r
  /* ---------------------------------------------------------------- analysis */\r
  function analyze(L, R, srcRate, progress, opts) {\r
    progress = progress || function () {}; opts = opts || {};\r
    var iso = opts.isolated === 'vocals', isoOther = opts.isolated === 'other', dbgRuns = [];\r
    var i, k, t, j;\r
    var n0 = L.length, stereo = !!R && R !== L;\r
    progress('Matching sample rate', 0.02);\r
    var mid = new Float32Array(n0), side = stereo ? new Float32Array(n0) : null;\r
    for (i = 0; i < n0; i++) { var l = L[i], r = stereo ? R[i] : l; mid[i] = 0.5 * (l + r); if (stereo) side[i] = 0.5 * (l - r); }\r
    var m = resample(mid, srcRate, SR); mid = null;\r
    var lowY = lowBand(m);\r
    var s = stereo ? resample(side, srcRate, SR) : null; side = null;\r
    if (s) { var se = 0, me = 0; for (i = 0; i < m.length; i += 5) { se += s[i] * s[i]; me += m[i] * m[i]; } if (se < me * 1e-5) s = null; }\r
    stereo = !!s;\r
    var len = m.length, F = Math.max(16, Math.ceil(len / HOP));\r
\r
    /* 1. spectrum: mid magnitude + how centered each bin is (from the side channel) */\r
    var mag = new Float32Array(F * K), cen = new Uint8Array(F * K);\r
    var win = new Float64Array(N); for (i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N);\r
    var fft = makeFFT(N), re = new Float64Array(N), im = new Float64Array(N);\r
    for (t = 0; t < F; t++) {\r
      var start = t * HOP - N / 2, base = t * K;\r
      for (i = 0; i < N; i++) {\r
        var idx = start + i;\r
        if (idx >= 0 && idx < len) { re[i] = m[idx] * win[i]; im[i] = s ? s[idx] * win[i] : 0; } else { re[i] = 0; im[i] = 0; }\r
      }\r
      fft(re, im);\r
      if (s) {\r
        for (k = 0; k < K; k++) {\r
          var nk = (N - k) & (N - 1);\r
          var xr = (re[k] + re[nk]) * 0.5, xi = (im[k] - im[nk]) * 0.5, yr = (im[k] + im[nk]) * 0.5, yi = (re[nk] - re[k]) * 0.5;\r
          var xm = Math.sqrt(xr * xr + xi * xi), ym = Math.sqrt(yr * yr + yi * yi), c = 2 * xm / (xm + ym + 1e-12) - 1;\r
          mag[base + k] = xm; cen[base + k] = c <= 0 ? 0 : (c * 255 + 0.5) | 0;\r
        }\r
      } else {\r
        for (k = 0; k < K; k++) { mag[base + k] = Math.sqrt(re[k] * re[k] + im[k] * im[k]); cen[base + k] = 255; }\r
      }\r
      if ((t & 255) === 0) progress('Reading the spectrum', 0.04 + 0.3 * t / F);\r
    }\r
    m = null; s = null;\r
\r
    /* 2. harmonic / percussive split (median filtering) and per-frame features */\r
    var kickE = new Float32Array(F), snE = new Float32Array(F), snC = new Float32Array(F), hatE = new Float32Array(F), hatC = new Float32Array(F), totE = new Float32Array(F);\r
    var bassE = new Float32Array(F), bassF = new Float32Array(F), bassB = new Float32Array(F);\r
    var leadS = new Float32Array(F), leadC = new Float32Array(F), leadM = new Float32Array(F), leadA = new Float32Array(F), leadB = new Float32Array(F), leadZ = new Float32Array(F), leadCen = new Float32Array(F), leadHi = new Float32Array(F);\r
    var pkM = new Float32Array(F * NP), pkA = new Float32Array(F * NP), pkB = new Float32Array(F * NP), pkZ = new Float32Array(F * NP), pkE = new Float32Array(F * NP), pkL = new Uint8Array(F * NP), pkN = new Uint8Array(F);\r
    var harm = new Float32Array(K), perc = new Float32Array(K), lc = new Float32Array(K), b9 = new Float32Array(9), offs = new Int32Array(9), csum = new Float64Array(K + 1), snFl = new Float32Array(F), pb = new Float32Array(F * DB), dbK = [];\r
    for (var bk = 0; bk <= DB; bk++) dbK.push(Math.max(bk ? dbK[bk - 1] + 1 : 2, Math.min(K, Math.round(DRUM_BANDS[bk] / BIN))));\r
    var leadCand = [], bassCand = [], mm;\r
    for (mm = 47; mm <= 84.001; mm += 1 / 3) leadCand.push(mtof(mm));\r
    for (mm = 23; mm <= 60.001; mm += 1 / 3) bassCand.push(mtof(mm));\r
    var nLC = leadCand.length, candK = new Int32Array(12), candA = new Float32Array(12), Sbuf = new Float32Array(nLC);\r
\r
    function pk(arr, off, f) { var b = f / BIN, i0 = Math.floor(b); if (i0 < 1 || i0 >= K - 1) return 0; var a = arr[off + i0], c = arr[off + i0 + 1]; return a > c ? a : c; }\r
    /* sharpen a coarse f0 using the strongest of its first hmax harmonics (parabolic peak fit) */\r
    function refine(arr, f, hmax) {\r
      var bestA = 0, bestF = f;\r
      for (var h = 1; h <= hmax; h++) {\r
        var k0 = Math.round(h * f / BIN), km = -1, am = 0;\r
        for (var q = k0 - 2; q <= k0 + 2; q++) { if (q < 1 || q >= K - 1) continue; if (arr[q] > am) { am = arr[q]; km = q; } }\r
        if (km < 0 || am <= bestA) continue;\r
        var a1 = Math.log(arr[km - 1] + 1e-20), b1 = Math.log(arr[km] + 1e-20), c1 = Math.log(arr[km + 1] + 1e-20), dn = a1 - 2 * b1 + c1;\r
        var d = dn < 0 ? 0.5 * (a1 - c1) / dn : 0; d = d > 0.5 ? 0.5 : d < -0.5 ? -0.5 : d;\r
        var est = (km + d) * BIN / h;\r
        if (Math.abs(12 * Math.log2(est / f)) < 1) { bestA = am; bestF = est; }\r
      }\r
      return bestF;\r
    }\r
    function at(arr, off, f) { var b = f / BIN, i0 = Math.floor(b); if (i0 < 0 || i0 >= K - 1) return 0; var fr = b - i0; return arr[off + i0] * (1 - fr) + arr[off + i0 + 1] * fr; }\r
\r
    for (t = 0; t < F; t++) {\r
      var bt = t * K;\r
      for (j = 0; j < 9; j++) { var tt = t + j - 4; offs[j] = (tt < 0 ? 0 : tt >= F ? F - 1 : tt) * K; }\r
      var te = 0;\r
      for (k = 0; k < K; k++) {\r
        for (j = 0; j < 9; j++) b9[j] = mag[offs[j] + k];\r
        var h = med9(b9);\r
        for (j = 0; j < 9; j++) { var kk = k + j - 4; b9[j] = mag[bt + (kk < 0 ? 0 : kk >= K ? K - 1 : kk)]; }\r
        var p = med9(b9), M = mag[bt + k], h2 = h * h, p2 = p * p, hm = h2 / (h2 + p2 + 1e-20);\r
        harm[k] = M * hm; perc[k] = M - harm[k]; te += M * M;\r
      }\r
      totE[t] = te;\r
\r
      /* drums from the percussive part */\r
      var ke = 0, se2 = 0, sc = 0, he = 0, hc = 0, v;\r
      for (k = 3; k <= 13; k++) ke += perc[k] * perc[k];\r
      var lg = 0, ar = 0;\r
      for (k = 74; k <= 465; k++) { v = perc[k] * perc[k]; se2 += v; sc += v * k; lg += Math.log(perc[k] + 1e-12); ar += perc[k]; }\r
      snFl[t] = Math.exp(lg / 392) / (ar / 392 + 1e-12);\r
      for (k = 464; k < K; k++) { v = perc[k] * perc[k]; he += v; hc += v * k; }\r
      for (var bb = 0, pbo = t * DB; bb < DB; bb++) { var pe3 = 0; for (k = dbK[bb]; k < dbK[bb + 1] && k < K; k++) pe3 += perc[k] * perc[k]; pb[pbo + bb] = pe3; }\r
      kickE[t] = ke; snE[t] = se2; snC[t] = se2 > 0 ? sc / se2 * BIN : 1500; hatE[t] = he; hatC[t] = he > 0 ? hc / he * BIN : 7000;\r
\r
      /* bass: harmonic sum over low candidates */\r
      var bE = 0; for (k = 3; k <= 24; k++) bE += harm[k] * harm[k]; bassE[t] = bE;\r
      var best = 0, bf = 0, ci, f;\r
      for (ci = 0; ci < bassCand.length; ci++) {\r
        f = bassCand[ci];\r
        v = pk(harm, 0, f) + 0.5 * pk(harm, 0, 2 * f) + 0.25 * pk(harm, 0, 3 * f);\r
        if (v > best) { best = v; bf = f; }\r
      }\r
      if (bf > 0) bf = refine(harm, bf, 3);\r
      bassF[t] = bf;\r
      if (bf > 0) {\r
        var lo = pk(harm, 0, bf) + pk(harm, 0, 2 * bf), hi = 0;\r
        for (j = 3; j <= 7; j++) hi += pk(harm, 0, j * bf);\r
        bassB[t] = hi / (lo + hi + 1e-12);\r
      }\r
\r
      /* lead line: harmonic summation on the centered, harmonic part */\r
      csum[0] = 0; for (k = 0; k < K; k++) csum[k + 1] = csum[k] + harm[k];\r
      for (k = 0; k < K; k++) {\r
        var lo3 = k < 7 ? 0 : k - 7, hi3 = k + 8 > K ? K : k + 8, fl = (csum[hi3] - csum[lo3]) / (hi3 - lo3), wv = harm[k] - 1.1 * fl;\r
        lc[k] = wv > 0 ? Math.sqrt(wv) * (0.2 + 0.8 * cen[bt + k] / 255) : 0;\r
      }\r
      if (!iso && bf > 0 && bE > 0.08 * te) {\r
        for (j = 1; j <= 8 && j * bf < 270; j++) { var kc = Math.round(j * bf / BIN); for (var q2 = kc - 1; q2 <= kc + 1; q2++) if (q2 >= 0 && q2 < K) lc[q2] *= 0.25; }\r
      }\r
      best = 0; var bi = 0, sum = 0, bestB = 0, prevM = t > 0 ? leadM[t - 1] : 0, prevOk = t > 0 && leadS[t - 1] > 0;\r
      for (ci = 0; ci < nLC; ci++) {\r
        f = leadCand[ci]; var S = 0, w = 1;\r
        for (j = 1; j <= 10; j++) { var fh = j * f; if (fh > 5000) break; S += w * pk(lc, 0, fh); w *= 0.82; }\r
        Sbuf[ci] = S; sum += S;\r
        /* mild preference for staying on the previous frame's note: keeps held notes from slipping */\r
        var Sb = (prevOk && Math.abs(ftom(f) - prevM) < 1) ? S * 1.25 : S;\r
        if (Sb > bestB) { bestB = Sb; best = S; bi = ci; }\r
      }\r
      leadS[t] = best; leadC[t] = best / (sum / nLC + 1e-12);\r
      var lf = refine(harm, leadCand[bi], 4); leadM[t] = ftom(lf);\r
      var tot = 0, hiA = 0, ce = 0, up = 0, all = 0;\r
      for (j = 1; j <= 10; j++) { var fq = j * lf; if (fq > 5000) break; var aa = pk(harm, 0, fq); tot += aa; if (j >= 4) hiA += aa; ce += aa * cen[bt + Math.min(K - 1, Math.round(fq / BIN))] / 255; }\r
      for (j = 1; j <= 30; j++) { var fu = j * lf; if (fu > 4000) break; var au = pk(harm, 0, fu); all += au; if (fu > 800) up += au; }\r
      leadA[t] = tot; leadB[t] = tot > 0 ? hiA / tot : 0; leadCen[t] = tot > 0 ? ce / tot : 0; leadHi[t] = all > 0 ? up / all : 0;\r
      var pe = 0, tr = 0;\r
      for (j = 1; j <= 16; j++) { var fz = j * lf; if (fz < 900) continue; if (fz > 4500) break; pe += pk(mag, bt, fz); tr += at(mag, bt, fz + 0.5 * lf); }\r
      leadZ[t] = pe > 0 ? tr / pe : 0;\r
\r
      /* other harmonic notes: spectral peaks, folded so overtones don't count as notes */\r
      var nc = 0;\r
      for (k = 17; k <= 232; k++) {\r
        v = harm[k];\r
        if (v > harm[k - 1] && v >= harm[k + 1] && v > harm[k - 2] && v >= harm[k + 2]) {\r
          if (nc < 12) { candK[nc] = k; candA[nc] = v; nc++; }\r
          else { var mi = 0; for (j = 1; j < 12; j++) if (candA[j] < candA[mi]) mi = j; if (v > candA[mi]) { candK[mi] = k; candA[mi] = v; } }\r
        }\r
      }\r
      var cands = [];\r
      for (j = 0; j < nc; j++) {\r
        var kb = candK[j], al = Math.log(harm[kb - 1] + 1e-20), be = Math.log(harm[kb] + 1e-20), ga = Math.log(harm[kb + 1] + 1e-20), den = al - 2 * be + ga;\r
        var dp = den < 0 ? 0.5 * (al - ga) / den : 0; dp = dp > 0.5 ? 0.5 : dp < -0.5 ? -0.5 : dp;\r
        cands.push({ f: (kb + dp) * BIN, a: candA[j] });\r
      }\r
      cands.sort(function (x, y) { return x.f - y.f; });\r
      var acc = [];\r
      for (j = 0; j < cands.length; j++) {\r
        var cc = cands[j], isH = false;\r
        for (var q = 0; q < acc.length; q++) { var rr = cc.f / acc[q].f, nr = Math.round(rr); if (nr >= 2 && nr <= 8 && Math.abs(rr / nr - 1) < 0.03 && cc.a < acc[q].a * 1.6) { isH = true; break; } }\r
        if (!isH) acc.push(cc);\r
      }\r
      acc.sort(function (x, y) { return y.a - x.a; });\r
      var np = Math.min(NP, acc.length); pkN[t] = np;\r
      for (j = 0; j < np; j++) {\r
        var f0 = acc[j].f, o = t * NP + j, num = 0, dnm = 0, pe2 = 0, tr2 = 0, hh, ev2 = 0, od2 = 0;\r
        for (hh = 1; hh <= 8; hh++) { var fh2 = hh * f0; if (fh2 > 8000) break; var a2 = pk(harm, 0, fh2); dnm += a2; if (hh >= 3) num += a2; if (hh >= 2 && hh <= 7) { if (hh & 1) od2 += a2; else ev2 += a2; } }\r
        for (hh = 1; hh <= 4; hh++) { pe2 += pk(mag, bt, hh * f0); tr2 += at(mag, bt, (hh + 0.5) * f0); }\r
        pkM[o] = ftom(f0); pkA[o] = acc[j].a; pkB[o] = dnm > 0 ? num / dnm : 0; pkZ[o] = pe2 > 0 ? tr2 / pe2 : 0; pkE[o] = ev2 + od2 > 0 ? ev2 / (ev2 + od2) : 0.5;\r
        var rl = f0 / lf, nl = Math.round(rl);\r
        pkL[o] = (nl >= 1 && nl <= 8 && Math.abs(rl / nl - 1) < 0.035) ? 1 : 0;\r
      }\r
      if ((t & 127) === 0) progress('Splitting drums from tones', 0.35 + 0.5 * t / F);\r
    }\r
    mag = null; cen = null;\r
\r
    var dt = HOP / SR;\r
\r
    /* 3. drum hits */\r
    progress('Finding drum hits', 0.87);\r
    var ko = onsetDetect(kickE, 5), so = onsetDetect(snE, 5), ho = onsetDetect(hatE, 3), flThr = 0.3;\r
    var events = [], kp = kickPitches(lowY, ko.hits, ko.dn), boom = kp.boom;\r
    /* how long a hit rings: frames until its band falls 14 dB below the hit, or the next hit of its kind */\r
    function ring(E, t, hits, n) {\r
      var p = Math.max(E[t], t + 1 < F ? E[t + 1] : 0), stop = n + 1 < hits.length ? hits[n + 1] : F, u = t + 2;\r
      while (u < F && u < stop && u < t + 40 && E[u] > 0.04 * p) u++;\r
      return (u - t) * dt;\r
    }\r
    function hit(t, type, strength, hz, ringS) {\r
      /* the hit's own spectrum: what each band gained over the two frames before it, so whatever else is\r
         playing (bass, a kick under a hat) doesn't count. Each kind only claims its own region: a hat landing on a\r
         bass note has no business at 150 Hz. */\r
      var e = [t * dt, type, strength, hz, ringS], mx = 1e-20, b, v, lo = type === 2 ? 1400 : type === 1 ? 120 : 0;\r
      for (b = 0; b < DB; b++) {\r
        if (Math.sqrt(DRUM_BANDS[b] * DRUM_BANDS[b + 1]) < lo) { e.push(0); continue; }\r
        var cur = Math.max(pb[t * DB + b], t + 1 < F ? pb[(t + 1) * DB + b] : 0), before = Math.max(t > 0 ? pb[(t - 1) * DB + b] : 0, t > 1 ? pb[(t - 2) * DB + b] : 0);\r
        v = Math.sqrt(Math.max(0, cur - before)); e.push(v); if (v > mx) mx = v;\r
      }\r
      for (b = 5; b < EVW; b++) e[b] /= mx;\r
      events.push(e);\r
    }\r
    ko.hits.forEach(function (t, n) { hit(t, 0, Math.min(1, ko.dn[t]), kp.hz[n] || boom || 52, ring(kickE, t, ko.hits, n)); });\r
    so.hits.forEach(function (t, n) {\r
      var kd = nearMax(ko.dn, t, 1);\r
      if (kd > 0.4 && so.dn[t] < 1.1 * kd) return;\r
      if (Math.max(snFl[t], snFl[Math.min(F - 1, t + 1)]) < flThr) return;\r
      hit(t, 1, Math.min(1, so.dn[t]), Math.max(snC[t], snC[Math.min(F - 1, t + 1)]), ring(snE, t, so.hits, n));\r
    });\r
    ho.hits.forEach(function (t, n) {\r
      var sd = nearMax(so.dn, t, 1);\r
      if (sd > 0.4 && ho.dn[t] < 1.1 * sd) return;\r
      hit(t, 2, Math.min(1, ho.dn[t]), hatC[t], ring(hatE, t, ho.hits, n));\r
    });\r
    events.sort(function (a, b) { return a[0] - b[0]; });\r
\r
    /* 4. bass track */\r
    var bRef = pct(bassE, 0.98) + 1e-20, bassN = new Float32Array(F), bassHz = new Float32Array(F), bassBr = new Float32Array(F), env = 0, eb = 0;\r
    for (t = 0; t < F; t++) {\r
      var x = Math.min(1.2, Math.sqrt(bassE[t] / bRef));\r
      env += (x > env ? 0.6 : 0.25) * (x - env); bassN[t] = env;\r
      eb += 0.2 * (bassB[t] - eb); bassBr[t] = eb;\r
    }\r
    /* kicks are pitched sweeps in the bass range: how much each frame sits under one */\r
    var kickW = new Float32Array(F);\r
    ko.hits.forEach(function (h) { var s1 = Math.min(1, 1.3 * ko.dn[h]); for (j = -1; j <= 9; j++) { var u = h + j; if (u >= 0 && u < F) kickW[u] = Math.max(kickW[u], s1 * (j < 6 ? 1 : (10 - j) / 4)); } });\r
    if (boom) { var nf = biquad('notch', boom, 2.5, BSR); for (i = 0; i < lowY.length; i++) lowY[i] = nf(lowY[i]); }\r
    var by = bassYin(lowY, F), bp = bassPath(by, F, kickW); by = null; lowY = null;\r
    for (t = 0; t < F; t++) bassF[t] = bp[t];\r
    var lastHz = 0, lastT = -1e9;\r
    for (t = 0; t < F; t++) {\r
      var win5 = [];\r
      for (j = -2; j <= 2; j++) { var u = t + j; if (u >= 0 && u < F && bassF[u] > 0) win5.push(ftom(bassF[u])); }\r
      win5.sort(function (a, b) { return a - b; });\r
      var hzT = win5.length ? mtof(win5[win5.length >> 1]) : 0;\r
      if (bassN[t] >= 0.08 && hzT > 0) { bassHz[t] = hzT; lastHz = hzT; lastT = t; }\r
      /* while a note dies away, keep its last confident pitch so the stroke thins out instead of stopping dead */\r
      else if (bassN[t] >= 0.015 && lastHz > 0 && (t - lastT) * dt < 0.6) bassHz[t] = (hzT > 0 && Math.abs(ftom(hzT) - ftom(lastHz)) < 1.5) ? hzT : lastHz;\r
      else bassHz[t] = 0;\r
    }\r
\r
    /* 5. lead line (usually the voice) */\r
    progress('Following the lead line', 0.9);\r
    var eMed = pct(totE, 0.5) + 1e-20, salList = [], conList = [];\r
    for (t = 0; t < F; t++) if (totE[t] > eMed * 0.05) { salList.push(leadS[t]); conList.push(leadC[t]); }\r
    var RUN_HI = 0.2, RUN_HI_MIN = 0.06, sThr = 0.45 * pct(salList, 0.9), cThr = Math.max(1.5, 0.75 * pct(conList, 0.5));\r
    var voiced = new Uint8Array(F);\r
    for (t = 0; t < F; t++) voiced[t] = (leadS[t] > sThr && leadC[t] > cThr && totE[t] > eMed * 0.02) ? 1 : 0;\r
    var lm = new Float32Array(F);\r
    for (t = 0; t < F; t++) {\r
      if (!voiced[t]) continue;\r
      var wl = [];\r
      for (j = -2; j <= 2; j++) { var w2 = t + j; if (w2 >= 0 && w2 < F && voiced[w2]) wl.push(leadM[w2]); }\r
      wl.sort(function (a, b) { return a - b; });\r
      var med = wl[wl.length >> 1], dd = leadM[t] - med;\r
      lm[t] = (Math.abs(Math.abs(dd) - 12) < 0.8 || Math.abs(dd) > 4) ? med : leadM[t];\r
    }\r
    /* fill short gaps, then drop short runs */\r
    for (t = 1; t < F; t++) {\r
      if (voiced[t] || !voiced[t - 1]) continue;\r
      var g = t; while (g < F && !voiced[g] && g - t < 4) g++;\r
      if (g < F && voiced[g] && g - t <= 3 && Math.abs(lm[g] - lm[t - 1]) < 3) { for (var z = t; z < g; z++) { voiced[z] = 1; lm[z] = lm[t - 1] + (lm[g] - lm[t - 1]) * (z - t + 1) / (g - t + 1); } t = g; }\r
    }\r
    /* split at big pitch leaps, then keep only runs whose upper harmonics look like a voice (not a bass line) */\r
    var runs = [];\r
    for (t = 0; t < F;) {\r
      if (!voiced[t]) { t++; continue; }\r
      var a0 = t; t++;\r
      while (t < F && voiced[t] && Math.abs(lm[t] - lm[t - 1]) < 7) t++;\r
      var hiSum = 0, bm = 0;\r
      for (z = a0; z < t; z++) {\r
        hiSum += leadHi[z];\r
        if (bassF[z] > 0 && bassE[z] > 0.08 * totE[z]) { var d8 = lm[z] - ftom(bassF[z]), oc = Math.round(d8 / 12); if (oc >= 0 && oc <= 2 && Math.abs(d8 - 12 * oc) < 0.7) bm++; }\r
      }\r
      var hiMean = hiSum / (t - a0), bassFrac = bm / (t - a0);\r
      /* a run that mostly sits on the bass line's notes, or has almost no upper harmonics, is the bass, not a voice */\r
      var reject = t - a0 < 5 || (!iso && (hiMean < RUN_HI_MIN || bassFrac > 0.5 || (hiMean < RUN_HI && bassFrac > 0.25)));\r
      if (opts.debug) dbgRuns.push([a0, t - 1, hiMean, bassFrac, reject ? 1 : 0]);\r
      if (reject) { for (z = a0; z < t; z++) voiced[z] = 0; } else runs.push([a0, t - 1]);\r
    }\r
    /* a short run sitting an octave away from an adjacent longer run is an octave slip: move it */\r
    function runMed(rn) { var a = []; for (var x = rn[0]; x <= rn[1]; x++) a.push(lm[x]); a.sort(function (p, q) { return p - q; }); return a[a.length >> 1]; }\r
    for (var ri = 0; ri < runs.length; ri++) {\r
      var cur = runs[ri], cm = runMed(cur), len0 = cur[1] - cur[0];\r
      [runs[ri - 1], runs[ri + 1]].forEach(function (nb) {\r
        if (!nb || nb[1] - nb[0] <= len0) return;\r
        var gapF = nb[0] > cur[1] ? nb[0] - cur[1] : cur[0] - nb[1];\r
        if (gapF > 4) return;\r
        var dlt = runMed(nb) - cm;\r
        if (Math.abs(Math.abs(dlt) - 12) < 1.5) { var sh = dlt > 0 ? 12 : -12; for (var x = cur[0]; x <= cur[1]; x++) lm[x] += sh; cm += sh; }\r
      });\r
    }\r
    var merged = [];\r
    runs.forEach(function (rn) {\r
      var lst = merged[merged.length - 1];\r
      if (lst && rn[0] - lst[1] <= 2 && Math.abs(lm[rn[0]] - lm[lst[1]]) < 2) lst[1] = rn[1]; else merged.push([rn[0], rn[1]]);\r
    });\r
    /* short runs that leap far from the runs around them are interlopers (bass, pads, release tails):\r
       octave leaps get moved, anything else is dropped */\r
    var keep = [];\r
    merged.forEach(function (rn, ri) {\r
      var dur = (rn[1] - rn[0] + 1) * dt;\r
      if (dur >= 0.45) { keep.push(rn); return; }\r
      var me2 = runMed(rn), nbs = [merged[ri - 1], merged[ri + 1]].filter(function (nb) {\r
        return nb && (nb[1] - nb[0]) > (rn[1] - rn[0]) && (nb[0] > rn[1] ? nb[0] - rn[1] : rn[0] - nb[1]) * dt < 0.6;\r
      });\r
      if (!nbs.length) { keep.push(rn); return; }\r
      var dl = nbs.map(function (nb) { return runMed(nb) - me2; });\r
      if (dl.some(function (d) { return Math.abs(d) <= 9; })) { keep.push(rn); return; }\r
      var oct = dl.filter(function (d) { return Math.abs(Math.abs(d) - 12) < 1.5; })[0];\r
      if (oct !== undefined) { for (var x = rn[0]; x <= rn[1]; x++) lm[x] += oct > 0 ? 12 : -12; keep.push(rn); return; }\r
      for (var y = rn[0]; y <= rn[1]; y++) voiced[y] = 0;\r
    });\r
    runs = keep;\r
    var ampList = []; for (t = 0; t < F; t++) if (voiced[t]) ampList.push(leadA[t]);\r
    var aRef = pct(ampList, 0.95) + 1e-20, zList = [];\r
    var leadHz = new Float32Array(F), leadN = new Float32Array(F), leadBr = new Float32Array(F), leadNz = new Float32Array(F);\r
    var eB = 0;\r
    for (t = 0; t < F; t++) {\r
      if (!voiced[t]) { eB = leadB[t]; continue; }\r
      leadHz[t] = mtof(lm[t]);\r
      leadN[t] = Math.min(1.2, Math.sqrt(leadA[t] / aRef));\r
      eB += 0.3 * (leadB[t] - eB); leadBr[t] = eB;\r
      var zz = []; for (j = -3; j <= 3; j++) { var w3 = t + j; if (w3 >= 0 && w3 < F && voiced[w3]) zz.push(leadZ[w3]); }\r
      zz.sort(function (a, b) { return a - b; }); leadNz[t] = zz[zz.length >> 1]; zList.push(leadNz[t]);\r
    }\r
\r
    /* syllable-ish onsets inside the lead line, used to place lyrics */\r
    var onsets = [];\r
    runs.forEach(function (rn) {\r
      var a = rn[0], b = rn[1], lastOn = a;\r
      onsets.push([a, 1]);\r
      for (var t = a + 3; t <= b - 3; t++) {\r
        if (t - lastOn < 5) continue;\r
        var before = (lm[t - 3] + lm[t - 2] + lm[t - 1]) / 3, after = (lm[t + 1] + lm[t + 2] + lm[t + 3]) / 3;\r
        var jump = Math.abs(after - before), settled = Math.abs(lm[t + 3] - lm[t + 1]) < 0.7 && Math.abs(lm[t + 1] - lm[t]) < 0.7;\r
        var dip = leadA[t] <= leadA[t - 1] && leadA[t] <= leadA[t + 1] && nearMax(leadA, t + 3, 3) > 2.0 * leadA[t] && nearMax(leadA, t - 3, 3) > 1.8 * leadA[t];\r
        if ((jump >= 1.0 && settled) || dip) { onsets.push([dip && !(jump >= 1.0) ? t + 1 : t, dip ? 0.6 : 0.8]); lastOn = t; }\r
      }\r
    });\r
    var runEndOf = new Int32Array(F).fill(-1), runStartOf = new Int32Array(F).fill(-1);\r
    runs.forEach(function (rn) { for (var t = rn[0]; t <= rn[1]; t++) { runEndOf[t] = rn[1]; runStartOf[t] = rn[0]; } });\r
    var onArr = new Float32Array(onsets.length * 4), prevEnd = -1e9;\r
    onsets.forEach(function (o, n) {\r
      var f = o[0], rs = runStartOf[f], gap = (rs === f) ? (f - prevEnd) * dt : 0;\r
      onArr[n * 4] = f * dt; onArr[n * 4 + 1] = Math.min(gap, 30); onArr[n * 4 + 2] = (runEndOf[f] + 1) * dt; onArr[n * 4 + 3] = o[1];\r
      prevEnd = runEndOf[f];\r
    });\r
\r
    /* Display only (the lyric onsets above are already fixed): bridge short dips inside a sung phrase and let\r
       each line follow the voice as it fades in and out, so quiet singing thins and pales instead of cutting off. */\r
    function ampN(z) { return Math.min(1.2, Math.sqrt(Math.max(0, leadA[z]) / aRef)); }\r
    function paint(z, m, nzRef, brRef) {\r
      leadHz[z] = mtof(m);\r
      /* if the tracker was following something else here, the voice itself is weak: keep it faint */\r
      leadN[z] = Math.abs(leadM[z] - m) < 1 ? ampN(z) : Math.min(ampN(z), 0.06);\r
      leadBr[z] = brRef; leadNz[z] = nzRef;\r
    }\r
    for (var rb = 0; rb + 1 < runs.length; rb++) {\r
      var e1 = runs[rb][1], s2 = runs[rb + 1][0], gapN = s2 - e1 - 1;\r
      if (gapN <= 0 || gapN * dt > 0.4 || Math.abs(lm[s2] - lm[e1]) > 4) continue;\r
      for (z = e1 + 1; z < s2; z++) paint(z, lm[e1] + (lm[s2] - lm[e1]) * (z - e1) / (s2 - e1), leadNz[e1], leadBr[e1]);\r
    }\r
    runs.forEach(function (rn) {\r
      var ref = 0, q;\r
      for (q = rn[0]; q <= rn[1]; q++) ref += leadA[q];\r
      ref /= rn[1] - rn[0] + 1;\r
      for (q = rn[1] + 1; q < Math.min(F, rn[1] + 10); q++) {\r
        if (leadHz[q] > 0 || leadA[q] < 0.06 * ref || Math.abs(leadM[q] - lm[rn[1]]) > 1.2) break;\r
        paint(q, lm[rn[1]], leadNz[rn[1]], leadBr[rn[1]]);\r
      }\r
      for (q = rn[0] - 1; q >= Math.max(0, rn[0] - 5); q--) {\r
        if (leadHz[q] > 0 || leadA[q] < 0.06 * ref || Math.abs(leadM[q] - lm[rn[0]]) > 1.2) break;\r
        paint(q, lm[rn[0]], leadNz[rn[0]], leadBr[rn[0]]);\r
      }\r
    });\r
\r
    /* 6. other notes as segments */\r
    progress('Printing notes', 0.95);\r
    var allA = []; for (t = 0; t < F; t++) for (j = 0; j < pkN[t]; j++) allA.push(pkA[t * NP + j]);\r
    var oThr = 0.2 * pct(allA, 0.95), oRef = pct(allA, 0.95) + 1e-20;\r
    var active = [], segs = [];\r
    /* Each note is followed frame by frame (nearest pitch, so vibrato and slight bends stay one note), then judged\r
       as a whole: how it starts (struck, swelling or held), how fast it fades, any vibrato, and whether its tone is\r
       hollow (odd harmonics only, like a clarinet or square wave). */\r
    function closeSeg(sg) {\r
      if (sg.a.length < 4) return;\r
      /* a note is only picked up once it is loud enough, so a slow swell is caught halfway up. Walk back through\r
         quieter frames at the same pitch while the level keeps falling, to find where it really began. */\r
      var lv0 = sg.a[0], m0 = sg.m[0], tb, jb;\r
      for (tb = sg.f[0] - 1; tb >= Math.max(0, sg.f[0] - 40); tb--) {\r
        var hit = -1;\r
        for (jb = 0; jb < pkN[tb]; jb++) { var ob = tb * NP + jb; if (Math.abs(pkM[ob] - m0) < 0.6 && (hit < 0 || pkA[ob] > pkA[hit])) hit = ob; }\r
        if (hit < 0 || pkA[hit] < 0.04 * oRef || pkA[hit] > lv0 * 1.15) break;\r
        lv0 = Math.min(lv0, pkA[hit]);\r
        sg.f.unshift(tb); sg.a.unshift(pkA[hit]); sg.m.unshift(pkM[hit]); sg.b.unshift(pkB[hit]); sg.z.unshift(pkZ[hit]); sg.e.unshift(pkE[hit]);\r
      }\r
      var n = sg.a.length;\r
      var k, pi = 0, sm = 0, sb = 0, sz = 0, se = 0;\r
      for (k = 0; k < n; k++) { if (sg.a[k] > sg.a[pi]) pi = k; sm += sg.m[k]; sb += sg.b[k]; sz += sg.z[k]; se += sg.e[k]; }\r
      var amax = sg.a[pi], k75 = 0; while (sg.a[k75] < 0.75 * amax) k75++;\r
      var attack = (sg.f[k75] - sg.f[0] + 1) * dt, dur = (sg.f[n - 1] - sg.f[0] + 1) * dt;\r
      /* fade in dB per second, measured 60% of the way from the peak to the end, so a held note's release\r
         tail doesn't read as a fade */\r
      var decay = 0;\r
      if (n - pi >= 5) {\r
        var k6 = pi + Math.round(0.6 * (n - 1 - pi)), lv = (sg.a[k6 - 1] + sg.a[k6] + sg.a[Math.min(n - 1, k6 + 1)]) / 3;\r
        decay = 20 * Math.log10(lv / amax + 1e-9) / Math.max(dt, (sg.f[k6] - sg.f[pi]) * dt);\r
      }\r
      /* vibrato: pitch wobble around a running mean, as depth (semitones) and rate (zero crossings) */\r
      var vd = 0, vr = 0;\r
      if (n >= 12) {\r
        var rs = [], ss = 0, zc = 0;\r
        for (k = 0; k < n; k++) { var lo = Math.max(0, k - 4), hi = Math.min(n - 1, k + 4), mu = 0; for (var q = lo; q <= hi; q++) mu += sg.m[q]; mu /= hi - lo + 1; rs.push(sg.m[k] - mu); }\r
        for (k = 2; k < n - 2; k++) { ss += rs[k] * rs[k]; if (k > 2 && rs[k] * rs[k - 1] < 0) zc++; }\r
        var depth = Math.sqrt(ss / (n - 4)) * Math.SQRT2, rate = zc / 2 / ((n - 4) * dt);\r
        if (depth >= 0.1 && depth < 1.5 && rate >= 3.5 && rate <= 8.5) { vd = depth; vr = rate; }\r
      }\r
      /* family: 0 struck (keys, plucks: hard start, fades), 1 swell (pads, bowed strings: slow start),\r
         2 held (organ, leads, brass: hard start, holds) */\r
      var fam = attack >= 0.12 ? 1 : (decay < -9 || dur < 0.35) ? 0 : 2;\r
      if (fam === 0 && vd > 0) fam = 2;\r
      segs.push([sg.f[0] * dt, (sg.f[n - 1] + 1) * dt, sm / n, Math.min(1.2, Math.sqrt(amax / oRef)), sb / n, sz / n, fam, attack, decay, vd, vr, 1 - Math.min(1, 2 * se / n)]);\r
    }\r
    var used = new Uint8Array(64);\r
    for (t = 0; t < F; t++) {\r
      for (j = 0; j < active.length; j++) used[j] = 0;\r
      for (j = 0; j < pkN[t]; j++) {\r
        var o2 = t * NP + j;\r
        if (pkA[o2] < oThr || (voiced[t] && pkL[o2] && !isoOther)) continue;\r
        var bi2 = -1, bd = 0.8;\r
        for (var q3 = 0; q3 < active.length; q3++) { var ag = active[q3], dd2 = Math.abs(ag.m[ag.m.length - 1] - pkM[o2]); if (!used[q3] && ag.f[ag.f.length - 1] >= t - 3 && dd2 < bd) { bd = dd2; bi2 = q3; } }\r
        var sg = bi2 >= 0 ? active[bi2] : null;\r
        if (!sg) { if (active.length >= 60) continue; sg = { f: [], a: [], m: [], b: [], z: [], e: [] }; active.push(sg); bi2 = active.length - 1; }\r
        used[bi2] = 1; sg.f.push(t); sg.a.push(pkA[o2]); sg.m.push(pkM[o2]); sg.b.push(pkB[o2]); sg.z.push(pkZ[o2]); sg.e.push(pkE[o2]);\r
      }\r
      for (j = active.length - 1; j >= 0; j--) if (active[j].f[active[j].f.length - 1] < t - 3) { closeSeg(active[j]); active.splice(j, 1); }\r
    }\r
    active.forEach(closeSeg);\r
    segs.sort(function (a, b) { return a[0] - b[0]; });\r
\r
    var ev = new Float32Array(events.length * EVW); events.forEach(function (e, n) { ev.set(e, n * EVW); });\r
    var sg2 = new Float32Array(segs.length * SEGW); segs.forEach(function (e, n) { sg2.set(e, n * SEGW); });\r
    progress('Done', 1);\r
    return {\r
      dur: len / SR, dt: dt, frames: F, stereo: stereo,\r
      bassN: bassN, bassHz: bassHz, bassBr: bassBr,\r
      leadHz: leadHz, leadN: leadN, leadBr: leadBr, leadNz: leadNz,\r
      noiseRef: [pct(zList, 0.2), pct(zList, 0.9)], dbgBass: opts.debug ? { spec: bassF, n: bassN, boom: boom } : undefined, dbgRuns: opts.debug ? dbgRuns : undefined,\r
      events: ev, evW: EVW, segs: sg2, segW: SEGW, onsets: onArr\r
    };\r
  }\r
\r
  /* ---------------------------------------------------------------- demo song */\r
  /* An original 12-bar demo. Every layer the visualizer listens for is in it. */\r
  var DEMO_LYRICS = 'Shake the page, the bass is low\\nEvery hit leaves ink below\\nSing it higher, watch it climb\\nWords arrive right on time';\r
\r
  function synthDemo(sr) {\r
    sr = sr || 44100;\r
    var bpm = 100, beat = 60 / bpm, bar = 4 * beat, bars = 12, dur = bars * bar + 2.2;\r
    var n = Math.ceil(dur * sr), seed = 12345;\r
    function rnd() { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; }\r
    function gains(pan) { var a = (pan + 1) * Math.PI / 4; return [Math.cos(a) * Math.SQRT2, Math.sin(a) * Math.SQRT2]; }\r
    function bus() { return [new Float32Array(n), new Float32Array(n)]; }\r
    var drums = bus(), bass = bus(), pads = bus(), plk = bus(), vox = bus();\r
    var truth = { kick: [], snare: [], hat: [], words: [], notes: [], bass: [] };\r
    function add(b, j, l, r) { if (j >= 0 && j < n) { b[0][j] += l; b[1][j] += r; } }\r
\r
    function kick(t) {\r
      var s0 = Math.round(t * sr), ln = Math.round(0.42 * sr), ph = 0;\r
      for (var i = 0; i < ln; i++) {\r
        var tt = i / sr, f = 46 + 110 * Math.exp(-tt * 32); ph += 2 * Math.PI * f / sr;\r
        var e = Math.exp(-tt * 7) * Math.min(1, tt / 0.0015), click = i < 0.004 * sr ? (rnd() * 2 - 1) * 0.25 * (1 - i / (0.004 * sr)) : 0;\r
        var v = Math.sin(ph) * e + click; add(drums, s0 + i, v, v);\r
      }\r
      truth.kick.push(t);\r
    }\r
    function snare(t) {\r
      var s0 = Math.round(t * sr), ln = Math.round(0.3 * sr), bp = biquad('bp', 2400, 0.7, sr), hp = biquad('hp', 600, 0.7, sr);\r
      for (var i = 0; i < ln; i++) {\r
        var tt = i / sr, nz = hp(bp(rnd() * 2 - 1)) * 2.4 * Math.exp(-tt * 18), body = Math.sin(2 * Math.PI * 185 * tt) * 0.5 * Math.exp(-tt * 30);\r
        var v = (nz + body) * 0.62; add(drums, s0 + i, v, v * 0.92);\r
      }\r
      truth.snare.push(t);\r
    }\r
    function hat(t, g) {\r
      var s0 = Math.round(t * sr), ln = Math.round(0.09 * sr), h1 = biquad('hp', 7000, 0.7, sr), h2 = biquad('hp', 7000, 0.7, sr);\r
      for (var i = 0; i < ln; i++) { var v = h2(h1(rnd() * 2 - 1)) * Math.exp(-i / sr * 60) * g; add(drums, s0 + i, v * 0.75, v * 1.15); }\r
      truth.hat.push(t);\r
    }\r
    function bassNote(t, d, m) {\r
      truth.bass.push([t, d, m]);\r
      var f = mtof(m), s0 = Math.round(t * sr), ln = Math.round((d + 0.08) * sr), ph = 0, l1 = 0, l2 = 0, a = 1 - Math.exp(-2 * Math.PI * 700 / sr);\r
      for (var i = 0; i < ln; i++) {\r
        var tt = i / sr; ph += f / sr; ph -= Math.floor(ph);\r
        var saw = 2 * ph - 1; l1 += a * (saw - l1); l2 += a * (l1 - l2);\r
        var e = Math.min(1, tt / 0.006) * (tt > d ? Math.max(0, 1 - (tt - d) / 0.08) : 1) * (0.75 + 0.25 * Math.exp(-tt * 5));\r
        var v = (l2 * 0.9 + Math.sin(2 * Math.PI * ph) * 0.7) * e; add(bass, s0 + i, v, v);\r
      }\r
    }\r
    function pad(t, d, m, pan) {\r
      var f = mtof(m), s0 = Math.round(t * sr), rel = 0.5, ln = Math.round((d + rel) * sr), gg = gains(pan);\r
      for (var i = 0; i < ln; i++) {\r
        var tt = i / sr, w = 2 * Math.PI * f * tt, e = Math.min(1, tt / 0.35) * (tt > d ? Math.max(0, 1 - (tt - d) / rel) : 1);\r
        var v = (Math.sin(w) + 0.12 * Math.sin(2 * w) + 0.05 * Math.sin(3 * w)) * e; add(pads, s0 + i, v * gg[0], v * gg[1]);\r
      }\r
    }\r
    function pluck(t, m, pan) {\r
      var f = mtof(m), s0 = Math.round(t * sr), ln = Math.round(0.5 * sr), gg = gains(pan), ph = 0, lp = 0, a = 1 - Math.exp(-2 * Math.PI * 4500 / sr);\r
      for (var i = 0; i < ln; i++) {\r
        var tt = i / sr; ph += f / sr; ph -= Math.floor(ph); lp += a * ((ph < 0.5 ? 1 : -1) - lp);\r
        var v = lp * Math.exp(-tt * 6) * Math.min(1, tt / 0.002); add(plk, s0 + i, v * gg[0], v * gg[1]);\r
      }\r
    }\r
    var VOW = { a: [730, 1090, 2440], o: [570, 840, 2410], e: [420, 2100, 2900], u: [440, 1020, 2240], i: [400, 1900, 2550] };\r
    function sing(t, d, m, prevM, vowel, cons) {\r
      truth.notes.push([t, d, m]);\r
      var f1 = mtof(m), fp = prevM ? mtof(prevM) : f1, s0 = Math.round(t * sr), rel = 0.07, ln = Math.round((d + rel) * sr), Fm = VOW[vowel];\r
      var b1 = biquad('bp', Fm[0], 3, sr), b2 = biquad('bp', Fm[1], 4.5, sr), b3 = biquad('bp', Fm[2], 6, sr), bn = biquad('bp', 4500, 1.2, sr), bc = biquad('hp', 3500, 0.7, sr), ph = 0;\r
      for (var i = 0; i < ln; i++) {\r
        var tt = i / sr, glide = tt < 0.05 ? fp + (f1 - fp) * (tt / 0.05) : f1;\r
        var vib = tt > 0.2 ? Math.min(1, (tt - 0.2) / 0.3) * 0.35 : 0, f = glide * Math.pow(2, vib * Math.sin(2 * Math.PI * 5.6 * tt) / 12);\r
        ph += f / sr; ph -= Math.floor(ph);\r
        var src = 2 * ph - 1, e = Math.min(1, tt / 0.035) * (tt > d ? Math.max(0, 1 - (tt - d) / rel) : 1);\r
        var y = (b1(src) + b2(src) * 0.55 + b3(src) * 0.3) * e, br = bn(rnd() * 2 - 1) * e * 0.035, cn = cons ? bc(rnd() * 2 - 1) * 0.15 * Math.max(0, 1 - tt / 0.04) : 0;\r
        var v = y + br + cn; add(vox, s0 + i, v, v);\r
      }\r
    }\r
\r
    var CH = [[57, 60, 64], [53, 57, 60], [52, 55, 60], [55, 59, 62]], ROOT = [33, 29, 36, 31], ORDER = [0, 1, 2, 3, 0, 1, 2, 3, 0, 1, 2, 0];\r
    for (var b = 0; b < bars; b++) {\r
      var t0 = b * bar, c = ORDER[b], last = b === bars - 1;\r
      CH[c].forEach(function (m, i) { pad(t0, last ? bar + 1 : bar - 0.05, m, [-0.75, 0.75, 0.55][i]); });\r
      for (var e8 = 0; e8 < (last ? 2 : 8); e8++) hat(t0 + e8 * beat / 2, e8 % 2 ? 0.8 : 0.55);\r
      if (b >= 2) {\r
        kick(t0); kick(t0 + 2 * beat); if (!last) kick(t0 + 2.5 * beat);\r
        if (!last) { snare(t0 + beat); snare(t0 + 3 * beat); }\r
        var r = ROOT[c];\r
        (last ? [[0, 3.5, 0]] : [[0, 0.7, 0], [0.75, 0.25, 0], [1.5, 0.5, 12], [2, 0.7, 0], [3, 0.45, 7], [3.5, 0.45, 12]]).forEach(function (p) { bassNote(t0 + p[0] * beat, p[1] * beat, r + p[2]); });\r
      }\r
      if (b >= 6 && !last) [0, 1, 2, 1, 0, 2, 1, 2].forEach(function (ix, i) { pluck(t0 + i * beat / 2, CH[c][ix] + 12, -0.8); });\r
    }\r
    /* sung melody: [word, [[beat, beats, midi, vowel, consonant], ...]] per line (2 bars each, from bar 4) */\r
    var MEL = [\r
      [['Shake', [[0, 0.75, 69, 'e', 1]]], ['the', [[0.75, 0.25, 69, 'a', 1]]], ['page,', [[1, 1, 72, 'e', 1]]], ['the', [[2, 0.5, 71, 'a', 1]]], ['bass', [[2.5, 0.5, 69, 'a', 1]]], ['is', [[3, 1, 67, 'i', 0]]], ['low', [[4, 2.5, 64, 'o', 1]]]],\r
      [['Every', [[0, 0.5, 64, 'e', 0], [0.5, 0.5, 67, 'i', 1]]], ['hit', [[1, 1, 72, 'i', 1]]], ['leaves', [[2, 1, 71, 'e', 1]]], ['ink', [[3, 1, 67, 'i', 0]]], ['below', [[4, 0.5, 67, 'i', 1], [4.5, 2.5, 62, 'o', 1]]]],\r
      [['Sing', [[0, 1, 64, 'i', 1]]], ['it', [[1, 0.5, 67, 'i', 0]]], ['higher,', [[1.5, 0.5, 69, 'a', 1], [2, 1, 72, 'a', 0]]], ['watch', [[3, 0.5, 74, 'o', 1]]], ['it', [[3.5, 0.5, 76, 'i', 0]]], ['climb', [[4, 2.5, 81, 'a', 1]]]],\r
      [['Words', [[0, 1, 79, 'u', 1]]], ['arrive', [[1, 0.5, 76, 'a', 0], [1.5, 1.5, 74, 'a', 1]]], ['right', [[3, 1, 72, 'a', 1]]], ['on', [[4, 0.5, 71, 'o', 0]]], ['time', [[4.5, 3, 69, 'a', 1]]]]\r
    ];\r
    var prev = 0;\r
    MEL.forEach(function (line, li) {\r
      var lt = (4 + li * 2) * bar;\r
      line.forEach(function (wd) {\r
        truth.words.push(lt + wd[1][0][0] * beat);\r
        wd[1].forEach(function (nt) { sing(lt + nt[0] * beat, nt[1] * beat - 0.03, nt[2], prev, nt[3], nt[4]); prev = nt[2]; });\r
      });\r
      prev = 0;\r
    });\r
\r
    function rms(b) { var s = 0, c = 0; for (var i = 0; i < n; i += 3) { var v = b[0][i]; if (v !== 0) { s += v * v; c++; } } return Math.sqrt(s / Math.max(1, c)) + 1e-9; }\r
    var mix = [[drums, 0.32], [bass, 0.2], [pads, 0.07], [plk, 0.06], [vox, 0.16]];\r
    var L = new Float32Array(n), R = new Float32Array(n), peak = 0, i;\r
    mix.forEach(function (mx) { var g = mx[1] / rms(mx[0]); for (i = 0; i < n; i++) { L[i] += mx[0][0][i] * g; R[i] += mx[0][1][i] * g; } });\r
    for (i = 0; i < n; i++) { var a = Math.abs(L[i]), bb = Math.abs(R[i]); if (a > peak) peak = a; if (bb > peak) peak = bb; }\r
    var gN = 0.89 / peak; for (i = 0; i < n; i++) { L[i] *= gN; R[i] *= gN; }\r
    return { L: L, R: R, sr: sr, truth: truth, lyrics: DEMO_LYRICS };\r
  }\r
\r
  /* ---------------------------------------------------------------- lyrics */\r
  var CJK = /[぀-ヿ㐀-鿿가-힯]/g;\r
  function syllableCount(word) {\r
    var cj = word.match(CJK); if (cj) return cj.length;\r
    var w = word.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z]/g, '');\r
    if (!w) return /\\d/.test(word) ? Math.max(1, word.replace(/\\D/g, '').length) : 0;\r
    if (w.length <= 3) return 1;\r
    w = w.replace(/(?:[^laeiouy]es|[^laeiouy]ed|[^laeiouy]e)$/, '').replace(/^y/, '');\r
    var mt = w.match(/[aeiouy]{1,2}/g);\r
    return Math.max(1, mt ? mt.length : 1);\r
  }\r
\r
  /* A whole lyrics web page pasted in (title line ending in "Lyrics", recommendations, "Embed", footer links)\r
     is cut down to the lyrics themselves. Plain lyrics pass through untouched. */\r
  function cleanPastedLyrics(text) {\r
    var src = String(text || '').replace(/\\r/g, ''), lines = src.split('\\n'), start = 0, end = lines.length, changed = false, i, j;\r
    if (!/(^|\\n)\\s*\\d*\\s*Embed\\s*($|\\n)|You might also like|Contributors|Genius/i.test(src)) return { text: src, cleaned: false };\r
    for (i = 0; i < Math.min(lines.length, 40); i++) {\r
      if (/\\S\\s*Lyrics\\s*(\\[[^\\]]*\\])?\\s*$/.test(lines[i]) && !/^\\s*\\[/.test(lines[i])) { start = i + 1; changed = true; break; }\r
    }\r
    for (i = start; i < lines.length; i++) {\r
      var t = lines[i].trim();\r
      if (/^\\d*\\s*Embed$/i.test(t) || /^(About|Q&A|Credits|Comments|Sign Up|Have the inside scoop on this song\\?)$/i.test(t)) { end = i; changed = true; break; }\r
      if (/^You might also like/i.test(t)) {\r
        var more = false;\r
        for (j = i + 1; j < lines.length; j++) { var u = lines[j].trim(); if (/^\\[[^\\]]+\\]$/.test(u)) { more = true; break; } if (/^\\d*\\s*Embed$/i.test(u)) break; }\r
        if (!more) { end = i; changed = true; break; }\r
        lines[i] = ''; changed = true;\r
      }\r
    }\r
    var out = lines.slice(start, end).map(function (l) { var m = l.replace(/\\d*Embed\\s*$/, ''); if (m !== l) changed = true; return m; });\r
    return { text: out.join('\\n').replace(/^\\s+|\\s+$/g, ''), cleaned: changed };\r
  }\r
\r
  /* A short fingerprint of a lyric line (case, accents and punctuation ignored), used to match timing to pasted text. */\r
  function normLine(s) { return String(s).normalize('NFKD').replace(/[\\u0300-\\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ''); }\r
  function lineHash(s) {\r
    var n = normLine(s), h = 0x811c9dc5;\r
    for (var i = 0; i < n.length; i++) { h ^= n.charCodeAt(i); h = Math.imul(h, 0x01000193); }\r
    return (h >>> 0).toString(36);\r
  }\r
\r
  /* Lines of words. Section headers like [Chorus] and blank lines are dropped. */\r
  function parseLyrics(text) {\r
    var lines = [];\r
    String(text || '').replace(/\\r/g, '').split('\\n').forEach(function (raw) {\r
      var s = raw.trim();\r
      if (!s || /^\\[[^\\]]*\\]$/.test(s) || /^\\{[^}]*\\}$/.test(s)) return;\r
      var words = s.split(/\\s+/).filter(Boolean).map(function (w) { return { text: w, syl: syllableCount(w) }; }).filter(function (w) { return w.syl > 0; });\r
      if (words.length) lines.push({ text: s, words: words });\r
    });\r
    return lines;\r
  }\r
\r
  /* Parse .lrc (line stamps [mm:ss.xx], optional word stamps <mm:ss.xx>). Returns {lines, anchors, wordTimes}. */\r
  function parseLRC(text) {\r
    var out = [], stampRe = /\\[(\\d+):(\\d+(?:[.:]\\d+)?)\\]/g, offset = 0;\r
    var om = /\\[offset:\\s*([+-]?\\d+)\\]/i.exec(text); if (om) offset = parseInt(om[1], 10) / 1000;\r
    String(text || '').replace(/\\r/g, '').split('\\n').forEach(function (raw) {\r
      var stamps = [], m, last = 0;\r
      stampRe.lastIndex = 0;\r
      while ((m = stampRe.exec(raw))) { stamps.push(parseInt(m[1], 10) * 60 + parseFloat(m[2].replace(':', '.'))); last = stampRe.lastIndex; }\r
      if (!stamps.length) return;\r
      var body = raw.slice(last).trim(); if (!body) return;\r
      var wt = [], words = [], wre = /<(\\d+):(\\d+(?:\\.\\d+)?)>\\s*([^<]*)/g, wm;\r
      if (/<\\d+:\\d+/.test(body)) {\r
        while ((wm = wre.exec(body))) {\r
          var tw = parseInt(wm[1], 10) * 60 + parseFloat(wm[2]);\r
          wm[3].trim().split(/\\s+/).filter(Boolean).forEach(function (w, i) { words.push(w); wt.push(i === 0 ? tw : null); });\r
        }\r
      } else words = body.split(/\\s+/).filter(Boolean);\r
      stamps.forEach(function (st) {\r
        out.push({ t: st - offset, text: words.join(' '), words: words.map(function (w) { return { text: w, syl: Math.max(1, syllableCount(w)) }; }), wt: wt.length ? wt.map(function (x) { return x == null ? null : x - offset; }) : null });\r
      });\r
    });\r
    out.sort(function (a, b) { return a.t - b.t; });\r
    return out;\r
  }\r
\r
  function sylSeq(lines) {\r
    var S = [];\r
    lines.forEach(function (ln, li) {\r
      ln.words.forEach(function (w, wi) {\r
        for (var k = 0; k < w.syl; k++) S.push({ li: li, wi: wi, first: k === 0, lineStart: wi === 0 && k === 0, lineEnd: wi === ln.words.length - 1 && k === w.syl - 1 });\r
      });\r
    });\r
    return S;\r
  }\r
\r
  /* DP: place every lyric syllable on a detected onset (in order).\r
     Line starts like to follow pauses, line ends like to precede them, and syllables inside a line\r
     pay for going much faster or slower than the song's typical pace (sigma). */\r
  function dpPlace(S, O, opt) {\r
    opt = opt || {};\r
    var nS = S.length, nO = O.length; if (!nS || !nO) return null;\r
    var SKIP = opt.skip != null ? opt.skip : 0.3, DUP = 1.1, EDGE = 0.06, INF = 1e18, W = 14;\r
    var sigma = opt.sigma || 0.3;\r
    var prev = new Float64Array(nO), cur = new Float64Array(nO), back = new Int32Array(nS * nO), i, j, q;\r
    var skc = new Float64Array(nO + 1); /* prefix sums of skip costs */\r
    for (j = 0; j < nO; j++) skc[j + 1] = skc[j] + SKIP * (0.4 + O[j].s);\r
    function local(si, oj) {\r
      var sy = S[si], o = O[oj], c = 0;\r
      if (sy.lineStart) c += 3 * (1 - Math.min(o.gap, 0.3) / 0.3);\r
      else if (o.gap > 0.6) c += 2.2 * Math.min(1, (o.gap - 0.6) / 1.2) + 0.6;\r
      if (sy.lineEnd) { var nx = O[oj + 1], ng = nx ? nx.gap : 5; c += 1.5 * (1 - Math.min(ng, 0.3) / 0.3); }\r
      if (sy.anchor != null) c += 6 * Math.min(2, Math.abs(o.t - sy.anchor));\r
      return c;\r
    }\r
    function pace(d) {\r
      if (d < 0.6 * sigma) return 0.9 * Math.log(0.6 * sigma / Math.max(d, 0.02));\r
      if (d > 4 * sigma) return 0.3 * Math.log(d / (4 * sigma));\r
      return 0;\r
    }\r
    for (j = 0; j < nO; j++) prev[j] = EDGE * j + local(0, j);\r
    for (i = 1; i < nS; i++) {\r
      var ls = S[i].lineStart, run = INF, runArg = -1;\r
      for (j = 0; j < nO; j++) {\r
        var bestV = INF, bestA = -1;\r
        if (ls) {\r
          /* new line: any earlier onset, paying only for skipped onsets */\r
          if (j > 0) { var sk = skc[j] - skc[j - 1], cand = prev[j - 1]; if (run + sk < cand) run += sk; else { run = cand; runArg = j - 1; } }\r
          bestV = run; bestA = runArg;\r
        } else {\r
          for (q = Math.max(0, j - W); q < j; q++) {\r
            if (prev[q] >= INF) continue;\r
            var v = prev[q] + (skc[j] - skc[q + 1]) + pace(O[j].t - O[q].t);\r
            if (v < bestV) { bestV = v; bestA = q; }\r
          }\r
        }\r
        var dupV = prev[j] + DUP;\r
        if (dupV < bestV) { bestV = dupV; bestA = j; }\r
        cur[j] = bestA < 0 ? INF : bestV + local(i, j);\r
        back[i * nO + j] = bestA;\r
      }\r
      var tmp = prev; prev = cur; cur = tmp;\r
    }\r
    var endJ = -1, endV = INF;\r
    for (j = 0; j < nO; j++) { var vv = prev[j] + EDGE * (nO - 1 - j); if (vv < endV) { endV = vv; endJ = j; } }\r
    if (endJ < 0) return null;\r
    var place = new Int32Array(nS); place[nS - 1] = endJ;\r
    for (i = nS - 1; i > 0; i--) place[i - 1] = back[i * nO + place[i]];\r
    return place;\r
  }\r
\r
  /* typical seconds per syllable: voiced time / syllables, clamped */\r
  function paceOf(O, nSyl) {\r
    var tot = 0, seen = {};\r
    O.forEach(function (o) { var k = o.runEnd.toFixed(3); if (!seen[k] && o.gap > 0) { seen[k] = 1; } });\r
    for (var i = 0; i < O.length; i++) { var nx = O[i + 1]; tot += Math.min(nx && nx.gap === 0 ? nx.t : O[i].runEnd, O[i].runEnd) - O[i].t; }\r
    return Math.max(0.15, Math.min(0.6, tot / Math.max(1, nSyl)));\r
  }\r
\r
  /* Convert syllable placements to word start times. Shared onsets are spread toward the next onset. */\r
  function wordTimes(lines, S, O, place) {\r
    var res = lines.map(function (ln) { return ln.words.map(function () { return null; }); });\r
    var i = 0;\r
    while (i < S.length) {\r
      var j = place[i], k = i; while (k + 1 < S.length && place[k + 1] === j) k++;\r
      var t0 = O[j].t, t1 = j + 1 < O.length ? Math.min(O[j + 1].t, O[j].runEnd + 0.15) : O[j].runEnd;\r
      if (t1 <= t0) t1 = t0 + 0.25 * (k - i + 1);\r
      for (var q = i; q <= k; q++) { var sy = S[q]; if (sy.first) res[sy.li][sy.wi] = t0 + (t1 - t0) * (q - i) / (k - i + 1); }\r
      i = k + 1;\r
    }\r
    return res;\r
  }\r
\r
  function onsetList(ana) {\r
    var O = [], a = ana.onsets;\r
    for (var i = 0; i < a.length; i += 4) O.push({ t: a[i], gap: a[i + 1], runEnd: a[i + 2], s: a[i + 3] });\r
    return O;\r
  }\r
\r
  /* Fully automatic placement. */\r
  function alignLyrics(lines, ana) {\r
    var O = onsetList(ana), S = sylSeq(lines);\r
    if (!S.length) return [];\r
    if (O.length < 2) return evenSpread(lines, 0, ana.dur);\r
    var place = dpPlace(S, O, { sigma: paceOf(O, S.length) });\r
    if (!place) return evenSpread(lines, 0, ana.dur);\r
    return wordTimes(lines, S, O, place);\r
  }\r
\r
  function evenSpread(lines, t0, t1) {\r
    var tot = 0; lines.forEach(function (l) { l.words.forEach(function (w) { tot += w.syl; }); });\r
    var per = (t1 - t0) / Math.max(1, tot), t = t0;\r
    return lines.map(function (l) { return l.words.map(function (w) { var s = t; t += per * w.syl; return s; }); });\r
  }\r
\r
  /* Placement when line start times are known (tap-along or .lrc). */\r
  function alignToAnchors(lines, anchors, ana) {\r
    var O = onsetList(ana), res = [], nAll = 0;\r
    lines.forEach(function (l) { l.words.forEach(function (w) { nAll += w.syl; }); });\r
    var sig = paceOf(O, nAll);\r
    lines.forEach(function (ln, li) {\r
      var a = anchors[li];\r
      if (a == null) { res.push(ln.words.map(function () { return null; })); return; }\r
      var next = ana.dur; for (var q = li + 1; q < anchors.length; q++) if (anchors[q] != null) { next = anchors[q]; break; }\r
      var span = O.filter(function (o) { return o.t >= a - 0.2 && o.t < next - 0.05; });\r
      var S = sylSeq([ln]);\r
      if (span.length >= 1) {\r
        S.forEach(function (sy, k) { sy.li = 0; sy.lineStart = k === 0; if (k === 0) sy.anchor = a; });\r
        var place = dpPlace(S, span, { skip: 0.25, sigma: sig });\r
        var wt = place ? wordTimes([ln], S, span, place)[0] : ln.words.map(function () { return null; });\r
        wt[0] = a;\r
        for (var w = 1; w < wt.length; w++) if (wt[w] == null || wt[w] <= wt[w - 1]) wt[w] = wt[w - 1] + 0.12;\r
        res.push(wt);\r
      } else {\r
        var dur = Math.min(next - a, 0.32 * S.length + 0.3), tot = S.length, t = a;\r
        res.push(ln.words.map(function (wd) { var s = t; t += dur * wd.syl / tot; return s; }));\r
      }\r
    });\r
    return res;\r
  }\r
\r
  return {\r
    analyze: analyze, synthDemo: synthDemo, parseLyrics: parseLyrics, parseLRC: parseLRC,\r
    alignLyrics: alignLyrics, alignToAnchors: alignToAnchors, syllableCount: syllableCount,\r
    cleanPastedLyrics: cleanPastedLyrics, lineHash: lineHash, DRUM_BANDS: DRUM_BANDS,\r
    mtof: mtof, ftom: ftom, DEMO_LYRICS: DEMO_LYRICS\r
  };\r
})();\r
\r
/* Worker glue: only active when this file runs inside a Web Worker. */\r
if (typeof WorkerGlobalScope !== 'undefined' && typeof self !== 'undefined' && self instanceof WorkerGlobalScope) {\r
  self.onmessage = function (e) {\r
    var d = e.data, lastP = -1;\r
    try {\r
      if (d.cmd === 'ping') { self.postMessage({ type: 'pong' }); return; }\r
      if (d.cmd === 'demo') {\r
        var demo = DSP.synthDemo(44100);\r
        self.postMessage({ type: 'demo', L: demo.L, R: demo.R, sr: demo.sr, lyrics: demo.lyrics }, [demo.L.buffer, demo.R.buffer]);\r
        return;\r
      }\r
      var res = DSP.analyze(d.L, d.R, d.sr, function (label, p) {\r
        if (p - lastP >= 0.02 || p === 1) { lastP = p; self.postMessage({ type: 'progress', label: label, p: p }); }\r
      }, d.opts);\r
      var tx = [res.bassN, res.bassHz, res.bassBr, res.leadHz, res.leadN, res.leadBr, res.leadNz, res.events, res.segs, res.onsets].map(function (a) { return a.buffer; });\r
      self.postMessage({ type: 'done', res: res }, tx);\r
    } catch (err) {\r
      self.postMessage({ type: 'error', message: String((err && err.message) || err) });\r
    }\r
  };\r
}\r
if (typeof module !== 'undefined') module.exports = DSP;\r
`})),a=e((()=>{})),o=e((()=>{})),s=e((()=>{a(),o()}));function c(e){return typeof e==`function`}function l(e){for(var t=0;t<e.length;t++)e[t]()}function u(){var e,t;return{promise:new Promise((n,r)=>{e=n,t=r}),resolve:e,reject:t}}var d,f,p,m,h,g,_,v,y,b,x,S,C=e((()=>{d=Array.isArray,f=Array.prototype.indexOf,p=Array.prototype.includes,m=Array.from,h=Object.defineProperty,g=Object.getOwnPropertyDescriptor,_=Object.getOwnPropertyDescriptors,v=Object.prototype,y=Array.prototype,b=Object.getPrototypeOf,x=Object.isExtensible,S=()=>{}})),w,T,E,ee,D,O,te,ne,re,k,ie,ae,oe,se,A,j,ce,le,M,N,ue,P,de,fe,pe,me,F=e((()=>{w=1<<24,T=1024,E=2048,ee=4096,D=8192,O=16384,te=32768,ne=1<<25,re=65536,k=1<<19,ie=1<<20,ae=1<<25,oe=1<<21,se=1<<22,A=1<<23,j=Symbol(`$state`),ce=Symbol(`component`),le=Symbol(`legacy props`),M=Symbol(``),N=Symbol(`attributes`),ue=Symbol(`class`),P=Symbol(`style`),de=Symbol(`text`),fe=Symbol(`form reset`),pe=new class extends Error{name=`StaleReactionError`;message="The reaction that called `getAbortSignal()` was re-run or destroyed"},me=!!globalThis.document?.contentType&&globalThis.document.contentType.includes(`xml`)})),he,I,ge,_e=e((()=>{he={},I=Symbol(`uninitialized`),ge=`http://www.w3.org/1999/xhtml`}));function ve(){console.warn(`https://svelte.dev/e/derived_inert`)}function ye(e){console.warn(`https://svelte.dev/e/hydration_mismatch`)}function be(){console.warn(`https://svelte.dev/e/select_multiple_invalid_value`)}function xe(){console.warn(`https://svelte.dev/e/svelte_boundary_reset_noop`)}var Se=e((()=>{s()}));function Ce(e){R=e}function we(e){if(e===null)throw ye(),he;return z=e}function Te(){return we(jn(z))}function L(e){if(R){if(jn(z)!==null)throw ye(),he;z=e}}function Ee(e=1){if(R){for(var t=e,n=z;t--;)n=jn(n);z=n}}function De(e=!0){for(var t=0,n=z;;){if(n.nodeType===8){var r=n.data;if(r===`]`){if(t===0)return n;--t}else(r===`[`||r===`[!`||r[0]===`[`&&!isNaN(Number(r.slice(1))))&&(t+=1)}var i=jn(n);e&&n.remove(),n=i}}function Oe(e){if(!e||e.nodeType!==8)throw ye(),he;return e.data}var R,z,B=e((()=>{F(),_e(),Se(),G(),R=!1}));function ke(e){return e===this.v}function Ae(e,t){return e==e?e!==t||typeof e==`object`&&!!e||typeof e==`function`:t==t}function je(e){return!Ae(e,this.v)}var Me=e((()=>{})),Ne=e((()=>{s()}));function Pe(){throw Error(`https://svelte.dev/e/async_derived_orphan`)}function Fe(e,t,n){throw Error(`https://svelte.dev/e/each_key_duplicate`)}function Ie(e){throw Error(`https://svelte.dev/e/effect_in_teardown`)}function Le(){throw Error(`https://svelte.dev/e/effect_in_unowned_derived`)}function Re(e){throw Error(`https://svelte.dev/e/effect_orphan`)}function ze(){throw Error(`https://svelte.dev/e/effect_update_depth_exceeded`)}function Be(e){throw Error(`https://svelte.dev/e/props_invalid_value`)}function Ve(){throw Error(`https://svelte.dev/e/state_descriptors_fixed`)}function He(){throw Error(`https://svelte.dev/e/state_prototype_fixed`)}function Ue(){throw Error(`https://svelte.dev/e/state_unsafe_mutation`)}function We(){throw Error(`https://svelte.dev/e/svelte_boundary_reset_onerror`)}var Ge=e((()=>{s(),Ne()})),Ke,qe,Je=e((()=>{Ke=!1,qe=!1})),Ye=e((()=>{C()})),Xe=e((()=>{Ye(),F(),K(),Q()})),Ze=e((()=>{s(),C(),Ne()}));function Qe(e){rt=e}function $e(e,t=!1,n){rt={p:rt,i:!1,c:null,e:null,s:e,x:null,r:X,l:qe&&!t?{s:null,u:null,$:[]}:null}}function et(e){var t=rt,n=t.e;if(n!==null){t.e=null;for(var r of n)Qn(r)}return e!==void 0&&(t.x=e),t.i=!0,rt=t.p,tt(e)}function tt(e={}){return h(e,ce,{value:!0}),e}function nt(){return!qe||rt!==null&&rt.l===null}var rt,it=e((()=>{s(),Ge(),Q(),K(),Je(),F(),C(),rt=null}));function at(){var e=ct;ct=[],l(e)}function ot(e){if(ct.length===0&&!$t){var t=ct;queueMicrotask(()=>{t===ct&&at()})}ct.push(e)}function st(){for(;ct.length>0;)at()}var ct,lt=e((()=>{C(),cn(),ct=[]}));function V(e,t){e.f=e.f&dt|t}function ut(e){e.f&512||e.deps===null?V(e,T):V(e,ee)}var dt,ft=e((()=>{F(),dt=~(E|ee|T)}));function pt(e,t,n){e.f&2048?t.add(e):e.f&4096&&n.add(e),V(e,T)}var mt=e((()=>{F(),ft()})),ht=e((()=>{F(),Ye(),Q()}));function gt(e,t){if(t){let t=document.body;e.autofocus=!0,ot(()=>{document.activeElement===t&&e.focus()})}}function _t(){vt||(vt=!0,document.addEventListener(`reset`,e=>{Promise.resolve().then(()=>{if(!e.defaultPrevented)for(let t of e.target.elements)t[fe]?.()})},{capture:!0}))}var vt,yt=e((()=>{B(),G(),lt(),F(),vt=!1}));function bt(e){var t=Y,n=X;xr(null),Sr(null);try{return e()}finally{xr(t),Sr(n)}}function xt(e,t,n,r=n){e.addEventListener(t,()=>bt(n));let i=e[fe];i?e[fe]=()=>{i(),r(!0)}:e[fe]=()=>r(!0),_t()}var St=e((()=>{K(),Q(),F(),yt()}));function Ct(e,t,n,r){let i=nt()?kt:Mt;var a=e.filter(e=>!e.settled),o=t.map(i);if(n.length===0&&a.length===0){r(o);return}var s=X,c=wt(),l=a.length===1?a[0].promise:a.length>1?Promise.all(a.map(e=>e.promise)):null;function u(e){if(!(s.f&16384)){c();try{r([...o,...e])}catch(e){Wn(e,s)}Tt()}}var d=Et();if(n.length===0){l.then(()=>u([])).finally(d);return}function f(){Promise.all(n.map(e=>At(e))).then(u).catch(e=>Wn(e,s)).finally(d)}l?l.then(()=>{s.f&16384?d():(c(),f(),Tt())}):f()}function wt(){var e=X,t=Y,n=rt,r=H;return function(i=!0){Sr(e),xr(t),Qe(n),i&&!(e.f&16384)&&(r?.activate(),r?.apply())}}function Tt(e=!0){Dt=!1,Sr(null),xr(null),Qe(null),e&&H?.deactivate()}function Et(){var e=X,t=e.b,n=H,r=!!t?.is_rendered();return t?.update_pending_count(1,n),n.increment(r,e),()=>{t?.update_pending_count(-1,n),n.decrement(r,e)}}var Dt,Ot=e((()=>{F(),s(),it(),Gn(),Q(),cn(),zt(),K()}));function kt(e){var t=2|E;return X!==null&&(X.f|=k),{ctx:rt,deps:null,effects:null,equals:ke,f:t,fn:e,reactions:null,rv:0,v:I,wv:0,parent:X,ac:null}}function At(e,t,n){let r=X;r===null&&Pe();var i=void 0,a=ln(I),o=!Y,s=new Set;return tr(()=>{var t=X,n=u();i=n.promise;try{Promise.resolve(e()).then(n.resolve,e=>{e!==pe&&n.reject(e)}).finally(Tt)}catch(e){n.reject(e),Tt()}var c=H;if(o){if(t.f&32768)var l=Et();if(r.b?.is_rendered())c.async_deriveds.get(t)?.reject(Rt);else for(let e of s.values())e.reject(Rt);s.add(n),c.async_deriveds.set(t,n)}let d=(e,t=void 0)=>{l?.(),s.delete(n),t!==Rt&&(c.activate(),t?(a.f|=A,pn(a,t)):(a.f&8388608&&(a.f^=A),pn(a,e)),c.deactivate())};n.promise.then(d,e=>d(null,e||`unknown`))}),Xn(()=>{for(let e of s)e.reject(Rt)}),new Promise(e=>{function t(n){function r(){n===i?e(a):t(i)}n.then(r,r)}t(i)})}function jt(e){let t=kt(e);return Ke||Cr(t),t}function Mt(e){let t=kt(e);return t.equals=je,t}function Nt(e){var t=e.effects;if(t!==null){e.effects=null;for(var n=0;n<t.length;n+=1)ur(t[n])}}function Pt(e){var t,n=X,r=e.parent;if(!Lr&&r!==null&&e.v!==I&&r.f&24576)return ve(),e.v;Sr(r);try{Nt(e),t=Or(e)}finally{Sr(n)}return t}function Ft(e){var t=Pt(e);!e.equals(t)&&(e.wv=Tr(),(!H?.is_fork||e.deps===null)&&(H===null?e.v=t:(H.capture(e,t,!0),Xt?.capture(e,t,!0)),e.deps===null))?V(e,T):Lr||(Zt===null?ut(e):(Yn()||H?.is_fork)&&Zt.set(e,t))}function It(e){if(e.effects!==null)for(let t of e.effects)(t.teardown||t.ac)&&(t.teardown?.(),t.ac!==null&&bt(()=>{t.ac.abort(pe),t.ac=null}),t.fn!==null&&(t.teardown=S),jr(t,0),cr(t))}function Lt(e){if(e.effects!==null)for(let t of e.effects)t.teardown&&t.fn!==null&&Mr(t)}var Rt,zt=e((()=>{s(),F(),Q(),St(),Me(),Ge(),Se(),K(),Sn(),Ze(),Je(),it(),_e(),cn(),Ot(),C(),ft(),Rt=Symbol(`obsolete`)}));function Bt(e){var t=$t,n=Xt;Xt=null,$t=!0;try{var r;for(e&&(Bt(),r=e());;){if(st(),H===null)return r;H.flush()}}finally{$t=t,Xt=n}}function Vt(){try{ze()}catch(e){Wn(e,Qt)}}function Ht(e){var t=e.length;if(t!==0){for(var n=0;n<t;){var r=e[n++];if(!(r.f&24576)&&Er(r)&&(sn=new Set,Mr(r),r.deps===null&&r.first===null&&r.nodes===null&&r.teardown===null&&r.ac===null&&fr(r),sn?.size>0)){vn.clear();for(let e of sn){if(e.f&24576)continue;let t=[e],n=e.parent;for(;n!==null;)sn.has(n)&&(sn.delete(n),t.push(n)),n=n.parent;for(let e=t.length-1;e>=0;e--){let n=t[e];n.f&24576||Mr(n)}}sn.clear()}}sn=null}}function Ut(e,t,n,r){if(!n.has(e)&&(n.add(e),e.reactions!==null))for(let i of e.reactions){let e=i.f;e&2?Ut(i,t,n,r):e&4194320&&!(e&2048)&&Wt(i,t,r)&&(V(i,E),Gt(i))}}function Wt(e,t,n){let r=n.get(e);if(r!==void 0)return r;if(e.deps!==null)for(let r of e.deps){if(p.call(t,r))return!0;if(r.f&2&&Wt(r,t,n))return n.set(r,!0),!0}return n.set(e,!1),!1}function Gt(e){H.schedule(e)}function Kt(e,t){if(!(e.f&32&&e.f&1024)){e.f&2048?t.d.push(e):e.f&4096&&t.m.push(e),V(e,T);for(var n=e.first;n!==null;)Kt(n,t),n=n.next}}function qt(e){V(e,T);for(var t=e.first;t!==null;)qt(t),t=t.next}var Jt,Yt,H,Xt,Zt,Qt,$t,en,tn,nn,rn,an,on,sn,cn=e((()=>{F(),Je(),C(),Q(),Ge(),lt(),s(),Gn(),Sn(),K(),mt(),_e(),ft(),Ze(),ht(),zt(),Jt=null,Yt=null,H=null,Xt=null,Zt=null,Qt=null,$t=!1,en=!1,tn=null,nn=null,rn=0,an=1,on=class e{id=an++;#e=!1;linked=!0;#t=null;#n=null;async_deriveds=new Map;current=new Map;previous=new Map;#r=new Set;#i=new Set;#a=0;#o=new Map;#s=null;#c=[];#l=[];#u=new Set;#d=new Set;#f=new Map;#p=new Set;is_fork=!1;#m=!1;constructor(){Yt===null?Jt=Yt=this:(Yt.#n=this,this.#t=Yt),Yt=this}#h(){if(this.is_fork)return!0;for(let n of this.#o.keys()){for(var e=n,t=!1;e.parent!==null;){if(this.#f.has(e)){t=!0;break}e=e.parent}if(!t)return!0}return!1}skip_effect(e){this.#f.has(e)||this.#f.set(e,{d:[],m:[]}),this.#p.delete(e)}unskip_effect(e,t=e=>this.schedule(e)){var n=this.#f.get(e);if(n){this.#f.delete(e);for(var r of n.d)V(r,E),t(r);for(r of n.m)V(r,ee),t(r)}this.#p.add(e)}#g(){var e=[];for(let i of this.#c)if(!(i.f&16384||!(i.f&6144))){for(var t=i,n=!1;t.parent!==null;){t=t.parent;var r=t.f;if(r&96){if(!(r&1024)){n=!0;break}t.f^=T}}n||e.push(t)}return this.#c=[],e}#_(){this.#e=!0;for(let e of this.#u)this.#d.delete(e),V(e,E),this.schedule(e);for(let e of this.#d)V(e,ee),this.schedule(e);this.apply();for(var t=tn=[],n=[],r=nn=[];this.#c.length>0;){rn++>1e3&&(this.#C(),Vt());for(let e of this.#g())try{this.#v(e,t,n)}catch(t){throw qt(e),this.#h()||this.discard(),t}}if(H=null,r.length>0){var i=e.ensure();for(let e of r)i.schedule(e)}if(tn=null,nn=null,this.#h()){this.#x(n),this.#x(t);for(let[e,t]of this.#f)Kt(e,t);r.length>0&&H.#_();return}let a=this.#y();if(a)this.#x(n),this.#x(t),a.#b(this);else{this.#u.clear(),this.#d.clear();for(let e of this.#r)e(this);this.#r.clear(),Xt=this,Ht(n),Ht(t),Xt=null,this.#s?.resolve();var o=H;if(this.#a===0&&(this.#c.length===0||o!==null)&&(this.#C(),Ke&&(this.#S(),H=o)),this.#c.length>0){if(o!==null){for(let e of this.#c)o.#c.push(e);this.#c=[]}else o=this}o!==null&&(vn.clear(),o.#_())}}#v(e,t,n){e.f^=T;for(var r=e.first;r!==null;){var i=r.f,a=!!(i&96);if(!(a&&i&1024||i&8192||this.#f.has(r))&&r.fn!==null){a?r.f^=T:i&4?t.push(r):Ke&&i&16777224?n.push(r):Er(r)&&(i&16&&this.#d.add(r),Mr(r));var o=r.first;if(o!==null){r=o;continue}}for(;r!==null;){var s=r.next;if(s!==null){r=s;break}r=r.parent}}}#y(){for(var e=this.#t;e!==null;){if(!e.is_fork){for(let[t,[,n]]of this.current)if(e.current.has(t)&&!n)return e}e=e.#t}return null}#b(e){for(let[t,n]of e.current)!this.previous.has(t)&&e.previous.has(t)&&this.previous.set(t,e.previous.get(t)),this.current.set(t,n);for(let[t,n]of e.async_deriveds){let e=this.async_deriveds.get(t);e&&n.promise.then(e.resolve).catch(e.reject)}e.async_deriveds.clear(),this.transfer_effects(e.#u,e.#d);let t=e=>{var n=e.reactions;if(n!==null&&!(e.f&2&&!(e.f&6144)))for(let e of n){var r=e.f;if(r&2)t(e);else{var i=e;r&4194320&&!this.async_deriveds.has(i)&&(this.#d.delete(i),V(i,E),this.schedule(i))}}};for(let e of this.current.keys())t(e);this.oncommit(()=>e.discard()),e.#C(),H=this,this.#_()}#x(e){for(var t=0;t<e.length;t+=1)pt(e[t],this.#u,this.#d)}capture(e,t,n=!1){e.v!==I&&!this.previous.has(e)&&this.previous.set(e,e.v),e.f&8388608||(this.current.set(e,[t,n]),Zt?.set(e,t)),this.is_fork||(e.v=t)}activate(){H=this}deactivate(){H=null,Zt=null}flush(){try{en=!0,H=this,this.#_()}finally{rn=0,Qt=null,tn=null,nn=null,en=!1,H=null,Zt=null,vn.clear()}}discard(){for(let e of this.#i)e(this);this.#i.clear();for(let e of this.async_deriveds.values())e.reject(Rt);this.#C(),this.#s?.resolve()}register_created_effect(e){this.#l.push(e)}#S(){for(let u=Jt;u!==null;u=u.#n){var e=u.id<this.id,t=[];for(let[r,[i,a]]of this.current){if(u.current.has(r)){var n=u.current.get(r)[0];if(e&&i!==n)u.current.set(r,[i,a]);else continue}t.push(r)}if(e)for(let[e,t]of this.async_deriveds){let n=u.async_deriveds.get(e);n&&t.promise.then(n.resolve).catch(n.reject)}var r=[...u.current.keys()].filter(e=>!u.current.get(e)[1]);if(u.#e&&r.length!==0){var i=r.filter(e=>!this.current.has(e));if(i.length===0)e&&u.discard();else if(t.length>0){if(e)for(let e of this.#p)u.unskip_effect(e,e=>{e.f&4194320?u.schedule(e):u.#x([e])});u.activate();var a=new Set,o=new Map;for(var s of t)Ut(s,i,a,o);o=new Map;var c=[...u.current].filter(([e,t])=>{let n=this.current.get(e);return!n||n[0]!==t[0]||n[1]!==t[1]}).map(([e])=>e);if(c.length>0)for(let e of this.#l)!(e.f&155648)&&Wt(e,c,o)&&(e.f&4194320?(V(e,E),u.schedule(e)):u.#u.add(e));if(u.#c.length>0&&!u.#m){u.apply();for(var l of u.#g())u.#v(l,[],[])}u.deactivate()}}}}increment(e,t){if(this.#a+=1,e){let e=this.#o.get(t)??0;this.#o.set(t,e+1)}}decrement(e,t){if(--this.#a,e){let e=this.#o.get(t)??0;e===1?this.#o.delete(t):this.#o.set(t,e-1)}this.#m||(this.#m=!0,ot(()=>{this.#m=!1,this.linked&&this.flush()}))}transfer_effects(e,t){for(let t of e)this.#u.add(t);for(let e of t)this.#d.add(e);e.clear(),t.clear()}oncommit(e){this.#r.add(e)}ondiscard(e){this.#i.add(e)}settled(){return(this.#s??=u()).promise}static ensure(){if(H===null){let t=H=new e;!en&&!$t&&ot(()=>{t.#e||t.flush()})}return H}apply(){if(!Ke||!this.is_fork&&this.#t===null&&this.#n===null)Zt=null;else{Zt=new Map;for(let[e,[t]]of this.current)Zt.set(e,t);for(let t=Jt;t!==null;t=t.#n)if(!(t===this||t.is_fork)){var e=!1;if(t.id<this.id){for(let[n,[,r]]of t.current)if(!r&&this.current.has(n)){e=!0;break}}if(!e)for(let[e,n]of t.previous)Zt.has(e)||Zt.set(e,n)}}}schedule(e){Qt=e,e.b?.is_pending&&e.f&16777228&&!(e.f&32768)?e.b.defer_effect(e):this.#c.push(e)}#C(){if(this.linked){var e=this.#t,t=this.#n;e===null?Jt=t:e.#n=t,t===null?Yt=e:t.#t=e,this.linked=!1}}},sn=null}));function ln(e,t){return{f:0,v:e,reactions:null,equals:ke,rv:0,wv:0}}function un(e,t){let n=ln(e,t);return Cr(n),n}function dn(e,t=!1,n=!0){let r=ln(e);return t||(r.equals=je),qe&&n&&rt!==null&&rt.l!==null&&(rt.l.s??=[]).push(r),r}function fn(e,t,n=!1){return Y!==null&&(!Rr||Y.f&131072)&&nt()&&Y.f&4325394&&(zr===null||!zr.has(e))&&Ue(),pn(e,n?Cn(t):t,nn)}function pn(e,t,n=null){if(!e.equals(t)){Lr?vn.set(e,t):vn.has(e)||vn.set(e,e.v);var r=on.ensure();if(r.capture(e,t),e.f&2){let t=e;e.f&2048&&Pt(t),Zt===null&&ut(t)}e.wv=Tr(),bn=null,xn=0,gn(e,E,n),bn=null,nt()&&X!==null&&X.f&1024&&!(X.f&96)&&(Vr===null?wr([e]):Vr.push(e)),!r.is_fork&&_n.size>0&&!yn&&mn()}return t}function mn(){yn=!1;for(let e of _n){e.f&1024&&V(e,ee);let t;try{t=Er(e)}catch{t=!0}t&&Mr(e)}_n.clear()}function hn(e){fn(e,e.v+1)}function gn(e,t,n){var r=e.reactions;if(r!==null){var i=nt(),a=r.length;if(xn+=a,xn>1e5&&bn===null&&(bn=new Set),bn!==null){if(bn.has(e))return;bn.add(e)}for(var o=0;o<a;o++){var s=r[o],c=s.f;if(i||s!==X){var l=(c&E)===0;if(l&&V(s,t),c&131072)_n.add(s);else if(c&2){var u=s;Zt?.delete(u),gn(u,ee,n)}else if(l){var d=s;c&16&&sn!==null&&sn.add(d),n===null?Gt(d):n.push(d)}}}}}var _n,vn,yn,bn,xn,Sn=e((()=>{s(),Q(),Me(),F(),Ge(),Je(),Xe(),Ze(),it(),cn(),En(),zt(),ft(),_n=new Set,vn=new Map,yn=!1,bn=null,xn=0}));function Cn(e){if(typeof e!=`object`||!e||j in e||ce in e)return e;let t=b(e);if(t!==v&&t!==y)return e;var n=new Map,r=d(e),i=un(0),a=null,o=Wr,s=e=>{if(Wr===o)return e();var t=Y,n=Wr;xr(null),q(o);var r=e();return xr(t),q(n),r};return r&&n.set(`length`,un(e.length,a)),new Proxy(e,{defineProperty(e,t,r){(!(`value`in r)||r.configurable===!1||r.enumerable===!1||r.writable===!1)&&Ve();var i=n.get(t);return i===void 0?s(()=>{var e=un(r.value,a);return n.set(t,e),e}):fn(i,r.value,!0),!0},deleteProperty(e,t){var r=n.get(t);if(r===void 0){if(t in e){let e=s(()=>un(I,a));n.set(t,e),hn(i)}}else fn(r,I),hn(i);return!0},get(t,r,i){if(r===j)return e;var o=n.get(r),c=r in t;if(o===void 0&&(!c||g(t,r)?.writable)&&(o=s(()=>un(Cn(c?t[r]:I),a)),n.set(r,o)),o!==void 0){var l=J(o);return l===I?void 0:l}return Reflect.get(t,r,i)},getOwnPropertyDescriptor(e,t){this.has?.(e,t);var r=Reflect.getOwnPropertyDescriptor(e,t),i=n.get(t);if(i!==void 0){var a=J(i);if(a===I)return;if(r&&`value`in r)r.value=a;else return{enumerable:!0,configurable:!0,value:a,writable:!0}}return r},has(e,t){if(t===j)return!0;var r=n.get(t),i=r!==void 0&&r.v!==I||Reflect.has(e,t);return(r!==void 0||X!==null&&(!i||g(e,t)?.writable))&&(r===void 0&&(r=s(()=>un(i?Cn(e[t]):I,a)),n.set(t,r)),J(r)===I)?!1:i},set(e,t,o,c){var l=n.get(t),u=t in e;if(r&&t===`length`)for(var d=o;d<l.v;d+=1){var f=n.get(d+``);f===void 0?d in e&&(f=s(()=>un(I,a)),n.set(d+``,f)):fn(f,I)}if(l===void 0)(!u||g(e,t)?.writable)&&(l=s(()=>un(void 0,a)),fn(l,Cn(o)),n.set(t,l));else{u=l.v!==I;var p=s(()=>Cn(o));fn(l,p)}var m=Reflect.getOwnPropertyDescriptor(e,t);if(m?.set&&m.set.call(c,o),!u){if(r&&typeof t==`string`){var h=n.get(`length`),_=Number(t);Number.isInteger(_)&&_>=h.v&&fn(h,_+1)}hn(i)}return!0},ownKeys(e){J(i);var t=Reflect.ownKeys(e).filter(e=>{var t=n.get(e);return t===void 0||t.v!==I});for(var[r,a]of n)a.v!==I&&!(r in e)&&t.push(r);return t},setPrototypeOf(){He()}})}function wn(e){try{if(typeof e==`object`&&e&&j in e)return e[j]}catch{}return e}function Tn(e,t){return Object.is(wn(e),wn(t))}var En=e((()=>{s(),Q(),C(),Sn(),F(),_e(),Ge(),Xe(),Ze(),Je()})),Dn=e((()=>{Se(),En()}));function On(){if(Rn===void 0){Rn=window,zn=document,Bn=/Firefox/.test(navigator.userAgent);var e=Element.prototype,t=Node.prototype,n=Text.prototype;Vn=g(t,`firstChild`).get,Hn=g(t,`nextSibling`).get,x(e)&&(e[ue]=void 0,e[N]=null,e[P]=void 0,e.__e=void 0),x(n)&&(n[de]=void 0)}}function kn(e=``){return document.createTextNode(e)}function An(e){return Vn.call(e)}function jn(e){return Hn.call(e)}function U(e,t){if(!R)return An(e);var n=An(z);if(n===null)n=z.appendChild(kn());else if(t&&n.nodeType!==3){var r=kn();return n?.before(r),we(r),r}return t&&Ln(n),we(n),n}function Mn(e,t=!1){if(!R){var n=An(e);return n instanceof Comment&&n.data===``?jn(n):n}if(t){if(z?.nodeType!==3){var r=kn();return z?.before(r),we(r),r}Ln(z)}return z}function Nn(e,t=!1){if(!R)return An(e);var n=U(e,t);return L(e),n}function W(e,t=1,n=!1){let r=R?z:e;for(var i;t--;)i=r,r=jn(r);if(!R)return r;if(n){if(r?.nodeType!==3){var a=kn();return r===null?i?.after(a):r.before(a),we(a),a}Ln(r)}return we(r),r}function Pn(e){e.textContent=``}function Fn(){return!Ke||sn!==null?!1:(X.f&te)!==0}function In(e,t,n){return t==null||t===`http://www.w3.org/1999/xhtml`?n?document.createElement(e,{is:n}):document.createElement(e):n?document.createElementNS(t,e,{is:n}):document.createElementNS(t,e)}function Ln(e){if(e.nodeValue.length<65536)return;let t=e.nextSibling;for(;t!==null&&t.nodeType===3;)t.remove(),e.nodeValue+=t.nodeValue,t=e.nextSibling}var Rn,zn,Bn,Vn,Hn,G=e((()=>{B(),s(),Dn(),C(),Q(),Je(),F(),cn(),_e()}));function Un(e){var t=X;if(t===null)return Y.f|=A,e;if(!(t.f&32768)&&!(t.f&4))throw e;Wn(e,t)}function Wn(e,t){if(e===he)throw e;if(!(t!==null&&t.f&16384)){for(;t!==null;){if(t.f&128&&!(t.f&33570816)){if(!(t.f&32768))throw e;try{t.b.error(e);return}catch(t){e=t}}t=t.parent}throw e}}var Gn=e((()=>{s(),_e(),G(),F(),C(),Q()}));function Kn(e){X===null&&(Y===null&&Re(e),Le()),Lr&&Ie(e)}function qn(e,t){var n=t.last;n===null?t.last=t.first=e:(n.next=e,e.prev=n,t.last=e)}function Jn(e,t){var n=X;n!==null&&n.f&8192&&(e|=D);var r={ctx:rt,deps:null,nodes:null,f:e|E|512,first:null,fn:t,last:null,next:null,parent:n,b:n&&n.b,prev:null,teardown:null,wv:0,ac:null};H?.register_created_effect(r);var i=r;if(e&4)tn===null?on.ensure().schedule(r):tn.push(r);else if(t!==null){try{Mr(r)}catch(e){throw ur(r),e}i.deps===null&&i.teardown===null&&i.nodes===null&&i.first===i.last&&!(i.f&524288)&&(i=i.first,e&16&&e&65536&&i!==null&&(i.f|=re))}if(i!==null&&(i.parent=n,n!==null&&qn(i,n),Y!==null&&Y.f&2&&!(e&64))){var a=Y;(a.effects??=[]).push(i)}return r}function Yn(){return Y!==null&&!Rr}function Xn(e){let t=Jn(8,null);return V(t,T),t.teardown=e,t}function Zn(e){Kn(`$effect`);var t=X.f;if(!Y&&t&32&&rt!==null&&!rt.i){var n=rt;(n.e??=[]).push(e)}else return Qn(e)}function Qn(e){return Jn(4|ie,e)}function $n(e){on.ensure();let t=Jn(64|k,e);return(e={})=>new Promise(n=>{e.outro?pr(t,()=>{ur(t),n(void 0)}):(ur(t),n(void 0))})}function er(e){return Jn(4,e)}function tr(e){return Jn(se|k,e)}function nr(e,t=0){return Jn(8|t,e)}function rr(e,t=[],n=[],r=[]){Ct(r,t,n,t=>{Jn(8,()=>{e(...t.map(J))})})}function ir(e,t=0){return Jn(16|t,e)}function ar(e,t=0){return Jn(w|t,e)}function or(e){return Jn(32|k,e)}function sr(e){var t=e.teardown;if(t!==null){let n=Lr,r=Y;br(!0),xr(null);try{t.call(null)}catch(t){Wn(t,e.parent)}finally{br(n),xr(r)}}}function cr(e,t=!1){var n=e.first;for(e.first=e.last=null;n!==null;){let e=n.ac;e!==null&&bt(()=>{e.abort(pe)});var r=n.next;n.f&64?n.parent=null:ur(n,t),n=r}}function lr(e){for(var t=e.first;t!==null;){var n=t.next;t.f&32||ur(t),t=n}}function ur(e,t=!0){var n=!1;(t||e.f&262144)&&e.nodes!==null&&e.nodes.end!==null&&(dr(e.nodes.start,e.nodes.end),n=!0),e.f|=ne,cr(e,t&&!n),jr(e,0);var r=e.nodes&&e.nodes.t;if(r!==null)for(let e of r)e.stop();sr(e),e.f^=ne,e.f|=O;var i=e.parent;i!==null&&i.first!==null&&fr(e),e.next=e.prev=e.teardown=e.ctx=e.deps=e.fn=e.nodes=e.ac=e.b=null}function dr(e,t){for(;e!==null;){var n=e===t?null:jn(e);e.remove(),e=n}}function fr(e){var t=e.parent,n=e.prev,r=e.next;n!==null&&(n.next=r),r!==null&&(r.prev=n),t!==null&&(t.first===e&&(t.first=r),t.last===e&&(t.last=n))}function pr(e,t,n=!0){var r=[];e.f|=256,mr(e,r,!0);var i=()=>{n&&ur(e),t&&t()},a=r.length;if(a>0){var o=()=>--a||i();for(var s of r)s.out(o)}else i()}function mr(e,t,n){if(!(e.f&8192)){e.f^=D;var r=e.nodes&&e.nodes.t;if(r!==null)for(let e of r)(e.is_global||n)&&t.push(e);for(var i=e.first;i!==null;){var a=i.next;if(!(i.f&64)){var o=!!(i.f&65536)||!!(i.f&32)&&!!(e.f&16);mr(i,t,o?n:!1)}i=a}}}function hr(e){e.f&=-257,gr(e,!0)}function gr(e,t){if(!(e.f&256)&&e.f&8192){e.f^=D,e.f&1024||(V(e,E),on.ensure().schedule(e));for(var n=e.first;n!==null;){var r=n.next,i=!!(n.f&65536)||!!(n.f&32);gr(n,i?t:!1),n=r}var a=e.nodes&&e.nodes.t;if(a!==null)for(let e of a)(e.is_global||t)&&e.in()}}function _r(e,t){if(e.nodes)for(var n=e.nodes.start,r=e.nodes.end;n!==null;){var i=n===r?null:jn(n);t.append(n),n=i}}var K=e((()=>{Q(),F(),Gn(),Ge(),s(),C(),G(),it(),cn(),Ot(),St(),ft()})),vr,yr=e((()=>{Sn(),Q(),vr=null}));function br(e){Lr=e}function xr(e){Y=e}function Sr(e){X=e}function Cr(e){Y!==null&&(!Ke&&Y.f&2097152||Y.f&2)&&(zr??=new Set).add(e)}function wr(e){Vr=e}function q(e){Wr=e}function Tr(){return++Hr}function Er(e){var t=e.f;if(t&2048)return!0;if(t&4096){for(var n=e.deps,r=n.length,i=0;i<r;i++){var a=n[i];if(Er(a)&&Ft(a),a.wv>e.wv)return!0}t&512&&Zt===null&&V(e,T)}return!1}function Dr(e,t,n=!0){var r=e.reactions;if(r!==null&&(Ke||zr===null||!zr.has(e)))for(var i=0;i<r.length;i++){var a=r[i];a.f&2?Dr(a,t,!1):t===a&&(n?V(a,E):a.f&1024&&V(a,ee),Gt(a))}}function Or(e){var t=Br,n=Z,r=Vr,i=Y,a=zr,o=rt,s=Rr,c=Wr,l=e.f;Br=null,Z=0,Vr=null,Y=l&96?null:e,zr=null,Qe(e.ctx),Rr=!1,Wr=++Ur,e.ac!==null&&(bt(()=>{e.ac.abort(pe)}),e.ac=null);try{e.f|=oe;var u=e.fn,d=u();e.f|=te;var f=kr(e);if(nt()&&Vr!==null&&!Rr&&f!==null&&!(e.f&6146))for(var p=0;p<Vr.length;p++)Dr(Vr[p],e);if(i!==null&&i!==e){if(Ur++,i.deps!==null)for(let e=0;e<n;e+=1)i.deps[e].rv=Ur;if(t!==null)for(let e of t)e.rv=Ur;Vr!==null&&(r===null?r=Vr:r.push(...Vr))}return e.f&8388608&&(e.f^=A),d}catch(t){return kr(e),Un(t)}finally{e.f^=oe,Br=t,Z=n,Vr=r,Y=i,zr=a,Qe(o),Rr=s,Wr=c}}function kr(e){var t=e.deps,n=H?.is_fork;if(Br!==null){var r;if(n||jr(e,Z),t!==null&&Z>0)for(t.length=Z+Br.length,r=0;r<Br.length;r++)t[Z+r]=Br[r];else e.deps=t=Br;if(Yn()&&e.f&512)for(r=Z;r<t.length;r++)(t[r].reactions??=[]).push(e)}else!n&&t!==null&&Z<t.length&&(jr(e,Z),t.length=Z);return t}function Ar(e,t){let n=t.reactions;if(n!==null){var r=f.call(n,e);if(r!==-1){var i=n.length-1;i===0?n=t.reactions=null:(n[r]=n[i],n.pop())}}if(n===null&&t.f&2&&(Br===null||!p.call(Br,t))){var a=t;a.f&512&&(a.f^=512),a.v!==I&&ut(a),a.ac!==null&&bt(()=>{a.ac.abort(pe),a.ac=null,V(a,E)}),It(a),jr(a,0)}}function jr(e,t){var n=e.deps;if(n!==null)for(var r=t;r<n.length;r++)Ar(e,n[r])}function Mr(e){var t=e.f;if(!(t&16384)){V(e,T);var n=X;X=e;try{t&16777232?lr(e):cr(e),sr(e);var r=Or(e);e.teardown=typeof r==`function`?r:null,e.wv=Hr}finally{X=n}}}async function Nr(){if(Ke)return new Promise(e=>{requestAnimationFrame(()=>e()),setTimeout(()=>e())});await Promise.resolve(),Bt()}function J(e){var t=!!(e.f&2);if(vr?.add(e),Y!==null&&!Rr&&!(X!==null&&X.f&16384)&&(zr===null||!zr.has(e))){var n=Y.deps;if(Y.f&2097152)e.rv<Ur&&(e.rv=Ur,Br===null&&n!==null&&n[Z]===e?Z++:Br===null?Br=[e]:Br.push(e));else{Y.deps??=[],p.call(Y.deps,e)||Y.deps.push(e);var r=e.reactions;r===null?e.reactions=[Y]:p.call(r,Y)||r.push(Y)}}if(Lr&&vn.has(e))return vn.get(e);if(t){var i=e;if(Lr){var a=i.v;return(!(i.f&1024)&&i.reactions!==null||Fr(i))&&(a=Pt(i)),vn.set(i,a),a}var o=!(i.f&512)&&!Rr&&Y!==null&&!!(Y.f&512),s=(i.f&te)===0;Er(i)&&(o&&(i.f|=512),Ft(i)),o&&!s&&(Lt(i),Pr(i))}if(Zt?.has(e))return Zt.get(e);if(e.f&8388608)throw e.v;return e.v}function Pr(e){if(e.f|=512,e.deps!==null)for(let n of e.deps){var t=n.reactions;t===null?n.reactions=[e]:p.call(t,e)||t.push(e),n.f&2&&!(n.f&512)&&(Lt(n),Pr(n))}}function Fr(e){if(e.v===I)return!0;if(e.deps===null)return!1;for(let t of e.deps)if(vn.has(t)||t.f&2&&Fr(t))return!0;return!1}function Ir(e){var t=Rr;try{return Rr=!0,e()}finally{Rr=t}}var Lr,Y,Rr,X,zr,Br,Z,Vr,Hr,Ur,Wr,Q=e((()=>{s(),C(),K(),F(),Sn(),zt(),Je(),Xe(),Ze(),it(),cn(),Gn(),_e(),yr(),St(),ft(),Se(),Lr=!1,Y=null,Rr=!1,X=null,zr=null,Br=null,Z=0,Vr=null,Hr=1,Ur=0,Wr=Ur})),Gr=e((()=>{$o(),ts(),K()}));function Kr(e){return e.endsWith(`capture`)&&e!==`gotpointercapture`&&e!==`lostpointercapture`}function qr(e){return Xr.includes(e)}function Jr(e){return e=e.toLowerCase(),Qr[e]??e}function Yr(e){return $r.includes(e)}var Xr,Zr,Qr,$r,ei,ti=e((()=>{Xr=[`beforeinput`,`click`,`change`,`dblclick`,`contextmenu`,`focusin`,`focusout`,`input`,`keydown`,`keyup`,`mousedown`,`mousemove`,`mouseout`,`mouseover`,`mouseup`,`pointerdown`,`pointermove`,`pointerout`,`pointerover`,`pointerup`,`touchend`,`touchmove`,`touchstart`],Zr=`allowfullscreen.async.autofocus.autoplay.checked.controls.default.disabled.formnovalidate.indeterminate.inert.ismap.loop.multiple.muted.nomodule.novalidate.open.playsinline.readonly.required.reversed.seamless.selected.webkitdirectory.defer.disablepictureinpicture.disableremoteplayback`.split(`.`),Qr={formnovalidate:`formNoValidate`,ismap:`isMap`,nomodule:`noModule`,playsinline:`playsInline`,readonly:`readOnly`,defaultvalue:`defaultValue`,defaultchecked:`defaultChecked`,srcobject:`srcObject`,novalidate:`noValidate`,allowfullscreen:`allowFullscreen`,disablepictureinpicture:`disablePictureInPicture`,disableremoteplayback:`disableRemotePlayback`},[...Zr],$r=[`touchstart`,`touchmove`],ei=[`$state`,`$state.raw`,`$derived`,`$derived.by`],[...ei]})),ni=e((()=>{F(),ti(),Q()})),ri=e((()=>{F(),B(),it()}));function ii(e,t,n,r={}){function i(e){if(r.capture||ci.call(t,e),!e.cancelBubble)return bt(()=>n?.call(this,e))}return e.startsWith(`pointer`)||e.startsWith(`touch`)||e===`wheel`?(i.__removed=!1,ot(()=>{i.__removed||t.addEventListener(e,i,r)})):t.addEventListener(e,i,r),i}function ai(e,t,n,r,i){var a={capture:r,passive:i},o=ii(e,t,n,a);(t===document.body||t===window||t===document||t instanceof HTMLMediaElement)&&Xn(()=>{o.__removed=!0,t.removeEventListener(e,o,a)})}function oi(e,t,n){(t[li]??={})[e]=n}function si(e){for(var t=0;t<e.length;t++)ui.add(e[t]);for(var n of di)n(e)}function ci(e){var t=this,n=t.ownerDocument,r=e.type,i=e.composedPath?.()||[],a=i[0]||e.target;fi=e,pi||(pi=!0,setTimeout(()=>{pi=!1,fi=null}));var o=0,s=fi===e&&e[li];if(s){var c=i.indexOf(s);if(c!==-1&&(t===document||t===window)){e[li]=t;return}var l=i.indexOf(t);if(l===-1)return;c<=l&&(o=c)}if(a=i[o]||e.target,a!==t){h(e,`currentTarget`,{configurable:!0,get(){return a||n}});var u=Y,d=X;xr(null),Sr(null);try{for(var f,p=[];a!==null&&a!==t;){try{var m=a[li]?.[r];m!=null&&(!a.disabled||e.target===a)&&m.call(a,e)}catch(e){f?p.push(e):f=e}if(e.cancelBubble)break;o++,a=o<i.length?i[o]:null}if(f){for(let e of p)queueMicrotask(()=>{throw e});throw f}}finally{e[li]=t,delete e.currentTarget,xr(u),Sr(d)}}}var li,ui,di,fi,pi,mi=e((()=>{K(),C(),B(),lt(),Q(),St(),li=Symbol(`events`),ui=new Set,di=new Set,fi=null,pi=!1}));function hi(e){return _i?.createHTML(e)??e}function gi(e){var t=In(`template`);return t.innerHTML=hi(e.replaceAll(`<!>`,`<!---->`)),t.content}var _i,vi=e((()=>{G(),_i=globalThis?.window?.trustedTypes&&globalThis.window.trustedTypes.createPolicy(`svelte-trusted-html`,{createHTML:e=>e})}));function yi(e,t){var n=X;n.nodes===null&&(n.nodes={start:e,end:t,a:null,t:null})}function bi(e,t){var n=!!(t&1),r=!!(t&2),i,a=!e.startsWith(`<!>`);return()=>{if(R)return yi(z,null),z;i===void 0&&(i=gi(a?e:`<!>`+e),n||(i=An(i)));var t=r||Bn?document.importNode(i,!0):i.cloneNode(!0);if(n){var o=An(t),s=t.lastChild;yi(o,s)}else yi(t,t);return t}}function xi(e,t,n=`svg`){var r=!e.startsWith(`<!>`),i=!!(t&1),a=`<${n}>${r?e:`<!>`+e}</${n}>`,o;return()=>{if(R)return yi(z,null),z;if(!o){var e=An(gi(a));if(i)for(o=document.createDocumentFragment();An(e);)o.appendChild(An(e));else o=An(e)}var t=o.cloneNode(!0);if(i){var n=An(t),r=t.lastChild;yi(n,r)}else yi(t,t);return t}}function Si(e,t){return xi(e,t,`svg`)}function Ci(){if(R)return yi(z,null),z;var e=document.createDocumentFragment(),t=document.createComment(``),n=kn();return e.append(t,n),yi(t,n),e}function wi(e,t){if(R){var n=X;(!(n.f&32768)||n.nodes.end===null)&&(n.nodes.end=z),Te()}else e!==null&&e.before(t)}var Ti=e((()=>{B(),G(),vi(),Q(),_e(),F()}));function Ei(e){let t=0,n=ln(0),r;return()=>{Yn()&&(J(n),nr(()=>(t===0&&(r=Ir(()=>e(()=>hn(n)))),t+=1,()=>{ot(()=>{--t,t===0&&(r?.(),r=void 0,hn(n))})})))}}var Di=e((()=>{Q(),K(),Sn(),Xe(),s(),lt()}));function Oi(e,t,n,r){new Ai(e,t,n,r)}var ki,Ai,ji=e((()=>{F(),_e(),it(),Gn(),K(),Q(),B(),lt(),Ge(),Se(),s(),cn(),Sn(),Xe(),Di(),G(),mt(),ki=re|k,Ai=class{parent;is_pending=!1;transform_error;#e;#t=R?z:null;#n;#r;#i;#a=null;#o=null;#s=null;#c=null;#l=0;#u=0;#d=!1;#f=new Set;#p=new Set;#m=null;#h=Ei(()=>(this.#m=ln(this.#l),()=>{this.#m=null}));constructor(e,t,n,r){this.#e=e,this.#n=t,this.#r=e=>{var t=X;t.b=this,t.f|=128,n(e)},this.parent=X.b,this.transform_error=r??this.parent?.transform_error??(e=>e),this.#i=ir(()=>{if(R){let e=Oe(this.#t);Te();let t=e===`[!`;if(e.startsWith(`[?`)){let t=JSON.parse(e.slice(2));this.#_(t)}else t?this.#b():this.#g()}else this.#x()},ki),R&&(this.#e=z)}#g(){try{this.#a=or(()=>this.#r(this.#e))}catch(e){this.error(e)}}#_(e){let t=this.#n.failed,{reset:n,invoke_onerror:r}=this.#v(e);ot(r),t&&(this.#s=or(()=>{t(this.#e,()=>e,()=>n)}))}#v(e){var t=!1,n=!1;let r=()=>{this.#y()||(t?xe():(t=!0,n&&We(),this.#s!==null&&pr(this.#s,()=>{this.#s=null}),this.#C(()=>{this.#x()})))};return{reset:r,invoke_onerror:()=>{if(!this.#y())try{n=!0,this.#n.onerror?.(e,r),n=!1}catch(e){Wn(e,this.#i&&this.#i.parent)}}}}#y(){return(this.#i.f&(O|ne))!==0}#b(){let e=this.#n.pending;e&&(this.is_pending=!0,this.#o=or(()=>e(this.#e)),ot(()=>{if(!this.#y()){var e=this.#c=document.createDocumentFragment(),t=kn(),n=!1;e.append(t),this.#a=this.#C(()=>{try{return or(()=>this.#r(t))}catch(e){try{this.error(e),n=!0}catch(e){Wn(e,this.#i.parent)}return null}}),this.#a===null?(this.#c=null,n&&this.#S(H)):this.#u===0&&(this.#e.before(e),this.#c=null,pr(this.#o,()=>{this.#o=null}),this.#S(H))}}))}#x(){try{if(this.is_pending=this.has_pending_snippet(),this.#u=0,this.#l=0,this.#a=or(()=>{this.#r(this.#e)}),this.#u>0){var e=this.#c=document.createDocumentFragment();_r(this.#a,e);let t=this.#n.pending;this.#o=or(()=>t(this.#e))}else this.#S(H)}catch(e){this.error(e)}}#S(e){this.is_pending=!1,e.transfer_effects(this.#f,this.#p)}defer_effect(e){pt(e,this.#f,this.#p)}is_rendered(){return!this.is_pending&&(!this.parent||this.parent.is_rendered())}has_pending_snippet(){return!!this.#n.pending}#C(e){var t=X,n=Y,r=rt;Sr(this.#i),xr(this.#i),Qe(this.#i.ctx);try{return on.ensure(),e()}finally{Sr(t),xr(n),Qe(r)}}#w(e,t){this.has_pending_snippet()?(this.#u+=e,this.#u===0&&(this.#S(t),this.#o&&pr(this.#o,()=>{this.#o=null}),this.#c&&=(this.#e.before(this.#c),null))):this.parent&&this.parent.#w(e,t)}update_pending_count(e,t){this.#w(e,t),this.#l+=e,!(!this.#m||this.#d)&&(this.#d=!0,ot(()=>{this.#d=!1,this.#m&&pn(this.#m,this.#l)}))}get_effect_pending(){return this.#h(),J(this.#m)}error(e){if(e===he||!this.#n.onerror&&!this.#n.failed)throw e;H?.is_fork?(this.#a&&H.skip_effect(this.#a),this.#o&&H.skip_effect(this.#o),this.#s&&H.skip_effect(this.#s),H.oncommit(()=>{this.#y()||this.#T(e)})):this.#T(e)}#T(e){this.#a&&=(ur(this.#a),null),this.#o&&=(ur(this.#o),null),this.#s&&=(ur(this.#s),null),R&&(we(this.#t),Ee(),we(De()));let t=this.#n.failed,n=e=>{if(this.#y())return;let{reset:n,invoke_onerror:r}=this.#v(e);r(),t&&!this.#y()&&(this.#s=this.#C(()=>{try{return or(()=>{var r=X;r.b=this,r.f|=128,t(this.#e,()=>e,()=>n)})}catch(e){return Wn(e,this.#i.parent),null}}))};ot(()=>{if(!this.#y()){var t;try{t=this.transform_error(e)}catch(e){Wn(e,this.#i&&this.#i.parent);return}typeof t==`object`&&t&&typeof t.then==`function`?t.then(n,e=>Wn(e,this.#i&&this.#i.parent)):n(t)}})}}}));function Mi(e,t){var n=t==null?``:typeof t==`object`?`${t}`:t;n!==(e[de]??=e.nodeValue)&&(e[de]=n,e.nodeValue=`${n}`)}function Ni(e,t){return Pi(e,t)}function Pi(e,{target:t,anchor:n,props:r={},events:i,context:a,intro:o=!0,transformError:s}){On();var c=void 0,l=$n(()=>{var l=n??t.appendChild(kn());Oi(l,{pending:()=>{}},t=>{$e({});var n=rt;if(a&&(n.c=a),i&&(r.$$events=i),R&&yi(t,null),Fi=o,c=e(t,r)||tt(),Fi=!0,R&&(X.nodes.end=z,z===null||z.nodeType!==8||z.data!==`]`))throw ye(),he;et()},s);var u=new Set,d=e=>{for(var n=0;n<e.length;n++){var r=e[n];if(!u.has(r)){u.add(r);var i=Yr(r);for(let e of[t,document]){var a=Ii.get(e);a===void 0&&(a=new Map,Ii.set(e,a));var o=a.get(r);o===void 0?(e.addEventListener(r,ci,{passive:i}),a.set(r,1)):a.set(r,o+1)}}}};return d(m(ui)),di.add(d),()=>{for(var e of u)for(let n of[t,document]){var r=Ii.get(n),i=r.get(e);--i==0?(n.removeEventListener(e,ci),r.delete(e),r.size===0&&Ii.delete(n)):r.set(e,i)}di.delete(d),l!==n&&l.parentNode?.removeChild(l)}});return Li.set(c,l),c}var Fi,Ii,Li,Ri=e((()=>{s(),G(),_e(),Q(),it(),K(),B(),C(),mi(),Se(),Ge(),Ti(),ti(),F(),ji(),Fi=!0,Ii=new Map,Li=new WeakMap})),zi=e((()=>{F(),B(),K(),Sn(),Ri(),Q()})),Bi=e((()=>{C(),F(),it(),ti()})),Vi=e((()=>{Ge(),it()})),Hi=e((()=>{Ye(),K(),Q(),Ze()})),Ui=e((()=>{Ot(),Q(),B(),Ti()})),Wi=e((()=>{Ge()})),Gi,Ki=e((()=>{cn(),K(),F(),B(),G(),s(),Gi=class{anchor;#e=new Map;#t=new Map;#n=new Map;#r=new Set;#i=!0;constructor(e,t=!0){this.anchor=e,this.#i=t}#a=e=>{if(this.#e.has(e)){var t=this.#e.get(e),n=this.#t.get(t);if(n)hr(n),this.#r.delete(t);else{var r=this.#n.get(t);r&&(hr(r.effect),this.#t.set(t,r.effect),this.#n.delete(t),r.fragment.lastChild.remove(),this.anchor.before(r.fragment),n=r.effect)}for(let[t,n]of this.#e){if(this.#e.delete(t),t===e)break;let r=this.#n.get(n);r&&(ur(r.effect),this.#n.delete(n))}for(let[e,r]of this.#t){if(e===t||this.#r.has(e))continue;let i=()=>{if(Array.from(this.#e.values()).includes(e)){var t=document.createDocumentFragment();_r(r,t),t.append(kn()),this.#n.set(e,{effect:r,fragment:t})}else ur(r);this.#r.delete(e),this.#t.delete(e)};this.#i||!n?(this.#r.add(e),pr(r,i,!1)):i()}}};#o=e=>{this.#e.delete(e);let t=Array.from(this.#e.values());for(let[e,n]of this.#n)t.includes(e)||(ur(n.effect),this.#n.delete(e))};ensure(e,t){var n=H,r=Fn();if(t&&!this.#t.has(e)&&!this.#n.has(e)){if(r){var i=document.createDocumentFragment(),a=kn();i.append(a),this.#n.set(e,{effect:or(()=>t(a)),fragment:i})}else this.#t.set(e,or(()=>t(this.anchor)))}if(this.#e.set(n,e),r){for(let[t,r]of this.#t)t===e?n.unskip_effect(r):n.skip_effect(r);for(let[t,r]of this.#n)t===e?n.unskip_effect(r.effect):n.skip_effect(r.effect);n.oncommit(this.#a),n.ondiscard(this.#o)}else R&&(this.anchor=z),this.#a(n)}}})),qi=e((()=>{C(),K(),Sn(),B(),lt(),it(),cn(),Ki(),Ot()}));function Ji(e,t,n=!1){var r;R&&(r=z,Te());var i=new Gi(e),a=n?re:0;function o(e,t){if(R){var n=Oe(r);if(e!==parseInt(n.substring(1))){var a=De();we(a),i.anchor=a,Ce(!1),i.ensure(e,t),Ce(!0);return}}i.ensure(e,t)}ir(()=>{var e=!1;t((t,n=0)=>{e=!0,o(n,t)}),e||o(-1,null)},a)}var Yi=e((()=>{F(),B(),K(),Ki()}));function Xi(e,t,n){R&&Te();var r=new Gi(e),i=!nt();ir(()=>{var e=t();e!==e&&(e=Zi),i&&typeof e==`object`&&e&&(e={}),r.ensure(e,n)})}var Zi,Qi=e((()=>{it(),K(),B(),Ki(),Zi=Symbol(`NaN`)})),$i=e((()=>{K(),B(),G()}));function ea(e,t){return t}function ta(e,t,n){for(var r=[],i=t.length,a,o=t.length,s=0;s<i;s++){let n=t[s];pr(n,()=>{if(a){if(a.pending.delete(n),a.done.add(n),a.pending.size===0){var t=e.outrogroups;na(e,m(a.done)),t.delete(a),t.size===0&&(e.outrogroups=null)}}else--o},!1)}if(o===0){var c=r.length===0&&n!==null&&e.pending.size===0;if(c){var l=n,u=l.parentNode;Pn(u),u.append(l),e.items.clear()}na(e,t,!c)}else a={pending:new Set(t),done:new Set},(e.outrogroups??=new Set).add(a)}function na(e,t,n=!0){var r;if(e.pending.size>0){r=new Set;for(let t of e.pending.values())for(let n of t)r.add(e.items.get(n).e)}for(var i=0;i<t.length;i++){var a=t[i];r?.has(a)?(a.f|=ae,_r(a,document.createDocumentFragment())):ur(t[i],n)}}function ra(e,t,n,r,i,a=null){var o=e,s=new Map;if(t&4){var c=e;o=R?we(An(c)):c.appendChild(kn())}R&&Te();var l=null,u=Mt(()=>{var e=n();return d(e)?e:e==null?[]:m(e)}),f=new Map,p=!0;function h(e){if(!(_.effect.f&16384)){_.pending.delete(e);var n=J(u);_.fallback=l,aa(_,n,o,t,r),l!==null&&(n.length===0?l.f&33554432?(l.f^=ae,sa(l,null,o)):hr(l):pr(l,()=>{l=null}))}}function g(e){_.pending.delete(e)}var _={effect:ir(()=>{var e=J(u),c=e.length;let d=!1;R&&Oe(o)===`[!`!=(c===0)&&(o=De(),we(o),Ce(!1),d=!0);for(var m=new Set,_=H,v=Fn(),y=0;y<c;y+=1){R&&z.nodeType===8&&z.data===`]`&&(o=z,d=!0,Ce(!1));var b=e[y],x=r(b,y),S=p?null:s.get(x);S?(S.v&&pn(S.v,b),S.i&&pn(S.i,y),v&&_.unskip_effect(S.e)):(S=oa(s,p?o:la??=kn(),b,x,y,i,t,n),p||(S.e.f|=ae),s.set(x,S)),m.add(x)}if(c===0&&a&&!l&&(p?l=or(()=>a(o)):(l=or(()=>a(la??=kn())),l.f|=ae)),c>m.size&&Fe(``,``,``),R&&c>0&&we(De()),!p){if(f.set(_,m),v){for(let[e,t]of s)m.has(e)||_.skip_effect(t.e);_.oncommit(h),_.ondiscard(g)}else h(_)}d&&Ce(!0),J(u)}),flags:t,items:s,pending:f,outrogroups:null,fallback:l};p=!1,R&&(o=z)}function ia(e){for(;e!==null&&!(e.f&32);)e=e.next;return e}function aa(e,t,n,r,i){var a=!!(r&8),o=t.length,s=e.items,c=ia(e.effect.first),l,u=null,d,f=[],p=[],h,g,_,v;if(a)for(v=0;v<o;v+=1)h=t[v],g=i(h,v),_=s.get(g).e,_.f&33554432||(_.nodes?.a?.measure(),(d??=new Set).add(_));for(v=0;v<o;v+=1){if(h=t[v],g=i(h,v),_=s.get(g).e,e.outrogroups!==null)for(let t of e.outrogroups)t.pending.delete(_),t.done.delete(_);if(_.f&8192&&(hr(_),a&&(_.nodes?.a?.unfix(),(d??=new Set).delete(_))),_.f&33554432){if(_.f^=ae,_===c)sa(_,null,n);else{var y=u?u.next:c;_===e.effect.last&&(e.effect.last=_.prev),_.prev&&(_.prev.next=_.next),_.next&&(_.next.prev=_.prev),ca(e,u,_),ca(e,_,y),sa(_,y,n),u=_,f=[],p=[],c=ia(u.next);continue}}if(_!==c){if(l!==void 0&&l.has(_)){if(f.length<p.length){var b=p[0],x;u=b.prev;var S=f[0],C=f[f.length-1];for(x=0;x<f.length;x+=1)sa(f[x],b,n);for(x=0;x<p.length;x+=1)l.delete(p[x]);ca(e,S.prev,C.next),ca(e,u,S),ca(e,C,b),c=b,u=C,--v,f=[],p=[]}else l.delete(_),sa(_,c,n),ca(e,_.prev,_.next),ca(e,_,u===null?e.effect.first:u.next),ca(e,u,_),u=_;continue}for(f=[],p=[];c!==null&&c!==_;)(l??=new Set).add(c),p.push(c),c=ia(c.next);if(c===null)continue}_.f&33554432||f.push(_),u=_,c=ia(_.next)}if(e.outrogroups!==null){for(let t of e.outrogroups)t.pending.size===0&&(na(e,m(t.done)),e.outrogroups?.delete(t));e.outrogroups.size===0&&(e.outrogroups=null)}if(c!==null||l!==void 0){var w=[];if(l!==void 0)for(_ of l)_.f&8192||w.push(_);for(;c!==null;)!(c.f&8192)&&c!==e.fallback&&w.push(c),c=ia(c.next);var T=w.length;if(T>0){var E=r&4&&o===0?n:null;if(a){for(v=0;v<T;v+=1)w[v].nodes?.a?.measure();for(v=0;v<T;v+=1)w[v].nodes?.a?.fix()}ta(e,w,E)}}a&&ot(()=>{if(d!==void 0)for(_ of d)_.nodes?.a?.apply()})}function oa(e,t,n,r,i,a,o,s){var c=o&1?o&16?ln(n):dn(n,!1,!1):null,l=o&2?ln(i):null;return{v:c,i:l,e:or(()=>(a(t,c??n,l??i,s),()=>{e.delete(r)}))}}function sa(e,t,n){if(e.nodes)for(var r=e.nodes.start,i=e.nodes.end,a=t&&!(t.f&33554432)?t.nodes.start:n;r!==null;){var o=jn(r);if(a.before(r),r===i)return;r=o}}function ca(e,t,n){t===null?e.effect.first=n:t.next=n,n===null?e.effect.last=t:n.prev=t}var la,ua=e((()=>{_e(),B(),G(),K(),Sn(),C(),F(),lt(),Q(),s(),zt(),cn(),Ge(),Xe()})),da=e((()=>{K(),B(),Ti(),ti(),it(),G(),Q(),F()})),fa=e((()=>{B(),G(),Ti()})),pa=e((()=>{ti(),Ne()})),ma=e((()=>{F(),K(),it(),B(),vi(),Ti(),Ge(),G(),pa(),Ki()})),ha=e((()=>{F(),K(),B(),Ki()})),ga,_a,va=e((()=>{C(),s(),ga=()=>performance.now(),_a={tick:e=>requestAnimationFrame(e),now:()=>ga(),tasks:new Set}}));function ya(){let e=_a.now();_a.tasks.forEach(t=>{t.c(e)||(_a.tasks.delete(t),t.f())}),_a.tasks.size!==0&&_a.tick(ya)}function ba(e){let t;return _a.tasks.size===0&&_a.tick(ya),{promise:new Promise(n=>{_a.tasks.add(t={c:e,f:n})}),abort(){_a.tasks.delete(t)}}}var xa=e((()=>{va()}));function Sa(e,t){bt(()=>{e.dispatchEvent(new CustomEvent(t))})}function Ca(e){if(e===`float`)return`cssFloat`;if(e===`offset`)return`cssOffset`;if(e.startsWith(`--`))return e;let t=e.split(`-`);return t.length===1?t[0]:t[0]+t.slice(1).map(e=>e[0].toUpperCase()+e.slice(1)).join(``)}function wa(e){let t={},n=e.split(`;`);for(let e of n){let[n,r]=e.split(`:`);if(!n||r===void 0)break;let i=Ca(n.trim());t[i]=r.trim()}return t}function Ta(e,t,n,r){var i=!!(e&1),a=!!(e&2),o=i&&a,s=!!(e&4),c=o?`both`:i?`in`:`out`,l,u=t.inert,d=t.style.overflow,f,p;function m(){return bt(()=>l??=n()(t,r?.()??{},{direction:c}))}var h={is_global:s,in(){t.inert=u,i?(a||f?.abort(),f=Ea(t,m(),p,1,()=>{Sa(t,`introstart`)},()=>{Sa(t,`introend`),f?.abort(),f=l=void 0,t.style.overflow=d})):(p?.abort(),p?.reset?.())},out(e){a?(t.inert=!0,p=Ea(t,m(),f,0,()=>{Sa(t,`outrostart`)},()=>{Sa(t,`outroend`),e?.()})):(e?.(),l=void 0)},stop:()=>{f?.abort(),p?.abort()}},g=X;if((g.nodes.t??=[]).push(h),i&&Fi){var _=s;if(!_){for(var v=g.parent;v&&v.f&65536;)for(;(v=v.parent)&&!(v.f&16););_=!v||!!(v.f&32768)}_&&er(()=>{Ir(()=>h.in())})}}function Ea(e,t,n,r,i,a){var o=r===1,s=!1;if(c(t)){var l;return ot(()=>{s||(l=Ea(e,t({direction:o?`in`:`out`}),n,r,i,a))}),{abort:()=>{s=!0,l?.abort()},deactivate:()=>l?.deactivate(),reset:()=>l?.reset(),t:()=>l?.t()??1-r}}if(n?.deactivate(),!t?.duration&&!t?.delay)return i(),a(),{abort:S,deactivate:S,reset:S,t:()=>r};let{delay:u=0,css:d,tick:f,easing:p=Da}=t;var m,h=()=>1-r;return ot(()=>{if(!s){var c=[];if(o&&n===void 0&&(f&&f(0,1),d)){var l=wa(d(0,1));c.push(l,l)}m=e.animate(c,{duration:u,fill:`forwards`}),m.onfinish=()=>{m.cancel(),i();var o=n?.t()??1-r;n?.abort();var s=r-o,c=t.duration*Math.abs(s),l=[];if(c>0){var u=!1;if(d)for(var g=Math.ceil(c/(1e3/60)),_=0;_<=g;_+=1){var v=o+s*p(_/g),y=wa(d(v,1-v));l.push(y),u||=y.overflow===`hidden`}u&&(e.style.overflow=`hidden`),h=()=>{var e=m.currentTime;return o+s*p(e/c)},f&&ba(()=>{if(m.playState!==`running`)return!1;var e=h();return f(e,1-e),!0})}m=e.animate(l,{duration:c,fill:`forwards`}),m.onfinish=()=>{h=()=>r,f?.(r,1-r),a()}}}}),{abort:()=>{s=!0,m&&(m.cancel(),m.effect=null,m.onfinish=S)},deactivate:()=>{a=S},reset:()=>{r===0&&f?.(1,0)},t:()=>h()}}var Da,Oa=e((()=>{C(),K(),Q(),xa(),Ri(),_e(),F(),lt(),St(),Da=e=>e})),ka=e((()=>{B(),G(),K(),Ri(),Q(),it(),F(),Ti(),ti(),Ki(),Oa()})),Aa=e((()=>{B(),G(),K(),F()})),ja=e((()=>{K(),G(),Q()})),Ma=e((()=>{K(),Q()}));function Na(e,t){var n=void 0,r;ar(()=>{n!==(n=t())&&(r&&=(ur(r),null),n&&(r=or(()=>{er(()=>n(e))})))})}var Pa=e((()=>{K()}));function Fa(e){var t,n,r=``;if(typeof e==`string`||typeof e==`number`)r+=e;else if(typeof e==`object`){if(Array.isArray(e)){var i=e.length;for(t=0;t<i;t++)e[t]&&(n=Fa(e[t]))&&(r&&(r+=` `),r+=n)}else for(n in e)e[n]&&(r&&(r+=` `),r+=n)}return r}function Ia(){for(var e,t,n=0,r=``,i=arguments.length;n<i;n++)(e=arguments[n])&&(t=Fa(e))&&(r&&(r+=` `),r+=t);return r}var La=e((()=>{}));function Ra(e){return typeof e==`object`?Ia(e):e??``}function za(e,t,n){var r=e==null?``:``+e;if(t&&(r=r?r+` `+t:t),n){for(var i of Object.keys(n))if(n[i])r=r?r+` `+i:i;else if(r.length)for(var a=i.length,o=0;(o=r.indexOf(i,o))>=0;){var s=o+a;(o===0||Ua.includes(r[o-1]))&&(s===r.length||Ua.includes(r[s]))?r=(o===0?``:r.substring(0,o))+r.substring(s+1):o=s}}return r===``?null:r}function Ba(e,t=!1){var n=t?` !important;`:`;`,r=``;for(var i of Object.keys(e)){var a=e[i];a!=null&&a!==``&&(r+=` `+i+`: `+a+n)}return r}function Va(e){return e[0]!==`-`||e[1]!==`-`?e.toLowerCase():e}function Ha(e,t){if(t){var n=``,r,i;if(Array.isArray(t)?(r=t[0],i=t[1]):r=t,e){e=String(e).replaceAll(/\/\*.*?\*\//g,``).trim();var a=!1,o=0,s=!1,c=[];r&&c.push(...Object.keys(r).map(Va)),i&&c.push(...Object.keys(i).map(Va));var l=0,u=-1;let t=e.length;for(var d=0;d<t;d++){var f=e[d];if(s?f===`/`&&e[d-1]===`*`&&(s=!1):a?a===f&&(a=!1):f===`/`&&e[d+1]===`*`?s=!0:f===`"`||f===`'`?a=f:f===`(`?o++:f===`)`&&o--,!s&&a===!1&&o===0){if(f===`:`&&u===-1)u=d;else if(f===`;`||d===t-1){if(u!==-1){var p=Va(e.substring(l,u).trim());if(!c.includes(p)){f!==`;`&&d++;var m=e.substring(l,d).trim();n+=` `+m+`;`}}l=d+1,u=-1}}}}return r&&(n+=Ba(r)),i&&(n+=Ba(i,!0)),n=n.trim(),n===``?null:n}return e==null?null:String(e)}var Ua,Wa=e((()=>{La(),C(),Ua=[...` 	
\r\f\xA0\v﻿`]}));function Ga(e,t,n,r,i,a){var o=e[ue];if(R||o!==n||o===void 0){var s=za(n,r,a);(!R||s!==e.getAttribute(`class`))&&(s==null?e.removeAttribute(`class`):t?e.className=s:e.setAttribute(`class`,s)),e[ue]=n}else if(a&&i!==a)for(var c in a){var l=!!a[c];(i==null||l!==!!i[c])&&e.classList.toggle(c,l)}return a}var Ka=e((()=>{Wa(),F(),B()}));function qa(e,t={},n,r){for(var i in n){var a=n[i];t[i]!==a&&(n[i]==null?e.style.removeProperty(i):e.style.setProperty(i,a,r))}}function Ja(e,t,n,r){var i=e[P];if(R||i!==t){var a=Ha(t,r);(!R||a!==e.getAttribute(`style`))&&(a==null?e.removeAttribute(`style`):e.style.cssText=a),e[P]=t}else r&&(Array.isArray(r)?(qa(e,n?.[0],r[0]),qa(e,n?.[1],r[1],`important`)):qa(e,n,r));return r}var Ya=e((()=>{Wa(),F(),B()}));function Xa(e,t){t?e.hasAttribute(`selected`)||e.setAttribute(`selected`,``):e.removeAttribute(`selected`)}function Za(e,t){var n=!(`__defaultValue`in e);(n||e.__defaultValue!==t)&&(e.__defaultValue=t,Qa(e,!n||`__value`in e))}function Qa(e,t){var n=e.__defaultValue,r=e.multiple,i=r?n??[]:null;if(!r||d(i)){var a=e.selectedIndex,o=t&&r?new Set(e.selectedOptions):null;for(var s of e.options){var c=to(s);Xa(s,r?i.includes(c):Tn(c,n))}if(t){if(o!==null)for(s of e.options){var l=o.has(s);s.selected!==l&&(s.selected=l)}else e.selectedIndex!==a&&(e.selectedIndex=a)}}}function $a(e,t,n=!1){if(e.multiple){if(t==null)return;if(!d(t))return be();for(var r of e.options)r.selected=t.includes(to(r))}else{for(r of e.options)if(Tn(to(r),t)){r.selected=!0;return}(!n||t!==void 0)&&(e.selectedIndex=-1)}}function eo(e){var t=new MutationObserver(t=>{t.every(no)||(`__defaultValue`in e&&Qa(e,!1),`__value`in e&&$a(e,e.__value))});t.observe(e,{childList:!0,subtree:!0,attributes:!0,attributeFilter:[`value`]}),Xn(()=>{t.disconnect()})}function to(e){return`__value`in e?e.__value:e.value}function no(e){if(e.target.closest(`selectedcontent`)!==null)return!0;if(e.type===`childList`){var t=[...e.addedNodes,...e.removedNodes];return t.length>0&&t.every(e=>e.nodeName===`SELECTEDCONTENT`)}return!1}var ro=e((()=>{K(),St(),En(),C(),Se(),cn()}));function io(e){if(R){var t=!1,n=()=>{if(!t){if(t=!0,e.hasAttribute(`value`)){var n=e.value;ao(e,`value`,null),e.value=n}if(e.hasAttribute(`checked`)){var r=e.checked;ao(e,`checked`,null),e.checked=r}}};e[fe]=n,ot(n),_t()}}function ao(e,t,n,r){var i=co(e);R&&(i[t]=e.getAttribute(t),t===`src`||t===`srcset`||t===`href`&&e.nodeName===ho)||i[t]!==(i[t]=n)&&(t===`loading`&&(e[M]=n),n==null?e.removeAttribute(t):typeof n!=`string`&&lo(e).has(t)?e[t]=n:e.setAttribute(t,n))}function oo(e,t,n,r,i=!1,a=!1){R&&i&&e.nodeName===go&&(`defaultValue`in n||`defaultChecked`in n||io(e));var o=co(e),s=o[po],c=!o[mo];let l=R&&s;l&&Ce(!1);var u=t||{},d=e.nodeName===_o,f=e.nodeName===vo;try{for(var p in t)!(p in n)&&p[0]+p[1]!==`$$`&&(n[p]=null);n.class?n.class=Ra(n.class):(r||n[uo])&&(n.class=null),n[fo]&&(n.style??=null);var m=lo(e);if(e.nodeName===go&&`type`in n&&(`value`in n||`__value`in n)){var h=n.type;(h!==u.type||h===void 0&&e.hasAttribute(`type`))&&(u.type=h,ao(e,`type`,h,a))}for(let i in n){let l=n[i];if(d&&i===`value`&&l==null)e.value=e.__value=``,u[i]=l;else if(i===`class`)Ga(e,e.namespaceURI===`http://www.w3.org/1999/xhtml`,l,r,t?.[uo],n[uo]),u[i]=l,u[uo]=n[uo];else if(i===`style`)Ja(e,l,t?.[fo],n[fo]),u[i]=l,u[fo]=n[fo];else{var g=u[i];if(l!==g||l===void 0&&e.hasAttribute(i)){u[i]=l;var _=i[0]+i[1];if(_!==`$$`){if(_===`on`){let t={},n=`$$`+i,r=i.slice(2);var v=qr(r);if(Kr(r)&&(r=r.slice(0,-7),t.capture=!0),!v&&g){if(l!=null)continue;e.removeEventListener(r,u[n],t),u[n]=null}if(v)oi(r,e,l),si([r]);else if(l!=null){function a(e){u[i].call(this,e)}u[n]=ii(r,e,a,t)}}else if(i===`style`)ao(e,i,l);else if(i===`autofocus`)gt(e,!!l);else if(!s&&(i===`__value`||i===`value`&&l!=null))e.__value=l,(g==null||e.value!==l||l===0&&e.nodeName===yo)&&(e.value=l);else if(i===`selected`&&d)Xa(e,l);else{var y=i;c||(y=Jr(y));var b=y===`defaultValue`||y===`defaultChecked`;if(f&&y===`defaultValue`)continue;if(l==null&&!s&&!b){if(o[i]=null,y===`value`||y===`checked`){let n=e,r=t===void 0;if(y===`value`){let e=n.defaultValue;n.removeAttribute(y),n.defaultValue=e,n.value=n.__value=r?e:null}else{let e=n.defaultChecked;n.removeAttribute(y),n.defaultChecked=e,n.checked=r?e:!1}}else e.removeAttribute(i)}else b||(s||typeof l!=`string`)&&m.has(y)?(e[y]=l,y in o&&(o[y]=I)):typeof l!=`function`&&ao(e,y,l,a)}}}}}}finally{l&&Ce(!0)}return u}function so(e,t,n=[],r=[],i=[],a,o=!1,s=!1){Ct(i,n,r,n=>{var r=void 0,i={},c=e.nodeName===vo,l=!1;if(ar(()=>{var u=t(...n.map(J)),d=oo(e,r,u,a,o,s);if(l&&c){var f=e;`defaultValue`in u&&Za(f,u.defaultValue),`value`in u&&$a(f,u.value)}for(let e of Object.getOwnPropertySymbols(i))u[e]||ur(i[e]);for(let t of Object.getOwnPropertySymbols(u)){var p=u[t];t.description===`@attach`&&(!r||p!==r[t])&&(i[t]&&ur(i[t]),i[t]=or(()=>Na(e,()=>p))),d[t]=p}r=d}),c){var u=e;er(()=>{var e=r;`defaultValue`in e&&Za(u,e.defaultValue),$a(u,e.value,!0),eo(u)})}l=!0})}function co(e){return e[N]??={[po]:e.nodeName.includes(`-`),[mo]:e.namespaceURI===ge}}function lo(e){var t=e.getAttribute(`is`)||e.nodeName,n=bo.get(t);if(n)return n;bo.set(t,n=new Set);for(var r,i=e,a=Element.prototype;a!==i;){for(var o in r=_(i),r)r[o].set&&o!==`innerHTML`&&o!==`textContent`&&o!==`innerText`&&n.add(o);i=b(i)}return n}var uo,fo,po,mo,ho,go,_o,vo,yo,bo,xo=e((()=>{s(),B(),C(),mi(),yt(),Se(),F(),lt(),ti(),Q(),Pa(),Wa(),Ka(),Ya(),_e(),K(),ro(),Ot(),uo=Symbol(`class`),fo=Symbol(`style`),po=Symbol(`is custom element`),mo=Symbol(`is html`),ho=me?`link`:`LINK`,go=me?`input`:`INPUT`,_o=me?`option`:`OPTION`,vo=me?`select`:`SELECT`,yo=me?`progress`:`PROGRESS`,bo=new Map})),So=e((()=>{B(),G(),vi(),Pa()})),Co=e((()=>{St()}));function wo(e,t,n=t){var r=new WeakSet;xt(e,`input`,async i=>{var a=i?e.defaultValue:e.value;if(a=To(e)?Eo(a):a,n(a),H!==null&&r.add(H),await Nr(),a!==(a=t())){var o=e.selectionStart,s=e.selectionEnd,c=e.value.length;if(e.value=a??``,s!==null){var l=e.value.length;o===s&&s===c&&l>c?(e.selectionStart=l,e.selectionEnd=l):(e.selectionStart=o,e.selectionEnd=Math.min(s,l))}}}),(R&&e.defaultValue!==e.value||Ir(t)==null&&e.value)&&(n(To(e)?Eo(e.value):e.value),H!==null&&r.add(H)),nr(()=>{var n=t();if(e===document.activeElement){var i=Ke?Xt:H;if(r.has(i))return}To(e)&&n===Eo(e.value)||(e.type!==`date`||n||e.value)&&n!==e.value&&(e.value=n??``)})}function To(e){var t=e.type;return t===`number`||t===`range`}function Eo(e){return e===``?null:+e}var Do=e((()=>{s(),K(),St(),Ge(),En(),lt(),B(),Q(),cn(),Je()})),Oo=e((()=>{K(),St()})),ko=e((()=>{St()})),Ao=e((()=>{K(),C()})),jo=e((()=>{K(),Q()}));function Mo(e,t){return e===t||e?.[j]===t}function No(e=tt(),t,n,r){var i=rt.r,a=X;return er(()=>{var o,s;return nr(()=>{o=s,s=r?.()||[],Ir(()=>{Mo(n(...s),e)||(t(e,...s),o&&Mo(n(...o),e)&&t(null,...o))})}),()=>{let r=a;for(;r!==i&&r.parent!==null&&r.parent.f&33554432;)r=r.parent;let o=()=>{s&&Mo(n(...s),e)&&t(null,...s)},c=r.teardown;r.teardown=()=>{o(),c?.()}}}),e}var Po=e((()=>{F(),it(),K(),Q()})),Fo=e((()=>{K(),St()})),Io=e((()=>{K(),St()})),Lo=e((()=>{C(),K(),mi()})),Ro=e((()=>{C(),it(),zt(),K(),Q()})),zo=e((()=>{Sn(),Q(),C()})),Bo=e((()=>{Q(),C()})),Vo=e((()=>{C(),Bo()}));function Ho(e){var t=Uo;try{return Uo=!1,[e(),Uo]}finally{Uo=t}}var Uo,Wo=e((()=>{Bo(),Vo(),C(),Q(),K(),Sn(),Uo=!1}));function Go(e,t,n){return new Proxy({props:e,exclude:t},qo)}function Ko(e,t,n,r){var i=!qe||!!(n&2),a=!!(n&8),o=!!(n&16),s=r,c=!0,l=void 0,u=()=>o&&i?(l??=kt(r),J(l)):(c&&(c=!1,s=o?Ir(r):r),s);let d;if(a){var f=j in e||le in e;d=g(e,t)?.set??(f&&t in e?n=>e[t]=n:void 0)}var p,m=!1;a?[p,m]=Ho(()=>e[t]):p=e[t],p===void 0&&r!==void 0&&(p=u(),d&&(i&&Be(t),d(p)));var h=i?()=>{var n=e[t];return n===void 0?u():(c=!0,n)}:()=>{var n=e[t];return n!==void 0&&(s=void 0),n===void 0?s:n};if(i&&!(n&4))return h;if(d){var _=e.$$legacy;return(function(e,t){return arguments.length>0?((!i||!t||_||m)&&d(t?h():e),e):h()})}var v=!1,y=(n&1?kt:Mt)(()=>(v=!1,h()));a&&J(y);var b=X;return(function(e,t){if(arguments.length>0){let n=t?J(y):i&&a?Cn(e):e;return fn(y,n),v=!0,s!==void 0&&(s=n),e}return Lr&&v||b.f&16384?y.v:J(y)})}var qo,Jo=e((()=>{s(),_e(),C(),Sn(),zt(),Q(),Ge(),F(),En(),Wo(),Je(),K(),qo={get(e,t){if(!e.exclude.has(t))return e.props[t]},set(e,t){return!1},getOwnPropertyDescriptor(e,t){if(!e.exclude.has(t)&&t in e.props)return{enumerable:!0,configurable:!0,value:e.props[t]}},has(e,t){return!e.exclude.has(t)&&t in e.props},ownKeys(e){return Reflect.ownKeys(e.props).filter(t=>!e.exclude.has(t))}}})),Yo=e((()=>{it(),K(),Wo(),Ot()})),Xo=e((()=>{F(),K(),Sn(),Ri(),Q(),cn(),C(),Ge(),it(),Je(),ft(),Lo()})),Zo=e((()=>{Xo(),K(),Ti(),C(),G()})),Qo=e((()=>{F(),Ye(),Q()})),$o=e((()=>{Gr(),_e(),it(),ni(),ri(),zi(),Bi(),Vi(),Xe(),Hi(),Ui(),Wi(),qi(),Yi(),Qi(),$i(),ua(),da(),fa(),ma(),ha(),ka(),Aa(),ja(),Ma(),Pa(),xo(),Ka(),mi(),yt(),So(),Ya(),Oa(),Co(),Do(),Oo(),ko(),Ao(),ro(),jo(),Po(),Fo(),Io(),B(),Lo(),Ro(),zo(),Ti(),Ot(),cn(),zt(),K(),Sn(),Jo(),Wo(),ji(),yr(),Ri(),Q(),Yo(),va(),En(),Zo(),G(),Wa(),Ye(),C(),pa(),Dn(),Qo()})),es=e((()=>{B(),Ge()})),ts=e((()=>{Q(),C(),$o(),Ge(),it(),s(),cn(),es(),Ri(),ma()})),ns=e((()=>{})),rs=e((()=>{ns(),typeof window<`u`&&((window.__svelte??={}).v??=new Set).add(`5`)}));function is(e){let t=e-1;return t*t*t+1}function as(e){let t=typeof e==`string`&&e.match(/^\s*(-?[\d.]+)([^\s]*)\s*$/);return t?[parseFloat(t[1]),t[2]||`px`]:[e,`px`]}function os(e,t,n){return Number.isNaN(t)?``:`${e}: ${n*t}px;`}function ss(e,{delay:t=0,duration:n=400,easing:r=us}={}){let i=+getComputedStyle(e).opacity;return{delay:t,duration:n,easing:r,css:e=>`opacity: ${e*i}`}}function cs(e,{delay:t=0,duration:n=400,easing:r=is,x:i=0,y:a=0,opacity:o=0}={}){let s=getComputedStyle(e),c=+s.opacity,l=s.transform===`none`?``:s.transform,u=c*(1-o),[d,f]=as(i),[p,m]=as(a);return{delay:t,duration:n,easing:r,css:(e,t)=>`
			transform: ${l} translate(${(1-e)*d}${f}, ${(1-e)*p}${m});
			opacity: ${c-u*t}`}}function ls(e,{delay:t=0,duration:n=400,easing:r=is,axis:i=`y`}={}){let a=getComputedStyle(e),o=+a.opacity,s=i===`y`?`height`:`width`,c=parseFloat(a[s]),l=i===`y`?[`top`,`bottom`]:[`left`,`right`],u=l.map(e=>`${e[0].toUpperCase()}${e.slice(1)}`),d=parseFloat(a[`padding${u[0]}`]),f=parseFloat(a[`padding${u[1]}`]),p=parseFloat(a[`margin${u[0]}`]),m=parseFloat(a[`margin${u[1]}`]),h=parseFloat(a[`border${u[0]}Width`]),g=parseFloat(a[`border${u[1]}Width`]);return{delay:t,duration:n,easing:r,css:e=>`overflow: hidden;opacity: ${Math.min(e*20,1)*o};`+os(s,c,e)+os(`padding-${l[0]}`,d,e)+os(`padding-${l[1]}`,f,e)+os(`margin-${l[0]}`,p,e)+os(`margin-${l[1]}`,m,e)+os(`border-${l[0]}-width`,h,e)+os(`border-${l[1]}-width`,g,e)+`min-${s}: 0`}}var us,ds=e((()=>{s(),Se(),us=e=>e})),$,fs,ps=e((()=>{$o(),$=Cn({splash:!0,hasSong:!1,where:`server`,local:!1,hasKey:!1,askKey:0,here:{done:!1,ok:!1,gpu:``,why:``,small:!1,mem:0,cores:0,mb:0},status:null}),fs={}})),ms,hs,gs=e((()=>{ms=typeof matchMedia==`function`&&matchMedia(`(prefers-reduced-motion: reduce)`).matches,hs=e=>ms?0:e}));function _s(e,t){let n=Go(t,vs);var r=ys();so(r,()=>({viewBox:`0 0 24 24`,width:`1.2em`,height:`1.2em`,...n})),wi(e,r)}var vs,ys,bs=e((()=>{rs(),$o(),vs=new Set([`$$slots`,`$$events`,`$$legacy`]),ys=Si(`<svg><g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"><rect width="20" height="14" x="2" y="3" rx="2"></rect><path d="M8 21h8m-4-4v4"></path></g></svg>`)}));function xs(e,t){let n=Go(t,Ss);var r=Cs();so(r,()=>({viewBox:`0 0 24 24`,width:`1.2em`,height:`1.2em`,...n})),wi(e,r)}var Ss,Cs,ws=e((()=>{rs(),$o(),Ss=new Set([`$$slots`,`$$events`,`$$legacy`]),Cs=Si(`<svg><path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9"></path></svg>`)}));function Ts(e,t){let n=Go(t,Es);var r=Ds();so(r,()=>({viewBox:`0 0 24 24`,width:`1.2em`,height:`1.2em`,...n})),wi(e,r)}var Es,Ds,Os=e((()=>{rs(),$o(),Es=new Set([`$$slots`,`$$events`,`$$legacy`]),Ds=Si(`<svg><g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"><path d="M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z"></path><circle cx="16.5" cy="7.5" r=".5" fill="currentColor"></circle></g></svg>`)})),ks=e((()=>{}));function As(e,t){$e(t,!0);let n=Ko(t,`withKey`,3,!1),r=Ko(t,`id`,3,`where`),i=un(!1),a=un(``),o=un(void 0),s=jt(()=>$.here),c=jt(()=>[J(s).gpu,J(s).cores?`${J(s).cores} cores`:``,J(s).mem?J(s).mem>=8?`8 GB+`:`${J(s).mem} GB`:``].filter(Boolean).join(` · `)),l=jt(()=>J(s).done?J(s).ok?J(s).small?`Slow on a phone: use the server`:J(c):J(s).why:`Checking…`),u=jt(()=>J(s).done&&(!J(s).ok||J(s).small)),d=jt(()=>$.local?`This machine`:$.hasKey?`Key saved`:`Needs a key`),f=jt(()=>n()&&!$.local&&$.where===`server`);Zn(()=>{$.askKey&&n()&&(fn(i,!0),queueMicrotask(()=>J(o)?.focus()))});function p(){fs.setKey(J(a).trim()),fn(i,!1)}function m(){fn(a,``),fn(i,!0),queueMicrotask(()=>J(o)?.focus())}var h=Ps(),g=U(h),_=W(g,2),v=U(_);let y;var b=U(v);_s(b,{class:`ic`,"aria-hidden":`true`});var x=Nn(W(b,4),!0);Ee(2),L(v);var S=W(v,2),C=U(S);xs(C,{class:`ic`,"aria-hidden":`true`});var w=Nn(W(C,4),!0);Ee(2),L(S),L(_);var T=W(_,2),E=e=>{var t=Ns(),n=U(t);Ts(n,{class:`ic`,"aria-hidden":`true`});var r=W(n,2),s=e=>{var t=js(),n=W(U(t));L(t),oi(`click`,n,m),wi(e,t)},c=e=>{var t=Ms(),n=U(t);io(n),No(n,e=>fn(o,e),()=>J(o)),L(t),ai(`submit`,t,e=>{e.preventDefault(),p()}),oi(`change`,n,p),ai(`blur`,n,()=>{$.hasKey&&!J(a)&&fn(i,!1)}),wo(n,()=>J(a),e=>fn(a,e)),wi(e,t)};Ji(r,e=>{$.hasKey&&!J(i)?e(s):e(c,-1)}),L(t),Ta(3,t,()=>ls,()=>({duration:hs(180)})),wi(e,t)};Ji(T,e=>{J(f)&&e(E)}),L(h),rr(()=>{ao(g,`id`,`${r()??``}-h`),ao(_,`aria-labelledby`,`${r()??``}-h`),y=Ga(v,1,`card svelte-p74ejk`,null,y,{off:J(u)}),ao(v,`aria-pressed`,$.where===`here`),Mi(x,J(l)),ao(S,`aria-pressed`,$.where===`server`),Mi(w,J(d))}),oi(`click`,v,()=>fs.setWhere(`here`)),oi(`click`,S,()=>fs.setWhere(`server`)),wi(e,h),et()}var js,Ms,Ns,Ps,Fs=e((()=>{rs(),$o(),ds(),ps(),gs(),bs(),ws(),Os(),ks(),js=bi(`<span class="saved svelte-p74ejk">Server key saved <button type="button" class="change svelte-p74ejk">Change</button></span>`),Ms=bi(`<form class="svelte-p74ejk"><input type="password" autocomplete="off" spellcheck="false" placeholder="Server key" aria-label="Server key" class="svelte-p74ejk"/></form>`),Ns=bi(`<div class="key svelte-p74ejk"><!> <!></div>`),Ps=bi(`<div class="where svelte-p74ejk"><h2 class="eyebrow svelte-p74ejk">Where songs are analysed</h2> <div class="cards svelte-p74ejk" role="group"><button type="button"><!> <span class="t svelte-p74ejk">This computer</span> <span class="s svelte-p74ejk"> </span> <i class="dot svelte-p74ejk" aria-hidden="true"></i></button> <button type="button" class="card svelte-p74ejk"><!> <span class="t svelte-p74ejk">The server</span> <span class="s svelte-p74ejk"> </span> <i class="dot svelte-p74ejk" aria-hidden="true"></i></button></div> <!></div>`),si([`click`,`change`])}));function Is(e,t){let n=Go(t,Ls);var r=Rs();so(r,()=>({viewBox:`0 0 24 24`,width:`1.2em`,height:`1.2em`,...n})),wi(e,r)}var Ls,Rs,zs=e((()=>{rs(),$o(),Ls=new Set([`$$slots`,`$$events`,`$$legacy`]),Rs=Si(`<svg><path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 3v12m5-7l-5-5l-5 5m14 7v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path></svg>`)}));function Bs(e,t){let n=Go(t,Vs);var r=Hs();so(r,()=>({viewBox:`0 0 24 24`,width:`1.2em`,height:`1.2em`,...n})),wi(e,r)}var Vs,Hs,Us=e((()=>{rs(),$o(),Vs=new Set([`$$slots`,`$$events`,`$$legacy`]),Hs=Si(`<svg><path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 12h14m-7-7l7 7l-7 7"></path></svg>`)})),Ws=e((()=>{}));function Gs(e,t){$e(t,!0);let n=[{title:`Dropping Out of School`,by:`Brad Sucks`,url:`https://archive.org/download/bs-out-of-it-remastered/01%20Dropping%20Out%20of%20School.mp3`},{title:`Incoherent`,by:`Josh Woodward`,url:`https://archive.org/download/JoshWoodwardSelection/20-JoshWoodward-HereToday-01-Incoherent.mp3`},{title:`Goldberg Variations: Aria`,by:`Kimiko Ishizaka`,url:`https://archive.org/download/OpenGoldbergVariations/Kimiko%20Ishizaka%20-%20J.S.%20Bach-%20-Open-%20Goldberg%20Variations%2C%20BWV%20988%20%28Piano%29%20-%2001%20Aria.mp3`},{title:`Invincible`,by:`Gigatop Arthur`,url:`https://archive.org/download/jamendo-140090/01-1165390-Gigatop%20Arthur-Invincible.mp3`}],r=un(``);function i(e){e.preventDefault();let t=J(r).trim();/^https?:\/\/\S+$/i.test(t)?fs.link(t):fs.say(`Paste a link that starts with https://`,!0)}let a=0,o=!1;function s(){o=!1,clearTimeout(a),a=setTimeout(()=>{o||fs.say(`No file picker? Open this page in your browser to load songs.`,!0)},2500)}function c(e){clearTimeout(a);let t=e.currentTarget.files?.[0];e.currentTarget.value=``,t&&fs.file(t)}Zn(()=>{let e=()=>{o=!0},t=()=>{document.hidden&&(o=!0)};return addEventListener(`blur`,e),document.addEventListener(`visibilitychange`,t),()=>{removeEventListener(`blur`,e),document.removeEventListener(`visibilitychange`,t)}});let l=e=>({y:10,duration:hs(320),delay:hs(60+e*70)});var u=Ci(),d=Mn(u),f=e=>{var t=Js(),a=U(t),o=U(a),u=W(o,2),d=U(u),f=U(d);Is(f,{class:`ic`,"aria-hidden":`true`});var p=W(f,2);L(d);var m=W(d,2),h=U(m);io(h);var g=W(h,2);Bs(U(g),{class:`ic`,"aria-hidden":`true`}),L(g),L(m),L(u);var _=W(u,2),v=W(U(_),2),y=U(v);ra(W(y,2),17,()=>n,ea,(e,t)=>{var n=Ks(),r=U(n),i=Nn(W(r),!0);L(n),rr(()=>{Mi(r,`${J(t).title??``} `),Mi(i,J(t).by)}),oi(`click`,n,()=>fs.link(J(t).url,J(t).title)),wi(e,n)}),L(v),L(_);var b=W(_,2);As(U(b),{withKey:!0,id:`where-splash`}),L(b);var x=W(b,2),S=e=>{var t=qs();oi(`click`,t,()=>fs.back()),wi(e,t)};Ji(x,e=>{$.hasSong&&e(S)}),L(a),L(t),Ta(1,o,()=>cs,()=>l(0)),oi(`click`,p,s),oi(`change`,p,c),ai(`submit`,m,i),wo(h,()=>J(r),e=>fn(r,e)),Ta(1,u,()=>cs,()=>l(1)),oi(`click`,y,()=>fs.demo()),Ta(1,_,()=>cs,()=>l(2)),Ta(1,b,()=>cs,()=>l(3)),Ta(2,t,()=>ss,()=>({duration:hs(160)})),wi(e,t)};Ji(d,e=>{$.splash&&e(f)}),wi(e,u),et()}var Ks,qs,Js,Ys=e((()=>{rs(),$o(),ds(),ps(),gs(),Fs(),zs(),Us(),Ws(),Ks=bi(`<button class="song svelte-2inaju" type="button"> <span class="svelte-2inaju"> </span></button>`),qs=bi(`<button class="btn btn-small btn-quiet back svelte-2inaju" type="button">Back to the song</button>`),Js=bi(`<section class="splash svelte-2inaju" aria-labelledby="splashTitle"><div class="in svelte-2inaju"><h1 class="title svelte-2inaju" id="splashTitle" data-text="Pitchscape">Pitchscape</h1> <div class="box pick svelte-2inaju"><label class="btn btn-primary upload svelte-2inaju"><!>Upload a song <input type="file" accept="audio/*,.mp3,.m4a,.aac,.wav,.ogg,.oga,.flac,.opus" class="svelte-2inaju"/></label> <form class="link svelte-2inaju"><input type="url" inputmode="url" autocomplete="off" spellcheck="false" placeholder="or paste a link to an audio file" aria-label="Link to an audio file" class="svelte-2inaju"/> <button class="btn go svelte-2inaju" type="submit" aria-label="Open the link"><!></button></form></div> <div class="box svelte-2inaju"><h2 class="eyebrow svelte-2inaju">Or try one of ours</h2> <div class="songs svelte-2inaju"><button class="song svelte-2inaju" type="button">Demo song <span class="svelte-2inaju">made here</span></button> <!></div></div> <div><!></div> <!></div></section>`),si([`click`,`change`])}));function Xs(e,t){let n=Go(t,Zs);var r=Qs();so(r,()=>({viewBox:`0 0 24 24`,width:`1.2em`,height:`1.2em`,...n})),wi(e,r)}var Zs,Qs,$s=e((()=>{rs(),$o(),Zs=new Set([`$$slots`,`$$events`,`$$legacy`]),Qs=Si(`<svg><path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.1 2.182a10 10 0 0 1 3.8 0m0 19.636a10 10 0 0 1-3.8 0m7.509-18.097a10 10 0 0 1 2.69 2.7M2.182 13.9a10 10 0 0 1 0-3.8m18.097 7.509a10 10 0 0 1-2.7 2.69M21.818 10.1a10 10 0 0 1 0 3.8M3.721 6.391a10 10 0 0 1 2.7-2.69m-.03 16.578a10 10 0 0 1-2.69-2.7"></path></svg>`)}));function ec(e,t){let n=Go(t,tc);var r=nc();so(r,()=>({viewBox:`0 0 24 24`,width:`1.2em`,height:`1.2em`,...n})),wi(e,r)}var tc,nc,rc=e((()=>{rs(),$o(),tc=new Set([`$$slots`,`$$events`,`$$legacy`]),nc=Si(`<svg><g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><path d="m16 9l-5.5 5.5L8 12"></path></g></svg>`)}));function ic(e,t){let n=Go(t,ac);var r=oc();so(r,()=>({viewBox:`0 0 24 24`,width:`1.2em`,height:`1.2em`,...n})),wi(e,r)}var ac,oc,sc=e((()=>{rs(),$o(),ac=new Set([`$$slots`,`$$events`,`$$legacy`]),oc=Si(`<svg><path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 12a9 9 0 1 1-6.219-8.56"></path></svg>`)})),cc=e((()=>{}));function lc(e,t){$e(t,!0);let n=jt(()=>$.status),r=jt(()=>J(n)?Math.round(J(n).p*100):0);var i=Ci(),a=Mn(i),o=e=>{var t=mc(),i=U(t),a=e=>{var t=uc(),r=Nn(t,!0);rr(()=>Mi(r,J(n).song)),wi(e,t)};Ji(i,e=>{J(n).song&&e(a)});var o=W(i,2);Xi(o,()=>J(n).label,e=>{var t=dc(),r=Nn(t,!0);rr(()=>Mi(r,J(n).label)),Ta(1,t,()=>cs,()=>({y:6,duration:hs(220)})),wi(e,t)});var s=W(o,2),c=U(s);let l;L(s);var u=W(s,2),d=U(u),f=Nn(d,!0),p=Nn(W(d),!0);L(u);var m=W(u,2),h=e=>{var t=pc();ra(t,21,()=>J(n).steps,e=>e.k,(e,t)=>{var n=fc(),r=U(n),i=e=>{ic(e,{class:`ic spin`,"aria-hidden":`true`})},a=e=>{ec(e,{class:`ic`,"aria-hidden":`true`})},o=e=>{Xs(e,{class:`ic`,"aria-hidden":`true`})};Ji(r,e=>{J(t).state===`now`?e(i):J(t).state?e(a,1):e(o,-1)});var s=W(r);L(n),rr(()=>{Ga(n,1,Ra(J(t).state),`svelte-1rjc52y`),Mi(s,` ${J(t).label??``}`)}),wi(e,n)}),L(t),wi(e,t)};Ji(m,e=>{J(n).steps&&e(h)}),L(t),rr(()=>{ao(s,`aria-label`,J(n).label),ao(s,`aria-valuenow`,J(r)),l=Ja(c,``,l,{width:`${J(r)??``}%`}),Mi(f,J(n).note),Mi(p,J(r)>2?J(r)+`%`:``)}),Ta(1,t,()=>cs,()=>({y:12,duration:hs(260)})),Ta(2,t,()=>ss,()=>({duration:hs(160)})),wi(e,t)};Ji(a,e=>{J(n)&&e(o)}),wi(e,i),et()}var uc,dc,fc,pc,mc,hc=e((()=>{rs(),$o(),ds(),ps(),gs(),$s(),rc(),sc(),cc(),uc=bi(`<p class="song svelte-1rjc52y"> </p>`),dc=bi(`<p class="now svelte-1rjc52y"> </p>`),fc=bi(`<li><!> </li>`),pc=bi(`<ol class="steps svelte-1rjc52y"></ol>`),mc=bi(`<div class="status svelte-1rjc52y" role="status"><!> <!> <div class="bar svelte-1rjc52y" role="progressbar" aria-valuemin="0" aria-valuemax="100"><i class="svelte-1rjc52y"></i></div> <p class="meta svelte-1rjc52y"><span> </span><span> </span></p> <!></div>`)}));function gc(){var e=function(e){return document.getElementById(e)},t=e(`cv`),n=t.getContext(`2d`),r=e(`liveCv`),i=r.getContext(`2d`),a=e(`grainCv`),o=e(`sheet`),s=e(`shake`),c=e(`stripView`),l=e(`stripRow`),u=e(`head`),d=e(`fps`),f=e(`glowBass`),p=e(`glowKick`),m=e(`plate`),h=e(`player`),g=e(`play`),_=e(`seek`),v=e(`labSeek`),y=e(`tNow`),b=e(`tDur`),x=e(`msg`),S=!!(window.matchMedia&&matchMedia(`(prefers-reduced-motion: reduce)`).matches),C=getComputedStyle(document.documentElement);function w(e,t){return C.getPropertyValue(e).trim()||t}var T={paper:w(`--paper`,`#EEF0EA`),ink:w(`--ink`,`#23211F`),blue:w(`--blue`,`#3255A4`),pink:w(`--pink`,`#FF48B0`),purple:w(`--purple`,`#765BA7`),teal:w(`--teal`,`#00838A`),orange:w(`--orange`,`#FF6C2F`),sun:w(`--sun`,`#FFB511`),green:w(`--green`,`#00A95C`),crimson:w(`--crimson`,`#E45D50`)};function E(e,t){var n=e.replace(`#`,``);return`rgba(`+parseInt(n.slice(0,2),16)+`,`+parseInt(n.slice(2,4),16)+`,`+parseInt(n.slice(4,6),16)+`,`+t+`)`}var ee=`500 9.5px "DM Mono", ui-monospace, Menlo, monospace`,D={ana:null,dur:0,name:``,key:``,kicks:[],snares:[],hats:[],toms:[],cymbals:[],segs:[],segMax:0,medHz:330,lines:[],wt:[],words:[],lineStarts:[],vis:{bass:!0,kick:!0,snare:!0,hats:!0,toms:!0,voice:!0,guitar:!0,piano:!0,synths:!0,words:!0},dirty:!0,neverPlayed:!0,previewT:0,tap:null,busy:!1,timing:null,song:``},O={get:function(e){try{return JSON.parse(localStorage.getItem(e)||`null`)}catch{return null}},set:function(e,t){try{localStorage.setItem(e,JSON.stringify(t))}catch{}},del:function(e){try{localStorage.removeItem(e)}catch{}}},te={colour:`inst`,drums:`sound`,kick:`splat`,bass:`smudge`,font:`grotesque`,wordSize:`voice`,shake:S?0:.25,tilt:S?0:.5,pulse:S?0:.6,slip:S?0:.35,secs:0,ink:1,weight:1,grain:.5,thick:`ear`,edges:1,guides:`on`,fps:`off`,vConf:.45,vFloor:.04,vRun:90,bFloor:.08,hold:.3,noteMin:100,drumK:1,rough0:.1,sharp0:1.75,leap:4},ne=2,re=O.get(`pitchscape:lab`),k=Object.assign({},te,re&&re.v===ne?re.set:{});k.kick===`smudge`&&(k.kick=`splat`);function ie(){var e={};for(var t in k)k[t]!==te[t]&&(e[t]=k[t]);O.set(`pitchscape:lab`,{v:ne,set:e})}var ae=null;function oe(e,t){x.textContent=e||``,x.classList.toggle(`err`,!!t),clearTimeout(ae),e&&!t&&(ae=setTimeout(function(){x.textContent===e&&(x.textContent=``)},4e3))}function se(e){e=Math.max(0,e||0);var t=Math.floor(e/60),n=Math.floor(e%60);return t+`:`+(n<10?`0`:``)+n}function A(e,t,n){return e<t?t:e>n?n:e}function j(e){return e|=0,e=Math.imul(e^e>>>16,73244475),e=Math.imul(e^e>>>16,73244475),e^=e>>>16,(e>>>0)/4294967296}function ce(e,t,n){for(var r=0,i=e.length;r<i;){var a=r+i>>1;e[a][n]<t?r=a+1:i=a}return r}var le=0,M=0,N=1,ue=0,P=4.2,de=100,fe=Math.log2(28),pe=Math.log2(1e4),me=60;function F(e){var t=me+12,n=M-12;return n-(Math.log2(Math.max(e,20))-fe)/(pe-fe)*(n-t)}function he(){me=Math.round(A(M*.15,54,116)),ot=(M-me-24)/((pe-fe)*12)}function I(e,t){return ue-(t-e)*de}function ge(e){return 4+3.2*Math.log2(Math.max(e,30)/30)}function _e(){N=Math.min(2,window.devicePixelRatio||1),le=Math.max(200,t.clientWidth),M=Math.max(200,t.clientHeight),t.width=r.width=Math.round(le*N),t.height=r.height=Math.round(M*N),P=k.secs>0?k.secs:le<520?4.2:le<900?5.5:7,he(),ue=Math.round(le*(le<520?.82:.86)),de=ue/P,u.style.left=ue-4.5+`px`,ve(),Ae(),B={},vn(),D.dirty=!0,U&&Rr()}function ve(){var e=a;e.width=t.width,e.height=t.height;for(var n=e.getContext(`2d`),r=n.createImageData(e.width,e.height),i=r.data,o=0;o<i.length;o+=4){var s=Math.random();s<.055&&(i[o]=i[o+1]=i[o+2]=255,i[o+3]=70+s*2e3)}n.putImageData(r,0,0)}function ye(e){D.ana=e,D.dur=e.dur;var t=e.evW,n=e.events,r;for(D.hits=[],r=0;r+t<=n.length;r+=t){var i={t:n[r],k:n[r+1],s:n[r+2],hz:n[r+3],d:n[r+4],p:n.subarray(r+5,r+5+16),mg:n[r+t-1],id:r/t};i.br=dt(i.p),i.mhz=ft(i.k,i),D.hits.push(i)}D.segs=[],D.bends=e.bends,D.holds=e.holds;var a=e.segW,o=e.segs;for(r=0;r+a<=o.length;r+=a)D.segs.push({t0:o[r],t1:o[r+1],m:o[r+2],a:o[r+3],b:o[r+4],z:o[r+5],f:o[r+6],att:o[r+7],dec:o[r+8],vd:o[r+9],vr:o[r+10],h:o[r+11],src:o[r+12],ro:o[r+13],sh:o[r+14],bs:o[r+15],bn:o[r+16],id:r/a});e.leadHz0=e.leadHz,e.bassHz0=e.bassHz,e.leadEar=nt(e.leadEar,rt(e.leadHz0)),e.bassEar=nt(e.bassEar,rt(e.bassHz0)),D.noteEar=nt(e.noteEar,D.segs.map(function(e){return[e.bs,e.bs+e.bn]})),Se()}function be(e,t){return Math.min(1,Math.hypot(A((e-k.rough0)/.3,0,1),A((t-k.sharp0)/1.25,0,1)))}var xe=0;function Se(){var e=D.ana;if(e){xe++;var t=e.frames,n,r,i=new Uint8Array(t),a=Math.max(1,Math.round(k.vRun/1e3/e.dt));for(n=0;n<t;n++)i[n]=+(e.leadHz0[n]>0&&e.leadP[n]>=k.vConf&&e.leadL[n]>=k.vFloor);for(n=0;n<t;)if(!i[n])n++;else{for(r=n;r<t&&i[r];)r++;r-n<a&&i.fill(0,n,r),n=r}var o=new Float32Array(t);for(n=0;n<t;n++)o[n]=i[n]?e.leadHz0[n]:0;e.leadHz=Te(o);var s=new Float32Array(t);for(n=0;n<t;n++)s[n]=e.bassN[n]>=k.bFloor?e.bassHz0[n]:0;e.bassHz=s;var c=new Float32Array(t),l=new Float32Array(t);for(n=0;n<t;n++)c[n]=be(e.leadRough[n],e.leadSharp[n]),l[n]=be(e.bassRough[n],e.bassSharp[n]);e.leadH=we(c,11),e.bassH=we(l,11),D.kicks=[],D.snares=[],D.hats=[],D.toms=[],D.cymbals=[];var u=[D.kicks,D.snares,D.hats,D.toms,D.cymbals];D.hits.forEach(function(e){e.mg>=k.drumK&&u[e.k].push(e)}),D.pieces=[],D.segMax=0;var d=2816/22050,f=k.noteMin/1e3,p=D.holds;D.segs.forEach(function(e){e.hs=be(e.ro,e.sh);var t=e.bn,n=(e.t1-e.t0)/Math.max(1,t-1),r=-1,i=-1,a=!0;function o(){var t=r===0?e.t0:e.t0+r*n,a=Math.min(e.t1,e.t0+i*n+n);a-t>=f&&(D.pieces.push({s:e,t0:t,t1:a}),a-t>D.segMax&&(D.segMax=a-t))}for(var s=0;s<t;s++)p[e.bs+s]>=k.hold?(r<0&&(r=a&&s*n<=d?0:s),i=s):r>=0&&(s-i)*n>d&&(o(),r=-1,a=!1);r>=0&&o()}),D.pieces.sort(function(e,t){return e.t0-t.t0});var m=[];for(n=0;n<e.leadHz.length;n+=3)e.leadHz[n]>0&&m.push(e.leadHz[n]);m.sort(function(e,t){return e-t}),D.medHz=m.length?m[m.length>>1]:330,Ce(e),he()}}function Ce(e){for(var t=[],n=0;n<e.bassHz.length;n+=2)e.bassHz[n]>0&&t.push(e.bassHz[n]);for(n=0;n<e.leadHz.length;n+=2)e.leadHz[n]>0&&t.push(e.leadHz[n]);if(D.pieces.forEach(function(n){for(var r=DSP.mtof(n.s.m),i=Math.max(1,Math.round((n.t1-n.t0)/(2*e.dt)));i>0;i--)t.push(r)}),t.length<50)fe=Math.log2(28),pe=Math.log2(1e4);else{t.sort(function(e,t){return e-t});var r=Math.log2(t[Math.floor(t.length*.01)])-.25,i=Math.log2(t[Math.floor(t.length*.995)])+.33;if(i-r<3){var a=(i+r)/2;r=a-1.5,i=a+1.5}fe=Math.max(Math.log2(24),r),pe=Math.min(Math.log2(9e3),i)}}function we(e,t){for(var n=new Float32Array(e.length),r=0,i=0;i<e.length+t;i++)i<e.length&&(r+=e[i]),i-2*t-1>=0&&(r-=e[i-2*t-1]),i-t>=0&&i-t<e.length&&(n[i-t]=r/(2*t+1));return n}function Te(e){for(var t=e.slice(),n=1;n<e.length-1;n++){var r=e[n-1],i=e[n],a=e[n+1];if(r>0&&i>0&&a>0){var o=12*Math.log2(i/r),s=12*Math.log2(i/a);Math.abs(o)>.8&&Math.abs(s)>.8&&o*s>0&&Math.abs(12*Math.log2(r/a))<.6&&(t[n]=Math.sqrt(r*a))}}return t}function L(e){var t=D.ana.noiseRef;return A(((e-t[0])/Math.max(.05,t[1]-t[0])-.35)*1.2,0,1)}function Ee(e){return A((e-.35)/.4,0,1)}function De(e,t,n){for(var r=0,i=ce(e,t-.6,`t`);i<e.length&&e[i].t<=t;i++)r+=e[i].s*Math.exp(-(t-e[i].t)*n);return Math.min(1.3,r)}function Oe(e){for(var t=D.ana,n=Math.round(e/t.dt),r=-1,i=0,a=0;a<=11;a++){var o=n+a;o<t.frames&&t.leadHz[o]>0&&t.leadN[o]>i&&(i=t.leadN[o],r=o)}if(r>=0)return r;for(a=1;a<=4;a++)if(n-a>=0&&t.leadHz[n-a]>0)return n-a;return-1}var R=[`#E4413A`,`#FF6C2F`,`#FFB511`,`#C2B21A`,`#6DB33F`,`#00A95C`,`#00838A`,`#0078BF`,`#3255A4`,`#765BA7`,`#B44C97`,`#FF48B0`],z=[],B={};function ke(e){return e=e.replace(`#`,``),[parseInt(e.slice(0,2),16),parseInt(e.slice(2,4),16),parseInt(e.slice(4,6),16)]}function Ae(){var e=[T.blue,T.teal,T.green,T.sun,T.orange,T.pink].map(ke);z=[];for(var t=0;t<96;t++){var n=t/95*(e.length-1),r=Math.min(e.length-2,Math.floor(n)),i=n-r,a=[0,1,2].map(function(t){return Math.round(e[r][t]+(e[r+1][t]-e[r][t])*i)});z.push(`#`+a.map(function(e){return(e<16?`0`:``)+e.toString(16)}).join(``))}}function je(e){return z[Math.round(A((M-12-e)/Math.max(1,M-28),0,1)*95)]||T.ink}var Me={voice:`#FF48B0`,words:`#914E72`,guitar:`#FF6C2F`,piano:`#FFB511`,lead:`#00838A`,pluck:`#009DA5`,pad:`#82D8D5`,bass:`#3255A4`,drum:`#23211F`};function Ne(e,t,n){return k.colour===`height`?je(n??F(t||1e3)):k.colour===`note`&&e!==`drum`&&t>0?R[(Math.round(DSP.ftom(t))%12+12)%12*7%12]:Me[e]}function Pe(e){return Math.min(1,e*k.ink)}function Fe(e,t,n){var r=e-Math.floor(e),i=(1-t)*Math.sin(6.2832*e)*.55+t*(2*r-1);return n?i*(1-n)+n*(r<.5?.75:-.75):i}var Ie={};function Le(e){var t=Ie[e];if(!t){var n=e.replace(`#`,``);t=Ie[e]=`rgba(`+parseInt(n.slice(0,2),16)+`,`+parseInt(n.slice(2,4),16)+`,`+parseInt(n.slice(4,6),16)+`,`}return t}function Re(e,t,n){var r=A((n-e)/(t-e),0,1);return r*r*(3-2*r)}function ze(e,t,r,i,a,o){var s=e.length;if(s<2)return null;var c=[],l=[],u=[],d=[],f=[],p=[],m=[],h=[],g=[],_=[],v,y,b=12,x=e[0].t,S=(e[s-1].t-x)*de;function C(e){if(a===`square`)return 1;var t=a===`blunt`?1:e/b;return i||(t=Math.min(t,(S-e)/b)),A(t,0,1)}var w=[],T=[];for(v=0;v<s-1;v++){var E=e[v],ee=e[v+1],D=(E.t-x)*de,O=(ee.t-x)*de,te=Math.max(1,Math.ceil(Math.abs(O-D)/1.6));for(y=0;y<te;y++){var ne=y/te,re=E.t+(ee.t-E.t)*ne,ie=D+(O-D)*ne,ae=C(ie);c.push(ie),l.push(E.y+(ee.y-E.y)*ne),u.push(re),_.push(ae),w.push(v),T.push(ne),d.push((E.a+(ee.a-E.a)*ne)*ae),f.push(E.c||t),p.push(E.b+(ee.b-E.b)*ne),m.push(E.z+(ee.z-E.z)*ne),h.push(re*E.r),g.push(E.q)}}var oe=e[s-1],se=i||a===`square`?1:0;c.push(S),l.push(oe.y),u.push(oe.t),_.push(-1),w.push(s-1),T.push(0),d.push(oe.a*se),f.push(oe.c||t),p.push(oe.b),m.push(0),h.push(oe.t*oe.r),g.push(oe.q);var ce=c.length,le=ce-1,M,N=c[le];if(N<1)M=Le(f[0])+d[0].toFixed(3)+`)`;else{M=n.createLinearGradient(0,0,N,0);var ue=Math.max(1,Math.floor(ce/Math.max(56,Math.ceil(N/7))));for(v=0;v<ce;v+=ue)M.addColorStop(A(c[v]/N,0,1),Le(f[v])+d[v].toFixed(3)+`)`);M.addColorStop(1,Le(f[le])+d[le].toFixed(3)+`)`)}function P(e,t,n){return t>=0?e.e[2*t+n]:n?e.wu==null?e.w:e.wu:e.wd==null?e.w:e.wd}var fe={t0:x,fill:M,prints:[]};return o.forEach(function(t){var n=new Path2D,i=null,a=[],o=[],f=t.s;for(v=0;v<ce;v++){var y=e[w[v]],b=e[Math.min(s-1,w[v]+1)],x=T[v],S=_[v],C=S<0?f*(.3+.7*se):f*(.3+.7*Math.sqrt(S)),E=(P(y,t.band,1)+(P(b,t.band,1)-P(y,t.band,1))*x)*C*k.weight,ee=(P(y,t.band,0)+(P(b,t.band,0)-P(y,t.band,0))*x)*C*k.weight,D=(E+ee)/2*(.03+.8*Math.max(p[v],.3*(g[v]||0))),O=c[v],te=l[v];if(v?n.lineTo(O,te-E-D*Fe(h[v],p[v],g[v])):n.moveTo(O,te-E-D*Fe(h[v],p[v],g[v])),a.push(O),o.push(te+ee+D*Fe(h[v]+.41,p[v],g[v])),S>=0&&m[v]>.02&&f===1&&d[v]>.05){var ne=Math.round(u[v]*300)+r;if(j(ne)<m[v]*.55){var re=.45+j(ne+29)*1.05,ie=O+(j(ne+7)-.5)*2,ae=te+(j(ne+13)*2-1)*(E+ee)/2/k.weight*1.6;i||=new Path2D,i.moveTo(ie+re,ae),i.arc(ie,ae,re,0,6.2832)}}}for(v=ce-1;v>=0;v--)n.lineTo(a[v],o[v]);n.closePath(),fe.prints.push({a:t.a,path:n,dots:i})}),fe}function Be(e,t){if(e){var r=I(e.t0,t);n.translate(r,0),n.fillStyle=e.fill;for(var i=0;i<e.prints.length;i++){var a=e.prints[i];n.globalAlpha=Pe(a.a),n.fill(a.path),a.dots&&n.fill(a.dots)}n.translate(-r,0),n.globalAlpha=1}}var Ve=new Map,He=``,Ue=0,We=0;function Ge(){var e=le+`|`+M+`|`+N+`|`+fe+`|`+pe+`|`+me+`|`+xe+`|`+JSON.stringify(k);e!==He&&(He=e,Ve.clear(),Ue++),++We%120==0&&Ve.forEach(function(e,t){e.used<We-2&&Ve.delete(t)})}function Ke(e,t){var n=Ve.get(e);return n||(n={st:t()},Ve.set(e,n)),n.used=We,n.st}function qe(e){for(var t=[],n=2;n>=0;n--)n>0&&!(k.edges>0)||t.push({a:e*(n===0?1:it[n]*k.edges),s:1,band:n});return t}function Je(e,t,r,i){i<=.03||(n.globalAlpha=Pe(.95*i),n.fillStyle=r,n.beginPath(),n.arc(ue,e,t*k.weight+1.6,0,6.2832),n.fill())}var Ye={},Xe=null,Ze=null;function Qe(e){var t=Ye[e];if(t)return t;t=document.createElement(`canvas`),t.width=t.height=64;var n=t.getContext(`2d`),r=n.createRadialGradient(32,32,0,32,32,32);return r.addColorStop(0,E(e,1)),r.addColorStop(.35,E(e,.7)),r.addColorStop(.7,E(e,.22)),r.addColorStop(1,E(e,0)),n.fillStyle=r,n.fillRect(0,0,64,64),Ye[e]=t,t}function $e(e,r,i){var a=n.canvas.width,o=n.canvas.height;(!Xe||Xe.width<a||Xe.height<o)&&(Xe=document.createElement(`canvas`),Xe.width=Math.max(a,t.width),Xe.height=Math.max(o,t.height),Ze=Xe.getContext(`2d`));var s=Ze,c,l,u=1/0,d=1/0,f=-1/0,p=-1/0,m=n.getTransform();if(s.setTransform(m),e.forEach(function(e){for(c=0;c<e.length-1;c++){var t=e[c],n=e[c+1],a=I(t.t,r),o=I(n.t,r),m=Math.max(1,Math.ceil(Math.abs(o-a)/2));for(l=0;l<m;l++){var h=l/m,g=t.a+(n.a-t.a)*h;if(!(g<.02)){var _=a+(o-a)*h,v=t.y+(n.y-t.y)*h,y;if(t.e){var b=t.e[3]+(n.e[3]-t.e[3])*h,x=t.e[2]+(n.e[2]-t.e[2])*h;v+=(x-b)/2,y=Math.max(1.5,(b+x)/2)*k.weight}else{var S=A((t.w+(n.w-t.w)*h-.8)/8,0,1);y=(ot*1.3+1.5)*(.85+.3*S)*k.weight}_+y<Vt||(s.globalAlpha=Math.min(1,i*g*3.2/y),s.drawImage(Qe(t.c),_-y,v-y,2*y,2*y),_-y<u&&(u=_-y),_+y>f&&(f=_+y),v-y<d&&(d=v-y),v+y>p&&(p=v+y))}}}}),!(f<u)){var h=1/0,g=1/0,_=-1/0,v=-1/0;[[u,d],[f,d],[u,p],[f,p]].forEach(function(e){var t=m.a*e[0]+m.c*e[1]+m.e,n=m.b*e[0]+m.d*e[1]+m.f;h=Math.min(h,t),g=Math.min(g,n),_=Math.max(_,t),v=Math.max(v,n)}),h=Math.max(0,Math.floor(h)-2),g=Math.max(0,Math.floor(g)-2),_=Math.ceil(_)+2,v=Math.ceil(v)+2;var y=Math.min(a,_),b=Math.min(o,v);y>h&&b>g&&(n.save(),n.setTransform(1,0,0,1,0,0),n.globalAlpha=Math.min(1,k.ink),n.drawImage(Xe,h,g,y-h,b-g,h,g,y-h,b-g),n.restore()),s.setTransform(1,0,0,1,0,0),s.clearRect(h,g,Math.max(0,Math.min(Xe.width,_)-h),Math.max(0,Math.min(Xe.height,v)-g))}}function et(e,t,n,r,i,a,o,s,c,l){var u=D.ana,d=u.dt,f=Math.max(0,Math.floor((e-P-.3)/d)),p=Math.min(u.frames-1,Math.floor(e/d)),m=null,h=o===`bass`&&k.bass===`smudge`,g=[],_=k.thick===`ear`,v=_?qe(s):(c>0?[{a:c,s:1.9,band:-1}]:[]).concat([{a:s,s:1,band:-1}]);function y(e){var s=t(e),c=F(s),l={t:e*d,y:c,w:n(e),a:r(e),b:i(e),z:a(e),r:ge(s),c:Ne(o,s,c)};return _&&(l.e=tt(o===`bass`?u.bassEar:u.leadEar,e),l.wd=l.e[2],l.wu=l.e[3]),l}function b(e,t){for(var n=[],r=e;r<=t;r++)n.push(y(r));return n}function x(e){var n=t(e),r=t(e-1);return n>0&&r>0&&!(Math.abs(12*Math.log2(n/r))>k.leap)}for(var S=f;S<=p;)if(!(t(S)>0))S++;else{var C=S;for(S++;S<=p&&x(S);S++);var w=S-1,T=w===p,E;h?(E=b(C,w),E.length>1&&g.push(E),T&&(m=E[E.length-1])):T?(E=b(C,w),m=E[E.length-1],E.length>1&&Be(ze(E,null,l,!0,void 0,v),e)):(w>C||C===f&&C>0&&x(C))&&Be(Ke(o+`:`+w,function(){for(var e=C;e>0&&x(e);)e--;return ze(b(e,w),null,l,!1,void 0,v)}),e)}g.length&&$e(g,e,s),m&&(m.e?Je(m.y+(m.e[0]-m.e[1])/2,h?ot*.55+.6:Math.min(ot*.8,(m.e[0]+m.e[1])/2),m.c,m.a):Je(m.y,h?ot*.55+.6:m.w,m.c,m.a))}function tt(e,t){for(var n=t*6,r=[,,,,,,],i=0;i<6;i++)r[i]=e[n+i]*ot;return r}function nt(e,t){var n=new Float32Array(e.length),r=3;return t.forEach(function(t){for(var i=t[0];i<t[1];i++)for(var a=Math.max(t[0],i-r),o=Math.min(t[1]-1,i+r),s=o-a+1,c=0;c<6;c++){for(var l=0,u=a;u<=o;u++)l+=e[u*6+c];n[i*6+c]=l/s}}),n}function rt(e){for(var t=[],n=0,r=e.length,i;n<r;)if(!(e[n]>0))n++;else{for(i=n;i<r&&e[i]>0;)i++;t.push([n,i]),n=i}return t}var it=[1,.32,.1];function at(e,t){if(e.bn<2)return 0;var n=A((t-e.t0)/Math.max(1e-6,e.t1-e.t0),0,1)*(e.bn-1),r=Math.min(e.bn-2,Math.floor(n)),i=n-r,a=D.bends,o=e.bs+r;return a[o]+(a[o+1]-a[o])*i}var ot=1;function st(e,t,n,r){for(var i=e-P-.2,a=ce(D.pieces,i-D.segMax,`t0`);a<D.pieces.length;a++){var o=D.pieces[a],s=o.s;if(o.t0>e)break;if(!(o.t1<i||s.src!==n)){var c=Math.min(o.t1,e);if(!(c-o.t0<.02)){o.t1>=e&&(t[r]+=s.a*.5);var l=DSP.mtof(s.m),u=F(l),d=o.t1>e,f=Ne(n===1?`guitar`:n===2?`piano`:s.f===1?`pad`:s.f===2?`lead`:`pluck`,l,u);if(!d)o.stG!==Ue&&(o.stG=Ue,o.st=ct(o,c,f,!1)),Be(o.st,e);else{var p=lt(o,c);Be(ct(o,c,f,!0,p),e);var m=p[p.length-1];m.e?Je(m.y+(m.e[0]-m.e[1])/2,Math.min(ot*.8,(m.e[0]+m.e[1])/2),f,m.a):Je(m.y,m.w,f,m.a)}}}}}function ct(e,t,n,r,i){var a=e.s,o=k.thick===`ear`?qe(.82):a.f===1?[{a:.12,s:1.45,band:-1},{a:.78,s:1,band:-1}]:[{a:a.f===0?.85:.82,s:1,band:-1}];return ze(i||lt(e,t),n,101+a.id*7,r,a.f===0?`blunt`:a.f===2?`square`:void 0,o)}function lt(e,t){for(var n=e.s,r=DSP.mtof(n.m),i=Ee(n.z),a=ge(r),o=Math.min(1,n.a),s=[],c=n.h>.5?A((n.h-.5)*2.5,0,1):0,l=e.t0;;l+=D.ana.dt){var u=Math.min(l,t),d=u-n.t0,f=F(DSP.mtof(n.m+at(n,u))),p,m;if(n.f===0){var h=10**(Math.max(-80,Math.min(0,n.dec))*d/20);p=(1.2+4.6*n.a)*1.3*(.22+.78*h**.7)*Math.min(1,d/.012+.6),m=(.5+.5*o)*(.35+.65*h)}else if(n.f===1){var g=Math.max(.08,n.att);p=(1+4.2*n.a)*1.6*(.04+.96*Re(0,g,d))*Math.min(1,(e.t1-u)/.25+.25),m=(.45+.55*o)*(.3+.7*Re(0,g,d))}else p=(1+4.2*n.a)*1.15*Math.min(1,(u-e.t0)/.02+.5),m=.5+.5*o;var _={t:u,y:f,w:p,a:m,b:n.hs,z:n.f===1?i*.5:i,r:a,q:c};if(k.thick===`ear`&&(_.e=tt(D.noteEar,n.bs+Math.round((u-n.t0)/Math.max(1e-6,n.t1-n.t0)*(n.bn-1)))),s.push(_),u>=t)break}return s}var V=DSP.DRUM_BANDS,ut=new Float32Array(36);function dt(e){if(!e)return .5;for(var t=0,n=0,r=0;r<e.length;r++){var i=e[r]*e[r];n+=i,V[r]>=2500&&(t+=i)}return n>0?t/n:.5}function ft(e,t){if(e===0)return A(t.hz||52,30,180);if(e===3&&t.p){for(var n=-1,r=0;r<t.p.length;r++)V[r]>=55&&V[r+1]<=760&&(n<0||t.p[r]>t.p[n])&&(n=r);if(n>=0)return Math.sqrt(V[n]*V[n+1])}var i=e===1?[350,4e3]:e===3?[60,800]:[2200,9500];return A(t.hz||i[0],i[0],i[1])}function pt(e,t,n){for(var r=ce(e,t-P-1.2,`t`);r<e.length&&e[r].t<=t;r++)ht(e[r],t,n)}function mt(e,t){if(t===`tom`)return A(F(e.mhz),me+12,M-12);var n=me-12;return 8+n*(t===`cymbal`?.2:t===`hat`?.5:.8)-(k.drums===`sound`?(e.br-.5)*n*.2:0)}function ht(e,t,r){var i=I(e.t,t),a=mt(e,r),o=t-e.t,s=o<.05?.55+.45*o/.05:1,c=k.drums===`sound`,l=c?e.br:.35,u=e.id*977+r.length*131,d=c&&(r===`hat`||r===`cymbal`)?e.d*de:0;i+d+30<Vt||(n.fillStyle=Ne(`drum`,e.mhz,a),n.beginPath(),r===`snare`?gt(i,a,(3.2+4.2*e.s)*s,l,e.s,u):r===`tom`?_t(i,a,(2.8+3.6*e.s)*s,u):vt(i,a,e.s,s,d,Math.min(o,e.d)*de,r===`cymbal`,u),n.globalAlpha=Pe(r===`snare`||r===`tom`?.92:.9),n.fill())}function gt(e,t,r,i,a,o){var s=ut.length,c,l,u=3+Math.round(6*i);for(c=0;c<s;c++)ut[c]=r*(.84+.3*j(o+c));for(c=0;c<u;c++)ut[Math.floor(j(o+50+c)*s)]=r*(1.45+(.7+1.6*i)*j(o+80+c));for(c=0;c<s;c++)l=c/s*6.2832,c?n.lineTo(e+Math.cos(l)*ut[c],t+Math.sin(l)*ut[c]):n.moveTo(e+ut[0],t);for(n.closePath(),c=0;c<2+Math.round(2*a+2*i);c++)yt(e,t,j(o+120+c)*6.2832,r*(2+1.4*j(o+140+c)),r*(.12+.16*j(o+160+c)))}function _t(e,t,r,i){for(var a=18,o=0,s,c;o<a;o++)s=o/a*6.2832,c=r*(.92+.16*j(i+o)),o?n.lineTo(e+Math.cos(s)*c,t+Math.sin(s)*c):n.moveTo(e+c,t);for(n.closePath(),o=0;o<2;o++)yt(e,t,j(i+40+o)*6.2832,r*(1.5+.7*j(i+60+o)),r*(.14+.12*j(i+80+o)))}function vt(e,t,n,r,i,a,o,s){var c=o?14+Math.round(16*n):6+Math.round(6*n),l=(o?6.5+8*n:4+4.5*n)*r,u=l*(o?.75:.9),d,f;for(yt(e,t,0,0,(o?1.1:1.9+1.2*n)*r),d=0;d<c;d++){f=Math.sqrt(j(s+30+d));var p=j(s+d)*6.2832;yt(e+Math.cos(p)*f*l,t+Math.sin(p)*f*u,0,0,(o?.6+.9*j(s+60+d):.8+1.1*j(s+60+d))*r)}if(i>2){var m=Math.min(28,Math.round(i/(o?2.5:3.5)));for(d=0;d<m;d++){var h=(d+j(s+200+d))/m;h*i>a||yt(e+h*i,t+(j(s+230+d)-.5)*u*(o?2.4:1.6)*(1-.5*h),0,0,(o?1:1.2)*(1-.55*h))}}}function yt(e,t,r,i,a){var o=e+Math.cos(r)*i,s=t+Math.sin(r)*i;n.moveTo(o+a,s),n.arc(o,s,a,0,6.2832)}function bt(e,t){var n=e+`|`+t;if(B[n])return B[n];var r=Math.ceil(2*t*N)+2,i=document.createElement(`canvas`);i.width=i.height=r;var a=i.getContext(`2d`),o=r/2,s=4.2*N,c=Math.SQRT1_2,l=Math.ceil(t*N/s)+2,u=t*N,d=Math.exp(-2.6);a.fillStyle=e,a.beginPath();for(var f=-l;f<=l;f++)for(var p=-l;p<=l;p++){var m=o+(f-p)*c*s,h=o+(f+p)*c*s,g=Math.sqrt((m-o)*(m-o)+(h-o)*(h-o))/u;if(!(g>=1)){var _=(Math.exp(-g*g*2.6)-d)/(1-d),v=s*.6*Math.sqrt(_);v<.3||(a.moveTo(m+v,h),a.arc(m,h,v,0,6.2832))}}return a.fill(),B[n]=i,i}function xt(e){for(var t=ce(D.kicks,e-P-.4,`t`);t<D.kicks.length&&D.kicks[t].t<=e;t++)St(D.kicks[t],e)}function St(e,t){var r=e.mhz,i=I(e.t,t),a=A(F(r),me+12,M-10),o=t-e.t,s=e.s,c=Ne(`drum`,r,a),l=Math.min(1,o/.28),u=(10+19*s)*(1+.4*A(e.d/.25,0,1)),d=u*(1+.35*(1-l)),f;if(k.kick===`halftone`){var p=Math.max(8,Math.round(u/4)*4);n.globalAlpha=Pe(.36+.34*s),n.drawImage(bt(c,p),i-d,a-d,2*d,2*d)}else n.fillStyle=c,n.beginPath(),gt(i,a,d*.42,.15,s,e.id*977+7),n.globalAlpha=Pe(.38+.3*s),n.fill();if(o<.45){var m=o/.45,h=u*(1.5+2.4*m);f=n.createRadialGradient(i,a,u*.4,i,a,h),f.addColorStop(0,E(c,Pe(.2*s*(1-m)*(1-m)))),f.addColorStop(1,E(c,0)),n.globalAlpha=1,n.fillStyle=f,n.beginPath(),n.arc(i,a,h,0,6.2832),n.fill()}}function Ct(e){if(D.words.length){n.textBaseline=`alphabetic`;for(var t=ce(D.words,e-P-.8,`t`);t<D.words.length&&D.words[t].t<=e;t++){var r=D.words[t],i=I(r.t,e);if(!(i+r.px<-4)){var a=e-r.t,o=a<.09?a/.09:1,s=r.yy;if(n.font=r.font,n.fillStyle=Ne(`words`,r.hz,s),n.globalAlpha=Pe(.4+.58*o),o<1){n.save(),n.translate(i,s);var c=1.25-.25*o;n.scale(c,c),n.fillText(r.text,0,0),n.restore()}else n.fillText(r.text,i,s)}}}}function wt(){if(k.guides!==`off`){n.globalCompositeOperation=`source-over`,n.globalAlpha=1,n.lineWidth=1,n.font=ee,n.textBaseline=`bottom`;for(var e=1;e<=8;e++){var t=440*2**((12*(e+1)-69)/12),r=Math.round(F(t))+.5;r<me+22||r>M-4||(n.strokeStyle=`rgba(35,33,31,0.075)`,n.beginPath(),n.moveTo(0,r),n.lineTo(le,r),n.stroke(),n.fillStyle=`rgba(35,33,31,0.42)`,n.fillText(`C`+e+` `+Math.round(t),6,r-2))}var i=me+4.5;n.strokeStyle=`rgba(35,33,31,0.09)`,n.setLineDash([1,5]),n.beginPath(),n.moveTo(0,i),n.lineTo(le,i),n.stroke(),n.setLineDash([])}}var Tt={guitar:[.8,-.6],synths:[-.4,.75],piano:[.65,.45],bass:[-.9,.3],voice:[.5,.85],hats:[-.3,-.95],toms:[.7,-.3],snare:[.95,.2],kick:[-.6,-.7],words:[.25,.6]},Et={};document.querySelectorAll(`.ink`).forEach(function(e){Et[e.dataset.layer||e.dataset.toggle]={el:e,v:-1}});function Dt(e,t){var n=Et[e];n&&(t=Math.round(A(t,0,1)*20)/20,t!==n.v&&(n.v=t,n.el.style.setProperty(`--lvl`,t)))}var Ot=/[?&]bench\b/.test(location.search)?{}:null,kt=`paint`,At=/[?&]live\b/.test(location.search);function jt(){kt===`paint`&&n.getImageData(0,0,1,1)}function Mt(e,t){jt();var n=performance.now();t(),jt(),(Ot[e]=Ot[e]||[]).push(performance.now()-n)}Ot&&(window.pitchscapeReady=function(){return!!D.ana}),Ot&&(window.pitchscapeStrips=function(){var e={};return Lt.forEach(function(t,n){e[n]=t.done}),{strips:e,pps:de,nowX:ue,W:le}}),Ot&&(window.pitchscapeBench=function(e,t){for(var n in kt=t||`paint`,Ot)delete Ot[n];var r=[];function i(){Ot.frame=r;var e={};for(var t in Ot){var n=Ot[t].slice().sort(function(e,t){return e-t});e[t]={med:n[n.length>>1],p95:n[Math.min(n.length-1,Math.floor(n.length*.95))],n:n.length}}return e}return kt===`raf`?new Promise(function(t){var n=0,a=0;(function o(s){if(n>0&&r.push(s-a),a=s,n>=e.length)return r.shift(),t(i());pn(e[n++]),requestAnimationFrame(o)})(performance.now())}):(e.forEach(function(e){jt();var t=performance.now();pn(e),jt(),r.push(performance.now()-t)}),Promise.resolve(i()))});var Nt=[[`synths`,function(e,t){st(e,t,0,`synths`)}],[`piano`,function(e,t){st(e,t,2,`piano`)}],[`guitar`,function(e,t){st(e,t,1,`guitar`)}],[`bass`,function(e){var t=D.ana;et(e,function(e){return t.bassHz[e]},function(e){return .8+12*t.bassN[e]},function(e){return Re(.015,.3,t.bassN[e])},function(e){return t.bassH[e]},function(){return 0},`bass`,.86,.15,11)}],[`voice`,function(e){var t=D.ana;et(e,function(e){return t.leadHz[e]},function(e){return .8+8.5*t.leadN[e]},function(e){return Re(.02,.4,t.leadN[e])},function(e){return t.leadH[e]},function(e){return L(t.leadNz[e])},`voice`,.9,.16,37)}],[`hats`,function(e){pt(D.hats,e,`hat`),pt(D.cymbals,e,`cymbal`)}],[`toms`,function(e){pt(D.toms,e,`tom`)}],[`snare`,function(e){pt(D.snares,e,`snare`)}],[`kick`,function(e){xt(e)}],[`words`,function(e){Ct(e)}]],Pt=1024,Ft=128,It=Pt/Ft,Lt=new Map,Rt=``,zt=null,Bt=[],Vt=-1/0,Ht={kick:.5,words:.15,hats:.1,toms:.1,snare:.1},Ut={kick:60,bass:40},Wt={words:3,hats:2.5};function Gt(e){return Wt[e]||.3}function Kt(e){return(Ht[e]||.3)+(Ut[e]||30)/de}function qt(){return Nt.filter(function(e){return D.vis[e[0]]})}function Jt(e){var t=0;return e.forEach(function(e){t=Math.max(t,Kt(e[0]))}),t}function Yt(){var e=Ue+`|`+de+`|`+JSON.stringify(D.vis);(e!==Rt||zt!==D.ana)&&(Lt.forEach(function(e){H(e)}),Lt.clear(),Rt=e,zt=D.ana)}function H(e){e.c.parentNode&&e.c.parentNode.removeChild(e.c),Bt.length<3&&Bt.push(e.c)}function Xt(e){var t=Lt.get(e);if(t)return t;for(var n=Math.ceil(Pt*N),r=Math.ceil(M*N),i=null,a=Bt.length-1;a>=0;a--)if(Bt[a].width===n&&Bt[a].height===r){i=Bt.splice(a,1)[0];break}if(!i)i=document.createElement(`canvas`),i.width=n,i.height=r;else{var o=i.getContext(`2d`);o.setTransform(1,0,0,1,0,0),o.globalCompositeOperation=`source-over`,o.clearRect(0,0,n,r)}return i.style.left=e*Pt+`px`,i.style.width=Pt+`px`,l.appendChild(i),t={c:i,done:0},Lt.set(e,t),t}function Zt(e){var t=Lt.get(Math.floor(e/It));return!!t&&t.done>e%It}function Qt(e,t,r){var i=Xt(e),a=i.done,o=e*Pt/de,s=o+a*Ft/de,c=s+Ft/de+r,l=i.c.getContext(`2d`),u=[n,ue,P];n=l,ue=(c-o)*de,l.save();try{l.setTransform(N,0,0,N,0,0),l.beginPath(),l.rect(a*Ft,0,Ft,M),l.clip(),l.globalCompositeOperation=`multiply`,t.forEach(function(e){P=c-s+Gt(e[0]),e[1](c,{guitar:0,piano:0,synths:0})})}finally{l.restore(),n=u[0],ue=u[1],P=u[2]}i.done++}var $t=null,en=null;function tn(e,t){var n=Jt(t),r=e-n,i=Math.max(0,e-(ue+40)/de),a=Ft/de,o=Math.floor(i/a),s=Math.floor(r/a),u=s+It/2,d,f,p=performance.now();for(d=o;d<=u;d++)if(!Zt(d)){if(performance.now()-p>4)break;for(f=Math.floor(d/It);Xt(f).done<=d%It&&performance.now()-p<=4;)Qt(f,t,n)}var m=i;for(d=o;d<=s&&Zt(d);d++)m=Math.min(r,(d+1)*a);var h=Math.round(I(0,e)*N)/N,g=m>i?Math.max(0,Math.round(I(m,e)*N)/N):0;h!==$t&&($t=h,l.style.transform=`translateX(`+h+`px)`),g!==en&&(en=g,c.style.width=g+`px`);var _=Math.floor(o/It),v=Math.floor(u/It);return Lt.forEach(function(e,t){(t<_||t>v)&&(Lt.delete(t),H(e))}),m}var nn=``,rn=``,an=[``,``],on=[-1,-1],sn=-1,cn=null,ln=null,un=null;function dn(e,t,n,r){r=Math.round(r*200)/200,r!==on[t]&&(on[t]=r,e.style.visibility=r>0?`visible`:`hidden`,r>0&&(e.style.opacity=String(r))),r>0&&n!==an[t]&&(an[t]=n,e.style.background=`linear-gradient(to top, `+E(n,1)+` 0, `+E(n,1)+` 30px, `+E(n,0)+` 100%)`)}function fn(){n.setTransform(N,0,0,N,0,0),n.globalCompositeOperation=`source-over`,n.globalAlpha=1,n.fillStyle=T.paper,n.fillRect(0,0,le,M),wt()}function pn(e){var t=D.ana;if(k.grain!==sn&&(sn=k.grain,a.style.opacity=String(k.grain),a.style.display=k.grain>0?``:`none`),!t)fn(),cn=null,mn(!0),dn(f,0,``,0),dn(p,1,``,0),rn&&(rn=``,s.style.transform=``),nn&&(nn=``,o.style.transform=``);else{Ge();var c=A(Math.floor(e/t.dt),0,t.frames-1),l=t.bassN[c]||0,u=De(D.kicks,e,14),d=De(D.snares,e,18),m=De(D.hats,e,22),h={guitar:0,piano:0,synths:0},g=k.shake*((D.vis.bass?l*l*5:0)+(D.vis.kick?u*9:0)+(D.vis.snare?d*2:0)),_=g*(Math.sin(e*53.1)+.7*Math.sin(e*31.7+1.3))/1.7,v=g*(Math.sin(e*47.3+2.1)+.7*Math.sin(e*29.9+.4))/1.7,y=g*.0022*Math.sin(e*37.7+.9),b=g>.01?`translate(`+_.toFixed(2)+`px,`+v.toFixed(2)+`px) rotate(`+y.toFixed(5)+`rad)`:``;b!==rn&&(rn=b,s.style.transform=b);var x=k.tilt*(9*Math.min(1,u)+3*l),S=k.tilt*1.4*l*Math.sin(e*1.3),C=k.tilt>0?`perspective(700px) rotateX(`+x.toFixed(2)+`deg) rotate(`+S.toFixed(2)+`deg)`:``;if(C!==nn&&(nn=C,o.style.transform=C),dn(f,0,Ne(`bass`,t.bassHz[c]||55,M),D.vis.bass&&l>.05?Pe(.2*l**1.5):0),dn(p,1,Ne(`drum`,50,M),D.vis.kick&&k.pulse>0&&u>.02?Math.min(.3,.22*k.pulse*u):0),W()||Ot&&At){mn(!0),cn=null;var w=k.slip*(u*2.4+l*1.1);fn(),n.globalCompositeOperation=`multiply`,Nt.forEach(function(t){var r=t[0];D.vis[r]&&(n.save(),n.translate(Tt[r][0]*w,Tt[r][1]*w),Ot?Mt(r,function(){t[1](e,h)}):t[1](e,h),n.restore())}),n.globalCompositeOperation=`source-over`}else{mn(!1),cn!==Ue&&(fn(),cn=Ue),Yt();var T=qt(),E=e,ee=P;Ot?Mt(`strips`,function(){E=tn(e,T)}):E=tn(e,T);var O=Math.round(I(E,e)*N)/N,te=Math.max(0,Math.floor(Math.min(O,ln===null?0:ln)*N)-2);ln=O;var ne=n;n=i;try{n.setTransform(1,0,0,1,0,0),n.globalCompositeOperation=`source-over`,n.globalAlpha=1,n.clearRect(te,0,r.width-te,r.height),n.setTransform(N,0,0,N,0,0),n.globalCompositeOperation=`multiply`,n.save(),n.beginPath(),n.rect(O,-80,le-O+80,M+160),n.clip(),Vt=O,T.forEach(function(t){P=Math.min(ee,e-E+Gt(t[0])),Ot?Mt(`l:`+t[0],function(){t[1](e,h)}):t[1](e,h)})}finally{P=ee,Vt=-1/0,n.restore(),n.globalCompositeOperation=`source-over`,n=ne}}var re=t.leadHz[c]>0?t.leadN[c]:0,ie=0;if(D.words.length){var ae=ce(D.words,e-.3,`t`);ae<D.words.length&&D.words[ae].t<=e&&(ie=1-(e-D.words[ae].t)/.3)}Dt(`bass`,l),Dt(`kick`,u),Dt(`snare`,d),Dt(`hats`,m),Dt(`voice`,re),Dt(`guitar`,h.guitar),Dt(`piano`,h.piano),Dt(`synths`,h.synths),Dt(`words`,ie)}}function mn(e){un!==!e&&(un=!e,ln=null,c.style.display=r.style.display=e?`none`:``,e||(i.setTransform(1,0,0,1,0,0),i.clearRect(0,0,r.width,r.height)))}var hn={grotesque:{fam:`"Bricolage Grotesque", "Avenir Next", system-ui, sans-serif`,w:[420,800],sc:1,st:``},script:{fam:`"Caveat", "Segoe Print", cursive`,css:`Caveat:wght@400..700`,w:[420,700],sc:1.38,st:``},serif:{fam:`"Fraunces", Georgia, serif`,css:`Fraunces:ital,opsz,wght@1,9..144,300..900`,w:[330,860],sc:1.08,st:`italic `},mono:{fam:`"DM Mono", ui-monospace, Menlo, monospace`,w:[400,500],sc:.94,st:``}};function gn(e){var t=hn[e]||hn.grotesque;return t.css?(t.ready||=new Promise(function(e){var n=document.createElement(`link`);n.rel=`stylesheet`,n.href=`https://fonts.googleapis.com/css2?family=`+t.css+`&display=block`,n.onload=function(){(document.fonts?document.fonts.load(t.st+t.w[1]+` 16px `+t.fam.split(`,`)[0]):Promise.resolve()).then(e,e)},n.onerror=e,document.head.appendChild(n)}),t.ready):Promise.resolve()}function _n(e){var t=hn[k.font]||hn.grotesque,n=k.wordSize===`voice`?A(e,0,1):.45,r=(k.wordSize===`voice`?10.5+9*n:13)*t.sc,i=Math.round(t.w[0]+(t.w[1]-t.w[0])*n);return{css:t.st+i+` `+r.toFixed(1)+`px `+t.fam,size:r}}function vn(){if(D.words.length&&D.ana&&M){n.save(),n.setTransform(1,0,0,1,0,0);var e=[],t=F(D.medHz)-16,r=D.medHz;D.words.forEach(function(i){var a=Oe(i.t),o=_n(a>=0?D.ana.leadN[a]:.35);i.font=o.css,i.lh=o.size+1,n.font=i.font;var s=n.measureText(i.text);i.px=s.width,i.asc=s.actualBoundingBoxAscent||o.size*.75,i.desc=s.actualBoundingBoxDescent||o.size*.22,a>=0?(i.hz=D.ana.leadHz[a],i.y=F(i.hz)-(.8+8.5*D.ana.leadN[a])*k.weight-5,t=i.y,r=i.hz):(i.y=t,i.hz=r);var c=me+6,l=M-8;i.y=A(i.y,c+i.asc,l-i.desc);var u=i.t*de,d=u+i.px,f=Math.max(6,i.lh*.55),p,m;function h(t){for(var n=e.length-1;n>=0;n--){var r=e[n];if(r.X0<u-600)break;if(r.X1+4>u&&r.X0<d+4&&r.top<t+i.desc+1&&r.bot>t-i.asc-1)return!0}return!1}var g=[];for(p=i.y;p-i.asc>=c;p-=f)g.push(p);for(p=i.y+f;p+i.desc<=l;p+=f)g.push(p);for(i.yy=i.y,m=0;m<g.length;m++)if(!h(g[m])){i.yy=g[m];break}e.push({X0:u,X1:d,top:i.yy-i.asc,bot:i.yy+i.desc})}),n.restore()}}function yn(e,t){D.lines=e,D.wt=t,D.words=[],e.forEach(function(e,n){e.words.forEach(function(e,r){var i=t[n]&&t[n][r];i!=null&&isFinite(i)&&D.words.push({t:i,text:e.text,li:n,wi:r})})}),D.words.sort(function(e,t){return e.t-t.t}),D.lineStarts=t.map(function(e){for(var t=0;e&&t<e.length;t++)if(e[t]!=null)return e[t];return null}),vn(),D.dirty=!0}function bn(e){var t=DSP.parseLyrics(e);yn(t,t.length?DSP.alignLyrics(t,D.ana):[])}t.addEventListener(`click`,function(){An.classList.contains(`away`)?Fn():Nn()&&Pn(!0)});var xn=0,Sn=-1,Cn=0,wn=!1;function Tn(){var e=h.currentTime||0,t=performance.now();if(h.paused||h.ended)return xn=e,Sn=e,Cn=t,e;e!==Sn&&(Sn=e,Cn=t);var n=Sn+(t-Cn)/1e3*(h.playbackRate||1);return xn=Math.abs(n-xn)>.35?n:Math.max(xn,n),Math.min(xn,D.dur||xn)}function En(){var t=!h.paused&&!h.ended;e(`icoPlay`).hidden=t,e(`icoPause`).hidden=!t,g.setAttribute(`aria-label`,t?`Pause`:`Play`),e(`labPlay`).textContent=t?`Pause`:`Play`}function Dn(t){g.disabled=!t,e(`labPlay`).disabled=!t}function On(){var e=h.play();e&&e.catch&&e.catch(function(){oe(`Playback was blocked. Tap play again.`,!0)})}function kn(){h.paused||h.ended?(D.neverPlayed&&=!1,h.ended&&(h.currentTime=0),On()):h.pause()}g.addEventListener(`click`,kn);var An=e(`hud`),jn=e(`labBtn`),U=e(`labPanel`),Mn=null;function Nn(){return!h.paused&&!h.ended}function W(){return!U.hidden}function Pn(e){An.classList.toggle(`away`,e),jn.classList.toggle(`away`,e)}function Fn(){clearTimeout(Mn),W()?Pn(!0):(Pn(!1),Nn()&&(Mn=setTimeout(function(){Nn()&&!In(An)&&!In(jn)&&Pn(!0)},2600)))}function In(e){var t=document.activeElement;try{return!!t&&e.contains(t)&&t.matches(`:focus-visible`)}catch{return!1}}[`pointerdown`,`focusin`,`input`].forEach(function(e){An.addEventListener(e,Fn),jn.addEventListener(e,Fn)}),m.addEventListener(`mousemove`,function(e){(e.movementX||e.movementY)&&Fn()}),[`play`,`pause`,`ended`].forEach(function(e){h.addEventListener(e,function(){En(),D.dirty=!0,Fn()})}),h.addEventListener(`seeked`,function(){D.dirty=!0}),h.addEventListener(`error`,function(){h.src&&oe(`Can't play that file here.`,!0)}),[_,v].forEach(function(e){e.addEventListener(`pointerdown`,function(){wn=!0}),e.addEventListener(`pointerup`,function(){wn=!1}),e.addEventListener(`change`,function(){wn=!1}),e.addEventListener(`input`,function(){D.neverPlayed&&=!1;var t=parseFloat(e.value);(e===_?v:_).value=e.value,h.currentTime=t,xn=t,y.textContent=se(xn),D.dirty=!0})}),document.addEventListener(`keydown`,function(e){e.code!==`Space`||/^(TEXTAREA|INPUT|BUTTON|SUMMARY)$/.test(e.target.tagName)||g.disabled||(e.preventDefault(),kn())});var Ln=null;function Rn(e){h.pause(),Ln&&URL.revokeObjectURL(Ln),Ln=e,h.src=e,h.load()}var zn=[],Bn=[],Vn=0,Hn=0;function G(e,t){var n=e.slice().sort(function(e,t){return e-t});return n[Math.min(n.length-1,Math.floor(n.length*t))]}function Un(e){var t=!h.paused&&!h.ended;if(t||D.dirty){var n=D.neverPlayed?D.previewT:Tn(),r=performance.now();pn(n),D.dirty=!1;var i=performance.now()-r;!wn&&!D.neverPlayed&&(_.value=v.value=String(n),y.textContent=se(n)),k.fps===`on`&&t?(Vn&&(zn.push(e-Vn),Bn.push(i),zn.length>120&&(zn.shift(),Bn.shift())),Vn=e,++Hn%30==0&&zn.length>=10&&(d.textContent=`frame `+G(zn,.5).toFixed(1)+` ms, slowest 5% `+G(zn,.95).toFixed(1)+`
drawing `+G(Bn,.5).toFixed(1)+` ms, slowest 5% `+G(Bn,.95).toFixed(1))):Vn=0}d.hidden!==(k.fps!==`on`)&&(d.hidden=k.fps!==`on`,d.textContent=`frame times show while it plays`,zn=[],Bn=[]),requestAnimationFrame(Un)}var Wn=null,Gn=null,Kn=!1;function qn(){return Kn?Promise.resolve(null):Gn||(Gn=new Promise(function(t){var n;try{n=new Worker(URL.createObjectURL(new Blob([e(`dsp`).textContent],{type:`text/javascript`})))}catch{Kn=!0,t(null);return}var r=setTimeout(function(){try{n.terminate()}catch{}Kn=!0,t(null)},4e3);n.onmessage=function(e){e.data&&e.data.type===`pong`&&(clearTimeout(r),Wn=n,t(n))},n.onerror=function(e){e&&e.preventDefault&&e.preventDefault(),clearTimeout(r),Kn=!0,t(null)},n.postMessage({cmd:`ping`})}),Gn)}function Jn(){Wn&&(Wn.terminate(),Wn=null,Gn=null)}function Yn(e,t,n){return qn().then(function(r){return r?new Promise(function(i,a){r.onmessage=function(e){var t=e.data;t.type===`progress`?n&&n(t.label,t.p):t.type===`error`?a(Error(t.message)):(t.type===`demo`||t.type===`done`)&&i(t)},r.onerror=function(e){a(Error(e&&e.message||`The analysis stopped.`))},r.postMessage(e,t)}):new Promise(function(e){setTimeout(e,40)}).then(function(){var e=DSP.synthDemo(44100);return{L:e.L,R:e.R,sr:e.sr}})})}function Xn(t,n,r){var i=$.status||{note:``,steps:null};$.status={label:t,p:A(n,0,1),note:r===void 0?i.note:r||``,song:e(`trackName`).textContent||``,steps:i.steps}}function Zn(){$.status=null}var Qn=[[`models`,`models`],[`stems`,`stems`],[`drums`,`drums`],[`notes`,`notes`],[`bass`,`bass`],[`voice`,`voice`],[`words`,`lyrics`],[`tone`,`tone`],[`width`,`width`]];function $n(e,t){if($.status){var n={};($.status.steps||[]).forEach(function(e){e.state&&(n[e.k]=!0)}),e&&(n[e]=!0),$.status.steps=Qn.filter(function(e){return e[0]!==`models`||t||n.models}).map(function(t){return{k:t[0],label:t[1],state:t[0]===e?`now`:n[t[0]]?`on`:``}})}}function er(e,t,n){var r=e.length,i=new ArrayBuffer(44+r*4),a=new DataView(i),o=44,s;function c(e,t){for(var n=0;n<t.length;n++)a.setUint8(e+n,t.charCodeAt(n))}for(c(0,`RIFF`),a.setUint32(4,36+r*4,!0),c(8,`WAVE`),c(12,`fmt `),a.setUint32(16,16,!0),a.setUint16(20,1,!0),a.setUint16(22,2,!0),a.setUint32(24,n,!0),a.setUint32(28,n*4,!0),a.setUint16(32,4,!0),a.setUint16(34,16,!0),c(36,`data`),a.setUint32(40,r*4,!0),s=0;s<r;s++,o+=4)a.setInt16(o,A(e[s],-1,1)*32767,!0),a.setInt16(o+2,A(t[s],-1,1)*32767,!0);return new Blob([i],{type:`audio/wav`})}var tr=0;function nr(e,t){return D.song=t||``,D.retry=null,D.busy&&Jn(),D.busy=!0,h.pause(),Dn(!1),D.ana=null,D.dur=0,D.neverPlayed=!0,D.previewT=0,yn([],[]),_.value=v.value=`0`,y.textContent=`0:00`,b.textContent=`0:00`,D.dirty=!0,oe(``),Zn(),Xn(e,.01),++tr}function rr(t,n,r,i,a){ye(t),D.name=n,D.key=r,e(`trackName`).textContent=n,b.textContent=se(t.dur),_.max=v.max=String(t.dur),_.value=v.value=`0`,y.textContent=`0:00`,D.neverPlayed=a>0,D.previewT=a,i?bn(i):yn([],[]),Zn(),Dn(!0),D.busy=!1,D.dirty=!0}function ir(){var t=nr(`Rendering the demo song`,`demo`);e(`trackName`).textContent=`Demo song`,Yn({cmd:`demo`},[],null).then(function(e){t===tr&&br(er(e.L,e.R,e.sr),`pitchscape-demo.wav`,`Demo song`,t,ir,!0)}).catch(function(e){t===tr&&or(`The demo failed to render: `+e.message)})}function ar(t){var n=nr(`Opening `+t.name,``);e(`trackName`).textContent=t.name,br(t,t.name,t.name.replace(/\.[^.]+$/,``),n,function(){ar(t)},!1)}function or(e){D.busy=!1,Zn(),Dn(!1),Fr(),oe(e,!0)}function sr(e){try{var t=new URL(e);return decodeURIComponent(t.pathname.split(`/`).pop()||``).replace(/\.[^.]+$/,``)||t.hostname}catch{return e}}function cr(t,n){var r=nr(`Fetching the song`,``);if(n||=sr(t),e(`trackName`).textContent=n,Dr()===`here`)fetch(t).then(function(e){if(!e.ok)throw Error(`That link answered `+e.status+`.`);return e.blob()},function(){throw Error(`This page can’t read that link itself (its site doesn’t allow other pages to). Choose the server, which can, or download the file and load it.`)}).then(function(e){r===tr&&br(e,sr(t)+`.mp3`,n,r,function(){cr(t,n)},!1)}).catch(function(e){r===tr&&or(e.message)});else{var i=new FormData;i.append(`url`,t),Cr(i,null,r,`Fetching the song`).then(function(e){return!e||r!==tr?null:(Xn(`Loading the audio`,.97),fetch(lr+`/library/`+e.sha+`/audio`,{headers:{"X-Pitchscape-Key":pr()}}).then(function(e){if(!e.ok)throw Error(`The server didn't send the song's audio (`+e.status+`). Open it again.`);return e.blob()},function(){throw Error(`Couldn't reach the server. Check the connection and open the song again.`)}).then(function(t){r===tr&&(Rn(URL.createObjectURL(t)),rr(Mr(e.pack),xr(e.pack,n),`sha:`+e.sha,null,0),Nr(e.pack))}))}).catch(function(e){r===tr&&(or(e&&e.message||`Couldn't open that link.`),e&&e.needsKey&&(D.retry=function(){cr(t,n)},$.askKey++))})}}var lr=null,ur=``,dr=!1,fr=Promise.resolve(null);function pr(){return O.get(`pitchscape:key`)||(dr?`local`:null)}try{fr=fetch(`config.json`,{cache:`no-store`}).then(function(e){return e.ok?e.json():null}).then(function(e){return lr=e&&e.api?String(e.api).replace(/\/$/,``):null,ur=e&&e.pipeline?String(e.pipeline):``,dr=!!(e&&e.local),lr},function(){return null})}catch{}function mr(e){return`pack:`+ur+`:`+e}function hr(e){return!!(e&&e.version>=12&&e.segStride===17&&e.bytes)}var gr=(function(){var e=null;function t(){return e||=new Promise(function(e,t){try{var n=indexedDB.open(`pitchscape`,1);n.onupgradeneeded=function(){n.result.createObjectStore(`packs`)},n.onsuccess=function(){e(n.result)},n.onerror=function(){t(n.error)}}catch(e){t(e)}}),e}function n(e,n){return t().then(function(t){return new Promise(function(r,i){var a=t.transaction(`packs`,e),o=n(a.objectStore(`packs`));a.oncomplete=function(){r(o&&o.result)},a.onerror=function(){i(a.error)}})})}return{get:function(e){return n(`readonly`,function(t){return t.get(e)}).catch(function(){return null})},put:function(e,t){return n(`readwrite`,function(n){return n.put(t,e)}).catch(function(){})}}})(),_r=[[`stems`,`Splitting the song into stems`,.2],[`drums`,`Reading the drums`,.45],[`notes`,`Reading the notes`,.55],[`tone`,`Listening for harsh sounds`,.8],[`width`,`Measuring how wide each sound is`,.82],[`bass`,`Following the bass`,.65],[`voice`,`Following the voice`,.75],[`words`,`Finding the lyrics`,.85],[`done`,`Finishing`,.95]];function K(e){for(var t=0;e&&t<_r.length;t++)if(e.indexOf(_r[t][0])===0)return _r[t];return[``,`Starting the server`,.12]}function vr(e){return window.crypto&&crypto.subtle?crypto.subtle.digest(`SHA-256`,e).then(function(e){return Array.prototype.map.call(new Uint8Array(e),function(e){return(e<16?`0`:``)+e.toString(16)}).join(``)},function(){return null}):Promise.resolve(null)}function yr(e){return e?fr.then(function(){return gr.get(mr(e)).then(function(t){if(t&&hr(t))return t;var n=pr();if(!lr||!n)return null;var r=window.AbortController?new AbortController:null,i=r&&setTimeout(function(){r.abort()},4e3);return fetch(lr+`/packs/`+e,{headers:{"X-Pitchscape-Key":n},signal:r?r.signal:void 0}).then(function(e){return clearTimeout(i),e.ok?e.json():null}).then(function(t){return t&&t.pack&&hr(t.pack)?(gr.put(mr(e),t.pack),t.pack):null},function(){return null})})}):Promise.resolve(null)}function br(e,t,n,r,i,a){var o=null;Xn(`Looking for this song`,.03),e.arrayBuffer().then(vr).then(function(e){return o=e,r===tr?yr(o):null}).then(function(n){if(n||r!==tr)return n;if(Dr()===`here`)return jr(e,t,o,r).then(function(e){return e&&e.pack});var i=new FormData;return i.append(`file`,e,t),Cr(i,o,r,`Uploading`).then(function(e){return e&&e.pack})}).then(function(i){i&&r===tr&&(Rn(URL.createObjectURL(e)),a?rr(Mr(i),n,`demo`,DSP.DEMO_LYRICS,16.9):(rr(Mr(i),xr(i,n),o?`sha:`+o:`file:`+t,null,0),Nr(i)),oe(``))}).catch(function(e){r===tr&&(or(e&&e.message||`Couldn't open that file.`),e&&e.needsKey&&(D.retry=i,$.askKey++))})}function xr(e,t){var n=e.song||{};return n.title?n.title+(n.artist?` · `+n.artist:``):t}function Sr(e){var t=Error(e);return t.needsKey=!0,t}function Cr(e,t,n,r){return fr.then(function(){var i=pr();if(!lr)throw Error(`This page has no analysis server set up.`);if(!i)throw Sr(`Add the server key below and this song will be analysed.`);return Xn(r,.05,`first time only, a few minutes`),fetch(lr+`/analyze`,{method:`POST`,headers:{"X-Pitchscape-Key":i},body:e}).then(function(e){if(e.status===401)throw Sr(`The server key is wrong. Fix it below and this song will be analysed.`);if(e.status===400||e.status===413||e.status===502)return e.json().catch(function(){return{}}).then(function(t){throw Error(t.detail||(e.status===413?`That file is over 80 MB.`:`The server said `+e.status+`.`))});if(!e.ok)throw Error(`The server said `+e.status+`. Try again in a minute.`);return e.json()},function(){throw Error(`Couldn't reach the server. Check the connection and try again.`)}).then(function(e){return t=e.sha256||t,e.status===`done`?e.pack:new Promise(function(t,r){var a=Date.now(),o=``;function s(){n===tr?!o&&Date.now()-a>48e4?r(Error(`The server never started on this song. Load it again in a minute.`)):fetch(lr+`/jobs/`+encodeURIComponent(e.job)+`?key=`+encodeURIComponent(e.key),{headers:{"X-Pitchscape-Key":i}}).then(function(e){return e.json()}).then(function(e){if(n!==tr)t(null);else if(e.status===`done`&&e.pack)t(e.pack);else if(e.status===`failed`)r(Error(`The analysis failed: `+String(e.error||`no reason given`).replace(/\.?\s*$/,`.`)));else{e.stage&&(o=e.stage);var i=K(e.stage);Xn(i[1],i[2]),$n(i[0]),setTimeout(s,3e3)}},function(){setTimeout(s,6e3)}):t(null)}Xn(`Starting the server`,.1),setTimeout(s,2500)})})}).then(function(e){if(e&&!hr(e))throw Error(`The server is being updated. Load the song again in a few minutes.`);return e&&t&&gr.put(mr(t),e),e?{pack:e,sha:t}:null})}var wr=`https://huggingface.co/stopamertime/pitchscape-models/resolve/main/`,q={done:!1,ok:!1,gpu:``,why:``,phone:!1,tablet:!1,mem:0,cores:0,mb:0},Tr=(function(){var e=navigator.userAgent||``;q.phone=navigator.userAgentData?!!navigator.userAgentData.mobile:/Android|iPhone|iPod|Mobile/i.test(e),q.tablet=/iPad/.test(e)||/Macintosh/.test(e)&&navigator.maxTouchPoints>1,q.mem=navigator.deviceMemory||0,q.cores=navigator.hardwareConcurrency||0;var t=fetch(wr+`manifest.json`,{cache:`no-cache`}).then(function(e){return e.ok?e.json():null}).then(function(e){var t=0;[`htdemucs_6s`,`adtof_frame_rnn`,`basic_pitch`,`crepe_full`,`align_en`].forEach(function(n){t+=e&&e[n]&&e[n].bytes||0}),q.mb=Math.round(t/1e6)},function(){}),n=navigator.gpu?navigator.gpu.requestAdapter({powerPreference:`high-performance`}).then(function(e){if(!e)q.why=`No usable graphics card`;else{var t=e.info||{};t.isFallbackAdapter||e.isFallbackAdapter?q.why=`Software graphics only: too slow`:(q.gpu=Er(t.vendor,t.architecture),q.ok=!0)}},function(){q.why=`WebGPU would not start`}):Promise.resolve(q.why=`No WebGPU: use Chrome or Edge`);return Promise.all([n,t]).then(function(){q.done=!0})})();function Er(e,t){var n={nvidia:`NVIDIA`,amd:`AMD`,intel:`Intel`,apple:`Apple`,qualcomm:`Qualcomm`,arm:`Arm`,microsoft:`Microsoft`}[e]||(e?e.charAt(0).toUpperCase()+e.slice(1):``),r=(t||``).replace(/^(rdna|gcn|cdna|xe|gen)-?(.*)$/i,function(e,t,n){return t.toUpperCase()+(n?` `+n:``)});return r&&r===(t||``)&&(r=r.charAt(0).toUpperCase()+r.slice(1)),(n+(r?` `+r:``)).trim()||`a graphics card`}function Dr(){var e=O.get(`pitchscape:where`);return e===`here`||e===`server`?e:q.ok&&!q.phone&&!q.tablet?`here`:`server`}function Or(){var e=O.get(`pitchscape:hereRate`);return e&&e>0?e:0}function kr(e){return e<90?Math.max(5,Math.round(e/5)*5)+` s`:Math.round(e/60)+` min`}function Ar(){$.where=Dr(),$.local=dr,$.hasKey=!!O.get(`pitchscape:key`),$.here={done:q.done,ok:q.ok,gpu:q.gpu,why:q.why,small:q.phone||q.tablet,mem:q.mem,cores:q.cores,mb:q.mb}}fs.setWhere=function(e){O.set(`pitchscape:where`,e),Ar()},Ar(),Tr.then(Ar);function jr(e,t,n,r){return Tr.then(function(){if(!q.ok)throw Error(`This computer can’t analyse songs (`+q.why.toLowerCase()+`). Choose the server instead.`);return Xn(`Reading the audio`,.02,``),$n(``,!0),e.arrayBuffer()}).then(function(e){return new OfflineAudioContext(2,1,44100).decodeAudioData(e.slice(0)).then(function(t){return{buf:e,mix:[t.getChannelData(0).slice(),t.getChannelData(Math.min(1,t.numberOfChannels-1)).slice()],dur:t.duration}},function(){throw Error(`This browser couldn’t read that file as audio.`)})}).then(function(e){return new Promise(function(n,i){var a=new Worker(new URL(`pipeline/analyse.worker.mjs`,location.href),{type:`module`}),o=performance.now(),s=0,c=0,l={},u=!1,d=!1,f=``,p=0,m=0,h=function(){return(performance.now()-o)/1e3};function g(e,t,n){f=e,p=Math.max(p,t),Xn(f,p,n)}function _(){var t=Or()*e.dur;if(t&&!u){var n=t-h();g(f,.55+.4*Math.min(.98,(h()-c)/Math.max(1,t-c)),n>5?`about `+kr(n)+` left`:`nearly done`)}}function v(e,t){clearInterval(m),a.terminate(),t?i(t):n(e)}a.onerror=function(e){v(null,Error(`The analysis here stopped: `+(e.message||`its worker would not start`)+`. Choose the server instead.`))},a.onmessage=function(t){var n=t.data;if(r!==tr)v(null);else if(n.download){u=!0,l[n.download.name]=n.download;var i=0,a=0;for(var o in l)i+=l[o].got,a+=l[o].total;var y=`fetching models: `+Math.round(i/1e6)+` / `+Math.round(a/1e6)+` MB · once`;d?Xn(f,p,y):(g(`Fetching the models`,.02+.08*i/Math.max(1,a),y.replace(`fetching models: `,``)),$n(`models`,!0))}else if(n.progress){d=!0;var b=K(n.progress),x=/^stems: (\d+)\/(\d+)/.exec(n.progress),S=``;if(x){var C=+x[1],w=+x[2];if(s||=performance.now(),C>=2){var T=(performance.now()-s)/1e3/(C-1)*(w-C),E=Or()*e.dur;S=(E>h()&&!u?`about `+kr(Math.max(T,E-h())):`about `+kr(T)+` for this step`)+` left`,T>180&&(S+=` · the server may be quicker`)}g(b[1],.1+.45*C/w,S)}else!c&&b[0]&&b[0]!==`stems`&&(c=h(),m=setInterval(_,1e3)),g(b[1],Math.min(b[2],.6)),_();$n(b[0],!0)}else n.pack?(u||O.set(`pitchscape:hereRate`,h()/Math.max(1,e.dur)),v(n.pack)):n.error&&v(null,Error(`The analysis here failed: `+n.error+` Choose the server to analyse it there.`))},a.postMessage({bytes:e.buf,name:t,mix:e.mix,models:wr},[e.buf,e.mix[0].buffer,e.mix[1].buffer])})}).then(function(e){return e&&n&&gr.put(mr(n),e),e?{pack:e,sha:n}:null})}function Mr(e){var t={dur:e.dur,dt:e.dt,frames:e.frames,stereo:e.stereo,noiseRef:e.noiseRef};for(var n in e.arrays)t[n]=Pr(e.arrays[n]);for(n in e.bytes)t[n]=J(e.bytes[n]);return t.segW=e.segStride,t.evW=e.eventStride,t.earDb=e.earDb,t}function Nr(e){var t=e.stats&&e.stats.lyrics||{};e.lyrics&&e.lyrics.lines&&e.lyrics.lines.length?yn(e.lyrics.lines.map(function(e){return{text:e.text,words:e.words.map(function(e){return{text:e[0],syl:Math.max(1,DSP.syllableCount(e[0]))}})}}),e.lyrics.lines.map(function(e){return e.words.map(function(e){return e[1]})})):(vn(),oe(t.why===`instrumental`?``:t.why===`LRCLIB could not be reached`?`No words: the lyrics site was down when this song was analysed.`:t.artist&&t.title?`No words: no published lyrics were found for `+t.title+` by `+t.artist+` at this length.`:`No words: this file doesn't name its artist and title, so its lyrics couldn't be looked up.`))}function J(e){for(var t=atob(e.data),n=new Float32Array(t.length),r=(e.hi-e.lo)/255,i=0;i<t.length;i++)n[i]=e.lo+t.charCodeAt(i)*r;return n}function Pr(e){for(var t=atob(e),n=new Uint8Array(t.length),r=0;r<t.length;r++)n[r]=t.charCodeAt(r);return new Float32Array(n.buffer)}function Fr(){h.pause(),Br(),$.hasSong=!!D.ana,$.splash=!0}function Ir(){$.splash=!1,oe(``),Fn()}e(`changeSong`).addEventListener(`click`,Fr),fs.back=function(){Ir(),g.focus({preventScroll:!0})},fs.demo=function(){Ir(),ir()},fs.link=function(e,t){Ir(),cr(e,t)},fs.file=function(e){Ir(),ar(e)},fs.say=oe,document.querySelectorAll(`.ink`).forEach(function(e){e.addEventListener(`click`,function(){var t=e.dataset.layer;D.vis[t]=!D.vis[t],e.setAttribute(`aria-pressed`,String(D.vis[t])),D.dirty=!0})});function Lr(e,t){return e===`secs`?t.toFixed(1)+` s`:e===`ink`||e===`weight`||e===`drumK`?`×`+t.toFixed(2):e===`vRun`||e===`noteMin`?Math.round(t)+` ms`:e===`rough0`?t.toFixed(2)+` asper`:e===`sharp0`?t.toFixed(2)+` acum`:e===`leap`?t+` st`:Math.round(t*100)+`%`}var Y={vConf:1,vFloor:1,vRun:1,bFloor:1,hold:1,noteMin:1,drumK:1,rough0:1,sharp0:1};function Rr(){U.querySelectorAll(`.seg[data-key]`).forEach(function(e){var t=e.dataset.key;e.querySelectorAll(`button`).forEach(function(e){e.setAttribute(`aria-pressed`,String(String(k[t])===e.dataset.v))})}),U.querySelectorAll(`input[type="range"][data-key]`).forEach(function(t){var n=t.dataset.key,r=n===`secs`?k.secs>0?k.secs:P:k[n];t.value=String(r),e(`lab-`+n+`-v`).textContent=Lr(n,r)});var t=document.documentElement.style;t.setProperty(`--drum`,Me.drum),t.setProperty(`--c-synth`,Me.pluck),[`bass`,`voice`,`guitar`,`piano`,`words`].forEach(function(e){t.setProperty(`--c-`+e,Me[e])})}function X(e){ie(),(Y[e]||e===`all`)&&(Se(),vn()),(e===`secs`||e===`all`)&&_e(),(e===`font`||e===`wordSize`||e===`weight`||e===`all`)&&gn(k.font).then(function(){vn(),D.dirty=!0}),Rr(),D.dirty=!0}U.querySelectorAll(`.seg[data-key] button`).forEach(function(e){e.addEventListener(`click`,function(){var t=e.parentNode.dataset.key;k[t]=e.dataset.v,X(t)})}),U.querySelectorAll(`input[type="range"][data-key]`).forEach(function(e){e.addEventListener(`input`,function(){var t=e.dataset.key;k[t]=parseFloat(e.value),X(t)})}),e(`labReset`).addEventListener(`click`,function(){k=Object.assign({},te),X(`all`)}),e(`labAll`).addEventListener(`click`,function(){[`vConf`,`vFloor`,`vRun`,`bFloor`,`hold`,`noteMin`,`drumK`].forEach(function(t){k[t]=parseFloat(e(`lab-`+t).min)}),X(`all`)});function zr(){U.hidden=!1,D.dirty=!0,jn.setAttribute(`aria-expanded`,`true`),Hr(),Fn()}function Br(){var e=!U.hidden&&U.contains(document.activeElement);U.hidden=!0,jn.setAttribute(`aria-expanded`,`false`),D.dirty=!0,Hr(),Fn(),e&&jn.focus({preventScroll:!0})}jn.addEventListener(`click`,function(){U.hidden?zr():Br()}),document.querySelectorAll(`[data-close]`).forEach(function(e){e.addEventListener(`click`,Br)}),e(`labPlay`).addEventListener(`click`,kn),document.addEventListener(`keydown`,function(e){e.key===`Escape`&&(W()||!Z.hidden)&&(Z.hidden?Br():Hr())});var Z=e(`bubble`),Vr=null;function Hr(){Vr&&Vr.setAttribute(`aria-expanded`,`false`),Z.hidden=!0,Vr=null}U.querySelectorAll(`.k[data-tip]`).forEach(function(e){e.addEventListener(`click`,function(){if(Vr===e)Hr();else{Hr(),Vr=e,e.setAttribute(`aria-expanded`,`true`),Z.textContent=e.dataset.tip,Z.hidden=!1;var t=U.getBoundingClientRect(),n=e.getBoundingClientRect(),r=U.querySelector(`.panel-head`).getBoundingClientRect(),i=Z.offsetHeight,a=n.top-i-12>r.bottom,o=Math.max(12,n.left-t.left-6);Z.classList.toggle(`above`,a),Z.classList.toggle(`below`,!a),Z.style.left=o+`px`,Z.style.top=n.top-t.top+U.scrollTop+(a?-i-10:n.height+10)+`px`,Z.style.setProperty(`--tail`,Math.max(12,Math.min(n.width-10,24)+n.left-t.left-o-6)+`px`)}})}),document.addEventListener(`pointerdown`,function(e){Vr&&!Z.contains(e.target)&&!Vr.contains(e.target)&&Hr()});var Ur=U.querySelectorAll(`[role="tab"]`);function Wr(e){Ur.forEach(function(t){t.setAttribute(`aria-selected`,String(t.dataset.tab===e)),t.tabIndex=t.dataset.tab===e?0:-1}),U.querySelectorAll(`.pane`).forEach(function(t){t.hidden=t.dataset.pane!==e}),Hr(),O.set(`pitchscape:tab`,e)}Ur.forEach(function(e){e.addEventListener(`click`,function(){Wr(e.dataset.tab)})}),Wr(U.querySelector(`[data-tab="`+O.get(`pitchscape:tab`)+`"]`)?O.get(`pitchscape:tab`):`colour`),Rr(),fs.setKey=function(e){if(e?O.set(`pitchscape:key`,e):O.del(`pitchscape:key`),Ar(),e&&D.retry){var t=D.retry;D.retry=null,Ir(),t()}else oe(e?`Server key saved.`:`Server key removed.`)},k.font!==`grotesque`&&gn(k.font).then(function(){vn(),D.dirty=!0}),window.ResizeObserver?new ResizeObserver(_e).observe(t):window.addEventListener(`resize`,_e),_e(),document.fonts&&document.fonts.ready&&document.fonts.ready.then(function(){vn(),D.dirty=!0}),requestAnimationFrame(Un),fr.then(Ar)}var _c=e((()=>{ps()}));t((()=>{n(),i(),ts(),Ys(),hc(),Fs(),_c();var e=document.createElement(`script`);e.id=`dsp`,e.textContent=r,document.body.append(e),Ni(Gs,{target:document.querySelector(`main.app`)}),Ni(lc,{target:document.getElementById(`plate`)}),Ni(As,{target:document.getElementById(`where-lab`),props:{id:`where-lab`}}),gc()}))();