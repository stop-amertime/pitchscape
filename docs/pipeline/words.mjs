// words: the song's published lyrics (LRCLIB) with each word placed when it is sung: the record found from the tags
// (find_lyrics, as server/pipeline.py's lyrics_for), its lines (parse_lrc), and each word's time from forced alignment
// of the text to the vocal stem (align.mjs: a CTC model and torchaudio's forced_align), each line near its LRC time.
// No lyrics on LRCLIB means no words. placeWords (Whisper's heard words matched to the published ones, the Python
// pipeline's way) is kept for comparing the two.
import {songInfo, songTags} from './tags.mjs';
import {pyRound} from './whisper.mjs';
import {ALIGNERS, emissions, alignLines} from './align.mjs';

export {songInfo, songTags};

export const LRCLIB = 'https://lrclib.net/api/';
const UA = 'Pitchscape (https://github.com/stop-amertime/pitchscape)';

// Python's whitespace (str.isspace), for strip() and split()
const WS = '\\t\\n\\x0b\\x0c\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
const STRIP = new RegExp(`^[${WS}]+|[${WS}]+$`, 'g'), SPLIT = new RegExp(`[${WS}]+`);
const strip = s => s.replace(STRIP, '');
const split = s => strip(s).split(SPLIT).filter(Boolean);
const splitlines = s => s.split(new RegExp('\r\n|[\n\r\x0b\x0c\x1c\x1d\x1e\x85\u2028\u2029]'));

export class Unreachable extends Error {}

/** urllib.parse.urlencode (quote_plus): only letters, digits and _.-~ are left as they are. */
export const urlencode = q => Object.entries(q).map(([k, v]) => enc(k) + '=' + enc(v)).join('&');
const enc = s => encodeURIComponent(String(s)).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase()).replace(/%20/g, '+');

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** One LRCLIB API call: the JSON, or null for "not found". LRCLIB often answers "busy" (503), sometimes for many
 * seconds, so a call is retried for about a minute before giving up (Unreachable). Browsers do not let a page set
 * User-Agent, so the client is named in Lrclib-Client, which LRCLIB accepts (and allows cross-origin). */
export async function lrclib(pathQ, {fetch = globalThis.fetch, tries = 10, log = () => {}, wait = sleep} = {}) {
  const node = typeof process !== 'undefined' && !!process.versions?.node && typeof window === 'undefined';
  const headers = node ? {'User-Agent': UA, 'Lrclib-Client': UA} : {'Lrclib-Client': UA};
  for (let k = 0; k < tries; k++) {
    try {
      const r = await fetch(LRCLIB + pathQ, {headers, signal: AbortSignal.timeout(15000)});
      if (r.status === 404) return null;
      if (r.ok) return await r.json();
      log('lrclib:', r.status, pathQ);
    } catch (e) {
      log('lrclib:', String(e && e.message || e), pathQ);
    }
    await wait((1 + k) * 1000);
  }
  throw new Unreachable(pathQ);
}

/** unicodedata.normalize('NFKD', w.lower()), letters and digits only */
export function norm(w) {
  let out = '';
  for (const c of w.toLowerCase().normalize('NFKD')) if (/[\p{L}\p{N}]/u.test(c)) out += c;
  return out;
}

/** The song's record on LRCLIB, within 3 s of the song's length (another length is another version, timed
 * differently), preferring one with timed lines: an exact match on artist, title and length, then a search by artist
 * and title. If the tagged artist finds nothing (tags are often wrong), a search by title alone, taking a record only
 * if it has exactly this title, is within 2 s of this length, and every such record is by the same artist. */
export async function findLyrics(artist, title, album, dur, opts = {}) {
  if (!title) return null;
  const call = q => lrclib(q, opts);
  const fits = (h, tol = 3) => !!h && typeof h === 'object' && !Array.isArray(h) &&
    Math.abs(parseFloat(h.duration || 0) - dur) <= tol && !!(h.instrumental || h.syncedLyrics || h.plainLyrics);
  const best = cands => {
    const c = cands.filter(h => fits(h));
    const key = h => [(!h.instrumental && !h.syncedLyrics) ? 1 : 0, Math.abs(parseFloat(h.duration || 0) - dur)];
    c.sort((x, y) => { const a = key(x), b = key(y); return a[0] - b[0] || a[1] - b[1]; });
    return c.length ? c[0] : null;
  };
  const found = [];
  if (artist) {
    const q = {artist_name: artist, track_name: title, duration: String(pyRound(dur))};
    if (album) found.push(await call('get?' + urlencode({...q, album_name: album})));
    found.push(await call('get?' + urlencode(q)));
    let hit = best(found);
    if (hit && (hit.syncedLyrics || hit.instrumental)) return hit;
    found.push(...((await call('search?' + urlencode({artist_name: artist, track_name: title}))) || []));
    hit = best(found);
    if (hit) return hit;
  }
  const same = ((await call('search?' + urlencode({track_name: title}))) || [])
    .filter(h => fits(h, 2) && norm(h.trackName || '') === norm(title));
  if (same.length && new Set(same.map(h => norm(h.artistName || ''))).size === 1) return {...best(same), byTitleOnly: true};
  return null;
}

/** Synced lyrics -> [[line time s, text]], in time order; a line stamped several times appears at each. */
export function parseLrc(text) {
  const out = [];
  for (const raw of splitlines(text || '')) {
    const stamps = [...raw.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)];
    const body = strip(raw.replace(/\[[^\]]*\]/g, '').replace(/<\d+:\d+(?:\.\d+)?>/g, ''));
    if (body) for (const [, m, sec] of stamps) out.push([parseInt(m, 10) * 60 + parseFloat(sec), body]);
  }
  return out.sort((x, y) => x[0] - y[0]);
}

// ------------------------------------------------------------------ difflib.SequenceMatcher (isjunk None, autojunk False)
/** get_matching_blocks(): [[i, j, n]...], ending with [len(a), len(b), 0]. */
export function matchingBlocks(a, b) {
  const b2j = new Map();
  b.forEach((x, j) => { if (!b2j.has(x)) b2j.set(x, []); b2j.get(x).push(j); });
  const longest = (alo, ahi, blo, bhi) => {
    let besti = alo, bestj = blo, bestsize = 0, j2len = new Map();
    for (let i = alo; i < ahi; i++) {
      const newj2len = new Map();
      for (const j of b2j.get(a[i]) || []) {
        if (j < blo) continue;
        if (j >= bhi) break;
        const k = (j2len.get(j - 1) || 0) + 1;
        newj2len.set(j, k);
        if (k > bestsize) { besti = i - k + 1; bestj = j - k + 1; bestsize = k; }
      }
      j2len = newj2len;
    }
    while (besti > alo && bestj > blo && a[besti - 1] === b[bestj - 1]) { besti--; bestj--; bestsize++; }
    while (besti + bestsize < ahi && bestj + bestsize < bhi && a[besti + bestsize] === b[bestj + bestsize]) bestsize++;
    return [besti, bestj, bestsize];
  };
  const queue = [[0, a.length, 0, b.length]], blocks = [];
  while (queue.length) {
    const [alo, ahi, blo, bhi] = queue.pop();
    const [i, j, k] = longest(alo, ahi, blo, bhi);
    if (k) {
      blocks.push([i, j, k]);
      if (alo < i && blo < j) queue.push([alo, i, blo, j]);
      if (i + k < ahi && j + k < bhi) queue.push([i + k, ahi, j + k, bhi]);
    }
  }
  blocks.sort((x, y) => x[0] - y[0] || x[1] - y[1] || x[2] - y[2]);
  let i1 = 0, j1 = 0, k1 = 0;
  const out = [];
  for (const [i2, j2, k2] of blocks) {
    if (i1 + k1 === i2 && j1 + k1 === j2) k1 += k2;
    else { if (k1) out.push([i1, j1, k1]); i1 = i2; j1 = j2; k1 = k2; }
  }
  if (k1) out.push([i1, j1, k1]);
  out.push([a.length, b.length, 0]);
  return out;
}

const median = a => {
  const s = Float64Array.from(a).sort(), n = s.length;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
};

/** Times for the published words. lines: [[LRC line time or null, text]]; heard: Whisper's [[word, start, end]].
 * The two word lists are matched in order (difflib); a matched word takes the time Whisper heard it at, unless that
 * is far from where the LRC puts its line (a match against a different repeat of a chorus). Words between matches
 * are spread evenly between them, and a line starting on an unmatched word starts at its LRC time. Returns
 * [lines with times or null, the share of words matched]. */
export function placeWords(lines, heard) {
  const toks = [];
  lines.forEach(([, text], li) => { for (const w of split(text)) toks.push([li, w]); });
  const a = toks.map(([, w]) => norm(w)), b = heard.map(([w]) => norm(w));
  const t = new Array(toks.length).fill(null);
  for (const [bi, bj, size] of matchingBlocks(a, b)) {
    for (let k = 0; k < size; k++) if (a[bi + k]) t[bi + k] = heard[bj + k][1];
  }
  const starts = lines.map(([lt]) => lt);
  const synced = starts.every(x => x !== null && x !== undefined);
  const first = new Map();
  toks.forEach(([li], k) => { if (!first.has(li)) first.set(li, k); });
  if (synced) {
    // the LRC may be timed against a copy that starts a little earlier or later: one offset for the song
    const d = [];
    for (const [li, k] of first) if (t[k] !== null) d.push(t[k] - starts[li]);
    const off = d.length ? median(d) : 0;
    const st = starts.map(x => x + off);
    toks.forEach(([li], k) => {
      const hi = li + 1 < st.length ? st[li + 1] : st[li] + 15;
      if (t[k] !== null && !(st[li] - 1.5 <= t[k] && t[k] <= hi + 1.0)) t[k] = null;
    });
    for (const [li, k] of first) if (t[k] === null || Math.abs(t[k] - st[li]) > 1.0) t[k] = Math.max(0.0, st[li]);
  }
  return finishTimes(lines, toks, t);
}

/** Lines with each word's time: times that do not run forward are dropped, and words without a time are spread
 * evenly between their timed neighbours (0.3 s apart past the first or last). -> [lines or null, share timed]. */
export function finishTimes(lines, toks, t) {
  // keep only times that run forward
  let last = -1.0;
  for (let k = 0; k < t.length; k++) {
    if (t[k] !== null) { if (t[k] <= last) t[k] = null; else last = t[k]; }
  }
  const known = [];
  t.forEach((x, k) => { if (x !== null) known.push(k); });
  const matched = known.length / Math.max(1, t.length);
  if (!known.length) return [null, 0.0];
  let p = 0;                                                     // known[p - 1] < k <= known[p]
  for (let k = 0; k < t.length; k++) {
    while (p < known.length && known[p] < k) p++;
    if (t[k] !== null) continue;
    const lo = p > 0 ? known[p - 1] : null, hi = p < known.length ? known[p] : null;
    if (lo !== null && hi !== null) t[k] = t[lo] + (t[hi] - t[lo]) * (k - lo) / (hi - lo);
    else if (lo !== null) t[k] = t[lo] + 0.3 * (k - lo);
    else t[k] = Math.max(0.0, t[hi] - 0.3 * (hi - k));
  }
  const out = [];
  lines.forEach(([, text], li) => {
    const ws = [];
    toks.forEach(([lj, w], k) => { if (lj === li) ws.push([w, pyRound(t[k], 3)]); });
    if (ws.length) out.push({text, words: ws});
  });
  return [out, matched];
}

/** [lyrics or null, what was found (and why not)]. info: songInfo's (its artist, title and album, the gaps filled
 * from an "Artist - Title" file name); dur: the song's length (s); vocals44: the vocal stem [left, right] at 44.1 kHz.
 * fetch: for LRCLIB (the global one by default). aligner: 'en' (wav2vec 2.0, English letters; the default) or 'mms'
 * (the multilingual MMS aligner, romanised letters; text in other scripts needs uroman, not ported, so its words go
 * untimed). onAligned(toks, {t, score, offset}): each word's aligned time and mean log probability. */
export async function lyricsFor(info, dur, vocals44, rt, {stats = {}, fetch = globalThis.fetch, log = () => {},
                                                       aligner = 'en', onAligned = null} = {}) {
  const artist = info.artist || '', title = info.title || '', album = info.album || '';
  const found = {artist, title};
  if (!title) return [null, {...found, found: false, why: 'no artist and title in the tags or the file name'}];
  let hit;
  const t0 = performance.now();
  try {
    hit = await findLyrics(artist, title, album, dur, {fetch, log});
  } catch (e) {
    if (e instanceof Unreachable) return [null, {...found, found: false, why: 'LRCLIB could not be reached'}];
    throw e;
  } finally { stats.lrclib_ms = performance.now() - t0; }
  if (!hit) return [null, {...found, found: false, why: 'not on LRCLIB at this length'}];
  Object.assign(found, {found: true, lrclib: hit.id ?? null, track: hit.trackName ?? null, by: hit.artistName ?? null,
                        byTitleOnly: !!hit.byTitleOnly});
  if (hit.instrumental) return [null, {...found, why: 'instrumental'}];
  let lines = parseLrc(hit.syncedLyrics);
  if (!lines.length) lines = splitlines(hit.plainLyrics || '').filter(ln => strip(ln)).map(ln => [null, strip(ln)]);
  if (!lines.length) return [null, {...found, why: 'no lyrics in the record'}];
  // the aligner's emissions for the vocal stem's mono mix at 16 kHz (librosa soxr_hq, as pipeline.to_rate)
  const [l, r] = vocals44, mono = new Float32Array(l.length);
  for (let i = 0; i < l.length; i++) mono[i] = (l[i] + r[i]) / 2;
  const v16 = await rt.pool.call('./resample.mjs', 'resample', [mono, 44100, 16000], [mono.buffer]);
  const name = ALIGNERS[aligner];
  if (!name) throw new Error(`no aligner '${aligner}' (${Object.keys(ALIGNERS).join(', ')})`);
  const file = rt.keeps ? name : name + '_f32';          // float16 on the browser's GPU, float32 for the CPU
  const t1 = performance.now();
  const sess = await rt.session(file);
  const {labels} = rt.manifest[file];
  const E = await emissions(v16, sess, labels.length);
  stats.emission_ms = performance.now() - t1;
  const toks = [];
  lines.forEach(([, text], li) => { for (const w of split(text)) toks.push([li, w]); });
  const t2 = performance.now();
  const al = alignLines(E, toks, lines.map(([lt]) => lt), dur, labels);
  stats.align_ms = performance.now() - t2;
  const aligned = al.t.filter(x => x !== null).length;
  const [placed, timed] = finishTimes(lines, toks, al.t);
  Object.assign(found, {synced: lines[0][0] !== null, aligner, aligned: pyRound(aligned / Math.max(1, toks.length), 3),
                        matched: pyRound(timed, 3), offset: al.offset === null ? null : pyRound(al.offset, 3)});
  if (onAligned) onAligned(toks, al);
  if (!placed) return [null, {...found, why: 'none of the words could be aligned'}];
  return [{language: aligner === 'en' ? 'en' : null, source: 'LRCLIB', lines: placed}, found];
}

