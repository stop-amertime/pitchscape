/* Pitchscape: analysis engine.
   Pure JS, no DOM. Runs inside a Web Worker (or on the main thread as a fallback).
   - analyze(L, R, sampleRate, progress) splits a song into layers and returns compact feature tracks
   - synthDemo() renders an original demo song (drums, bass, pads, pluck, sung melody)
   - parseLyrics / alignLyrics / alignToAnchors place pasted lyrics against the detected singing */
var DSP = (function () {
  'use strict';
  var SR = 22050, N = 2048, HOP = 512, K = 800, BIN = SR / N, NP = 6, SEGW = 12;
  /* drum hits carry a coarse spectrum: DB bands, log-spaced from 30 Hz to 11 kHz, so each hit can be printed at the
     frequencies where its energy actually is. Event record: [time, type, strength, Hz, ring s, band 0..DB-1]. */
  var DB = 16, DRUM_BANDS = [], EVW = 5 + DB;
  for (var di = 0; di <= DB; di++) DRUM_BANDS.push(30 * Math.pow(SR / 2 / 30, di / DB));

  function mtof(m) { return 440 * Math.pow(2, (m - 69) / 12); }
  function ftom(f) { return 69 + 12 * Math.log2(f / 440); }

  function biquad(type, fc, Q, sr) {
    var w0 = 2 * Math.PI * fc / sr, c = Math.cos(w0), s = Math.sin(w0), a = s / (2 * Q);
    var b0, b1, b2, a0 = 1 + a, a1 = -2 * c, a2 = 1 - a;
    if (type === 'lp') { b0 = (1 - c) / 2; b1 = 1 - c; b2 = b0; }
    else if (type === 'hp') { b0 = (1 + c) / 2; b1 = -(1 + c); b2 = b0; }
    else if (type === 'notch') { b0 = 1; b1 = -2 * c; b2 = 1; }
    else { b0 = a; b1 = 0; b2 = -a; }
    b0 /= a0; b1 /= a0; b2 /= a0; a1 /= a0; a2 /= a0;
    var x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    return function (x) {
      var y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      x2 = x1; x1 = x; y2 = y1; y1 = y;
      return y;
    };
  }

  function resample(x, from, to) {
    if (Math.abs(from - to) < 1) return x;
    var src = x, i;
    if (from > to) {
      src = new Float32Array(x.length);
      var f1 = biquad('lp', to * 0.42, 0.5412, from), f2 = biquad('lp', to * 0.42, 1.3066, from);
      for (i = 0; i < x.length; i++) src[i] = f2(f1(x[i]));
    }
    var ratio = from / to, n = Math.floor(src.length / ratio), out = new Float32Array(n), last = src.length - 1;
    for (var j = 0; j < n; j++) {
      var p = j * ratio, i0 = p | 0, fr = p - i0, a = src[i0], b = i0 < last ? src[i0 + 1] : a;
      out[j] = a + (b - a) * fr;
    }
    return out;
  }

  function makeFFT(n) {
    var bits = Math.round(Math.log2(n)), rev = new Uint32Array(n), cos = new Float64Array(n / 2), sin = new Float64Array(n / 2), i;
    for (i = 0; i < n; i++) { var r = 0; for (var b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b); rev[i] = r; }
    for (i = 0; i < n / 2; i++) { cos[i] = Math.cos(2 * Math.PI * i / n); sin[i] = Math.sin(2 * Math.PI * i / n); }
    return function (re, im) {
      var i, j, t;
      for (i = 0; i < n; i++) { j = rev[i]; if (j > i) { t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
      for (var size = 2; size <= n; size <<= 1) {
        var half = size >> 1, step = n / size;
        for (i = 0; i < n; i += size) {
          for (j = i, t = 0; j < i + half; j++, t += step) {
            var l = j + half, c = cos[t], s = sin[t];
            var tr = re[l] * c + im[l] * s, ti = im[l] * c - re[l] * s;
            re[l] = re[j] - tr; im[l] = im[j] - ti; re[j] += tr; im[j] += ti;
          }
        }
      }
    };
  }

  function pct(arr, q) {
    var n = arr.length; if (!n) return 0;
    var c = Float32Array.from(arr); c.sort();
    return c[Math.min(n - 1, Math.max(0, Math.round(q * (n - 1))))];
  }

  function med9(b) {
    for (var a = 1; a < 9; a++) { var v = b[a], j = a - 1; while (j >= 0 && b[j] > v) { b[j + 1] = b[j]; j--; } b[j + 1] = v; }
    return b[4];
  }

  /* Onset detection on a band-energy envelope: log compression, positive flux, adaptive threshold. */
  function onsetDetect(E, minGap) {
    var F = E.length, ref = pct(E, 0.95) + 1e-20, e = new Float32Array(F), d = new Float32Array(F), i;
    for (i = 0; i < F; i++) e[i] = Math.log(1 + 30 * E[i] / ref);
    for (i = 1; i < F; i++) { var v = e[i] - e[i - 1]; d[i] = v > 0 ? v : 0; }
    var p99 = pct(d, 0.99) + 1e-9, W = 12, cs = new Float64Array(F + 1), dn = new Float32Array(F);
    for (i = 0; i < F; i++) { cs[i + 1] = cs[i] + d[i]; dn[i] = Math.min(1.5, d[i] / p99); }
    var hits = [], last = -1e9;
    for (i = 1; i < F - 1; i++) {
      if (d[i] < d[i - 1] || d[i] < d[i + 1]) continue;
      var a = Math.max(0, i - W), b = Math.min(F, i + W + 1), mean = (cs[b] - cs[a]) / (b - a);
      if (d[i] > 1.5 * mean + 0.18 * p99 && i - last >= minGap) { hits.push(i); last = i; }
    }
    return { hits: hits, dn: dn };
  }

  function nearMax(arr, i, r) { var m = 0; for (var j = Math.max(0, i - r); j <= Math.min(arr.length - 1, i + r); j++) if (arr[j] > m) m = arr[j]; return m; }


  /* Bass pitch in the time domain. The STFT's 10.8 Hz bins are coarser than a semitone below ~180 Hz, so low notes
     read flat. Periodicity (YIN's normalised difference) on a low-passed, decimated copy resolves them to a few cents.
     Returns the difference curve for every frame so the line can be chosen across time (bassPath). */
  var BD = 8, BSR = SR / BD, BW = 176, BM0 = 23, BM1 = 60, NB = BM1 - BM0 + 1, TMAX = Math.ceil(BSR / mtof(BM0 - 0.6)) + 1;
  function lowBand(x) {
    var f1 = biquad('lp', 420, 0.5412, SR), f2 = biquad('lp', 420, 1.3066, SR), n = Math.floor(x.length / BD), y = new Float32Array(n), i, j;
    for (i = 0, j = 0; i < x.length; i++) { var v = f2(f1(x[i])); if (i % BD === 0 && j < n) y[j++] = v; }
    return y;
  }
  /* normalised difference d'(tau) of y over BW samples from s0, written to out[o + tau] */
  function yinAt(y, s0, out, o, TS) {
    var e0 = 0, j, run = 0, tau, acc, df;
    for (j = 0; j < BW; j++) e0 += y[s0 + j] * y[s0 + j];
    if (e0 < 1e-10) return false;
    for (tau = 1; tau < TS; tau++) {
      acc = 0; for (j = 0; j < BW; j++) { df = y[s0 + j] - y[s0 + j + tau]; acc += df * df; }
      run += acc; out[o + tau] = acc * tau / (run + 1e-20);
    }
    return true;
  }
  function bestTau(d, o, a, z) { var bt = a; for (var q = a + 1; q <= z; q++) if (d[o + q] < d[o + bt]) bt = q; return bt; }
  /* A song reuses one kick drum, and its boom is a low sine. Each hit's boom pitch is read just after the hit; the
     song's boom is the most common of those on strong hits (the bass under them changes; the boom doesn't).
     Returns { hz: per-hit Hz (0 if unclear), boom: Hz or 0 if no consistent boom }. */
  function kickPitches(y, hits, dn) {
    var TS = TMAX + 2, d = new Float32Array(TS).fill(1), hist = new Float32Array(NB), n = 0, hop = HOP / BD, hz = new Float32Array(hits.length);
    hits.forEach(function (h, i) {
      var s0 = Math.round((h + 4) * hop);
      if (s0 + BW + TS >= y.length || !yinAt(y, s0, d, 0, TS)) return;
      var bt = bestTau(d, 0, Math.floor(BSR / mtof(BM0 + 25)), Math.ceil(BSR / mtof(BM0 - 0.5)));
      if (d[bt] > 0.3) return;
      hz[i] = BSR / bt;
      if (dn[h] < 0.35) return;
      var mi = Math.round(ftom(BSR / bt)) - BM0; if (mi >= 0 && mi <= 13) { hist[mi] += 1; n++; }
    });
    var boom = 0;
    if (n >= 6) {
      var bi = 0; for (var i = 1; i < NB; i++) if (hist[i] > hist[bi]) bi = i;
      var near = hist[bi] + (bi > 0 ? hist[bi - 1] : 0) + (bi < NB - 1 ? hist[bi + 1] : 0);
      if (near >= 0.45 * n) boom = mtof(BM0 + bi);
    }
    return { hz: hz, boom: boom };
  }
  function bassYin(y, F) {
    var TS = TMAX + 2, dp = new Float32Array(F * TS).fill(1), hop = HOP / BD;
    for (var t = 0; t < F; t++) {
      var s0 = Math.round(t * hop - (BW + TMAX) / 2);
      if (s0 >= 0 && s0 + BW + TS < y.length) yinAt(y, s0, dp, t * TS, TS);
    }
    return { dp: dp, TS: TS };
  }
  /* Choose the bass line through time (Viterbi over semitones plus "no bass"). Each frame scores a note by how
     periodic the low band is at that period; a note whose octave above scores as well is probably a subharmonic.
     Frames under a kick are trusted less (a kick's boom is a pitched sweep), so the line there follows the note
     heard once the kick fades. Returns f0 per frame, refined to the exact dip. */
  function bassPath(Y, F, kickW) {
    var TS = Y.TS, dp = Y.dp, S = NB + 1, cost = new Float32Array(S), prev = new Float32Array(S), back = new Uint8Array(F * S), c = new Float32Array(NB);
    var UNV = 0.42, t, m, q;
    function dAt(o, tau) { var i0 = Math.floor(tau), fr = tau - i0; return dp[o + i0] * (1 - fr) + dp[o + i0 + 1] * fr; }
    for (t = 0; t < F; t++) {
      var o = t * TS;
      for (m = 0; m < NB; m++) {
        var tc = BSR / mtof(BM0 + m), lo = BSR / mtof(BM0 + m + 0.5), hi = BSR / mtof(BM0 + m - 0.5), best = dAt(o, tc);
        for (q = Math.ceil(lo); q <= hi; q++) if (dp[o + q] < best) best = dp[o + q];
        c[m] = best;
      }
      /* a periodic sound also repeats at 2x and 3x its period: among near-best notes, keep the highest */
      var g = 1; for (m = 0; m < NB; m++) if (c[m] < g) g = c[m];
      var gate = g + 0.3;
      for (m = 0; m < NB; m++) if (c[m] <= gate && ((m + 12 < NB && c[m + 12] <= gate) || (m + 19 < NB && c[m + 19] <= gate) || (m + 24 < NB && c[m + 24] <= gate))) c[m] += 0.2;
      var w = 1 - 0.75 * kickW[t];
      for (m = 0; m < NB; m++) cost[m] = UNV + (c[m] - UNV) * w;
      cost[NB] = UNV;
      if (t === 0) { prev.set(cost); continue; }
      var bo = t * S, minP = 1e9, minI = 0;
      for (q = 0; q < S; q++) if (prev[q] < minP) { minP = prev[q]; minI = q; }
      for (m = 0; m < S; m++) {
        var b = prev[m], bi = m, jump = m === NB ? 0.25 : 0.3;
        if (minP + jump < b) { b = minP + jump; bi = minI; }
        if (m < NB) for (q = Math.max(0, m - 2); q <= Math.min(NB - 1, m + 2); q++) if (q !== m && prev[q] + 0.12 < b) { b = prev[q] + 0.12; bi = q; }
        back[bo + m] = bi; cost[m] += b;
      }
      for (q = 0; q < S; q++) prev[q] = cost[q];
    }
    var st = 0, mv = 1e9; for (q = 0; q < S; q++) if (prev[q] < mv) { mv = prev[q]; st = q; }
    var hz = new Float32Array(F);
    for (t = F - 1; t >= 0; t--) {
      if (st < NB) {
        var o2 = t * TS, a = Math.floor(BSR / mtof(BM0 + st + 0.6)), z = Math.ceil(BSR / mtof(BM0 + st - 0.6)), bt = a;
        for (q = a; q <= z; q++) if (dp[o2 + q] < dp[o2 + bt]) bt = q;
        var A = dp[o2 + bt - 1], B = dp[o2 + bt], C = dp[o2 + bt + 1], den = A - 2 * B + C, off = den > 0 ? 0.5 * (A - C) / den : 0;
        off = off > 0.5 ? 0.5 : off < -0.5 ? -0.5 : off;
        var f = BSR / (bt + off);
        hz[t] = Math.abs(ftom(f) - (BM0 + st)) < 0.6 ? f : mtof(BM0 + st);
      }
      if (t > 0) st = back[t * S + st];
    }
    return hz;
  }

  /* ---------------------------------------------------------------- analysis */
  function analyze(L, R, srcRate, progress, opts) {
    progress = progress || function () {}; opts = opts || {};
    var iso = opts.isolated === 'vocals', isoOther = opts.isolated === 'other', dbgRuns = [];
    var i, k, t, j;
    var n0 = L.length, stereo = !!R && R !== L;
    progress('Matching sample rate', 0.02);
    var mid = new Float32Array(n0), side = stereo ? new Float32Array(n0) : null;
    for (i = 0; i < n0; i++) { var l = L[i], r = stereo ? R[i] : l; mid[i] = 0.5 * (l + r); if (stereo) side[i] = 0.5 * (l - r); }
    var m = resample(mid, srcRate, SR); mid = null;
    var lowY = lowBand(m);
    var s = stereo ? resample(side, srcRate, SR) : null; side = null;
    if (s) { var se = 0, me = 0; for (i = 0; i < m.length; i += 5) { se += s[i] * s[i]; me += m[i] * m[i]; } if (se < me * 1e-5) s = null; }
    stereo = !!s;
    var len = m.length, F = Math.max(16, Math.ceil(len / HOP));

    /* 1. spectrum: mid magnitude + how centered each bin is (from the side channel) */
    var mag = new Float32Array(F * K), cen = new Uint8Array(F * K);
    var win = new Float64Array(N); for (i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N);
    var fft = makeFFT(N), re = new Float64Array(N), im = new Float64Array(N);
    for (t = 0; t < F; t++) {
      var start = t * HOP - N / 2, base = t * K;
      for (i = 0; i < N; i++) {
        var idx = start + i;
        if (idx >= 0 && idx < len) { re[i] = m[idx] * win[i]; im[i] = s ? s[idx] * win[i] : 0; } else { re[i] = 0; im[i] = 0; }
      }
      fft(re, im);
      if (s) {
        for (k = 0; k < K; k++) {
          var nk = (N - k) & (N - 1);
          var xr = (re[k] + re[nk]) * 0.5, xi = (im[k] - im[nk]) * 0.5, yr = (im[k] + im[nk]) * 0.5, yi = (re[nk] - re[k]) * 0.5;
          var xm = Math.sqrt(xr * xr + xi * xi), ym = Math.sqrt(yr * yr + yi * yi), c = 2 * xm / (xm + ym + 1e-12) - 1;
          mag[base + k] = xm; cen[base + k] = c <= 0 ? 0 : (c * 255 + 0.5) | 0;
        }
      } else {
        for (k = 0; k < K; k++) { mag[base + k] = Math.sqrt(re[k] * re[k] + im[k] * im[k]); cen[base + k] = 255; }
      }
      if ((t & 255) === 0) progress('Reading the spectrum', 0.04 + 0.3 * t / F);
    }
    m = null; s = null;

    /* 2. harmonic / percussive split (median filtering) and per-frame features */
    var kickE = new Float32Array(F), snE = new Float32Array(F), snC = new Float32Array(F), hatE = new Float32Array(F), hatC = new Float32Array(F), totE = new Float32Array(F);
    var bassE = new Float32Array(F), bassF = new Float32Array(F), bassB = new Float32Array(F);
    var leadS = new Float32Array(F), leadC = new Float32Array(F), leadM = new Float32Array(F), leadA = new Float32Array(F), leadB = new Float32Array(F), leadZ = new Float32Array(F), leadCen = new Float32Array(F), leadHi = new Float32Array(F);
    var pkM = new Float32Array(F * NP), pkA = new Float32Array(F * NP), pkB = new Float32Array(F * NP), pkZ = new Float32Array(F * NP), pkE = new Float32Array(F * NP), pkL = new Uint8Array(F * NP), pkN = new Uint8Array(F);
    var harm = new Float32Array(K), perc = new Float32Array(K), lc = new Float32Array(K), b9 = new Float32Array(9), offs = new Int32Array(9), csum = new Float64Array(K + 1), snFl = new Float32Array(F), pb = new Float32Array(F * DB), dbK = [];
    for (var bk = 0; bk <= DB; bk++) dbK.push(Math.max(bk ? dbK[bk - 1] + 1 : 2, Math.min(K, Math.round(DRUM_BANDS[bk] / BIN))));
    var leadCand = [], bassCand = [], mm;
    for (mm = 47; mm <= 84.001; mm += 1 / 3) leadCand.push(mtof(mm));
    for (mm = 23; mm <= 60.001; mm += 1 / 3) bassCand.push(mtof(mm));
    var nLC = leadCand.length, candK = new Int32Array(12), candA = new Float32Array(12), Sbuf = new Float32Array(nLC);

    function pk(arr, off, f) { var b = f / BIN, i0 = Math.floor(b); if (i0 < 1 || i0 >= K - 1) return 0; var a = arr[off + i0], c = arr[off + i0 + 1]; return a > c ? a : c; }
    /* sharpen a coarse f0 using the strongest of its first hmax harmonics (parabolic peak fit) */
    function refine(arr, f, hmax) {
      var bestA = 0, bestF = f;
      for (var h = 1; h <= hmax; h++) {
        var k0 = Math.round(h * f / BIN), km = -1, am = 0;
        for (var q = k0 - 2; q <= k0 + 2; q++) { if (q < 1 || q >= K - 1) continue; if (arr[q] > am) { am = arr[q]; km = q; } }
        if (km < 0 || am <= bestA) continue;
        var a1 = Math.log(arr[km - 1] + 1e-20), b1 = Math.log(arr[km] + 1e-20), c1 = Math.log(arr[km + 1] + 1e-20), dn = a1 - 2 * b1 + c1;
        var d = dn < 0 ? 0.5 * (a1 - c1) / dn : 0; d = d > 0.5 ? 0.5 : d < -0.5 ? -0.5 : d;
        var est = (km + d) * BIN / h;
        if (Math.abs(12 * Math.log2(est / f)) < 1) { bestA = am; bestF = est; }
      }
      return bestF;
    }
    function at(arr, off, f) { var b = f / BIN, i0 = Math.floor(b); if (i0 < 0 || i0 >= K - 1) return 0; var fr = b - i0; return arr[off + i0] * (1 - fr) + arr[off + i0 + 1] * fr; }

    for (t = 0; t < F; t++) {
      var bt = t * K;
      for (j = 0; j < 9; j++) { var tt = t + j - 4; offs[j] = (tt < 0 ? 0 : tt >= F ? F - 1 : tt) * K; }
      var te = 0;
      for (k = 0; k < K; k++) {
        for (j = 0; j < 9; j++) b9[j] = mag[offs[j] + k];
        var h = med9(b9);
        for (j = 0; j < 9; j++) { var kk = k + j - 4; b9[j] = mag[bt + (kk < 0 ? 0 : kk >= K ? K - 1 : kk)]; }
        var p = med9(b9), M = mag[bt + k], h2 = h * h, p2 = p * p, hm = h2 / (h2 + p2 + 1e-20);
        harm[k] = M * hm; perc[k] = M - harm[k]; te += M * M;
      }
      totE[t] = te;

      /* drums from the percussive part */
      var ke = 0, se2 = 0, sc = 0, he = 0, hc = 0, v;
      for (k = 3; k <= 13; k++) ke += perc[k] * perc[k];
      var lg = 0, ar = 0;
      for (k = 74; k <= 465; k++) { v = perc[k] * perc[k]; se2 += v; sc += v * k; lg += Math.log(perc[k] + 1e-12); ar += perc[k]; }
      snFl[t] = Math.exp(lg / 392) / (ar / 392 + 1e-12);
      for (k = 464; k < K; k++) { v = perc[k] * perc[k]; he += v; hc += v * k; }
      for (var bb = 0, pbo = t * DB; bb < DB; bb++) { var pe3 = 0; for (k = dbK[bb]; k < dbK[bb + 1] && k < K; k++) pe3 += perc[k] * perc[k]; pb[pbo + bb] = pe3; }
      kickE[t] = ke; snE[t] = se2; snC[t] = se2 > 0 ? sc / se2 * BIN : 1500; hatE[t] = he; hatC[t] = he > 0 ? hc / he * BIN : 7000;

      /* bass: harmonic sum over low candidates */
      var bE = 0; for (k = 3; k <= 24; k++) bE += harm[k] * harm[k]; bassE[t] = bE;
      var best = 0, bf = 0, ci, f;
      for (ci = 0; ci < bassCand.length; ci++) {
        f = bassCand[ci];
        v = pk(harm, 0, f) + 0.5 * pk(harm, 0, 2 * f) + 0.25 * pk(harm, 0, 3 * f);
        if (v > best) { best = v; bf = f; }
      }
      if (bf > 0) bf = refine(harm, bf, 3);
      bassF[t] = bf;
      if (bf > 0) {
        var lo = pk(harm, 0, bf) + pk(harm, 0, 2 * bf), hi = 0;
        for (j = 3; j <= 7; j++) hi += pk(harm, 0, j * bf);
        bassB[t] = hi / (lo + hi + 1e-12);
      }

      /* lead line: harmonic summation on the centered, harmonic part */
      csum[0] = 0; for (k = 0; k < K; k++) csum[k + 1] = csum[k] + harm[k];
      for (k = 0; k < K; k++) {
        var lo3 = k < 7 ? 0 : k - 7, hi3 = k + 8 > K ? K : k + 8, fl = (csum[hi3] - csum[lo3]) / (hi3 - lo3), wv = harm[k] - 1.1 * fl;
        lc[k] = wv > 0 ? Math.sqrt(wv) * (0.2 + 0.8 * cen[bt + k] / 255) : 0;
      }
      if (!iso && bf > 0 && bE > 0.08 * te) {
        for (j = 1; j <= 8 && j * bf < 270; j++) { var kc = Math.round(j * bf / BIN); for (var q2 = kc - 1; q2 <= kc + 1; q2++) if (q2 >= 0 && q2 < K) lc[q2] *= 0.25; }
      }
      best = 0; var bi = 0, sum = 0, bestB = 0, prevM = t > 0 ? leadM[t - 1] : 0, prevOk = t > 0 && leadS[t - 1] > 0;
      for (ci = 0; ci < nLC; ci++) {
        f = leadCand[ci]; var S = 0, w = 1;
        for (j = 1; j <= 10; j++) { var fh = j * f; if (fh > 5000) break; S += w * pk(lc, 0, fh); w *= 0.82; }
        Sbuf[ci] = S; sum += S;
        /* mild preference for staying on the previous frame's note: keeps held notes from slipping */
        var Sb = (prevOk && Math.abs(ftom(f) - prevM) < 1) ? S * 1.25 : S;
        if (Sb > bestB) { bestB = Sb; best = S; bi = ci; }
      }
      leadS[t] = best; leadC[t] = best / (sum / nLC + 1e-12);
      var lf = refine(harm, leadCand[bi], 4); leadM[t] = ftom(lf);
      var tot = 0, hiA = 0, ce = 0, up = 0, all = 0;
      for (j = 1; j <= 10; j++) { var fq = j * lf; if (fq > 5000) break; var aa = pk(harm, 0, fq); tot += aa; if (j >= 4) hiA += aa; ce += aa * cen[bt + Math.min(K - 1, Math.round(fq / BIN))] / 255; }
      for (j = 1; j <= 30; j++) { var fu = j * lf; if (fu > 4000) break; var au = pk(harm, 0, fu); all += au; if (fu > 800) up += au; }
      leadA[t] = tot; leadB[t] = tot > 0 ? hiA / tot : 0; leadCen[t] = tot > 0 ? ce / tot : 0; leadHi[t] = all > 0 ? up / all : 0;
      var pe = 0, tr = 0;
      for (j = 1; j <= 16; j++) { var fz = j * lf; if (fz < 900) continue; if (fz > 4500) break; pe += pk(mag, bt, fz); tr += at(mag, bt, fz + 0.5 * lf); }
      leadZ[t] = pe > 0 ? tr / pe : 0;

      /* other harmonic notes: spectral peaks, folded so overtones don't count as notes */
      var nc = 0;
      for (k = 17; k <= 232; k++) {
        v = harm[k];
        if (v > harm[k - 1] && v >= harm[k + 1] && v > harm[k - 2] && v >= harm[k + 2]) {
          if (nc < 12) { candK[nc] = k; candA[nc] = v; nc++; }
          else { var mi = 0; for (j = 1; j < 12; j++) if (candA[j] < candA[mi]) mi = j; if (v > candA[mi]) { candK[mi] = k; candA[mi] = v; } }
        }
      }
      var cands = [];
      for (j = 0; j < nc; j++) {
        var kb = candK[j], al = Math.log(harm[kb - 1] + 1e-20), be = Math.log(harm[kb] + 1e-20), ga = Math.log(harm[kb + 1] + 1e-20), den = al - 2 * be + ga;
        var dp = den < 0 ? 0.5 * (al - ga) / den : 0; dp = dp > 0.5 ? 0.5 : dp < -0.5 ? -0.5 : dp;
        cands.push({ f: (kb + dp) * BIN, a: candA[j] });
      }
      cands.sort(function (x, y) { return x.f - y.f; });
      var acc = [];
      for (j = 0; j < cands.length; j++) {
        var cc = cands[j], isH = false;
        for (var q = 0; q < acc.length; q++) { var rr = cc.f / acc[q].f, nr = Math.round(rr); if (nr >= 2 && nr <= 8 && Math.abs(rr / nr - 1) < 0.03 && cc.a < acc[q].a * 1.6) { isH = true; break; } }
        if (!isH) acc.push(cc);
      }
      acc.sort(function (x, y) { return y.a - x.a; });
      var np = Math.min(NP, acc.length); pkN[t] = np;
      for (j = 0; j < np; j++) {
        var f0 = acc[j].f, o = t * NP + j, num = 0, dnm = 0, pe2 = 0, tr2 = 0, hh, ev2 = 0, od2 = 0;
        for (hh = 1; hh <= 8; hh++) { var fh2 = hh * f0; if (fh2 > 8000) break; var a2 = pk(harm, 0, fh2); dnm += a2; if (hh >= 3) num += a2; if (hh >= 2 && hh <= 7) { if (hh & 1) od2 += a2; else ev2 += a2; } }
        for (hh = 1; hh <= 4; hh++) { pe2 += pk(mag, bt, hh * f0); tr2 += at(mag, bt, (hh + 0.5) * f0); }
        pkM[o] = ftom(f0); pkA[o] = acc[j].a; pkB[o] = dnm > 0 ? num / dnm : 0; pkZ[o] = pe2 > 0 ? tr2 / pe2 : 0; pkE[o] = ev2 + od2 > 0 ? ev2 / (ev2 + od2) : 0.5;
        var rl = f0 / lf, nl = Math.round(rl);
        pkL[o] = (nl >= 1 && nl <= 8 && Math.abs(rl / nl - 1) < 0.035) ? 1 : 0;
      }
      if ((t & 127) === 0) progress('Splitting drums from tones', 0.35 + 0.5 * t / F);
    }
    mag = null; cen = null;

    var dt = HOP / SR;

    /* 3. drum hits */
    progress('Finding drum hits', 0.87);
    var ko = onsetDetect(kickE, 5), so = onsetDetect(snE, 5), ho = onsetDetect(hatE, 3), flThr = 0.3;
    var events = [], kp = kickPitches(lowY, ko.hits, ko.dn), boom = kp.boom;
    /* how long a hit rings: frames until its band falls 14 dB below the hit, or the next hit of its kind */
    function ring(E, t, hits, n) {
      var p = Math.max(E[t], t + 1 < F ? E[t + 1] : 0), stop = n + 1 < hits.length ? hits[n + 1] : F, u = t + 2;
      while (u < F && u < stop && u < t + 40 && E[u] > 0.04 * p) u++;
      return (u - t) * dt;
    }
    function hit(t, type, strength, hz, ringS) {
      /* the hit's own spectrum: what each band gained over the two frames before it, so whatever else is
         playing (bass, a kick under a hat) doesn't count. Each kind only claims its own region: a hat landing on a
         bass note has no business at 150 Hz. */
      var e = [t * dt, type, strength, hz, ringS], mx = 1e-20, b, v, lo = type === 2 ? 1400 : type === 1 ? 120 : 0;
      for (b = 0; b < DB; b++) {
        if (Math.sqrt(DRUM_BANDS[b] * DRUM_BANDS[b + 1]) < lo) { e.push(0); continue; }
        var cur = Math.max(pb[t * DB + b], t + 1 < F ? pb[(t + 1) * DB + b] : 0), before = Math.max(t > 0 ? pb[(t - 1) * DB + b] : 0, t > 1 ? pb[(t - 2) * DB + b] : 0);
        v = Math.sqrt(Math.max(0, cur - before)); e.push(v); if (v > mx) mx = v;
      }
      for (b = 5; b < EVW; b++) e[b] /= mx;
      events.push(e);
    }
    ko.hits.forEach(function (t, n) { hit(t, 0, Math.min(1, ko.dn[t]), kp.hz[n] || boom || 52, ring(kickE, t, ko.hits, n)); });
    so.hits.forEach(function (t, n) {
      var kd = nearMax(ko.dn, t, 1);
      if (kd > 0.4 && so.dn[t] < 1.1 * kd) return;
      if (Math.max(snFl[t], snFl[Math.min(F - 1, t + 1)]) < flThr) return;
      hit(t, 1, Math.min(1, so.dn[t]), Math.max(snC[t], snC[Math.min(F - 1, t + 1)]), ring(snE, t, so.hits, n));
    });
    ho.hits.forEach(function (t, n) {
      var sd = nearMax(so.dn, t, 1);
      if (sd > 0.4 && ho.dn[t] < 1.1 * sd) return;
      hit(t, 2, Math.min(1, ho.dn[t]), hatC[t], ring(hatE, t, ho.hits, n));
    });
    events.sort(function (a, b) { return a[0] - b[0]; });

    /* 4. bass track */
    var bRef = pct(bassE, 0.98) + 1e-20, bassN = new Float32Array(F), bassHz = new Float32Array(F), bassBr = new Float32Array(F), env = 0, eb = 0;
    for (t = 0; t < F; t++) {
      var x = Math.min(1.2, Math.sqrt(bassE[t] / bRef));
      env += (x > env ? 0.6 : 0.25) * (x - env); bassN[t] = env;
      eb += 0.2 * (bassB[t] - eb); bassBr[t] = eb;
    }
    /* kicks are pitched sweeps in the bass range: how much each frame sits under one */
    var kickW = new Float32Array(F);
    ko.hits.forEach(function (h) { var s1 = Math.min(1, 1.3 * ko.dn[h]); for (j = -1; j <= 9; j++) { var u = h + j; if (u >= 0 && u < F) kickW[u] = Math.max(kickW[u], s1 * (j < 6 ? 1 : (10 - j) / 4)); } });
    if (boom) { var nf = biquad('notch', boom, 2.5, BSR); for (i = 0; i < lowY.length; i++) lowY[i] = nf(lowY[i]); }
    var by = bassYin(lowY, F), bp = bassPath(by, F, kickW); by = null; lowY = null;
    for (t = 0; t < F; t++) bassF[t] = bp[t];
    var lastHz = 0, lastT = -1e9;
    for (t = 0; t < F; t++) {
      var win5 = [];
      for (j = -2; j <= 2; j++) { var u = t + j; if (u >= 0 && u < F && bassF[u] > 0) win5.push(ftom(bassF[u])); }
      win5.sort(function (a, b) { return a - b; });
      var hzT = win5.length ? mtof(win5[win5.length >> 1]) : 0;
      if (bassN[t] >= 0.08 && hzT > 0) { bassHz[t] = hzT; lastHz = hzT; lastT = t; }
      /* while a note dies away, keep its last confident pitch so the stroke thins out instead of stopping dead */
      else if (bassN[t] >= 0.015 && lastHz > 0 && (t - lastT) * dt < 0.6) bassHz[t] = (hzT > 0 && Math.abs(ftom(hzT) - ftom(lastHz)) < 1.5) ? hzT : lastHz;
      else bassHz[t] = 0;
    }

    /* 5. lead line (usually the voice) */
    progress('Following the lead line', 0.9);
    var eMed = pct(totE, 0.5) + 1e-20, salList = [], conList = [];
    for (t = 0; t < F; t++) if (totE[t] > eMed * 0.05) { salList.push(leadS[t]); conList.push(leadC[t]); }
    var RUN_HI = 0.2, RUN_HI_MIN = 0.06, sThr = 0.45 * pct(salList, 0.9), cThr = Math.max(1.5, 0.75 * pct(conList, 0.5));
    var voiced = new Uint8Array(F);
    for (t = 0; t < F; t++) voiced[t] = (leadS[t] > sThr && leadC[t] > cThr && totE[t] > eMed * 0.02) ? 1 : 0;
    var lm = new Float32Array(F);
    for (t = 0; t < F; t++) {
      if (!voiced[t]) continue;
      var wl = [];
      for (j = -2; j <= 2; j++) { var w2 = t + j; if (w2 >= 0 && w2 < F && voiced[w2]) wl.push(leadM[w2]); }
      wl.sort(function (a, b) { return a - b; });
      var med = wl[wl.length >> 1], dd = leadM[t] - med;
      lm[t] = (Math.abs(Math.abs(dd) - 12) < 0.8 || Math.abs(dd) > 4) ? med : leadM[t];
    }
    /* fill short gaps, then drop short runs */
    for (t = 1; t < F; t++) {
      if (voiced[t] || !voiced[t - 1]) continue;
      var g = t; while (g < F && !voiced[g] && g - t < 4) g++;
      if (g < F && voiced[g] && g - t <= 3 && Math.abs(lm[g] - lm[t - 1]) < 3) { for (var z = t; z < g; z++) { voiced[z] = 1; lm[z] = lm[t - 1] + (lm[g] - lm[t - 1]) * (z - t + 1) / (g - t + 1); } t = g; }
    }
    /* split at big pitch leaps, then keep only runs whose upper harmonics look like a voice (not a bass line) */
    var runs = [];
    for (t = 0; t < F;) {
      if (!voiced[t]) { t++; continue; }
      var a0 = t; t++;
      while (t < F && voiced[t] && Math.abs(lm[t] - lm[t - 1]) < 7) t++;
      var hiSum = 0, bm = 0;
      for (z = a0; z < t; z++) {
        hiSum += leadHi[z];
        if (bassF[z] > 0 && bassE[z] > 0.08 * totE[z]) { var d8 = lm[z] - ftom(bassF[z]), oc = Math.round(d8 / 12); if (oc >= 0 && oc <= 2 && Math.abs(d8 - 12 * oc) < 0.7) bm++; }
      }
      var hiMean = hiSum / (t - a0), bassFrac = bm / (t - a0);
      /* a run that mostly sits on the bass line's notes, or has almost no upper harmonics, is the bass, not a voice */
      var reject = t - a0 < 5 || (!iso && (hiMean < RUN_HI_MIN || bassFrac > 0.5 || (hiMean < RUN_HI && bassFrac > 0.25)));
      if (opts.debug) dbgRuns.push([a0, t - 1, hiMean, bassFrac, reject ? 1 : 0]);
      if (reject) { for (z = a0; z < t; z++) voiced[z] = 0; } else runs.push([a0, t - 1]);
    }
    /* a short run sitting an octave away from an adjacent longer run is an octave slip: move it */
    function runMed(rn) { var a = []; for (var x = rn[0]; x <= rn[1]; x++) a.push(lm[x]); a.sort(function (p, q) { return p - q; }); return a[a.length >> 1]; }
    for (var ri = 0; ri < runs.length; ri++) {
      var cur = runs[ri], cm = runMed(cur), len0 = cur[1] - cur[0];
      [runs[ri - 1], runs[ri + 1]].forEach(function (nb) {
        if (!nb || nb[1] - nb[0] <= len0) return;
        var gapF = nb[0] > cur[1] ? nb[0] - cur[1] : cur[0] - nb[1];
        if (gapF > 4) return;
        var dlt = runMed(nb) - cm;
        if (Math.abs(Math.abs(dlt) - 12) < 1.5) { var sh = dlt > 0 ? 12 : -12; for (var x = cur[0]; x <= cur[1]; x++) lm[x] += sh; cm += sh; }
      });
    }
    var merged = [];
    runs.forEach(function (rn) {
      var lst = merged[merged.length - 1];
      if (lst && rn[0] - lst[1] <= 2 && Math.abs(lm[rn[0]] - lm[lst[1]]) < 2) lst[1] = rn[1]; else merged.push([rn[0], rn[1]]);
    });
    /* short runs that leap far from the runs around them are interlopers (bass, pads, release tails):
       octave leaps get moved, anything else is dropped */
    var keep = [];
    merged.forEach(function (rn, ri) {
      var dur = (rn[1] - rn[0] + 1) * dt;
      if (dur >= 0.45) { keep.push(rn); return; }
      var me2 = runMed(rn), nbs = [merged[ri - 1], merged[ri + 1]].filter(function (nb) {
        return nb && (nb[1] - nb[0]) > (rn[1] - rn[0]) && (nb[0] > rn[1] ? nb[0] - rn[1] : rn[0] - nb[1]) * dt < 0.6;
      });
      if (!nbs.length) { keep.push(rn); return; }
      var dl = nbs.map(function (nb) { return runMed(nb) - me2; });
      if (dl.some(function (d) { return Math.abs(d) <= 9; })) { keep.push(rn); return; }
      var oct = dl.filter(function (d) { return Math.abs(Math.abs(d) - 12) < 1.5; })[0];
      if (oct !== undefined) { for (var x = rn[0]; x <= rn[1]; x++) lm[x] += oct > 0 ? 12 : -12; keep.push(rn); return; }
      for (var y = rn[0]; y <= rn[1]; y++) voiced[y] = 0;
    });
    runs = keep;
    var ampList = []; for (t = 0; t < F; t++) if (voiced[t]) ampList.push(leadA[t]);
    var aRef = pct(ampList, 0.95) + 1e-20, zList = [];
    var leadHz = new Float32Array(F), leadN = new Float32Array(F), leadBr = new Float32Array(F), leadNz = new Float32Array(F);
    var eB = 0;
    for (t = 0; t < F; t++) {
      if (!voiced[t]) { eB = leadB[t]; continue; }
      leadHz[t] = mtof(lm[t]);
      leadN[t] = Math.min(1.2, Math.sqrt(leadA[t] / aRef));
      eB += 0.3 * (leadB[t] - eB); leadBr[t] = eB;
      var zz = []; for (j = -3; j <= 3; j++) { var w3 = t + j; if (w3 >= 0 && w3 < F && voiced[w3]) zz.push(leadZ[w3]); }
      zz.sort(function (a, b) { return a - b; }); leadNz[t] = zz[zz.length >> 1]; zList.push(leadNz[t]);
    }

    /* syllable-ish onsets inside the lead line, used to place lyrics */
    var onsets = [];
    runs.forEach(function (rn) {
      var a = rn[0], b = rn[1], lastOn = a;
      onsets.push([a, 1]);
      for (var t = a + 3; t <= b - 3; t++) {
        if (t - lastOn < 5) continue;
        var before = (lm[t - 3] + lm[t - 2] + lm[t - 1]) / 3, after = (lm[t + 1] + lm[t + 2] + lm[t + 3]) / 3;
        var jump = Math.abs(after - before), settled = Math.abs(lm[t + 3] - lm[t + 1]) < 0.7 && Math.abs(lm[t + 1] - lm[t]) < 0.7;
        var dip = leadA[t] <= leadA[t - 1] && leadA[t] <= leadA[t + 1] && nearMax(leadA, t + 3, 3) > 2.0 * leadA[t] && nearMax(leadA, t - 3, 3) > 1.8 * leadA[t];
        if ((jump >= 1.0 && settled) || dip) { onsets.push([dip && !(jump >= 1.0) ? t + 1 : t, dip ? 0.6 : 0.8]); lastOn = t; }
      }
    });
    var runEndOf = new Int32Array(F).fill(-1), runStartOf = new Int32Array(F).fill(-1);
    runs.forEach(function (rn) { for (var t = rn[0]; t <= rn[1]; t++) { runEndOf[t] = rn[1]; runStartOf[t] = rn[0]; } });
    var onArr = new Float32Array(onsets.length * 4), prevEnd = -1e9;
    onsets.forEach(function (o, n) {
      var f = o[0], rs = runStartOf[f], gap = (rs === f) ? (f - prevEnd) * dt : 0;
      onArr[n * 4] = f * dt; onArr[n * 4 + 1] = Math.min(gap, 30); onArr[n * 4 + 2] = (runEndOf[f] + 1) * dt; onArr[n * 4 + 3] = o[1];
      prevEnd = runEndOf[f];
    });

    /* Display only (the lyric onsets above are already fixed): bridge short dips inside a sung phrase and let
       each line follow the voice as it fades in and out, so quiet singing thins and pales instead of cutting off. */
    function ampN(z) { return Math.min(1.2, Math.sqrt(Math.max(0, leadA[z]) / aRef)); }
    function paint(z, m, nzRef, brRef) {
      leadHz[z] = mtof(m);
      /* if the tracker was following something else here, the voice itself is weak: keep it faint */
      leadN[z] = Math.abs(leadM[z] - m) < 1 ? ampN(z) : Math.min(ampN(z), 0.06);
      leadBr[z] = brRef; leadNz[z] = nzRef;
    }
    for (var rb = 0; rb + 1 < runs.length; rb++) {
      var e1 = runs[rb][1], s2 = runs[rb + 1][0], gapN = s2 - e1 - 1;
      if (gapN <= 0 || gapN * dt > 0.4 || Math.abs(lm[s2] - lm[e1]) > 4) continue;
      for (z = e1 + 1; z < s2; z++) paint(z, lm[e1] + (lm[s2] - lm[e1]) * (z - e1) / (s2 - e1), leadNz[e1], leadBr[e1]);
    }
    runs.forEach(function (rn) {
      var ref = 0, q;
      for (q = rn[0]; q <= rn[1]; q++) ref += leadA[q];
      ref /= rn[1] - rn[0] + 1;
      for (q = rn[1] + 1; q < Math.min(F, rn[1] + 10); q++) {
        if (leadHz[q] > 0 || leadA[q] < 0.06 * ref || Math.abs(leadM[q] - lm[rn[1]]) > 1.2) break;
        paint(q, lm[rn[1]], leadNz[rn[1]], leadBr[rn[1]]);
      }
      for (q = rn[0] - 1; q >= Math.max(0, rn[0] - 5); q--) {
        if (leadHz[q] > 0 || leadA[q] < 0.06 * ref || Math.abs(leadM[q] - lm[rn[0]]) > 1.2) break;
        paint(q, lm[rn[0]], leadNz[rn[0]], leadBr[rn[0]]);
      }
    });

    /* 6. other notes as segments */
    progress('Printing notes', 0.95);
    var allA = []; for (t = 0; t < F; t++) for (j = 0; j < pkN[t]; j++) allA.push(pkA[t * NP + j]);
    var oThr = 0.2 * pct(allA, 0.95), oRef = pct(allA, 0.95) + 1e-20;
    var active = [], segs = [];
    /* Each note is followed frame by frame (nearest pitch, so vibrato and slight bends stay one note), then judged
       as a whole: how it starts (struck, swelling or held), how fast it fades, any vibrato, and whether its tone is
       hollow (odd harmonics only, like a clarinet or square wave). */
    function closeSeg(sg) {
      if (sg.a.length < 4) return;
      /* a note is only picked up once it is loud enough, so a slow swell is caught halfway up. Walk back through
         quieter frames at the same pitch while the level keeps falling, to find where it really began. */
      var lv0 = sg.a[0], m0 = sg.m[0], tb, jb;
      for (tb = sg.f[0] - 1; tb >= Math.max(0, sg.f[0] - 40); tb--) {
        var hit = -1;
        for (jb = 0; jb < pkN[tb]; jb++) { var ob = tb * NP + jb; if (Math.abs(pkM[ob] - m0) < 0.6 && (hit < 0 || pkA[ob] > pkA[hit])) hit = ob; }
        if (hit < 0 || pkA[hit] < 0.04 * oRef || pkA[hit] > lv0 * 1.15) break;
        lv0 = Math.min(lv0, pkA[hit]);
        sg.f.unshift(tb); sg.a.unshift(pkA[hit]); sg.m.unshift(pkM[hit]); sg.b.unshift(pkB[hit]); sg.z.unshift(pkZ[hit]); sg.e.unshift(pkE[hit]);
      }
      var n = sg.a.length;
      var k, pi = 0, sm = 0, sb = 0, sz = 0, se = 0;
      for (k = 0; k < n; k++) { if (sg.a[k] > sg.a[pi]) pi = k; sm += sg.m[k]; sb += sg.b[k]; sz += sg.z[k]; se += sg.e[k]; }
      var amax = sg.a[pi], k75 = 0; while (sg.a[k75] < 0.75 * amax) k75++;
      var attack = (sg.f[k75] - sg.f[0] + 1) * dt, dur = (sg.f[n - 1] - sg.f[0] + 1) * dt;
      /* fade in dB per second, measured 60% of the way from the peak to the end, so a held note's release
         tail doesn't read as a fade */
      var decay = 0;
      if (n - pi >= 5) {
        var k6 = pi + Math.round(0.6 * (n - 1 - pi)), lv = (sg.a[k6 - 1] + sg.a[k6] + sg.a[Math.min(n - 1, k6 + 1)]) / 3;
        decay = 20 * Math.log10(lv / amax + 1e-9) / Math.max(dt, (sg.f[k6] - sg.f[pi]) * dt);
      }
      /* vibrato: pitch wobble around a running mean, as depth (semitones) and rate (zero crossings) */
      var vd = 0, vr = 0;
      if (n >= 12) {
        var rs = [], ss = 0, zc = 0;
        for (k = 0; k < n; k++) { var lo = Math.max(0, k - 4), hi = Math.min(n - 1, k + 4), mu = 0; for (var q = lo; q <= hi; q++) mu += sg.m[q]; mu /= hi - lo + 1; rs.push(sg.m[k] - mu); }
        for (k = 2; k < n - 2; k++) { ss += rs[k] * rs[k]; if (k > 2 && rs[k] * rs[k - 1] < 0) zc++; }
        var depth = Math.sqrt(ss / (n - 4)) * Math.SQRT2, rate = zc / 2 / ((n - 4) * dt);
        if (depth >= 0.1 && depth < 1.5 && rate >= 3.5 && rate <= 8.5) { vd = depth; vr = rate; }
      }
      /* family: 0 struck (keys, plucks: hard start, fades), 1 swell (pads, bowed strings: slow start),
         2 held (organ, leads, brass: hard start, holds) */
      var fam = attack >= 0.12 ? 1 : (decay < -9 || dur < 0.35) ? 0 : 2;
      if (fam === 0 && vd > 0) fam = 2;
      segs.push([sg.f[0] * dt, (sg.f[n - 1] + 1) * dt, sm / n, Math.min(1.2, Math.sqrt(amax / oRef)), sb / n, sz / n, fam, attack, decay, vd, vr, 1 - Math.min(1, 2 * se / n)]);
    }
    var used = new Uint8Array(64);
    for (t = 0; t < F; t++) {
      for (j = 0; j < active.length; j++) used[j] = 0;
      for (j = 0; j < pkN[t]; j++) {
        var o2 = t * NP + j;
        if (pkA[o2] < oThr || (voiced[t] && pkL[o2] && !isoOther)) continue;
        var bi2 = -1, bd = 0.8;
        for (var q3 = 0; q3 < active.length; q3++) { var ag = active[q3], dd2 = Math.abs(ag.m[ag.m.length - 1] - pkM[o2]); if (!used[q3] && ag.f[ag.f.length - 1] >= t - 3 && dd2 < bd) { bd = dd2; bi2 = q3; } }
        var sg = bi2 >= 0 ? active[bi2] : null;
        if (!sg) { if (active.length >= 60) continue; sg = { f: [], a: [], m: [], b: [], z: [], e: [] }; active.push(sg); bi2 = active.length - 1; }
        used[bi2] = 1; sg.f.push(t); sg.a.push(pkA[o2]); sg.m.push(pkM[o2]); sg.b.push(pkB[o2]); sg.z.push(pkZ[o2]); sg.e.push(pkE[o2]);
      }
      for (j = active.length - 1; j >= 0; j--) if (active[j].f[active[j].f.length - 1] < t - 3) { closeSeg(active[j]); active.splice(j, 1); }
    }
    active.forEach(closeSeg);
    segs.sort(function (a, b) { return a[0] - b[0]; });

    var ev = new Float32Array(events.length * EVW); events.forEach(function (e, n) { ev.set(e, n * EVW); });
    var sg2 = new Float32Array(segs.length * SEGW); segs.forEach(function (e, n) { sg2.set(e, n * SEGW); });
    progress('Done', 1);
    return {
      dur: len / SR, dt: dt, frames: F, stereo: stereo,
      bassN: bassN, bassHz: bassHz, bassBr: bassBr,
      leadHz: leadHz, leadN: leadN, leadBr: leadBr, leadNz: leadNz,
      noiseRef: [pct(zList, 0.2), pct(zList, 0.9)], dbgBass: opts.debug ? { spec: bassF, n: bassN, boom: boom } : undefined, dbgRuns: opts.debug ? dbgRuns : undefined,
      events: ev, evW: EVW, segs: sg2, segW: SEGW, onsets: onArr
    };
  }

  /* ---------------------------------------------------------------- demo song */
  /* An original 12-bar demo. Every layer the visualizer listens for is in it. */
  var DEMO_LYRICS = 'Shake the page, the bass is low\nEvery hit leaves ink below\nSing it higher, watch it climb\nWords arrive right on time';

  function synthDemo(sr) {
    sr = sr || 44100;
    var bpm = 100, beat = 60 / bpm, bar = 4 * beat, bars = 12, dur = bars * bar + 2.2;
    var n = Math.ceil(dur * sr), seed = 12345;
    function rnd() { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; }
    function gains(pan) { var a = (pan + 1) * Math.PI / 4; return [Math.cos(a) * Math.SQRT2, Math.sin(a) * Math.SQRT2]; }
    function bus() { return [new Float32Array(n), new Float32Array(n)]; }
    var drums = bus(), bass = bus(), pads = bus(), plk = bus(), vox = bus();
    var truth = { kick: [], snare: [], hat: [], words: [], notes: [], bass: [] };
    function add(b, j, l, r) { if (j >= 0 && j < n) { b[0][j] += l; b[1][j] += r; } }

    function kick(t) {
      var s0 = Math.round(t * sr), ln = Math.round(0.42 * sr), ph = 0;
      for (var i = 0; i < ln; i++) {
        var tt = i / sr, f = 46 + 110 * Math.exp(-tt * 32); ph += 2 * Math.PI * f / sr;
        var e = Math.exp(-tt * 7) * Math.min(1, tt / 0.0015), click = i < 0.004 * sr ? (rnd() * 2 - 1) * 0.25 * (1 - i / (0.004 * sr)) : 0;
        var v = Math.sin(ph) * e + click; add(drums, s0 + i, v, v);
      }
      truth.kick.push(t);
    }
    function snare(t) {
      var s0 = Math.round(t * sr), ln = Math.round(0.3 * sr), bp = biquad('bp', 2400, 0.7, sr), hp = biquad('hp', 600, 0.7, sr);
      for (var i = 0; i < ln; i++) {
        var tt = i / sr, nz = hp(bp(rnd() * 2 - 1)) * 2.4 * Math.exp(-tt * 18), body = Math.sin(2 * Math.PI * 185 * tt) * 0.5 * Math.exp(-tt * 30);
        var v = (nz + body) * 0.62; add(drums, s0 + i, v, v * 0.92);
      }
      truth.snare.push(t);
    }
    function hat(t, g) {
      var s0 = Math.round(t * sr), ln = Math.round(0.09 * sr), h1 = biquad('hp', 7000, 0.7, sr), h2 = biquad('hp', 7000, 0.7, sr);
      for (var i = 0; i < ln; i++) { var v = h2(h1(rnd() * 2 - 1)) * Math.exp(-i / sr * 60) * g; add(drums, s0 + i, v * 0.75, v * 1.15); }
      truth.hat.push(t);
    }
    function bassNote(t, d, m) {
      truth.bass.push([t, d, m]);
      var f = mtof(m), s0 = Math.round(t * sr), ln = Math.round((d + 0.08) * sr), ph = 0, l1 = 0, l2 = 0, a = 1 - Math.exp(-2 * Math.PI * 700 / sr);
      for (var i = 0; i < ln; i++) {
        var tt = i / sr; ph += f / sr; ph -= Math.floor(ph);
        var saw = 2 * ph - 1; l1 += a * (saw - l1); l2 += a * (l1 - l2);
        var e = Math.min(1, tt / 0.006) * (tt > d ? Math.max(0, 1 - (tt - d) / 0.08) : 1) * (0.75 + 0.25 * Math.exp(-tt * 5));
        var v = (l2 * 0.9 + Math.sin(2 * Math.PI * ph) * 0.7) * e; add(bass, s0 + i, v, v);
      }
    }
    function pad(t, d, m, pan) {
      var f = mtof(m), s0 = Math.round(t * sr), rel = 0.5, ln = Math.round((d + rel) * sr), gg = gains(pan);
      for (var i = 0; i < ln; i++) {
        var tt = i / sr, w = 2 * Math.PI * f * tt, e = Math.min(1, tt / 0.35) * (tt > d ? Math.max(0, 1 - (tt - d) / rel) : 1);
        var v = (Math.sin(w) + 0.12 * Math.sin(2 * w) + 0.05 * Math.sin(3 * w)) * e; add(pads, s0 + i, v * gg[0], v * gg[1]);
      }
    }
    function pluck(t, m, pan) {
      var f = mtof(m), s0 = Math.round(t * sr), ln = Math.round(0.5 * sr), gg = gains(pan), ph = 0, lp = 0, a = 1 - Math.exp(-2 * Math.PI * 4500 / sr);
      for (var i = 0; i < ln; i++) {
        var tt = i / sr; ph += f / sr; ph -= Math.floor(ph); lp += a * ((ph < 0.5 ? 1 : -1) - lp);
        var v = lp * Math.exp(-tt * 6) * Math.min(1, tt / 0.002); add(plk, s0 + i, v * gg[0], v * gg[1]);
      }
    }
    var VOW = { a: [730, 1090, 2440], o: [570, 840, 2410], e: [420, 2100, 2900], u: [440, 1020, 2240], i: [400, 1900, 2550] };
    function sing(t, d, m, prevM, vowel, cons) {
      truth.notes.push([t, d, m]);
      var f1 = mtof(m), fp = prevM ? mtof(prevM) : f1, s0 = Math.round(t * sr), rel = 0.07, ln = Math.round((d + rel) * sr), Fm = VOW[vowel];
      var b1 = biquad('bp', Fm[0], 3, sr), b2 = biquad('bp', Fm[1], 4.5, sr), b3 = biquad('bp', Fm[2], 6, sr), bn = biquad('bp', 4500, 1.2, sr), bc = biquad('hp', 3500, 0.7, sr), ph = 0;
      for (var i = 0; i < ln; i++) {
        var tt = i / sr, glide = tt < 0.05 ? fp + (f1 - fp) * (tt / 0.05) : f1;
        var vib = tt > 0.2 ? Math.min(1, (tt - 0.2) / 0.3) * 0.35 : 0, f = glide * Math.pow(2, vib * Math.sin(2 * Math.PI * 5.6 * tt) / 12);
        ph += f / sr; ph -= Math.floor(ph);
        var src = 2 * ph - 1, e = Math.min(1, tt / 0.035) * (tt > d ? Math.max(0, 1 - (tt - d) / rel) : 1);
        var y = (b1(src) + b2(src) * 0.55 + b3(src) * 0.3) * e, br = bn(rnd() * 2 - 1) * e * 0.035, cn = cons ? bc(rnd() * 2 - 1) * 0.15 * Math.max(0, 1 - tt / 0.04) : 0;
        var v = y + br + cn; add(vox, s0 + i, v, v);
      }
    }

    var CH = [[57, 60, 64], [53, 57, 60], [52, 55, 60], [55, 59, 62]], ROOT = [33, 29, 36, 31], ORDER = [0, 1, 2, 3, 0, 1, 2, 3, 0, 1, 2, 0];
    for (var b = 0; b < bars; b++) {
      var t0 = b * bar, c = ORDER[b], last = b === bars - 1;
      CH[c].forEach(function (m, i) { pad(t0, last ? bar + 1 : bar - 0.05, m, [-0.75, 0.75, 0.55][i]); });
      for (var e8 = 0; e8 < (last ? 2 : 8); e8++) hat(t0 + e8 * beat / 2, e8 % 2 ? 0.8 : 0.55);
      if (b >= 2) {
        kick(t0); kick(t0 + 2 * beat); if (!last) kick(t0 + 2.5 * beat);
        if (!last) { snare(t0 + beat); snare(t0 + 3 * beat); }
        var r = ROOT[c];
        (last ? [[0, 3.5, 0]] : [[0, 0.7, 0], [0.75, 0.25, 0], [1.5, 0.5, 12], [2, 0.7, 0], [3, 0.45, 7], [3.5, 0.45, 12]]).forEach(function (p) { bassNote(t0 + p[0] * beat, p[1] * beat, r + p[2]); });
      }
      if (b >= 6 && !last) [0, 1, 2, 1, 0, 2, 1, 2].forEach(function (ix, i) { pluck(t0 + i * beat / 2, CH[c][ix] + 12, -0.8); });
    }
    /* sung melody: [word, [[beat, beats, midi, vowel, consonant], ...]] per line (2 bars each, from bar 4) */
    var MEL = [
      [['Shake', [[0, 0.75, 69, 'e', 1]]], ['the', [[0.75, 0.25, 69, 'a', 1]]], ['page,', [[1, 1, 72, 'e', 1]]], ['the', [[2, 0.5, 71, 'a', 1]]], ['bass', [[2.5, 0.5, 69, 'a', 1]]], ['is', [[3, 1, 67, 'i', 0]]], ['low', [[4, 2.5, 64, 'o', 1]]]],
      [['Every', [[0, 0.5, 64, 'e', 0], [0.5, 0.5, 67, 'i', 1]]], ['hit', [[1, 1, 72, 'i', 1]]], ['leaves', [[2, 1, 71, 'e', 1]]], ['ink', [[3, 1, 67, 'i', 0]]], ['below', [[4, 0.5, 67, 'i', 1], [4.5, 2.5, 62, 'o', 1]]]],
      [['Sing', [[0, 1, 64, 'i', 1]]], ['it', [[1, 0.5, 67, 'i', 0]]], ['higher,', [[1.5, 0.5, 69, 'a', 1], [2, 1, 72, 'a', 0]]], ['watch', [[3, 0.5, 74, 'o', 1]]], ['it', [[3.5, 0.5, 76, 'i', 0]]], ['climb', [[4, 2.5, 81, 'a', 1]]]],
      [['Words', [[0, 1, 79, 'u', 1]]], ['arrive', [[1, 0.5, 76, 'a', 0], [1.5, 1.5, 74, 'a', 1]]], ['right', [[3, 1, 72, 'a', 1]]], ['on', [[4, 0.5, 71, 'o', 0]]], ['time', [[4.5, 3, 69, 'a', 1]]]]
    ];
    var prev = 0;
    MEL.forEach(function (line, li) {
      var lt = (4 + li * 2) * bar;
      line.forEach(function (wd) {
        truth.words.push(lt + wd[1][0][0] * beat);
        wd[1].forEach(function (nt) { sing(lt + nt[0] * beat, nt[1] * beat - 0.03, nt[2], prev, nt[3], nt[4]); prev = nt[2]; });
      });
      prev = 0;
    });

    function rms(b) { var s = 0, c = 0; for (var i = 0; i < n; i += 3) { var v = b[0][i]; if (v !== 0) { s += v * v; c++; } } return Math.sqrt(s / Math.max(1, c)) + 1e-9; }
    var mix = [[drums, 0.32], [bass, 0.2], [pads, 0.07], [plk, 0.06], [vox, 0.16]];
    var L = new Float32Array(n), R = new Float32Array(n), peak = 0, i;
    mix.forEach(function (mx) { var g = mx[1] / rms(mx[0]); for (i = 0; i < n; i++) { L[i] += mx[0][0][i] * g; R[i] += mx[0][1][i] * g; } });
    for (i = 0; i < n; i++) { var a = Math.abs(L[i]), bb = Math.abs(R[i]); if (a > peak) peak = a; if (bb > peak) peak = bb; }
    var gN = 0.89 / peak; for (i = 0; i < n; i++) { L[i] *= gN; R[i] *= gN; }
    return { L: L, R: R, sr: sr, truth: truth, lyrics: DEMO_LYRICS };
  }

  /* ---------------------------------------------------------------- lyrics */
  var CJK = /[぀-ヿ㐀-鿿가-힯]/g;
  function syllableCount(word) {
    var cj = word.match(CJK); if (cj) return cj.length;
    var w = word.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z]/g, '');
    if (!w) return /\d/.test(word) ? Math.max(1, word.replace(/\D/g, '').length) : 0;
    if (w.length <= 3) return 1;
    w = w.replace(/(?:[^laeiouy]es|[^laeiouy]ed|[^laeiouy]e)$/, '').replace(/^y/, '');
    var mt = w.match(/[aeiouy]{1,2}/g);
    return Math.max(1, mt ? mt.length : 1);
  }

  /* A whole lyrics web page pasted in (title line ending in "Lyrics", recommendations, "Embed", footer links)
     is cut down to the lyrics themselves. Plain lyrics pass through untouched. */
  function cleanPastedLyrics(text) {
    var src = String(text || '').replace(/\r/g, ''), lines = src.split('\n'), start = 0, end = lines.length, changed = false, i, j;
    if (!/(^|\n)\s*\d*\s*Embed\s*($|\n)|You might also like|Contributors|Genius/i.test(src)) return { text: src, cleaned: false };
    for (i = 0; i < Math.min(lines.length, 40); i++) {
      if (/\S\s*Lyrics\s*(\[[^\]]*\])?\s*$/.test(lines[i]) && !/^\s*\[/.test(lines[i])) { start = i + 1; changed = true; break; }
    }
    for (i = start; i < lines.length; i++) {
      var t = lines[i].trim();
      if (/^\d*\s*Embed$/i.test(t) || /^(About|Q&A|Credits|Comments|Sign Up|Have the inside scoop on this song\?)$/i.test(t)) { end = i; changed = true; break; }
      if (/^You might also like/i.test(t)) {
        var more = false;
        for (j = i + 1; j < lines.length; j++) { var u = lines[j].trim(); if (/^\[[^\]]+\]$/.test(u)) { more = true; break; } if (/^\d*\s*Embed$/i.test(u)) break; }
        if (!more) { end = i; changed = true; break; }
        lines[i] = ''; changed = true;
      }
    }
    var out = lines.slice(start, end).map(function (l) { var m = l.replace(/\d*Embed\s*$/, ''); if (m !== l) changed = true; return m; });
    return { text: out.join('\n').replace(/^\s+|\s+$/g, ''), cleaned: changed };
  }

  /* A short fingerprint of a lyric line (case, accents and punctuation ignored), used to match timing to pasted text. */
  function normLine(s) { return String(s).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ''); }
  function lineHash(s) {
    var n = normLine(s), h = 0x811c9dc5;
    for (var i = 0; i < n.length; i++) { h ^= n.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return (h >>> 0).toString(36);
  }

  /* Lines of words. Section headers like [Chorus] and blank lines are dropped. */
  function parseLyrics(text) {
    var lines = [];
    String(text || '').replace(/\r/g, '').split('\n').forEach(function (raw) {
      var s = raw.trim();
      if (!s || /^\[[^\]]*\]$/.test(s) || /^\{[^}]*\}$/.test(s)) return;
      var words = s.split(/\s+/).filter(Boolean).map(function (w) { return { text: w, syl: syllableCount(w) }; }).filter(function (w) { return w.syl > 0; });
      if (words.length) lines.push({ text: s, words: words });
    });
    return lines;
  }

  /* Parse .lrc (line stamps [mm:ss.xx], optional word stamps <mm:ss.xx>). Returns {lines, anchors, wordTimes}. */
  function parseLRC(text) {
    var out = [], stampRe = /\[(\d+):(\d+(?:[.:]\d+)?)\]/g, offset = 0;
    var om = /\[offset:\s*([+-]?\d+)\]/i.exec(text); if (om) offset = parseInt(om[1], 10) / 1000;
    String(text || '').replace(/\r/g, '').split('\n').forEach(function (raw) {
      var stamps = [], m, last = 0;
      stampRe.lastIndex = 0;
      while ((m = stampRe.exec(raw))) { stamps.push(parseInt(m[1], 10) * 60 + parseFloat(m[2].replace(':', '.'))); last = stampRe.lastIndex; }
      if (!stamps.length) return;
      var body = raw.slice(last).trim(); if (!body) return;
      var wt = [], words = [], wre = /<(\d+):(\d+(?:\.\d+)?)>\s*([^<]*)/g, wm;
      if (/<\d+:\d+/.test(body)) {
        while ((wm = wre.exec(body))) {
          var tw = parseInt(wm[1], 10) * 60 + parseFloat(wm[2]);
          wm[3].trim().split(/\s+/).filter(Boolean).forEach(function (w, i) { words.push(w); wt.push(i === 0 ? tw : null); });
        }
      } else words = body.split(/\s+/).filter(Boolean);
      stamps.forEach(function (st) {
        out.push({ t: st - offset, text: words.join(' '), words: words.map(function (w) { return { text: w, syl: Math.max(1, syllableCount(w)) }; }), wt: wt.length ? wt.map(function (x) { return x == null ? null : x - offset; }) : null });
      });
    });
    out.sort(function (a, b) { return a.t - b.t; });
    return out;
  }

  function sylSeq(lines) {
    var S = [];
    lines.forEach(function (ln, li) {
      ln.words.forEach(function (w, wi) {
        for (var k = 0; k < w.syl; k++) S.push({ li: li, wi: wi, first: k === 0, lineStart: wi === 0 && k === 0, lineEnd: wi === ln.words.length - 1 && k === w.syl - 1 });
      });
    });
    return S;
  }

  /* DP: place every lyric syllable on a detected onset (in order).
     Line starts like to follow pauses, line ends like to precede them, and syllables inside a line
     pay for going much faster or slower than the song's typical pace (sigma). */
  function dpPlace(S, O, opt) {
    opt = opt || {};
    var nS = S.length, nO = O.length; if (!nS || !nO) return null;
    var SKIP = opt.skip != null ? opt.skip : 0.3, DUP = 1.1, EDGE = 0.06, INF = 1e18, W = 14;
    var sigma = opt.sigma || 0.3;
    var prev = new Float64Array(nO), cur = new Float64Array(nO), back = new Int32Array(nS * nO), i, j, q;
    var skc = new Float64Array(nO + 1); /* prefix sums of skip costs */
    for (j = 0; j < nO; j++) skc[j + 1] = skc[j] + SKIP * (0.4 + O[j].s);
    function local(si, oj) {
      var sy = S[si], o = O[oj], c = 0;
      if (sy.lineStart) c += 3 * (1 - Math.min(o.gap, 0.3) / 0.3);
      else if (o.gap > 0.6) c += 2.2 * Math.min(1, (o.gap - 0.6) / 1.2) + 0.6;
      if (sy.lineEnd) { var nx = O[oj + 1], ng = nx ? nx.gap : 5; c += 1.5 * (1 - Math.min(ng, 0.3) / 0.3); }
      if (sy.anchor != null) c += 6 * Math.min(2, Math.abs(o.t - sy.anchor));
      return c;
    }
    function pace(d) {
      if (d < 0.6 * sigma) return 0.9 * Math.log(0.6 * sigma / Math.max(d, 0.02));
      if (d > 4 * sigma) return 0.3 * Math.log(d / (4 * sigma));
      return 0;
    }
    for (j = 0; j < nO; j++) prev[j] = EDGE * j + local(0, j);
    for (i = 1; i < nS; i++) {
      var ls = S[i].lineStart, run = INF, runArg = -1;
      for (j = 0; j < nO; j++) {
        var bestV = INF, bestA = -1;
        if (ls) {
          /* new line: any earlier onset, paying only for skipped onsets */
          if (j > 0) { var sk = skc[j] - skc[j - 1], cand = prev[j - 1]; if (run + sk < cand) run += sk; else { run = cand; runArg = j - 1; } }
          bestV = run; bestA = runArg;
        } else {
          for (q = Math.max(0, j - W); q < j; q++) {
            if (prev[q] >= INF) continue;
            var v = prev[q] + (skc[j] - skc[q + 1]) + pace(O[j].t - O[q].t);
            if (v < bestV) { bestV = v; bestA = q; }
          }
        }
        var dupV = prev[j] + DUP;
        if (dupV < bestV) { bestV = dupV; bestA = j; }
        cur[j] = bestA < 0 ? INF : bestV + local(i, j);
        back[i * nO + j] = bestA;
      }
      var tmp = prev; prev = cur; cur = tmp;
    }
    var endJ = -1, endV = INF;
    for (j = 0; j < nO; j++) { var vv = prev[j] + EDGE * (nO - 1 - j); if (vv < endV) { endV = vv; endJ = j; } }
    if (endJ < 0) return null;
    var place = new Int32Array(nS); place[nS - 1] = endJ;
    for (i = nS - 1; i > 0; i--) place[i - 1] = back[i * nO + place[i]];
    return place;
  }

  /* typical seconds per syllable: voiced time / syllables, clamped */
  function paceOf(O, nSyl) {
    var tot = 0, seen = {};
    O.forEach(function (o) { var k = o.runEnd.toFixed(3); if (!seen[k] && o.gap > 0) { seen[k] = 1; } });
    for (var i = 0; i < O.length; i++) { var nx = O[i + 1]; tot += Math.min(nx && nx.gap === 0 ? nx.t : O[i].runEnd, O[i].runEnd) - O[i].t; }
    return Math.max(0.15, Math.min(0.6, tot / Math.max(1, nSyl)));
  }

  /* Convert syllable placements to word start times. Shared onsets are spread toward the next onset. */
  function wordTimes(lines, S, O, place) {
    var res = lines.map(function (ln) { return ln.words.map(function () { return null; }); });
    var i = 0;
    while (i < S.length) {
      var j = place[i], k = i; while (k + 1 < S.length && place[k + 1] === j) k++;
      var t0 = O[j].t, t1 = j + 1 < O.length ? Math.min(O[j + 1].t, O[j].runEnd + 0.15) : O[j].runEnd;
      if (t1 <= t0) t1 = t0 + 0.25 * (k - i + 1);
      for (var q = i; q <= k; q++) { var sy = S[q]; if (sy.first) res[sy.li][sy.wi] = t0 + (t1 - t0) * (q - i) / (k - i + 1); }
      i = k + 1;
    }
    return res;
  }

  function onsetList(ana) {
    var O = [], a = ana.onsets;
    for (var i = 0; i < a.length; i += 4) O.push({ t: a[i], gap: a[i + 1], runEnd: a[i + 2], s: a[i + 3] });
    return O;
  }

  /* Fully automatic placement. */
  function alignLyrics(lines, ana) {
    var O = onsetList(ana), S = sylSeq(lines);
    if (!S.length) return [];
    if (O.length < 2) return evenSpread(lines, 0, ana.dur);
    var place = dpPlace(S, O, { sigma: paceOf(O, S.length) });
    if (!place) return evenSpread(lines, 0, ana.dur);
    return wordTimes(lines, S, O, place);
  }

  function evenSpread(lines, t0, t1) {
    var tot = 0; lines.forEach(function (l) { l.words.forEach(function (w) { tot += w.syl; }); });
    var per = (t1 - t0) / Math.max(1, tot), t = t0;
    return lines.map(function (l) { return l.words.map(function (w) { var s = t; t += per * w.syl; return s; }); });
  }

  /* Placement when line start times are known (tap-along or .lrc). */
  function alignToAnchors(lines, anchors, ana) {
    var O = onsetList(ana), res = [], nAll = 0;
    lines.forEach(function (l) { l.words.forEach(function (w) { nAll += w.syl; }); });
    var sig = paceOf(O, nAll);
    lines.forEach(function (ln, li) {
      var a = anchors[li];
      if (a == null) { res.push(ln.words.map(function () { return null; })); return; }
      var next = ana.dur; for (var q = li + 1; q < anchors.length; q++) if (anchors[q] != null) { next = anchors[q]; break; }
      var span = O.filter(function (o) { return o.t >= a - 0.2 && o.t < next - 0.05; });
      var S = sylSeq([ln]);
      if (span.length >= 1) {
        S.forEach(function (sy, k) { sy.li = 0; sy.lineStart = k === 0; if (k === 0) sy.anchor = a; });
        var place = dpPlace(S, span, { skip: 0.25, sigma: sig });
        var wt = place ? wordTimes([ln], S, span, place)[0] : ln.words.map(function () { return null; });
        wt[0] = a;
        for (var w = 1; w < wt.length; w++) if (wt[w] == null || wt[w] <= wt[w - 1]) wt[w] = wt[w - 1] + 0.12;
        res.push(wt);
      } else {
        var dur = Math.min(next - a, 0.32 * S.length + 0.3), tot = S.length, t = a;
        res.push(ln.words.map(function (wd) { var s = t; t += dur * wd.syl / tot; return s; }));
      }
    });
    return res;
  }

  return {
    analyze: analyze, synthDemo: synthDemo, parseLyrics: parseLyrics, parseLRC: parseLRC,
    alignLyrics: alignLyrics, alignToAnchors: alignToAnchors, syllableCount: syllableCount,
    cleanPastedLyrics: cleanPastedLyrics, lineHash: lineHash, DRUM_BANDS: DRUM_BANDS,
    mtof: mtof, ftom: ftom, DEMO_LYRICS: DEMO_LYRICS
  };
})();

/* Worker glue: only active when this file runs inside a Web Worker. */
if (typeof WorkerGlobalScope !== 'undefined' && typeof self !== 'undefined' && self instanceof WorkerGlobalScope) {
  self.onmessage = function (e) {
    var d = e.data, lastP = -1;
    try {
      if (d.cmd === 'ping') { self.postMessage({ type: 'pong' }); return; }
      if (d.cmd === 'demo') {
        var demo = DSP.synthDemo(44100);
        self.postMessage({ type: 'demo', L: demo.L, R: demo.R, sr: demo.sr, lyrics: demo.lyrics }, [demo.L.buffer, demo.R.buffer]);
        return;
      }
      var res = DSP.analyze(d.L, d.R, d.sr, function (label, p) {
        if (p - lastP >= 0.02 || p === 1) { lastP = p; self.postMessage({ type: 'progress', label: label, p: p }); }
      }, d.opts);
      var tx = [res.bassN, res.bassHz, res.bassBr, res.leadHz, res.leadN, res.leadBr, res.leadNz, res.events, res.segs, res.onsets].map(function (a) { return a.buffer; });
      self.postMessage({ type: 'done', res: res }, tx);
    } catch (err) {
      self.postMessage({ type: 'error', message: String((err && err.message) || err) });
    }
  };
}
if (typeof module !== 'undefined') module.exports = DSP;
