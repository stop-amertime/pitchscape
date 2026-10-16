// Whisper's words with their times, as server/pipeline.py heard_words gets them from faster-whisper 1.2.1:
// model.transcribe(audio, word_timestamps=True, vad_filter=True, condition_on_previous_text=False), the rest at its
// defaults. A port of faster-whisper's transcribe.py (Silero VAD and the speech kept, the log-mel features, language
// detection, 30 s windows sought through by timestamps, the temperature fallback, the split into segments, word
// timing) and of the parts of CTranslate2 it calls (Whisper generate's logits processors, align's attention
// normalisation, median filter and DTW; its beam search, and its sampling of best_of hypotheses as one batch), on
// the ONNX graphs tools/export_whisper.py makes. Like faster-whisper, it is not the same twice: the fallback samples
// at random.
//
// The browser keeps the cross-attention keys and values and the self-attention cache on the GPU between steps
// (rt.keeps); onnxruntime-node cannot, so under Node the decoder runs on the CPU, where its inputs cost nothing to pass.
import {N_FFT, HOP, melFilters} from './whisper.dsp.mjs';
import {deflate} from './vendor/pako_deflate.mjs';

const SR = 16000, N_FRAMES = 3000, FPS = 100, TOKENS_PER_SECOND = 50, TIME_PRECISION = 0.02, INPUT_STRIDE = 2;
const TEMPERATURES = [0.0, 0.2, 0.4, 0.6, 0.8, 1.0];
const BEAM_SIZE = 5, BEST_OF = 5, COMPRESSION_RATIO_THRESHOLD = 2.4, LOG_PROB_THRESHOLD = -1.0, NO_SPEECH_THRESHOLD = 0.6;
const MAX_INITIAL_TIMESTAMP = 1.0;
const PREPEND = '"\'“¿([{-', APPEND = '"\'.。,，!！?？:：”)]}、';
const DSP = './whisper.dsp.mjs';
const LOWEST = -3.4028234663852886e38;     // CTranslate2 disables a token by setting its logit to float's lowest

// ------------------------------------------------------------------ Python's numbers
/** Python's round(x, n): to the nearest, ties (exact, in binary) to even. */
export function pyRound(x, n = 0) {
  if (!Number.isFinite(x)) return x;
  const s = Math.abs(x).toFixed(Math.min(100, n + 60));         // exact digits
  const dot = s.indexOf('.'), keep = s.slice(0, dot + 1 + n), rest = s.slice(dot + 1 + n);
  let up;
  if (rest[0] > '5') up = true;
  else if (rest[0] < '5') up = false;
  else if (/[1-9]/.test(rest.slice(1))) up = true;
  else up = +(keep.replace('.', '').slice(-1)) % 2 === 1;        // a tie: to even
  let v = parseFloat(keep.endsWith('.') ? keep.slice(0, -1) : keep);
  if (up) v = parseFloat((v + 10 ** -n).toFixed(n));
  return x < 0 ? -v : v;
}

/** numpy's round(x, n), which word times go through in faster-whisper (they are numpy floats there): x * 10**n
 * rounded half to even, divided back. */
const rint = y => { const f = Math.floor(y), d = y - f; return d > 0.5 || (d === 0.5 && f % 2 !== 0) ? f + 1 : f; };
export const npRound = (x, n) => rint(x * 10 ** n) / 10 ** n;

const median = a => {
  const s = Float64Array.from(a).sort(), n = s.length;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
};
const WS = '\t\n\x0b\x0c\r\x1c-\x1f \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000';
const PY_SPACE = new RegExp(`^[${WS}]+|[${WS}]+$`, 'g');      // Python's str.strip()
const strip = s => s.replace(PY_SPACE, '');
const PUNCTUATION = '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~';       // Python's string.punctuation

// ------------------------------------------------------------------ the tokenizer
class Tokenizer {
  constructor(j, language) {
    Object.assign(this, j);
    this.bytes = j.text.map(h => Uint8Array.from(h.match(/../g) || [], b => parseInt(b, 16)));
    this.language = j.languages[language];
    this.languageCode = language;
    this.sotSequence = [j.sot, this.language, j.transcribe];
  }
  /** tokenizer.decode: the text tokens' bytes as UTF-8 (lossy, as the tokenizers library decodes). */
  decode(tokens) {
    const keep = tokens.filter(t => t < this.eot);
    let n = 0;
    for (const t of keep) n += this.bytes[t].length;
    const u = new Uint8Array(n);
    let o = 0;
    for (const t of keep) { u.set(this.bytes[t], o); o += this.bytes[t].length; }
    return new TextDecoder('utf-8').decode(u);
  }
  /** decode_with_timestamps for text tokens (no timestamps are given to it here) */
  splitOnUnicode(tokens) {
    const full = Array.from(this.decode(tokens));
    const words = [], wordTokens = [];
    let cur = [], offset = 0;
    for (const t of tokens) {
      cur.push(t);
      const dec = Array.from(this.decode(cur));
      const i = dec.indexOf('�');
      const at = i < 0 ? null : i + offset;
      if (at === null || (at < full.length && full[at] === '�')) {
        words.push(dec.join(''));
        wordTokens.push(cur);
        cur = [];
        offset += dec.length;
      }
    }
    return [words, wordTokens];
  }
  splitOnSpaces(tokens) {
    const [subwords, subTokens] = this.splitOnUnicode(tokens);
    const words = [], wordTokens = [];
    subwords.forEach((sw, i) => {
      const special = subTokens[i][0] >= this.eot, space = sw.startsWith(' '), punct = PUNCTUATION.includes(strip(sw));
      if (special || space || punct || !words.length) { words.push(sw); wordTokens.push(subTokens[i]); }
      else { words[words.length - 1] += sw; wordTokens[wordTokens.length - 1].push(...subTokens[i]); }
    });
    return [words, wordTokens];
  }
  splitToWordTokens(tokens) {
    return ['zh', 'ja', 'th', 'lo', 'my', 'yue'].includes(this.languageCode) ? this.splitOnUnicode(tokens) : this.splitOnSpaces(tokens);
  }
}

// ------------------------------------------------------------------ Silero VAD (vad.py, VadOptions defaults)
async function speechProbs(audio, rt) {
  const W = 512, C = 64;
  const n = audio.length + (W - audio.length % W), rows = n / W;
  const padded = new Float32Array(n);
  padded.set(audio);
  padded.fill(0, n - C);                     // vad.py zeroes the last window's context through a view of it
  const sess = await rt.session('silero_vad');
  let h = new Float32Array(128), c = new Float32Array(128);
  const out = new Float32Array(rows);
  for (let r0 = 0; r0 < rows; r0 += 10000) {
    const r1 = Math.min(rows, r0 + 10000), x = new Float32Array((r1 - r0) * (W + C));
    for (let r = r0; r < r1; r++) {
      const o = (r - r0) * (W + C);
      if (r > 0) x.set(padded.subarray(r * W - C, r * W), o);
      x.set(padded.subarray(r * W, (r + 1) * W), o + C);
    }
    const res = await sess.run({input: {data: x, dims: [r1 - r0, W + C]}, h: {data: h, dims: [1, 1, 128]}, c: {data: c, dims: [1, 1, 128]}});
    out.set(res.speech_probs.data, r0);
    h = Float32Array.from(res.hn.data);
    c = Float32Array.from(res.cn.data);
  }
  return out;
}

/** get_speech_timestamps: [{start, end}] in samples. */
export async function speechTimestamps(audio, rt) {
  const threshold = 0.5, neg = Math.max(threshold - 0.15, 0.01), W = 512;
  const minSpeech = 0, pad = SR * 400 / 1000, maxSpeech = Infinity, minSilence = SR * 2000 / 1000, atMax = SR * 98 / 1000;
  const probs = await speechProbs(audio, rt), len = audio.length;
  let triggered = false, speeches = [], cur = {}, tempEnd = 0, prevEnd = 0, nextStart = 0;
  for (let i = 0; i < probs.length; i++) {
    const p = probs[i];
    if (p >= threshold && tempEnd) {
      tempEnd = 0;
      if (nextStart < prevEnd) nextStart = W * i;
    }
    if (p >= threshold && !triggered) { triggered = true; cur.start = W * i; continue; }
    if (triggered && W * i - cur.start > maxSpeech) {
      if (prevEnd) {
        cur.end = prevEnd; speeches.push(cur); cur = {};
        if (nextStart < prevEnd) triggered = false; else cur.start = nextStart;
        prevEnd = nextStart = tempEnd = 0;
      } else {
        cur.end = W * i; speeches.push(cur); cur = {};
        prevEnd = nextStart = tempEnd = 0; triggered = false;
        continue;
      }
    }
    if (p < neg && triggered) {
      if (!tempEnd) tempEnd = W * i;
      if (W * i - tempEnd > atMax) prevEnd = tempEnd;
      if (W * i - tempEnd < minSilence) continue;
      cur.end = tempEnd;
      if (cur.end - cur.start > minSpeech) speeches.push(cur);
      cur = {}; prevEnd = nextStart = tempEnd = 0; triggered = false;
      continue;
    }
  }
  if ('start' in cur && len - cur.start > minSpeech) { cur.end = len; speeches.push(cur); }
  speeches.forEach((s, i) => {
    if (i === 0) s.start = Math.trunc(Math.max(0, s.start - pad));
    if (i !== speeches.length - 1) {
      const silence = speeches[i + 1].start - s.end;
      if (silence < 2 * pad) {
        s.end += Math.trunc(Math.floor(silence / 2));
        speeches[i + 1].start = Math.trunc(Math.max(0, speeches[i + 1].start - Math.floor(silence / 2)));
      } else {
        s.end = Math.trunc(Math.min(len, s.end + pad));
        speeches[i + 1].start = Math.trunc(Math.max(0, speeches[i + 1].start - pad));
      }
    } else s.end = Math.trunc(Math.min(len, s.end + pad));
  });
  return speeches;
}

/** SpeechTimestampsMap: times in the speech kept back to times in the song. */
class SpeechMap {
  constructor(chunks) {
    this.ends = [];
    this.silence = [];
    let prev = 0, silent = 0;
    for (const c of chunks) {
      silent += c.start - prev;
      prev = c.end;
      this.ends.push(c.end - silent);
      this.silence.push(silent / SR);
    }
  }
  index(time, isEnd = false) {
    const sample = Math.trunc(time * SR);
    if (isEnd && this.ends.includes(sample)) return this.ends.indexOf(sample);
    let lo = 0, hi = this.ends.length;                          // bisect.bisect (right)
    while (lo < hi) { const mid = (lo + hi) >> 1; if (sample < this.ends[mid]) hi = mid; else lo = mid + 1; }
    return Math.min(lo, this.ends.length - 1);
  }
  original(time, index = null, isEnd = false) {
    if (index === null) index = this.index(time, isEnd);
    return npRound(this.silence[index] + time, 2);
  }
}

// ------------------------------------------------------------------ features
/** FeatureExtractor(feature_size=n_mels)(audio): Float32Array [n_mels * frames] (mel-major) and the frame count. */
async function features(audio, nMels, rt) {
  const padded = new Float32Array(audio.length + 160);           // padding=160
  padded.set(audio);
  const L = padded.length, P = N_FFT / 2;
  if (L <= P) throw new Error('whisper: audio too short');
  const x = new Float32Array(L + 2 * P);                          // center: reflect P samples at each end
  x.set(padded, P);
  for (let i = 0; i < P; i++) { x[P - 1 - i] = padded[i + 1]; x[P + L + i] = padded[L - 2 - i]; }
  const frames = 1 + Math.floor((x.length - N_FFT) / HOP) - 1;  // the last frame is dropped (stft[..., :-1])
  const filters = melFilters(nMels), pool = rt.pool;
  const per = Math.ceil(frames / pool.size), parts = [];
  for (let f0 = 0; f0 < frames; f0 += per) {
    const f1 = Math.min(frames, f0 + per), from = f0 * HOP, seg = x.slice(from, (f1 - 1) * HOP + N_FFT);
    parts.push(pool.call(DSP, 'melPower', [seg, from, f0, f1, filters, nMels], [seg.buffer]).then(p => [f0, f1, p]));
  }
  const mel = new Float32Array(nMels * frames);
  for (const [f0, f1, p] of await Promise.all(parts)) {
    const nf = f1 - f0;
    for (let m = 0; m < nMels; m++) mel.set(p.subarray(m * nf, (m + 1) * nf), m * frames + f0);
  }
  let max = -Infinity;
  for (let i = 0; i < mel.length; i++) { const v = Math.fround(Math.log10(Math.max(mel[i], 1e-10))); mel[i] = v; if (v > max) max = v; }
  for (let i = 0; i < mel.length; i++) mel[i] = Math.fround((Math.max(mel[i], max - 8) + 4) / 4);
  return {mel, frames};
}

/** pad_or_trim(features[:, seek:seek + size]) as the encoder's input [1, n_mels, 3000]. */
function window(f, nMels, seek, size) {
  const out = new Float32Array(nMels * N_FRAMES), n = Math.min(size, N_FRAMES);
  for (let m = 0; m < nMels; m++) out.set(f.mel.subarray(m * f.frames + seek, m * f.frames + seek + n), m * N_FRAMES);
  return {data: out, dims: [1, nMels, N_FRAMES]};
}

// ------------------------------------------------------------------ the model
class Model {
  constructor(rt, size, tok, enc, dec, j) {
    Object.assign(this, {rt, size, tok, enc, dec, L: j.layers, H: j.heads, dh: j.width / j.heads,
                         calls: 0, ms: 0, encMs: 0, temps: []});
  }

  static async load(rt, size) {
    const j = JSON.parse(new TextDecoder().decode(await rt.file('whisper_' + size)));
    const names = p => Array.from({length: j.layers}, (_, i) => p + i);
    // the browser keeps tensors on the GPU and runs float16; Node runs the decoder on the CPU, in float32
    const enc = await rt.session(`whisper_${size}_encoder${rt.keeps ? '' : '_f32'}`,
                                 rt.keeps ? {keep: [...names('k'), ...names('v')]} : {});
    const dec = await rt.session(`whisper_${size}_decoder${rt.keeps ? '' : '_f32'}`,
                                 rt.keeps ? {keep: [...names('nk'), ...names('nv')]} : {ep: 'cpu'});
    return {j, model: new Model(rt, size, null, enc, dec, j)};
  }

  /** The window's cross-attention keys and values, per decoder layer: {k: [...], v: [...]}. */
  async encode(mel) {
    const t = performance.now(), o = await this.enc.run({mel});
    this.encMs += performance.now() - t;
    return {k: Array.from({length: this.L}, (_, i) => o['k' + i]), v: Array.from({length: this.L}, (_, i) => o['v' + i])};
  }

  /** One decoder call: rows of tokens (b rows of n), each after the cache's row order[i] (the cache null: none;
   * order null: row i) -> {logits [b * n * vocab], cache {k: [...], v: [...]}, qk [b, heads, n, 1500], b, n}. */
  async step(rows, cache, mem, order = null) {
    const b = rows.length, n = rows[0].length, t = performance.now(), feeds = {};
    feeds.tokens = {data: Int32Array.from(rows.flat()), dims: [b, n], type: 'int32'};
    feeds.order = {data: order ? Int32Array.from(order) : Int32Array.from({length: b}, (_, i) => i), dims: [b], type: 'int32'};
    const empty = {data: new Float32Array(0), dims: [b, this.H, 0, this.dh]};
    for (let i = 0; i < this.L; i++) {
      feeds['pk' + i] = cache ? cache.k[i] : empty;
      feeds['pv' + i] = cache ? cache.v[i] : empty;
      feeds['k' + i] = mem.k[i];
      feeds['v' + i] = mem.v[i];
    }
    this.calls++;
    const o = await this.dec.run(feeds);
    this.ms += performance.now() - t;
    return {logits: o.logits.data, cache: {k: Array.from({length: this.L}, (_, i) => o['nk' + i]),
                                           v: Array.from({length: this.L}, (_, i) => o['nv' + i])},
            qk: o.qk, b, n};
  }

  release(...ts) { this.rt.release(...ts); }
  drop(c) { if (c) this.rt.release(...c.k, ...c.v); }
}

// ------------------------------------------------------------------ decoding (CTranslate2's Whisper generate)
const logSoftmax = x => {
  let m = -Infinity;
  for (let i = 0; i < x.length; i++) if (x[i] > m) m = x[i];
  let s = 0;
  for (let i = 0; i < x.length; i++) s += Math.exp(x[i] - m);
  const lse = m + Math.log(s), out = new Float64Array(x.length);
  for (let i = 0; i < x.length; i++) out[i] = x[i] - lse;
  return out;
};

/** The logits processors CTranslate2 applies at a step (SuppressTokens, SuppressTokensBegin, ApplyTimestampRules),
 * in place on logits (a Float64Array of the vocabulary), given the tokens sampled so far. */
function processLogits(logits, step, seq, tok) {
  const V = logits.length, tb = tok.timestamp_begin, te = V - 1, eot = tok.eot;
  const off = (a, b) => { for (let i = a; i < b; i++) logits[i] = LOWEST; };
  for (const t of tok.suppress) logits[t] = LOWEST;
  if (step === 0) for (const t of tok.suppress_begin) logits[t] = LOWEST;
  logits[tok.no_timestamps] = LOWEST;
  let check = false;
  if (step === 0) {
    off(0, tb);
    off(tb + Math.round(MAX_INITIAL_TIMESTAMP / TIME_PRECISION) + 1, te + 1);
  } else {
    const last = seq[step - 1];
    if (last >= tb) {
      const pen = step - 1 > 0 ? seq[step - 2] : last;
      if (pen >= tb) off(tb, te + 1);
      else { off(0, eot); off(tb, last); check = true; }
    } else {
      check = true;
      for (let t = step - 1; t >= 0; t--) if (seq[t] >= tb) { off(tb, seq[t] + 1); break; }
    }
  }
  if (check) {
    // the timestamps' total probability against the likeliest text token's (on the logits: log_softmax shifts both
    // sides by the same amount)
    let maxText = -Infinity;
    for (let i = 0; i < tb; i++) if (logits[i] > maxText) maxText = logits[i];
    let m = -Infinity;
    for (let i = tb; i <= te; i++) if (logits[i] > m) m = logits[i];
    let s = 0;
    for (let i = tb; i <= te; i++) s += Math.exp(logits[i] - m);
    if (m + Math.log(s) > maxText) off(0, tb);
  }
}

/** Sampled hypotheses from the prompt's state, b of them decoded together (CTranslate2 samples best_of as one batch):
 * greedy at temperature 0. -> [{tokens, score (cumulative)}] */
async function sample(model, prompt, mem, temperature, random, b) {
  const tok = model.tok, maxLength = Math.min(model.tok.max_length / 2, model.tok.max_length - (prompt.tokens.length - 1));
  const V = prompt.logits.length;
  const hyps = Array.from({length: b}, () => ({tokens: [], score: 0, done: false}));
  let logits = null, cache = null;
  const lg = new Float64Array(V), pr = temperature > 0 ? new Float64Array(V) : null;
  for (let step = 0; step < maxLength; step++) {
    const ids = [];
    for (let r = 0; r < b; r++) {
      const h = hyps[r];
      if (h.done) { ids.push(tok.eot); continue; }
      lg.set(logits ? logits.subarray(r * V, (r + 1) * V) : prompt.logits);
      processLogits(lg, step, h.tokens, tok);
      // log_softmax(lg)[i] = lg[i] - lse
      let m = -Infinity, id = 0;
      for (let i = 0; i < V; i++) if (lg[i] > m) { m = lg[i]; id = i; }
      let s = 0;
      for (let i = 0; i < V; i++) s += Math.exp(lg[i] - m);
      const lse = m + Math.log(s);
      if (temperature > 0) {
        // drawn from softmax(log_softmax / T)
        let t = 0;
        for (let i = 0; i < V; i++) t += pr[i] = Math.exp((lg[i] - m) / temperature);
        let x = random() * t;
        for (id = 0; id < V - 1 && (x -= pr[id]) > 0; id++);
      }
      h.score += lg[id] - lse;
      if (id !== tok.eot) h.tokens.push(id);
      if (id === tok.eot || step + 1 >= maxLength) h.done = true;
      ids.push(id);
    }
    if (hyps.every(h => h.done)) break;
    // the first step continues the prompt's one row in every row
    const o = await model.step(ids.map(id => [id]), cache || prompt.cache, mem, cache ? null : new Array(b).fill(0));
    model.drop(cache);
    model.release(o.qk);
    cache = o.cache;
    logits = o.logits;
  }
  model.drop(cache);
  return hyps;
}

/** CTranslate2's BeamSearch::search as faster-whisper runs it (beam_size 5, patience 1, length_penalty 1, one
 * hypothesis): -> {tokens, score (cumulative, over the length)} */
async function beamSearch(model, prompt, mem, beam) {
  const tok = model.tok, maxLength = Math.min(model.tok.max_length / 2, model.tok.max_length - (prompt.tokens.length - 1));
  const V = prompt.logits.length, C = beam * 2, maxCandidates = beam;
  const lg = new Float64Array(V), results = [];
  let rows = [{seq: [], score: 0}], logits = prompt.logits, cache = null;
  for (let step = 0; step < maxLength; step++) {
    const last = step + 1 === maxLength;
    // the best C candidates over every beam's next token: cumulative log-probability, highest first (only the first
    // beam at the first step)
    const cand = [];
    for (let r = 0; r < rows.length; r++) {
      lg.set(logits.subarray(r * V, (r + 1) * V));
      processLogits(lg, step, rows[r].seq, tok);
      let m = -Infinity;
      for (let i = 0; i < V; i++) if (lg[i] > m) m = lg[i];
      let s = 0;
      for (let i = 0; i < V; i++) s += Math.exp(lg[i] - m);
      const base = rows[r].score - (m + Math.log(s));
      for (let i = 0; i < V; i++) {
        const score = base + lg[i];
        if (cand.length === C && score <= cand[C - 1].score) continue;
        let j = cand.length === C ? C - 1 : cand.length;
        while (j > 0 && cand[j - 1].score < score) { if (j < C) cand[j] = cand[j - 1]; j--; }
        cand[j] = {score, row: r, id: i};
        if (cand.length > C) cand.length = C;
      }
    }
    // a candidate ending in <|endoftext|> (or any at the last step) is a finished hypothesis; the next candidate
    // that does not end takes its place among the beams
    const next = [];
    let secondary = beam;
    for (let k = 0; k < beam; k++) {
      const c = cand[k];
      let nb = k;
      if (c.id === tok.eot || last) {
        const seq = rows[c.row].seq;
        results.push({tokens: c.id === tok.eot ? seq.slice() : [...seq, c.id], score: c.score});
        for (let j = secondary; j < C; j++) if (cand[j].id !== tok.eot) { nb = j; secondary = j + 1; break; }
      }
      next.push(cand[nb]);
    }
    if (last || results.length >= maxCandidates) break;
    const o = await model.step(next.map(c => [c.id]), cache || prompt.cache, mem, next.map(c => c.row));
    model.drop(cache);
    model.release(o.qk);
    cache = o.cache;
    logits = o.logits;
    rows = next.map(c => ({seq: [...rows[c.row].seq, c.id], score: c.score}));
  }
  model.drop(cache);
  // finalize_result: the score over the length, the best first
  for (const r of results) r.score /= r.tokens.length;
  return results.reduce((a, b) => (b.score > a.score ? b : a));
}

/** The prompt <|startoftranscript|><|lang|><|transcribe|>: its cache, the first step's logits, and the logits at
 * <|startoftranscript|>. */
async function promptFor(model, mem) {
  const tok = model.tok, p = await model.step([tok.sotSequence], null, mem);
  model.release(p.qk);
  const V = p.logits.length / p.n;
  return {tokens: tok.sotSequence, cache: p.cache, logits: p.logits.subarray((p.n - 1) * V), first: p.logits.subarray(0, V)};
}

/** generate_with_fallback -> {tokens, avgLogprob, temperature, compressionRatio, noSpeechProb} */
async function generateWithFallback(model, mem, random) {
  const tok = model.tok;
  // the probability of <|nospeech|> at <|startoftranscript|> (CTranslate2 reads it from the prompt's first position)
  const prompt = await promptFor(model, mem);
  const noSpeechProb = Math.exp(logSoftmax(prompt.first)[tok.no_speech]);
  const all = [], belowCr = [];
  let result = null;
  for (const temperature of TEMPERATURES) {
    let best;
    if (temperature > 0) {
      // best_of hypotheses, the best by score over length
      const hyps = await sample(model, prompt, mem, temperature, random, BEST_OF);
      for (const h of hyps) h.score /= h.tokens.length;
      best = hyps.reduce((a, b) => (b.score > a.score ? b : a));
    } else best = await beamSearch(model, prompt, mem, BEAM_SIZE);
    const n = best.tokens.length;
    const avgLogprob = best.score * n / (n + 1);           // faster-whisper: scores[0] * len ** length_penalty / (len + 1)
    const text = new TextEncoder().encode(strip(tok.decode(best.tokens)));
    const compressionRatio = text.length / deflate(text).length;
    result = {tokens: best.tokens, avgLogprob, temperature, compressionRatio, noSpeechProb};
    all.push(result);
    let fallback = false;
    if (compressionRatio > COMPRESSION_RATIO_THRESHOLD) fallback = true; else belowCr.push(result);
    if (avgLogprob < LOG_PROB_THRESHOLD) fallback = true;
    if (noSpeechProb > NO_SPEECH_THRESHOLD && avgLogprob < LOG_PROB_THRESHOLD) fallback = false;
    model.temps.push(temperature);
    if (!fallback) { result.done = true; break; }
  }
  if (!result.done) {
    const pool = belowCr.length ? belowCr : all;
    const best = pool.reduce((a, b) => (b.avgLogprob > a.avgLogprob ? b : a));
    result = {...best, temperature: TEMPERATURES[TEMPERATURES.length - 1]};
  }
  model.drop(prompt.cache);
  return result;
}

// ------------------------------------------------------------------ segments and word timing
function splitByTimestamps(tok, tokens, timeOffset, segmentSize, segmentDuration, seek) {
  const tb = tok.timestamp_begin, segs = [];
  const single = tokens.length >= 2 && tokens[tokens.length - 2] < tb && tb <= tokens[tokens.length - 1];
  const consecutive = [];
  for (let i = 1; i < tokens.length; i++) if (tokens[i] >= tb && tokens[i - 1] >= tb) consecutive.push(i);
  if (consecutive.length) {
    const slices = [...consecutive];
    if (single) slices.push(tokens.length);
    let last = 0;
    for (const cur of slices) {
      const s = tokens.slice(last, cur);
      segs.push({seek, start: timeOffset + (s[0] - tb) * TIME_PRECISION, end: timeOffset + (s[s.length - 1] - tb) * TIME_PRECISION, tokens: s});
      last = cur;
    }
    if (single) seek += segmentSize;
    else seek += (tokens[last - 1] - tb) * INPUT_STRIDE;
  } else {
    let duration = segmentDuration;
    const ts = tokens.filter(t => t >= tb);
    if (ts.length && ts[ts.length - 1] !== tb) duration = (ts[ts.length - 1] - tb) * TIME_PRECISION;
    segs.push({seek, start: timeOffset, end: timeOffset + duration, tokens});
    seek += segmentSize;
  }
  return [segs, seek, single];
}

/** CTranslate2's negative_dtw */
function negativeDtw(x, n, m) {
  const cost = new Float32Array((n + 1) * (m + 1)).fill(Infinity), trace = new Int8Array((n + 1) * (m + 1)).fill(-1);
  const W = m + 1;
  cost[0] = 0;
  for (let j = 1; j <= m; j++) for (let i = 1; i <= n; i++) {
    const c0 = cost[(i - 1) * W + j - 1], c1 = cost[(i - 1) * W + j], c2 = cost[i * W + j - 1];
    let c, t;
    if (c0 < c1 && c0 < c2) { c = c0; t = 0; } else if (c1 < c0 && c1 < c2) { c = c1; t = 1; } else { c = c2; t = 2; }
    cost[i * W + j] = Math.fround(-x[(i - 1) * m + (j - 1)] + c);
    trace[i * W + j] = t;
  }
  for (let k = 0; k <= m; k++) trace[k] = 2;
  for (let k = 0; k <= n; k++) trace[k * W] = 1;
  const path = [];
  let i = n, j = m;
  while (i > 0 || j > 0) {
    path.push([i - 1, j - 1]);
    const t = trace[i * W + j];
    if (t === 0) { i--; j--; } else if (t === 1) i--; else if (t === 2) j--; else throw new Error('dtw: unexpected trace');
  }
  return path.reverse();
}

/** CTranslate2's align for one window: the alignment heads' attention over text_tokens -> the DTW path. */
async function align(model, mem, textTokens, numFrames) {
  const tok = model.tok;
  const input = [...tok.sotSequence, tok.no_timestamps, ...textTokens, tok.eot];
  const o = await model.step([input], null, mem);
  model.drop(o.cache);
  const qk = o.qk instanceof Float32Array ? o.qk : o.qk.data ?? o.qk;
  const H = tok.alignment_heads.length, T = input.length, F = Math.floor(numFrames / 2);
  if (F === 0) return [];
  // per head: softmax over the first F frames, normalised over tokens (LayerNorm(-2), epsilon 0), median filter 7
  const mean = new Float64Array((T) * F);
  const att = new Float32Array(T * F);
  for (let h = 0; h < H; h++) {
    for (let t = 0; t < T; t++) {
      const row = (h * T + t) * 1500;
      let m = -Infinity;
      for (let f = 0; f < F; f++) if (qk[row + f] > m) m = qk[row + f];
      let s = 0;
      for (let f = 0; f < F; f++) s += Math.exp(qk[row + f] - m);
      for (let f = 0; f < F; f++) att[t * F + f] = Math.fround(Math.exp(qk[row + f] - m) / s);
    }
    for (let f = 0; f < F; f++) {
      let mu = 0, v = 0;
      for (let t = 0; t < T; t++) mu += att[t * F + f];
      mu /= T;
      for (let t = 0; t < T; t++) v += (att[t * F + f] - mu) ** 2;
      const sd = Math.sqrt(v / T);
      for (let t = 0; t < T; t++) att[t * F + f] = Math.fround((att[t * F + f] - mu) / sd);
    }
    const rank = 3, win = new Float32Array(7), sorted = new Float32Array(7);
    for (let t = 0; t < T; t++) {
      const row = att.subarray(t * F, (t + 1) * F);
      for (let f = 0; f < F; f++) {
        let v;
        if (F <= rank) v = row[f];
        else {
          for (let k = -rank; k <= rank; k++) {
            let r = Math.abs(f + k);
            if (r >= F) r = F - (r - F) - 2;
            win[k + rank] = row[r];
          }
          sorted.set(win);
          v = sorted.sort()[rank];
        }
        mean[t * F + f] += v / H;
      }
    }
  }
  // the rows from <|notimestamps|> to the last text token
  const sot = tok.sotSequence.length, n = textTokens.length + 1, x = new Float32Array(n * F);
  for (let i = 0; i < n; i++) for (let f = 0; f < F; f++) x[i * F + f] = Math.fround(mean[(sot + i) * F + f]);
  return negativeDtw(x, n, F);
}

/** find_alignment: [{word, tokens, start, end}] for the window's text tokens. */
async function findAlignment(model, mem, textTokens, numFrames) {
  const tok = model.tok;
  if (!textTokens.length) return [];
  const path = await align(model, mem, textTokens, numFrames);
  const [words, wordTokens] = tok.splitToWordTokens([...textTokens, tok.eot]);
  if (wordTokens.length <= 1 || !path.length) return [];
  const bounds = [0];
  for (const w of wordTokens.slice(0, -1)) bounds.push(bounds[bounds.length - 1] + w.length);
  const jumpTimes = [];
  path.forEach(([ti, fi], k) => { if (k === 0 || ti !== path[k - 1][0]) jumpTimes.push(fi / TOKENS_PER_SECOND); });
  const out = [];
  for (let w = 0; w < bounds.length - 1; w++) {
    out.push({word: words[w], tokens: wordTokens[w], start: jumpTimes[bounds[w]], end: jumpTimes[bounds[w + 1]]});
  }
  return out;
}

function mergePunctuations(al) {
  let i = al.length - 2, j = al.length - 1;
  while (i >= 0) {
    const prev = al[i], next = al[j];
    if (prev.word.startsWith(' ') && PREPEND.includes(strip(prev.word))) {
      next.word = prev.word + next.word; next.tokens = [...prev.tokens, ...next.tokens];
      prev.word = ''; prev.tokens = [];
    } else j = i;
    i--;
  }
  i = 0; j = 1;
  while (j < al.length) {
    const prev = al[i], next = al[j];
    if (!prev.word.endsWith(' ') && APPEND.includes(next.word)) {
      prev.word += next.word; prev.tokens = [...prev.tokens, ...next.tokens];
      next.word = ''; next.tokens = [];
    } else i = j;
    j++;
  }
}

/** add_word_timestamps for one window's segments; returns last_speech_timestamp. */
async function addWordTimestamps(model, mem, segments, numFrames, lastSpeech) {
  const tok = model.tok;
  const perSeg = segments.map(s => s.tokens.filter(t => t < tok.eot));
  const textTokens = perSeg.flat();
  const al = await findAlignment(model, mem, textTokens, numFrames);
  const durs = al.map(w => w.end - w.start).filter(d => d !== 0);
  const medianDuration = Math.min(0.7, durs.length ? median(durs) : 0), maxDuration = medianDuration * 2;
  if (durs.length) {
    const marks = '.。!！?？';
    for (let i = 1; i < al.length; i++) {
      if (al[i].end - al[i].start > maxDuration) {
        if (marks.includes(al[i].word)) al[i].end = al[i].start + maxDuration;
        else if (marks.includes(al[i - 1].word)) al[i].start = al[i].end - maxDuration;
      }
    }
  }
  mergePunctuations(al);
  const timeOffset = segments[0].seek / FPS;
  let wi = 0;
  segments.forEach((sub, si) => {
    let saved = 0;
    const words = [];
    while (wi < al.length && saved < perSeg[si].length) {
      const t = al[wi];
      if (t.word) words.push({word: t.word, start: npRound(timeOffset + t.start, 2), end: npRound(timeOffset + t.end, 2)});
      saved += t.tokens.length;
      wi++;
    }
    if (words.length) {
      if (words[0].end - lastSpeech > medianDuration * 4 &&
          (words[0].end - words[0].start > maxDuration || (words.length > 1 && words[1].end - words[0].start > maxDuration * 2))) {
        if (words.length > 1 && words[1].end - words[1].start > maxDuration) {
          const boundary = Math.max(words[1].end / 2, words[1].end - maxDuration);
          words[0].end = words[1].start = boundary;
        }
        words[0].start = Math.max(0, words[0].end - maxDuration);
      }
      if (sub.start < words[0].end && sub.start - 0.5 > words[0].start) {
        words[0].start = Math.max(0, Math.min(words[0].end - medianDuration, sub.start));
      } else sub.start = words[0].start;
      const lw = words[words.length - 1];
      if (sub.end > lw.start && sub.end + 0.5 < lw.end) lw.end = Math.max(lw.start + medianDuration, sub.end);
      else sub.end = lw.end;
      lastSpeech = sub.end;
    }
    sub.words = words;
  });
  return lastSpeech;
}

const getEnd = segs => {
  for (let s = segs.length - 1; s >= 0; s--) for (let w = segs[s].words.length - 1; w >= 0; w--) return segs[s].words[w].end;
  return segs.length ? segs[segs.length - 1].end : null;
};

// ------------------------------------------------------------------ transcribe
/** heard_words: Whisper's words [[word, start, end]...] in the song's time, and the language it heard.
 * vocals16: the vocal stem's mono mix at 16 kHz. size: the model ('medium', as the pipeline on a GPU).
 * random: the sampler's random numbers at temperatures above 0 (faster-whisper's are random too). */
export async function heardWords(vocals16, rt, {size = 'medium', stats = {}, random = Math.random, progress = () => {}} = {}) {
  const t0 = performance.now();
  const chunks = await speechTimestamps(vocals16, rt);
  let n = 0;
  for (const c of chunks) n += c.end - c.start;
  const audio = new Float32Array(n);
  let o = 0;
  for (const c of chunks) { audio.set(vocals16.subarray(c.start, c.end), o); o += c.end - c.start; }
  stats.vad_ms = performance.now() - t0;
  stats.speech_s = n / SR;
  const {j, model} = await Model.load(rt, size);
  const f = await features(audio.length ? audio : new Float32Array(1), j.n_mels, rt);
  stats.features_ms = performance.now() - t0 - stats.vad_ms;
  // the language, from the first 30 s
  const t1 = performance.now();
  const mem0 = await model.encode(window(f, j.n_mels, 0, Math.min(f.frames, N_FRAMES)));
  const first = await model.step([[j.sot]], null, mem0);
  model.drop(first.cache);
  model.drop(mem0);
  model.release(first.qk);
  const ids = j.lang_ids, lp = ids.map(i => first.logits[i]), mx = Math.max(...lp);
  const ex = lp.map(x => Math.exp(x - mx)), sum = ex.reduce((a, b) => a + b, 0);
  let best = 0;
  ex.forEach((e, i) => { if (e > ex[best]) best = i; });
  const language = Object.keys(j.languages).find(c => j.languages[c] === ids[best]);
  stats.language_probability = ex[best] / sum;
  model.tok = new Tokenizer(j, language);

  const contentFrames = f.frames - 1, segmentsOut = [];
  let seek = 0, lastSpeech = 0, windows = 0, steps = 0;
  while (seek < contentFrames) {
    const timeOffset = seek * 0.01, size = Math.min(N_FRAMES, contentFrames - seek, contentFrames - seek);
    const mem = await model.encode(window(f, j.n_mels, seek, size));
    windows++;
    const res = await generateWithFallback(model, mem, random);
    if (res.noSpeechProb > NO_SPEECH_THRESHOLD && !(res.avgLogprob > LOG_PROB_THRESHOLD)) {
      seek += size;
      model.drop(mem);
      continue;
    }
    steps += res.tokens.length;
    let segs, single;
    [segs, seek, single] = splitByTimestamps(model.tok, res.tokens, timeOffset, size, size * 0.01, seek);
    await addWordTimestamps(model, mem, segs, size, lastSpeech);   // (faster-whisper drops what it returns)
    model.drop(mem);
    if (!single) {
      const end = getEnd(segs);
      if (end !== null && end > timeOffset) seek = rint(end * FPS);
    }
    const end = getEnd(segs);
    if (end !== null) lastSpeech = end;
    for (const s of segs) {
      if (s.start === s.end || !strip(model.tok.decode(s.tokens))) continue;
      segmentsOut.push(s);
    }
    progress(Math.min(seek, contentFrames) / Math.max(1, contentFrames));
  }
  Object.assign(stats, {decoder_calls: model.calls, decoder_ms: model.ms, encoder_ms: model.encMs,
                       temperatures: model.temps.join(' ')});
  stats.windows = windows;
  stats.tokens = steps;
  stats.whisper_ms = performance.now() - t1;
  // restore_speech_timestamps
  const map = new SpeechMap(chunks), words = [];
  for (const s of segmentsOut) for (const w of s.words) {
    const idx = map.index((w.start + w.end) / 2);
    const word = strip(w.word);
    if (word) words.push([word, map.original(w.start, idx), map.original(w.end, idx)]);
  }
  return [words, language];
}
