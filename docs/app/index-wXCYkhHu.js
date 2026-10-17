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
`})),a=e((()=>{})),o=e((()=>{})),s=e((()=>{a(),o()}));function c(e){return typeof e==`function`}function l(e){for(var t=0;t<e.length;t++)e[t]()}function u(){var e,t;return{promise:new Promise((n,r)=>{e=n,t=r}),resolve:e,reject:t}}var d,f,p,m,h,g,_,v,y,b,x,S,C=e((()=>{d=Array.isArray,f=Array.prototype.indexOf,p=Array.prototype.includes,m=Array.from,h=Object.defineProperty,g=Object.getOwnPropertyDescriptor,_=Object.getOwnPropertyDescriptors,v=Object.prototype,y=Array.prototype,b=Object.getPrototypeOf,x=Object.isExtensible,S=()=>{}})),w,T,E,D,O,k,A,j,ee,te,ne,re,ie,ae,oe,M,se,ce,le,ue,de,fe,pe,me,he,ge,N=e((()=>{w=1<<24,T=1024,E=2048,D=4096,O=8192,k=16384,A=32768,j=1<<25,ee=65536,te=1<<19,ne=1<<20,re=1<<25,ie=1<<21,ae=1<<22,oe=1<<23,M=Symbol(`$state`),se=Symbol(`component`),ce=Symbol(`legacy props`),le=Symbol(``),ue=Symbol(`attributes`),de=Symbol(`class`),fe=Symbol(`style`),pe=Symbol(`text`),me=Symbol(`form reset`),he=new class extends Error{name=`StaleReactionError`;message="The reaction that called `getAbortSignal()` was re-run or destroyed"},ge=!!globalThis.document?.contentType&&globalThis.document.contentType.includes(`xml`)})),_e,ve,ye,be=e((()=>{_e={},ve=Symbol(`uninitialized`),ye=`http://www.w3.org/1999/xhtml`}));function xe(){console.warn(`https://svelte.dev/e/derived_inert`)}function Se(e){console.warn(`https://svelte.dev/e/hydration_mismatch`)}function Ce(){console.warn(`https://svelte.dev/e/select_multiple_invalid_value`)}function we(){console.warn(`https://svelte.dev/e/svelte_boundary_reset_noop`)}var Te=e((()=>{s()}));function Ee(e){F=e}function De(e){if(e===null)throw Se(),_e;return I=e}function Oe(){return De(jn(I))}function P(e){if(F){if(jn(I)!==null)throw Se(),_e;I=e}}function ke(e=1){if(F){for(var t=e,n=I;t--;)n=jn(n);I=n}}function Ae(e=!0){for(var t=0,n=I;;){if(n.nodeType===8){var r=n.data;if(r===`]`){if(t===0)return n;--t}else(r===`[`||r===`[!`||r[0]===`[`&&!isNaN(Number(r.slice(1))))&&(t+=1)}var i=jn(n);e&&n.remove(),n=i}}function je(e){if(!e||e.nodeType!==8)throw Se(),_e;return e.data}var F,I,L=e((()=>{N(),be(),Te(),K(),F=!1}));function Me(e){return e===this.v}function Ne(e,t){return e==e?e!==t||typeof e==`object`&&!!e||typeof e==`function`:t==t}function Pe(e){return!Ne(e,this.v)}var Fe=e((()=>{})),Ie=e((()=>{s()}));function Le(){throw Error(`https://svelte.dev/e/async_derived_orphan`)}function Re(e,t,n){throw Error(`https://svelte.dev/e/each_key_duplicate`)}function ze(e){throw Error(`https://svelte.dev/e/effect_in_teardown`)}function Be(){throw Error(`https://svelte.dev/e/effect_in_unowned_derived`)}function Ve(e){throw Error(`https://svelte.dev/e/effect_orphan`)}function He(){throw Error(`https://svelte.dev/e/effect_update_depth_exceeded`)}function Ue(e){throw Error(`https://svelte.dev/e/props_invalid_value`)}function We(){throw Error(`https://svelte.dev/e/state_descriptors_fixed`)}function Ge(){throw Error(`https://svelte.dev/e/state_prototype_fixed`)}function Ke(){throw Error(`https://svelte.dev/e/state_unsafe_mutation`)}function qe(){throw Error(`https://svelte.dev/e/svelte_boundary_reset_onerror`)}var Je=e((()=>{s(),Ie()})),Ye,Xe,Ze=e((()=>{Ye=!1,Xe=!1})),Qe=e((()=>{C()})),$e=e((()=>{Qe(),N(),q(),Z()})),et=e((()=>{s(),C(),Ie()}));function tt(e){R=e}function nt(e,t=!1,n){R={p:R,i:!1,c:null,e:null,s:e,x:null,r:X,l:Xe&&!t?{s:null,u:null,$:[]}:null}}function rt(e){var t=R,n=t.e;if(n!==null){t.e=null;for(var r of n)Zn(r)}return e!==void 0&&(t.x=e),t.i=!0,R=t.p,it(e)}function it(e={}){return h(e,se,{value:!0}),e}function at(){return!Xe||R!==null&&R.l===null}var R,z=e((()=>{s(),Je(),Z(),q(),Ze(),N(),C(),R=null}));function ot(){var e=lt;lt=[],l(e)}function st(e){if(lt.length===0&&!en){var t=lt;queueMicrotask(()=>{t===lt&&ot()})}lt.push(e)}function ct(){for(;lt.length>0;)ot()}var lt,ut=e((()=>{C(),H(),lt=[]}));function B(e,t){e.f=e.f&ft|t}function dt(e){e.f&512||e.deps===null?B(e,T):B(e,D)}var ft,pt=e((()=>{N(),ft=~(E|D|T)}));function mt(e,t,n){e.f&2048?t.add(e):e.f&4096&&n.add(e),B(e,T)}var ht=e((()=>{N(),pt()})),gt=e((()=>{N(),Qe(),Z()}));function _t(e,t){if(t){let t=document.body;e.autofocus=!0,st(()=>{document.activeElement===t&&e.focus()})}}function vt(){yt||(yt=!0,document.addEventListener(`reset`,e=>{Promise.resolve().then(()=>{if(!e.defaultPrevented)for(let t of e.target.elements)t[me]?.()})},{capture:!0}))}var yt,bt=e((()=>{L(),K(),ut(),N(),yt=!1}));function xt(e){var t=Y,n=X;br(null),xr(null);try{return e()}finally{br(t),xr(n)}}function St(e,t,n,r=n){e.addEventListener(t,()=>xt(n));let i=e[me];i?e[me]=()=>{i(),r(!0)}:e[me]=()=>r(!0),vt()}var Ct=e((()=>{q(),Z(),N(),bt()}));function wt(e,t,n,r){let i=at()?At:Nt;var a=e.filter(e=>!e.settled),o=t.map(i);if(n.length===0&&a.length===0){r(o);return}var s=X,c=Tt(),l=a.length===1?a[0].promise:a.length>1?Promise.all(a.map(e=>e.promise)):null;function u(e){if(!(s.f&16384)){c();try{r([...o,...e])}catch(e){Un(e,s)}Et()}}var d=Dt();if(n.length===0){l.then(()=>u([])).finally(d);return}function f(){Promise.all(n.map(e=>jt(e))).then(u).catch(e=>Un(e,s)).finally(d)}l?l.then(()=>{s.f&16384?d():(c(),f(),Et())}):f()}function Tt(){var e=X,t=Y,n=R,r=V;return function(i=!0){xr(e),br(t),tt(n),i&&!(e.f&16384)&&(r?.activate(),r?.apply())}}function Et(e=!0){Ot=!1,xr(null),br(null),tt(null),e&&V?.deactivate()}function Dt(){var e=X,t=e.b,n=V,r=!!t?.is_rendered();return t?.update_pending_count(1,n),n.increment(r,e),()=>{t?.update_pending_count(-1,n),n.decrement(r,e)}}var Ot,kt=e((()=>{N(),s(),z(),Wn(),Z(),H(),Bt(),q()}));function At(e){var t=2|E;return X!==null&&(X.f|=te),{ctx:R,deps:null,effects:null,equals:Me,f:t,fn:e,reactions:null,rv:0,v:ve,wv:0,parent:X,ac:null}}function jt(e,t,n){let r=X;r===null&&Le();var i=void 0,a=ln(ve),o=!Y,s=new Set;return er(()=>{var t=X,n=u();i=n.promise;try{Promise.resolve(e()).then(n.resolve,e=>{e!==he&&n.reject(e)}).finally(Et)}catch(e){n.reject(e),Et()}var c=V;if(o){if(t.f&32768)var l=Dt();if(r.b?.is_rendered())c.async_deriveds.get(t)?.reject(zt);else for(let e of s.values())e.reject(zt);s.add(n),c.async_deriveds.set(t,n)}let d=(e,t=void 0)=>{l?.(),s.delete(n),t!==zt&&(c.activate(),t?(a.f|=oe,pn(a,t)):(a.f&8388608&&(a.f^=oe),pn(a,e)),c.deactivate())};n.promise.then(d,e=>d(null,e||`unknown`))}),Yn(()=>{for(let e of s)e.reject(zt)}),new Promise(e=>{function t(n){function r(){n===i?e(a):t(i)}n.then(r,r)}t(i)})}function Mt(e){let t=At(e);return Ye||Sr(t),t}function Nt(e){let t=At(e);return t.equals=Pe,t}function Pt(e){var t=e.effects;if(t!==null){e.effects=null;for(var n=0;n<t.length;n+=1)lr(t[n])}}function Ft(e){var t,n=X,r=e.parent;if(!Lr&&r!==null&&e.v!==ve&&r.f&24576)return xe(),e.v;xr(r);try{Pt(e),t=Or(e)}finally{xr(n)}return t}function It(e){var t=Ft(e);!e.equals(t)&&(e.wv=Tr(),(!V?.is_fork||e.deps===null)&&(V===null?e.v=t:(V.capture(e,t,!0),Zt?.capture(e,t,!0)),e.deps===null))?B(e,T):Lr||(Qt===null?dt(e):(Jn()||V?.is_fork)&&Qt.set(e,t))}function Lt(e){if(e.effects!==null)for(let t of e.effects)(t.teardown||t.ac)&&(t.teardown?.(),t.ac!==null&&xt(()=>{t.ac.abort(he),t.ac=null}),t.fn!==null&&(t.teardown=S),jr(t,0),sr(t))}function Rt(e){if(e.effects!==null)for(let t of e.effects)t.teardown&&t.fn!==null&&Mr(t)}var zt,Bt=e((()=>{s(),N(),Z(),Ct(),Fe(),Je(),Te(),q(),Sn(),et(),Ze(),z(),be(),H(),kt(),C(),pt(),zt=Symbol(`obsolete`)}));function Vt(e){var t=en,n=Zt;Zt=null,en=!0;try{var r;for(e&&(Vt(),r=e());;){if(ct(),V===null)return r;V.flush()}}finally{en=t,Zt=n}}function Ht(){try{He()}catch(e){Un(e,$t)}}function Ut(e){var t=e.length;if(t!==0){for(var n=0;n<t;){var r=e[n++];if(!(r.f&24576)&&Er(r)&&(cn=new Set,Mr(r),r.deps===null&&r.first===null&&r.nodes===null&&r.teardown===null&&r.ac===null&&dr(r),cn?.size>0)){vn.clear();for(let e of cn){if(e.f&24576)continue;let t=[e],n=e.parent;for(;n!==null;)cn.has(n)&&(cn.delete(n),t.push(n)),n=n.parent;for(let e=t.length-1;e>=0;e--){let n=t[e];n.f&24576||Mr(n)}}cn.clear()}}cn=null}}function Wt(e,t,n,r){if(!n.has(e)&&(n.add(e),e.reactions!==null))for(let i of e.reactions){let e=i.f;e&2?Wt(i,t,n,r):e&4194320&&!(e&2048)&&Gt(i,t,r)&&(B(i,E),Kt(i))}}function Gt(e,t,n){let r=n.get(e);if(r!==void 0)return r;if(e.deps!==null)for(let r of e.deps){if(p.call(t,r))return!0;if(r.f&2&&Gt(r,t,n))return n.set(r,!0),!0}return n.set(e,!1),!1}function Kt(e){V.schedule(e)}function qt(e,t){if(!(e.f&32&&e.f&1024)){e.f&2048?t.d.push(e):e.f&4096&&t.m.push(e),B(e,T);for(var n=e.first;n!==null;)qt(n,t),n=n.next}}function Jt(e){B(e,T);for(var t=e.first;t!==null;)Jt(t),t=t.next}var Yt,Xt,V,Zt,Qt,$t,en,tn,nn,rn,an,on,sn,cn,H=e((()=>{N(),Ze(),C(),Z(),Je(),ut(),s(),Wn(),Sn(),q(),ht(),be(),pt(),et(),gt(),Bt(),Yt=null,Xt=null,V=null,Zt=null,Qt=null,$t=null,en=!1,tn=!1,nn=null,rn=null,an=0,on=1,sn=class e{id=on++;#e=!1;linked=!0;#t=null;#n=null;async_deriveds=new Map;current=new Map;previous=new Map;#r=new Set;#i=new Set;#a=0;#o=new Map;#s=null;#c=[];#l=[];#u=new Set;#d=new Set;#f=new Map;#p=new Set;is_fork=!1;#m=!1;constructor(){Xt===null?Yt=Xt=this:(Xt.#n=this,this.#t=Xt),Xt=this}#h(){if(this.is_fork)return!0;for(let n of this.#o.keys()){for(var e=n,t=!1;e.parent!==null;){if(this.#f.has(e)){t=!0;break}e=e.parent}if(!t)return!0}return!1}skip_effect(e){this.#f.has(e)||this.#f.set(e,{d:[],m:[]}),this.#p.delete(e)}unskip_effect(e,t=e=>this.schedule(e)){var n=this.#f.get(e);if(n){this.#f.delete(e);for(var r of n.d)B(r,E),t(r);for(r of n.m)B(r,D),t(r)}this.#p.add(e)}#g(){var e=[];for(let i of this.#c)if(!(i.f&16384||!(i.f&6144))){for(var t=i,n=!1;t.parent!==null;){t=t.parent;var r=t.f;if(r&96){if(!(r&1024)){n=!0;break}t.f^=T}}n||e.push(t)}return this.#c=[],e}#_(){this.#e=!0;for(let e of this.#u)this.#d.delete(e),B(e,E),this.schedule(e);for(let e of this.#d)B(e,D),this.schedule(e);this.apply();for(var t=nn=[],n=[],r=rn=[];this.#c.length>0;){an++>1e3&&(this.#C(),Ht());for(let e of this.#g())try{this.#v(e,t,n)}catch(t){throw Jt(e),this.#h()||this.discard(),t}}if(V=null,r.length>0){var i=e.ensure();for(let e of r)i.schedule(e)}if(nn=null,rn=null,this.#h()){this.#x(n),this.#x(t);for(let[e,t]of this.#f)qt(e,t);r.length>0&&V.#_();return}let a=this.#y();if(a)this.#x(n),this.#x(t),a.#b(this);else{this.#u.clear(),this.#d.clear();for(let e of this.#r)e(this);this.#r.clear(),Zt=this,Ut(n),Ut(t),Zt=null,this.#s?.resolve();var o=V;if(this.#a===0&&(this.#c.length===0||o!==null)&&(this.#C(),Ye&&(this.#S(),V=o)),this.#c.length>0){if(o!==null){for(let e of this.#c)o.#c.push(e);this.#c=[]}else o=this}o!==null&&(vn.clear(),o.#_())}}#v(e,t,n){e.f^=T;for(var r=e.first;r!==null;){var i=r.f,a=!!(i&96);if(!(a&&i&1024||i&8192||this.#f.has(r))&&r.fn!==null){a?r.f^=T:i&4?t.push(r):Ye&&i&16777224?n.push(r):Er(r)&&(i&16&&this.#d.add(r),Mr(r));var o=r.first;if(o!==null){r=o;continue}}for(;r!==null;){var s=r.next;if(s!==null){r=s;break}r=r.parent}}}#y(){for(var e=this.#t;e!==null;){if(!e.is_fork){for(let[t,[,n]]of this.current)if(e.current.has(t)&&!n)return e}e=e.#t}return null}#b(e){for(let[t,n]of e.current)!this.previous.has(t)&&e.previous.has(t)&&this.previous.set(t,e.previous.get(t)),this.current.set(t,n);for(let[t,n]of e.async_deriveds){let e=this.async_deriveds.get(t);e&&n.promise.then(e.resolve).catch(e.reject)}e.async_deriveds.clear(),this.transfer_effects(e.#u,e.#d);let t=e=>{var n=e.reactions;if(n!==null&&!(e.f&2&&!(e.f&6144)))for(let e of n){var r=e.f;if(r&2)t(e);else{var i=e;r&4194320&&!this.async_deriveds.has(i)&&(this.#d.delete(i),B(i,E),this.schedule(i))}}};for(let e of this.current.keys())t(e);this.oncommit(()=>e.discard()),e.#C(),V=this,this.#_()}#x(e){for(var t=0;t<e.length;t+=1)mt(e[t],this.#u,this.#d)}capture(e,t,n=!1){e.v!==ve&&!this.previous.has(e)&&this.previous.set(e,e.v),e.f&8388608||(this.current.set(e,[t,n]),Qt?.set(e,t)),this.is_fork||(e.v=t)}activate(){V=this}deactivate(){V=null,Qt=null}flush(){try{tn=!0,V=this,this.#_()}finally{an=0,$t=null,nn=null,rn=null,tn=!1,V=null,Qt=null,vn.clear()}}discard(){for(let e of this.#i)e(this);this.#i.clear();for(let e of this.async_deriveds.values())e.reject(zt);this.#C(),this.#s?.resolve()}register_created_effect(e){this.#l.push(e)}#S(){for(let u=Yt;u!==null;u=u.#n){var e=u.id<this.id,t=[];for(let[r,[i,a]]of this.current){if(u.current.has(r)){var n=u.current.get(r)[0];if(e&&i!==n)u.current.set(r,[i,a]);else continue}t.push(r)}if(e)for(let[e,t]of this.async_deriveds){let n=u.async_deriveds.get(e);n&&t.promise.then(n.resolve).catch(n.reject)}var r=[...u.current.keys()].filter(e=>!u.current.get(e)[1]);if(u.#e&&r.length!==0){var i=r.filter(e=>!this.current.has(e));if(i.length===0)e&&u.discard();else if(t.length>0){if(e)for(let e of this.#p)u.unskip_effect(e,e=>{e.f&4194320?u.schedule(e):u.#x([e])});u.activate();var a=new Set,o=new Map;for(var s of t)Wt(s,i,a,o);o=new Map;var c=[...u.current].filter(([e,t])=>{let n=this.current.get(e);return!n||n[0]!==t[0]||n[1]!==t[1]}).map(([e])=>e);if(c.length>0)for(let e of this.#l)!(e.f&155648)&&Gt(e,c,o)&&(e.f&4194320?(B(e,E),u.schedule(e)):u.#u.add(e));if(u.#c.length>0&&!u.#m){u.apply();for(var l of u.#g())u.#v(l,[],[])}u.deactivate()}}}}increment(e,t){if(this.#a+=1,e){let e=this.#o.get(t)??0;this.#o.set(t,e+1)}}decrement(e,t){if(--this.#a,e){let e=this.#o.get(t)??0;e===1?this.#o.delete(t):this.#o.set(t,e-1)}this.#m||(this.#m=!0,st(()=>{this.#m=!1,this.linked&&this.flush()}))}transfer_effects(e,t){for(let t of e)this.#u.add(t);for(let e of t)this.#d.add(e);e.clear(),t.clear()}oncommit(e){this.#r.add(e)}ondiscard(e){this.#i.add(e)}settled(){return(this.#s??=u()).promise}static ensure(){if(V===null){let t=V=new e;!tn&&!en&&st(()=>{t.#e||t.flush()})}return V}apply(){if(!Ye||!this.is_fork&&this.#t===null&&this.#n===null)Qt=null;else{Qt=new Map;for(let[e,[t]]of this.current)Qt.set(e,t);for(let t=Yt;t!==null;t=t.#n)if(!(t===this||t.is_fork)){var e=!1;if(t.id<this.id){for(let[n,[,r]]of t.current)if(!r&&this.current.has(n)){e=!0;break}}if(!e)for(let[e,n]of t.previous)Qt.has(e)||Qt.set(e,n)}}}schedule(e){$t=e,e.b?.is_pending&&e.f&16777228&&!(e.f&32768)?e.b.defer_effect(e):this.#c.push(e)}#C(){if(this.linked){var e=this.#t,t=this.#n;e===null?Yt=t:e.#n=t,t===null?Xt=e:t.#t=e,this.linked=!1}}},cn=null}));function ln(e,t){return{f:0,v:e,reactions:null,equals:Me,rv:0,wv:0}}function un(e,t){let n=ln(e,t);return Sr(n),n}function dn(e,t=!1,n=!0){let r=ln(e);return t||(r.equals=Pe),Xe&&n&&R!==null&&R.l!==null&&(R.l.s??=[]).push(r),r}function fn(e,t,n=!1){return Y!==null&&(!Rr||Y.f&131072)&&at()&&Y.f&4325394&&(zr===null||!zr.has(e))&&Ke(),pn(e,n?Cn(t):t,rn)}function pn(e,t,n=null){if(!e.equals(t)){Lr?vn.set(e,t):vn.has(e)||vn.set(e,e.v);var r=sn.ensure();if(r.capture(e,t),e.f&2){let t=e;e.f&2048&&Ft(t),Qt===null&&dt(t)}e.wv=Tr(),bn=null,xn=0,gn(e,E,n),bn=null,at()&&X!==null&&X.f&1024&&!(X.f&96)&&(Hr===null?Cr([e]):Hr.push(e)),!r.is_fork&&_n.size>0&&!yn&&mn()}return t}function mn(){yn=!1;for(let e of _n){e.f&1024&&B(e,D);let t;try{t=Er(e)}catch{t=!0}t&&Mr(e)}_n.clear()}function hn(e){fn(e,e.v+1)}function gn(e,t,n){var r=e.reactions;if(r!==null){var i=at(),a=r.length;if(xn+=a,xn>1e5&&bn===null&&(bn=new Set),bn!==null){if(bn.has(e))return;bn.add(e)}for(var o=0;o<a;o++){var s=r[o],c=s.f;if(i||s!==X){var l=(c&E)===0;if(l&&B(s,t),c&131072)_n.add(s);else if(c&2){var u=s;Qt?.delete(u),gn(u,D,n)}else if(l){var d=s;c&16&&cn!==null&&cn.add(d),n===null?Kt(d):n.push(d)}}}}}var _n,vn,yn,bn,xn,Sn=e((()=>{s(),Z(),Fe(),N(),Je(),Ze(),$e(),et(),z(),H(),En(),Bt(),pt(),_n=new Set,vn=new Map,yn=!1,bn=null,xn=0}));function Cn(e){if(typeof e!=`object`||!e||M in e||se in e)return e;let t=b(e);if(t!==v&&t!==y)return e;var n=new Map,r=d(e),i=un(0),a=null,o=Gr,s=e=>{if(Gr===o)return e();var t=Y,n=Gr;br(null),wr(o);var r=e();return br(t),wr(n),r};return r&&n.set(`length`,un(e.length,a)),new Proxy(e,{defineProperty(e,t,r){(!(`value`in r)||r.configurable===!1||r.enumerable===!1||r.writable===!1)&&We();var i=n.get(t);return i===void 0?s(()=>{var e=un(r.value,a);return n.set(t,e),e}):fn(i,r.value,!0),!0},deleteProperty(e,t){var r=n.get(t);if(r===void 0){if(t in e){let e=s(()=>un(ve,a));n.set(t,e),hn(i)}}else fn(r,ve),hn(i);return!0},get(t,r,i){if(r===M)return e;var o=n.get(r),c=r in t;if(o===void 0&&(!c||g(t,r)?.writable)&&(o=s(()=>un(Cn(c?t[r]:ve),a)),n.set(r,o)),o!==void 0){var l=J(o);return l===ve?void 0:l}return Reflect.get(t,r,i)},getOwnPropertyDescriptor(e,t){this.has?.(e,t);var r=Reflect.getOwnPropertyDescriptor(e,t),i=n.get(t);if(i!==void 0){var a=J(i);if(a===ve)return;if(r&&`value`in r)r.value=a;else return{enumerable:!0,configurable:!0,value:a,writable:!0}}return r},has(e,t){if(t===M)return!0;var r=n.get(t),i=r!==void 0&&r.v!==ve||Reflect.has(e,t);return(r!==void 0||X!==null&&(!i||g(e,t)?.writable))&&(r===void 0&&(r=s(()=>un(i?Cn(e[t]):ve,a)),n.set(t,r)),J(r)===ve)?!1:i},set(e,t,o,c){var l=n.get(t),u=t in e;if(r&&t===`length`)for(var d=o;d<l.v;d+=1){var f=n.get(d+``);f===void 0?d in e&&(f=s(()=>un(ve,a)),n.set(d+``,f)):fn(f,ve)}if(l===void 0)(!u||g(e,t)?.writable)&&(l=s(()=>un(void 0,a)),fn(l,Cn(o)),n.set(t,l));else{u=l.v!==ve;var p=s(()=>Cn(o));fn(l,p)}var m=Reflect.getOwnPropertyDescriptor(e,t);if(m?.set&&m.set.call(c,o),!u){if(r&&typeof t==`string`){var h=n.get(`length`),_=Number(t);Number.isInteger(_)&&_>=h.v&&fn(h,_+1)}hn(i)}return!0},ownKeys(e){J(i);var t=Reflect.ownKeys(e).filter(e=>{var t=n.get(e);return t===void 0||t.v!==ve});for(var[r,a]of n)a.v!==ve&&!(r in e)&&t.push(r);return t},setPrototypeOf(){Ge()}})}function wn(e){try{if(typeof e==`object`&&e&&M in e)return e[M]}catch{}return e}function Tn(e,t){return Object.is(wn(e),wn(t))}var En=e((()=>{s(),Z(),C(),Sn(),N(),be(),Je(),$e(),et(),Ze()})),Dn=e((()=>{Te(),En()}));function On(){if(Ln===void 0){Ln=window,Rn=document,zn=/Firefox/.test(navigator.userAgent);var e=Element.prototype,t=Node.prototype,n=Text.prototype;Bn=g(t,`firstChild`).get,Vn=g(t,`nextSibling`).get,x(e)&&(e[de]=void 0,e[ue]=null,e[fe]=void 0,e.__e=void 0),x(n)&&(n[pe]=void 0)}}function kn(e=``){return document.createTextNode(e)}function An(e){return Bn.call(e)}function jn(e){return Vn.call(e)}function U(e,t){if(!F)return An(e);var n=An(I);if(n===null)n=I.appendChild(kn());else if(t&&n.nodeType!==3){var r=kn();return n?.before(r),De(r),r}return t&&In(n),De(n),n}function W(e,t=!1){if(!F){var n=An(e);return n instanceof Comment&&n.data===``?jn(n):n}if(t){if(I?.nodeType!==3){var r=kn();return I?.before(r),De(r),r}In(I)}return I}function Mn(e,t=!1){if(!F)return An(e);var n=U(e,t);return P(e),n}function G(e,t=1,n=!1){let r=F?I:e;for(var i;t--;)i=r,r=jn(r);if(!F)return r;if(n){if(r?.nodeType!==3){var a=kn();return r===null?i?.after(a):r.before(a),De(a),a}In(r)}return De(r),r}function Nn(e){e.textContent=``}function Pn(){return!Ye||cn!==null?!1:(X.f&A)!==0}function Fn(e,t,n){return t==null||t===`http://www.w3.org/1999/xhtml`?n?document.createElement(e,{is:n}):document.createElement(e):n?document.createElementNS(t,e,{is:n}):document.createElementNS(t,e)}function In(e){if(e.nodeValue.length<65536)return;let t=e.nextSibling;for(;t!==null&&t.nodeType===3;)t.remove(),e.nodeValue+=t.nodeValue,t=e.nextSibling}var Ln,Rn,zn,Bn,Vn,K=e((()=>{L(),s(),Dn(),C(),Z(),Ze(),N(),H(),be()}));function Hn(e){var t=X;if(t===null)return Y.f|=oe,e;if(!(t.f&32768)&&!(t.f&4))throw e;Un(e,t)}function Un(e,t){if(e===_e)throw e;if(!(t!==null&&t.f&16384)){for(;t!==null;){if(t.f&128&&!(t.f&33570816)){if(!(t.f&32768))throw e;try{t.b.error(e);return}catch(t){e=t}}t=t.parent}throw e}}var Wn=e((()=>{s(),be(),K(),N(),C(),Z()}));function Gn(e){X===null&&(Y===null&&Ve(e),Be()),Lr&&ze(e)}function Kn(e,t){var n=t.last;n===null?t.last=t.first=e:(n.next=e,e.prev=n,t.last=e)}function qn(e,t){var n=X;n!==null&&n.f&8192&&(e|=O);var r={ctx:R,deps:null,nodes:null,f:e|E|512,first:null,fn:t,last:null,next:null,parent:n,b:n&&n.b,prev:null,teardown:null,wv:0,ac:null};V?.register_created_effect(r);var i=r;if(e&4)nn===null?sn.ensure().schedule(r):nn.push(r);else if(t!==null){try{Mr(r)}catch(e){throw lr(r),e}i.deps===null&&i.teardown===null&&i.nodes===null&&i.first===i.last&&!(i.f&524288)&&(i=i.first,e&16&&e&65536&&i!==null&&(i.f|=ee))}if(i!==null&&(i.parent=n,n!==null&&Kn(i,n),Y!==null&&Y.f&2&&!(e&64))){var a=Y;(a.effects??=[]).push(i)}return r}function Jn(){return Y!==null&&!Rr}function Yn(e){let t=qn(8,null);return B(t,T),t.teardown=e,t}function Xn(e){Gn(`$effect`);var t=X.f;if(!Y&&t&32&&R!==null&&!R.i){var n=R;(n.e??=[]).push(e)}else return Zn(e)}function Zn(e){return qn(4|ne,e)}function Qn(e){sn.ensure();let t=qn(64|te,e);return(e={})=>new Promise(n=>{e.outro?fr(t,()=>{lr(t),n(void 0)}):(lr(t),n(void 0))})}function $n(e){return qn(4,e)}function er(e){return qn(ae|te,e)}function tr(e,t=0){return qn(8|t,e)}function nr(e,t=[],n=[],r=[]){wt(r,t,n,t=>{qn(8,()=>{e(...t.map(J))})})}function rr(e,t=0){return qn(16|t,e)}function ir(e,t=0){return qn(w|t,e)}function ar(e){return qn(32|te,e)}function or(e){var t=e.teardown;if(t!==null){let n=Lr,r=Y;yr(!0),br(null);try{t.call(null)}catch(t){Un(t,e.parent)}finally{yr(n),br(r)}}}function sr(e,t=!1){var n=e.first;for(e.first=e.last=null;n!==null;){let e=n.ac;e!==null&&xt(()=>{e.abort(he)});var r=n.next;n.f&64?n.parent=null:lr(n,t),n=r}}function cr(e){for(var t=e.first;t!==null;){var n=t.next;t.f&32||lr(t),t=n}}function lr(e,t=!0){var n=!1;(t||e.f&262144)&&e.nodes!==null&&e.nodes.end!==null&&(ur(e.nodes.start,e.nodes.end),n=!0),e.f|=j,sr(e,t&&!n),jr(e,0);var r=e.nodes&&e.nodes.t;if(r!==null)for(let e of r)e.stop();or(e),e.f^=j,e.f|=k;var i=e.parent;i!==null&&i.first!==null&&dr(e),e.next=e.prev=e.teardown=e.ctx=e.deps=e.fn=e.nodes=e.ac=e.b=null}function ur(e,t){for(;e!==null;){var n=e===t?null:jn(e);e.remove(),e=n}}function dr(e){var t=e.parent,n=e.prev,r=e.next;n!==null&&(n.next=r),r!==null&&(r.prev=n),t!==null&&(t.first===e&&(t.first=r),t.last===e&&(t.last=n))}function fr(e,t,n=!0){var r=[];e.f|=256,pr(e,r,!0);var i=()=>{n&&lr(e),t&&t()},a=r.length;if(a>0){var o=()=>--a||i();for(var s of r)s.out(o)}else i()}function pr(e,t,n){if(!(e.f&8192)){e.f^=O;var r=e.nodes&&e.nodes.t;if(r!==null)for(let e of r)(e.is_global||n)&&t.push(e);for(var i=e.first;i!==null;){var a=i.next;if(!(i.f&64)){var o=!!(i.f&65536)||!!(i.f&32)&&!!(e.f&16);pr(i,t,o?n:!1)}i=a}}}function mr(e){e.f&=-257,hr(e,!0)}function hr(e,t){if(!(e.f&256)&&e.f&8192){e.f^=O,e.f&1024||(B(e,E),sn.ensure().schedule(e));for(var n=e.first;n!==null;){var r=n.next,i=!!(n.f&65536)||!!(n.f&32);hr(n,i?t:!1),n=r}var a=e.nodes&&e.nodes.t;if(a!==null)for(let e of a)(e.is_global||t)&&e.in()}}function gr(e,t){if(e.nodes)for(var n=e.nodes.start,r=e.nodes.end;n!==null;){var i=n===r?null:jn(n);t.append(n),n=i}}var q=e((()=>{Z(),N(),Wn(),Je(),s(),C(),K(),z(),H(),kt(),Ct(),pt()})),_r,vr=e((()=>{Sn(),Z(),_r=null}));function yr(e){Lr=e}function br(e){Y=e}function xr(e){X=e}function Sr(e){Y!==null&&(!Ye&&Y.f&2097152||Y.f&2)&&(zr??=new Set).add(e)}function Cr(e){Hr=e}function wr(e){Gr=e}function Tr(){return++Ur}function Er(e){var t=e.f;if(t&2048)return!0;if(t&4096){for(var n=e.deps,r=n.length,i=0;i<r;i++){var a=n[i];if(Er(a)&&It(a),a.wv>e.wv)return!0}t&512&&Qt===null&&B(e,T)}return!1}function Dr(e,t,n=!0){var r=e.reactions;if(r!==null&&(Ye||zr===null||!zr.has(e)))for(var i=0;i<r.length;i++){var a=r[i];a.f&2?Dr(a,t,!1):t===a&&(n?B(a,E):a.f&1024&&B(a,D),Kt(a))}}function Or(e){var t=Br,n=Vr,r=Hr,i=Y,a=zr,o=R,s=Rr,c=Gr,l=e.f;Br=null,Vr=0,Hr=null,Y=l&96?null:e,zr=null,tt(e.ctx),Rr=!1,Gr=++Wr,e.ac!==null&&(xt(()=>{e.ac.abort(he)}),e.ac=null);try{e.f|=ie;var u=e.fn,d=u();e.f|=A;var f=kr(e);if(at()&&Hr!==null&&!Rr&&f!==null&&!(e.f&6146))for(var p=0;p<Hr.length;p++)Dr(Hr[p],e);if(i!==null&&i!==e){if(Wr++,i.deps!==null)for(let e=0;e<n;e+=1)i.deps[e].rv=Wr;if(t!==null)for(let e of t)e.rv=Wr;Hr!==null&&(r===null?r=Hr:r.push(...Hr))}return e.f&8388608&&(e.f^=oe),d}catch(t){return kr(e),Hn(t)}finally{e.f^=ie,Br=t,Vr=n,Hr=r,Y=i,zr=a,tt(o),Rr=s,Gr=c}}function kr(e){var t=e.deps,n=V?.is_fork;if(Br!==null){var r;if(n||jr(e,Vr),t!==null&&Vr>0)for(t.length=Vr+Br.length,r=0;r<Br.length;r++)t[Vr+r]=Br[r];else e.deps=t=Br;if(Jn()&&e.f&512)for(r=Vr;r<t.length;r++)(t[r].reactions??=[]).push(e)}else!n&&t!==null&&Vr<t.length&&(jr(e,Vr),t.length=Vr);return t}function Ar(e,t){let n=t.reactions;if(n!==null){var r=f.call(n,e);if(r!==-1){var i=n.length-1;i===0?n=t.reactions=null:(n[r]=n[i],n.pop())}}if(n===null&&t.f&2&&(Br===null||!p.call(Br,t))){var a=t;a.f&512&&(a.f^=512),a.v!==ve&&dt(a),a.ac!==null&&xt(()=>{a.ac.abort(he),a.ac=null,B(a,E)}),Lt(a),jr(a,0)}}function jr(e,t){var n=e.deps;if(n!==null)for(var r=t;r<n.length;r++)Ar(e,n[r])}function Mr(e){var t=e.f;if(!(t&16384)){B(e,T);var n=X;X=e;try{t&16777232?cr(e):sr(e),or(e);var r=Or(e);e.teardown=typeof r==`function`?r:null,e.wv=Ur}finally{X=n}}}async function Nr(){if(Ye)return new Promise(e=>{requestAnimationFrame(()=>e()),setTimeout(()=>e())});await Promise.resolve(),Vt()}function J(e){var t=!!(e.f&2);if(_r?.add(e),Y!==null&&!Rr&&!(X!==null&&X.f&16384)&&(zr===null||!zr.has(e))){var n=Y.deps;if(Y.f&2097152)e.rv<Wr&&(e.rv=Wr,Br===null&&n!==null&&n[Vr]===e?Vr++:Br===null?Br=[e]:Br.push(e));else{Y.deps??=[],p.call(Y.deps,e)||Y.deps.push(e);var r=e.reactions;r===null?e.reactions=[Y]:p.call(r,Y)||r.push(Y)}}if(Lr&&vn.has(e))return vn.get(e);if(t){var i=e;if(Lr){var a=i.v;return(!(i.f&1024)&&i.reactions!==null||Fr(i))&&(a=Ft(i)),vn.set(i,a),a}var o=!(i.f&512)&&!Rr&&Y!==null&&!!(Y.f&512),s=(i.f&A)===0;Er(i)&&(o&&(i.f|=512),It(i)),o&&!s&&(Rt(i),Pr(i))}if(Qt?.has(e))return Qt.get(e);if(e.f&8388608)throw e.v;return e.v}function Pr(e){if(e.f|=512,e.deps!==null)for(let n of e.deps){var t=n.reactions;t===null?n.reactions=[e]:p.call(t,e)||t.push(e),n.f&2&&!(n.f&512)&&(Rt(n),Pr(n))}}function Fr(e){if(e.v===ve)return!0;if(e.deps===null)return!1;for(let t of e.deps)if(vn.has(t)||t.f&2&&Fr(t))return!0;return!1}function Ir(e){var t=Rr;try{return Rr=!0,e()}finally{Rr=t}}var Lr,Y,Rr,X,zr,Br,Vr,Hr,Ur,Wr,Gr,Z=e((()=>{s(),C(),q(),N(),Sn(),Bt(),Ze(),$e(),et(),z(),H(),Wn(),be(),vr(),Ct(),pt(),Te(),Lr=!1,Y=null,Rr=!1,X=null,zr=null,Br=null,Vr=0,Hr=null,Ur=1,Wr=0,Gr=Wr})),Kr=e((()=>{$o(),ts(),q()}));function qr(e){return e.endsWith(`capture`)&&e!==`gotpointercapture`&&e!==`lostpointercapture`}function Jr(e){return Zr.includes(e)}function Yr(e){return e=e.toLowerCase(),$r[e]??e}function Xr(e){return ei.includes(e)}var Zr,Qr,$r,ei,ti,ni=e((()=>{Zr=[`beforeinput`,`click`,`change`,`dblclick`,`contextmenu`,`focusin`,`focusout`,`input`,`keydown`,`keyup`,`mousedown`,`mousemove`,`mouseout`,`mouseover`,`mouseup`,`pointerdown`,`pointermove`,`pointerout`,`pointerover`,`pointerup`,`touchend`,`touchmove`,`touchstart`],Qr=`allowfullscreen.async.autofocus.autoplay.checked.controls.default.disabled.formnovalidate.indeterminate.inert.ismap.loop.multiple.muted.nomodule.novalidate.open.playsinline.readonly.required.reversed.seamless.selected.webkitdirectory.defer.disablepictureinpicture.disableremoteplayback`.split(`.`),$r={formnovalidate:`formNoValidate`,ismap:`isMap`,nomodule:`noModule`,playsinline:`playsInline`,readonly:`readOnly`,defaultvalue:`defaultValue`,defaultchecked:`defaultChecked`,srcobject:`srcObject`,novalidate:`noValidate`,allowfullscreen:`allowFullscreen`,disablepictureinpicture:`disablePictureInPicture`,disableremoteplayback:`disableRemotePlayback`},[...Qr],ei=[`touchstart`,`touchmove`],ti=[`$state`,`$state.raw`,`$derived`,`$derived.by`],[...ti]})),ri=e((()=>{N(),ni(),Z()})),ii=e((()=>{N(),L(),z()}));function ai(e,t,n,r={}){function i(e){if(r.capture||li.call(t,e),!e.cancelBubble)return xt(()=>n?.call(this,e))}return e.startsWith(`pointer`)||e.startsWith(`touch`)||e===`wheel`?(i.__removed=!1,st(()=>{i.__removed||t.addEventListener(e,i,r)})):t.addEventListener(e,i,r),i}function oi(e,t,n,r,i){var a={capture:r,passive:i},o=ai(e,t,n,a);(t===document.body||t===window||t===document||t instanceof HTMLMediaElement)&&Yn(()=>{o.__removed=!0,t.removeEventListener(e,o,a)})}function si(e,t,n){(t[ui]??={})[e]=n}function ci(e){for(var t=0;t<e.length;t++)di.add(e[t]);for(var n of fi)n(e)}function li(e){var t=this,n=t.ownerDocument,r=e.type,i=e.composedPath?.()||[],a=i[0]||e.target;pi=e,mi||(mi=!0,setTimeout(()=>{mi=!1,pi=null}));var o=0,s=pi===e&&e[ui];if(s){var c=i.indexOf(s);if(c!==-1&&(t===document||t===window)){e[ui]=t;return}var l=i.indexOf(t);if(l===-1)return;c<=l&&(o=c)}if(a=i[o]||e.target,a!==t){h(e,`currentTarget`,{configurable:!0,get(){return a||n}});var u=Y,d=X;br(null),xr(null);try{for(var f,p=[];a!==null&&a!==t;){try{var m=a[ui]?.[r];m!=null&&(!a.disabled||e.target===a)&&m.call(a,e)}catch(e){f?p.push(e):f=e}if(e.cancelBubble)break;o++,a=o<i.length?i[o]:null}if(f){for(let e of p)queueMicrotask(()=>{throw e});throw f}}finally{e[ui]=t,delete e.currentTarget,br(u),xr(d)}}}var ui,di,fi,pi,mi,hi=e((()=>{q(),C(),L(),ut(),Z(),Ct(),ui=Symbol(`events`),di=new Set,fi=new Set,pi=null,mi=!1}));function gi(e){return vi?.createHTML(e)??e}function _i(e){var t=Fn(`template`);return t.innerHTML=gi(e.replaceAll(`<!>`,`<!---->`)),t.content}var vi,yi=e((()=>{K(),vi=globalThis?.window?.trustedTypes&&globalThis.window.trustedTypes.createPolicy(`svelte-trusted-html`,{createHTML:e=>e})}));function bi(e,t){var n=X;n.nodes===null&&(n.nodes={start:e,end:t,a:null,t:null})}function xi(e,t){var n=!!(t&1),r=!!(t&2),i,a=!e.startsWith(`<!>`);return()=>{if(F)return bi(I,null),I;i===void 0&&(i=_i(a?e:`<!>`+e),n||(i=An(i)));var t=r||zn?document.importNode(i,!0):i.cloneNode(!0);if(n){var o=An(t),s=t.lastChild;bi(o,s)}else bi(t,t);return t}}function Si(e,t,n=`svg`){var r=!e.startsWith(`<!>`),i=!!(t&1),a=`<${n}>${r?e:`<!>`+e}</${n}>`,o;return()=>{if(F)return bi(I,null),I;if(!o){var e=An(_i(a));if(i)for(o=document.createDocumentFragment();An(e);)o.appendChild(An(e));else o=An(e)}var t=o.cloneNode(!0);if(i){var n=An(t),r=t.lastChild;bi(n,r)}else bi(t,t);return t}}function Ci(e,t){return Si(e,t,`svg`)}function wi(){if(F)return bi(I,null),I;var e=document.createDocumentFragment(),t=document.createComment(``),n=kn();return e.append(t,n),bi(t,n),e}function Q(e,t){if(F){var n=X;(!(n.f&32768)||n.nodes.end===null)&&(n.nodes.end=I),Oe()}else e!==null&&e.before(t)}var Ti=e((()=>{L(),K(),yi(),Z(),be(),N()}));function Ei(e){let t=0,n=ln(0),r;return()=>{Jn()&&(J(n),tr(()=>(t===0&&(r=Ir(()=>e(()=>hn(n)))),t+=1,()=>{st(()=>{--t,t===0&&(r?.(),r=void 0,hn(n))})})))}}var Di=e((()=>{Z(),q(),Sn(),$e(),s(),ut()}));function Oi(e,t,n,r){new Ai(e,t,n,r)}var ki,Ai,ji=e((()=>{N(),be(),z(),Wn(),q(),Z(),L(),ut(),Je(),Te(),s(),H(),Sn(),$e(),Di(),K(),ht(),ki=ee|te,Ai=class{parent;is_pending=!1;transform_error;#e;#t=F?I:null;#n;#r;#i;#a=null;#o=null;#s=null;#c=null;#l=0;#u=0;#d=!1;#f=new Set;#p=new Set;#m=null;#h=Ei(()=>(this.#m=ln(this.#l),()=>{this.#m=null}));constructor(e,t,n,r){this.#e=e,this.#n=t,this.#r=e=>{var t=X;t.b=this,t.f|=128,n(e)},this.parent=X.b,this.transform_error=r??this.parent?.transform_error??(e=>e),this.#i=rr(()=>{if(F){let e=je(this.#t);Oe();let t=e===`[!`;if(e.startsWith(`[?`)){let t=JSON.parse(e.slice(2));this.#_(t)}else t?this.#b():this.#g()}else this.#x()},ki),F&&(this.#e=I)}#g(){try{this.#a=ar(()=>this.#r(this.#e))}catch(e){this.error(e)}}#_(e){let t=this.#n.failed,{reset:n,invoke_onerror:r}=this.#v(e);st(r),t&&(this.#s=ar(()=>{t(this.#e,()=>e,()=>n)}))}#v(e){var t=!1,n=!1;let r=()=>{this.#y()||(t?we():(t=!0,n&&qe(),this.#s!==null&&fr(this.#s,()=>{this.#s=null}),this.#C(()=>{this.#x()})))};return{reset:r,invoke_onerror:()=>{if(!this.#y())try{n=!0,this.#n.onerror?.(e,r),n=!1}catch(e){Un(e,this.#i&&this.#i.parent)}}}}#y(){return(this.#i.f&(k|j))!==0}#b(){let e=this.#n.pending;e&&(this.is_pending=!0,this.#o=ar(()=>e(this.#e)),st(()=>{if(!this.#y()){var e=this.#c=document.createDocumentFragment(),t=kn(),n=!1;e.append(t),this.#a=this.#C(()=>{try{return ar(()=>this.#r(t))}catch(e){try{this.error(e),n=!0}catch(e){Un(e,this.#i.parent)}return null}}),this.#a===null?(this.#c=null,n&&this.#S(V)):this.#u===0&&(this.#e.before(e),this.#c=null,fr(this.#o,()=>{this.#o=null}),this.#S(V))}}))}#x(){try{if(this.is_pending=this.has_pending_snippet(),this.#u=0,this.#l=0,this.#a=ar(()=>{this.#r(this.#e)}),this.#u>0){var e=this.#c=document.createDocumentFragment();gr(this.#a,e);let t=this.#n.pending;this.#o=ar(()=>t(this.#e))}else this.#S(V)}catch(e){this.error(e)}}#S(e){this.is_pending=!1,e.transfer_effects(this.#f,this.#p)}defer_effect(e){mt(e,this.#f,this.#p)}is_rendered(){return!this.is_pending&&(!this.parent||this.parent.is_rendered())}has_pending_snippet(){return!!this.#n.pending}#C(e){var t=X,n=Y,r=R;xr(this.#i),br(this.#i),tt(this.#i.ctx);try{return sn.ensure(),e()}finally{xr(t),br(n),tt(r)}}#w(e,t){this.has_pending_snippet()?(this.#u+=e,this.#u===0&&(this.#S(t),this.#o&&fr(this.#o,()=>{this.#o=null}),this.#c&&=(this.#e.before(this.#c),null))):this.parent&&this.parent.#w(e,t)}update_pending_count(e,t){this.#w(e,t),this.#l+=e,!(!this.#m||this.#d)&&(this.#d=!0,st(()=>{this.#d=!1,this.#m&&pn(this.#m,this.#l)}))}get_effect_pending(){return this.#h(),J(this.#m)}error(e){if(e===_e||!this.#n.onerror&&!this.#n.failed)throw e;V?.is_fork?(this.#a&&V.skip_effect(this.#a),this.#o&&V.skip_effect(this.#o),this.#s&&V.skip_effect(this.#s),V.oncommit(()=>{this.#y()||this.#T(e)})):this.#T(e)}#T(e){this.#a&&=(lr(this.#a),null),this.#o&&=(lr(this.#o),null),this.#s&&=(lr(this.#s),null),F&&(De(this.#t),ke(),De(Ae()));let t=this.#n.failed,n=e=>{if(this.#y())return;let{reset:n,invoke_onerror:r}=this.#v(e);r(),t&&!this.#y()&&(this.#s=this.#C(()=>{try{return ar(()=>{var r=X;r.b=this,r.f|=128,t(this.#e,()=>e,()=>n)})}catch(e){return Un(e,this.#i.parent),null}}))};st(()=>{if(!this.#y()){var t;try{t=this.transform_error(e)}catch(e){Un(e,this.#i&&this.#i.parent);return}typeof t==`object`&&t&&typeof t.then==`function`?t.then(n,e=>Un(e,this.#i&&this.#i.parent)):n(t)}})}}}));function Mi(e,t){var n=t==null?``:typeof t==`object`?`${t}`:t;n!==(e[pe]??=e.nodeValue)&&(e[pe]=n,e.nodeValue=`${n}`)}function Ni(e,t){return Pi(e,t)}function Pi(e,{target:t,anchor:n,props:r={},events:i,context:a,intro:o=!0,transformError:s}){On();var c=void 0,l=Qn(()=>{var l=n??t.appendChild(kn());Oi(l,{pending:()=>{}},t=>{nt({});var n=R;if(a&&(n.c=a),i&&(r.$$events=i),F&&bi(t,null),Fi=o,c=e(t,r)||it(),Fi=!0,F&&(X.nodes.end=I,I===null||I.nodeType!==8||I.data!==`]`))throw Se(),_e;rt()},s);var u=new Set,d=e=>{for(var n=0;n<e.length;n++){var r=e[n];if(!u.has(r)){u.add(r);var i=Xr(r);for(let e of[t,document]){var a=Ii.get(e);a===void 0&&(a=new Map,Ii.set(e,a));var o=a.get(r);o===void 0?(e.addEventListener(r,li,{passive:i}),a.set(r,1)):a.set(r,o+1)}}}};return d(m(di)),fi.add(d),()=>{for(var e of u)for(let n of[t,document]){var r=Ii.get(n),i=r.get(e);--i==0?(n.removeEventListener(e,li),r.delete(e),r.size===0&&Ii.delete(n)):r.set(e,i)}fi.delete(d),l!==n&&l.parentNode?.removeChild(l)}});return Li.set(c,l),c}var Fi,Ii,Li,Ri=e((()=>{s(),K(),be(),Z(),z(),q(),L(),C(),hi(),Te(),Je(),Ti(),ni(),N(),ji(),Fi=!0,Ii=new Map,Li=new WeakMap})),zi=e((()=>{N(),L(),q(),Sn(),Ri(),Z()})),Bi=e((()=>{C(),N(),z(),ni()})),Vi=e((()=>{Je(),z()})),Hi=e((()=>{Qe(),q(),Z(),et()})),Ui=e((()=>{kt(),Z(),L(),Ti()})),Wi=e((()=>{Je()})),Gi,Ki=e((()=>{H(),q(),N(),L(),K(),s(),Gi=class{anchor;#e=new Map;#t=new Map;#n=new Map;#r=new Set;#i=!0;constructor(e,t=!0){this.anchor=e,this.#i=t}#a=e=>{if(this.#e.has(e)){var t=this.#e.get(e),n=this.#t.get(t);if(n)mr(n),this.#r.delete(t);else{var r=this.#n.get(t);r&&(mr(r.effect),this.#t.set(t,r.effect),this.#n.delete(t),r.fragment.lastChild.remove(),this.anchor.before(r.fragment),n=r.effect)}for(let[t,n]of this.#e){if(this.#e.delete(t),t===e)break;let r=this.#n.get(n);r&&(lr(r.effect),this.#n.delete(n))}for(let[e,r]of this.#t){if(e===t||this.#r.has(e))continue;let i=()=>{if(Array.from(this.#e.values()).includes(e)){var t=document.createDocumentFragment();gr(r,t),t.append(kn()),this.#n.set(e,{effect:r,fragment:t})}else lr(r);this.#r.delete(e),this.#t.delete(e)};this.#i||!n?(this.#r.add(e),fr(r,i,!1)):i()}}};#o=e=>{this.#e.delete(e);let t=Array.from(this.#e.values());for(let[e,n]of this.#n)t.includes(e)||(lr(n.effect),this.#n.delete(e))};ensure(e,t){var n=V,r=Pn();if(t&&!this.#t.has(e)&&!this.#n.has(e)){if(r){var i=document.createDocumentFragment(),a=kn();i.append(a),this.#n.set(e,{effect:ar(()=>t(a)),fragment:i})}else this.#t.set(e,ar(()=>t(this.anchor)))}if(this.#e.set(n,e),r){for(let[t,r]of this.#t)t===e?n.unskip_effect(r):n.skip_effect(r);for(let[t,r]of this.#n)t===e?n.unskip_effect(r.effect):n.skip_effect(r.effect);n.oncommit(this.#a),n.ondiscard(this.#o)}else F&&(this.anchor=I),this.#a(n)}}})),qi=e((()=>{C(),q(),Sn(),L(),ut(),z(),H(),Ki(),kt()}));function Ji(e,t,n=!1){var r;F&&(r=I,Oe());var i=new Gi(e),a=n?ee:0;function o(e,t){if(F){var n=je(r);if(e!==parseInt(n.substring(1))){var a=Ae();De(a),i.anchor=a,Ee(!1),i.ensure(e,t),Ee(!0);return}}i.ensure(e,t)}rr(()=>{var e=!1;t((t,n=0)=>{e=!0,o(n,t)}),e||o(-1,null)},a)}var Yi=e((()=>{N(),L(),q(),Ki()}));function Xi(e,t,n){F&&Oe();var r=new Gi(e),i=!at();rr(()=>{var e=t();e!==e&&(e=Zi),i&&typeof e==`object`&&e&&(e={}),r.ensure(e,n)})}var Zi,Qi=e((()=>{z(),q(),L(),Ki(),Zi=Symbol(`NaN`)})),$i=e((()=>{q(),L(),K()}));function ea(e,t){return t}function ta(e,t,n){for(var r=[],i=t.length,a,o=t.length,s=0;s<i;s++){let n=t[s];fr(n,()=>{if(a){if(a.pending.delete(n),a.done.add(n),a.pending.size===0){var t=e.outrogroups;na(e,m(a.done)),t.delete(a),t.size===0&&(e.outrogroups=null)}}else--o},!1)}if(o===0){var c=r.length===0&&n!==null&&e.pending.size===0;if(c){var l=n,u=l.parentNode;Nn(u),u.append(l),e.items.clear()}na(e,t,!c)}else a={pending:new Set(t),done:new Set},(e.outrogroups??=new Set).add(a)}function na(e,t,n=!0){var r;if(e.pending.size>0){r=new Set;for(let t of e.pending.values())for(let n of t)r.add(e.items.get(n).e)}for(var i=0;i<t.length;i++){var a=t[i];r?.has(a)?(a.f|=re,gr(a,document.createDocumentFragment())):lr(t[i],n)}}function ra(e,t,n,r,i,a=null){var o=e,s=new Map;if(t&4){var c=e;o=F?De(An(c)):c.appendChild(kn())}F&&Oe();var l=null,u=Nt(()=>{var e=n();return d(e)?e:e==null?[]:m(e)}),f=new Map,p=!0;function h(e){if(!(_.effect.f&16384)){_.pending.delete(e);var n=J(u);_.fallback=l,aa(_,n,o,t,r),l!==null&&(n.length===0?l.f&33554432?(l.f^=re,sa(l,null,o)):mr(l):fr(l,()=>{l=null}))}}function g(e){_.pending.delete(e)}var _={effect:rr(()=>{var e=J(u),c=e.length;let d=!1;F&&je(o)===`[!`!=(c===0)&&(o=Ae(),De(o),Ee(!1),d=!0);for(var m=new Set,_=V,v=Pn(),y=0;y<c;y+=1){F&&I.nodeType===8&&I.data===`]`&&(o=I,d=!0,Ee(!1));var b=e[y],x=r(b,y),S=p?null:s.get(x);S?(S.v&&pn(S.v,b),S.i&&pn(S.i,y),v&&_.unskip_effect(S.e)):(S=oa(s,p?o:la??=kn(),b,x,y,i,t,n),p||(S.e.f|=re),s.set(x,S)),m.add(x)}if(c===0&&a&&!l&&(p?l=ar(()=>a(o)):(l=ar(()=>a(la??=kn())),l.f|=re)),c>m.size&&Re(``,``,``),F&&c>0&&De(Ae()),!p){if(f.set(_,m),v){for(let[e,t]of s)m.has(e)||_.skip_effect(t.e);_.oncommit(h),_.ondiscard(g)}else h(_)}d&&Ee(!0),J(u)}),flags:t,items:s,pending:f,outrogroups:null,fallback:l};p=!1,F&&(o=I)}function ia(e){for(;e!==null&&!(e.f&32);)e=e.next;return e}function aa(e,t,n,r,i){var a=!!(r&8),o=t.length,s=e.items,c=ia(e.effect.first),l,u=null,d,f=[],p=[],h,g,_,v;if(a)for(v=0;v<o;v+=1)h=t[v],g=i(h,v),_=s.get(g).e,_.f&33554432||(_.nodes?.a?.measure(),(d??=new Set).add(_));for(v=0;v<o;v+=1){if(h=t[v],g=i(h,v),_=s.get(g).e,e.outrogroups!==null)for(let t of e.outrogroups)t.pending.delete(_),t.done.delete(_);if(_.f&8192&&(mr(_),a&&(_.nodes?.a?.unfix(),(d??=new Set).delete(_))),_.f&33554432){if(_.f^=re,_===c)sa(_,null,n);else{var y=u?u.next:c;_===e.effect.last&&(e.effect.last=_.prev),_.prev&&(_.prev.next=_.next),_.next&&(_.next.prev=_.prev),ca(e,u,_),ca(e,_,y),sa(_,y,n),u=_,f=[],p=[],c=ia(u.next);continue}}if(_!==c){if(l!==void 0&&l.has(_)){if(f.length<p.length){var b=p[0],x;u=b.prev;var S=f[0],C=f[f.length-1];for(x=0;x<f.length;x+=1)sa(f[x],b,n);for(x=0;x<p.length;x+=1)l.delete(p[x]);ca(e,S.prev,C.next),ca(e,u,S),ca(e,C,b),c=b,u=C,--v,f=[],p=[]}else l.delete(_),sa(_,c,n),ca(e,_.prev,_.next),ca(e,_,u===null?e.effect.first:u.next),ca(e,u,_),u=_;continue}for(f=[],p=[];c!==null&&c!==_;)(l??=new Set).add(c),p.push(c),c=ia(c.next);if(c===null)continue}_.f&33554432||f.push(_),u=_,c=ia(_.next)}if(e.outrogroups!==null){for(let t of e.outrogroups)t.pending.size===0&&(na(e,m(t.done)),e.outrogroups?.delete(t));e.outrogroups.size===0&&(e.outrogroups=null)}if(c!==null||l!==void 0){var w=[];if(l!==void 0)for(_ of l)_.f&8192||w.push(_);for(;c!==null;)!(c.f&8192)&&c!==e.fallback&&w.push(c),c=ia(c.next);var T=w.length;if(T>0){var E=r&4&&o===0?n:null;if(a){for(v=0;v<T;v+=1)w[v].nodes?.a?.measure();for(v=0;v<T;v+=1)w[v].nodes?.a?.fix()}ta(e,w,E)}}a&&st(()=>{if(d!==void 0)for(_ of d)_.nodes?.a?.apply()})}function oa(e,t,n,r,i,a,o,s){var c=o&1?o&16?ln(n):dn(n,!1,!1):null,l=o&2?ln(i):null;return{v:c,i:l,e:ar(()=>(a(t,c??n,l??i,s),()=>{e.delete(r)}))}}function sa(e,t,n){if(e.nodes)for(var r=e.nodes.start,i=e.nodes.end,a=t&&!(t.f&33554432)?t.nodes.start:n;r!==null;){var o=jn(r);if(a.before(r),r===i)return;r=o}}function ca(e,t,n){t===null?e.effect.first=n:t.next=n,n===null?e.effect.last=t:n.prev=t}var la,ua=e((()=>{be(),L(),K(),q(),Sn(),C(),N(),ut(),Z(),s(),Bt(),H(),Je(),$e()})),da=e((()=>{q(),L(),Ti(),ni(),z(),K(),Z(),N()})),fa=e((()=>{L(),K(),Ti()})),pa=e((()=>{ni(),Ie()})),ma=e((()=>{N(),q(),z(),L(),yi(),Ti(),Je(),K(),pa(),Ki()})),ha=e((()=>{N(),q(),L(),Ki()})),ga,_a,va=e((()=>{C(),s(),ga=()=>performance.now(),_a={tick:e=>requestAnimationFrame(e),now:()=>ga(),tasks:new Set}}));function ya(){let e=_a.now();_a.tasks.forEach(t=>{t.c(e)||(_a.tasks.delete(t),t.f())}),_a.tasks.size!==0&&_a.tick(ya)}function ba(e){let t;return _a.tasks.size===0&&_a.tick(ya),{promise:new Promise(n=>{_a.tasks.add(t={c:e,f:n})}),abort(){_a.tasks.delete(t)}}}var xa=e((()=>{va()}));function Sa(e,t){xt(()=>{e.dispatchEvent(new CustomEvent(t))})}function Ca(e){if(e===`float`)return`cssFloat`;if(e===`offset`)return`cssOffset`;if(e.startsWith(`--`))return e;let t=e.split(`-`);return t.length===1?t[0]:t[0]+t.slice(1).map(e=>e[0].toUpperCase()+e.slice(1)).join(``)}function wa(e){let t={},n=e.split(`;`);for(let e of n){let[n,r]=e.split(`:`);if(!n||r===void 0)break;let i=Ca(n.trim());t[i]=r.trim()}return t}function Ta(e,t,n,r){var i=!!(e&1),a=!!(e&2),o=i&&a,s=!!(e&4),c=o?`both`:i?`in`:`out`,l,u=t.inert,d=t.style.overflow,f,p;function m(){return xt(()=>l??=n()(t,r?.()??{},{direction:c}))}var h={is_global:s,in(){t.inert=u,i?(a||f?.abort(),f=Ea(t,m(),p,1,()=>{Sa(t,`introstart`)},()=>{Sa(t,`introend`),f?.abort(),f=l=void 0,t.style.overflow=d})):(p?.abort(),p?.reset?.())},out(e){a?(t.inert=!0,p=Ea(t,m(),f,0,()=>{Sa(t,`outrostart`)},()=>{Sa(t,`outroend`),e?.()})):(e?.(),l=void 0)},stop:()=>{f?.abort(),p?.abort()}},g=X;if((g.nodes.t??=[]).push(h),i&&Fi){var _=s;if(!_){for(var v=g.parent;v&&v.f&65536;)for(;(v=v.parent)&&!(v.f&16););_=!v||!!(v.f&32768)}_&&$n(()=>{Ir(()=>h.in())})}}function Ea(e,t,n,r,i,a){var o=r===1,s=!1;if(c(t)){var l;return st(()=>{s||(l=Ea(e,t({direction:o?`in`:`out`}),n,r,i,a))}),{abort:()=>{s=!0,l?.abort()},deactivate:()=>l?.deactivate(),reset:()=>l?.reset(),t:()=>l?.t()??1-r}}if(n?.deactivate(),!t?.duration&&!t?.delay)return i(),a(),{abort:S,deactivate:S,reset:S,t:()=>r};let{delay:u=0,css:d,tick:f,easing:p=Da}=t;var m,h=()=>1-r;return st(()=>{if(!s){var c=[];if(o&&n===void 0&&(f&&f(0,1),d)){var l=wa(d(0,1));c.push(l,l)}m=e.animate(c,{duration:u,fill:`forwards`}),m.onfinish=()=>{m.cancel(),i();var o=n?.t()??1-r;n?.abort();var s=r-o,c=t.duration*Math.abs(s),l=[];if(c>0){var u=!1;if(d)for(var g=Math.ceil(c/(1e3/60)),_=0;_<=g;_+=1){var v=o+s*p(_/g),y=wa(d(v,1-v));l.push(y),u||=y.overflow===`hidden`}u&&(e.style.overflow=`hidden`),h=()=>{var e=m.currentTime;return o+s*p(e/c)},f&&ba(()=>{if(m.playState!==`running`)return!1;var e=h();return f(e,1-e),!0})}m=e.animate(l,{duration:c,fill:`forwards`}),m.onfinish=()=>{h=()=>r,f?.(r,1-r),a()}}}}),{abort:()=>{s=!0,m&&(m.cancel(),m.effect=null,m.onfinish=S)},deactivate:()=>{a=S},reset:()=>{r===0&&f?.(1,0)},t:()=>h()}}var Da,Oa=e((()=>{C(),q(),Z(),xa(),Ri(),be(),N(),ut(),Ct(),Da=e=>e})),ka=e((()=>{L(),K(),q(),Ri(),Z(),z(),N(),Ti(),ni(),Ki(),Oa()})),Aa=e((()=>{L(),K(),q(),N()})),ja=e((()=>{q(),K(),Z()})),Ma=e((()=>{q(),Z()}));function Na(e,t){var n=void 0,r;ir(()=>{n!==(n=t())&&(r&&=(lr(r),null),n&&(r=ar(()=>{$n(()=>n(e))})))})}var Pa=e((()=>{q()}));function Fa(e){var t,n,r=``;if(typeof e==`string`||typeof e==`number`)r+=e;else if(typeof e==`object`){if(Array.isArray(e)){var i=e.length;for(t=0;t<i;t++)e[t]&&(n=Fa(e[t]))&&(r&&(r+=` `),r+=n)}else for(n in e)e[n]&&(r&&(r+=` `),r+=n)}return r}function Ia(){for(var e,t,n=0,r=``,i=arguments.length;n<i;n++)(e=arguments[n])&&(t=Fa(e))&&(r&&(r+=` `),r+=t);return r}var La=e((()=>{}));function Ra(e){return typeof e==`object`?Ia(e):e??``}function za(e,t,n){var r=e==null?``:``+e;if(t&&(r=r?r+` `+t:t),n){for(var i of Object.keys(n))if(n[i])r=r?r+` `+i:i;else if(r.length)for(var a=i.length,o=0;(o=r.indexOf(i,o))>=0;){var s=o+a;(o===0||Ua.includes(r[o-1]))&&(s===r.length||Ua.includes(r[s]))?r=(o===0?``:r.substring(0,o))+r.substring(s+1):o=s}}return r===``?null:r}function Ba(e,t=!1){var n=t?` !important;`:`;`,r=``;for(var i of Object.keys(e)){var a=e[i];a!=null&&a!==``&&(r+=` `+i+`: `+a+n)}return r}function Va(e){return e[0]!==`-`||e[1]!==`-`?e.toLowerCase():e}function Ha(e,t){if(t){var n=``,r,i;if(Array.isArray(t)?(r=t[0],i=t[1]):r=t,e){e=String(e).replaceAll(/\/\*.*?\*\//g,``).trim();var a=!1,o=0,s=!1,c=[];r&&c.push(...Object.keys(r).map(Va)),i&&c.push(...Object.keys(i).map(Va));var l=0,u=-1;let t=e.length;for(var d=0;d<t;d++){var f=e[d];if(s?f===`/`&&e[d-1]===`*`&&(s=!1):a?a===f&&(a=!1):f===`/`&&e[d+1]===`*`?s=!0:f===`"`||f===`'`?a=f:f===`(`?o++:f===`)`&&o--,!s&&a===!1&&o===0){if(f===`:`&&u===-1)u=d;else if(f===`;`||d===t-1){if(u!==-1){var p=Va(e.substring(l,u).trim());if(!c.includes(p)){f!==`;`&&d++;var m=e.substring(l,d).trim();n+=` `+m+`;`}}l=d+1,u=-1}}}}return r&&(n+=Ba(r)),i&&(n+=Ba(i,!0)),n=n.trim(),n===``?null:n}return e==null?null:String(e)}var Ua,Wa=e((()=>{La(),C(),Ua=[...` 	
\r\f\xA0\v﻿`]}));function Ga(e,t,n,r,i,a){var o=e[de];if(F||o!==n||o===void 0){var s=za(n,r,a);(!F||s!==e.getAttribute(`class`))&&(s==null?e.removeAttribute(`class`):t?e.className=s:e.setAttribute(`class`,s)),e[de]=n}else if(a&&i!==a)for(var c in a){var l=!!a[c];(i==null||l!==!!i[c])&&e.classList.toggle(c,l)}return a}var Ka=e((()=>{Wa(),N(),L()}));function qa(e,t={},n,r){for(var i in n){var a=n[i];t[i]!==a&&(n[i]==null?e.style.removeProperty(i):e.style.setProperty(i,a,r))}}function Ja(e,t,n,r){var i=e[fe];if(F||i!==t){var a=Ha(t,r);(!F||a!==e.getAttribute(`style`))&&(a==null?e.removeAttribute(`style`):e.style.cssText=a),e[fe]=t}else r&&(Array.isArray(r)?(qa(e,n?.[0],r[0]),qa(e,n?.[1],r[1],`important`)):qa(e,n,r));return r}var Ya=e((()=>{Wa(),N(),L()}));function Xa(e,t){t?e.hasAttribute(`selected`)||e.setAttribute(`selected`,``):e.removeAttribute(`selected`)}function Za(e,t){var n=!(`__defaultValue`in e);(n||e.__defaultValue!==t)&&(e.__defaultValue=t,Qa(e,!n||`__value`in e))}function Qa(e,t){var n=e.__defaultValue,r=e.multiple,i=r?n??[]:null;if(!r||d(i)){var a=e.selectedIndex,o=t&&r?new Set(e.selectedOptions):null;for(var s of e.options){var c=to(s);Xa(s,r?i.includes(c):Tn(c,n))}if(t){if(o!==null)for(s of e.options){var l=o.has(s);s.selected!==l&&(s.selected=l)}else e.selectedIndex!==a&&(e.selectedIndex=a)}}}function $a(e,t,n=!1){if(e.multiple){if(t==null)return;if(!d(t))return Ce();for(var r of e.options)r.selected=t.includes(to(r))}else{for(r of e.options)if(Tn(to(r),t)){r.selected=!0;return}(!n||t!==void 0)&&(e.selectedIndex=-1)}}function eo(e){var t=new MutationObserver(t=>{t.every(no)||(`__defaultValue`in e&&Qa(e,!1),`__value`in e&&$a(e,e.__value))});t.observe(e,{childList:!0,subtree:!0,attributes:!0,attributeFilter:[`value`]}),Yn(()=>{t.disconnect()})}function to(e){return`__value`in e?e.__value:e.value}function no(e){if(e.target.closest(`selectedcontent`)!==null)return!0;if(e.type===`childList`){var t=[...e.addedNodes,...e.removedNodes];return t.length>0&&t.every(e=>e.nodeName===`SELECTEDCONTENT`)}return!1}var ro=e((()=>{q(),Ct(),En(),C(),Te(),H()}));function io(e){if(F){var t=!1,n=()=>{if(!t){if(t=!0,e.hasAttribute(`value`)){var n=e.value;ao(e,`value`,null),e.value=n}if(e.hasAttribute(`checked`)){var r=e.checked;ao(e,`checked`,null),e.checked=r}}};e[me]=n,st(n),vt()}}function ao(e,t,n,r){var i=co(e);F&&(i[t]=e.getAttribute(t),t===`src`||t===`srcset`||t===`href`&&e.nodeName===ho)||i[t]!==(i[t]=n)&&(t===`loading`&&(e[le]=n),n==null?e.removeAttribute(t):typeof n!=`string`&&lo(e).has(t)?e[t]=n:e.setAttribute(t,n))}function oo(e,t,n,r,i=!1,a=!1){F&&i&&e.nodeName===go&&(`defaultValue`in n||`defaultChecked`in n||io(e));var o=co(e),s=o[po],c=!o[mo];let l=F&&s;l&&Ee(!1);var u=t||{},d=e.nodeName===_o,f=e.nodeName===vo;try{for(var p in t)!(p in n)&&p[0]+p[1]!==`$$`&&(n[p]=null);n.class?n.class=Ra(n.class):(r||n[uo])&&(n.class=null),n[fo]&&(n.style??=null);var m=lo(e);if(e.nodeName===go&&`type`in n&&(`value`in n||`__value`in n)){var h=n.type;(h!==u.type||h===void 0&&e.hasAttribute(`type`))&&(u.type=h,ao(e,`type`,h,a))}for(let i in n){let l=n[i];if(d&&i===`value`&&l==null)e.value=e.__value=``,u[i]=l;else if(i===`class`)Ga(e,e.namespaceURI===`http://www.w3.org/1999/xhtml`,l,r,t?.[uo],n[uo]),u[i]=l,u[uo]=n[uo];else if(i===`style`)Ja(e,l,t?.[fo],n[fo]),u[i]=l,u[fo]=n[fo];else{var g=u[i];if(l!==g||l===void 0&&e.hasAttribute(i)){u[i]=l;var _=i[0]+i[1];if(_!==`$$`){if(_===`on`){let t={},n=`$$`+i,r=i.slice(2);var v=Jr(r);if(qr(r)&&(r=r.slice(0,-7),t.capture=!0),!v&&g){if(l!=null)continue;e.removeEventListener(r,u[n],t),u[n]=null}if(v)si(r,e,l),ci([r]);else if(l!=null){function a(e){u[i].call(this,e)}u[n]=ai(r,e,a,t)}}else if(i===`style`)ao(e,i,l);else if(i===`autofocus`)_t(e,!!l);else if(!s&&(i===`__value`||i===`value`&&l!=null))e.__value=l,(g==null||e.value!==l||l===0&&e.nodeName===yo)&&(e.value=l);else if(i===`selected`&&d)Xa(e,l);else{var y=i;c||(y=Yr(y));var b=y===`defaultValue`||y===`defaultChecked`;if(f&&y===`defaultValue`)continue;if(l==null&&!s&&!b){if(o[i]=null,y===`value`||y===`checked`){let n=e,r=t===void 0;if(y===`value`){let e=n.defaultValue;n.removeAttribute(y),n.defaultValue=e,n.value=n.__value=r?e:null}else{let e=n.defaultChecked;n.removeAttribute(y),n.defaultChecked=e,n.checked=r?e:!1}}else e.removeAttribute(i)}else b||(s||typeof l!=`string`)&&m.has(y)?(e[y]=l,y in o&&(o[y]=ve)):typeof l!=`function`&&ao(e,y,l,a)}}}}}}finally{l&&Ee(!0)}return u}function so(e,t,n=[],r=[],i=[],a,o=!1,s=!1){wt(i,n,r,n=>{var r=void 0,i={},c=e.nodeName===vo,l=!1;if(ir(()=>{var u=t(...n.map(J)),d=oo(e,r,u,a,o,s);if(l&&c){var f=e;`defaultValue`in u&&Za(f,u.defaultValue),`value`in u&&$a(f,u.value)}for(let e of Object.getOwnPropertySymbols(i))u[e]||lr(i[e]);for(let t of Object.getOwnPropertySymbols(u)){var p=u[t];t.description===`@attach`&&(!r||p!==r[t])&&(i[t]&&lr(i[t]),i[t]=ar(()=>Na(e,()=>p))),d[t]=p}r=d}),c){var u=e;$n(()=>{var e=r;`defaultValue`in e&&Za(u,e.defaultValue),$a(u,e.value,!0),eo(u)})}l=!0})}function co(e){return e[ue]??={[po]:e.nodeName.includes(`-`),[mo]:e.namespaceURI===ye}}function lo(e){var t=e.getAttribute(`is`)||e.nodeName,n=bo.get(t);if(n)return n;bo.set(t,n=new Set);for(var r,i=e,a=Element.prototype;a!==i;){for(var o in r=_(i),r)r[o].set&&o!==`innerHTML`&&o!==`textContent`&&o!==`innerText`&&n.add(o);i=b(i)}return n}var uo,fo,po,mo,ho,go,_o,vo,yo,bo,xo=e((()=>{s(),L(),C(),hi(),bt(),Te(),N(),ut(),ni(),Z(),Pa(),Wa(),Ka(),Ya(),be(),q(),ro(),kt(),uo=Symbol(`class`),fo=Symbol(`style`),po=Symbol(`is custom element`),mo=Symbol(`is html`),ho=ge?`link`:`LINK`,go=ge?`input`:`INPUT`,_o=ge?`option`:`OPTION`,vo=ge?`select`:`SELECT`,yo=ge?`progress`:`PROGRESS`,bo=new Map})),So=e((()=>{L(),K(),yi(),Pa()})),Co=e((()=>{Ct()}));function wo(e,t,n=t){var r=new WeakSet;St(e,`input`,async i=>{var a=i?e.defaultValue:e.value;if(a=To(e)?Eo(a):a,n(a),V!==null&&r.add(V),await Nr(),a!==(a=t())){var o=e.selectionStart,s=e.selectionEnd,c=e.value.length;if(e.value=a??``,s!==null){var l=e.value.length;o===s&&s===c&&l>c?(e.selectionStart=l,e.selectionEnd=l):(e.selectionStart=o,e.selectionEnd=Math.min(s,l))}}}),(F&&e.defaultValue!==e.value||Ir(t)==null&&e.value)&&(n(To(e)?Eo(e.value):e.value),V!==null&&r.add(V)),tr(()=>{var n=t();if(e===document.activeElement){var i=Ye?Zt:V;if(r.has(i))return}To(e)&&n===Eo(e.value)||(e.type!==`date`||n||e.value)&&n!==e.value&&(e.value=n??``)})}function To(e){var t=e.type;return t===`number`||t===`range`}function Eo(e){return e===``?null:+e}var Do=e((()=>{s(),q(),Ct(),Je(),En(),ut(),L(),Z(),H(),Ze()})),Oo=e((()=>{q(),Ct()})),ko=e((()=>{Ct()})),Ao=e((()=>{q(),C()})),jo=e((()=>{q(),Z()}));function Mo(e,t){return e===t||e?.[M]===t}function No(e=it(),t,n,r){var i=R.r,a=X;return $n(()=>{var o,s;return tr(()=>{o=s,s=r?.()||[],Ir(()=>{Mo(n(...s),e)||(t(e,...s),o&&Mo(n(...o),e)&&t(null,...o))})}),()=>{let r=a;for(;r!==i&&r.parent!==null&&r.parent.f&33554432;)r=r.parent;let o=()=>{s&&Mo(n(...s),e)&&t(null,...s)},c=r.teardown;r.teardown=()=>{o(),c?.()}}}),e}var Po=e((()=>{N(),z(),q(),Z()})),Fo=e((()=>{q(),Ct()})),Io=e((()=>{q(),Ct()})),Lo=e((()=>{C(),q(),hi()})),Ro=e((()=>{C(),z(),Bt(),q(),Z()})),zo=e((()=>{Sn(),Z(),C()})),Bo=e((()=>{Z(),C()})),Vo=e((()=>{C(),Bo()}));function Ho(e){var t=Uo;try{return Uo=!1,[e(),Uo]}finally{Uo=t}}var Uo,Wo=e((()=>{Bo(),Vo(),C(),Z(),q(),Sn(),Uo=!1}));function Go(e,t,n){return new Proxy({props:e,exclude:t},qo)}function Ko(e,t,n,r){var i=!Xe||!!(n&2),a=!!(n&8),o=!!(n&16),s=r,c=!0,l=void 0,u=()=>o&&i?(l??=At(r),J(l)):(c&&(c=!1,s=o?Ir(r):r),s);let d;if(a){var f=M in e||ce in e;d=g(e,t)?.set??(f&&t in e?n=>e[t]=n:void 0)}var p,m=!1;a?[p,m]=Ho(()=>e[t]):p=e[t],p===void 0&&r!==void 0&&(p=u(),d&&(i&&Ue(t),d(p)));var h=i?()=>{var n=e[t];return n===void 0?u():(c=!0,n)}:()=>{var n=e[t];return n!==void 0&&(s=void 0),n===void 0?s:n};if(i&&!(n&4))return h;if(d){var _=e.$$legacy;return(function(e,t){return arguments.length>0?((!i||!t||_||m)&&d(t?h():e),e):h()})}var v=!1,y=(n&1?At:Nt)(()=>(v=!1,h()));a&&J(y);var b=X;return(function(e,t){if(arguments.length>0){let n=t?J(y):i&&a?Cn(e):e;return fn(y,n),v=!0,s!==void 0&&(s=n),e}return Lr&&v||b.f&16384?y.v:J(y)})}var qo,Jo=e((()=>{s(),be(),C(),Sn(),Bt(),Z(),Je(),N(),En(),Wo(),Ze(),q(),qo={get(e,t){if(!e.exclude.has(t))return e.props[t]},set(e,t){return!1},getOwnPropertyDescriptor(e,t){if(!e.exclude.has(t)&&t in e.props)return{enumerable:!0,configurable:!0,value:e.props[t]}},has(e,t){return!e.exclude.has(t)&&t in e.props},ownKeys(e){return Reflect.ownKeys(e.props).filter(t=>!e.exclude.has(t))}}})),Yo=e((()=>{z(),q(),Wo(),kt()})),Xo=e((()=>{N(),q(),Sn(),Ri(),Z(),H(),C(),Je(),z(),Ze(),pt(),Lo()})),Zo=e((()=>{Xo(),q(),Ti(),C(),K()})),Qo=e((()=>{N(),Qe(),Z()})),$o=e((()=>{Kr(),be(),z(),ri(),ii(),zi(),Bi(),Vi(),$e(),Hi(),Ui(),Wi(),qi(),Yi(),Qi(),$i(),ua(),da(),fa(),ma(),ha(),ka(),Aa(),ja(),Ma(),Pa(),xo(),Ka(),hi(),bt(),So(),Ya(),Oa(),Co(),Do(),Oo(),ko(),Ao(),ro(),jo(),Po(),Fo(),Io(),L(),Lo(),Ro(),zo(),Ti(),kt(),H(),Bt(),q(),Sn(),Jo(),Wo(),ji(),vr(),Ri(),Z(),Yo(),va(),En(),Zo(),K(),Wa(),Qe(),C(),pa(),Dn(),Qo()})),es=e((()=>{L(),Je()})),ts=e((()=>{Z(),C(),$o(),Je(),z(),s(),H(),es(),Ri(),ma()})),ns=e((()=>{})),rs=e((()=>{ns(),typeof window<`u`&&((window.__svelte??={}).v??=new Set).add(`5`)}));function is(e){let t=e-1;return t*t*t+1}function as(e){let t=typeof e==`string`&&e.match(/^\s*(-?[\d.]+)([^\s]*)\s*$/);return t?[parseFloat(t[1]),t[2]||`px`]:[e,`px`]}function os(e,t,n){return Number.isNaN(t)?``:`${e}: ${n*t}px;`}function ss(e,{delay:t=0,duration:n=400,easing:r=us}={}){let i=+getComputedStyle(e).opacity;return{delay:t,duration:n,easing:r,css:e=>`opacity: ${e*i}`}}function cs(e,{delay:t=0,duration:n=400,easing:r=is,x:i=0,y:a=0,opacity:o=0}={}){let s=getComputedStyle(e),c=+s.opacity,l=s.transform===`none`?``:s.transform,u=c*(1-o),[d,f]=as(i),[p,m]=as(a);return{delay:t,duration:n,easing:r,css:(e,t)=>`
			transform: ${l} translate(${(1-e)*d}${f}, ${(1-e)*p}${m});
			opacity: ${c-u*t}`}}function ls(e,{delay:t=0,duration:n=400,easing:r=is,axis:i=`y`}={}){let a=getComputedStyle(e),o=+a.opacity,s=i===`y`?`height`:`width`,c=parseFloat(a[s]),l=i===`y`?[`top`,`bottom`]:[`left`,`right`],u=l.map(e=>`${e[0].toUpperCase()}${e.slice(1)}`),d=parseFloat(a[`padding${u[0]}`]),f=parseFloat(a[`padding${u[1]}`]),p=parseFloat(a[`margin${u[0]}`]),m=parseFloat(a[`margin${u[1]}`]),h=parseFloat(a[`border${u[0]}Width`]),g=parseFloat(a[`border${u[1]}Width`]);return{delay:t,duration:n,easing:r,css:e=>`overflow: hidden;opacity: ${Math.min(e*20,1)*o};`+os(s,c,e)+os(`padding-${l[0]}`,d,e)+os(`padding-${l[1]}`,f,e)+os(`margin-${l[0]}`,p,e)+os(`margin-${l[1]}`,m,e)+os(`border-${l[0]}-width`,h,e)+os(`border-${l[1]}-width`,g,e)+`min-${s}: 0`}}var us,ds=e((()=>{s(),Te(),us=e=>e})),$,fs,ps=e((()=>{$o(),$=Cn({splash:!0,hasSong:!1,where:`server`,local:!1,hasKey:!1,askKey:0,here:{done:!1,ok:!1,gpu:``,why:``,small:!1,mem:0,cores:0,mb:0},status:null}),fs={}})),ms,hs,gs=e((()=>{ms=typeof matchMedia==`function`&&matchMedia(`(prefers-reduced-motion: reduce)`).matches,hs=e=>ms?0:e}));function _s(e,t){let n=Go(t,vs);var r=ys();so(r,()=>({viewBox:`0 0 24 24`,width:`1.2em`,height:`1.2em`,...n})),Q(e,r)}var vs,ys,bs=e((()=>{rs(),$o(),vs=new Set([`$$slots`,`$$events`,`$$legacy`]),ys=Ci(`<svg><g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"><rect width="20" height="14" x="2" y="3" rx="2"></rect><path d="M8 21h8m-4-4v4"></path></g></svg>`)}));function xs(e,t){let n=Go(t,Ss);var r=Cs();so(r,()=>({viewBox:`0 0 24 24`,width:`1.2em`,height:`1.2em`,...n})),Q(e,r)}var Ss,Cs,ws=e((()=>{rs(),$o(),Ss=new Set([`$$slots`,`$$events`,`$$legacy`]),Cs=Ci(`<svg><path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9"></path></svg>`)}));function Ts(e,t){let n=Go(t,Es);var r=Ds();so(r,()=>({viewBox:`0 0 24 24`,width:`1.2em`,height:`1.2em`,...n})),Q(e,r)}var Es,Ds,Os=e((()=>{rs(),$o(),Es=new Set([`$$slots`,`$$events`,`$$legacy`]),Ds=Ci(`<svg><g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"><path d="M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z"></path><circle cx="16.5" cy="7.5" r=".5" fill="currentColor"></circle></g></svg>`)})),ks=e((()=>{}));function As(e,t){nt(t,!0);let n=Ko(t,`withKey`,3,!1),r=Ko(t,`id`,3,`where`),i=un(!1),a=un(``),o=un(void 0),s=Mt(()=>$.here),c=Mt(()=>[J(s).gpu,J(s).cores?`${J(s).cores} cores`:``,J(s).mem?J(s).mem>=8?`8 GB+`:`${J(s).mem} GB`:``].filter(Boolean).join(` · `)),l=Mt(()=>J(s).done?J(s).ok?J(s).small?`Slow on a phone: use the server`:J(c):J(s).why:`Checking…`),u=Mt(()=>J(s).done&&(!J(s).ok||J(s).small)),d=Mt(()=>$.local?`This machine`:$.hasKey?`Key saved`:`Needs a key`),f=Mt(()=>n()&&!$.local&&$.where===`server`);Xn(()=>{$.askKey&&n()&&(fn(i,!0),queueMicrotask(()=>J(o)?.focus()))});function p(){fs.setKey(J(a).trim()),fn(i,!1)}function m(){fn(a,``),fn(i,!0),queueMicrotask(()=>J(o)?.focus())}var h=Ps(),g=U(h),_=G(g,2),v=U(_);let y;var b=U(v);_s(b,{class:`ic`,"aria-hidden":`true`});var x=Mn(G(b,4),!0);ke(2),P(v);var S=G(v,2),C=U(S);xs(C,{class:`ic`,"aria-hidden":`true`});var w=Mn(G(C,4),!0);ke(2),P(S),P(_);var T=G(_,2),E=e=>{var t=Ns(),n=U(t);Ts(n,{class:`ic`,"aria-hidden":`true`});var r=G(n,2),s=e=>{var t=js(),n=G(U(t));P(t),si(`click`,n,m),Q(e,t)},c=e=>{var t=Ms(),n=U(t);io(n),No(n,e=>fn(o,e),()=>J(o)),P(t),oi(`submit`,t,e=>{e.preventDefault(),p()}),si(`change`,n,p),oi(`blur`,n,()=>{$.hasKey&&!J(a)&&fn(i,!1)}),wo(n,()=>J(a),e=>fn(a,e)),Q(e,t)};Ji(r,e=>{$.hasKey&&!J(i)?e(s):e(c,-1)}),P(t),Ta(3,t,()=>ls,()=>({duration:hs(180)})),Q(e,t)};Ji(T,e=>{J(f)&&e(E)}),P(h),nr(()=>{ao(g,`id`,`${r()??``}-h`),ao(_,`aria-labelledby`,`${r()??``}-h`),y=Ga(v,1,`card svelte-p74ejk`,null,y,{off:J(u)}),ao(v,`aria-pressed`,$.where===`here`),Mi(x,J(l)),ao(S,`aria-pressed`,$.where===`server`),Mi(w,J(d))}),si(`click`,v,()=>fs.setWhere(`here`)),si(`click`,S,()=>fs.setWhere(`server`)),Q(e,h),rt()}var js,Ms,Ns,Ps,Fs=e((()=>{rs(),$o(),ds(),ps(),gs(),bs(),ws(),Os(),ks(),js=xi(`<span class="saved svelte-p74ejk">Server key saved <button type="button" class="change svelte-p74ejk">Change</button></span>`),Ms=xi(`<form class="svelte-p74ejk"><input type="password" autocomplete="off" spellcheck="false" placeholder="Server key" aria-label="Server key" class="svelte-p74ejk"/></form>`),Ns=xi(`<div class="key svelte-p74ejk"><!> <!></div>`),Ps=xi(`<div class="where svelte-p74ejk"><h2 class="eyebrow svelte-p74ejk">Where songs are analysed</h2> <div class="cards svelte-p74ejk" role="group"><button type="button"><!> <span class="t svelte-p74ejk">This computer</span> <span class="s svelte-p74ejk"> </span> <i class="dot svelte-p74ejk" aria-hidden="true"></i></button> <button type="button" class="card svelte-p74ejk"><!> <span class="t svelte-p74ejk">The server</span> <span class="s svelte-p74ejk"> </span> <i class="dot svelte-p74ejk" aria-hidden="true"></i></button></div> <!></div>`),ci([`click`,`change`])}));function Is(e,t){let n=Go(t,Ls);var r=Rs();so(r,()=>({viewBox:`0 0 24 24`,width:`1.2em`,height:`1.2em`,...n})),Q(e,r)}var Ls,Rs,zs=e((()=>{rs(),$o(),Ls=new Set([`$$slots`,`$$events`,`$$legacy`]),Rs=Ci(`<svg><path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 3v12m5-7l-5-5l-5 5m14 7v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path></svg>`)}));function Bs(e,t){let n=Go(t,Vs);var r=Hs();so(r,()=>({viewBox:`0 0 24 24`,width:`1.2em`,height:`1.2em`,...n})),Q(e,r)}var Vs,Hs,Us=e((()=>{rs(),$o(),Vs=new Set([`$$slots`,`$$events`,`$$legacy`]),Hs=Ci(`<svg><path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 12h14m-7-7l7 7l-7 7"></path></svg>`)})),Ws=e((()=>{}));function Gs(e,t){nt(t,!0);let n=[{title:`Dropping Out of School`,by:`Brad Sucks`,url:`https://archive.org/download/bs-out-of-it-remastered/01%20Dropping%20Out%20of%20School.mp3`},{title:`Incoherent`,by:`Josh Woodward`,url:`https://archive.org/download/JoshWoodwardSelection/20-JoshWoodward-HereToday-01-Incoherent.mp3`},{title:`Goldberg Variations: Aria`,by:`Kimiko Ishizaka`,url:`https://archive.org/download/OpenGoldbergVariations/Kimiko%20Ishizaka%20-%20J.S.%20Bach-%20-Open-%20Goldberg%20Variations%2C%20BWV%20988%20%28Piano%29%20-%2001%20Aria.mp3`},{title:`Invincible`,by:`Gigatop Arthur`,url:`https://archive.org/download/jamendo-140090/01-1165390-Gigatop%20Arthur-Invincible.mp3`}],r=un(``);function i(e){e.preventDefault();let t=J(r).trim();/^https?:\/\/\S+$/i.test(t)?fs.link(t):fs.say(`Paste a link that starts with https://`,!0)}let a=0,o=!1;function s(){o=!1,clearTimeout(a),a=setTimeout(()=>{o||fs.say(`No file picker? Open this page in your browser to load songs.`,!0)},2500)}function c(e){clearTimeout(a);let t=e.currentTarget.files?.[0];e.currentTarget.value=``,t&&fs.file(t)}Xn(()=>{let e=()=>{o=!0},t=()=>{document.hidden&&(o=!0)};return addEventListener(`blur`,e),document.addEventListener(`visibilitychange`,t),()=>{removeEventListener(`blur`,e),document.removeEventListener(`visibilitychange`,t)}});let l=e=>({y:10,duration:hs(320),delay:hs(60+e*70)});var u=wi(),d=W(u),f=e=>{var t=Js(),a=U(t),o=U(a),u=G(o,2),d=U(u),f=U(d);Is(f,{class:`ic`,"aria-hidden":`true`});var p=G(f,2);P(d);var m=G(d,2),h=U(m);io(h);var g=G(h,2);Bs(U(g),{class:`ic`,"aria-hidden":`true`}),P(g),P(m),P(u);var _=G(u,2),v=G(U(_),2),y=U(v);ra(G(y,2),17,()=>n,ea,(e,t)=>{var n=Ks(),r=U(n),i=Mn(G(r),!0);P(n),nr(()=>{Mi(r,`${J(t).title??``} `),Mi(i,J(t).by)}),si(`click`,n,()=>fs.link(J(t).url,J(t).title)),Q(e,n)}),P(v),P(_);var b=G(_,2);As(U(b),{withKey:!0,id:`where-splash`}),P(b);var x=G(b,2),S=e=>{var t=qs();si(`click`,t,()=>fs.back()),Q(e,t)};Ji(x,e=>{$.hasSong&&e(S)}),P(a),P(t),Ta(1,o,()=>cs,()=>l(0)),si(`click`,p,s),si(`change`,p,c),oi(`submit`,m,i),wo(h,()=>J(r),e=>fn(r,e)),Ta(1,u,()=>cs,()=>l(1)),si(`click`,y,()=>fs.demo()),Ta(1,_,()=>cs,()=>l(2)),Ta(1,b,()=>cs,()=>l(3)),Ta(2,t,()=>ss,()=>({duration:hs(160)})),Q(e,t)};Ji(d,e=>{$.splash&&e(f)}),Q(e,u),rt()}var Ks,qs,Js,Ys=e((()=>{rs(),$o(),ds(),ps(),gs(),Fs(),zs(),Us(),Ws(),Ks=xi(`<button class="song svelte-2inaju" type="button"> <span class="svelte-2inaju"> </span></button>`),qs=xi(`<button class="btn btn-small btn-quiet back svelte-2inaju" type="button">Back to the song</button>`),Js=xi(`<section class="splash svelte-2inaju" aria-labelledby="splashTitle"><div class="in svelte-2inaju"><h1 class="title svelte-2inaju" id="splashTitle" data-text="Pitchscape">Pitchscape</h1> <div class="box pick svelte-2inaju"><label class="btn btn-primary upload svelte-2inaju"><!>Upload a song <input type="file" accept="audio/*,.mp3,.m4a,.aac,.wav,.ogg,.oga,.flac,.opus" class="svelte-2inaju"/></label> <form class="link svelte-2inaju"><input type="url" inputmode="url" autocomplete="off" spellcheck="false" placeholder="or paste a link to an audio file" aria-label="Link to an audio file" class="svelte-2inaju"/> <button class="btn go svelte-2inaju" type="submit" aria-label="Open the link"><!></button></form></div> <div class="box svelte-2inaju"><h2 class="eyebrow svelte-2inaju">Or try one of ours</h2> <div class="songs svelte-2inaju"><button class="song svelte-2inaju" type="button">Demo song <span class="svelte-2inaju">made here</span></button> <!></div></div> <div><!></div> <!></div></section>`),ci([`click`,`change`])}));function Xs(e,t){let n=Go(t,Zs);var r=Qs();so(r,()=>({viewBox:`0 0 24 24`,width:`1.2em`,height:`1.2em`,...n})),Q(e,r)}var Zs,Qs,$s=e((()=>{rs(),$o(),Zs=new Set([`$$slots`,`$$events`,`$$legacy`]),Qs=Ci(`<svg><path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.1 2.182a10 10 0 0 1 3.8 0m0 19.636a10 10 0 0 1-3.8 0m7.509-18.097a10 10 0 0 1 2.69 2.7M2.182 13.9a10 10 0 0 1 0-3.8m18.097 7.509a10 10 0 0 1-2.7 2.69M21.818 10.1a10 10 0 0 1 0 3.8M3.721 6.391a10 10 0 0 1 2.7-2.69m-.03 16.578a10 10 0 0 1-2.69-2.7"></path></svg>`)}));function ec(e,t){let n=Go(t,tc);var r=nc();so(r,()=>({viewBox:`0 0 24 24`,width:`1.2em`,height:`1.2em`,...n})),Q(e,r)}var tc,nc,rc=e((()=>{rs(),$o(),tc=new Set([`$$slots`,`$$events`,`$$legacy`]),nc=Ci(`<svg><g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><path d="m16 9l-5.5 5.5L8 12"></path></g></svg>`)}));function ic(e,t){let n=Go(t,ac);var r=oc();so(r,()=>({viewBox:`0 0 24 24`,width:`1.2em`,height:`1.2em`,...n})),Q(e,r)}var ac,oc,sc=e((()=>{rs(),$o(),ac=new Set([`$$slots`,`$$events`,`$$legacy`]),oc=Ci(`<svg><path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 12a9 9 0 1 1-6.219-8.56"></path></svg>`)})),cc=e((()=>{}));function lc(e,t){nt(t,!0);let n=Mt(()=>$.status),r=Mt(()=>J(n)?Math.round(J(n).p*100):0);var i=wi(),a=W(i),o=e=>{var t=mc(),i=U(t),a=e=>{var t=uc(),r=Mn(t,!0);nr(()=>Mi(r,J(n).song)),Q(e,t)};Ji(i,e=>{J(n).song&&e(a)});var o=G(i,2);Xi(o,()=>J(n).label,e=>{var t=dc(),r=Mn(t,!0);nr(()=>Mi(r,J(n).label)),Ta(1,t,()=>cs,()=>({y:6,duration:hs(220)})),Q(e,t)});var s=G(o,2),c=U(s);let l;P(s);var u=G(s,2),d=U(u),f=Mn(d,!0),p=Mn(G(d),!0);P(u);var m=G(u,2),h=e=>{var t=pc();ra(t,21,()=>J(n).steps,e=>e.k,(e,t)=>{var n=fc(),r=U(n),i=e=>{ic(e,{class:`ic spin`,"aria-hidden":`true`})},a=e=>{ec(e,{class:`ic`,"aria-hidden":`true`})},o=e=>{Xs(e,{class:`ic`,"aria-hidden":`true`})};Ji(r,e=>{J(t).state===`now`?e(i):J(t).state?e(a,1):e(o,-1)});var s=G(r);P(n),nr(()=>{Ga(n,1,Ra(J(t).state),`svelte-1rjc52y`),Mi(s,` ${J(t).label??``}`)}),Q(e,n)}),P(t),Q(e,t)};Ji(m,e=>{J(n).steps&&e(h)}),P(t),nr(()=>{ao(s,`aria-label`,J(n).label),ao(s,`aria-valuenow`,J(r)),l=Ja(c,``,l,{width:`${J(r)??``}%`}),Mi(f,J(n).note),Mi(p,J(r)>2?J(r)+`%`:``)}),Ta(1,t,()=>cs,()=>({y:12,duration:hs(260)})),Ta(2,t,()=>ss,()=>({duration:hs(160)})),Q(e,t)};Ji(a,e=>{J(n)&&e(o)}),Q(e,i),rt()}var uc,dc,fc,pc,mc,hc=e((()=>{rs(),$o(),ds(),ps(),gs(),$s(),rc(),sc(),cc(),uc=xi(`<p class="song svelte-1rjc52y"> </p>`),dc=xi(`<p class="now svelte-1rjc52y"> </p>`),fc=xi(`<li><!> </li>`),pc=xi(`<ol class="steps svelte-1rjc52y"></ol>`),mc=xi(`<div class="status svelte-1rjc52y" role="status"><!> <!> <div class="bar svelte-1rjc52y" role="progressbar" aria-valuemin="0" aria-valuemax="100"><i class="svelte-1rjc52y"></i></div> <p class="meta svelte-1rjc52y"><span> </span><span> </span></p> <!></div>`)}));function gc(){var e=function(e){return document.getElementById(e)},t=e(`cv`),n=t.getContext(`2d`),r=e(`plate`),i=e(`player`),a=e(`play`),o=e(`seek`),s=e(`labSeek`),c=e(`tNow`),l=e(`tDur`),u=e(`msg`),d=!!(window.matchMedia&&matchMedia(`(prefers-reduced-motion: reduce)`).matches),f=getComputedStyle(document.documentElement);function p(e,t){return f.getPropertyValue(e).trim()||t}var m={paper:p(`--paper`,`#EEF0EA`),ink:p(`--ink`,`#23211F`),blue:p(`--blue`,`#3255A4`),pink:p(`--pink`,`#FF48B0`),purple:p(`--purple`,`#765BA7`),teal:p(`--teal`,`#00838A`),orange:p(`--orange`,`#FF6C2F`),sun:p(`--sun`,`#FFB511`),green:p(`--green`,`#00A95C`),crimson:p(`--crimson`,`#E45D50`)};function h(e,t){var n=e.replace(`#`,``);return`rgba(`+parseInt(n.slice(0,2),16)+`,`+parseInt(n.slice(2,4),16)+`,`+parseInt(n.slice(4,6),16)+`,`+t+`)`}var g=`500 9.5px "DM Mono", ui-monospace, Menlo, monospace`,_={ana:null,dur:0,name:``,key:``,kicks:[],snares:[],hats:[],toms:[],cymbals:[],segs:[],segMax:0,medHz:330,lines:[],wt:[],words:[],lineStarts:[],vis:{bass:!0,kick:!0,snare:!0,hats:!0,toms:!0,voice:!0,guitar:!0,piano:!0,synths:!0,words:!0},dirty:!0,neverPlayed:!0,previewT:0,tap:null,busy:!1,timing:null,song:``},v={get:function(e){try{return JSON.parse(localStorage.getItem(e)||`null`)}catch{return null}},set:function(e,t){try{localStorage.setItem(e,JSON.stringify(t))}catch{}},del:function(e){try{localStorage.removeItem(e)}catch{}}},y={colour:`inst`,drums:`sound`,kick:`smudge`,bass:`smudge`,font:`grotesque`,wordSize:`voice`,shake:d?0:.25,tilt:d?0:.5,pulse:d?0:.6,slip:d?0:.35,secs:0,ink:1,weight:1,grain:.5,thick:`ear`,edges:1,guides:`on`,vConf:.45,vFloor:.04,vRun:90,bFloor:.08,hold:.3,noteMin:100,drumK:1,rough0:.1,sharp0:1.75,leap:4},b=2,x=v.get(`pitchscape:lab`),S=Object.assign({},y,x&&x.v===b?x.set:{});function C(){var e={};for(var t in S)S[t]!==y[t]&&(e[t]=S[t]);v.set(`pitchscape:lab`,{v:b,set:e})}var w=null;function T(e,t){u.textContent=e||``,u.classList.toggle(`err`,!!t),clearTimeout(w),e&&!t&&(w=setTimeout(function(){u.textContent===e&&(u.textContent=``)},4e3))}function E(e){e=Math.max(0,e||0);var t=Math.floor(e/60),n=Math.floor(e%60);return t+`:`+(n<10?`0`:``)+n}function D(e,t,n){return e<t?t:e>n?n:e}function O(e){return e|=0,e=Math.imul(e^e>>>16,73244475),e=Math.imul(e^e>>>16,73244475),e^=e>>>16,(e>>>0)/4294967296}function k(e,t,n){for(var r=0,i=e.length;r<i;){var a=r+i>>1;e[a][n]<t?r=a+1:i=a}return r}var A=0,j=0,ee=1,te=0,ne=4.2,re=100,ie=null,ae=Math.log2(28),oe=Math.log2(1e4),M=60;function se(e){var t=M+12,n=j-12;return n-(Math.log2(Math.max(e,20))-ae)/(oe-ae)*(n-t)}function ce(){M=Math.round(D(j*.15,54,116)),$e=(j-M-24)/((oe-ae)*12)}function le(e,t){return te-(t-e)*re}function ue(e){return 4+3.2*Math.log2(Math.max(e,30)/30)}function de(){ee=Math.min(2,window.devicePixelRatio||1),A=Math.max(200,t.clientWidth),j=Math.max(200,t.clientHeight),t.width=Math.round(A*ee),t.height=Math.round(j*ee),ne=S.secs>0?S.secs:A<520?4.2:A<900?5.5:7,ce(),te=Math.round(A*(A<520?.82:.86)),re=te/ne,fe(),De(),Te={},Ot(),_.dirty=!0,Ht&&Gn()}function fe(){var e=document.createElement(`canvas`);e.width=t.width,e.height=t.height;for(var n=e.getContext(`2d`),r=n.createImageData(e.width,e.height),i=r.data,a=0;a<i.length;a+=4){var o=Math.random();o<.055&&(i[a]=i[a+1]=i[a+2]=255,i[a+3]=70+o*2e3)}n.putImageData(r,0,0),ie=e}function pe(e){_.ana=e,_.dur=e.dur;var t=e.evW,n=e.events,r;for(_.hits=[],r=0;r+t<=n.length;r+=t){var i={t:n[r],k:n[r+1],s:n[r+2],hz:n[r+3],d:n[r+4],p:n.subarray(r+5,r+5+16),mg:n[r+t-1],id:r/t};i.br=at(i.p),i.mhz=R(i.k,i),_.hits.push(i)}_.segs=[],_.bends=e.bends,_.holds=e.holds;var a=e.segW,o=e.segs;for(r=0;r+a<=o.length;r+=a)_.segs.push({t0:o[r],t1:o[r+1],m:o[r+2],a:o[r+3],b:o[r+4],z:o[r+5],f:o[r+6],att:o[r+7],dec:o[r+8],vd:o[r+9],vr:o[r+10],h:o[r+11],src:o[r+12],ro:o[r+13],sh:o[r+14],bs:o[r+15],bn:o[r+16],id:r/a});e.leadHz0=e.leadHz,e.bassHz0=e.bassHz,e.leadEar=Ye(e.leadEar,Xe(e.leadHz0)),e.bassEar=Ye(e.bassEar,Xe(e.bassHz0)),_.noteEar=Ye(e.noteEar,_.segs.map(function(e){return[e.bs,e.bs+e.bn]})),ge()}function me(e,t){return Math.min(1,Math.hypot(D((e-S.rough0)/.3,0,1),D((t-S.sharp0)/1.25,0,1)))}var he=0;function ge(){var e=_.ana;if(e){he++;var t=e.frames,n,r,i=new Uint8Array(t),a=Math.max(1,Math.round(S.vRun/1e3/e.dt));for(n=0;n<t;n++)i[n]=+(e.leadHz0[n]>0&&e.leadP[n]>=S.vConf&&e.leadL[n]>=S.vFloor);for(n=0;n<t;)if(!i[n])n++;else{for(r=n;r<t&&i[r];)r++;r-n<a&&i.fill(0,n,r),n=r}var o=new Float32Array(t);for(n=0;n<t;n++)o[n]=i[n]?e.leadHz0[n]:0;e.leadHz=ve(o);var s=new Float32Array(t);for(n=0;n<t;n++)s[n]=e.bassN[n]>=S.bFloor?e.bassHz0[n]:0;e.bassHz=s;var c=new Float32Array(t),l=new Float32Array(t);for(n=0;n<t;n++)c[n]=me(e.leadRough[n],e.leadSharp[n]),l[n]=me(e.bassRough[n],e.bassSharp[n]);e.leadH=_e(c,11),e.bassH=_e(l,11),_.kicks=[],_.snares=[],_.hats=[],_.toms=[],_.cymbals=[];var u=[_.kicks,_.snares,_.hats,_.toms,_.cymbals];_.hits.forEach(function(e){e.mg>=S.drumK&&u[e.k].push(e)}),_.pieces=[],_.segMax=0;var d=2816/22050,f=S.noteMin/1e3,p=_.holds;_.segs.forEach(function(e){e.hs=me(e.ro,e.sh);var t=e.bn,n=(e.t1-e.t0)/Math.max(1,t-1),r=-1,i=-1,a=!0;function o(){var t=r===0?e.t0:e.t0+r*n,a=Math.min(e.t1,e.t0+i*n+n);a-t>=f&&(_.pieces.push({s:e,t0:t,t1:a}),a-t>_.segMax&&(_.segMax=a-t))}for(var s=0;s<t;s++)p[e.bs+s]>=S.hold?(r<0&&(r=a&&s*n<=d?0:s),i=s):r>=0&&(s-i)*n>d&&(o(),r=-1,a=!1);r>=0&&o()}),_.pieces.sort(function(e,t){return e.t0-t.t0});var m=[];for(n=0;n<e.leadHz.length;n+=3)e.leadHz[n]>0&&m.push(e.leadHz[n]);m.sort(function(e,t){return e-t}),_.medHz=m.length?m[m.length>>1]:330,N(e),ce()}}function N(e){for(var t=[],n=0;n<e.bassHz.length;n+=2)e.bassHz[n]>0&&t.push(e.bassHz[n]);for(n=0;n<e.leadHz.length;n+=2)e.leadHz[n]>0&&t.push(e.leadHz[n]);if(_.pieces.forEach(function(n){for(var r=DSP.mtof(n.s.m),i=Math.max(1,Math.round((n.t1-n.t0)/(2*e.dt)));i>0;i--)t.push(r)}),t.length<50)ae=Math.log2(28),oe=Math.log2(1e4);else{t.sort(function(e,t){return e-t});var r=Math.log2(t[Math.floor(t.length*.01)])-.25,i=Math.log2(t[Math.floor(t.length*.995)])+.33;if(i-r<3){var a=(i+r)/2;r=a-1.5,i=a+1.5}ae=Math.max(Math.log2(24),r),oe=Math.min(Math.log2(9e3),i)}}function _e(e,t){for(var n=new Float32Array(e.length),r=0,i=0;i<e.length+t;i++)i<e.length&&(r+=e[i]),i-2*t-1>=0&&(r-=e[i-2*t-1]),i-t>=0&&i-t<e.length&&(n[i-t]=r/(2*t+1));return n}function ve(e){for(var t=e.slice(),n=1;n<e.length-1;n++){var r=e[n-1],i=e[n],a=e[n+1];if(r>0&&i>0&&a>0){var o=12*Math.log2(i/r),s=12*Math.log2(i/a);Math.abs(o)>.8&&Math.abs(s)>.8&&o*s>0&&Math.abs(12*Math.log2(r/a))<.6&&(t[n]=Math.sqrt(r*a))}}return t}function ye(e){var t=_.ana.noiseRef;return D(((e-t[0])/Math.max(.05,t[1]-t[0])-.35)*1.2,0,1)}function be(e){return D((e-.35)/.4,0,1)}function xe(e,t,n){for(var r=0,i=k(e,t-.6,`t`);i<e.length&&e[i].t<=t;i++)r+=e[i].s*Math.exp(-(t-e[i].t)*n);return Math.min(1.3,r)}function Se(e){for(var t=_.ana,n=Math.round(e/t.dt),r=-1,i=0,a=0;a<=11;a++){var o=n+a;o<t.frames&&t.leadHz[o]>0&&t.leadN[o]>i&&(i=t.leadN[o],r=o)}if(r>=0)return r;for(a=1;a<=4;a++)if(n-a>=0&&t.leadHz[n-a]>0)return n-a;return-1}var Ce=[`#E4413A`,`#FF6C2F`,`#FFB511`,`#C2B21A`,`#6DB33F`,`#00A95C`,`#00838A`,`#0078BF`,`#3255A4`,`#765BA7`,`#B44C97`,`#FF48B0`],we=[],Te={};function Ee(e){return e=e.replace(`#`,``),[parseInt(e.slice(0,2),16),parseInt(e.slice(2,4),16),parseInt(e.slice(4,6),16)]}function De(){var e=[m.blue,m.teal,m.green,m.sun,m.orange,m.pink].map(Ee);we=[];for(var t=0;t<96;t++){var n=t/95*(e.length-1),r=Math.min(e.length-2,Math.floor(n)),i=n-r,a=[0,1,2].map(function(t){return Math.round(e[r][t]+(e[r+1][t]-e[r][t])*i)});we.push(`#`+a.map(function(e){return(e<16?`0`:``)+e.toString(16)}).join(``))}}function Oe(e){return we[Math.round(D((j-12-e)/Math.max(1,j-28),0,1)*95)]||m.ink}var P={voice:`#FF48B0`,words:`#914E72`,guitar:`#FF6C2F`,piano:`#FFB511`,lead:`#00838A`,pluck:`#009DA5`,pad:`#82D8D5`,bass:`#3255A4`,drum:`#23211F`};function ke(e,t,n){return S.colour===`height`?Oe(n??se(t||1e3)):S.colour===`note`&&e!==`drum`&&t>0?Ce[(Math.round(DSP.ftom(t))%12+12)%12*7%12]:P[e]}function Ae(e){return Math.min(1,e*S.ink)}function je(e,t,n){var r=e-Math.floor(e),i=(1-t)*Math.sin(6.2832*e)*.55+t*(2*r-1);return n?i*(1-n)+n*(r<.5?.75:-.75):i}var F={};function I(e){var t=F[e];if(!t){var n=e.replace(`#`,``);t=F[e]=`rgba(`+parseInt(n.slice(0,2),16)+`,`+parseInt(n.slice(2,4),16)+`,`+parseInt(n.slice(4,6),16)+`,`}return t}function L(e,t,n){var r=D((n-e)/(t-e),0,1);return r*r*(3-2*r)}function Me(e,t,r,i,a,o){var s=e.length;if(s<2)return null;var c=[],l=[],u=[],d=[],f=[],p=[],m=[],h=[],g=[],_=[],v,y,b=12,x=e[0].t,C=(e[s-1].t-x)*re;function w(e){if(a===`square`)return 1;var t=a===`blunt`?1:e/b;return i||(t=Math.min(t,(C-e)/b)),D(t,0,1)}var T=[],E=[];for(v=0;v<s-1;v++){var k=e[v],A=e[v+1],j=(k.t-x)*re,ee=(A.t-x)*re,te=Math.max(1,Math.ceil(Math.abs(ee-j)/1.6));for(y=0;y<te;y++){var ne=y/te,ie=k.t+(A.t-k.t)*ne,ae=j+(ee-j)*ne,oe=w(ae);c.push(ae),l.push(k.y+(A.y-k.y)*ne),u.push(ie),_.push(oe),T.push(v),E.push(ne),d.push((k.a+(A.a-k.a)*ne)*oe),f.push(k.c||t),p.push(k.b+(A.b-k.b)*ne),m.push(k.z+(A.z-k.z)*ne),h.push(ie*k.r),g.push(k.q)}}var M=e[s-1],se=i||a===`square`?1:0;c.push(C),l.push(M.y),u.push(M.t),_.push(-1),T.push(s-1),E.push(0),d.push(M.a*se),f.push(M.c||t),p.push(M.b),m.push(0),h.push(M.t*M.r),g.push(M.q);var ce=c.length,le=ce-1,ue,de=c[le];if(de<1)ue=I(f[0])+d[0].toFixed(3)+`)`;else{ue=n.createLinearGradient(0,0,de,0);var fe=Math.max(1,Math.floor(ce/Math.max(56,Math.ceil(de/7))));for(v=0;v<ce;v+=fe)ue.addColorStop(D(c[v]/de,0,1),I(f[v])+d[v].toFixed(3)+`)`);ue.addColorStop(1,I(f[le])+d[le].toFixed(3)+`)`)}function pe(e,t,n){return t>=0?e.e[2*t+n]:n?e.wu==null?e.w:e.wu:e.wd==null?e.w:e.wd}var me={t0:x,fill:ue,prints:[]};return o.forEach(function(t){var n=new Path2D,i=null,a=[],o=[],f=t.s;for(v=0;v<ce;v++){var y=e[T[v]],b=e[Math.min(s-1,T[v]+1)],x=E[v],C=_[v],w=C<0?f*(.3+.7*se):f*(.3+.7*Math.sqrt(C)),D=(pe(y,t.band,1)+(pe(b,t.band,1)-pe(y,t.band,1))*x)*w*S.weight,k=(pe(y,t.band,0)+(pe(b,t.band,0)-pe(y,t.band,0))*x)*w*S.weight,A=(D+k)/2*(.03+.8*Math.max(p[v],.3*(g[v]||0))),j=c[v],ee=l[v];if(v?n.lineTo(j,ee-D-A*je(h[v],p[v],g[v])):n.moveTo(j,ee-D-A*je(h[v],p[v],g[v])),a.push(j),o.push(ee+k+A*je(h[v]+.41,p[v],g[v])),C>=0&&m[v]>.02&&f===1&&d[v]>.05){var te=Math.round(u[v]*300)+r;if(O(te)<m[v]*.55){var ne=.45+O(te+29)*1.05,re=j+(O(te+7)-.5)*2,ie=ee+(O(te+13)*2-1)*(D+k)/2/S.weight*1.6;i||=new Path2D,i.moveTo(re+ne,ie),i.arc(re,ie,ne,0,6.2832)}}}for(v=ce-1;v>=0;v--)n.lineTo(a[v],o[v]);n.closePath(),me.prints.push({a:t.a,path:n,dots:i})}),me}function Ne(e,t){if(e){var r=le(e.t0,t);n.translate(r,0),n.fillStyle=e.fill;for(var i=0;i<e.prints.length;i++){var a=e.prints[i];n.globalAlpha=Ae(a.a),n.fill(a.path),a.dots&&n.fill(a.dots)}n.translate(-r,0),n.globalAlpha=1}}var Pe=new Map,Fe=``,Ie=0,Le=0;function Re(){var e=A+`|`+j+`|`+ee+`|`+ae+`|`+oe+`|`+M+`|`+he+`|`+JSON.stringify(S);e!==Fe&&(Fe=e,Pe.clear(),Ie++),++Le%120==0&&Pe.forEach(function(e,t){e.used<Le-2&&Pe.delete(t)})}function ze(e,t){var n=Pe.get(e);return n||(n={st:t()},Pe.set(e,n)),n.used=Le,n.st}function Be(e){for(var t=[],n=2;n>=0;n--)n>0&&!(S.edges>0)||t.push({a:e*(n===0?1:Ze[n]*S.edges),s:1,band:n});return t}function Ve(e,t,r,i){i<=.03||(n.globalAlpha=Ae(.95*i),n.fillStyle=r,n.beginPath(),n.arc(te,e,t*S.weight+1.6,0,6.2832),n.fill())}var He={},Ue=null,We=null;function Ge(e){var t=He[e];if(t)return t;t=document.createElement(`canvas`),t.width=t.height=64;var n=t.getContext(`2d`),r=n.createRadialGradient(32,32,0,32,32,32);return r.addColorStop(0,h(e,1)),r.addColorStop(.35,h(e,.7)),r.addColorStop(.7,h(e,.22)),r.addColorStop(1,h(e,0)),n.fillStyle=r,n.fillRect(0,0,64,64),He[e]=t,t}function Ke(e,r,i){(!Ue||Ue.width!==t.width||Ue.height!==t.height)&&(Ue=document.createElement(`canvas`),Ue.width=t.width,Ue.height=t.height,We=Ue.getContext(`2d`));var a=We,o,s;a.setTransform(1,0,0,1,0,0),a.clearRect(0,0,Ue.width,Ue.height),a.setTransform(n.getTransform()),e.forEach(function(e){for(o=0;o<e.length-1;o++){var t=e[o],n=e[o+1],c=le(t.t,r),l=le(n.t,r),u=Math.max(1,Math.ceil(Math.abs(l-c)/2));for(s=0;s<u;s++){var d=s/u,f=t.a+(n.a-t.a)*d;if(!(f<.02)){var p=c+(l-c)*d,m=t.y+(n.y-t.y)*d,h;if(t.e){var g=t.e[3]+(n.e[3]-t.e[3])*d,_=t.e[2]+(n.e[2]-t.e[2])*d;m+=(_-g)/2,h=Math.max(1.5,(g+_)/2)*S.weight}else{var v=D((t.w+(n.w-t.w)*d-.8)/8,0,1);h=($e*1.3+1.5)*(.85+.3*v)*S.weight}a.globalAlpha=Math.min(1,i*f*3.2/h),a.drawImage(Ge(t.c),p-h,m-h,2*h,2*h)}}}}),n.save(),n.setTransform(1,0,0,1,0,0),n.globalAlpha=Math.min(1,S.ink),n.drawImage(Ue,0,0),n.restore()}function qe(e,t,n,r,i,a,o,s,c,l){var u=_.ana,d=u.dt,f=Math.max(0,Math.floor((e-ne-.3)/d)),p=Math.min(u.frames-1,Math.floor(e/d)),m=null,h=o===`bass`&&S.bass===`smudge`,g=[],v=S.thick===`ear`,y=v?Be(s):(c>0?[{a:c,s:1.9,band:-1}]:[]).concat([{a:s,s:1,band:-1}]);function b(e){var s=t(e),c=se(s),l={t:e*d,y:c,w:n(e),a:r(e),b:i(e),z:a(e),r:ue(s),c:ke(o,s,c)};return v&&(l.e=Je(o===`bass`?u.bassEar:u.leadEar,e),l.wd=l.e[2],l.wu=l.e[3]),l}function x(e,t){for(var n=[],r=e;r<=t;r++)n.push(b(r));return n}function C(e){var n=t(e),r=t(e-1);return n>0&&r>0&&!(Math.abs(12*Math.log2(n/r))>S.leap)}for(var w=f;w<=p;)if(!(t(w)>0))w++;else{var T=w;for(w++;w<=p&&C(w);w++);var E=w-1,D=E===p,O;h?(O=x(T,E),O.length>1&&g.push(O),D&&(m=O[O.length-1])):D?(O=x(T,E),m=O[O.length-1],O.length>1&&Ne(Me(O,null,l,!0,void 0,y),e)):(E>T||T===f&&T>0&&C(T))&&Ne(ze(o+`:`+E,function(){for(var e=T;e>0&&C(e);)e--;return Me(x(e,E),null,l,!1,void 0,y)}),e)}g.length&&Ke(g,e,s),m&&(m.e?Ve(m.y+(m.e[0]-m.e[1])/2,h?$e*.55+.6:Math.min($e*.8,(m.e[0]+m.e[1])/2),m.c,m.a):Ve(m.y,h?$e*.55+.6:m.w,m.c,m.a))}function Je(e,t){for(var n=t*6,r=[,,,,,,],i=0;i<6;i++)r[i]=e[n+i]*$e;return r}function Ye(e,t){var n=new Float32Array(e.length),r=3;return t.forEach(function(t){for(var i=t[0];i<t[1];i++)for(var a=Math.max(t[0],i-r),o=Math.min(t[1]-1,i+r),s=o-a+1,c=0;c<6;c++){for(var l=0,u=a;u<=o;u++)l+=e[u*6+c];n[i*6+c]=l/s}}),n}function Xe(e){for(var t=[],n=0,r=e.length,i;n<r;)if(!(e[n]>0))n++;else{for(i=n;i<r&&e[i]>0;)i++;t.push([n,i]),n=i}return t}var Ze=[1,.32,.1];function Qe(e,t){if(e.bn<2)return 0;var n=D((t-e.t0)/Math.max(1e-6,e.t1-e.t0),0,1)*(e.bn-1),r=Math.min(e.bn-2,Math.floor(n)),i=n-r,a=_.bends,o=e.bs+r;return a[o]+(a[o+1]-a[o])*i}var $e=1;function et(e,t,n,r){for(var i=e-ne-.2,a=k(_.pieces,i-_.segMax,`t0`);a<_.pieces.length;a++){var o=_.pieces[a],s=o.s;if(o.t0>e)break;if(!(o.t1<i||s.src!==n)){var c=Math.min(o.t1,e);if(!(c-o.t0<.02)){o.t1>=e&&(t[r]+=s.a*.5);var l=DSP.mtof(s.m),u=se(l),d=o.t1>e,f=ke(n===1?`guitar`:n===2?`piano`:s.f===1?`pad`:s.f===2?`lead`:`pluck`,l,u);if(!d)o.stG!==Ie&&(o.stG=Ie,o.st=tt(o,c,f,!1)),Ne(o.st,e);else{var p=nt(o,c);Ne(tt(o,c,f,!0,p),e);var m=p[p.length-1];m.e?Ve(m.y+(m.e[0]-m.e[1])/2,Math.min($e*.8,(m.e[0]+m.e[1])/2),f,m.a):Ve(m.y,m.w,f,m.a)}}}}}function tt(e,t,n,r,i){var a=e.s,o=S.thick===`ear`?Be(.82):a.f===1?[{a:.12,s:1.45,band:-1},{a:.78,s:1,band:-1}]:[{a:a.f===0?.85:.82,s:1,band:-1}];return Me(i||nt(e,t),n,101+a.id*7,r,a.f===0?`blunt`:a.f===2?`square`:void 0,o)}function nt(e,t){for(var n=e.s,r=DSP.mtof(n.m),i=be(n.z),a=ue(r),o=Math.min(1,n.a),s=[],c=n.h>.5?D((n.h-.5)*2.5,0,1):0,l=e.t0;;l+=_.ana.dt){var u=Math.min(l,t),d=u-n.t0,f=se(DSP.mtof(n.m+Qe(n,u))),p,m;if(n.f===0){var h=10**(Math.max(-80,Math.min(0,n.dec))*d/20);p=(1.2+4.6*n.a)*1.3*(.22+.78*h**.7)*Math.min(1,d/.012+.6),m=(.5+.5*o)*(.35+.65*h)}else if(n.f===1){var g=Math.max(.08,n.att);p=(1+4.2*n.a)*1.6*(.04+.96*L(0,g,d))*Math.min(1,(e.t1-u)/.25+.25),m=(.45+.55*o)*(.3+.7*L(0,g,d))}else p=(1+4.2*n.a)*1.15*Math.min(1,(u-e.t0)/.02+.5),m=.5+.5*o;var v={t:u,y:f,w:p,a:m,b:n.hs,z:n.f===1?i*.5:i,r:a,q:c};if(S.thick===`ear`&&(v.e=Je(_.noteEar,n.bs+Math.round((u-n.t0)/Math.max(1e-6,n.t1-n.t0)*(n.bn-1)))),s.push(v),u>=t)break}return s}var rt=DSP.DRUM_BANDS,it=new Float32Array(36);function at(e){if(!e)return .5;for(var t=0,n=0,r=0;r<e.length;r++){var i=e[r]*e[r];n+=i,rt[r]>=2500&&(t+=i)}return n>0?t/n:.5}function R(e,t){if(e===0)return D(t.hz||52,30,180);if(e===3&&t.p){for(var n=-1,r=0;r<t.p.length;r++)rt[r]>=55&&rt[r+1]<=760&&(n<0||t.p[r]>t.p[n])&&(n=r);if(n>=0)return Math.sqrt(rt[n]*rt[n+1])}var i=e===1?[350,4e3]:e===3?[60,800]:[2200,9500];return D(t.hz||i[0],i[0],i[1])}function z(e,t,n){for(var r=k(e,t-ne-1.2,`t`);r<e.length&&e[r].t<=t;r++)st(e[r],t,n)}function ot(e,t){if(t===`tom`)return D(se(e.mhz),M+12,j-12);var n=M-12;return 8+n*(t===`cymbal`?.2:t===`hat`?.5:.8)-(S.drums===`sound`?(e.br-.5)*n*.2:0)}function st(e,t,r){var i=le(e.t,t),a=ot(e,r),o=t-e.t,s=o<.05?.55+.45*o/.05:1,c=S.drums===`sound`,l=c?e.br:.35,u=e.id*977+r.length*131,d=c&&(r===`hat`||r===`cymbal`)?Math.min(o,e.d)*re:0;n.fillStyle=ke(`drum`,e.mhz,a),n.beginPath(),r===`snare`?ct(i,a,(3.2+4.2*e.s)*s,l,e.s,u):r===`tom`?lt(i,a,(2.8+3.6*e.s)*s,u):ut(i,a,e.s,s,d,r===`cymbal`,u),n.globalAlpha=Ae(r===`snare`||r===`tom`?.92:.9),n.fill()}function ct(e,t,r,i,a,o){var s=it.length,c,l,u=3+Math.round(6*i);for(c=0;c<s;c++)it[c]=r*(.84+.3*O(o+c));for(c=0;c<u;c++)it[Math.floor(O(o+50+c)*s)]=r*(1.45+(.7+1.6*i)*O(o+80+c));for(c=0;c<s;c++)l=c/s*6.2832,c?n.lineTo(e+Math.cos(l)*it[c],t+Math.sin(l)*it[c]):n.moveTo(e+it[0],t);for(n.closePath(),c=0;c<2+Math.round(2*a+2*i);c++)B(e,t,O(o+120+c)*6.2832,r*(2+1.4*O(o+140+c)),r*(.12+.16*O(o+160+c)))}function lt(e,t,r,i){for(var a=18,o=0,s,c;o<a;o++)s=o/a*6.2832,c=r*(.92+.16*O(i+o)),o?n.lineTo(e+Math.cos(s)*c,t+Math.sin(s)*c):n.moveTo(e+c,t);for(n.closePath(),o=0;o<2;o++)B(e,t,O(i+40+o)*6.2832,r*(1.5+.7*O(i+60+o)),r*(.14+.12*O(i+80+o)))}function ut(e,t,n,r,i,a,o){var s=a?14+Math.round(16*n):6+Math.round(6*n),c=(a?6.5+8*n:4+4.5*n)*r,l=c*(a?.75:.9),u,d;for(B(e,t,0,0,(a?1.1:1.9+1.2*n)*r),u=0;u<s;u++){d=Math.sqrt(O(o+30+u));var f=O(o+u)*6.2832;B(e+Math.cos(f)*d*c,t+Math.sin(f)*d*l,0,0,(a?.6+.9*O(o+60+u):.8+1.1*O(o+60+u))*r)}if(i>2){var p=Math.min(28,Math.round(i/(a?2.5:3.5)));for(u=0;u<p;u++){var m=(u+O(o+200+u))/p;B(e+m*i,t+(O(o+230+u)-.5)*l*(a?2.4:1.6)*(1-.5*m),0,0,(a?1:1.2)*(1-.55*m))}}}function B(e,t,r,i,a){var o=e+Math.cos(r)*i,s=t+Math.sin(r)*i;n.moveTo(o+a,s),n.arc(o,s,a,0,6.2832)}function dt(e,t){var n=e+`|`+t;if(Te[n])return Te[n];var r=Math.ceil(2*t*ee)+2,i=document.createElement(`canvas`);i.width=i.height=r;var a=i.getContext(`2d`),o=r/2,s=4.2*ee,c=Math.SQRT1_2,l=Math.ceil(t*ee/s)+2,u=t*ee,d=Math.exp(-2.6);a.fillStyle=e,a.beginPath();for(var f=-l;f<=l;f++)for(var p=-l;p<=l;p++){var m=o+(f-p)*c*s,h=o+(f+p)*c*s,g=Math.sqrt((m-o)*(m-o)+(h-o)*(h-o))/u;if(!(g>=1)){var _=(Math.exp(-g*g*2.6)-d)/(1-d),v=s*.6*Math.sqrt(_);v<.3||(a.moveTo(m+v,h),a.arc(m,h,v,0,6.2832))}}return a.fill(),Te[n]=i,i}function ft(e){for(var t=k(_.kicks,e-ne-.4,`t`);t<_.kicks.length&&_.kicks[t].t<=e;t++)pt(_.kicks[t],e)}function pt(e,t){var r=e.mhz,i=le(e.t,t),a=D(se(r),M+12,j-10),o=t-e.t,s=e.s,c=ke(`drum`,r,a),l=Math.min(1,o/.28),u=(10+19*s)*(1+.4*D(e.d/.25,0,1)),d=u*(1+.35*(1-l)),f;if(S.kick===`halftone`){var p=Math.max(8,Math.round(u/4)*4);n.globalAlpha=Ae(.36+.34*s),n.drawImage(dt(c,p),i-d,a-d,2*d,2*d)}else f=n.createRadialGradient(i,a,0,i,a,d),f.addColorStop(0,h(c,Ae(.42+.3*s))),f.addColorStop(.55,h(c,Ae(.16+.12*s))),f.addColorStop(1,h(c,0)),n.globalAlpha=1,n.fillStyle=f,n.beginPath(),n.arc(i,a,d,0,6.2832),n.fill();if(o<.45){var m=o/.45,g=u*(1.5+2.4*m);f=n.createRadialGradient(i,a,u*.4,i,a,g),f.addColorStop(0,h(c,Ae(.2*s*(1-m)*(1-m)))),f.addColorStop(1,h(c,0)),n.globalAlpha=1,n.fillStyle=f,n.beginPath(),n.arc(i,a,g,0,6.2832),n.fill()}}function mt(e){if(_.words.length){n.textBaseline=`alphabetic`;for(var t=k(_.words,e-ne-.8,`t`);t<_.words.length&&_.words[t].t<=e;t++){var r=_.words[t],i=le(r.t,e);if(!(i+r.px<-4)){var a=e-r.t,o=a<.09?a/.09:1,s=r.yy;if(n.font=r.font,n.fillStyle=ke(`words`,r.hz,s),n.globalAlpha=Ae(.4+.58*o),o<1){n.save(),n.translate(i,s);var c=1.25-.25*o;n.scale(c,c),n.fillText(r.text,0,0),n.restore()}else n.fillText(r.text,i,s)}}}}function ht(){if(S.guides!==`off`){n.globalCompositeOperation=`source-over`,n.globalAlpha=1,n.lineWidth=1,n.font=g,n.textBaseline=`bottom`;for(var e=1;e<=8;e++){var t=440*2**((12*(e+1)-69)/12),r=Math.round(se(t))+.5;r<M+22||r>j-4||(n.strokeStyle=`rgba(35,33,31,0.075)`,n.beginPath(),n.moveTo(0,r),n.lineTo(A,r),n.stroke(),n.fillStyle=`rgba(35,33,31,0.42)`,n.fillText(`C`+e+` `+Math.round(t),6,r-2))}var i=M+4.5;n.strokeStyle=`rgba(35,33,31,0.09)`,n.setLineDash([1,5]),n.beginPath(),n.moveTo(0,i),n.lineTo(A,i),n.stroke(),n.setLineDash([])}}var gt={guitar:[.8,-.6],synths:[-.4,.75],piano:[.65,.45],bass:[-.9,.3],voice:[.5,.85],hats:[-.3,-.95],toms:[.7,-.3],snare:[.95,.2],kick:[-.6,-.7],words:[.25,.6]},_t={};document.querySelectorAll(`.ink`).forEach(function(e){_t[e.dataset.layer||e.dataset.toggle]={el:e,v:-1}});function vt(e,t){var n=_t[e];n&&(t=Math.round(D(t,0,1)*20)/20,t!==n.v&&(n.v=t,n.el.style.setProperty(`--lvl`,t)))}var yt=/[?&]bench\b/.test(location.search)?{}:null,bt=`paint`;function xt(){bt===`paint`&&n.getImageData(0,0,1,1)}function St(e,t){xt();var n=performance.now();t(),xt(),(yt[e]=yt[e]||[]).push(performance.now()-n)}yt&&(window.pitchscapeBench=function(e,t){for(var n in bt=t||`paint`,yt)delete yt[n];var r=[];function i(){yt.frame=r;var e={};for(var t in yt){var n=yt[t].slice().sort(function(e,t){return e-t});e[t]={med:n[n.length>>1],p95:n[Math.min(n.length-1,Math.floor(n.length*.95))],n:n.length}}return e}return bt===`raf`?new Promise(function(t){var n=0,a=0;(function o(s){if(n>0&&r.push(s-a),a=s,n>=e.length)return r.shift(),t(i());wt(e[n++]),requestAnimationFrame(o)})(performance.now())}):(e.forEach(function(e){xt();var t=performance.now();wt(e),xt(),r.push(performance.now()-t)}),Promise.resolve(i()))});var Ct=``;function wt(e){n.setTransform(ee,0,0,ee,0,0),n.globalCompositeOperation=`source-over`,n.globalAlpha=1,n.fillStyle=m.paper,n.fillRect(0,0,A,j);var r=_.ana;if(!r){ht();return}Re();var i=D(Math.floor(e/r.dt),0,r.frames-1),a=r.bassN[i]||0,o=xe(_.kicks,e,14),s=xe(_.snares,e,18),c=xe(_.hats,e,22),l={guitar:0,piano:0,synths:0},u=S.shake*((_.vis.bass?a*a*5:0)+(_.vis.kick?o*9:0)+(_.vis.snare?s*2:0)),d=u*(Math.sin(e*53.1)+.7*Math.sin(e*31.7+1.3))/1.7,f=u*(Math.sin(e*47.3+2.1)+.7*Math.sin(e*29.9+.4))/1.7,p=u*.0022*Math.sin(e*37.7+.9),g=S.slip*(o*2.4+a*1.1),v={};for(var y in gt)v[y]=[gt[y][0]*g,gt[y][1]*g];if(n.save(),n.translate(A/2+d,j/2+f),n.rotate(p),n.translate(-A/2,-j/2),ht(),n.globalCompositeOperation=`multiply`,_.vis.bass&&a>.05){var b=ke(`bass`,r.bassHz[i]||55,j),x=n.createLinearGradient(0,j,0,j*.6);x.addColorStop(0,h(b,Ae(.2*a**1.5))),x.addColorStop(1,h(b,0)),n.globalAlpha=1,n.fillStyle=x,n.fillRect(-30,j*.6,A+60,j*.4+30)}if(_.vis.kick&&S.pulse>0&&o>.02){var C=ke(`drum`,50,j),w=n.createLinearGradient(0,j,0,j*.45);w.addColorStop(0,h(C,Math.min(.3,.22*S.pulse*o))),w.addColorStop(1,h(C,0)),n.globalAlpha=1,n.fillStyle=w,n.fillRect(-30,j*.45,A+60,j*.55+30)}function T(e,t){_.vis[e]&&(n.save(),n.translate(v[e][0],v[e][1]),yt?St(e,t):t(),n.restore())}T(`synths`,function(){et(e,l,0,`synths`)}),T(`piano`,function(){et(e,l,2,`piano`)}),T(`guitar`,function(){et(e,l,1,`guitar`)}),T(`bass`,function(){qe(e,function(e){return r.bassHz[e]},function(e){return .8+12*r.bassN[e]},function(e){return L(.015,.3,r.bassN[e])},function(e){return r.bassH[e]},function(){return 0},`bass`,.86,.15,11)}),T(`voice`,function(){qe(e,function(e){return r.leadHz[e]},function(e){return .8+8.5*r.leadN[e]},function(e){return L(.02,.4,r.leadN[e])},function(e){return r.leadH[e]},function(e){return ye(r.leadNz[e])},`voice`,.9,.16,37)}),T(`hats`,function(){z(_.hats,e,`hat`),z(_.cymbals,e,`cymbal`)}),T(`toms`,function(){z(_.toms,e,`tom`)}),T(`snare`,function(){z(_.snares,e,`snare`)}),T(`kick`,function(){ft(e)}),T(`words`,function(){mt(e)}),n.restore(),n.globalCompositeOperation=`source-over`,n.globalAlpha=1,n.strokeStyle=`rgba(35,33,31,0.32)`,n.lineWidth=1,n.setLineDash([2,4]),n.beginPath(),n.moveTo(te+.5,28),n.lineTo(te+.5,j-6),n.stroke(),n.setLineDash([]),n.fillStyle=m.ink,n.beginPath(),n.moveTo(te-4.5,21),n.lineTo(te+5.5,21),n.lineTo(te+.5,27),n.closePath(),n.fill(),ie&&S.grain>0&&(n.globalCompositeOperation=`screen`,n.globalAlpha=S.grain,n.setTransform(1,0,0,1,0,0),n.drawImage(ie,0,0)),n.globalCompositeOperation=`source-over`,n.globalAlpha=1;var E=r.leadHz[i]>0?r.leadN[i]:0,O=0;if(_.words.length){var ne=k(_.words,e-.3,`t`);ne<_.words.length&&_.words[ne].t<=e&&(O=1-(e-_.words[ne].t)/.3)}vt(`bass`,a),vt(`kick`,o),vt(`snare`,s),vt(`hats`,c),vt(`voice`,E),vt(`guitar`,l.guitar),vt(`piano`,l.piano),vt(`synths`,l.synths),vt(`words`,O);var re=S.tilt*(9*Math.min(1,o)+3*a),ae=S.tilt*1.4*a*Math.sin(e*1.3),oe=S.tilt>0?`perspective(700px) rotateX(`+re.toFixed(2)+`deg) rotate(`+ae.toFixed(2)+`deg)`:``;oe!==Ct&&(Ct=oe,t.style.transform=oe)}var Tt={grotesque:{fam:`"Bricolage Grotesque", "Avenir Next", system-ui, sans-serif`,w:[420,800],sc:1,st:``},script:{fam:`"Caveat", "Segoe Print", cursive`,css:`Caveat:wght@400..700`,w:[420,700],sc:1.38,st:``},serif:{fam:`"Fraunces", Georgia, serif`,css:`Fraunces:ital,opsz,wght@1,9..144,300..900`,w:[330,860],sc:1.08,st:`italic `},mono:{fam:`"DM Mono", ui-monospace, Menlo, monospace`,w:[400,500],sc:.94,st:``}};function Et(e){var t=Tt[e]||Tt.grotesque;return t.css?(t.ready||=new Promise(function(e){var n=document.createElement(`link`);n.rel=`stylesheet`,n.href=`https://fonts.googleapis.com/css2?family=`+t.css+`&display=block`,n.onload=function(){(document.fonts?document.fonts.load(t.st+t.w[1]+` 16px `+t.fam.split(`,`)[0]):Promise.resolve()).then(e,e)},n.onerror=e,document.head.appendChild(n)}),t.ready):Promise.resolve()}function Dt(e){var t=Tt[S.font]||Tt.grotesque,n=S.wordSize===`voice`?D(e,0,1):.45,r=(S.wordSize===`voice`?10.5+9*n:13)*t.sc,i=Math.round(t.w[0]+(t.w[1]-t.w[0])*n);return{css:t.st+i+` `+r.toFixed(1)+`px `+t.fam,size:r}}function Ot(){if(_.words.length&&_.ana&&j){n.save(),n.setTransform(1,0,0,1,0,0);var e=[],t=se(_.medHz)-16,r=_.medHz;_.words.forEach(function(i){var a=Se(i.t),o=Dt(a>=0?_.ana.leadN[a]:.35);i.font=o.css,i.lh=o.size+1,n.font=i.font;var s=n.measureText(i.text);i.px=s.width,i.asc=s.actualBoundingBoxAscent||o.size*.75,i.desc=s.actualBoundingBoxDescent||o.size*.22,a>=0?(i.hz=_.ana.leadHz[a],i.y=se(i.hz)-(.8+8.5*_.ana.leadN[a])*S.weight-5,t=i.y,r=i.hz):(i.y=t,i.hz=r);var c=M+6,l=j-8;i.y=D(i.y,c+i.asc,l-i.desc);var u=i.t*re,d=u+i.px,f=Math.max(6,i.lh*.55),p,m;function h(t){for(var n=e.length-1;n>=0;n--){var r=e[n];if(r.X0<u-600)break;if(r.X1+4>u&&r.X0<d+4&&r.top<t+i.desc+1&&r.bot>t-i.asc-1)return!0}return!1}var g=[];for(p=i.y;p-i.asc>=c;p-=f)g.push(p);for(p=i.y+f;p+i.desc<=l;p+=f)g.push(p);for(i.yy=i.y,m=0;m<g.length;m++)if(!h(g[m])){i.yy=g[m];break}e.push({X0:u,X1:d,top:i.yy-i.asc,bot:i.yy+i.desc})}),n.restore()}}function kt(e,t){_.lines=e,_.wt=t,_.words=[],e.forEach(function(e,n){e.words.forEach(function(e,r){var i=t[n]&&t[n][r];i!=null&&isFinite(i)&&_.words.push({t:i,text:e.text,li:n,wi:r})})}),_.words.sort(function(e,t){return e.t-t.t}),_.lineStarts=t.map(function(e){for(var t=0;e&&t<e.length;t++)if(e[t]!=null)return e[t];return null}),Ot(),_.dirty=!0}function At(e){var t=DSP.parseLyrics(e);kt(t,t.length?DSP.alignLyrics(t,_.ana):[])}t.addEventListener(`click`,function(){Bt.classList.contains(`away`)?qt():Wt()&&Kt(!0)});var jt=0,Mt=-1,Nt=0,Pt=!1;function Ft(){var e=i.currentTime||0,t=performance.now();if(i.paused||i.ended)return jt=e,Mt=e,Nt=t,e;e!==Mt&&(Mt=e,Nt=t);var n=Mt+(t-Nt)/1e3*(i.playbackRate||1);return jt=Math.abs(n-jt)>.35?n:Math.max(jt,n),Math.min(jt,_.dur||jt)}function It(){var t=!i.paused&&!i.ended;e(`icoPlay`).hidden=t,e(`icoPause`).hidden=!t,a.setAttribute(`aria-label`,t?`Pause`:`Play`),e(`labPlay`).textContent=t?`Pause`:`Play`}function Lt(t){a.disabled=!t,e(`labPlay`).disabled=!t}function Rt(){var e=i.play();e&&e.catch&&e.catch(function(){T(`Playback was blocked. Tap play again.`,!0)})}function zt(){i.paused||i.ended?(_.neverPlayed&&=!1,i.ended&&(i.currentTime=0),Rt()):i.pause()}a.addEventListener(`click`,zt);var Bt=e(`hud`),Vt=e(`labBtn`),Ht=e(`labPanel`),Ut=null;function Wt(){return!i.paused&&!i.ended}function Gt(){return!Ht.hidden}function Kt(e){Bt.classList.toggle(`away`,e),Vt.classList.toggle(`away`,e)}function qt(){clearTimeout(Ut),Gt()?Kt(!0):(Kt(!1),Wt()&&(Ut=setTimeout(function(){Wt()&&!Jt(Bt)&&!Jt(Vt)&&Kt(!0)},2600)))}function Jt(e){var t=document.activeElement;try{return!!t&&e.contains(t)&&t.matches(`:focus-visible`)}catch{return!1}}[`pointerdown`,`focusin`,`input`].forEach(function(e){Bt.addEventListener(e,qt),Vt.addEventListener(e,qt)}),r.addEventListener(`mousemove`,function(e){(e.movementX||e.movementY)&&qt()}),[`play`,`pause`,`ended`].forEach(function(e){i.addEventListener(e,function(){It(),_.dirty=!0,qt()})}),i.addEventListener(`seeked`,function(){_.dirty=!0}),i.addEventListener(`error`,function(){i.src&&T(`Can't play that file here.`,!0)}),[o,s].forEach(function(e){e.addEventListener(`pointerdown`,function(){Pt=!0}),e.addEventListener(`pointerup`,function(){Pt=!1}),e.addEventListener(`change`,function(){Pt=!1}),e.addEventListener(`input`,function(){_.neverPlayed&&=!1;var t=parseFloat(e.value);(e===o?s:o).value=e.value,i.currentTime=t,jt=t,c.textContent=E(jt),_.dirty=!0})}),document.addEventListener(`keydown`,function(e){e.code!==`Space`||/^(TEXTAREA|INPUT|BUTTON|SUMMARY)$/.test(e.target.tagName)||a.disabled||(e.preventDefault(),zt())});var Yt=null;function Xt(e){i.pause(),Yt&&URL.revokeObjectURL(Yt),Yt=e,i.src=e,i.load()}function V(){if(!i.paused&&!i.ended||_.dirty){var e=_.neverPlayed?_.previewT:Ft();wt(e),_.dirty=!1,!Pt&&!_.neverPlayed&&(o.value=s.value=String(e),c.textContent=E(e))}requestAnimationFrame(V)}var Zt=null,Qt=null,$t=!1;function en(){return $t?Promise.resolve(null):Qt||(Qt=new Promise(function(t){var n;try{n=new Worker(URL.createObjectURL(new Blob([e(`dsp`).textContent],{type:`text/javascript`})))}catch{$t=!0,t(null);return}var r=setTimeout(function(){try{n.terminate()}catch{}$t=!0,t(null)},4e3);n.onmessage=function(e){e.data&&e.data.type===`pong`&&(clearTimeout(r),Zt=n,t(n))},n.onerror=function(e){e&&e.preventDefault&&e.preventDefault(),clearTimeout(r),$t=!0,t(null)},n.postMessage({cmd:`ping`})}),Qt)}function tn(){Zt&&(Zt.terminate(),Zt=null,Qt=null)}function nn(e,t,n){return en().then(function(r){return r?new Promise(function(i,a){r.onmessage=function(e){var t=e.data;t.type===`progress`?n&&n(t.label,t.p):t.type===`error`?a(Error(t.message)):(t.type===`demo`||t.type===`done`)&&i(t)},r.onerror=function(e){a(Error(e&&e.message||`The analysis stopped.`))},r.postMessage(e,t)}):new Promise(function(e){setTimeout(e,40)}).then(function(){var e=DSP.synthDemo(44100);return{L:e.L,R:e.R,sr:e.sr}})})}function rn(t,n,r){var i=$.status||{note:``,steps:null};$.status={label:t,p:D(n,0,1),note:r===void 0?i.note:r||``,song:e(`trackName`).textContent||``,steps:i.steps}}function an(){$.status=null}var on=[[`models`,`models`],[`stems`,`stems`],[`drums`,`drums`],[`notes`,`notes`],[`bass`,`bass`],[`voice`,`voice`],[`words`,`lyrics`],[`tone`,`tone`],[`width`,`width`]];function sn(e,t){if($.status){var n={};($.status.steps||[]).forEach(function(e){e.state&&(n[e.k]=!0)}),e&&(n[e]=!0),$.status.steps=on.filter(function(e){return e[0]!==`models`||t||n.models}).map(function(t){return{k:t[0],label:t[1],state:t[0]===e?`now`:n[t[0]]?`on`:``}})}}function cn(e,t,n){var r=e.length,i=new ArrayBuffer(44+r*4),a=new DataView(i),o=44,s;function c(e,t){for(var n=0;n<t.length;n++)a.setUint8(e+n,t.charCodeAt(n))}for(c(0,`RIFF`),a.setUint32(4,36+r*4,!0),c(8,`WAVE`),c(12,`fmt `),a.setUint32(16,16,!0),a.setUint16(20,1,!0),a.setUint16(22,2,!0),a.setUint32(24,n,!0),a.setUint32(28,n*4,!0),a.setUint16(32,4,!0),a.setUint16(34,16,!0),c(36,`data`),a.setUint32(40,r*4,!0),s=0;s<r;s++,o+=4)a.setInt16(o,D(e[s],-1,1)*32767,!0),a.setInt16(o+2,D(t[s],-1,1)*32767,!0);return new Blob([i],{type:`audio/wav`})}var H=0;function ln(e,t){return _.song=t||``,_.retry=null,_.busy&&tn(),_.busy=!0,i.pause(),Lt(!1),_.ana=null,_.dur=0,_.neverPlayed=!0,_.previewT=0,kt([],[]),o.value=s.value=`0`,c.textContent=`0:00`,l.textContent=`0:00`,_.dirty=!0,T(``),an(),rn(e,.01),++H}function un(t,n,r,i,a){pe(t),_.name=n,_.key=r,e(`trackName`).textContent=n,l.textContent=E(t.dur),o.max=s.max=String(t.dur),o.value=s.value=`0`,c.textContent=`0:00`,_.neverPlayed=a>0,_.previewT=a,i?At(i):kt([],[]),an(),Lt(!0),_.busy=!1,_.dirty=!0}function dn(){var t=ln(`Rendering the demo song`,`demo`);e(`trackName`).textContent=`Demo song`,nn({cmd:`demo`},[],null).then(function(e){t===H&&On(cn(e.L,e.R,e.sr),`pitchscape-demo.wav`,`Demo song`,t,dn,!0)}).catch(function(e){t===H&&pn(`The demo failed to render: `+e.message)})}function fn(t){var n=ln(`Opening `+t.name,``);e(`trackName`).textContent=t.name,On(t,t.name,t.name.replace(/\.[^.]+$/,``),n,function(){fn(t)},!1)}function pn(e){_.busy=!1,an(),Lt(!1),K(),T(e,!0)}function mn(e){try{var t=new URL(e);return decodeURIComponent(t.pathname.split(`/`).pop()||``).replace(/\.[^.]+$/,``)||t.hostname}catch{return e}}function hn(t,n){var r=ln(`Fetching the song`,``);if(n||=mn(t),e(`trackName`).textContent=n,Nn()===`here`)fetch(t).then(function(e){if(!e.ok)throw Error(`That link answered `+e.status+`.`);return e.blob()},function(){throw Error(`This page can’t read that link itself (its site doesn’t allow other pages to). Choose the server, which can, or download the file and load it.`)}).then(function(e){r===H&&On(e,mn(t)+`.mp3`,n,r,function(){hn(t,n)},!1)}).catch(function(e){r===H&&pn(e.message)});else{var i=new FormData;i.append(`url`,t),jn(i,null,r,`Fetching the song`).then(function(e){return!e||r!==H?null:(rn(`Loading the audio`,.97),fetch(gn+`/library/`+e.sha+`/audio`,{headers:{"X-Pitchscape-Key":bn()}}).then(function(e){if(!e.ok)throw Error(`The server didn't send the song's audio (`+e.status+`). Open it again.`);return e.blob()},function(){throw Error(`Couldn't reach the server. Check the connection and open the song again.`)}).then(function(t){r===H&&(Xt(URL.createObjectURL(t)),un(Rn(e.pack),kn(e.pack,n),`sha:`+e.sha,null,0),zn(e.pack))}))}).catch(function(e){r===H&&(pn(e&&e.message||`Couldn't open that link.`),e&&e.needsKey&&(_.retry=function(){hn(t,n)},$.askKey++))})}}var gn=null,_n=``,vn=!1,yn=Promise.resolve(null);function bn(){return v.get(`pitchscape:key`)||(vn?`local`:null)}try{yn=fetch(`config.json`,{cache:`no-store`}).then(function(e){return e.ok?e.json():null}).then(function(e){return gn=e&&e.api?String(e.api).replace(/\/$/,``):null,_n=e&&e.pipeline?String(e.pipeline):``,vn=!!(e&&e.local),gn},function(){return null})}catch{}function xn(e){return`pack:`+_n+`:`+e}function Sn(e){return!!(e&&e.version>=12&&e.segStride===17&&e.bytes)}var Cn=(function(){var e=null;function t(){return e||=new Promise(function(e,t){try{var n=indexedDB.open(`pitchscape`,1);n.onupgradeneeded=function(){n.result.createObjectStore(`packs`)},n.onsuccess=function(){e(n.result)},n.onerror=function(){t(n.error)}}catch(e){t(e)}}),e}function n(e,n){return t().then(function(t){return new Promise(function(r,i){var a=t.transaction(`packs`,e),o=n(a.objectStore(`packs`));a.oncomplete=function(){r(o&&o.result)},a.onerror=function(){i(a.error)}})})}return{get:function(e){return n(`readonly`,function(t){return t.get(e)}).catch(function(){return null})},put:function(e,t){return n(`readwrite`,function(n){return n.put(t,e)}).catch(function(){})}}})(),wn=[[`stems`,`Splitting the song into stems`,.2],[`drums`,`Reading the drums`,.45],[`notes`,`Reading the notes`,.55],[`tone`,`Listening for harsh sounds`,.8],[`width`,`Measuring how wide each sound is`,.82],[`bass`,`Following the bass`,.65],[`voice`,`Following the voice`,.75],[`words`,`Finding the lyrics`,.85],[`done`,`Finishing`,.95]];function Tn(e){for(var t=0;e&&t<wn.length;t++)if(e.indexOf(wn[t][0])===0)return wn[t];return[``,`Starting the server`,.12]}function En(e){return window.crypto&&crypto.subtle?crypto.subtle.digest(`SHA-256`,e).then(function(e){return Array.prototype.map.call(new Uint8Array(e),function(e){return(e<16?`0`:``)+e.toString(16)}).join(``)},function(){return null}):Promise.resolve(null)}function Dn(e){return e?yn.then(function(){return Cn.get(xn(e)).then(function(t){if(t&&Sn(t))return t;var n=bn();if(!gn||!n)return null;var r=window.AbortController?new AbortController:null,i=r&&setTimeout(function(){r.abort()},4e3);return fetch(gn+`/packs/`+e,{headers:{"X-Pitchscape-Key":n},signal:r?r.signal:void 0}).then(function(e){return clearTimeout(i),e.ok?e.json():null}).then(function(t){return t&&t.pack&&Sn(t.pack)?(Cn.put(xn(e),t.pack),t.pack):null},function(){return null})})}):Promise.resolve(null)}function On(e,t,n,r,i,a){var o=null;rn(`Looking for this song`,.03),e.arrayBuffer().then(En).then(function(e){return o=e,r===H?Dn(o):null}).then(function(n){if(n||r!==H)return n;if(Nn()===`here`)return Ln(e,t,o,r).then(function(e){return e&&e.pack});var i=new FormData;return i.append(`file`,e,t),jn(i,o,r,`Uploading`).then(function(e){return e&&e.pack})}).then(function(i){i&&r===H&&(Xt(URL.createObjectURL(e)),a?un(Rn(i),n,`demo`,DSP.DEMO_LYRICS,16.9):(un(Rn(i),kn(i,n),o?`sha:`+o:`file:`+t,null,0),zn(i)),T(``))}).catch(function(e){r===H&&(pn(e&&e.message||`Couldn't open that file.`),e&&e.needsKey&&(_.retry=i,$.askKey++))})}function kn(e,t){var n=e.song||{};return n.title?n.title+(n.artist?` · `+n.artist:``):t}function An(e){var t=Error(e);return t.needsKey=!0,t}function jn(e,t,n,r){return yn.then(function(){var i=bn();if(!gn)throw Error(`This page has no analysis server set up.`);if(!i)throw An(`Add the server key below and this song will be analysed.`);return rn(r,.05,`first time only, a few minutes`),fetch(gn+`/analyze`,{method:`POST`,headers:{"X-Pitchscape-Key":i},body:e}).then(function(e){if(e.status===401)throw An(`The server key is wrong. Fix it below and this song will be analysed.`);if(e.status===400||e.status===413||e.status===502)return e.json().catch(function(){return{}}).then(function(t){throw Error(t.detail||(e.status===413?`That file is over 80 MB.`:`The server said `+e.status+`.`))});if(!e.ok)throw Error(`The server said `+e.status+`. Try again in a minute.`);return e.json()},function(){throw Error(`Couldn't reach the server. Check the connection and try again.`)}).then(function(e){return t=e.sha256||t,e.status===`done`?e.pack:new Promise(function(t,r){var a=Date.now(),o=``;function s(){n===H?!o&&Date.now()-a>48e4?r(Error(`The server never started on this song. Load it again in a minute.`)):fetch(gn+`/jobs/`+encodeURIComponent(e.job)+`?key=`+encodeURIComponent(e.key),{headers:{"X-Pitchscape-Key":i}}).then(function(e){return e.json()}).then(function(e){if(n!==H)t(null);else if(e.status===`done`&&e.pack)t(e.pack);else if(e.status===`failed`)r(Error(`The analysis failed: `+String(e.error||`no reason given`).replace(/\.?\s*$/,`.`)));else{e.stage&&(o=e.stage);var i=Tn(e.stage);rn(i[1],i[2]),sn(i[0]),setTimeout(s,3e3)}},function(){setTimeout(s,6e3)}):t(null)}rn(`Starting the server`,.1),setTimeout(s,2500)})})}).then(function(e){if(e&&!Sn(e))throw Error(`The server is being updated. Load the song again in a few minutes.`);return e&&t&&Cn.put(xn(t),e),e?{pack:e,sha:t}:null})}var U=`https://huggingface.co/stopamertime/pitchscape-models/resolve/main/`,W={done:!1,ok:!1,gpu:``,why:``,phone:!1,tablet:!1,mem:0,cores:0,mb:0},Mn=(function(){var e=navigator.userAgent||``;W.phone=navigator.userAgentData?!!navigator.userAgentData.mobile:/Android|iPhone|iPod|Mobile/i.test(e),W.tablet=/iPad/.test(e)||/Macintosh/.test(e)&&navigator.maxTouchPoints>1,W.mem=navigator.deviceMemory||0,W.cores=navigator.hardwareConcurrency||0;var t=fetch(U+`manifest.json`,{cache:`no-cache`}).then(function(e){return e.ok?e.json():null}).then(function(e){var t=0;[`htdemucs_6s`,`adtof_frame_rnn`,`basic_pitch`,`crepe_full`,`align_en`].forEach(function(n){t+=e&&e[n]&&e[n].bytes||0}),W.mb=Math.round(t/1e6)},function(){}),n=navigator.gpu?navigator.gpu.requestAdapter({powerPreference:`high-performance`}).then(function(e){if(!e)W.why=`No usable graphics card`;else{var t=e.info||{};t.isFallbackAdapter||e.isFallbackAdapter?W.why=`Software graphics only: too slow`:(W.gpu=G(t.vendor,t.architecture),W.ok=!0)}},function(){W.why=`WebGPU would not start`}):Promise.resolve(W.why=`No WebGPU: use Chrome or Edge`);return Promise.all([n,t]).then(function(){W.done=!0})})();function G(e,t){var n={nvidia:`NVIDIA`,amd:`AMD`,intel:`Intel`,apple:`Apple`,qualcomm:`Qualcomm`,arm:`Arm`,microsoft:`Microsoft`}[e]||(e?e.charAt(0).toUpperCase()+e.slice(1):``),r=(t||``).replace(/^(rdna|gcn|cdna|xe|gen)-?(.*)$/i,function(e,t,n){return t.toUpperCase()+(n?` `+n:``)});return r&&r===(t||``)&&(r=r.charAt(0).toUpperCase()+r.slice(1)),(n+(r?` `+r:``)).trim()||`a graphics card`}function Nn(){var e=v.get(`pitchscape:where`);return e===`here`||e===`server`?e:W.ok&&!W.phone&&!W.tablet?`here`:`server`}function Pn(){var e=v.get(`pitchscape:hereRate`);return e&&e>0?e:0}function Fn(e){return e<90?Math.max(5,Math.round(e/5)*5)+` s`:Math.round(e/60)+` min`}function In(){$.where=Nn(),$.local=vn,$.hasKey=!!v.get(`pitchscape:key`),$.here={done:W.done,ok:W.ok,gpu:W.gpu,why:W.why,small:W.phone||W.tablet,mem:W.mem,cores:W.cores,mb:W.mb}}fs.setWhere=function(e){v.set(`pitchscape:where`,e),In()},In(),Mn.then(In);function Ln(e,t,n,r){return Mn.then(function(){if(!W.ok)throw Error(`This computer can’t analyse songs (`+W.why.toLowerCase()+`). Choose the server instead.`);return rn(`Reading the audio`,.02,``),sn(``,!0),e.arrayBuffer()}).then(function(e){return new OfflineAudioContext(2,1,44100).decodeAudioData(e.slice(0)).then(function(t){return{buf:e,mix:[t.getChannelData(0).slice(),t.getChannelData(Math.min(1,t.numberOfChannels-1)).slice()],dur:t.duration}},function(){throw Error(`This browser couldn’t read that file as audio.`)})}).then(function(e){return new Promise(function(n,i){var a=new Worker(new URL(`pipeline/analyse.worker.mjs`,location.href),{type:`module`}),o=performance.now(),s=0,c=0,l={},u=!1,d=!1,f=``,p=0,m=0,h=function(){return(performance.now()-o)/1e3};function g(e,t,n){f=e,p=Math.max(p,t),rn(f,p,n)}function _(){var t=Pn()*e.dur;if(t&&!u){var n=t-h();g(f,.55+.4*Math.min(.98,(h()-c)/Math.max(1,t-c)),n>5?`about `+Fn(n)+` left`:`nearly done`)}}function y(e,t){clearInterval(m),a.terminate(),t?i(t):n(e)}a.onerror=function(e){y(null,Error(`The analysis here stopped: `+(e.message||`its worker would not start`)+`. Choose the server instead.`))},a.onmessage=function(t){var n=t.data;if(r!==H)y(null);else if(n.download){u=!0,l[n.download.name]=n.download;var i=0,a=0;for(var o in l)i+=l[o].got,a+=l[o].total;var b=`fetching models: `+Math.round(i/1e6)+` / `+Math.round(a/1e6)+` MB · once`;d?rn(f,p,b):(g(`Fetching the models`,.02+.08*i/Math.max(1,a),b.replace(`fetching models: `,``)),sn(`models`,!0))}else if(n.progress){d=!0;var x=Tn(n.progress),S=/^stems: (\d+)\/(\d+)/.exec(n.progress),C=``;if(S){var w=+S[1],T=+S[2];if(s||=performance.now(),w>=2){var E=(performance.now()-s)/1e3/(w-1)*(T-w),D=Pn()*e.dur;C=(D>h()&&!u?`about `+Fn(Math.max(E,D-h())):`about `+Fn(E)+` for this step`)+` left`,E>180&&(C+=` · the server may be quicker`)}g(x[1],.1+.45*w/T,C)}else!c&&x[0]&&x[0]!==`stems`&&(c=h(),m=setInterval(_,1e3)),g(x[1],Math.min(x[2],.6)),_();sn(x[0],!0)}else n.pack?(u||v.set(`pitchscape:hereRate`,h()/Math.max(1,e.dur)),y(n.pack)):n.error&&y(null,Error(`The analysis here failed: `+n.error+` Choose the server to analyse it there.`))},a.postMessage({bytes:e.buf,name:t,mix:e.mix,models:U},[e.buf,e.mix[0].buffer,e.mix[1].buffer])})}).then(function(e){return e&&n&&Cn.put(xn(n),e),e?{pack:e,sha:n}:null})}function Rn(e){var t={dur:e.dur,dt:e.dt,frames:e.frames,stereo:e.stereo,noiseRef:e.noiseRef};for(var n in e.arrays)t[n]=Vn(e.arrays[n]);for(n in e.bytes)t[n]=Bn(e.bytes[n]);return t.segW=e.segStride,t.evW=e.eventStride,t.earDb=e.earDb,t}function zn(e){var t=e.stats&&e.stats.lyrics||{};e.lyrics&&e.lyrics.lines&&e.lyrics.lines.length?kt(e.lyrics.lines.map(function(e){return{text:e.text,words:e.words.map(function(e){return{text:e[0],syl:Math.max(1,DSP.syllableCount(e[0]))}})}}),e.lyrics.lines.map(function(e){return e.words.map(function(e){return e[1]})})):(Ot(),T(t.why===`instrumental`?``:t.why===`LRCLIB could not be reached`?`No words: the lyrics site was down when this song was analysed.`:t.artist&&t.title?`No words: no published lyrics were found for `+t.title+` by `+t.artist+` at this length.`:`No words: this file doesn't name its artist and title, so its lyrics couldn't be looked up.`))}function Bn(e){for(var t=atob(e.data),n=new Float32Array(t.length),r=(e.hi-e.lo)/255,i=0;i<t.length;i++)n[i]=e.lo+t.charCodeAt(i)*r;return n}function Vn(e){for(var t=atob(e),n=new Uint8Array(t.length),r=0;r<t.length;r++)n[r]=t.charCodeAt(r);return new Float32Array(n.buffer)}function K(){i.pause(),Jn(),$.hasSong=!!_.ana,$.splash=!0}function Hn(){$.splash=!1,T(``),qt()}e(`changeSong`).addEventListener(`click`,K),fs.back=function(){Hn(),a.focus({preventScroll:!0})},fs.demo=function(){Hn(),dn()},fs.link=function(e,t){Hn(),hn(e,t)},fs.file=function(e){Hn(),fn(e)},fs.say=T,document.querySelectorAll(`.ink`).forEach(function(e){e.addEventListener(`click`,function(){var t=e.dataset.layer;_.vis[t]=!_.vis[t],e.setAttribute(`aria-pressed`,String(_.vis[t])),_.dirty=!0})});function Un(e,t){return e===`secs`?t.toFixed(1)+` s`:e===`ink`||e===`weight`||e===`drumK`?`×`+t.toFixed(2):e===`vRun`||e===`noteMin`?Math.round(t)+` ms`:e===`rough0`?t.toFixed(2)+` asper`:e===`sharp0`?t.toFixed(2)+` acum`:e===`leap`?t+` st`:Math.round(t*100)+`%`}var Wn={vConf:1,vFloor:1,vRun:1,bFloor:1,hold:1,noteMin:1,drumK:1,rough0:1,sharp0:1};function Gn(){Ht.querySelectorAll(`.seg[data-key]`).forEach(function(e){var t=e.dataset.key;e.querySelectorAll(`button`).forEach(function(e){e.setAttribute(`aria-pressed`,String(String(S[t])===e.dataset.v))})}),Ht.querySelectorAll(`input[type="range"][data-key]`).forEach(function(t){var n=t.dataset.key,r=n===`secs`?S.secs>0?S.secs:ne:S[n];t.value=String(r),e(`lab-`+n+`-v`).textContent=Un(n,r)});var t=document.documentElement.style;t.setProperty(`--drum`,P.drum),t.setProperty(`--c-synth`,P.pluck),[`bass`,`voice`,`guitar`,`piano`,`words`].forEach(function(e){t.setProperty(`--c-`+e,P[e])})}function Kn(e){C(),(Wn[e]||e===`all`)&&(ge(),Ot()),(e===`secs`||e===`all`)&&de(),(e===`font`||e===`wordSize`||e===`weight`||e===`all`)&&Et(S.font).then(function(){Ot(),_.dirty=!0}),Gn(),_.dirty=!0}Ht.querySelectorAll(`.seg[data-key] button`).forEach(function(e){e.addEventListener(`click`,function(){var t=e.parentNode.dataset.key;S[t]=e.dataset.v,Kn(t)})}),Ht.querySelectorAll(`input[type="range"][data-key]`).forEach(function(e){e.addEventListener(`input`,function(){var t=e.dataset.key;S[t]=parseFloat(e.value),Kn(t)})}),e(`labReset`).addEventListener(`click`,function(){S=Object.assign({},y),Kn(`all`)}),e(`labAll`).addEventListener(`click`,function(){[`vConf`,`vFloor`,`vRun`,`bFloor`,`hold`,`noteMin`,`drumK`].forEach(function(t){S[t]=parseFloat(e(`lab-`+t).min)}),Kn(`all`)});function qn(){Ht.hidden=!1,Vt.setAttribute(`aria-expanded`,`true`),Zn(),qt()}function Jn(){var e=!Ht.hidden&&Ht.contains(document.activeElement);Ht.hidden=!0,Vt.setAttribute(`aria-expanded`,`false`),Zn(),qt(),e&&Vt.focus({preventScroll:!0})}Vt.addEventListener(`click`,function(){Ht.hidden?qn():Jn()}),document.querySelectorAll(`[data-close]`).forEach(function(e){e.addEventListener(`click`,Jn)}),e(`labPlay`).addEventListener(`click`,zt),document.addEventListener(`keydown`,function(e){e.key===`Escape`&&(Gt()||!Yn.hidden)&&(Yn.hidden?Jn():Zn())});var Yn=e(`bubble`),Xn=null;function Zn(){Xn&&Xn.setAttribute(`aria-expanded`,`false`),Yn.hidden=!0,Xn=null}Ht.querySelectorAll(`.k[data-tip]`).forEach(function(e){e.addEventListener(`click`,function(){if(Xn===e)Zn();else{Zn(),Xn=e,e.setAttribute(`aria-expanded`,`true`),Yn.textContent=e.dataset.tip,Yn.hidden=!1;var t=Ht.getBoundingClientRect(),n=e.getBoundingClientRect(),r=Ht.querySelector(`.panel-head`).getBoundingClientRect(),i=Yn.offsetHeight,a=n.top-i-12>r.bottom,o=Math.max(12,n.left-t.left-6);Yn.classList.toggle(`above`,a),Yn.classList.toggle(`below`,!a),Yn.style.left=o+`px`,Yn.style.top=n.top-t.top+Ht.scrollTop+(a?-i-10:n.height+10)+`px`,Yn.style.setProperty(`--tail`,Math.max(12,Math.min(n.width-10,24)+n.left-t.left-o-6)+`px`)}})}),document.addEventListener(`pointerdown`,function(e){Xn&&!Yn.contains(e.target)&&!Xn.contains(e.target)&&Zn()});var Qn=Ht.querySelectorAll(`[role="tab"]`);function $n(e){Qn.forEach(function(t){t.setAttribute(`aria-selected`,String(t.dataset.tab===e)),t.tabIndex=t.dataset.tab===e?0:-1}),Ht.querySelectorAll(`.pane`).forEach(function(t){t.hidden=t.dataset.pane!==e}),Zn(),v.set(`pitchscape:tab`,e)}Qn.forEach(function(e){e.addEventListener(`click`,function(){$n(e.dataset.tab)})}),$n(Ht.querySelector(`[data-tab="`+v.get(`pitchscape:tab`)+`"]`)?v.get(`pitchscape:tab`):`colour`),Gn(),fs.setKey=function(e){if(e?v.set(`pitchscape:key`,e):v.del(`pitchscape:key`),In(),e&&_.retry){var t=_.retry;_.retry=null,Hn(),t()}else T(e?`Server key saved.`:`Server key removed.`)},S.font!==`grotesque`&&Et(S.font).then(function(){Ot(),_.dirty=!0}),window.ResizeObserver?new ResizeObserver(de).observe(t):window.addEventListener(`resize`,de),de(),document.fonts&&document.fonts.ready&&document.fonts.ready.then(function(){Ot(),_.dirty=!0}),requestAnimationFrame(V),yn.then(In)}var _c=e((()=>{ps()}));t((()=>{n(),i(),ts(),Ys(),hc(),Fs(),_c();var e=document.createElement(`script`);e.id=`dsp`,e.textContent=r,document.body.append(e),Ni(Gs,{target:document.querySelector(`main.app`)}),Ni(lc,{target:document.getElementById(`plate`)}),Ni(As,{target:document.getElementById(`where-lab`),props:{id:`where-lab`}}),gc()}))();