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
`})),a=e((()=>{})),o=e((()=>{})),s=e((()=>{a(),o()}));function c(e){return typeof e==`function`}function l(e){for(var t=0;t<e.length;t++)e[t]()}function u(){var e,t;return{promise:new Promise((n,r)=>{e=n,t=r}),resolve:e,reject:t}}var d,f,p,m,h,g,_,v,y,b,x,S,C=e((()=>{d=Array.isArray,f=Array.prototype.indexOf,p=Array.prototype.includes,m=Array.from,h=Object.defineProperty,g=Object.getOwnPropertyDescriptor,_=Object.getOwnPropertyDescriptors,v=Object.prototype,y=Array.prototype,b=Object.getPrototypeOf,x=Object.isExtensible,S=()=>{}})),ee,w,T,E,te,D,O,ne,re,ie,k,ae,oe,A,se,j,M,ce,le,N,P,ue,F,I,de,fe,L=e((()=>{ee=1<<24,w=1024,T=2048,E=4096,te=8192,D=16384,O=32768,ne=1<<25,re=65536,ie=1<<19,k=1<<20,ae=1<<25,oe=1<<21,A=1<<22,se=1<<23,j=Symbol(`$state`),M=Symbol(`component`),ce=Symbol(`legacy props`),le=Symbol(``),N=Symbol(`attributes`),P=Symbol(`class`),ue=Symbol(`style`),F=Symbol(`text`),I=Symbol(`form reset`),de=new class extends Error{name=`StaleReactionError`;message="The reaction that called `getAbortSignal()` was re-run or destroyed"},fe=!!globalThis.document?.contentType&&globalThis.document.contentType.includes(`xml`)})),pe,me,he,ge=e((()=>{pe={},me=Symbol(`uninitialized`),he=`http://www.w3.org/1999/xhtml`}));function _e(){console.warn(`https://svelte.dev/e/derived_inert`)}function ve(e){console.warn(`https://svelte.dev/e/hydration_mismatch`)}function ye(){console.warn(`https://svelte.dev/e/select_multiple_invalid_value`)}function be(){console.warn(`https://svelte.dev/e/svelte_boundary_reset_noop`)}var xe=e((()=>{s()}));function Se(e){z=e}function Ce(e){if(e===null)throw ve(),pe;return B=e}function we(){return Ce(kn(B))}function R(e){if(z){if(kn(B)!==null)throw ve(),pe;B=e}}function Te(e=1){if(z){for(var t=e,n=B;t--;)n=kn(n);B=n}}function Ee(e=!0){for(var t=0,n=B;;){if(n.nodeType===8){var r=n.data;if(r===`]`){if(t===0)return n;--t}else(r===`[`||r===`[!`||r[0]===`[`&&!isNaN(Number(r.slice(1))))&&(t+=1)}var i=kn(n);e&&n.remove(),n=i}}function De(e){if(!e||e.nodeType!==8)throw ve(),pe;return e.data}var z,B,V=e((()=>{L(),ge(),xe(),Vn(),z=!1}));function Oe(e){return e===this.v}function ke(e,t){return e==e?e!==t||typeof e==`object`&&!!e||typeof e==`function`:t==t}function Ae(e){return!ke(e,this.v)}var je=e((()=>{})),Me=e((()=>{s()}));function Ne(){throw Error(`https://svelte.dev/e/async_derived_orphan`)}function Pe(e,t,n){throw Error(`https://svelte.dev/e/each_key_duplicate`)}function Fe(e){throw Error(`https://svelte.dev/e/effect_in_teardown`)}function Ie(){throw Error(`https://svelte.dev/e/effect_in_unowned_derived`)}function Le(e){throw Error(`https://svelte.dev/e/effect_orphan`)}function Re(){throw Error(`https://svelte.dev/e/effect_update_depth_exceeded`)}function ze(e){throw Error(`https://svelte.dev/e/props_invalid_value`)}function Be(){throw Error(`https://svelte.dev/e/state_descriptors_fixed`)}function Ve(){throw Error(`https://svelte.dev/e/state_prototype_fixed`)}function He(){throw Error(`https://svelte.dev/e/state_unsafe_mutation`)}function Ue(){throw Error(`https://svelte.dev/e/svelte_boundary_reset_onerror`)}var We=e((()=>{s(),Me()})),Ge,Ke,qe=e((()=>{Ge=!1,Ke=!1})),Je=e((()=>{C()})),Ye=e((()=>{Je(),L(),q(),Q()})),Xe=e((()=>{s(),C(),Me()}));function Ze(e){H=e}function Qe(e,t=!1,n){H={p:H,i:!1,c:null,e:null,s:e,x:null,r:X,l:Ke&&!t?{s:null,u:null,$:[]}:null}}function $e(e){var t=H,n=t.e;if(n!==null){t.e=null;for(var r of n)Zn(r)}return e!==void 0&&(t.x=e),t.i=!0,H=t.p,et(e)}function et(e={}){return h(e,M,{value:!0}),e}function tt(){return!Ke||H!==null&&H.l===null}var H,nt=e((()=>{s(),We(),Q(),q(),qe(),L(),C(),H=null}));function rt(){var e=ot;ot=[],l(e)}function it(e){if(ot.length===0&&!Zt){var t=ot;queueMicrotask(()=>{t===ot&&rt()})}ot.push(e)}function at(){for(;ot.length>0;)rt()}var ot,st=e((()=>{C(),on(),ot=[]}));function U(e,t){e.f=e.f&lt|t}function ct(e){e.f&512||e.deps===null?U(e,w):U(e,E)}var lt,ut=e((()=>{L(),lt=~(T|E|w)}));function dt(e,t,n){e.f&2048?t.add(e):e.f&4096&&n.add(e),U(e,w)}var ft=e((()=>{L(),ut()})),pt=e((()=>{L(),Je(),Q()}));function mt(e,t){if(t){let t=document.body;e.autofocus=!0,it(()=>{document.activeElement===t&&e.focus()})}}function ht(){gt||(gt=!0,document.addEventListener(`reset`,e=>{Promise.resolve().then(()=>{if(!e.defaultPrevented)for(let t of e.target.elements)t[I]?.()})},{capture:!0}))}var gt,_t=e((()=>{V(),Vn(),st(),L(),gt=!1}));function vt(e){var t=Y,n=X;br(null),xr(null);try{return e()}finally{br(t),xr(n)}}function yt(e,t,n,r=n){e.addEventListener(t,()=>vt(n));let i=e[I];i?e[I]=()=>{i(),r(!0)}:e[I]=()=>r(!0),ht()}var bt=e((()=>{q(),Q(),L(),_t()}));function xt(e,t,n,r){let i=tt()?Dt:At;var a=e.filter(e=>!e.settled),o=t.map(i);if(n.length===0&&a.length===0){r(o);return}var s=X,c=St(),l=a.length===1?a[0].promise:a.length>1?Promise.all(a.map(e=>e.promise)):null;function u(e){if(!(s.f&16384)){c();try{r([...o,...e])}catch(e){Un(e,s)}Ct()}}var d=wt();if(n.length===0){l.then(()=>u([])).finally(d);return}function f(){Promise.all(n.map(e=>Ot(e))).then(u).catch(e=>Un(e,s)).finally(d)}l?l.then(()=>{s.f&16384?d():(c(),f(),Ct())}):f()}function St(){var e=X,t=Y,n=H,r=W;return function(i=!0){xr(e),br(t),Ze(n),i&&!(e.f&16384)&&(r?.activate(),r?.apply())}}function Ct(e=!0){Tt=!1,xr(null),br(null),Ze(null),e&&W?.deactivate()}function wt(){var e=X,t=e.b,n=W,r=!!t?.is_rendered();return t?.update_pending_count(1,n),n.increment(r,e),()=>{t?.update_pending_count(-1,n),n.decrement(r,e)}}var Tt,Et=e((()=>{L(),s(),nt(),Wn(),Q(),on(),Lt(),q()}));function Dt(e){var t=2|T;return X!==null&&(X.f|=ie),{ctx:H,deps:null,effects:null,equals:Oe,f:t,fn:e,reactions:null,rv:0,v:me,wv:0,parent:X,ac:null}}function Ot(e,t,n){let r=X;r===null&&Ne();var i=void 0,a=sn(me),o=!Y,s=new Set;return er(()=>{var t=X,n=u();i=n.promise;try{Promise.resolve(e()).then(n.resolve,e=>{e!==de&&n.reject(e)}).finally(Ct)}catch(e){n.reject(e),Ct()}var c=W;if(o){if(t.f&32768)var l=wt();if(r.b?.is_rendered())c.async_deriveds.get(t)?.reject(It);else for(let e of s.values())e.reject(It);s.add(n),c.async_deriveds.set(t,n)}let d=(e,t=void 0)=>{l?.(),s.delete(n),t!==It&&(c.activate(),t?(a.f|=se,dn(a,t)):(a.f&8388608&&(a.f^=se),dn(a,e)),c.deactivate())};n.promise.then(d,e=>d(null,e||`unknown`))}),Yn(()=>{for(let e of s)e.reject(It)}),new Promise(e=>{function t(n){function r(){n===i?e(a):t(i)}n.then(r,r)}t(i)})}function kt(e){let t=Dt(e);return Ge||Sr(t),t}function At(e){let t=Dt(e);return t.equals=Ae,t}function jt(e){var t=e.effects;if(t!==null){e.effects=null;for(var n=0;n<t.length;n+=1)lr(t[n])}}function Mt(e){var t,n=X,r=e.parent;if(!Lr&&r!==null&&e.v!==me&&r.f&24576)return _e(),e.v;xr(r);try{jt(e),t=Or(e)}finally{xr(n)}return t}function Nt(e){var t=Mt(e);!e.equals(t)&&(e.wv=Tr(),(!W?.is_fork||e.deps===null)&&(W===null?e.v=t:(W.capture(e,t,!0),Jt?.capture(e,t,!0)),e.deps===null))?U(e,w):Lr||(Yt===null?ct(e):(Jn()||W?.is_fork)&&Yt.set(e,t))}function Pt(e){if(e.effects!==null)for(let t of e.effects)(t.teardown||t.ac)&&(t.teardown?.(),t.ac!==null&&vt(()=>{t.ac.abort(de),t.ac=null}),t.fn!==null&&(t.teardown=S),jr(t,0),sr(t))}function Ft(e){if(e.effects!==null)for(let t of e.effects)t.teardown&&t.fn!==null&&Mr(t)}var It,Lt=e((()=>{s(),L(),Q(),bt(),je(),We(),xe(),q(),bn(),Xe(),qe(),nt(),ge(),on(),Et(),C(),ut(),It=Symbol(`obsolete`)}));function Rt(e){var t=Zt,n=Jt;Jt=null,Zt=!0;try{var r;for(e&&(Rt(),r=e());;){if(at(),W===null)return r;W.flush()}}finally{Zt=t,Jt=n}}function zt(){try{Re()}catch(e){Un(e,Xt)}}function Bt(e){var t=e.length;if(t!==0){for(var n=0;n<t;){var r=e[n++];if(!(r.f&24576)&&Er(r)&&(an=new Set,Mr(r),r.deps===null&&r.first===null&&r.nodes===null&&r.teardown===null&&r.ac===null&&dr(r),an?.size>0)){gn.clear();for(let e of an){if(e.f&24576)continue;let t=[e],n=e.parent;for(;n!==null;)an.has(n)&&(an.delete(n),t.push(n)),n=n.parent;for(let e=t.length-1;e>=0;e--){let n=t[e];n.f&24576||Mr(n)}}an.clear()}}an=null}}function Vt(e,t,n,r){if(!n.has(e)&&(n.add(e),e.reactions!==null))for(let i of e.reactions){let e=i.f;e&2?Vt(i,t,n,r):e&4194320&&!(e&2048)&&Ht(i,t,r)&&(U(i,T),Ut(i))}}function Ht(e,t,n){let r=n.get(e);if(r!==void 0)return r;if(e.deps!==null)for(let r of e.deps){if(p.call(t,r))return!0;if(r.f&2&&Ht(r,t,n))return n.set(r,!0),!0}return n.set(e,!1),!1}function Ut(e){W.schedule(e)}function Wt(e,t){if(!(e.f&32&&e.f&1024)){e.f&2048?t.d.push(e):e.f&4096&&t.m.push(e),U(e,w);for(var n=e.first;n!==null;)Wt(n,t),n=n.next}}function Gt(e){U(e,w);for(var t=e.first;t!==null;)Gt(t),t=t.next}var Kt,qt,W,Jt,Yt,Xt,Zt,Qt,$t,en,tn,nn,rn,an,on=e((()=>{L(),qe(),C(),Q(),We(),st(),s(),Wn(),bn(),q(),ft(),ge(),ut(),Xe(),pt(),Lt(),Kt=null,qt=null,W=null,Jt=null,Yt=null,Xt=null,Zt=!1,Qt=!1,$t=null,en=null,tn=0,nn=1,rn=class e{id=nn++;#e=!1;linked=!0;#t=null;#n=null;async_deriveds=new Map;current=new Map;previous=new Map;#r=new Set;#i=new Set;#a=0;#o=new Map;#s=null;#c=[];#l=[];#u=new Set;#d=new Set;#f=new Map;#p=new Set;is_fork=!1;#m=!1;constructor(){qt===null?Kt=qt=this:(qt.#n=this,this.#t=qt),qt=this}#h(){if(this.is_fork)return!0;for(let n of this.#o.keys()){for(var e=n,t=!1;e.parent!==null;){if(this.#f.has(e)){t=!0;break}e=e.parent}if(!t)return!0}return!1}skip_effect(e){this.#f.has(e)||this.#f.set(e,{d:[],m:[]}),this.#p.delete(e)}unskip_effect(e,t=e=>this.schedule(e)){var n=this.#f.get(e);if(n){this.#f.delete(e);for(var r of n.d)U(r,T),t(r);for(r of n.m)U(r,E),t(r)}this.#p.add(e)}#g(){var e=[];for(let i of this.#c)if(!(i.f&16384||!(i.f&6144))){for(var t=i,n=!1;t.parent!==null;){t=t.parent;var r=t.f;if(r&96){if(!(r&1024)){n=!0;break}t.f^=w}}n||e.push(t)}return this.#c=[],e}#_(){this.#e=!0;for(let e of this.#u)this.#d.delete(e),U(e,T),this.schedule(e);for(let e of this.#d)U(e,E),this.schedule(e);this.apply();for(var t=$t=[],n=[],r=en=[];this.#c.length>0;){tn++>1e3&&(this.#C(),zt());for(let e of this.#g())try{this.#v(e,t,n)}catch(t){throw Gt(e),this.#h()||this.discard(),t}}if(W=null,r.length>0){var i=e.ensure();for(let e of r)i.schedule(e)}if($t=null,en=null,this.#h()){this.#x(n),this.#x(t);for(let[e,t]of this.#f)Wt(e,t);r.length>0&&W.#_();return}let a=this.#y();if(a)this.#x(n),this.#x(t),a.#b(this);else{this.#u.clear(),this.#d.clear();for(let e of this.#r)e(this);this.#r.clear(),Jt=this,Bt(n),Bt(t),Jt=null,this.#s?.resolve();var o=W;if(this.#a===0&&(this.#c.length===0||o!==null)&&(this.#C(),Ge&&(this.#S(),W=o)),this.#c.length>0){if(o!==null){for(let e of this.#c)o.#c.push(e);this.#c=[]}else o=this}o!==null&&(gn.clear(),o.#_())}}#v(e,t,n){e.f^=w;for(var r=e.first;r!==null;){var i=r.f,a=!!(i&96);if(!(a&&i&1024||i&8192||this.#f.has(r))&&r.fn!==null){a?r.f^=w:i&4?t.push(r):Ge&&i&16777224?n.push(r):Er(r)&&(i&16&&this.#d.add(r),Mr(r));var o=r.first;if(o!==null){r=o;continue}}for(;r!==null;){var s=r.next;if(s!==null){r=s;break}r=r.parent}}}#y(){for(var e=this.#t;e!==null;){if(!e.is_fork){for(let[t,[,n]]of this.current)if(e.current.has(t)&&!n)return e}e=e.#t}return null}#b(e){for(let[t,n]of e.current)!this.previous.has(t)&&e.previous.has(t)&&this.previous.set(t,e.previous.get(t)),this.current.set(t,n);for(let[t,n]of e.async_deriveds){let e=this.async_deriveds.get(t);e&&n.promise.then(e.resolve).catch(e.reject)}e.async_deriveds.clear(),this.transfer_effects(e.#u,e.#d);let t=e=>{var n=e.reactions;if(n!==null&&!(e.f&2&&!(e.f&6144)))for(let e of n){var r=e.f;if(r&2)t(e);else{var i=e;r&4194320&&!this.async_deriveds.has(i)&&(this.#d.delete(i),U(i,T),this.schedule(i))}}};for(let e of this.current.keys())t(e);this.oncommit(()=>e.discard()),e.#C(),W=this,this.#_()}#x(e){for(var t=0;t<e.length;t+=1)dt(e[t],this.#u,this.#d)}capture(e,t,n=!1){e.v!==me&&!this.previous.has(e)&&this.previous.set(e,e.v),e.f&8388608||(this.current.set(e,[t,n]),Yt?.set(e,t)),this.is_fork||(e.v=t)}activate(){W=this}deactivate(){W=null,Yt=null}flush(){try{Qt=!0,W=this,this.#_()}finally{tn=0,Xt=null,$t=null,en=null,Qt=!1,W=null,Yt=null,gn.clear()}}discard(){for(let e of this.#i)e(this);this.#i.clear();for(let e of this.async_deriveds.values())e.reject(It);this.#C(),this.#s?.resolve()}register_created_effect(e){this.#l.push(e)}#S(){for(let u=Kt;u!==null;u=u.#n){var e=u.id<this.id,t=[];for(let[r,[i,a]]of this.current){if(u.current.has(r)){var n=u.current.get(r)[0];if(e&&i!==n)u.current.set(r,[i,a]);else continue}t.push(r)}if(e)for(let[e,t]of this.async_deriveds){let n=u.async_deriveds.get(e);n&&t.promise.then(n.resolve).catch(n.reject)}var r=[...u.current.keys()].filter(e=>!u.current.get(e)[1]);if(u.#e&&r.length!==0){var i=r.filter(e=>!this.current.has(e));if(i.length===0)e&&u.discard();else if(t.length>0){if(e)for(let e of this.#p)u.unskip_effect(e,e=>{e.f&4194320?u.schedule(e):u.#x([e])});u.activate();var a=new Set,o=new Map;for(var s of t)Vt(s,i,a,o);o=new Map;var c=[...u.current].filter(([e,t])=>{let n=this.current.get(e);return!n||n[0]!==t[0]||n[1]!==t[1]}).map(([e])=>e);if(c.length>0)for(let e of this.#l)!(e.f&155648)&&Ht(e,c,o)&&(e.f&4194320?(U(e,T),u.schedule(e)):u.#u.add(e));if(u.#c.length>0&&!u.#m){u.apply();for(var l of u.#g())u.#v(l,[],[])}u.deactivate()}}}}increment(e,t){if(this.#a+=1,e){let e=this.#o.get(t)??0;this.#o.set(t,e+1)}}decrement(e,t){if(--this.#a,e){let e=this.#o.get(t)??0;e===1?this.#o.delete(t):this.#o.set(t,e-1)}this.#m||(this.#m=!0,it(()=>{this.#m=!1,this.linked&&this.flush()}))}transfer_effects(e,t){for(let t of e)this.#u.add(t);for(let e of t)this.#d.add(e);e.clear(),t.clear()}oncommit(e){this.#r.add(e)}ondiscard(e){this.#i.add(e)}settled(){return(this.#s??=u()).promise}static ensure(){if(W===null){let t=W=new e;!Qt&&!Zt&&it(()=>{t.#e||t.flush()})}return W}apply(){if(!Ge||!this.is_fork&&this.#t===null&&this.#n===null)Yt=null;else{Yt=new Map;for(let[e,[t]]of this.current)Yt.set(e,t);for(let t=Kt;t!==null;t=t.#n)if(!(t===this||t.is_fork)){var e=!1;if(t.id<this.id){for(let[n,[,r]]of t.current)if(!r&&this.current.has(n)){e=!0;break}}if(!e)for(let[e,n]of t.previous)Yt.has(e)||Yt.set(e,n)}}}schedule(e){Xt=e,e.b?.is_pending&&e.f&16777228&&!(e.f&32768)?e.b.defer_effect(e):this.#c.push(e)}#C(){if(this.linked){var e=this.#t,t=this.#n;e===null?Kt=t:e.#n=t,t===null?qt=e:t.#t=e,this.linked=!1}}},an=null}));function sn(e,t){return{f:0,v:e,reactions:null,equals:Oe,rv:0,wv:0}}function cn(e,t){let n=sn(e,t);return Sr(n),n}function ln(e,t=!1,n=!0){let r=sn(e);return t||(r.equals=Ae),Ke&&n&&H!==null&&H.l!==null&&(H.l.s??=[]).push(r),r}function un(e,t,n=!1){return Y!==null&&(!Rr||Y.f&131072)&&tt()&&Y.f&4325394&&(zr===null||!zr.has(e))&&He(),dn(e,n?xn(t):t,en)}function dn(e,t,n=null){if(!e.equals(t)){Lr?gn.set(e,t):gn.has(e)||gn.set(e,e.v);var r=rn.ensure();if(r.capture(e,t),e.f&2){let t=e;e.f&2048&&Mt(t),Yt===null&&ct(t)}e.wv=Tr(),vn=null,yn=0,mn(e,T,n),vn=null,tt()&&X!==null&&X.f&1024&&!(X.f&96)&&(Vr===null?Cr([e]):Vr.push(e)),!r.is_fork&&hn.size>0&&!_n&&fn()}return t}function fn(){_n=!1;for(let e of hn){e.f&1024&&U(e,E);let t;try{t=Er(e)}catch{t=!0}t&&Mr(e)}hn.clear()}function pn(e){un(e,e.v+1)}function mn(e,t,n){var r=e.reactions;if(r!==null){var i=tt(),a=r.length;if(yn+=a,yn>1e5&&vn===null&&(vn=new Set),vn!==null){if(vn.has(e))return;vn.add(e)}for(var o=0;o<a;o++){var s=r[o],c=s.f;if(i||s!==X){var l=(c&T)===0;if(l&&U(s,t),c&131072)hn.add(s);else if(c&2){var u=s;Yt?.delete(u),mn(u,E,n)}else if(l){var d=s;c&16&&an!==null&&an.add(d),n===null?Ut(d):n.push(d)}}}}}var hn,gn,_n,vn,yn,bn=e((()=>{s(),Q(),je(),L(),We(),qe(),Ye(),Xe(),nt(),on(),wn(),Lt(),ut(),hn=new Set,gn=new Map,_n=!1,vn=null,yn=0}));function xn(e){if(typeof e!=`object`||!e||j in e||M in e)return e;let t=b(e);if(t!==v&&t!==y)return e;var n=new Map,r=d(e),i=cn(0),a=null,o=Wr,s=e=>{if(Wr===o)return e();var t=Y,n=Wr;br(null),wr(o);var r=e();return br(t),wr(n),r};return r&&n.set(`length`,cn(e.length,a)),new Proxy(e,{defineProperty(e,t,r){(!(`value`in r)||r.configurable===!1||r.enumerable===!1||r.writable===!1)&&Be();var i=n.get(t);return i===void 0?s(()=>{var e=cn(r.value,a);return n.set(t,e),e}):un(i,r.value,!0),!0},deleteProperty(e,t){var r=n.get(t);if(r===void 0){if(t in e){let e=s(()=>cn(me,a));n.set(t,e),pn(i)}}else un(r,me),pn(i);return!0},get(t,r,i){if(r===j)return e;var o=n.get(r),c=r in t;if(o===void 0&&(!c||g(t,r)?.writable)&&(o=s(()=>cn(xn(c?t[r]:me),a)),n.set(r,o)),o!==void 0){var l=J(o);return l===me?void 0:l}return Reflect.get(t,r,i)},getOwnPropertyDescriptor(e,t){this.has?.(e,t);var r=Reflect.getOwnPropertyDescriptor(e,t),i=n.get(t);if(i!==void 0){var a=J(i);if(a===me)return;if(r&&`value`in r)r.value=a;else return{enumerable:!0,configurable:!0,value:a,writable:!0}}return r},has(e,t){if(t===j)return!0;var r=n.get(t),i=r!==void 0&&r.v!==me||Reflect.has(e,t);return(r!==void 0||X!==null&&(!i||g(e,t)?.writable))&&(r===void 0&&(r=s(()=>cn(i?xn(e[t]):me,a)),n.set(t,r)),J(r)===me)?!1:i},set(e,t,o,c){var l=n.get(t),u=t in e;if(r&&t===`length`)for(var d=o;d<l.v;d+=1){var f=n.get(d+``);f===void 0?d in e&&(f=s(()=>cn(me,a)),n.set(d+``,f)):un(f,me)}if(l===void 0)(!u||g(e,t)?.writable)&&(l=s(()=>cn(void 0,a)),un(l,xn(o)),n.set(t,l));else{u=l.v!==me;var p=s(()=>xn(o));un(l,p)}var m=Reflect.getOwnPropertyDescriptor(e,t);if(m?.set&&m.set.call(c,o),!u){if(r&&typeof t==`string`){var h=n.get(`length`),_=Number(t);Number.isInteger(_)&&_>=h.v&&un(h,_+1)}pn(i)}return!0},ownKeys(e){J(i);var t=Reflect.ownKeys(e).filter(e=>{var t=n.get(e);return t===void 0||t.v!==me});for(var[r,a]of n)a.v!==me&&!(r in e)&&t.push(r);return t},setPrototypeOf(){Ve()}})}function Sn(e){try{if(typeof e==`object`&&e&&j in e)return e[j]}catch{}return e}function Cn(e,t){return Object.is(Sn(e),Sn(t))}var wn=e((()=>{s(),Q(),C(),bn(),L(),ge(),We(),Ye(),Xe(),qe()})),Tn=e((()=>{xe(),wn()}));function En(){if(In===void 0){In=window,Ln=document,Rn=/Firefox/.test(navigator.userAgent);var e=Element.prototype,t=Node.prototype,n=Text.prototype;zn=g(t,`firstChild`).get,Bn=g(t,`nextSibling`).get,x(e)&&(e[P]=void 0,e[N]=null,e[ue]=void 0,e.__e=void 0),x(n)&&(n[F]=void 0)}}function Dn(e=``){return document.createTextNode(e)}function On(e){return zn.call(e)}function kn(e){return Bn.call(e)}function G(e,t){if(!z)return On(e);var n=On(B);if(n===null)n=B.appendChild(Dn());else if(t&&n.nodeType!==3){var r=Dn();return n?.before(r),Ce(r),r}return t&&Fn(n),Ce(n),n}function An(e,t=!1){if(!z){var n=On(e);return n instanceof Comment&&n.data===``?kn(n):n}if(t){if(B?.nodeType!==3){var r=Dn();return B?.before(r),Ce(r),r}Fn(B)}return B}function jn(e,t=!1){if(!z)return On(e);var n=G(e,t);return R(e),n}function K(e,t=1,n=!1){let r=z?B:e;for(var i;t--;)i=r,r=kn(r);if(!z)return r;if(n){if(r?.nodeType!==3){var a=Dn();return r===null?i?.after(a):r.before(a),Ce(a),a}Fn(r)}return Ce(r),r}function Mn(e){e.textContent=``}function Nn(){return!Ge||an!==null?!1:(X.f&O)!==0}function Pn(e,t,n){return t==null||t===`http://www.w3.org/1999/xhtml`?n?document.createElement(e,{is:n}):document.createElement(e):n?document.createElementNS(t,e,{is:n}):document.createElementNS(t,e)}function Fn(e){if(e.nodeValue.length<65536)return;let t=e.nextSibling;for(;t!==null&&t.nodeType===3;)t.remove(),e.nodeValue+=t.nodeValue,t=e.nextSibling}var In,Ln,Rn,zn,Bn,Vn=e((()=>{V(),s(),Tn(),C(),Q(),qe(),L(),on(),ge()}));function Hn(e){var t=X;if(t===null)return Y.f|=se,e;if(!(t.f&32768)&&!(t.f&4))throw e;Un(e,t)}function Un(e,t){if(e===pe)throw e;if(!(t!==null&&t.f&16384)){for(;t!==null;){if(t.f&128&&!(t.f&33570816)){if(!(t.f&32768))throw e;try{t.b.error(e);return}catch(t){e=t}}t=t.parent}throw e}}var Wn=e((()=>{s(),ge(),Vn(),L(),C(),Q()}));function Gn(e){X===null&&(Y===null&&Le(e),Ie()),Lr&&Fe(e)}function Kn(e,t){var n=t.last;n===null?t.last=t.first=e:(n.next=e,e.prev=n,t.last=e)}function qn(e,t){var n=X;n!==null&&n.f&8192&&(e|=te);var r={ctx:H,deps:null,nodes:null,f:e|T|512,first:null,fn:t,last:null,next:null,parent:n,b:n&&n.b,prev:null,teardown:null,wv:0,ac:null};W?.register_created_effect(r);var i=r;if(e&4)$t===null?rn.ensure().schedule(r):$t.push(r);else if(t!==null){try{Mr(r)}catch(e){throw lr(r),e}i.deps===null&&i.teardown===null&&i.nodes===null&&i.first===i.last&&!(i.f&524288)&&(i=i.first,e&16&&e&65536&&i!==null&&(i.f|=re))}if(i!==null&&(i.parent=n,n!==null&&Kn(i,n),Y!==null&&Y.f&2&&!(e&64))){var a=Y;(a.effects??=[]).push(i)}return r}function Jn(){return Y!==null&&!Rr}function Yn(e){let t=qn(8,null);return U(t,w),t.teardown=e,t}function Xn(e){Gn(`$effect`);var t=X.f;if(!Y&&t&32&&H!==null&&!H.i){var n=H;(n.e??=[]).push(e)}else return Zn(e)}function Zn(e){return qn(4|k,e)}function Qn(e){rn.ensure();let t=qn(64|ie,e);return(e={})=>new Promise(n=>{e.outro?fr(t,()=>{lr(t),n(void 0)}):(lr(t),n(void 0))})}function $n(e){return qn(4,e)}function er(e){return qn(A|ie,e)}function tr(e,t=0){return qn(8|t,e)}function nr(e,t=[],n=[],r=[]){xt(r,t,n,t=>{qn(8,()=>{e(...t.map(J))})})}function rr(e,t=0){return qn(16|t,e)}function ir(e,t=0){return qn(ee|t,e)}function ar(e){return qn(32|ie,e)}function or(e){var t=e.teardown;if(t!==null){let n=Lr,r=Y;yr(!0),br(null);try{t.call(null)}catch(t){Un(t,e.parent)}finally{yr(n),br(r)}}}function sr(e,t=!1){var n=e.first;for(e.first=e.last=null;n!==null;){let e=n.ac;e!==null&&vt(()=>{e.abort(de)});var r=n.next;n.f&64?n.parent=null:lr(n,t),n=r}}function cr(e){for(var t=e.first;t!==null;){var n=t.next;t.f&32||lr(t),t=n}}function lr(e,t=!0){var n=!1;(t||e.f&262144)&&e.nodes!==null&&e.nodes.end!==null&&(ur(e.nodes.start,e.nodes.end),n=!0),e.f|=ne,sr(e,t&&!n),jr(e,0);var r=e.nodes&&e.nodes.t;if(r!==null)for(let e of r)e.stop();or(e),e.f^=ne,e.f|=D;var i=e.parent;i!==null&&i.first!==null&&dr(e),e.next=e.prev=e.teardown=e.ctx=e.deps=e.fn=e.nodes=e.ac=e.b=null}function ur(e,t){for(;e!==null;){var n=e===t?null:kn(e);e.remove(),e=n}}function dr(e){var t=e.parent,n=e.prev,r=e.next;n!==null&&(n.next=r),r!==null&&(r.prev=n),t!==null&&(t.first===e&&(t.first=r),t.last===e&&(t.last=n))}function fr(e,t,n=!0){var r=[];e.f|=256,pr(e,r,!0);var i=()=>{n&&lr(e),t&&t()},a=r.length;if(a>0){var o=()=>--a||i();for(var s of r)s.out(o)}else i()}function pr(e,t,n){if(!(e.f&8192)){e.f^=te;var r=e.nodes&&e.nodes.t;if(r!==null)for(let e of r)(e.is_global||n)&&t.push(e);for(var i=e.first;i!==null;){var a=i.next;if(!(i.f&64)){var o=!!(i.f&65536)||!!(i.f&32)&&!!(e.f&16);pr(i,t,o?n:!1)}i=a}}}function mr(e){e.f&=-257,hr(e,!0)}function hr(e,t){if(!(e.f&256)&&e.f&8192){e.f^=te,e.f&1024||(U(e,T),rn.ensure().schedule(e));for(var n=e.first;n!==null;){var r=n.next,i=!!(n.f&65536)||!!(n.f&32);hr(n,i?t:!1),n=r}var a=e.nodes&&e.nodes.t;if(a!==null)for(let e of a)(e.is_global||t)&&e.in()}}function gr(e,t){if(e.nodes)for(var n=e.nodes.start,r=e.nodes.end;n!==null;){var i=n===r?null:kn(n);t.append(n),n=i}}var q=e((()=>{Q(),L(),Wn(),We(),s(),C(),Vn(),nt(),on(),Et(),bt(),ut()})),_r,vr=e((()=>{bn(),Q(),_r=null}));function yr(e){Lr=e}function br(e){Y=e}function xr(e){X=e}function Sr(e){Y!==null&&(!Ge&&Y.f&2097152||Y.f&2)&&(zr??=new Set).add(e)}function Cr(e){Vr=e}function wr(e){Wr=e}function Tr(){return++Hr}function Er(e){var t=e.f;if(t&2048)return!0;if(t&4096){for(var n=e.deps,r=n.length,i=0;i<r;i++){var a=n[i];if(Er(a)&&Nt(a),a.wv>e.wv)return!0}t&512&&Yt===null&&U(e,w)}return!1}function Dr(e,t,n=!0){var r=e.reactions;if(r!==null&&(Ge||zr===null||!zr.has(e)))for(var i=0;i<r.length;i++){var a=r[i];a.f&2?Dr(a,t,!1):t===a&&(n?U(a,T):a.f&1024&&U(a,E),Ut(a))}}function Or(e){var t=Z,n=Br,r=Vr,i=Y,a=zr,o=H,s=Rr,c=Wr,l=e.f;Z=null,Br=0,Vr=null,Y=l&96?null:e,zr=null,Ze(e.ctx),Rr=!1,Wr=++Ur,e.ac!==null&&(vt(()=>{e.ac.abort(de)}),e.ac=null);try{e.f|=oe;var u=e.fn,d=u();e.f|=O;var f=kr(e);if(tt()&&Vr!==null&&!Rr&&f!==null&&!(e.f&6146))for(var p=0;p<Vr.length;p++)Dr(Vr[p],e);if(i!==null&&i!==e){if(Ur++,i.deps!==null)for(let e=0;e<n;e+=1)i.deps[e].rv=Ur;if(t!==null)for(let e of t)e.rv=Ur;Vr!==null&&(r===null?r=Vr:r.push(...Vr))}return e.f&8388608&&(e.f^=se),d}catch(t){return kr(e),Hn(t)}finally{e.f^=oe,Z=t,Br=n,Vr=r,Y=i,zr=a,Ze(o),Rr=s,Wr=c}}function kr(e){var t=e.deps,n=W?.is_fork;if(Z!==null){var r;if(n||jr(e,Br),t!==null&&Br>0)for(t.length=Br+Z.length,r=0;r<Z.length;r++)t[Br+r]=Z[r];else e.deps=t=Z;if(Jn()&&e.f&512)for(r=Br;r<t.length;r++)(t[r].reactions??=[]).push(e)}else!n&&t!==null&&Br<t.length&&(jr(e,Br),t.length=Br);return t}function Ar(e,t){let n=t.reactions;if(n!==null){var r=f.call(n,e);if(r!==-1){var i=n.length-1;i===0?n=t.reactions=null:(n[r]=n[i],n.pop())}}if(n===null&&t.f&2&&(Z===null||!p.call(Z,t))){var a=t;a.f&512&&(a.f^=512),a.v!==me&&ct(a),a.ac!==null&&vt(()=>{a.ac.abort(de),a.ac=null,U(a,T)}),Pt(a),jr(a,0)}}function jr(e,t){var n=e.deps;if(n!==null)for(var r=t;r<n.length;r++)Ar(e,n[r])}function Mr(e){var t=e.f;if(!(t&16384)){U(e,w);var n=X;X=e;try{t&16777232?cr(e):sr(e),or(e);var r=Or(e);e.teardown=typeof r==`function`?r:null,e.wv=Hr}finally{X=n}}}async function Nr(){if(Ge)return new Promise(e=>{requestAnimationFrame(()=>e()),setTimeout(()=>e())});await Promise.resolve(),Rt()}function J(e){var t=!!(e.f&2);if(_r?.add(e),Y!==null&&!Rr&&!(X!==null&&X.f&16384)&&(zr===null||!zr.has(e))){var n=Y.deps;if(Y.f&2097152)e.rv<Ur&&(e.rv=Ur,Z===null&&n!==null&&n[Br]===e?Br++:Z===null?Z=[e]:Z.push(e));else{Y.deps??=[],p.call(Y.deps,e)||Y.deps.push(e);var r=e.reactions;r===null?e.reactions=[Y]:p.call(r,Y)||r.push(Y)}}if(Lr&&gn.has(e))return gn.get(e);if(t){var i=e;if(Lr){var a=i.v;return(!(i.f&1024)&&i.reactions!==null||Fr(i))&&(a=Mt(i)),gn.set(i,a),a}var o=!(i.f&512)&&!Rr&&Y!==null&&!!(Y.f&512),s=(i.f&O)===0;Er(i)&&(o&&(i.f|=512),Nt(i)),o&&!s&&(Ft(i),Pr(i))}if(Yt?.has(e))return Yt.get(e);if(e.f&8388608)throw e.v;return e.v}function Pr(e){if(e.f|=512,e.deps!==null)for(let n of e.deps){var t=n.reactions;t===null?n.reactions=[e]:p.call(t,e)||t.push(e),n.f&2&&!(n.f&512)&&(Ft(n),Pr(n))}}function Fr(e){if(e.v===me)return!0;if(e.deps===null)return!1;for(let t of e.deps)if(gn.has(t)||t.f&2&&Fr(t))return!0;return!1}function Ir(e){var t=Rr;try{return Rr=!0,e()}finally{Rr=t}}var Lr,Y,Rr,X,zr,Z,Br,Vr,Hr,Ur,Wr,Q=e((()=>{s(),C(),q(),L(),bn(),Lt(),qe(),Ye(),Xe(),nt(),on(),Wn(),ge(),vr(),bt(),ut(),xe(),Lr=!1,Y=null,Rr=!1,X=null,zr=null,Z=null,Br=0,Vr=null,Hr=1,Ur=0,Wr=Ur})),Gr=e((()=>{$o(),ts(),q()}));function Kr(e){return e.endsWith(`capture`)&&e!==`gotpointercapture`&&e!==`lostpointercapture`}function qr(e){return Xr.includes(e)}function Jr(e){return e=e.toLowerCase(),Qr[e]??e}function Yr(e){return $r.includes(e)}var Xr,Zr,Qr,$r,ei,ti=e((()=>{Xr=[`beforeinput`,`click`,`change`,`dblclick`,`contextmenu`,`focusin`,`focusout`,`input`,`keydown`,`keyup`,`mousedown`,`mousemove`,`mouseout`,`mouseover`,`mouseup`,`pointerdown`,`pointermove`,`pointerout`,`pointerover`,`pointerup`,`touchend`,`touchmove`,`touchstart`],Zr=`allowfullscreen.async.autofocus.autoplay.checked.controls.default.disabled.formnovalidate.indeterminate.inert.ismap.loop.multiple.muted.nomodule.novalidate.open.playsinline.readonly.required.reversed.seamless.selected.webkitdirectory.defer.disablepictureinpicture.disableremoteplayback`.split(`.`),Qr={formnovalidate:`formNoValidate`,ismap:`isMap`,nomodule:`noModule`,playsinline:`playsInline`,readonly:`readOnly`,defaultvalue:`defaultValue`,defaultchecked:`defaultChecked`,srcobject:`srcObject`,novalidate:`noValidate`,allowfullscreen:`allowFullscreen`,disablepictureinpicture:`disablePictureInPicture`,disableremoteplayback:`disableRemotePlayback`},[...Zr],$r=[`touchstart`,`touchmove`],ei=[`$state`,`$state.raw`,`$derived`,`$derived.by`],[...ei]})),ni=e((()=>{L(),ti(),Q()})),ri=e((()=>{L(),V(),nt()}));function ii(e,t,n,r={}){function i(e){if(r.capture||ci.call(t,e),!e.cancelBubble)return vt(()=>n?.call(this,e))}return e.startsWith(`pointer`)||e.startsWith(`touch`)||e===`wheel`?(i.__removed=!1,it(()=>{i.__removed||t.addEventListener(e,i,r)})):t.addEventListener(e,i,r),i}function ai(e,t,n,r,i){var a={capture:r,passive:i},o=ii(e,t,n,a);(t===document.body||t===window||t===document||t instanceof HTMLMediaElement)&&Yn(()=>{o.__removed=!0,t.removeEventListener(e,o,a)})}function oi(e,t,n){(t[li]??={})[e]=n}function si(e){for(var t=0;t<e.length;t++)ui.add(e[t]);for(var n of di)n(e)}function ci(e){var t=this,n=t.ownerDocument,r=e.type,i=e.composedPath?.()||[],a=i[0]||e.target;fi=e,pi||(pi=!0,setTimeout(()=>{pi=!1,fi=null}));var o=0,s=fi===e&&e[li];if(s){var c=i.indexOf(s);if(c!==-1&&(t===document||t===window)){e[li]=t;return}var l=i.indexOf(t);if(l===-1)return;c<=l&&(o=c)}if(a=i[o]||e.target,a!==t){h(e,`currentTarget`,{configurable:!0,get(){return a||n}});var u=Y,d=X;br(null),xr(null);try{for(var f,p=[];a!==null&&a!==t;){try{var m=a[li]?.[r];m!=null&&(!a.disabled||e.target===a)&&m.call(a,e)}catch(e){f?p.push(e):f=e}if(e.cancelBubble)break;o++,a=o<i.length?i[o]:null}if(f){for(let e of p)queueMicrotask(()=>{throw e});throw f}}finally{e[li]=t,delete e.currentTarget,br(u),xr(d)}}}var li,ui,di,fi,pi,mi=e((()=>{q(),C(),V(),st(),Q(),bt(),li=Symbol(`events`),ui=new Set,di=new Set,fi=null,pi=!1}));function hi(e){return _i?.createHTML(e)??e}function gi(e){var t=Pn(`template`);return t.innerHTML=hi(e.replaceAll(`<!>`,`<!---->`)),t.content}var _i,vi=e((()=>{Vn(),_i=globalThis?.window?.trustedTypes&&globalThis.window.trustedTypes.createPolicy(`svelte-trusted-html`,{createHTML:e=>e})}));function yi(e,t){var n=X;n.nodes===null&&(n.nodes={start:e,end:t,a:null,t:null})}function bi(e,t){var n=!!(t&1),r=!!(t&2),i,a=!e.startsWith(`<!>`);return()=>{if(z)return yi(B,null),B;i===void 0&&(i=gi(a?e:`<!>`+e),n||(i=On(i)));var t=r||Rn?document.importNode(i,!0):i.cloneNode(!0);if(n){var o=On(t),s=t.lastChild;yi(o,s)}else yi(t,t);return t}}function xi(e,t,n=`svg`){var r=!e.startsWith(`<!>`),i=!!(t&1),a=`<${n}>${r?e:`<!>`+e}</${n}>`,o;return()=>{if(z)return yi(B,null),B;if(!o){var e=On(gi(a));if(i)for(o=document.createDocumentFragment();On(e);)o.appendChild(On(e));else o=On(e)}var t=o.cloneNode(!0);if(i){var n=On(t),r=t.lastChild;yi(n,r)}else yi(t,t);return t}}function Si(e,t){return xi(e,t,`svg`)}function Ci(){if(z)return yi(B,null),B;var e=document.createDocumentFragment(),t=document.createComment(``),n=Dn();return e.append(t,n),yi(t,n),e}function wi(e,t){if(z){var n=X;(!(n.f&32768)||n.nodes.end===null)&&(n.nodes.end=B),we()}else e!==null&&e.before(t)}var Ti=e((()=>{V(),Vn(),vi(),Q(),ge(),L()}));function Ei(e){let t=0,n=sn(0),r;return()=>{Jn()&&(J(n),tr(()=>(t===0&&(r=Ir(()=>e(()=>pn(n)))),t+=1,()=>{it(()=>{--t,t===0&&(r?.(),r=void 0,pn(n))})})))}}var Di=e((()=>{Q(),q(),bn(),Ye(),s(),st()}));function Oi(e,t,n,r){new Ai(e,t,n,r)}var ki,Ai,ji=e((()=>{L(),ge(),nt(),Wn(),q(),Q(),V(),st(),We(),xe(),s(),on(),bn(),Ye(),Di(),Vn(),ft(),ki=re|ie,Ai=class{parent;is_pending=!1;transform_error;#e;#t=z?B:null;#n;#r;#i;#a=null;#o=null;#s=null;#c=null;#l=0;#u=0;#d=!1;#f=new Set;#p=new Set;#m=null;#h=Ei(()=>(this.#m=sn(this.#l),()=>{this.#m=null}));constructor(e,t,n,r){this.#e=e,this.#n=t,this.#r=e=>{var t=X;t.b=this,t.f|=128,n(e)},this.parent=X.b,this.transform_error=r??this.parent?.transform_error??(e=>e),this.#i=rr(()=>{if(z){let e=De(this.#t);we();let t=e===`[!`;if(e.startsWith(`[?`)){let t=JSON.parse(e.slice(2));this.#_(t)}else t?this.#b():this.#g()}else this.#x()},ki),z&&(this.#e=B)}#g(){try{this.#a=ar(()=>this.#r(this.#e))}catch(e){this.error(e)}}#_(e){let t=this.#n.failed,{reset:n,invoke_onerror:r}=this.#v(e);it(r),t&&(this.#s=ar(()=>{t(this.#e,()=>e,()=>n)}))}#v(e){var t=!1,n=!1;let r=()=>{this.#y()||(t?be():(t=!0,n&&Ue(),this.#s!==null&&fr(this.#s,()=>{this.#s=null}),this.#C(()=>{this.#x()})))};return{reset:r,invoke_onerror:()=>{if(!this.#y())try{n=!0,this.#n.onerror?.(e,r),n=!1}catch(e){Un(e,this.#i&&this.#i.parent)}}}}#y(){return(this.#i.f&(D|ne))!==0}#b(){let e=this.#n.pending;e&&(this.is_pending=!0,this.#o=ar(()=>e(this.#e)),it(()=>{if(!this.#y()){var e=this.#c=document.createDocumentFragment(),t=Dn(),n=!1;e.append(t),this.#a=this.#C(()=>{try{return ar(()=>this.#r(t))}catch(e){try{this.error(e),n=!0}catch(e){Un(e,this.#i.parent)}return null}}),this.#a===null?(this.#c=null,n&&this.#S(W)):this.#u===0&&(this.#e.before(e),this.#c=null,fr(this.#o,()=>{this.#o=null}),this.#S(W))}}))}#x(){try{if(this.is_pending=this.has_pending_snippet(),this.#u=0,this.#l=0,this.#a=ar(()=>{this.#r(this.#e)}),this.#u>0){var e=this.#c=document.createDocumentFragment();gr(this.#a,e);let t=this.#n.pending;this.#o=ar(()=>t(this.#e))}else this.#S(W)}catch(e){this.error(e)}}#S(e){this.is_pending=!1,e.transfer_effects(this.#f,this.#p)}defer_effect(e){dt(e,this.#f,this.#p)}is_rendered(){return!this.is_pending&&(!this.parent||this.parent.is_rendered())}has_pending_snippet(){return!!this.#n.pending}#C(e){var t=X,n=Y,r=H;xr(this.#i),br(this.#i),Ze(this.#i.ctx);try{return rn.ensure(),e()}finally{xr(t),br(n),Ze(r)}}#w(e,t){this.has_pending_snippet()?(this.#u+=e,this.#u===0&&(this.#S(t),this.#o&&fr(this.#o,()=>{this.#o=null}),this.#c&&=(this.#e.before(this.#c),null))):this.parent&&this.parent.#w(e,t)}update_pending_count(e,t){this.#w(e,t),this.#l+=e,!(!this.#m||this.#d)&&(this.#d=!0,it(()=>{this.#d=!1,this.#m&&dn(this.#m,this.#l)}))}get_effect_pending(){return this.#h(),J(this.#m)}error(e){if(e===pe||!this.#n.onerror&&!this.#n.failed)throw e;W?.is_fork?(this.#a&&W.skip_effect(this.#a),this.#o&&W.skip_effect(this.#o),this.#s&&W.skip_effect(this.#s),W.oncommit(()=>{this.#y()||this.#T(e)})):this.#T(e)}#T(e){this.#a&&=(lr(this.#a),null),this.#o&&=(lr(this.#o),null),this.#s&&=(lr(this.#s),null),z&&(Ce(this.#t),Te(),Ce(Ee()));let t=this.#n.failed,n=e=>{if(this.#y())return;let{reset:n,invoke_onerror:r}=this.#v(e);r(),t&&!this.#y()&&(this.#s=this.#C(()=>{try{return ar(()=>{var r=X;r.b=this,r.f|=128,t(this.#e,()=>e,()=>n)})}catch(e){return Un(e,this.#i.parent),null}}))};it(()=>{if(!this.#y()){var t;try{t=this.transform_error(e)}catch(e){Un(e,this.#i&&this.#i.parent);return}typeof t==`object`&&t&&typeof t.then==`function`?t.then(n,e=>Un(e,this.#i&&this.#i.parent)):n(t)}})}}}));function Mi(e,t){var n=t==null?``:typeof t==`object`?`${t}`:t;n!==(e[F]??=e.nodeValue)&&(e[F]=n,e.nodeValue=`${n}`)}function Ni(e,t){return Pi(e,t)}function Pi(e,{target:t,anchor:n,props:r={},events:i,context:a,intro:o=!0,transformError:s}){En();var c=void 0,l=Qn(()=>{var l=n??t.appendChild(Dn());Oi(l,{pending:()=>{}},t=>{Qe({});var n=H;if(a&&(n.c=a),i&&(r.$$events=i),z&&yi(t,null),Fi=o,c=e(t,r)||et(),Fi=!0,z&&(X.nodes.end=B,B===null||B.nodeType!==8||B.data!==`]`))throw ve(),pe;$e()},s);var u=new Set,d=e=>{for(var n=0;n<e.length;n++){var r=e[n];if(!u.has(r)){u.add(r);var i=Yr(r);for(let e of[t,document]){var a=Ii.get(e);a===void 0&&(a=new Map,Ii.set(e,a));var o=a.get(r);o===void 0?(e.addEventListener(r,ci,{passive:i}),a.set(r,1)):a.set(r,o+1)}}}};return d(m(ui)),di.add(d),()=>{for(var e of u)for(let n of[t,document]){var r=Ii.get(n),i=r.get(e);--i==0?(n.removeEventListener(e,ci),r.delete(e),r.size===0&&Ii.delete(n)):r.set(e,i)}di.delete(d),l!==n&&l.parentNode?.removeChild(l)}});return Li.set(c,l),c}var Fi,Ii,Li,Ri=e((()=>{s(),Vn(),ge(),Q(),nt(),q(),V(),C(),mi(),xe(),We(),Ti(),ti(),L(),ji(),Fi=!0,Ii=new Map,Li=new WeakMap})),zi=e((()=>{L(),V(),q(),bn(),Ri(),Q()})),Bi=e((()=>{C(),L(),nt(),ti()})),Vi=e((()=>{We(),nt()})),Hi=e((()=>{Je(),q(),Q(),Xe()})),Ui=e((()=>{Et(),Q(),V(),Ti()})),Wi=e((()=>{We()})),Gi,Ki=e((()=>{on(),q(),L(),V(),Vn(),s(),Gi=class{anchor;#e=new Map;#t=new Map;#n=new Map;#r=new Set;#i=!0;constructor(e,t=!0){this.anchor=e,this.#i=t}#a=e=>{if(this.#e.has(e)){var t=this.#e.get(e),n=this.#t.get(t);if(n)mr(n),this.#r.delete(t);else{var r=this.#n.get(t);r&&(mr(r.effect),this.#t.set(t,r.effect),this.#n.delete(t),r.fragment.lastChild.remove(),this.anchor.before(r.fragment),n=r.effect)}for(let[t,n]of this.#e){if(this.#e.delete(t),t===e)break;let r=this.#n.get(n);r&&(lr(r.effect),this.#n.delete(n))}for(let[e,r]of this.#t){if(e===t||this.#r.has(e))continue;let i=()=>{if(Array.from(this.#e.values()).includes(e)){var t=document.createDocumentFragment();gr(r,t),t.append(Dn()),this.#n.set(e,{effect:r,fragment:t})}else lr(r);this.#r.delete(e),this.#t.delete(e)};this.#i||!n?(this.#r.add(e),fr(r,i,!1)):i()}}};#o=e=>{this.#e.delete(e);let t=Array.from(this.#e.values());for(let[e,n]of this.#n)t.includes(e)||(lr(n.effect),this.#n.delete(e))};ensure(e,t){var n=W,r=Nn();if(t&&!this.#t.has(e)&&!this.#n.has(e)){if(r){var i=document.createDocumentFragment(),a=Dn();i.append(a),this.#n.set(e,{effect:ar(()=>t(a)),fragment:i})}else this.#t.set(e,ar(()=>t(this.anchor)))}if(this.#e.set(n,e),r){for(let[t,r]of this.#t)t===e?n.unskip_effect(r):n.skip_effect(r);for(let[t,r]of this.#n)t===e?n.unskip_effect(r.effect):n.skip_effect(r.effect);n.oncommit(this.#a),n.ondiscard(this.#o)}else z&&(this.anchor=B),this.#a(n)}}})),qi=e((()=>{C(),q(),bn(),V(),st(),nt(),on(),Ki(),Et()}));function Ji(e,t,n=!1){var r;z&&(r=B,we());var i=new Gi(e),a=n?re:0;function o(e,t){if(z){var n=De(r);if(e!==parseInt(n.substring(1))){var a=Ee();Ce(a),i.anchor=a,Se(!1),i.ensure(e,t),Se(!0);return}}i.ensure(e,t)}rr(()=>{var e=!1;t((t,n=0)=>{e=!0,o(n,t)}),e||o(-1,null)},a)}var Yi=e((()=>{L(),V(),q(),Ki()}));function Xi(e,t,n){z&&we();var r=new Gi(e),i=!tt();rr(()=>{var e=t();e!==e&&(e=Zi),i&&typeof e==`object`&&e&&(e={}),r.ensure(e,n)})}var Zi,Qi=e((()=>{nt(),q(),V(),Ki(),Zi=Symbol(`NaN`)})),$i=e((()=>{q(),V(),Vn()}));function ea(e,t){return t}function ta(e,t,n){for(var r=[],i=t.length,a,o=t.length,s=0;s<i;s++){let n=t[s];fr(n,()=>{if(a){if(a.pending.delete(n),a.done.add(n),a.pending.size===0){var t=e.outrogroups;na(e,m(a.done)),t.delete(a),t.size===0&&(e.outrogroups=null)}}else--o},!1)}if(o===0){var c=r.length===0&&n!==null&&e.pending.size===0;if(c){var l=n,u=l.parentNode;Mn(u),u.append(l),e.items.clear()}na(e,t,!c)}else a={pending:new Set(t),done:new Set},(e.outrogroups??=new Set).add(a)}function na(e,t,n=!0){var r;if(e.pending.size>0){r=new Set;for(let t of e.pending.values())for(let n of t)r.add(e.items.get(n).e)}for(var i=0;i<t.length;i++){var a=t[i];r?.has(a)?(a.f|=ae,gr(a,document.createDocumentFragment())):lr(t[i],n)}}function ra(e,t,n,r,i,a=null){var o=e,s=new Map;if(t&4){var c=e;o=z?Ce(On(c)):c.appendChild(Dn())}z&&we();var l=null,u=At(()=>{var e=n();return d(e)?e:e==null?[]:m(e)}),f=new Map,p=!0;function h(e){if(!(_.effect.f&16384)){_.pending.delete(e);var n=J(u);_.fallback=l,aa(_,n,o,t,r),l!==null&&(n.length===0?l.f&33554432?(l.f^=ae,sa(l,null,o)):mr(l):fr(l,()=>{l=null}))}}function g(e){_.pending.delete(e)}var _={effect:rr(()=>{var e=J(u),c=e.length;let d=!1;z&&De(o)===`[!`!=(c===0)&&(o=Ee(),Ce(o),Se(!1),d=!0);for(var m=new Set,_=W,v=Nn(),y=0;y<c;y+=1){z&&B.nodeType===8&&B.data===`]`&&(o=B,d=!0,Se(!1));var b=e[y],x=r(b,y),S=p?null:s.get(x);S?(S.v&&dn(S.v,b),S.i&&dn(S.i,y),v&&_.unskip_effect(S.e)):(S=oa(s,p?o:la??=Dn(),b,x,y,i,t,n),p||(S.e.f|=ae),s.set(x,S)),m.add(x)}if(c===0&&a&&!l&&(p?l=ar(()=>a(o)):(l=ar(()=>a(la??=Dn())),l.f|=ae)),c>m.size&&Pe(``,``,``),z&&c>0&&Ce(Ee()),!p){if(f.set(_,m),v){for(let[e,t]of s)m.has(e)||_.skip_effect(t.e);_.oncommit(h),_.ondiscard(g)}else h(_)}d&&Se(!0),J(u)}),flags:t,items:s,pending:f,outrogroups:null,fallback:l};p=!1,z&&(o=B)}function ia(e){for(;e!==null&&!(e.f&32);)e=e.next;return e}function aa(e,t,n,r,i){var a=!!(r&8),o=t.length,s=e.items,c=ia(e.effect.first),l,u=null,d,f=[],p=[],h,g,_,v;if(a)for(v=0;v<o;v+=1)h=t[v],g=i(h,v),_=s.get(g).e,_.f&33554432||(_.nodes?.a?.measure(),(d??=new Set).add(_));for(v=0;v<o;v+=1){if(h=t[v],g=i(h,v),_=s.get(g).e,e.outrogroups!==null)for(let t of e.outrogroups)t.pending.delete(_),t.done.delete(_);if(_.f&8192&&(mr(_),a&&(_.nodes?.a?.unfix(),(d??=new Set).delete(_))),_.f&33554432){if(_.f^=ae,_===c)sa(_,null,n);else{var y=u?u.next:c;_===e.effect.last&&(e.effect.last=_.prev),_.prev&&(_.prev.next=_.next),_.next&&(_.next.prev=_.prev),ca(e,u,_),ca(e,_,y),sa(_,y,n),u=_,f=[],p=[],c=ia(u.next);continue}}if(_!==c){if(l!==void 0&&l.has(_)){if(f.length<p.length){var b=p[0],x;u=b.prev;var S=f[0],C=f[f.length-1];for(x=0;x<f.length;x+=1)sa(f[x],b,n);for(x=0;x<p.length;x+=1)l.delete(p[x]);ca(e,S.prev,C.next),ca(e,u,S),ca(e,C,b),c=b,u=C,--v,f=[],p=[]}else l.delete(_),sa(_,c,n),ca(e,_.prev,_.next),ca(e,_,u===null?e.effect.first:u.next),ca(e,u,_),u=_;continue}for(f=[],p=[];c!==null&&c!==_;)(l??=new Set).add(c),p.push(c),c=ia(c.next);if(c===null)continue}_.f&33554432||f.push(_),u=_,c=ia(_.next)}if(e.outrogroups!==null){for(let t of e.outrogroups)t.pending.size===0&&(na(e,m(t.done)),e.outrogroups?.delete(t));e.outrogroups.size===0&&(e.outrogroups=null)}if(c!==null||l!==void 0){var ee=[];if(l!==void 0)for(_ of l)_.f&8192||ee.push(_);for(;c!==null;)!(c.f&8192)&&c!==e.fallback&&ee.push(c),c=ia(c.next);var w=ee.length;if(w>0){var T=r&4&&o===0?n:null;if(a){for(v=0;v<w;v+=1)ee[v].nodes?.a?.measure();for(v=0;v<w;v+=1)ee[v].nodes?.a?.fix()}ta(e,ee,T)}}a&&it(()=>{if(d!==void 0)for(_ of d)_.nodes?.a?.apply()})}function oa(e,t,n,r,i,a,o,s){var c=o&1?o&16?sn(n):ln(n,!1,!1):null,l=o&2?sn(i):null;return{v:c,i:l,e:ar(()=>(a(t,c??n,l??i,s),()=>{e.delete(r)}))}}function sa(e,t,n){if(e.nodes)for(var r=e.nodes.start,i=e.nodes.end,a=t&&!(t.f&33554432)?t.nodes.start:n;r!==null;){var o=kn(r);if(a.before(r),r===i)return;r=o}}function ca(e,t,n){t===null?e.effect.first=n:t.next=n,n===null?e.effect.last=t:n.prev=t}var la,ua=e((()=>{ge(),V(),Vn(),q(),bn(),C(),L(),st(),Q(),s(),Lt(),on(),We(),Ye()})),da=e((()=>{q(),V(),Ti(),ti(),nt(),Vn(),Q(),L()})),fa=e((()=>{V(),Vn(),Ti()})),pa=e((()=>{ti(),Me()})),ma=e((()=>{L(),q(),nt(),V(),vi(),Ti(),We(),Vn(),pa(),Ki()})),ha=e((()=>{L(),q(),V(),Ki()})),ga,_a,va=e((()=>{C(),s(),ga=()=>performance.now(),_a={tick:e=>requestAnimationFrame(e),now:()=>ga(),tasks:new Set}}));function ya(){let e=_a.now();_a.tasks.forEach(t=>{t.c(e)||(_a.tasks.delete(t),t.f())}),_a.tasks.size!==0&&_a.tick(ya)}function ba(e){let t;return _a.tasks.size===0&&_a.tick(ya),{promise:new Promise(n=>{_a.tasks.add(t={c:e,f:n})}),abort(){_a.tasks.delete(t)}}}var xa=e((()=>{va()}));function Sa(e,t){vt(()=>{e.dispatchEvent(new CustomEvent(t))})}function Ca(e){if(e===`float`)return`cssFloat`;if(e===`offset`)return`cssOffset`;if(e.startsWith(`--`))return e;let t=e.split(`-`);return t.length===1?t[0]:t[0]+t.slice(1).map(e=>e[0].toUpperCase()+e.slice(1)).join(``)}function wa(e){let t={},n=e.split(`;`);for(let e of n){let[n,r]=e.split(`:`);if(!n||r===void 0)break;let i=Ca(n.trim());t[i]=r.trim()}return t}function Ta(e,t,n,r){var i=!!(e&1),a=!!(e&2),o=i&&a,s=!!(e&4),c=o?`both`:i?`in`:`out`,l,u=t.inert,d=t.style.overflow,f,p;function m(){return vt(()=>l??=n()(t,r?.()??{},{direction:c}))}var h={is_global:s,in(){t.inert=u,i?(a||f?.abort(),f=Ea(t,m(),p,1,()=>{Sa(t,`introstart`)},()=>{Sa(t,`introend`),f?.abort(),f=l=void 0,t.style.overflow=d})):(p?.abort(),p?.reset?.())},out(e){a?(t.inert=!0,p=Ea(t,m(),f,0,()=>{Sa(t,`outrostart`)},()=>{Sa(t,`outroend`),e?.()})):(e?.(),l=void 0)},stop:()=>{f?.abort(),p?.abort()}},g=X;if((g.nodes.t??=[]).push(h),i&&Fi){var _=s;if(!_){for(var v=g.parent;v&&v.f&65536;)for(;(v=v.parent)&&!(v.f&16););_=!v||!!(v.f&32768)}_&&$n(()=>{Ir(()=>h.in())})}}function Ea(e,t,n,r,i,a){var o=r===1,s=!1;if(c(t)){var l;return it(()=>{s||(l=Ea(e,t({direction:o?`in`:`out`}),n,r,i,a))}),{abort:()=>{s=!0,l?.abort()},deactivate:()=>l?.deactivate(),reset:()=>l?.reset(),t:()=>l?.t()??1-r}}if(n?.deactivate(),!t?.duration&&!t?.delay)return i(),a(),{abort:S,deactivate:S,reset:S,t:()=>r};let{delay:u=0,css:d,tick:f,easing:p=Da}=t;var m,h=()=>1-r;return it(()=>{if(!s){var c=[];if(o&&n===void 0&&(f&&f(0,1),d)){var l=wa(d(0,1));c.push(l,l)}m=e.animate(c,{duration:u,fill:`forwards`}),m.onfinish=()=>{m.cancel(),i();var o=n?.t()??1-r;n?.abort();var s=r-o,c=t.duration*Math.abs(s),l=[];if(c>0){var u=!1;if(d)for(var g=Math.ceil(c/(1e3/60)),_=0;_<=g;_+=1){var v=o+s*p(_/g),y=wa(d(v,1-v));l.push(y),u||=y.overflow===`hidden`}u&&(e.style.overflow=`hidden`),h=()=>{var e=m.currentTime;return o+s*p(e/c)},f&&ba(()=>{if(m.playState!==`running`)return!1;var e=h();return f(e,1-e),!0})}m=e.animate(l,{duration:c,fill:`forwards`}),m.onfinish=()=>{h=()=>r,f?.(r,1-r),a()}}}}),{abort:()=>{s=!0,m&&(m.cancel(),m.effect=null,m.onfinish=S)},deactivate:()=>{a=S},reset:()=>{r===0&&f?.(1,0)},t:()=>h()}}var Da,Oa=e((()=>{C(),q(),Q(),xa(),Ri(),ge(),L(),st(),bt(),Da=e=>e})),ka=e((()=>{V(),Vn(),q(),Ri(),Q(),nt(),L(),Ti(),ti(),Ki(),Oa()})),Aa=e((()=>{V(),Vn(),q(),L()})),ja=e((()=>{q(),Vn(),Q()})),Ma=e((()=>{q(),Q()}));function Na(e,t){var n=void 0,r;ir(()=>{n!==(n=t())&&(r&&=(lr(r),null),n&&(r=ar(()=>{$n(()=>n(e))})))})}var Pa=e((()=>{q()}));function Fa(e){var t,n,r=``;if(typeof e==`string`||typeof e==`number`)r+=e;else if(typeof e==`object`){if(Array.isArray(e)){var i=e.length;for(t=0;t<i;t++)e[t]&&(n=Fa(e[t]))&&(r&&(r+=` `),r+=n)}else for(n in e)e[n]&&(r&&(r+=` `),r+=n)}return r}function Ia(){for(var e,t,n=0,r=``,i=arguments.length;n<i;n++)(e=arguments[n])&&(t=Fa(e))&&(r&&(r+=` `),r+=t);return r}var La=e((()=>{}));function Ra(e){return typeof e==`object`?Ia(e):e??``}function za(e,t,n){var r=e==null?``:``+e;if(t&&(r=r?r+` `+t:t),n){for(var i of Object.keys(n))if(n[i])r=r?r+` `+i:i;else if(r.length)for(var a=i.length,o=0;(o=r.indexOf(i,o))>=0;){var s=o+a;(o===0||Ua.includes(r[o-1]))&&(s===r.length||Ua.includes(r[s]))?r=(o===0?``:r.substring(0,o))+r.substring(s+1):o=s}}return r===``?null:r}function Ba(e,t=!1){var n=t?` !important;`:`;`,r=``;for(var i of Object.keys(e)){var a=e[i];a!=null&&a!==``&&(r+=` `+i+`: `+a+n)}return r}function Va(e){return e[0]!==`-`||e[1]!==`-`?e.toLowerCase():e}function Ha(e,t){if(t){var n=``,r,i;if(Array.isArray(t)?(r=t[0],i=t[1]):r=t,e){e=String(e).replaceAll(/\/\*.*?\*\//g,``).trim();var a=!1,o=0,s=!1,c=[];r&&c.push(...Object.keys(r).map(Va)),i&&c.push(...Object.keys(i).map(Va));var l=0,u=-1;let t=e.length;for(var d=0;d<t;d++){var f=e[d];if(s?f===`/`&&e[d-1]===`*`&&(s=!1):a?a===f&&(a=!1):f===`/`&&e[d+1]===`*`?s=!0:f===`"`||f===`'`?a=f:f===`(`?o++:f===`)`&&o--,!s&&a===!1&&o===0){if(f===`:`&&u===-1)u=d;else if(f===`;`||d===t-1){if(u!==-1){var p=Va(e.substring(l,u).trim());if(!c.includes(p)){f!==`;`&&d++;var m=e.substring(l,d).trim();n+=` `+m+`;`}}l=d+1,u=-1}}}}return r&&(n+=Ba(r)),i&&(n+=Ba(i,!0)),n=n.trim(),n===``?null:n}return e==null?null:String(e)}var Ua,Wa=e((()=>{La(),C(),Ua=[...` 	
\r\f\xA0\v﻿`]}));function Ga(e,t,n,r,i,a){var o=e[P];if(z||o!==n||o===void 0){var s=za(n,r,a);(!z||s!==e.getAttribute(`class`))&&(s==null?e.removeAttribute(`class`):t?e.className=s:e.setAttribute(`class`,s)),e[P]=n}else if(a&&i!==a)for(var c in a){var l=!!a[c];(i==null||l!==!!i[c])&&e.classList.toggle(c,l)}return a}var Ka=e((()=>{Wa(),L(),V()}));function qa(e,t={},n,r){for(var i in n){var a=n[i];t[i]!==a&&(n[i]==null?e.style.removeProperty(i):e.style.setProperty(i,a,r))}}function Ja(e,t,n,r){var i=e[ue];if(z||i!==t){var a=Ha(t,r);(!z||a!==e.getAttribute(`style`))&&(a==null?e.removeAttribute(`style`):e.style.cssText=a),e[ue]=t}else r&&(Array.isArray(r)?(qa(e,n?.[0],r[0]),qa(e,n?.[1],r[1],`important`)):qa(e,n,r));return r}var Ya=e((()=>{Wa(),L(),V()}));function Xa(e,t){t?e.hasAttribute(`selected`)||e.setAttribute(`selected`,``):e.removeAttribute(`selected`)}function Za(e,t){var n=!(`__defaultValue`in e);(n||e.__defaultValue!==t)&&(e.__defaultValue=t,Qa(e,!n||`__value`in e))}function Qa(e,t){var n=e.__defaultValue,r=e.multiple,i=r?n??[]:null;if(!r||d(i)){var a=e.selectedIndex,o=t&&r?new Set(e.selectedOptions):null;for(var s of e.options){var c=to(s);Xa(s,r?i.includes(c):Cn(c,n))}if(t){if(o!==null)for(s of e.options){var l=o.has(s);s.selected!==l&&(s.selected=l)}else e.selectedIndex!==a&&(e.selectedIndex=a)}}}function $a(e,t,n=!1){if(e.multiple){if(t==null)return;if(!d(t))return ye();for(var r of e.options)r.selected=t.includes(to(r))}else{for(r of e.options)if(Cn(to(r),t)){r.selected=!0;return}(!n||t!==void 0)&&(e.selectedIndex=-1)}}function eo(e){var t=new MutationObserver(t=>{t.every(no)||(`__defaultValue`in e&&Qa(e,!1),`__value`in e&&$a(e,e.__value))});t.observe(e,{childList:!0,subtree:!0,attributes:!0,attributeFilter:[`value`]}),Yn(()=>{t.disconnect()})}function to(e){return`__value`in e?e.__value:e.value}function no(e){if(e.target.closest(`selectedcontent`)!==null)return!0;if(e.type===`childList`){var t=[...e.addedNodes,...e.removedNodes];return t.length>0&&t.every(e=>e.nodeName===`SELECTEDCONTENT`)}return!1}var ro=e((()=>{q(),bt(),wn(),C(),xe(),on()}));function io(e){if(z){var t=!1,n=()=>{if(!t){if(t=!0,e.hasAttribute(`value`)){var n=e.value;ao(e,`value`,null),e.value=n}if(e.hasAttribute(`checked`)){var r=e.checked;ao(e,`checked`,null),e.checked=r}}};e[I]=n,it(n),ht()}}function ao(e,t,n,r){var i=co(e);z&&(i[t]=e.getAttribute(t),t===`src`||t===`srcset`||t===`href`&&e.nodeName===ho)||i[t]!==(i[t]=n)&&(t===`loading`&&(e[le]=n),n==null?e.removeAttribute(t):typeof n!=`string`&&lo(e).has(t)?e[t]=n:e.setAttribute(t,n))}function oo(e,t,n,r,i=!1,a=!1){z&&i&&e.nodeName===go&&(`defaultValue`in n||`defaultChecked`in n||io(e));var o=co(e),s=o[po],c=!o[mo];let l=z&&s;l&&Se(!1);var u=t||{},d=e.nodeName===_o,f=e.nodeName===vo;try{for(var p in t)!(p in n)&&p[0]+p[1]!==`$$`&&(n[p]=null);n.class?n.class=Ra(n.class):(r||n[uo])&&(n.class=null),n[fo]&&(n.style??=null);var m=lo(e);if(e.nodeName===go&&`type`in n&&(`value`in n||`__value`in n)){var h=n.type;(h!==u.type||h===void 0&&e.hasAttribute(`type`))&&(u.type=h,ao(e,`type`,h,a))}for(let i in n){let l=n[i];if(d&&i===`value`&&l==null)e.value=e.__value=``,u[i]=l;else if(i===`class`)Ga(e,e.namespaceURI===`http://www.w3.org/1999/xhtml`,l,r,t?.[uo],n[uo]),u[i]=l,u[uo]=n[uo];else if(i===`style`)Ja(e,l,t?.[fo],n[fo]),u[i]=l,u[fo]=n[fo];else{var g=u[i];if(l!==g||l===void 0&&e.hasAttribute(i)){u[i]=l;var _=i[0]+i[1];if(_!==`$$`){if(_===`on`){let t={},n=`$$`+i,r=i.slice(2);var v=qr(r);if(Kr(r)&&(r=r.slice(0,-7),t.capture=!0),!v&&g){if(l!=null)continue;e.removeEventListener(r,u[n],t),u[n]=null}if(v)oi(r,e,l),si([r]);else if(l!=null){function a(e){u[i].call(this,e)}u[n]=ii(r,e,a,t)}}else if(i===`style`)ao(e,i,l);else if(i===`autofocus`)mt(e,!!l);else if(!s&&(i===`__value`||i===`value`&&l!=null))e.__value=l,(g==null||e.value!==l||l===0&&e.nodeName===yo)&&(e.value=l);else if(i===`selected`&&d)Xa(e,l);else{var y=i;c||(y=Jr(y));var b=y===`defaultValue`||y===`defaultChecked`;if(f&&y===`defaultValue`)continue;if(l==null&&!s&&!b){if(o[i]=null,y===`value`||y===`checked`){let n=e,r=t===void 0;if(y===`value`){let e=n.defaultValue;n.removeAttribute(y),n.defaultValue=e,n.value=n.__value=r?e:null}else{let e=n.defaultChecked;n.removeAttribute(y),n.defaultChecked=e,n.checked=r?e:!1}}else e.removeAttribute(i)}else b||(s||typeof l!=`string`)&&m.has(y)?(e[y]=l,y in o&&(o[y]=me)):typeof l!=`function`&&ao(e,y,l,a)}}}}}}finally{l&&Se(!0)}return u}function so(e,t,n=[],r=[],i=[],a,o=!1,s=!1){xt(i,n,r,n=>{var r=void 0,i={},c=e.nodeName===vo,l=!1;if(ir(()=>{var u=t(...n.map(J)),d=oo(e,r,u,a,o,s);if(l&&c){var f=e;`defaultValue`in u&&Za(f,u.defaultValue),`value`in u&&$a(f,u.value)}for(let e of Object.getOwnPropertySymbols(i))u[e]||lr(i[e]);for(let t of Object.getOwnPropertySymbols(u)){var p=u[t];t.description===`@attach`&&(!r||p!==r[t])&&(i[t]&&lr(i[t]),i[t]=ar(()=>Na(e,()=>p))),d[t]=p}r=d}),c){var u=e;$n(()=>{var e=r;`defaultValue`in e&&Za(u,e.defaultValue),$a(u,e.value,!0),eo(u)})}l=!0})}function co(e){return e[N]??={[po]:e.nodeName.includes(`-`),[mo]:e.namespaceURI===he}}function lo(e){var t=e.getAttribute(`is`)||e.nodeName,n=bo.get(t);if(n)return n;bo.set(t,n=new Set);for(var r,i=e,a=Element.prototype;a!==i;){for(var o in r=_(i),r)r[o].set&&o!==`innerHTML`&&o!==`textContent`&&o!==`innerText`&&n.add(o);i=b(i)}return n}var uo,fo,po,mo,ho,go,_o,vo,yo,bo,xo=e((()=>{s(),V(),C(),mi(),_t(),xe(),L(),st(),ti(),Q(),Pa(),Wa(),Ka(),Ya(),ge(),q(),ro(),Et(),uo=Symbol(`class`),fo=Symbol(`style`),po=Symbol(`is custom element`),mo=Symbol(`is html`),ho=fe?`link`:`LINK`,go=fe?`input`:`INPUT`,_o=fe?`option`:`OPTION`,vo=fe?`select`:`SELECT`,yo=fe?`progress`:`PROGRESS`,bo=new Map})),So=e((()=>{V(),Vn(),vi(),Pa()})),Co=e((()=>{bt()}));function wo(e,t,n=t){var r=new WeakSet;yt(e,`input`,async i=>{var a=i?e.defaultValue:e.value;if(a=To(e)?Eo(a):a,n(a),W!==null&&r.add(W),await Nr(),a!==(a=t())){var o=e.selectionStart,s=e.selectionEnd,c=e.value.length;if(e.value=a??``,s!==null){var l=e.value.length;o===s&&s===c&&l>c?(e.selectionStart=l,e.selectionEnd=l):(e.selectionStart=o,e.selectionEnd=Math.min(s,l))}}}),(z&&e.defaultValue!==e.value||Ir(t)==null&&e.value)&&(n(To(e)?Eo(e.value):e.value),W!==null&&r.add(W)),tr(()=>{var n=t();if(e===document.activeElement){var i=Ge?Jt:W;if(r.has(i))return}To(e)&&n===Eo(e.value)||(e.type!==`date`||n||e.value)&&n!==e.value&&(e.value=n??``)})}function To(e){var t=e.type;return t===`number`||t===`range`}function Eo(e){return e===``?null:+e}var Do=e((()=>{s(),q(),bt(),We(),wn(),st(),V(),Q(),on(),qe()})),Oo=e((()=>{q(),bt()})),ko=e((()=>{bt()})),Ao=e((()=>{q(),C()})),jo=e((()=>{q(),Q()}));function Mo(e,t){return e===t||e?.[j]===t}function No(e=et(),t,n,r){var i=H.r,a=X;return $n(()=>{var o,s;return tr(()=>{o=s,s=r?.()||[],Ir(()=>{Mo(n(...s),e)||(t(e,...s),o&&Mo(n(...o),e)&&t(null,...o))})}),()=>{let r=a;for(;r!==i&&r.parent!==null&&r.parent.f&33554432;)r=r.parent;let o=()=>{s&&Mo(n(...s),e)&&t(null,...s)},c=r.teardown;r.teardown=()=>{o(),c?.()}}}),e}var Po=e((()=>{L(),nt(),q(),Q()})),Fo=e((()=>{q(),bt()})),Io=e((()=>{q(),bt()})),Lo=e((()=>{C(),q(),mi()})),Ro=e((()=>{C(),nt(),Lt(),q(),Q()})),zo=e((()=>{bn(),Q(),C()})),Bo=e((()=>{Q(),C()})),Vo=e((()=>{C(),Bo()}));function Ho(e){var t=Uo;try{return Uo=!1,[e(),Uo]}finally{Uo=t}}var Uo,Wo=e((()=>{Bo(),Vo(),C(),Q(),q(),bn(),Uo=!1}));function Go(e,t,n){return new Proxy({props:e,exclude:t},qo)}function Ko(e,t,n,r){var i=!Ke||!!(n&2),a=!!(n&8),o=!!(n&16),s=r,c=!0,l=void 0,u=()=>o&&i?(l??=Dt(r),J(l)):(c&&(c=!1,s=o?Ir(r):r),s);let d;if(a){var f=j in e||ce in e;d=g(e,t)?.set??(f&&t in e?n=>e[t]=n:void 0)}var p,m=!1;a?[p,m]=Ho(()=>e[t]):p=e[t],p===void 0&&r!==void 0&&(p=u(),d&&(i&&ze(t),d(p)));var h=i?()=>{var n=e[t];return n===void 0?u():(c=!0,n)}:()=>{var n=e[t];return n!==void 0&&(s=void 0),n===void 0?s:n};if(i&&!(n&4))return h;if(d){var _=e.$$legacy;return(function(e,t){return arguments.length>0?((!i||!t||_||m)&&d(t?h():e),e):h()})}var v=!1,y=(n&1?Dt:At)(()=>(v=!1,h()));a&&J(y);var b=X;return(function(e,t){if(arguments.length>0){let n=t?J(y):i&&a?xn(e):e;return un(y,n),v=!0,s!==void 0&&(s=n),e}return Lr&&v||b.f&16384?y.v:J(y)})}var qo,Jo=e((()=>{s(),ge(),C(),bn(),Lt(),Q(),We(),L(),wn(),Wo(),qe(),q(),qo={get(e,t){if(!e.exclude.has(t))return e.props[t]},set(e,t){return!1},getOwnPropertyDescriptor(e,t){if(!e.exclude.has(t)&&t in e.props)return{enumerable:!0,configurable:!0,value:e.props[t]}},has(e,t){return!e.exclude.has(t)&&t in e.props},ownKeys(e){return Reflect.ownKeys(e.props).filter(t=>!e.exclude.has(t))}}})),Yo=e((()=>{nt(),q(),Wo(),Et()})),Xo=e((()=>{L(),q(),bn(),Ri(),Q(),on(),C(),We(),nt(),qe(),ut(),Lo()})),Zo=e((()=>{Xo(),q(),Ti(),C(),Vn()})),Qo=e((()=>{L(),Je(),Q()})),$o=e((()=>{Gr(),ge(),nt(),ni(),ri(),zi(),Bi(),Vi(),Ye(),Hi(),Ui(),Wi(),qi(),Yi(),Qi(),$i(),ua(),da(),fa(),ma(),ha(),ka(),Aa(),ja(),Ma(),Pa(),xo(),Ka(),mi(),_t(),So(),Ya(),Oa(),Co(),Do(),Oo(),ko(),Ao(),ro(),jo(),Po(),Fo(),Io(),V(),Lo(),Ro(),zo(),Ti(),Et(),on(),Lt(),q(),bn(),Jo(),Wo(),ji(),vr(),Ri(),Q(),Yo(),va(),wn(),Zo(),Vn(),Wa(),Je(),C(),pa(),Tn(),Qo()})),es=e((()=>{V(),We()})),ts=e((()=>{Q(),C(),$o(),We(),nt(),s(),on(),es(),Ri(),ma()})),ns=e((()=>{})),rs=e((()=>{ns(),typeof window<`u`&&((window.__svelte??={}).v??=new Set).add(`5`)}));function is(e){let t=e-1;return t*t*t+1}function as(e){let t=typeof e==`string`&&e.match(/^\s*(-?[\d.]+)([^\s]*)\s*$/);return t?[parseFloat(t[1]),t[2]||`px`]:[e,`px`]}function os(e,t,n){return Number.isNaN(t)?``:`${e}: ${n*t}px;`}function ss(e,{delay:t=0,duration:n=400,easing:r=us}={}){let i=+getComputedStyle(e).opacity;return{delay:t,duration:n,easing:r,css:e=>`opacity: ${e*i}`}}function cs(e,{delay:t=0,duration:n=400,easing:r=is,x:i=0,y:a=0,opacity:o=0}={}){let s=getComputedStyle(e),c=+s.opacity,l=s.transform===`none`?``:s.transform,u=c*(1-o),[d,f]=as(i),[p,m]=as(a);return{delay:t,duration:n,easing:r,css:(e,t)=>`
			transform: ${l} translate(${(1-e)*d}${f}, ${(1-e)*p}${m});
			opacity: ${c-u*t}`}}function ls(e,{delay:t=0,duration:n=400,easing:r=is,axis:i=`y`}={}){let a=getComputedStyle(e),o=+a.opacity,s=i===`y`?`height`:`width`,c=parseFloat(a[s]),l=i===`y`?[`top`,`bottom`]:[`left`,`right`],u=l.map(e=>`${e[0].toUpperCase()}${e.slice(1)}`),d=parseFloat(a[`padding${u[0]}`]),f=parseFloat(a[`padding${u[1]}`]),p=parseFloat(a[`margin${u[0]}`]),m=parseFloat(a[`margin${u[1]}`]),h=parseFloat(a[`border${u[0]}Width`]),g=parseFloat(a[`border${u[1]}Width`]);return{delay:t,duration:n,easing:r,css:e=>`overflow: hidden;opacity: ${Math.min(e*20,1)*o};`+os(s,c,e)+os(`padding-${l[0]}`,d,e)+os(`padding-${l[1]}`,f,e)+os(`margin-${l[0]}`,p,e)+os(`margin-${l[1]}`,m,e)+os(`border-${l[0]}-width`,h,e)+os(`border-${l[1]}-width`,g,e)+`min-${s}: 0`}}var us,ds=e((()=>{s(),xe(),us=e=>e})),$,fs,ps=e((()=>{$o(),$=xn({splash:!0,hasSong:!1,where:`server`,local:!1,hasKey:!1,askKey:0,here:{done:!1,ok:!1,gpu:``,why:``,small:!1,mem:0,cores:0,mb:0},status:null}),fs={}})),ms,hs,gs=e((()=>{ms=typeof matchMedia==`function`&&matchMedia(`(prefers-reduced-motion: reduce)`).matches,hs=e=>ms?0:e}));function _s(e,t){let n=Go(t,vs);var r=ys();so(r,()=>({viewBox:`0 0 24 24`,width:`1.2em`,height:`1.2em`,...n})),wi(e,r)}var vs,ys,bs=e((()=>{rs(),$o(),vs=new Set([`$$slots`,`$$events`,`$$legacy`]),ys=Si(`<svg><g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"><rect width="20" height="14" x="2" y="3" rx="2"></rect><path d="M8 21h8m-4-4v4"></path></g></svg>`)}));function xs(e,t){let n=Go(t,Ss);var r=Cs();so(r,()=>({viewBox:`0 0 24 24`,width:`1.2em`,height:`1.2em`,...n})),wi(e,r)}var Ss,Cs,ws=e((()=>{rs(),$o(),Ss=new Set([`$$slots`,`$$events`,`$$legacy`]),Cs=Si(`<svg><path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9"></path></svg>`)}));function Ts(e,t){let n=Go(t,Es);var r=Ds();so(r,()=>({viewBox:`0 0 24 24`,width:`1.2em`,height:`1.2em`,...n})),wi(e,r)}var Es,Ds,Os=e((()=>{rs(),$o(),Es=new Set([`$$slots`,`$$events`,`$$legacy`]),Ds=Si(`<svg><g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"><path d="M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z"></path><circle cx="16.5" cy="7.5" r=".5" fill="currentColor"></circle></g></svg>`)})),ks=e((()=>{}));function As(e,t){Qe(t,!0);let n=Ko(t,`withKey`,3,!1),r=Ko(t,`id`,3,`where`),i=cn(!1),a=cn(``),o=cn(void 0),s=kt(()=>$.here),c=kt(()=>[J(s).gpu,J(s).cores?`${J(s).cores} cores`:``,J(s).mem?J(s).mem>=8?`8 GB+`:`${J(s).mem} GB`:``].filter(Boolean).join(` · `)),l=kt(()=>J(s).done?J(s).ok?J(s).small?`Slow on a phone: use the server`:J(c):J(s).why:`Checking…`),u=kt(()=>J(s).done&&(!J(s).ok||J(s).small)),d=kt(()=>$.local?`This machine`:$.hasKey?`Key saved`:`Needs a key`),f=kt(()=>n()&&!$.local&&$.where===`server`);Xn(()=>{$.askKey&&n()&&(un(i,!0),queueMicrotask(()=>J(o)?.focus()))});function p(){fs.setKey(J(a).trim()),un(i,!1)}function m(){un(a,``),un(i,!0),queueMicrotask(()=>J(o)?.focus())}var h=Ps(),g=G(h),_=K(g,2),v=G(_);let y;var b=G(v);_s(b,{class:`ic`,"aria-hidden":`true`});var x=jn(K(b,4),!0);Te(2),R(v);var S=K(v,2),C=G(S);xs(C,{class:`ic`,"aria-hidden":`true`});var ee=jn(K(C,4),!0);Te(2),R(S),R(_);var w=K(_,2),T=e=>{var t=Ns(),n=G(t);Ts(n,{class:`ic`,"aria-hidden":`true`});var r=K(n,2),s=e=>{var t=js(),n=K(G(t));R(t),oi(`click`,n,m),wi(e,t)},c=e=>{var t=Ms(),n=G(t);io(n),No(n,e=>un(o,e),()=>J(o)),R(t),ai(`submit`,t,e=>{e.preventDefault(),p()}),oi(`change`,n,p),ai(`blur`,n,()=>{$.hasKey&&!J(a)&&un(i,!1)}),wo(n,()=>J(a),e=>un(a,e)),wi(e,t)};Ji(r,e=>{$.hasKey&&!J(i)?e(s):e(c,-1)}),R(t),Ta(3,t,()=>ls,()=>({duration:hs(180)})),wi(e,t)};Ji(w,e=>{J(f)&&e(T)}),R(h),nr(()=>{ao(g,`id`,`${r()??``}-h`),ao(_,`aria-labelledby`,`${r()??``}-h`),y=Ga(v,1,`card svelte-p74ejk`,null,y,{off:J(u)}),ao(v,`aria-pressed`,$.where===`here`),Mi(x,J(l)),ao(S,`aria-pressed`,$.where===`server`),Mi(ee,J(d))}),oi(`click`,v,()=>fs.setWhere(`here`)),oi(`click`,S,()=>fs.setWhere(`server`)),wi(e,h),$e()}var js,Ms,Ns,Ps,Fs=e((()=>{rs(),$o(),ds(),ps(),gs(),bs(),ws(),Os(),ks(),js=bi(`<span class="saved svelte-p74ejk">Server key saved <button type="button" class="change svelte-p74ejk">Change</button></span>`),Ms=bi(`<form class="svelte-p74ejk"><input type="password" autocomplete="off" spellcheck="false" placeholder="Server key" aria-label="Server key" class="svelte-p74ejk"/></form>`),Ns=bi(`<div class="key svelte-p74ejk"><!> <!></div>`),Ps=bi(`<div class="where svelte-p74ejk"><h2 class="eyebrow svelte-p74ejk">Where songs are analysed</h2> <div class="cards svelte-p74ejk" role="group"><button type="button"><!> <span class="t svelte-p74ejk">This computer</span> <span class="s svelte-p74ejk"> </span> <i class="dot svelte-p74ejk" aria-hidden="true"></i></button> <button type="button" class="card svelte-p74ejk"><!> <span class="t svelte-p74ejk">The server</span> <span class="s svelte-p74ejk"> </span> <i class="dot svelte-p74ejk" aria-hidden="true"></i></button></div> <!></div>`),si([`click`,`change`])}));function Is(e,t){let n=Go(t,Ls);var r=Rs();so(r,()=>({viewBox:`0 0 24 24`,width:`1.2em`,height:`1.2em`,...n})),wi(e,r)}var Ls,Rs,zs=e((()=>{rs(),$o(),Ls=new Set([`$$slots`,`$$events`,`$$legacy`]),Rs=Si(`<svg><path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 3v12m5-7l-5-5l-5 5m14 7v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path></svg>`)}));function Bs(e,t){let n=Go(t,Vs);var r=Hs();so(r,()=>({viewBox:`0 0 24 24`,width:`1.2em`,height:`1.2em`,...n})),wi(e,r)}var Vs,Hs,Us=e((()=>{rs(),$o(),Vs=new Set([`$$slots`,`$$events`,`$$legacy`]),Hs=Si(`<svg><path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 12h14m-7-7l7 7l-7 7"></path></svg>`)})),Ws=e((()=>{}));function Gs(e,t){Qe(t,!0);let n=[{title:`Dropping Out of School`,by:`Brad Sucks`,url:`https://archive.org/download/bs-out-of-it-remastered/01%20Dropping%20Out%20of%20School.mp3`},{title:`Incoherent`,by:`Josh Woodward`,url:`https://archive.org/download/JoshWoodwardSelection/20-JoshWoodward-HereToday-01-Incoherent.mp3`},{title:`Goldberg Variations: Aria`,by:`Kimiko Ishizaka`,url:`https://archive.org/download/OpenGoldbergVariations/Kimiko%20Ishizaka%20-%20J.S.%20Bach-%20-Open-%20Goldberg%20Variations%2C%20BWV%20988%20%28Piano%29%20-%2001%20Aria.mp3`},{title:`Invincible`,by:`Gigatop Arthur`,url:`https://archive.org/download/jamendo-140090/01-1165390-Gigatop%20Arthur-Invincible.mp3`}],r=cn(``);function i(e){e.preventDefault();let t=J(r).trim();/^https?:\/\/\S+$/i.test(t)?fs.link(t):fs.say(`Paste a link that starts with https://`,!0)}let a=0,o=!1;function s(){o=!1,clearTimeout(a),a=setTimeout(()=>{o||fs.say(`No file picker? Open this page in your browser to load songs.`,!0)},2500)}function c(e){clearTimeout(a);let t=e.currentTarget.files?.[0];e.currentTarget.value=``,t&&fs.file(t)}Xn(()=>{let e=()=>{o=!0},t=()=>{document.hidden&&(o=!0)};return addEventListener(`blur`,e),document.addEventListener(`visibilitychange`,t),()=>{removeEventListener(`blur`,e),document.removeEventListener(`visibilitychange`,t)}});let l=e=>({y:10,duration:hs(320),delay:hs(60+e*70)});var u=Ci(),d=An(u),f=e=>{var t=Js(),a=G(t),o=G(a),u=K(o,2),d=G(u),f=G(d);Is(f,{class:`ic`,"aria-hidden":`true`});var p=K(f,2);R(d);var m=K(d,2),h=G(m);io(h);var g=K(h,2);Bs(G(g),{class:`ic`,"aria-hidden":`true`}),R(g),R(m),R(u);var _=K(u,2),v=K(G(_),2),y=G(v);ra(K(y,2),17,()=>n,ea,(e,t)=>{var n=Ks(),r=G(n),i=jn(K(r),!0);R(n),nr(()=>{Mi(r,`${J(t).title??``} `),Mi(i,J(t).by)}),oi(`click`,n,()=>fs.link(J(t).url,J(t).title)),wi(e,n)}),R(v),R(_);var b=K(_,2);As(G(b),{withKey:!0,id:`where-splash`}),R(b);var x=K(b,2),S=e=>{var t=qs();oi(`click`,t,()=>fs.back()),wi(e,t)};Ji(x,e=>{$.hasSong&&e(S)}),R(a),R(t),Ta(1,o,()=>cs,()=>l(0)),oi(`click`,p,s),oi(`change`,p,c),ai(`submit`,m,i),wo(h,()=>J(r),e=>un(r,e)),Ta(1,u,()=>cs,()=>l(1)),oi(`click`,y,()=>fs.demo()),Ta(1,_,()=>cs,()=>l(2)),Ta(1,b,()=>cs,()=>l(3)),Ta(2,t,()=>ss,()=>({duration:hs(160)})),wi(e,t)};Ji(d,e=>{$.splash&&e(f)}),wi(e,u),$e()}var Ks,qs,Js,Ys=e((()=>{rs(),$o(),ds(),ps(),gs(),Fs(),zs(),Us(),Ws(),Ks=bi(`<button class="song svelte-2inaju" type="button"> <span class="svelte-2inaju"> </span></button>`),qs=bi(`<button class="btn btn-small btn-quiet back svelte-2inaju" type="button">Back to the song</button>`),Js=bi(`<section class="splash svelte-2inaju" aria-labelledby="splashTitle"><div class="in svelte-2inaju"><h1 class="title svelte-2inaju" id="splashTitle" data-text="Pitchscape">Pitchscape</h1> <div class="box pick svelte-2inaju"><label class="btn btn-primary upload svelte-2inaju"><!>Upload a song <input type="file" accept="audio/*,.mp3,.m4a,.aac,.wav,.ogg,.oga,.flac,.opus" class="svelte-2inaju"/></label> <form class="link svelte-2inaju"><input type="url" inputmode="url" autocomplete="off" spellcheck="false" placeholder="or paste a link to an audio file" aria-label="Link to an audio file" class="svelte-2inaju"/> <button class="btn go svelte-2inaju" type="submit" aria-label="Open the link"><!></button></form></div> <div class="box svelte-2inaju"><h2 class="eyebrow svelte-2inaju">Or try one of ours</h2> <div class="songs svelte-2inaju"><button class="song svelte-2inaju" type="button">Demo song <span class="svelte-2inaju">made here</span></button> <!></div></div> <div><!></div> <!></div></section>`),si([`click`,`change`])}));function Xs(e,t){let n=Go(t,Zs);var r=Qs();so(r,()=>({viewBox:`0 0 24 24`,width:`1.2em`,height:`1.2em`,...n})),wi(e,r)}var Zs,Qs,$s=e((()=>{rs(),$o(),Zs=new Set([`$$slots`,`$$events`,`$$legacy`]),Qs=Si(`<svg><path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.1 2.182a10 10 0 0 1 3.8 0m0 19.636a10 10 0 0 1-3.8 0m7.509-18.097a10 10 0 0 1 2.69 2.7M2.182 13.9a10 10 0 0 1 0-3.8m18.097 7.509a10 10 0 0 1-2.7 2.69M21.818 10.1a10 10 0 0 1 0 3.8M3.721 6.391a10 10 0 0 1 2.7-2.69m-.03 16.578a10 10 0 0 1-2.69-2.7"></path></svg>`)}));function ec(e,t){let n=Go(t,tc);var r=nc();so(r,()=>({viewBox:`0 0 24 24`,width:`1.2em`,height:`1.2em`,...n})),wi(e,r)}var tc,nc,rc=e((()=>{rs(),$o(),tc=new Set([`$$slots`,`$$events`,`$$legacy`]),nc=Si(`<svg><g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><path d="m16 9l-5.5 5.5L8 12"></path></g></svg>`)}));function ic(e,t){let n=Go(t,ac);var r=oc();so(r,()=>({viewBox:`0 0 24 24`,width:`1.2em`,height:`1.2em`,...n})),wi(e,r)}var ac,oc,sc=e((()=>{rs(),$o(),ac=new Set([`$$slots`,`$$events`,`$$legacy`]),oc=Si(`<svg><path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 12a9 9 0 1 1-6.219-8.56"></path></svg>`)})),cc=e((()=>{}));function lc(e,t){Qe(t,!0);let n=kt(()=>$.status),r=kt(()=>J(n)?Math.round(J(n).p*100):0);var i=Ci(),a=An(i),o=e=>{var t=mc(),i=G(t),a=e=>{var t=uc(),r=jn(t,!0);nr(()=>Mi(r,J(n).song)),wi(e,t)};Ji(i,e=>{J(n).song&&e(a)});var o=K(i,2);Xi(o,()=>J(n).label,e=>{var t=dc(),r=jn(t,!0);nr(()=>Mi(r,J(n).label)),Ta(1,t,()=>cs,()=>({y:6,duration:hs(220)})),wi(e,t)});var s=K(o,2),c=G(s);let l;R(s);var u=K(s,2),d=G(u),f=jn(d,!0),p=jn(K(d),!0);R(u);var m=K(u,2),h=e=>{var t=pc();ra(t,21,()=>J(n).steps,e=>e.k,(e,t)=>{var n=fc(),r=G(n),i=e=>{ic(e,{class:`ic spin`,"aria-hidden":`true`})},a=e=>{ec(e,{class:`ic`,"aria-hidden":`true`})},o=e=>{Xs(e,{class:`ic`,"aria-hidden":`true`})};Ji(r,e=>{J(t).state===`now`?e(i):J(t).state?e(a,1):e(o,-1)});var s=K(r);R(n),nr(()=>{Ga(n,1,Ra(J(t).state),`svelte-1rjc52y`),Mi(s,` ${J(t).label??``}`)}),wi(e,n)}),R(t),wi(e,t)};Ji(m,e=>{J(n).steps&&e(h)}),R(t),nr(()=>{ao(s,`aria-label`,J(n).label),ao(s,`aria-valuenow`,J(r)),l=Ja(c,``,l,{width:`${J(r)??``}%`}),Mi(f,J(n).note),Mi(p,J(r)>2?J(r)+`%`:``)}),Ta(1,t,()=>cs,()=>({y:12,duration:hs(260)})),Ta(2,t,()=>ss,()=>({duration:hs(160)})),wi(e,t)};Ji(a,e=>{J(n)&&e(o)}),wi(e,i),$e()}var uc,dc,fc,pc,mc,hc=e((()=>{rs(),$o(),ds(),ps(),gs(),$s(),rc(),sc(),cc(),uc=bi(`<p class="song svelte-1rjc52y"> </p>`),dc=bi(`<p class="now svelte-1rjc52y"> </p>`),fc=bi(`<li><!> </li>`),pc=bi(`<ol class="steps svelte-1rjc52y"></ol>`),mc=bi(`<div class="status svelte-1rjc52y" role="status"><!> <!> <div class="bar svelte-1rjc52y" role="progressbar" aria-valuemin="0" aria-valuemax="100"><i class="svelte-1rjc52y"></i></div> <p class="meta svelte-1rjc52y"><span> </span><span> </span></p> <!></div>`)}));function gc(){var e=function(e){return document.getElementById(e)},t=e(`blooms`),n=e(`cv`),r=n.getContext(`2d`),i=e(`liveCv`),a=i.getContext(`2d`),o=e(`grainCv`),s=e(`sheet`),c=e(`shake`),l=e(`stripView`),u=e(`stripRow`),d=e(`head`),f=e(`fps`),p=e(`glowBass`),m=e(`glowKick`),h=e(`plate`),g=e(`player`),_=e(`play`),v=e(`seek`),y=e(`labSeek`),b=e(`tNow`),x=e(`tDur`),S=e(`msg`),C=!!(window.matchMedia&&matchMedia(`(prefers-reduced-motion: reduce)`).matches),ee=getComputedStyle(document.documentElement);function w(e,t){return ee.getPropertyValue(e).trim()||t}var T={paper:w(`--paper`,`#EEF0EA`),ink:w(`--ink`,`#23211F`),blue:w(`--blue`,`#3255A4`),pink:w(`--pink`,`#FF48B0`),purple:w(`--purple`,`#765BA7`),teal:w(`--teal`,`#00838A`),orange:w(`--orange`,`#FF6C2F`),sun:w(`--sun`,`#FFB511`),green:w(`--green`,`#00A95C`),crimson:w(`--crimson`,`#E45D50`)};function E(e,t){var n=e.replace(`#`,``);return`rgba(`+parseInt(n.slice(0,2),16)+`,`+parseInt(n.slice(2,4),16)+`,`+parseInt(n.slice(4,6),16)+`,`+t+`)`}var te=`500 9.5px "DM Mono", ui-monospace, Menlo, monospace`,D={ana:null,dur:0,name:``,key:``,kicks:[],snares:[],hats:[],toms:[],cymbals:[],segs:[],segMax:0,medHz:330,lines:[],wt:[],words:[],lineStarts:[],vis:{bass:!0,kick:!0,snare:!0,hats:!0,toms:!0,voice:!0,guitar:!0,piano:!0,synths:!0,words:!0},dirty:!0,neverPlayed:!0,previewT:0,tap:null,busy:!1,timing:null,song:``},O={get:function(e){try{return JSON.parse(localStorage.getItem(e)||`null`)}catch{return null}},set:function(e,t){try{localStorage.setItem(e,JSON.stringify(t))}catch{}},del:function(e){try{localStorage.removeItem(e)}catch{}}},ne={colour:`inst`,drums:`sound`,kick:`splat`,bass:`notes`,gline:`on`,font:`grotesque`,wordSize:`voice`,shake:C?0:.25,tilt:C?0:.5,pulse:C?0:.6,slip:C?0:.35,secs:0,ink:1,weight:1,grain:.5,thick:`thin`,edges:1,guides:`on`,fps:`off`,res:2,vConf:.45,vFloor:.04,vRun:90,bFloor:.08,hold:.3,noteMin:100,drumK:1,leap:4,lFloor:.3,exDb:7,attack:6,nShare:24,nGate:.06,nJag:4,sShare:12,gConf:.21},re=2,ie=O.get(`pitchscape:lab`),k=Object.assign({},ne,ie&&ie.v===re?ie.set:{});k.kick===`smudge`&&(k.kick=`splat`);function ae(){var e={};for(var t in k)k[t]!==ne[t]&&(e[t]=k[t]);O.set(`pitchscape:lab`,{v:re,set:e})}var oe=null;function A(e,t){S.textContent=e||``,S.classList.toggle(`err`,!!t),clearTimeout(oe),e&&!t&&(oe=setTimeout(function(){S.textContent===e&&(S.textContent=``)},4e3))}function se(e){e=Math.max(0,e||0);var t=Math.floor(e/60),n=Math.floor(e%60);return t+`:`+(n<10?`0`:``)+n}function j(e,t,n){return e<t?t:e>n?n:e}function M(e){return e|=0,e=Math.imul(e^e>>>16,73244475),e=Math.imul(e^e>>>16,73244475),e^=e>>>16,(e>>>0)/4294967296}function ce(e,t,n){for(var r=0,i=e.length;r<i;){var a=r+i>>1;e[a][n]<t?r=a+1:i=a}return r}var le=0,N=0,P=1,ue=0,F=4.2,I=100,de=Math.log2(28),fe=Math.log2(1e4),L=60;function pe(e){var t=L+12,n=N-12;return n-(Math.log2(Math.max(e,20))-de)/(fe-de)*(n-t)}function me(){L=Math.round(j(N*.15,54,116)),ot=(N-L-24)/((fe-de)*12)}function he(e,t){return ue-(t-e)*I}function ge(e){return 4+3.2*Math.log2(Math.max(e,30)/30)}function _e(){P=Math.min(Rt.dpr,k.res,window.devicePixelRatio||1),le=Math.max(200,n.clientWidth),N=Math.max(200,n.clientHeight),n.width=i.width=Math.round(le*P),n.height=i.height=Math.round(N*P),zt=null,F=k.secs>0?k.secs:le<520?4.2:le<900?5.5:7,me(),ue=Math.round(le*(le<520?.82:.86)),I=ue/F,d.style.left=ue-4.5+`px`,ve(),Ae(),Oe={},En(),D.dirty=!0,Rn&&ei()}function ve(){var e=o;e.width=n.width,e.height=n.height;for(var t=e.getContext(`2d`),r=t.createImageData(e.width,e.height),i=r.data,a=0;a<i.length;a+=4){var s=Math.random();s<.055&&(i[a]=i[a+1]=i[a+2]=255,i[a+3]=70+s*2e3)}t.putImageData(r,0,0)}function ye(e){D.ana=e,D.dur=e.dur;var t=e.evW,n=e.events,r;for(D.hits=[],r=0;r+t<=n.length;r+=t){var i={t:n[r],k:n[r+1],s:n[r+2],hz:n[r+3],d:n[r+4],p:n.subarray(r+5,r+5+16),mg:n[r+t-1],id:r/t};i.br=dt(i.p),i.mhz=ft(i.k,i),D.hits.push(i)}D.segs=[],D.bends=e.bends,D.holds=e.holds;var a=e.segW,o=e.segs;for(r=0;r+a<=o.length;r+=a)D.segs.push({t0:o[r],t1:o[r+1],m:o[r+2],a:o[r+3],b:o[r+4],z:o[r+5],f:o[r+6],att:o[r+7],dec:o[r+8],vd:o[r+9],vr:o[r+10],h:o[r+11],src:o[r+12],ex:o[r+13],rise:o[r+14],bs:o[r+15],bn:o[r+16],ring:o[r+17],hk:o[r+18],id:r/a});e.leadHz0=e.leadHz,e.bassHz0=e.bassHz,e.leadEar=H(e.leadEar,nt(e.leadHz0)),e.bassEar=H(e.bassEar,nt(e.bassHz0)),D.noteEar=H(e.noteEar,D.segs.map(function(e){return[e.bs,e.bs+e.bn]})),D.noteLvl=e.noteLvl,D.noteNz=e.noteNz,R()}function be(e,t){var n=k.nGate>0?j((t-k.nGate)/k.nGate,0,1):1;return j(1-(1-e)*36/k.nShare,0,1)*n}var xe=[`other`,`guitar`,`piano`,`bass`];function Se(e,t){var n=D.ana.noiseShare&&D.ana.noiseShare[e];return n?n[Math.max(0,Math.min(n.length-1,t))]:0}function Ce(e){return j((e-k.lFloor)/Math.max(1e-6,1-k.lFloor),0,1)}var we=0;function R(){var e=D.ana;if(!e)return;we++;var t=e.frames,n,r,i=new Uint8Array(t),a=Math.max(1,Math.round(k.vRun/1e3/e.dt));for(n=0;n<t;n++)i[n]=+(e.leadHz0[n]>0&&e.leadP[n]>=k.vConf&&e.leadL[n]>=k.vFloor);for(n=0;n<t;)if(!i[n])n++;else{for(r=n;r<t&&i[r];)r++;r-n<a&&i.fill(0,n,r),n=r}var o=new Float32Array(t);for(n=0;n<t;n++)o[n]=i[n]?e.leadHz0[n]:0;e.leadHz=Ee(o);var s=new Float32Array(t);for(n=0;n<t;n++)s[n]=e.bassN[n]>=k.bFloor?e.bassHz0[n]:0;e.bassHz=s;var c=new Uint8Array(t);if(e.gtrHz){for(n=0;n<t;n++)c[n]=+(e.gtrHz[n]>0&&e.gtrP[n]>=k.gConf&&e.gtrL[n]>=k.vFloor);for(n=0;n<t;)if(!c[n])n++;else{for(r=n;r<t&&c[r];)r++;r-n<a&&c.fill(0,n,r),n=r}var l=new Float32Array(t);for(n=0;n<t;n++)l[n]=c[n]?e.gtrHz[n]:0;e.gtrLine=Ee(l)}else e.gtrLine=new Float32Array(t);for(e.leadJ=new Float32Array(t),e.gtrJ=new Float32Array(t),n=0;n<t;n++)e.vocalsNz&&(e.leadJ[n]=be(e.vocalsNz[n],Se(`vocals`,n))),e.guitarNz&&(e.gtrJ[n]=be(e.guitarNz[n],Se(`guitar`,n)));D.kicks=[],D.snares=[],D.hats=[],D.toms=[],D.cymbals=[];var u=[D.kicks,D.snares,D.hats,D.toms,D.cymbals];D.hits.forEach(function(e){e.mg>=k.drumK&&u[e.k].push(e)}),D.pieces=[],D.segMax=0;var d=2816/22050,f=k.noteMin/1e3,p=D.holds;D.segs.forEach(function(e){if(e.cont=e.ring>=0&&e.rise<k.attack,e.ex<k.exDb)return;var t=e.bn,n=(e.t1-e.t0)/Math.max(1,t-1),r=-1,i=-1,a=!0;function o(){var t=r===0?e.t0:e.t0+r*n,a=Math.min(e.t1,e.t0+i*n+n);a-t>=f&&(D.pieces.push({s:e,t0:t,t1:a}),a-t>D.segMax&&(D.segMax=a-t))}for(var s=0;s<t;s++)p[e.bs+s]>=k.hold?(r<0&&(r=a&&s*n<=d?0:s),i=s):r>=0&&(s-i)*n>d&&(o(),r=-1,a=!1);r>=0&&o()}),D.pieces.sort(function(e,t){return e.t0-t.t0});var m=e.dt,h={};function g(e,n,r){if(!(n<0||n>=t)){var i=h[e]||(h[e]={});(i[n]||(i[n]=[])).push(r)}}for(D.pieces.forEach(function(e){for(var t=xe[e.s.src],n=Math.round(e.t0/m)-2,r=Math.round(e.t1/m),i=n;i<=r;i++)g(t,i,e.s.m)}),n=0;n<t;n++)e.leadHz[n]>0&&g(`vocals`,n,DSP.ftom(e.leadHz[n])),e.gtrLine[n]>0&&g(`guitar`,n,DSP.ftom(e.gtrLine[n]));D.soundsAt=h;var _=[];for(n=0;n<e.leadHz.length;n+=3)e.leadHz[n]>0&&_.push(e.leadHz[n]);_.sort(function(e,t){return e-t}),D.medHz=_.length?_[_.length>>1]:330,Te(e),me()}function Te(e){for(var t=[],n=0;n<e.bassHz.length;n+=2)e.bassHz[n]>0&&t.push(e.bassHz[n]);for(n=0;n<e.leadHz.length;n+=2)e.leadHz[n]>0&&t.push(e.leadHz[n]);if(D.pieces.forEach(function(n){for(var r=DSP.mtof(n.s.m),i=Math.max(1,Math.round((n.t1-n.t0)/(2*e.dt)));i>0;i--)t.push(r)}),t.length<50)de=Math.log2(28),fe=Math.log2(1e4);else{t.sort(function(e,t){return e-t});var r=Math.log2(t[Math.floor(t.length*.01)])-.25,i=Math.log2(t[Math.floor(t.length*.995)])+.33;if(i-r<3){var a=(i+r)/2;r=a-1.5,i=a+1.5}de=Math.max(Math.log2(24),r),fe=Math.min(Math.log2(9e3),i)}}function Ee(e){for(var t=e.slice(),n=1;n<e.length-1;n++){var r=e[n-1],i=e[n],a=e[n+1];if(r>0&&i>0&&a>0){var o=12*Math.log2(i/r),s=12*Math.log2(i/a);Math.abs(o)>.8&&Math.abs(s)>.8&&o*s>0&&Math.abs(12*Math.log2(r/a))<.6&&(t[n]=Math.sqrt(r*a))}}return t}function De(e,t,n){for(var r=0,i=ce(e,t-.6,`t`);i<e.length&&e[i].t<=t;i++)r+=e[i].s*Math.exp(-(t-e[i].t)*n);return Math.min(1.3,r)}function z(e){for(var t=D.ana,n=Math.round(e/t.dt),r=-1,i=0,a=0;a<=11;a++){var o=n+a;o<t.frames&&t.leadHz[o]>0&&t.leadN[o]>i&&(i=t.leadN[o],r=o)}if(r>=0)return r;for(a=1;a<=4;a++)if(n-a>=0&&t.leadHz[n-a]>0)return n-a;return-1}var B=[`#E4413A`,`#FF6C2F`,`#FFB511`,`#C2B21A`,`#6DB33F`,`#00A95C`,`#00838A`,`#0078BF`,`#3255A4`,`#765BA7`,`#B44C97`,`#FF48B0`],V=[],Oe={};function ke(e){return e=e.replace(`#`,``),[parseInt(e.slice(0,2),16),parseInt(e.slice(2,4),16),parseInt(e.slice(4,6),16)]}function Ae(){var e=[T.blue,T.teal,T.green,T.sun,T.orange,T.pink].map(ke);V=[];for(var t=0;t<96;t++){var n=t/95*(e.length-1),r=Math.min(e.length-2,Math.floor(n)),i=n-r,a=[0,1,2].map(function(t){return Math.round(e[r][t]+(e[r+1][t]-e[r][t])*i)});V.push(`#`+a.map(function(e){return(e<16?`0`:``)+e.toString(16)}).join(``))}}function je(e){return V[Math.round(j((N-12-e)/Math.max(1,N-28),0,1)*95)]||T.ink}var Me={voice:`#FF48B0`,words:`#914E72`,guitar:`#FF6C2F`,piano:`#FFB511`,lead:`#00838A`,pluck:`#009DA5`,pad:`#82D8D5`,bass:`#3255A4`,drum:`#23211F`};function Ne(e,t,n){return k.colour===`height`?je(n??pe(t||1e3)):k.colour===`note`&&e!==`drum`&&t>0?B[(Math.round(DSP.ftom(t))%12+12)%12*7%12]:Me[e]}function Pe(e){return Math.min(1,e*k.ink)}function Fe(e,t,n){var r=e-Math.floor(e),i=(1-t)*Math.sin(6.2832*e)*.55+t*(2*r-1);return n?i*(1-n)+n*(r<.5?.75:-.75):i}var Ie={};function Le(e){var t=Ie[e];if(!t){var n=e.replace(`#`,``);t=Ie[e]=`rgba(`+parseInt(n.slice(0,2),16)+`,`+parseInt(n.slice(2,4),16)+`,`+parseInt(n.slice(4,6),16)+`,`}return t}function Re(e,t,n){var r=j((n-e)/(t-e),0,1);return r*r*(3-2*r)}function ze(e,t,n,i,a,o){var s=e.length;if(s<2)return null;var c=[],l=[],u=[],d=[],f=[],p=[],m=[],h=[],g=[],_=[],v=[],y,b,x=12,S=e[0].t,C=(e[s-1].t-S)*I;function ee(e){if(a===`square`)return 1;var t=a===`blunt`?1:e/x;return i||(t=Math.min(t,(C-e)/x)),j(t,0,1)}var w=[],T=[];for(y=0;y<s-1;y++){var E=e[y],te=e[y+1],D=(E.t-S)*I,O=(te.t-S)*I,ne=Math.max(1,Math.ceil(Math.abs(O-D)/1.6));for(b=0;b<ne;b++){var re=b/ne,ie=E.t+(te.t-E.t)*re,ae=D+(O-D)*re,oe=ee(ae);c.push(ae),l.push(E.y+(te.y-E.y)*re),u.push(ie),_.push(oe),w.push(y),T.push(re),d.push((E.a+(te.a-E.a)*re)*oe),f.push(E.c||t),p.push(E.b+(te.b-E.b)*re),m.push(E.z+(te.z-E.z)*re),h.push(ie*E.r),g.push(E.q),v.push(E.j==null?-1:E.j+((te.j==null?E.j:te.j)-E.j)*re)}}var A=e[s-1],se=i||a===`square`?1:0;c.push(C),l.push(A.y),u.push(A.t),_.push(-1),w.push(s-1),T.push(0),d.push(A.a*se),f.push(A.c||t),p.push(A.b),m.push(0),h.push(A.t*A.r),g.push(A.q),v.push(A.j==null?-1:A.j);var ce=c.length,le=ce-1,N,P=c[le];if(P<1)N=Le(f[0])+d[0].toFixed(3)+`)`;else{N=r.createLinearGradient(0,0,P,0);var ue=Math.max(1,Math.floor(ce/Math.max(56,Math.ceil(P/7))));for(y=0;y<ce;y+=ue)N.addColorStop(j(c[y]/P,0,1),Le(f[y])+d[y].toFixed(3)+`)`);N.addColorStop(1,Le(f[le])+d[le].toFixed(3)+`)`)}function F(e,t,n){return t>=0?e.e[2*t+n]:n?e.wu==null?e.w:e.wu:e.wd==null?e.w:e.wd}var de={t0:S,fill:N,prints:[]};return o.forEach(function(t){var r=new Path2D,i=null,a=[],o=[],f=t.s;for(y=0;y<ce;y++){var b=e[w[y]],x=e[Math.min(s-1,w[y]+1)],S=T[y],C=_[y],ee=C<0?f*(.3+.7*se):f*(.3+.7*Math.sqrt(C)),E=(F(b,t.band,1)+(F(x,t.band,1)-F(b,t.band,1))*S)*ee*k.weight,te=(F(b,t.band,0)+(F(x,t.band,0)-F(b,t.band,0))*S)*ee*k.weight,D=v[y]>=0?v[y]*Math.max(.3,C<0?se:Math.sqrt(C)):(E+te)/2*(.03+.8*Math.max(p[y],.3*(g[y]||0))),O=c[y],ne=l[y];if(y?r.lineTo(O,ne-E-D*Fe(h[y],p[y],g[y])):r.moveTo(O,ne-E-D*Fe(h[y],p[y],g[y])),a.push(O),o.push(ne+te+D*Fe(h[y]+.41,p[y],g[y])),v[y]>=0){var re=.15+.85*M(Math.round(u[y]*300)+n);if(C>=0&&f===1&&m[y]>re&&d[y]>.02){var ie=2*ot*Math.sqrt(2*Math.log(m[y]/re))+(E+te)/2;i||=new Path2D,i.rect(O-.45,ne-ie,.9,2*ie)}}else if(C>=0&&m[y]>.02&&f===1&&d[y]>.05){var ae=Math.round(u[y]*300)+n;if(M(ae)<m[y]*.55){var oe=.45+M(ae+29)*1.05,A=O+(M(ae+7)-.5)*2,j=ne+(M(ae+13)*2-1)*(E+te)/2/k.weight*1.6;i||=new Path2D,i.moveTo(A+oe,j),i.arc(A,j,oe,0,6.2832)}}}for(y=ce-1;y>=0;y--)r.lineTo(a[y],o[y]);r.closePath(),de.prints.push({a:t.a,path:r,dots:i})}),de}function Be(e,t){if(e){var n=he(e.t0,t);r.translate(n,0),r.fillStyle=e.fill;for(var i=0;i<e.prints.length;i++){var a=e.prints[i];r.globalAlpha=Pe(a.a),r.fill(a.path),a.dots&&r.fill(a.dots)}r.translate(-n,0),r.globalAlpha=1}}var Ve=new Map,He=``,Ue=0,We=0;function Ge(){var e=le+`|`+N+`|`+P+`|`+de+`|`+fe+`|`+L+`|`+we+`|`+JSON.stringify(k);e!==He&&(He=e,Ve.clear(),Ue++),++We%120==0&&Ve.forEach(function(e,t){e.used<We-2&&Ve.delete(t)})}function Ke(e,t){var n=Ve.get(e);return n||(n={st:t()},Ve.set(e,n)),n.used=We,n.st}function qe(e){for(var t=[],n=2;n>=0;n--)n>0&&!(k.edges>0)||t.push({a:e*(n===0?1:rt[n]*k.edges),s:1,band:n});return t}function Je(e,t,n,i){i<=.03||(r.globalAlpha=Pe(.95*i),r.fillStyle=n,r.beginPath(),r.arc(ue,e,t*k.weight+1.6,0,6.2832),r.fill())}var Ye={},Xe=null,Ze=null;function Qe(e){var t=Ye[e];if(t)return t;t=document.createElement(`canvas`),t.width=t.height=64;var n=t.getContext(`2d`),r=n.createRadialGradient(32,32,0,32,32,32);return r.addColorStop(0,E(e,1)),r.addColorStop(.35,E(e,.7)),r.addColorStop(.7,E(e,.22)),r.addColorStop(1,E(e,0)),n.fillStyle=r,n.fillRect(0,0,64,64),Ye[e]=t,t}function $e(e,t,i){var a=r.canvas.width,o=r.canvas.height;(!Xe||Xe.width<a||Xe.height<o)&&(Xe=document.createElement(`canvas`),Xe.width=Math.max(a,n.width),Xe.height=Math.max(o,n.height),Ze=Xe.getContext(`2d`));var s=Ze,c,l,u=1/0,d=1/0,f=-1/0,p=-1/0,m=r.getTransform();if(s.setTransform(m),e.forEach(function(e){for(c=0;c<e.length-1;c++){var n=e[c],r=e[c+1],a=he(n.t,t),o=he(r.t,t),m=Math.max(1,Math.ceil(Math.abs(o-a)/2));for(l=0;l<m;l++){var h=l/m,g=n.a+(r.a-n.a)*h;if(!(g<.02)){var _=a+(o-a)*h,v=n.y+(r.y-n.y)*h,y;if(n.e){var b=n.e[3]+(r.e[3]-n.e[3])*h,x=n.e[2]+(r.e[2]-n.e[2])*h;v+=(x-b)/2,y=Math.max(1.5,(b+x)/2)*k.weight}else{var S=j((n.w+(r.w-n.w)*h-.8)/8,0,1);y=(ot*1.3+1.5)*(.85+.3*S)*k.weight}_+y<qt||(s.globalAlpha=Math.min(1,i*g*3.2/y),s.drawImage(Qe(n.c),_-y,v-y,2*y,2*y),_-y<u&&(u=_-y),_+y>f&&(f=_+y),v-y<d&&(d=v-y),v+y>p&&(p=v+y))}}}}),!(f<u)){var h=1/0,g=1/0,_=-1/0,v=-1/0;[[u,d],[f,d],[u,p],[f,p]].forEach(function(e){var t=m.a*e[0]+m.c*e[1]+m.e,n=m.b*e[0]+m.d*e[1]+m.f;h=Math.min(h,t),g=Math.min(g,n),_=Math.max(_,t),v=Math.max(v,n)}),h=Math.max(0,Math.floor(h)-2),g=Math.max(0,Math.floor(g)-2),_=Math.ceil(_)+2,v=Math.ceil(v)+2;var y=Math.min(a,_),b=Math.min(o,v);y>h&&b>g&&(r.save(),r.setTransform(1,0,0,1,0,0),r.globalAlpha=Math.min(1,k.ink),r.drawImage(Xe,h,g,y-h,b-g,h,g,y-h,b-g),r.restore()),s.setTransform(1,0,0,1,0,0),s.clearRect(h,g,Math.max(0,Math.min(Xe.width,_)-h),Math.max(0,Math.min(Xe.height,v)-g))}}function et(e,t,n,r,i,a,o,s,c,l){var u=D.ana,d=u.dt,f=Math.max(0,Math.floor((e-F-.3)/d)),p=Math.min(u.frames-1,Math.floor(e/d)),m=null,h=o===`bass`&&k.bass===`smudge`,g=[],_=k.thick===`ear`&&o!==`guitar`,v=_?qe(s):(c>0?[{a:c,s:1.9,band:-1}]:[]).concat([{a:s,s:1,band:-1}]);function y(e){var s=t(e),c=pe(s),l={t:e*d,y:c,w:n(e),a:r(e),b:1,j:i(e),z:a(e),r:ge(s),c:Ne(o,s,c)};return _&&(l.e=tt(o===`bass`?u.bassEar:u.leadEar,e),l.wd=l.e[2],l.wu=l.e[3]),l}function b(e,t){for(var n=[],r=e;r<=t;r++)n.push(y(r));return n}function x(e){var n=t(e),r=t(e-1);return n>0&&r>0&&!(Math.abs(12*Math.log2(n/r))>k.leap)}for(var S=f;S<=p;)if(!(t(S)>0))S++;else{var C=S;for(S++;S<=p&&x(S);S++);var ee=S-1,w=ee===p,T;h?(T=b(C,ee),T.length>1&&g.push(T),w&&(m=T[T.length-1])):w?(T=b(C,ee),m=T[T.length-1],T.length>1&&Be(ze(T,null,l,!0,void 0,v),e)):(ee>C||C===f&&C>0&&x(C))&&Be(Ke(o+`:`+ee,function(){for(var e=C;e>0&&x(e);)e--;return ze(b(e,ee),null,l,!1,void 0,v)}),e)}g.length&&$e(g,e,s),m&&(m.e?Je(m.y+(m.e[0]-m.e[1])/2,h?ot*.55+.6:Math.min(ot*.8,(m.e[0]+m.e[1])/2),m.c,m.a):Je(m.y,h?ot*.55+.6:m.w,m.c,m.a))}function tt(e,t){for(var n=t*6,r=[,,,,,,],i=0;i<6;i++)r[i]=e[n+i]*ot;return r}function H(e,t){var n=new Float32Array(e.length),r=3;return t.forEach(function(t){for(var i=t[0];i<t[1];i++)for(var a=Math.max(t[0],i-r),o=Math.min(t[1]-1,i+r),s=o-a+1,c=0;c<6;c++){for(var l=0,u=a;u<=o;u++)l+=e[u*6+c];n[i*6+c]=l/s}}),n}function nt(e){for(var t=[],n=0,r=e.length,i;n<r;)if(!(e[n]>0))n++;else{for(i=n;i<r&&e[i]>0;)i++;t.push([n,i]),n=i}return t}var rt=[1,.32,.1];function it(e,t){if(e.bn<2)return 0;var n=j((t-e.t0)/Math.max(1e-6,e.t1-e.t0),0,1)*(e.bn-1),r=Math.min(e.bn-2,Math.floor(n)),i=n-r,a=D.bends,o=e.bs+r;return a[o]+(a[o+1]-a[o])*i}function at(e,t,n){var i=D.ana,a=i.strikes&&i.strikes[t],o=D.soundsAt&&D.soundsAt[t];if(a&&o){var s=i.strikeBands,c=i.dt,l=Math.max(0,Math.floor((e-F-.2)/c)),u=Math.min(i.frames-1,Math.floor(e/c)),d=Math.max(1,Math.round(3/Math.max(.1,I*c)));r.fillStyle=Ne(n,0,0);for(var f=l-l%d;f<=u;f+=d){var p=o[f];if(p){var m=he(f*c,e);if(!(m<qt-2))for(var h=0;h<p.length;h++){var g=p[h],_=j(Math.floor((g-21)*3/24),0,s-1),v=j(Math.floor((g-25)*3/24),0,s-1),y=j(Math.floor((g-17)*3/24),0,s-1),b=j(1-(1-Math.max(a[f*s+_],a[f*s+v],a[f*s+y]))*36/k.sShare,0,1);if(!(b<.03)){var x=Math.max(L,pe(DSP.mtof(g+4))),S=pe(DSP.mtof(g-4));r.globalAlpha=Pe(b*.8),r.fillRect(m-.4,x,.8,S-x)}}}}r.globalAlpha=1}}var ot=1;function st(e,t,n,r){for(var i=e-F-.2,a=ce(D.pieces,i-D.segMax,`t0`);a<D.pieces.length;a++){var o=D.pieces[a],s=o.s;if(o.t0>e)break;if(!(o.t1<i||s.src!==n)){var c=Math.min(o.t1,e);if(!(c-o.t0<.02)){o.t1>=e&&(t[r]+=s.a*.5);var l=DSP.mtof(s.m),u=pe(l),d=o.t1>e,f=Ne(n===1?`guitar`:n===2?`piano`:n===3?`bass`:s.f===1?`pad`:s.f===2?`lead`:`pluck`,l,u);if(!d)o.stG!==Ue&&(o.stG=Ue,o.st=U(o,c,f,!1)),Be(o.st,e);else{var p=ct(o,c);Be(U(o,c,f,!0,p),e);var m=p[p.length-1];m.e?Je(m.y+(m.e[0]-m.e[1])/2,Math.min(ot*.8,(m.e[0]+m.e[1])/2),f,m.a):Je(m.y,m.w,f,m.a)}}}}}function U(e,t,n,r,i){var a=e.s,o=k.thick===`ear`?qe(.82):k.thick===`thin`?[{a:.9,s:1,band:-1}]:a.f===1?[{a:.12,s:1.45,band:-1},{a:.78,s:1,band:-1}]:[{a:a.f===0?.85:.82,s:1,band:-1}],s=a.cont&&e.t0-a.t0<.05?`square`:a.f===0?`blunt`:a.f===2?`square`:void 0;return ze(i||ct(e,t),n,101+a.id*7,r,s,o)}function ct(e,t){for(var n=e.s,r=ge(DSP.mtof(n.m)),i=Math.min(1,n.a),a=[],o=xe[n.src],s=k.thick===`thin`,c=n.h>.5?j((n.h-.5)*2.5,0,1):0,l=e.t0;;l+=D.ana.dt){var u=Math.min(l,t),d=u-n.t0,f=pe(DSP.mtof(n.m+it(n,u))),p,m;if(n.f===0){var h=10**(Math.max(-80,Math.min(0,n.dec))*d/20);p=(1.2+4.6*n.a)*1.3*(.22+.78*h**.7)*Math.min(1,d/.012+.6),m=(.5+.5*i)*(.35+.65*h)}else if(n.f===1){var g=Math.max(.08,n.att);p=(1+4.2*n.a)*1.6*(.04+.96*Re(0,g,d))*Math.min(1,(e.t1-u)/.25+.25),m=(.45+.55*i)*(.3+.7*Re(0,g,d))}else p=(1+4.2*n.a)*1.15*Math.min(1,(u-e.t0)/.02+.5),m=.5+.5*i;var _=n.bs+Math.round((u-n.t0)/Math.max(1e-6,n.t1-n.t0)*(n.bn-1));D.noteLvl&&(m=Ce(D.noteLvl[_]),s&&(p=ot*(.15+.2*m)+.55));var v=D.noteNz?be(D.noteNz[_],Se(o,Math.round(u/D.ana.dt))):0,y={t:u,y:f,w:p,a:m,b:1,j:v*k.nJag/3*ot,z:v,r,q:c};if(k.thick===`ear`&&(y.e=tt(D.noteEar,n.bs+Math.round((u-n.t0)/Math.max(1e-6,n.t1-n.t0)*(n.bn-1)))),a.push(y),u>=t)break}return a}var lt=DSP.DRUM_BANDS,ut=new Float32Array(36);function dt(e){if(!e)return .5;for(var t=0,n=0,r=0;r<e.length;r++){var i=e[r]*e[r];n+=i,lt[r]>=2500&&(t+=i)}return n>0?t/n:.5}function ft(e,t){if(e===0)return j(t.hz||52,30,180);if(e===3&&t.p){for(var n=-1,r=0;r<t.p.length;r++)lt[r]>=55&&lt[r+1]<=760&&(n<0||t.p[r]>t.p[n])&&(n=r);if(n>=0)return Math.sqrt(lt[n]*lt[n+1])}var i=e===1?[350,4e3]:e===3?[60,800]:[2200,9500];return j(t.hz||i[0],i[0],i[1])}function pt(e,t,n){for(var r=ce(e,t-F-1.2,`t`);r<e.length&&e[r].t<=t;r++)ht(e[r],t,n)}function mt(e,t){if(t===`tom`)return j(pe(e.mhz),L+12,N-12);var n=L-12;return 8+n*(t===`cymbal`?.2:t===`hat`?.5:.8)-(k.drums===`sound`?(e.br-.5)*n*.2:0)}function ht(e,t,n){var i=he(e.t,t),a=mt(e,n),o=t-e.t,s=o<.05?.55+.45*o/.05:1,c=k.drums===`sound`,l=c?e.br:.35,u=e.id*977+n.length*131,d=c&&(n===`hat`||n===`cymbal`)?e.d*I:0;i+d+30<qt||(r.fillStyle=Ne(`drum`,e.mhz,a),r.beginPath(),n===`snare`?gt(i,a,(3.2+4.2*e.s)*s,l,e.s,u):n===`tom`?_t(i,a,(2.8+3.6*e.s)*s,u):vt(i,a,e.s,s,d,Math.min(o,e.d)*I,n===`cymbal`,u),r.globalAlpha=Pe(n===`snare`||n===`tom`?.92:.9),r.fill())}function gt(e,t,n,i,a,o){var s=ut.length,c,l,u=3+Math.round(6*i);for(c=0;c<s;c++)ut[c]=n*(.84+.3*M(o+c));for(c=0;c<u;c++)ut[Math.floor(M(o+50+c)*s)]=n*(1.45+(.7+1.6*i)*M(o+80+c));for(c=0;c<s;c++)l=c/s*6.2832,c?r.lineTo(e+Math.cos(l)*ut[c],t+Math.sin(l)*ut[c]):r.moveTo(e+ut[0],t);for(r.closePath(),c=0;c<2+Math.round(2*a+2*i);c++)yt(e,t,M(o+120+c)*6.2832,n*(2+1.4*M(o+140+c)),n*(.12+.16*M(o+160+c)))}function _t(e,t,n,i){for(var a=18,o=0,s,c;o<a;o++)s=o/a*6.2832,c=n*(.92+.16*M(i+o)),o?r.lineTo(e+Math.cos(s)*c,t+Math.sin(s)*c):r.moveTo(e+c,t);for(r.closePath(),o=0;o<2;o++)yt(e,t,M(i+40+o)*6.2832,n*(1.5+.7*M(i+60+o)),n*(.14+.12*M(i+80+o)))}function vt(e,t,n,r,i,a,o,s){var c=o?14+Math.round(16*n):6+Math.round(6*n),l=(o?6.5+8*n:4+4.5*n)*r,u=l*(o?.75:.9),d,f;for(yt(e,t,0,0,(o?1.1:1.9+1.2*n)*r),d=0;d<c;d++){f=Math.sqrt(M(s+30+d));var p=M(s+d)*6.2832;yt(e+Math.cos(p)*f*l,t+Math.sin(p)*f*u,0,0,(o?.6+.9*M(s+60+d):.8+1.1*M(s+60+d))*r)}if(i>2){var m=Math.min(28,Math.round(i/(o?2.5:3.5)));for(d=0;d<m;d++){var h=(d+M(s+200+d))/m;h*i>a||yt(e+h*i,t+(M(s+230+d)-.5)*u*(o?2.4:1.6)*(1-.5*h),0,0,(o?1:1.2)*(1-.55*h))}}}function yt(e,t,n,i,a){var o=e+Math.cos(n)*i,s=t+Math.sin(n)*i;r.moveTo(o+a,s),r.arc(o,s,a,0,6.2832)}function bt(e,t){var n=e+`|`+t;if(Oe[n])return Oe[n];var r=Math.ceil(2*t*P)+2,i=document.createElement(`canvas`);i.width=i.height=r;var a=i.getContext(`2d`),o=r/2,s=4.2*P,c=Math.SQRT1_2,l=Math.ceil(t*P/s)+2,u=t*P,d=Math.exp(-2.6);a.fillStyle=e,a.beginPath();for(var f=-l;f<=l;f++)for(var p=-l;p<=l;p++){var m=o+(f-p)*c*s,h=o+(f+p)*c*s,g=Math.sqrt((m-o)*(m-o)+(h-o)*(h-o))/u;if(!(g>=1)){var _=(Math.exp(-g*g*2.6)-d)/(1-d),v=s*.6*Math.sqrt(_);v<.3||(a.moveTo(m+v,h),a.arc(m,h,v,0,6.2832))}}return a.fill(),Oe[n]=i,i}function xt(e){for(var t=ce(D.kicks,e-F-.4,`t`);t<D.kicks.length&&D.kicks[t].t<=e;t++)Tt(D.kicks[t],e)}function St(e){return(10+19*e.s)*(1+.4*j(e.d/.25,0,1))}function Ct(e){return j(pe(e.mhz),L+12,N-10)}var wt=!0;function Tt(e,t){var n=e.mhz,i=he(e.t,t),a=Ct(e),o=t-e.t,s=e.s,c=Ne(`drum`,n,a),l=St(e),u=l,d;if(k.kick===`halftone`){var f=Math.max(8,Math.round(l/4)*4);r.globalAlpha=Pe(.36+.34*s),r.drawImage(bt(c,f),i-u,a-u,2*u,2*u)}else r.fillStyle=c,r.beginPath(),gt(i,a,u*.42,.15,s,e.id*977+7),r.globalAlpha=Pe(.38+.3*s),r.fill();if(o<.45&&wt){var p=o/.45,m=l*(1.5+2.4*p);d=r.createRadialGradient(i,a,l*.4,i,a,m),d.addColorStop(0,E(c,Pe(.2*s*(1-p)*(1-p)))),d.addColorStop(1,E(c,0)),r.globalAlpha=1,r.fillStyle=d,r.beginPath(),r.arc(i,a,m,0,6.2832),r.fill()}}function Et(e){if(D.words.length){r.textBaseline=`alphabetic`;for(var t=ce(D.words,e-F-.8,`t`);t<D.words.length&&D.words[t].t<=e;t++){var n=D.words[t],i=he(n.t,e);if(!(i+n.px<-4)){var a=e-n.t,o=a<.09?a/.09:1,s=n.yy;if(r.font=n.font,r.fillStyle=Ne(`words`,n.hz,s),r.globalAlpha=Pe(.4+.58*o),o<1){r.save(),r.translate(i,s);var c=1.25-.25*o;r.scale(c,c),r.fillText(n.text,0,0),r.restore()}else r.fillText(n.text,i,s)}}}}function Dt(){if(k.guides!==`off`){r.globalCompositeOperation=`source-over`,r.globalAlpha=1,r.lineWidth=1,r.font=te,r.textBaseline=`bottom`;for(var e=1;e<=8;e++){var t=440*2**((12*(e+1)-69)/12),n=Math.round(pe(t))+.5;n<L+22||n>N-4||(r.strokeStyle=`rgba(35,33,31,0.075)`,r.beginPath(),r.moveTo(0,n),r.lineTo(le,n),r.stroke(),r.fillStyle=`rgba(35,33,31,0.42)`,r.fillText(`C`+e+` `+Math.round(t),6,n-2))}var i=L+4.5;r.strokeStyle=`rgba(35,33,31,0.09)`,r.setLineDash([1,5]),r.beginPath(),r.moveTo(0,i),r.lineTo(le,i),r.stroke(),r.setLineDash([])}}var Ot={guitar:[.8,-.6],synths:[-.4,.75],piano:[.65,.45],bass:[-.9,.3],voice:[.5,.85],hats:[-.3,-.95],toms:[.7,-.3],snare:[.95,.2],kick:[-.6,-.7],words:[.25,.6]},kt={};document.querySelectorAll(`.ink`).forEach(function(e){kt[e.dataset.layer||e.dataset.toggle]={el:e,v:-1}});function At(e,t){var n=kt[e];n&&(t=Math.round(j(t,0,1)*20)/20,t!==n.v&&(n.v=t,n.el.style.setProperty(`--lvl`,t)))}var jt=/[?&]bench\b/.test(location.search)?{}:null,Mt=`paint`,Nt=/[?&]live\b/.test(location.search);function Pt(){Mt===`paint`&&r.getImageData(0,0,1,1)}function Ft(e,t){Pt();var n=performance.now();t(),Pt(),(jt[e]=jt[e]||[]).push(performance.now()-n)}jt&&(window.pitchscapeReady=function(){return!!D.ana}),jt&&(window.pitchscapeStrips=function(){var e={};return Ut.forEach(function(t,n){e[n]=t.done}),{strips:e,pps:I,nowX:ue,W:le}}),jt&&(window.pitchscapeBench=function(e,t){for(var n in Mt=t||`paint`,jt)delete jt[n];var r=[];function i(){jt.frame=r;var e={};for(var t in jt){var n=jt[t].slice().sort(function(e,t){return e-t});e[t]={med:n[n.length>>1],p95:n[Math.min(n.length-1,Math.floor(n.length*.95))],n:n.length}}return e}return Mt===`raf`?new Promise(function(t){var n=0,a=0;(function o(s){if(n>0&&r.push(s-a),a=s,n>=e.length)return r.shift(),t(i());xn(e[n++]),requestAnimationFrame(o)})(performance.now())}):(e.forEach(function(e){Pt();var t=performance.now();xn(e),Pt(),r.push(performance.now()-t)}),Promise.resolve(i()))});var It=[[`synths`,function(e,t){st(e,t,0,`synths`),at(e,`other`,`lead`)}],[`piano`,function(e,t){st(e,t,2,`piano`),at(e,`piano`,`piano`)}],[`guitar`,function(e,t){var n=D.ana;st(e,t,1,`guitar`),k.gline===`on`&&n.gtrLine&&et(e,function(e){return n.gtrLine[e]},function(e){return ot*(.15+.2*Ce(n.guitarLvl?n.guitarLvl[e]:1))+.55},function(e){return n.guitarLvl?Ce(n.guitarLvl[e]):.8},function(e){return n.gtrJ[e]*k.nJag/3*ot},function(e){return n.gtrJ[e]},`guitar`,.9,0,53),at(e,`guitar`,`guitar`)}],[`bass`,function(e,t){var n=D.ana;k.bass===`notes`?st(e,t,3,`bass`):et(e,function(e){return n.bassHz[e]},function(e){return .8+12*n.bassN[e]},function(e){return Re(.015,.3,n.bassN[e])},function(){return 0},function(){return 0},`bass`,.86,.15,11),at(e,`bass`,`bass`)}],[`voice`,function(e){var t=D.ana,n=k.thick===`thin`;et(e,function(e){return t.leadHz[e]},function(e){return n?ot*(.15+.2*Ce(t.vocalsLvl?t.vocalsLvl[e]:1))+.7:.8+8.5*t.leadN[e]},function(e){return n&&t.vocalsLvl?Ce(t.vocalsLvl[e]):Re(.02,.4,t.leadN[e])},function(e){return t.leadJ[e]*k.nJag/3*ot},function(e){return t.leadJ[e]},`voice`,.9,n?0:.16,37),at(e,`vocals`,`voice`)}],[`hats`,function(e){pt(D.hats,e,`hat`),pt(D.cymbals,e,`cymbal`)}],[`toms`,function(e){pt(D.toms,e,`tom`)}],[`snare`,function(e){pt(D.snares,e,`snare`)}],[`kick`,function(e){xt(e)}],[`words`,function(e){Et(e)}]],Lt={blend:!0,grain:!0,glows:!0,tilt:!0,shake:!0,live:!1,still:!1,dpr:3,narrow:!0,nolive:!1,nostrips:!1,strip:1024},Rt=Object.assign({},Lt),zt=null,Bt=1024,Vt=128,Ht=Bt/Vt,Ut=new Map,Wt=``,Gt=null,Kt=[],qt=-1/0,W={kick:0,words:.15,hats:.1,toms:.1,snare:.1},Jt={kick:60,bass:40},Yt={words:3,hats:2.5};function Xt(e){return Yt[e]||.3}function Zt(e){return(e in W?W[e]:.05)+(Jt[e]||30)/I}function Qt(){return It.filter(function(e){return D.vis[e[0]]})}function $t(e){var t=0;return e.forEach(function(e){t=Math.max(t,Zt(e[0]))}),t}function en(){var e=Ue+`|`+I+`|`+JSON.stringify(D.vis);(e!==Wt||Gt!==D.ana)&&(Ut.forEach(function(e){tn(e)}),Ut.clear(),Wt=e,Gt=D.ana)}function tn(e){e.c.parentNode&&e.c.parentNode.removeChild(e.c),Kt.length<3&&Kt.push(e.c)}function nn(e){var t=Ut.get(e);if(t)return t;for(var n=Math.ceil(Bt*P),r=Math.ceil(N*P),i=null,a=Kt.length-1;a>=0;a--)if(Kt[a].width===n&&Kt[a].height===r){i=Kt.splice(a,1)[0];break}if(!i)i=document.createElement(`canvas`),i.width=n,i.height=r;else{var o=i.getContext(`2d`);o.setTransform(1,0,0,1,0,0),o.globalCompositeOperation=`source-over`,o.clearRect(0,0,n,r)}return i.style.left=e*Bt+`px`,i.style.width=Bt+`px`,u.appendChild(i),t={c:i,done:0},Ut.set(e,t),t}function rn(e){var t=Ut.get(Math.floor(e/Ht));return!!t&&t.done>e%Ht}function an(e,t,n){var i=nn(e),a=i.done,o=e*Bt/I,s=o+a*Vt/I,c=s+Vt/I+n,l=i.c.getContext(`2d`),u=[r,ue,F];r=l,ue=(c-o)*I,l.save();try{l.setTransform(P,0,0,P,0,0),l.beginPath(),l.rect(a*Vt,0,Vt,N),l.clip(),l.globalCompositeOperation=`multiply`,t.forEach(function(e){F=c-s+Xt(e[0]),e[1](c,{guitar:0,piano:0,synths:0})})}finally{l.restore(),r=u[0],ue=u[1],F=u[2]}i.done++}var on=[];function sn(e){var n=0;if(D.vis.kick)for(var r=ce(D.kicks,e-.45,`t`);r<D.kicks.length&&D.kicks[r].t<=e;r++){var i=D.kicks[r],a=(e-i.t)/.45,o=St(i),s=o*(1.5+2.4*a),c=Ct(i),l=he(i.t,e),u=Ne(`drum`,i.mhz,c),d=Pe(.2*i.s*(1-a)*(1-a)),f=on[n]||(on[n]=t.appendChild(document.createElement(`div`)));f.style.display=``,f.style.width=f.style.height=2*s+`px`,f.style.transform=`translate(`+(l-s).toFixed(1)+`px,`+(c-s).toFixed(1)+`px)`,f.style.background=`radial-gradient(circle closest-side, `+E(u,d)+` 0, `+E(u,d)+` `+(40*o/s).toFixed(1)+`%, `+E(u,0)+` 100%)`,n++}for(;n<on.length;n++)on[n].style.display!==`none`&&(on[n].style.display=`none`)}var cn=null,ln=null;function un(e,t){var n=$t(t),r=e-n,i=Math.max(0,e-(ue+40)/I),a=Vt/I,o=Math.floor(i/a),s=Math.floor(r/a),c=s+Ht/2,d,f,p=performance.now();for(d=o;d<=c;d++)if(!rn(d)){if(performance.now()-p>4)break;for(f=Math.floor(d/Ht);nn(f).done<=d%Ht&&performance.now()-p<=4;)an(f,t,n)}var m=i;for(d=o;d<=s&&rn(d);d++)m=Math.min(r,(d+1)*a);var h=Math.round(he(0,e)*P)/P,g=m>i?Math.max(0,Math.round(he(m,e)*P)/P):0;h!==cn&&(cn=h,u.style.transform=`translateX(`+h+`px)`),g!==ln&&(ln=g,l.style.width=g+`px`);var _=Math.floor(o/Ht),v=Math.floor(c/Ht);return Ut.forEach(function(e,t){(t<_||t>v)&&(Ut.delete(t),tn(e))}),m}var dn=``,fn=``,pn=[``,``],mn=[-1,-1],hn=-1,gn=null,_n=null,vn=null;function yn(e,t,n,r){r=Math.round(r*200)/200,r!==mn[t]&&(mn[t]=r,e.style.visibility=r>0?`visible`:`hidden`,r>0&&(e.style.opacity=String(r))),r>0&&n!==pn[t]&&(pn[t]=n,e.style.background=`linear-gradient(to top, `+E(n,1)+` 0, `+E(n,1)+` 30px, `+E(n,0)+` 100%)`)}function bn(){r.setTransform(P,0,0,P,0,0),r.globalCompositeOperation=`source-over`,r.globalAlpha=1,r.fillStyle=T.paper,r.fillRect(0,0,le,N),Dt()}function xn(e){var t=D.ana,n=Rt.grain?k.grain:0;if(n!==hn&&(hn=n,o.style.opacity=String(n),o.style.display=n>0?``:`none`),!t)bn(),gn=null,Sn(!0),yn(p,0,``,0),yn(m,1,``,0),fn&&(fn=``,c.style.transform=``),dn&&(dn=``,s.style.transform=``);else{Ge();var l=j(Math.floor(e/t.dt),0,t.frames-1),u=t.bassN[l]||0,d=De(D.kicks,e,14),f=De(D.snares,e,18),h=De(D.hats,e,22),g={guitar:0,piano:0,synths:0},_=(Rt.shake?k.shake:0)*((D.vis.bass?u*u*5:0)+(D.vis.kick?d*9:0)+(D.vis.snare?f*2:0)),v=_*(Math.sin(e*53.1)+.7*Math.sin(e*31.7+1.3))/1.7,y=_*(Math.sin(e*47.3+2.1)+.7*Math.sin(e*29.9+.4))/1.7,b=_*.0022*Math.sin(e*37.7+.9),x=_>.01?`translate(`+v.toFixed(2)+`px,`+y.toFixed(2)+`px) rotate(`+b.toFixed(5)+`rad)`:``;x!==fn&&(fn=x,c.style.transform=x);var S=k.tilt*(9*Math.min(1,d)+3*u),C=k.tilt*1.4*u*Math.sin(e*1.3),ee=k.tilt>0&&Rt.tilt?`perspective(700px) rotateX(`+S.toFixed(2)+`deg) rotate(`+C.toFixed(2)+`deg)`:``;if(ee!==dn&&(dn=ee,s.style.transform=ee),yn(p,0,Ne(`bass`,t.bassHz[l]||55,N),Rt.glows&&D.vis.bass&&u>.05?Pe(.2*u**1.5):0),yn(m,1,Ne(`drum`,50,N),Rt.glows&&D.vis.kick&&k.pulse>0&&d>.02?Math.min(.3,.22*k.pulse*d):0),Vn()||Rt.live||jt&&Nt){Sn(!0),gn=null,wt=!0,sn(-1e9);var w=k.slip*(d*2.4+u*1.1);bn(),r.globalCompositeOperation=`multiply`,It.forEach(function(t){var n=t[0];D.vis[n]&&(r.save(),r.translate(Ot[n][0]*w,Ot[n][1]*w),jt?Ft(n,function(){t[1](e,g)}):t[1](e,g),r.restore())}),r.globalCompositeOperation=`source-over`}else{Sn(!1),wt=!1,sn(e),gn!==Ue&&(bn(),gn=Ue),en();var T=Qt(),E=e,te=F;jt?Ft(`strips`,function(){E=un(e,T)}):E=un(e,T);var O=Math.round(he(E,e)*P)/P,ne=Rt.narrow?Math.max(0,Math.floor(Math.min(O,ue-$t(T)*I)-8)):0;ne!==zt&&(zt=ne,_n=null,i.style.left=ne?ne+`px`:``,i.style.width=ne?le-ne+`px`:``,i.width=Math.round((le-ne)*P),i.height=Math.round(N*P));var re=Math.round(ne*P),ie=Math.max(0,Math.floor(Math.min(O,_n===null?0:_n)*P)-2-re);_n=O,i.style.visibility=Rt.nolive?`hidden`:``;var ae=r;r=a;try{r.setTransform(1,0,0,1,0,0),r.globalCompositeOperation=`source-over`,r.globalAlpha=1,r.clearRect(ie,0,i.width-ie,i.height),Rt.nolive&&(T=[]),r.setTransform(P,0,0,P,-re,0),r.globalCompositeOperation=`multiply`,r.save(),r.beginPath(),r.rect(O,-80,le-O+80,N+160),r.clip(),qt=O,T.forEach(function(t){F=Math.min(te,e-E+Xt(t[0])),jt?Ft(`l:`+t[0],function(){t[1](e,g)}):t[1](e,g)})}finally{F=te,qt=-1/0,r.restore(),r.globalCompositeOperation=`source-over`,r=ae}}var oe=t.leadHz[l]>0?t.leadN[l]:0,A=0;if(D.words.length){var se=ce(D.words,e-.3,`t`);se<D.words.length&&D.words[se].t<=e&&(A=1-(e-D.words[se].t)/.3)}At(`bass`,u),At(`kick`,d),At(`snare`,f),At(`hats`,h),At(`voice`,oe),At(`guitar`,g.guitar),At(`piano`,g.piano),At(`synths`,g.synths),At(`words`,A)}}function Sn(e){vn!==!e&&(vn=!e,_n=null,l.style.display=i.style.display=e?`none`:``,e||(a.setTransform(1,0,0,1,0,0),a.clearRect(0,0,i.width,i.height)))}var Cn={grotesque:{fam:`"Bricolage Grotesque", "Avenir Next", system-ui, sans-serif`,w:[420,800],sc:1,st:``},script:{fam:`"Caveat", "Segoe Print", cursive`,css:`Caveat:wght@400..700`,w:[420,700],sc:1.38,st:``},serif:{fam:`"Fraunces", Georgia, serif`,css:`Fraunces:ital,opsz,wght@1,9..144,300..900`,w:[330,860],sc:1.08,st:`italic `},mono:{fam:`"DM Mono", ui-monospace, Menlo, monospace`,w:[400,500],sc:.94,st:``}};function wn(e){var t=Cn[e]||Cn.grotesque;return t.css?(t.ready||=new Promise(function(e){var n=document.createElement(`link`);n.rel=`stylesheet`,n.href=`https://fonts.googleapis.com/css2?family=`+t.css+`&display=block`,n.onload=function(){(document.fonts?document.fonts.load(t.st+t.w[1]+` 16px `+t.fam.split(`,`)[0]):Promise.resolve()).then(e,e)},n.onerror=e,document.head.appendChild(n)}),t.ready):Promise.resolve()}function Tn(e){var t=Cn[k.font]||Cn.grotesque,n=k.wordSize===`voice`?j(e,0,1):.45,r=(k.wordSize===`voice`?10.5+9*n:13)*t.sc,i=Math.round(t.w[0]+(t.w[1]-t.w[0])*n);return{css:t.st+i+` `+r.toFixed(1)+`px `+t.fam,size:r}}function En(){if(D.words.length&&D.ana&&N){r.save(),r.setTransform(1,0,0,1,0,0);var e=[],t=pe(D.medHz)-16,n=D.medHz;D.words.forEach(function(i){var a=z(i.t),o=Tn(a>=0?D.ana.leadN[a]:.35);i.font=o.css,i.lh=o.size+1,r.font=i.font;var s=r.measureText(i.text);i.px=s.width,i.asc=s.actualBoundingBoxAscent||o.size*.75,i.desc=s.actualBoundingBoxDescent||o.size*.22,a>=0?(i.hz=D.ana.leadHz[a],i.y=pe(i.hz)-(.8+8.5*D.ana.leadN[a])*k.weight-5,t=i.y,n=i.hz):(i.y=t,i.hz=n);var c=L+6,l=N-8;i.y=j(i.y,c+i.asc,l-i.desc);var u=i.t*I,d=u+i.px,f=Math.max(6,i.lh*.55),p,m;function h(t){for(var n=e.length-1;n>=0;n--){var r=e[n];if(r.X0<u-600)break;if(r.X1+4>u&&r.X0<d+4&&r.top<t+i.desc+1&&r.bot>t-i.asc-1)return!0}return!1}var g=[];for(p=i.y;p-i.asc>=c;p-=f)g.push(p);for(p=i.y+f;p+i.desc<=l;p+=f)g.push(p);for(i.yy=i.y,m=0;m<g.length;m++)if(!h(g[m])){i.yy=g[m];break}e.push({X0:u,X1:d,top:i.yy-i.asc,bot:i.yy+i.desc})}),r.restore()}}function Dn(e,t){D.lines=e,D.wt=t,D.words=[],e.forEach(function(e,n){e.words.forEach(function(e,r){var i=t[n]&&t[n][r];i!=null&&isFinite(i)&&D.words.push({t:i,text:e.text,li:n,wi:r})})}),D.words.sort(function(e,t){return e.t-t.t}),D.lineStarts=t.map(function(e){for(var t=0;e&&t<e.length;t++)if(e[t]!=null)return e[t];return null}),En(),D.dirty=!0}function On(e){var t=DSP.parseLyrics(e);Dn(t,t.length?DSP.alignLyrics(t,D.ana):[])}n.addEventListener(`click`,function(){In.classList.contains(`away`)?Un():Bn()&&Hn(!0)});var kn=0,G=-1,An=0,jn=!1;function K(){var e=g.currentTime||0,t=performance.now();if(g.paused||g.ended)return kn=e,G=e,An=t,e;e!==G&&(G=e,An=t);var n=G+(t-An)/1e3*(g.playbackRate||1);return kn=Math.abs(n-kn)>.35?n:Math.max(kn,n),Math.min(kn,D.dur||kn)}function Mn(){var t=!g.paused&&!g.ended;e(`icoPlay`).hidden=t,e(`icoPause`).hidden=!t,_.setAttribute(`aria-label`,t?`Pause`:`Play`),e(`labPlay`).textContent=t?`Pause`:`Play`}function Nn(t){_.disabled=!t,e(`labPlay`).disabled=!t}function Pn(){var e=g.play();e&&e.catch&&e.catch(function(){A(`Playback was blocked. Tap play again.`,!0)})}function Fn(){g.paused||g.ended?(D.neverPlayed&&=!1,g.ended&&(g.currentTime=0),Pn()):g.pause()}_.addEventListener(`click`,Fn);var In=e(`hud`),Ln=e(`labBtn`),Rn=e(`labPanel`),zn=null;function Bn(){return!g.paused&&!g.ended}function Vn(){return!Rn.hidden}function Hn(e){In.classList.toggle(`away`,e),Ln.classList.toggle(`away`,e)}function Un(){clearTimeout(zn),Vn()?Hn(!0):(Hn(!1),Bn()&&(zn=setTimeout(function(){Bn()&&!Wn(In)&&!Wn(Ln)&&Hn(!0)},2600)))}function Wn(e){var t=document.activeElement;try{return!!t&&e.contains(t)&&t.matches(`:focus-visible`)}catch{return!1}}[`pointerdown`,`focusin`,`input`].forEach(function(e){In.addEventListener(e,Un),Ln.addEventListener(e,Un)}),h.addEventListener(`mousemove`,function(e){(e.movementX||e.movementY)&&Un()}),[`play`,`pause`,`ended`].forEach(function(e){g.addEventListener(e,function(){Mn(),D.dirty=!0,Un()})}),g.addEventListener(`seeked`,function(){D.dirty=!0}),g.addEventListener(`error`,function(){g.src&&A(`Can't play that file here.`,!0)}),[v,y].forEach(function(e){e.addEventListener(`pointerdown`,function(){jn=!0}),e.addEventListener(`pointerup`,function(){jn=!1}),e.addEventListener(`change`,function(){jn=!1}),e.addEventListener(`input`,function(){D.neverPlayed&&=!1;var t=parseFloat(e.value);(e===v?y:v).value=e.value,g.currentTime=t,kn=t,b.textContent=se(kn),D.dirty=!0})}),document.addEventListener(`keydown`,function(e){e.code!==`Space`||/^(TEXTAREA|INPUT|BUTTON|SUMMARY)$/.test(e.target.tagName)||_.disabled||(e.preventDefault(),Fn())});var Gn=null;function Kn(e){g.pause(),Gn&&URL.revokeObjectURL(Gn),Gn=e,g.src=e,g.load()}var qn=[],Jn=[],Yn=0,Xn=0;function Zn(e,t){var n=e.slice().sort(function(e,t){return e-t});return n[Math.min(n.length-1,Math.floor(n.length*t))]}function Qn(e){var t=!g.paused&&!g.ended;if((t||D.dirty)&&!er){var n=D.neverPlayed?D.previewT:K(),r=performance.now();xn(n),D.dirty=!1;var i=performance.now()-r;!jn&&!D.neverPlayed&&(v.value=y.value=String(n),b.textContent=se(n)),k.fps===`on`&&t?(Yn&&(qn.push(e-Yn),Jn.push(i),qn.length>120&&(qn.shift(),Jn.shift())),Yn=e,++Xn%30==0&&qn.length>=10&&(f.textContent=`frame `+Zn(qn,.5).toFixed(1)+` ms, slowest 5% `+Zn(qn,.95).toFixed(1)+`
drawing `+Zn(Jn,.5).toFixed(1)+` ms, slowest 5% `+Zn(Jn,.95).toFixed(1))):Yn=0}!er&&f.hidden!==(k.fps!==`on`)&&(f.hidden=k.fps!==`on`,f.textContent=`frame times show while it plays`,qn=[],Jn=[]),requestAnimationFrame(Qn)}var $n=[[`as now`,{}],[`wide live canvas (test 2)`,{narrow:!1}],[`no live canvas`,{nolive:!0}],[`resolution 1.75`,{dpr:1.75}],[`resolution 1.5`,{dpr:1.5}],[`nothing drawn: the phone alone`,{still:!0}]],er=!1,tr=null,nr=!1;function rr(e){e&&!tr&&!nr&&navigator.wakeLock&&document.visibilityState===`visible`&&(nr=!0,navigator.wakeLock.request(`screen`).then(function(e){nr=!1,tr=e,e.addEventListener(`release`,function(){tr=null})},function(){nr=!1})),!e&&tr&&(tr.release(),tr=null)}[`play`,`pause`,`ended`].forEach(function(e){g.addEventListener(e,function(){rr(er||Bn())})}),document.addEventListener(`visibilitychange`,function(){document.visibilityState===`visible`&&rr(er||Bn())});function ir(e){var t=Rt.dpr;Rt=Object.assign({},Lt,e),[l,i,p,m].forEach(function(e){e.style.mixBlendMode=Rt.blend?``:`normal`}),l.style.visibility=Rt.nostrips?`hidden`:``,Rt.strip!==Bt&&(Bt=Rt.strip,Ht=Bt/Vt,Wt=``),Rt.dpr!==t&&_e(),D.dirty=!0}function ar(e){var t=e.slice().sort(function(e,t){return e-t}),n=function(e){return+t[Math.min(t.length-1,Math.floor(t.length*e))].toFixed(1)};return t.length?{median:n(.5),p95:n(.95),p99:n(.99),max:+t[t.length-1].toFixed(1)}:null}function or(){if(!D.ana||er)return;g.pause(),ri(),clearTimeout(zn),Hn(!0);var e=Math.max(0,Math.min(K(),(D.dur||10)-10)),t=-1,r=0,i=0,a=[],o=[],s={};for(var c in k)k[c]!==ne[c]&&(s[c]=k[c]);var l={test:`pitchscape speed test 3`,when:new Date().toISOString(),device:{ua:navigator.userAgent,dpr:window.devicePixelRatio,cores:navigator.hardwareConcurrency||null,memoryGB:navigator.deviceMemory||null},print:{res:k.res,css:le+`x`+N,px:n.width+`x`+n.height,secondsShown:+F.toFixed(2),from:+e.toFixed(2),to:+(e+10).toFixed(2),lab:s,hidden:Object.keys(D.vis).filter(function(e){return!D.vis[e]})},runs:[]};er=!0,f.hidden=!1,rr(!0);function u(){if(++t>=$n.length)return p();ir($n[t][1]),r=0,i=0,a=[],o=[],f.textContent=`speed test `+(t+1)+` of `+$n.length+`: `+$n[t][0],requestAnimationFrame(d)}function d(s){r||=s;var c=(s-r)/1e3,f=0;if(!Rt.still){var p=performance.now();xn(e+Math.min(c,10)),f=performance.now()-p}if(c>.5&&i&&(a.push(s-i),o.push(f)),i=s,c<10.5)return requestAnimationFrame(d);var m=a.filter(function(e){return e>34}).length;t||(l.print.css=le+`x`+N,l.print.px=n.width+`x`+n.height),l.runs.push({run:$n[t][0],frames:a.length,frameMs:ar(a),drawMs:Rt.still?null:ar(o),over2frames:+(m/Math.max(1,a.length)).toFixed(3)}),u()}function p(){ir({}),er=!1,f.hidden=k.fps!==`on`,D.dirty=!0,Un(),rr(Bn()),sr(JSON.stringify(l))}u()}function sr(e){var t=document.createElement(`div`);t.className=`speedout`,t.setAttribute(`role`,`dialog`),t.setAttribute(`aria-label`,`Speed test results`),t.innerHTML=`<p>Speed test done. Copy this and paste it to Claude.</p><textarea readonly aria-label="Results"></textarea><div class="speedbtns"><button class="btn btn-small" type="button">Copy</button><button class="btn btn-small btn-quiet" type="button">Close</button></div>`;var n=t.querySelector(`textarea`),r=t.querySelectorAll(`button`);n.value=e,r[0].addEventListener(`click`,function(){var t=function(){r[0].textContent=`Copied`};navigator.clipboard&&navigator.clipboard.writeText?navigator.clipboard.writeText(e).then(t,function(){n.select()}):(n.select(),document.execCommand(`copy`),t())}),r[1].addEventListener(`click`,function(){t.remove()}),h.appendChild(t),r[0].focus()}e(`speedTest`).addEventListener(`click`,or);var cr=null,lr=null,ur=!1;function dr(){return ur?Promise.resolve(null):lr||(lr=new Promise(function(t){var n;try{n=new Worker(URL.createObjectURL(new Blob([e(`dsp`).textContent],{type:`text/javascript`})))}catch{ur=!0,t(null);return}var r=setTimeout(function(){try{n.terminate()}catch{}ur=!0,t(null)},4e3);n.onmessage=function(e){e.data&&e.data.type===`pong`&&(clearTimeout(r),cr=n,t(n))},n.onerror=function(e){e&&e.preventDefault&&e.preventDefault(),clearTimeout(r),ur=!0,t(null)},n.postMessage({cmd:`ping`})}),lr)}function fr(){cr&&(cr.terminate(),cr=null,lr=null)}function pr(e,t,n){return dr().then(function(r){return r?new Promise(function(i,a){r.onmessage=function(e){var t=e.data;t.type===`progress`?n&&n(t.label,t.p):t.type===`error`?a(Error(t.message)):(t.type===`demo`||t.type===`done`)&&i(t)},r.onerror=function(e){a(Error(e&&e.message||`The analysis stopped.`))},r.postMessage(e,t)}):new Promise(function(e){setTimeout(e,40)}).then(function(){var e=DSP.synthDemo(44100);return{L:e.L,R:e.R,sr:e.sr}})})}function mr(t,n,r){var i=$.status||{note:``,steps:null};$.status={label:t,p:j(n,0,1),note:r===void 0?i.note:r||``,song:e(`trackName`).textContent||``,steps:i.steps}}function hr(){$.status=null}var gr=[[`models`,`models`],[`stems`,`stems`],[`drums`,`drums`],[`notes`,`notes`],[`bass`,`bass`],[`voice`,`voice`],[`words`,`lyrics`],[`tone`,`tone`],[`width`,`width`]];function q(e,t){if($.status){var n={};($.status.steps||[]).forEach(function(e){e.state&&(n[e.k]=!0)}),e&&(n[e]=!0),$.status.steps=gr.filter(function(e){return e[0]!==`models`||t||n.models}).map(function(t){return{k:t[0],label:t[1],state:t[0]===e?`now`:n[t[0]]?`on`:``}})}}function _r(e,t,n){var r=e.length,i=new ArrayBuffer(44+r*4),a=new DataView(i),o=44,s;function c(e,t){for(var n=0;n<t.length;n++)a.setUint8(e+n,t.charCodeAt(n))}for(c(0,`RIFF`),a.setUint32(4,36+r*4,!0),c(8,`WAVE`),c(12,`fmt `),a.setUint32(16,16,!0),a.setUint16(20,1,!0),a.setUint16(22,2,!0),a.setUint32(24,n,!0),a.setUint32(28,n*4,!0),a.setUint16(32,4,!0),a.setUint16(34,16,!0),c(36,`data`),a.setUint32(40,r*4,!0),s=0;s<r;s++,o+=4)a.setInt16(o,j(e[s],-1,1)*32767,!0),a.setInt16(o+2,j(t[s],-1,1)*32767,!0);return new Blob([i],{type:`audio/wav`})}var vr=0;function yr(e,t){return D.song=t||``,D.retry=null,D.busy&&fr(),D.busy=!0,g.pause(),Nn(!1),D.ana=null,D.dur=0,D.neverPlayed=!0,D.previewT=0,Dn([],[]),v.value=y.value=`0`,b.textContent=`0:00`,x.textContent=`0:00`,D.dirty=!0,A(``),hr(),mr(e,.01),++vr}function br(t,n,r,i,a){ye(t),D.name=n,D.key=r,e(`trackName`).textContent=n,x.textContent=se(t.dur),v.max=y.max=String(t.dur),v.value=y.value=`0`,b.textContent=`0:00`,D.neverPlayed=a>0,D.previewT=a,i?On(i):Dn([],[]),hr(),Nn(!0),D.busy=!1,D.dirty=!0}function xr(){var t=yr(`Rendering the demo song`,`demo`);e(`trackName`).textContent=`Demo song`,pr({cmd:`demo`},[],null).then(function(e){t===vr&&Lr(_r(e.L,e.R,e.sr),`pitchscape-demo.wav`,`Demo song`,t,xr,!0)}).catch(function(e){t===vr&&Cr(`The demo failed to render: `+e.message)})}function Sr(t){var n=yr(`Opening `+t.name,``);e(`trackName`).textContent=t.name,Lr(t,t.name,t.name.replace(/\.[^.]+$/,``),n,function(){Sr(t)},!1)}function Cr(e){D.busy=!1,hr(),Nn(!1),Xr(),A(e,!0)}function wr(e){try{var t=new URL(e);return decodeURIComponent(t.pathname.split(`/`).pop()||``).replace(/\.[^.]+$/,``)||t.hostname}catch{return e}}function Tr(t,n){var r=yr(`Fetching the song`,``);if(n||=wr(t),e(`trackName`).textContent=n,Hr()===`here`)fetch(t).then(function(e){if(!e.ok)throw Error(`That link answered `+e.status+`.`);return e.blob()},function(){throw Error(`This page can’t read that link itself (its site doesn’t allow other pages to). Choose the server, which can, or download the file and load it.`)}).then(function(e){r===vr&&Lr(e,wr(t)+`.mp3`,n,r,function(){Tr(t,n)},!1)}).catch(function(e){r===vr&&Cr(e.message)});else{var i=new FormData;i.append(`url`,t),X(i,null,r,`Fetching the song`).then(function(e){return!e||r!==vr?null:(mr(`Loading the audio`,.97),fetch(Er+`/library/`+e.sha+`/audio`,{headers:{"X-Pitchscape-Key":Ar()}}).then(function(e){if(!e.ok)throw Error(`The server didn't send the song's audio (`+e.status+`). Open it again.`);return e.blob()},function(){throw Error(`Couldn't reach the server. Check the connection and open the song again.`)}).then(function(t){r===vr&&(Kn(URL.createObjectURL(t)),br(Kr(e.pack),Y(e.pack,n),`sha:`+e.sha,null,0),qr(e.pack))}))}).catch(function(e){r===vr&&(Cr(e&&e.message||`Couldn't open that link.`),e&&e.needsKey&&(D.retry=function(){Tr(t,n)},$.askKey++))})}}var Er=null,Dr=``,Or=!1,kr=Promise.resolve(null);function Ar(){return O.get(`pitchscape:key`)||(Or?`local`:null)}try{kr=fetch(`config.json`,{cache:`no-store`}).then(function(e){return e.ok?e.json():null}).then(function(e){return Er=e&&e.api?String(e.api).replace(/\/$/,``):null,Dr=e&&e.pipeline?String(e.pipeline):``,Or=!!(e&&e.local),Er},function(){return null})}catch{}function jr(e){return`pack:`+Dr+`:`+e}function Mr(e){return!!(e&&e.version>=14&&e.segStride===19&&e.bytes&&e.strikes)}var Nr=(function(){var e=null;function t(){return e||=new Promise(function(e,t){try{var n=indexedDB.open(`pitchscape`,1);n.onupgradeneeded=function(){n.result.createObjectStore(`packs`)},n.onsuccess=function(){e(n.result)},n.onerror=function(){t(n.error)}}catch(e){t(e)}}),e}function n(e,n){return t().then(function(t){return new Promise(function(r,i){var a=t.transaction(`packs`,e),o=n(a.objectStore(`packs`));a.oncomplete=function(){r(o&&o.result)},a.onerror=function(){i(a.error)}})})}return{get:function(e){return n(`readonly`,function(t){return t.get(e)}).catch(function(){return null})},put:function(e,t){return n(`readwrite`,function(n){return n.put(t,e)}).catch(function(){})}}})(),J=[[`stems`,`Splitting the song into stems`,.2],[`drums`,`Reading the drums`,.45],[`notes`,`Reading the notes`,.55],[`loudness`,`Listening for how loud and how noisy each sound is`,.8],[`width`,`Measuring how wide each sound is`,.82],[`bass`,`Following the bass`,.65],[`voice`,`Following the voice`,.75],[`words`,`Finding the lyrics`,.85],[`done`,`Finishing`,.95]];function Pr(e){for(var t=0;e&&t<J.length;t++)if(e.indexOf(J[t][0])===0)return J[t];return[``,`Starting the server`,.12]}function Fr(e){return window.crypto&&crypto.subtle?crypto.subtle.digest(`SHA-256`,e).then(function(e){return Array.prototype.map.call(new Uint8Array(e),function(e){return(e<16?`0`:``)+e.toString(16)}).join(``)},function(){return null}):Promise.resolve(null)}function Ir(e){return e?kr.then(function(){return Nr.get(jr(e)).then(function(t){if(t&&Mr(t))return t;var n=Ar();if(!Er||!n)return null;var r=window.AbortController?new AbortController:null,i=r&&setTimeout(function(){r.abort()},4e3);return fetch(Er+`/packs/`+e,{headers:{"X-Pitchscape-Key":n},signal:r?r.signal:void 0}).then(function(e){return clearTimeout(i),e.ok?e.json():null}).then(function(t){return t&&t.pack&&Mr(t.pack)?(Nr.put(jr(e),t.pack),t.pack):null},function(){return null})})}):Promise.resolve(null)}function Lr(e,t,n,r,i,a){var o=null;mr(`Looking for this song`,.03),e.arrayBuffer().then(Fr).then(function(e){return o=e,r===vr?Ir(o):null}).then(function(n){if(n||r!==vr)return n;if(Hr()===`here`)return Gr(e,t,o,r).then(function(e){return e&&e.pack});var i=new FormData;return i.append(`file`,e,t),X(i,o,r,`Uploading`).then(function(e){return e&&e.pack})}).then(function(i){i&&r===vr&&(Kn(URL.createObjectURL(e)),a?br(Kr(i),n,`demo`,DSP.DEMO_LYRICS,16.9):(br(Kr(i),Y(i,n),o?`sha:`+o:`file:`+t,null,0),qr(i)),A(``))}).catch(function(e){r===vr&&(Cr(e&&e.message||`Couldn't open that file.`),e&&e.needsKey&&(D.retry=i,$.askKey++))})}function Y(e,t){var n=e.song||{};return n.title?n.title+(n.artist?` · `+n.artist:``):t}function Rr(e){var t=Error(e);return t.needsKey=!0,t}function X(e,t,n,r){return kr.then(function(){var i=Ar();if(!Er)throw Error(`This page has no analysis server set up.`);if(!i)throw Rr(`Add the server key below and this song will be analysed.`);return mr(r,.05,`first time only, a few minutes`),fetch(Er+`/analyze`,{method:`POST`,headers:{"X-Pitchscape-Key":i},body:e}).then(function(e){if(e.status===401)throw Rr(`The server key is wrong. Fix it below and this song will be analysed.`);if(e.status===400||e.status===413||e.status===502)return e.json().catch(function(){return{}}).then(function(t){throw Error(t.detail||(e.status===413?`That file is over 80 MB.`:`The server said `+e.status+`.`))});if(!e.ok)throw Error(`The server said `+e.status+`. Try again in a minute.`);return e.json()},function(){throw Error(`Couldn't reach the server. Check the connection and try again.`)}).then(function(e){return t=e.sha256||t,e.status===`done`?e.pack:new Promise(function(t,r){var a=Date.now(),o=``;function s(){n===vr?!o&&Date.now()-a>48e4?r(Error(`The server never started on this song. Load it again in a minute.`)):fetch(Er+`/jobs/`+encodeURIComponent(e.job)+`?key=`+encodeURIComponent(e.key),{headers:{"X-Pitchscape-Key":i}}).then(function(e){return e.json()}).then(function(e){if(n!==vr)t(null);else if(e.status===`done`&&e.pack)t(e.pack);else if(e.status===`failed`)r(Error(`The analysis failed: `+String(e.error||`no reason given`).replace(/\.?\s*$/,`.`)));else{e.stage&&(o=e.stage);var i=Pr(e.stage);mr(i[1],i[2]),q(i[0]),setTimeout(s,3e3)}},function(){setTimeout(s,6e3)}):t(null)}mr(`Starting the server`,.1),setTimeout(s,2500)})})}).then(function(e){if(e&&!Mr(e))throw Error(`The server is being updated. Load the song again in a few minutes.`);return e&&t&&Nr.put(jr(t),e),e?{pack:e,sha:t}:null})}var zr=`https://huggingface.co/stopamertime/pitchscape-models/resolve/main/`,Z={done:!1,ok:!1,gpu:``,why:``,phone:!1,tablet:!1,mem:0,cores:0,mb:0},Br=(function(){var e=navigator.userAgent||``;Z.phone=navigator.userAgentData?!!navigator.userAgentData.mobile:/Android|iPhone|iPod|Mobile/i.test(e),Z.tablet=/iPad/.test(e)||/Macintosh/.test(e)&&navigator.maxTouchPoints>1,Z.mem=navigator.deviceMemory||0,Z.cores=navigator.hardwareConcurrency||0;var t=fetch(zr+`manifest.json`,{cache:`no-cache`}).then(function(e){return e.ok?e.json():null}).then(function(e){var t=0;[`htdemucs_6s`,`adtof_frame_rnn`,`basic_pitch`,`crepe_full`,`align_en`].forEach(function(n){t+=e&&e[n]&&e[n].bytes||0}),Z.mb=Math.round(t/1e6)},function(){}),n=navigator.gpu?navigator.gpu.requestAdapter({powerPreference:`high-performance`}).then(function(e){if(!e)Z.why=`No usable graphics card`;else{var t=e.info||{};t.isFallbackAdapter||e.isFallbackAdapter?Z.why=`Software graphics only: too slow`:(Z.gpu=Vr(t.vendor,t.architecture),Z.ok=!0)}},function(){Z.why=`WebGPU would not start`}):Promise.resolve(Z.why=`No WebGPU: use Chrome or Edge`);return Promise.all([n,t]).then(function(){Z.done=!0})})();function Vr(e,t){var n={nvidia:`NVIDIA`,amd:`AMD`,intel:`Intel`,apple:`Apple`,qualcomm:`Qualcomm`,arm:`Arm`,microsoft:`Microsoft`}[e]||(e?e.charAt(0).toUpperCase()+e.slice(1):``),r=(t||``).replace(/^(rdna|gcn|cdna|xe|gen)-?(.*)$/i,function(e,t,n){return t.toUpperCase()+(n?` `+n:``)});return r&&r===(t||``)&&(r=r.charAt(0).toUpperCase()+r.slice(1)),(n+(r?` `+r:``)).trim()||`a graphics card`}function Hr(){var e=O.get(`pitchscape:where`);return e===`here`||e===`server`?e:Z.ok&&!Z.phone&&!Z.tablet?`here`:`server`}function Ur(){var e=O.get(`pitchscape:hereRate`);return e&&e>0?e:0}function Wr(e){return e<90?Math.max(5,Math.round(e/5)*5)+` s`:Math.round(e/60)+` min`}function Q(){$.where=Hr(),$.local=Or,$.hasKey=!!O.get(`pitchscape:key`),$.here={done:Z.done,ok:Z.ok,gpu:Z.gpu,why:Z.why,small:Z.phone||Z.tablet,mem:Z.mem,cores:Z.cores,mb:Z.mb}}fs.setWhere=function(e){O.set(`pitchscape:where`,e),Q()},Q(),Br.then(Q);function Gr(e,t,n,r){return Br.then(function(){if(!Z.ok)throw Error(`This computer can’t analyse songs (`+Z.why.toLowerCase()+`). Choose the server instead.`);return mr(`Reading the audio`,.02,``),q(``,!0),e.arrayBuffer()}).then(function(e){return new OfflineAudioContext(2,1,44100).decodeAudioData(e.slice(0)).then(function(t){return{buf:e,mix:[t.getChannelData(0).slice(),t.getChannelData(Math.min(1,t.numberOfChannels-1)).slice()],dur:t.duration}},function(){throw Error(`This browser couldn’t read that file as audio.`)})}).then(function(e){return new Promise(function(n,i){var a=new Worker(new URL(`pipeline/analyse.worker.mjs`,location.href),{type:`module`}),o=performance.now(),s=0,c=0,l={},u=!1,d=!1,f=``,p=0,m=0,h=function(){return(performance.now()-o)/1e3};function g(e,t,n){f=e,p=Math.max(p,t),mr(f,p,n)}function _(){var t=Ur()*e.dur;if(t&&!u){var n=t-h();g(f,.55+.4*Math.min(.98,(h()-c)/Math.max(1,t-c)),n>5?`about `+Wr(n)+` left`:`nearly done`)}}function v(e,t){clearInterval(m),a.terminate(),t?i(t):n(e)}a.onerror=function(e){v(null,Error(`The analysis here stopped: `+(e.message||`its worker would not start`)+`. Choose the server instead.`))},a.onmessage=function(t){var n=t.data;if(r!==vr)v(null);else if(n.download){u=!0,l[n.download.name]=n.download;var i=0,a=0;for(var o in l)i+=l[o].got,a+=l[o].total;var y=`fetching models: `+Math.round(i/1e6)+` / `+Math.round(a/1e6)+` MB · once`;d?mr(f,p,y):(g(`Fetching the models`,.02+.08*i/Math.max(1,a),y.replace(`fetching models: `,``)),q(`models`,!0))}else if(n.progress){d=!0;var b=Pr(n.progress),x=/^stems: (\d+)\/(\d+)/.exec(n.progress),S=``;if(x){var C=+x[1],ee=+x[2];if(s||=performance.now(),C>=2){var w=(performance.now()-s)/1e3/(C-1)*(ee-C),T=Ur()*e.dur;S=(T>h()&&!u?`about `+Wr(Math.max(w,T-h())):`about `+Wr(w)+` for this step`)+` left`,w>180&&(S+=` · the server may be quicker`)}g(b[1],.1+.45*C/ee,S)}else!c&&b[0]&&b[0]!==`stems`&&(c=h(),m=setInterval(_,1e3)),g(b[1],Math.min(b[2],.6)),_();q(b[0],!0)}else n.pack?(u||O.set(`pitchscape:hereRate`,h()/Math.max(1,e.dur)),v(n.pack)):n.error&&v(null,Error(`The analysis here failed: `+n.error+` Choose the server to analyse it there.`))},a.postMessage({bytes:e.buf,name:t,mix:e.mix,models:zr},[e.buf,e.mix[0].buffer,e.mix[1].buffer])})}).then(function(e){return e&&n&&Nr.put(jr(n),e),e?{pack:e,sha:n}:null})}function Kr(e){var t={dur:e.dur,dt:e.dt,frames:e.frames,stereo:e.stereo,noiseRef:e.noiseRef};for(var n in e.arrays)t[n]=Yr(e.arrays[n]);for(n in e.bytes)t[n]=Jr(e.bytes[n]);for(n in t.segW=e.segStride,t.evW=e.eventStride,t.earDb=e.earDb,t.strikeBands=e.strikeBands,t.noiseShare={},t.strikes={},e.noiseShare)t.noiseShare[n]=Jr(e.noiseShare[n]);for(n in e.strikes)t.strikes[n]=Jr(e.strikes[n]);return t}function qr(e){var t=e.stats&&e.stats.lyrics||{};e.lyrics&&e.lyrics.lines&&e.lyrics.lines.length?Dn(e.lyrics.lines.map(function(e){return{text:e.text,words:e.words.map(function(e){return{text:e[0],syl:Math.max(1,DSP.syllableCount(e[0]))}})}}),e.lyrics.lines.map(function(e){return e.words.map(function(e){return e[1]})})):(En(),A(t.why===`instrumental`?``:t.why===`LRCLIB could not be reached`?`No words: the lyrics site was down when this song was analysed.`:t.artist&&t.title?`No words: no published lyrics were found for `+t.title+` by `+t.artist+` at this length.`:`No words: this file doesn't name its artist and title, so its lyrics couldn't be looked up.`))}function Jr(e){for(var t=atob(e.data),n=new Float32Array(t.length),r=(e.hi-e.lo)/255,i=0;i<t.length;i++)n[i]=e.lo+t.charCodeAt(i)*r;return n}function Yr(e){for(var t=atob(e),n=new Uint8Array(t.length),r=0;r<t.length;r++)n[r]=t.charCodeAt(r);return new Float32Array(n.buffer)}function Xr(){g.pause(),ri(),$.hasSong=!!D.ana,$.splash=!0}function Zr(){$.splash=!1,A(``),Un()}e(`changeSong`).addEventListener(`click`,Xr),fs.back=function(){Zr(),_.focus({preventScroll:!0})},fs.demo=function(){Zr(),xr()},fs.link=function(e,t){Zr(),Tr(e,t)},fs.file=function(e){Zr(),Sr(e)},fs.say=A,document.querySelectorAll(`.ink`).forEach(function(e){e.addEventListener(`click`,function(){var t=e.dataset.layer;D.vis[t]=!D.vis[t],e.setAttribute(`aria-pressed`,String(D.vis[t])),D.dirty=!0})});function Qr(e,t){return e===`secs`?t.toFixed(1)+` s`:e===`res`?`×`+t.toFixed(2)+(t>(window.devicePixelRatio||1)?` (screen ×`+(window.devicePixelRatio||1)+`)`:``):e===`ink`||e===`weight`||e===`drumK`?`×`+t.toFixed(2):e===`vRun`||e===`noteMin`?Math.round(t)+` ms`:e===`exDb`||e===`attack`||e===`nShare`||e===`sShare`?t+` dB`:e===`nJag`?(t/3).toFixed(1)+` st`:e===`lFloor`?`−`+Math.round((1-t)*72)+` dB`:e===`leap`?t+` st`:Math.round(t*100)+`%`}var $r={vConf:1,vFloor:1,vRun:1,bFloor:1,hold:1,noteMin:1,drumK:1,exDb:1,attack:1,nShare:1,nGate:1,gConf:1};function ei(){Rn.querySelectorAll(`.seg[data-key]`).forEach(function(e){var t=e.dataset.key;e.querySelectorAll(`button`).forEach(function(e){e.setAttribute(`aria-pressed`,String(String(k[t])===e.dataset.v))})}),Rn.querySelectorAll(`input[type="range"][data-key]`).forEach(function(t){var n=t.dataset.key,r=n===`secs`?k.secs>0?k.secs:F:k[n];t.value=String(r),e(`lab-`+n+`-v`).textContent=Qr(n,r)});var t=document.documentElement.style;t.setProperty(`--drum`,Me.drum),t.setProperty(`--c-synth`,Me.pluck),[`bass`,`voice`,`guitar`,`piano`,`words`].forEach(function(e){t.setProperty(`--c-`+e,Me[e])})}function ti(e){ae(),($r[e]||e===`all`)&&(R(),En()),(e===`secs`||e===`res`||e===`all`)&&_e(),(e===`font`||e===`wordSize`||e===`weight`||e===`all`)&&wn(k.font).then(function(){En(),D.dirty=!0}),ei(),D.dirty=!0}Rn.querySelectorAll(`.seg[data-key] button`).forEach(function(e){e.addEventListener(`click`,function(){var t=e.parentNode.dataset.key;k[t]=e.dataset.v,ti(t)})}),Rn.querySelectorAll(`input[type="range"][data-key]`).forEach(function(e){e.addEventListener(`input`,function(){var t=e.dataset.key;k[t]=parseFloat(e.value),ti(t)})}),e(`labReset`).addEventListener(`click`,function(){k=Object.assign({},ne),ti(`all`)}),e(`labAll`).addEventListener(`click`,function(){[`vConf`,`vFloor`,`vRun`,`bFloor`,`hold`,`noteMin`,`drumK`].forEach(function(t){k[t]=parseFloat(e(`lab-`+t).min)}),ti(`all`)});function ni(){Rn.hidden=!1,D.dirty=!0,Ln.setAttribute(`aria-expanded`,`true`),oi(),Un()}function ri(){var e=!Rn.hidden&&Rn.contains(document.activeElement);Rn.hidden=!0,Ln.setAttribute(`aria-expanded`,`false`),D.dirty=!0,oi(),Un(),e&&Ln.focus({preventScroll:!0})}Ln.addEventListener(`click`,function(){Rn.hidden?ni():ri()}),document.querySelectorAll(`[data-close]`).forEach(function(e){e.addEventListener(`click`,ri)}),e(`labPlay`).addEventListener(`click`,Fn),document.addEventListener(`keydown`,function(e){e.key===`Escape`&&(Vn()||!ii.hidden)&&(ii.hidden?ri():oi())});var ii=e(`bubble`),ai=null;function oi(){ai&&ai.setAttribute(`aria-expanded`,`false`),ii.hidden=!0,ai=null}Rn.querySelectorAll(`.k[data-tip]`).forEach(function(e){e.addEventListener(`click`,function(){if(ai===e)oi();else{oi(),ai=e,e.setAttribute(`aria-expanded`,`true`),ii.textContent=e.dataset.tip,ii.hidden=!1;var t=Rn.getBoundingClientRect(),n=e.getBoundingClientRect(),r=Rn.querySelector(`.panel-head`).getBoundingClientRect(),i=ii.offsetHeight,a=n.top-i-12>r.bottom,o=Math.max(12,n.left-t.left-6);ii.classList.toggle(`above`,a),ii.classList.toggle(`below`,!a),ii.style.left=o+`px`,ii.style.top=n.top-t.top+Rn.scrollTop+(a?-i-10:n.height+10)+`px`,ii.style.setProperty(`--tail`,Math.max(12,Math.min(n.width-10,24)+n.left-t.left-o-6)+`px`)}})}),document.addEventListener(`pointerdown`,function(e){ai&&!ii.contains(e.target)&&!ai.contains(e.target)&&oi()});var si=Rn.querySelectorAll(`[role="tab"]`);function ci(e){si.forEach(function(t){t.setAttribute(`aria-selected`,String(t.dataset.tab===e)),t.tabIndex=t.dataset.tab===e?0:-1}),Rn.querySelectorAll(`.pane`).forEach(function(t){t.hidden=t.dataset.pane!==e}),oi(),O.set(`pitchscape:tab`,e)}si.forEach(function(e){e.addEventListener(`click`,function(){ci(e.dataset.tab)})}),ci(Rn.querySelector(`[data-tab="`+O.get(`pitchscape:tab`)+`"]`)?O.get(`pitchscape:tab`):`colour`),ei(),fs.setKey=function(e){if(e?O.set(`pitchscape:key`,e):O.del(`pitchscape:key`),Q(),e&&D.retry){var t=D.retry;D.retry=null,Zr(),t()}else A(e?`Server key saved.`:`Server key removed.`)},k.font!==`grotesque`&&wn(k.font).then(function(){En(),D.dirty=!0}),window.ResizeObserver?new ResizeObserver(_e).observe(n):window.addEventListener(`resize`,_e),_e(),document.fonts&&document.fonts.ready&&document.fonts.ready.then(function(){En(),D.dirty=!0}),requestAnimationFrame(Qn),kr.then(Q)}var _c=e((()=>{ps()}));t((()=>{n(),i(),ts(),Ys(),hc(),Fs(),_c();var e=document.createElement(`script`);e.id=`dsp`,e.textContent=r,document.body.append(e),Ni(Gs,{target:document.querySelector(`main.app`)}),Ni(lc,{target:document.getElementById(`plate`)}),Ni(As,{target:document.getElementById(`where-lab`),props:{id:`where-lab`}}),gc()}))();