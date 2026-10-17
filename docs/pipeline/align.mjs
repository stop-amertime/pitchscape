// Forced alignment of the published words to the vocal stem: a CTC acoustic model (tools/export_align.py:
// wav2vec 2.0 fine-tuned on LibriSpeech for English, 'en', or the multilingual MMS aligner, 'mms') gives each 20 ms
// frame's label log probabilities, and torchaudio.functional.forced_align (its CPU kernel, ported here) finds the
// most likely path through the words' letters. With synced lyrics each LRC line is aligned in a window around its
// own time, so a line can only land near where the LRC puts it; unsynced lyrics are aligned over the whole song.

export const ALIGNERS = {en: 'align_en', mms: 'align_mms'};
const RATE = 16000, STRIDE = 320, FRAME_S = STRIDE / RATE;
// the model runs on fixed windows (one shape for the GPU): 20 s kept from each, with 2.5 s of audio either side
const KEEP = 1000, CTX = 125, WIN = (KEEP + 2 * CTX) * STRIDE + 80;

/** torchaudio.functional.forced_align for one sequence (its CPU kernel, forced_align_impl, in float32 as it runs on
 * float32 log_probs). lp: Float32Array [T * C] log probabilities; targets: label indices (no blank) -> {path:
 * Int32Array [T] (a label per frame), scores: Float32Array [T]} or null when T is too short for the targets
 * (T < L + repeats, where torchaudio raises). */
export function forcedAlign(lp, T, C, targets, blank = 0) {
  const L = targets.length, S = 2 * L + 1, f = Math.fround;
  let R = 0;
  for (let i = 1; i < L; i++) if (targets[i] === targets[i - 1]) R++;
  if (T < L + R) return null;
  const NEG = -Infinity;
  let prev = new Float32Array(S).fill(NEG), cur = new Float32Array(S).fill(NEG);
  const back = new Int8Array(T * S).fill(-1);
  let start = T - (L + R) > 0 ? 0 : 1;
  let end = S === 1 ? 1 : 2;
  for (let i = start; i < end; i++) prev[i] = lp[i % 2 === 0 ? blank : targets[i >> 1]];
  for (let t = 1; t < T; t++) {
    if (T - t <= L + R) {
      if (start % 2 === 1 && targets[start >> 1] !== targets[(start >> 1) + 1]) start++;
      start++;
    }
    if (t <= L + R) {
      if (end % 2 === 0 && end < 2 * L && targets[(end >> 1) - 1] !== targets[end >> 1]) end++;
      end++;
    }
    let loop = start;
    cur.fill(NEG);
    const row = t * C, brow = t * S;
    if (start === 0) {
      cur[0] = f(prev[0] + lp[row + blank]);
      back[brow] = 0;
      loop++;
    }
    for (let i = loop; i < end; i++) {
      const x0 = prev[i], x1 = prev[i - 1];
      let x2 = NEG;
      const label = i % 2 === 0 ? blank : targets[i >> 1];
      if (i % 2 !== 0 && i !== 1 && targets[i >> 1] !== targets[(i >> 1) - 1]) x2 = prev[i - 2];
      let r;
      if (x2 > x1 && x2 > x0) { r = x2; back[brow + i] = 2; }
      else if (x1 > x0 && x1 > x2) { r = x1; back[brow + i] = 1; }
      else { r = x0; back[brow + i] = 0; }
      cur[i] = f(r + lp[row + label]);
    }
    [prev, cur] = [cur, prev];
  }
  let s = S === 1 || prev[S - 1] > prev[S - 2] ? S - 1 : S - 2;
  const path = new Int32Array(T), scores = new Float32Array(T);
  for (let t = T - 1; t >= 0; t--) {
    const label = s % 2 === 0 ? blank : targets[s >> 1];
    path[t] = label;
    scores[t] = lp[t * C + label];
    s -= back[t * S + s];
  }
  return {path, scores};
}

/** torchaudio.functional.merge_tokens: [{token, start, end, score}] for each run of one non-blank label. */
export function mergeTokens(path, scores, blank = 0) {
  const out = [];
  for (let a = 0; a < path.length;) {
    let b = a + 1;
    while (b < path.length && path[b] === path[a]) b++;
    if (path[a] !== blank) {
      let s = 0;
      for (let k = a; k < b; k++) s += scores[k];
      out.push({token: path[a], start: a, end: b, score: s / (b - a)});
    }
    a = b;
  }
  return out;
}

/** A word as the model's labels: letters only (accents dropped; upper case for 'en', lower for 'mms'), the
 * apostrophe kept. A word with none of the model's letters (a number, a dash) gives []. */
export function wordLabels(word, labels) {
  const upper = labels.includes('E');
  let w = word.normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[‘’ʼ`]/g, "'");
  w = upper ? w.toUpperCase() : w.toLowerCase();
  const ids = [];
  for (const ch of w) {
    const k = labels.indexOf(ch);
    if (k > 0 && ch !== '|') ids.push(k);
  }
  return ids;
}

/** The model's log probabilities for the whole vocal (v16: mono 16 kHz) -> {lp: Float32Array [frames * C], T, C}:
 * frame k covers samples from k * 320 (as wav2vec 2.0's feature encoder strides), each window's middle 20 s kept. */
export async function emissions(v16, sess, C) {
  const T = Math.max(0, Math.floor((v16.length - 400) / STRIDE) + 1);
  const lp = new Float32Array(T * C).fill(Math.log(1 / C));
  for (let k0 = 0; k0 < T; k0 += KEEP) {
    const from = Math.max(0, k0 - CTX), s0 = from * STRIDE;
    const audio = new Float32Array(WIN);
    audio.set(v16.subarray(s0, Math.min(v16.length, s0 + WIN)));
    const o = (await sess.run({audio: {data: audio, dims: [1, WIN]}})).log_probs;
    const d = o.data, n = o.dims[1];
    for (let k = k0; k < Math.min(T, k0 + KEEP); k++) {
      const j = k - from;
      if (j < n) lp.set(d.subarray(j * C, (j + 1) * C), k * C);
    }
  }
  return {lp, T, C};
}

/** Align words (strings) to frames [f0, f1) of the emissions -> each word's start time (s) or null (no letters, or
 * the window too short), and its mean log probability. en puts '|' between words, as the model was trained. The
 * words are put between two star tokens, torchaudio's (MMS_FA's with_star: one more label whose log probability is 0
 * in every frame), which take whatever audio in the window is not these words: the line before or after, a gap. */
function alignWords(E, f0, f1, words, labels) {
  f0 = Math.max(0, Math.floor(f0)); f1 = Math.min(E.T, Math.ceil(f1));
  const sep = labels.indexOf('|');
  const ids = words.map(w => wordLabels(w, labels));
  const star = E.C, targets = [star], owner = [-1];
  ids.forEach((w, i) => {
    if (!w.length) return;
    if (sep > 0 && targets.length > 1) { targets.push(sep); owner.push(-1); }
    for (const x of w) { targets.push(x); owner.push(i); }
  });
  targets.push(star); owner.push(-1);
  const times = words.map(() => null), score = words.map(() => null);
  if (targets.length === 2 || f1 <= f0) return {times, score};
  const T = f1 - f0, C = E.C + 1, lp = new Float32Array(T * C);
  for (let t = 0; t < T; t++) lp.set(E.lp.subarray((f0 + t) * E.C, (f0 + t + 1) * E.C), t * C);
  const r = forcedAlign(lp, T, C, targets);
  if (!r) return {times, score};
  const spans = mergeTokens(r.path, r.scores);
  // spans follow targets one to one (forced alignment emits every target once, in order)
  const sums = words.map(() => [0, 0]);
  spans.forEach((sp, k) => {
    const i = owner[k];
    if (i < 0) return;
    if (times[i] === null) times[i] = (f0 + sp.start) * FRAME_S;
    sums[i][0] += sp.score * (sp.end - sp.start); sums[i][1] += sp.end - sp.start;
  });
  sums.forEach(([s, n], i) => { if (n) score[i] = s / n; });
  return {times, score};
}

const median = a => {
  const s = Float64Array.from(a).sort(), n = s.length;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
};

/** Times for every word of the lyrics. toks: [[line index, word]]; starts: each line's LRC time (s) or null (all null
 * for unsynced lyrics); dur: the song's length. Synced: each line is aligned between 2 s before its time and 1 s after
 * the next line's (the last: 15 s), the median shift of the lines' first words from their LRC times is taken as the
 * LRC's offset against this copy, and each line is aligned again between 1 s before and 0.5 s after its shifted
 * times. -> {t: [s or null] per word, score: [mean log probability or null], offset}. */
export function alignLines(E, toks, starts, dur, labels) {
  const words = toks.map(([, w]) => w);
  const fr = s => s / FRAME_S;
  if (starts.some(x => x === null || x === undefined)) {
    const r = alignWords(E, 0, E.T, words, labels);
    return {t: r.times, score: r.score, offset: null};
  }
  const byLine = new Map();
  toks.forEach(([li], k) => { if (!byLine.has(li)) byLine.set(li, []); byLine.get(li).push(k); });
  const run = (off, before, after) => {
    const t = words.map(() => null), score = words.map(() => null);
    for (const [li, ks] of byLine) {
      const a = starts[li] + off - before;
      const b = (li + 1 < starts.length ? starts[li + 1] : Math.min(dur, starts[li] + 15)) + off + after;
      const r = alignWords(E, fr(a), fr(b), ks.map(k => words[k]), labels);
      ks.forEach((k, j) => { t[k] = r.times[j]; score[k] = r.score[j]; });
    }
    return {t, score};
  };
  const first = run(0, 2.0, 1.0);
  const d = [];
  for (const [li, ks] of byLine) { const k = ks.find(x => first.t[x] !== null); if (k !== undefined) d.push(first.t[k] - starts[li]); }
  const offset = d.length ? median(d) : 0;
  return {...run(offset, 1.0, 0.5), offset};
}
