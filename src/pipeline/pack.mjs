// The pack: the page's data format, as server/pipeline.py analyze writes it (its encodings, layout and stats), from
// the stages' outputs. Kept to the same fields and order so a pack from either pipeline draws the same.

export const SR = 22050, HOP = 512, DT = HOP / SR;
export const NOTE_STEMS = ['other', 'guitar', 'piano', 'bass'];
export const TYPES = {kick: 0, snare: 1, hat: 2, tom: 3, cymbal: 4};
export const EAR_DB = [1, 3, 10], EAR_SPAN = 16;
export const FLOORS = {drums: 0.6, hold: 0.15, noteMs: 50, voiceP: 0.15, voiceL: 0.01, bassL: 0.02};
export const EVW = 6 + 16, SEGW = 19;

/** Frames on the page's grid for a song dur seconds long (pipeline.analyze's F). */
export const frameCount = dur => Math.max(16, Math.ceil(dur * SR / HOP));

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
/** Bytes as base64 (the same text Python's base64.b64encode gives). */
export function base64(bytes) {
  let s = '';
  const n = bytes.length, chunk = [];
  for (let i = 0; i < n; i += 3) {
    const a = bytes[i], b = i + 1 < n ? bytes[i + 1] : 0, c = i + 2 < n ? bytes[i + 2] : 0;
    chunk.push(B64[a >> 2], B64[((a & 3) << 4) | (b >> 4)], i + 1 < n ? B64[((b & 15) << 2) | (c >> 6)] : '=', i + 2 < n ? B64[c & 63] : '=');
    if (chunk.length >= 8192) { s += chunk.join(''); chunk.length = 0; }
  }
  return s + chunk.join('');
}

/** pipeline.b64f32: little-endian float32 as base64 (typed arrays are little-endian on every platform we run on). */
export function b64f32(a) {
  const f = a instanceof Float32Array ? a : Float32Array.from(a.flat ? a.flat(Infinity) : a);
  return base64(new Uint8Array(f.buffer, f.byteOffset, f.byteLength));
}

/** pipeline.u8: values spread over 0..255 between lo and hi (numpy's round: half to even). */
export function u8(a, lo, hi) {
  const q = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i++) {
    const v = (a[i] - lo) / (hi - lo) * 255;
    let r = Math.round(v);
    if (Math.abs(v % 1) === 0.5 && r % 2) r -= 1;               // np.round rounds halves to even
    q[i] = Math.min(255, Math.max(0, r));
  }
  return {data: base64(q), lo, hi};
}

/** numpy.percentile (linear interpolation) of a list of numbers. */
export function percentile(xs, p) {
  const s = Float64Array.from(xs).sort();
  if (!s.length) return NaN;
  const k = (s.length - 1) * p / 100, f = Math.floor(k), c = Math.min(s.length - 1, f + 1);
  return s[f] + (s[c] - s[f]) * (k - f);
}
export const median = xs => percentile(xs, 50);

const round = (x, d) => { const m = 10 ** d; return Math.round(x * m) / m; };

/** The pack, from everything the stages found. r: {song, dur, words, hits, events, segs (the notes stage's records),
 * bassN, bassHz, bassBr, lead and gtr (voice's object, on the vocal and guitar stems), loud (the loudness stage's),
 * curves (pack_curves: bends, holds, widths, where), leadEar, bassEar, lyrics, found, voiced, seconds, title}.
 * A note (segStride 19): t0, t1, midi, amplitude, brightness, noise, family, attack, fade, vibrato depth and rate,
 * hollowness, stem (noteStems), echo dB (NaN: on no lower note's harmonic), rise dB, its samples' start and count,
 * the note still ringing at its pitch when it starts (an index, or -1), and which harmonic it sits on. */
export function makePack(r) {
  const F = frameCount(r.dur), Lo = r.loud;
  const segs = r.segs.map((s, i) => [...s.slice(0, 13), Lo.cues[i][0], Lo.cues[i][2], r.curves.where[i][0], r.curves.where[i][1],
    Lo.cues[i][3], Lo.cues[i][1]]);
  const flat = rows => Float32Array.from(rows.flat());
  const L = r.lead, leadOn = [], bassOn = [];
  for (let f = 0; f < F; f++) { if (L.leadHz[f] > 0) leadOn.push(f); if (r.bassHz[f] > 0) bassOn.push(f); }
  const width3 = (ear, on) => on.length ? round(median(on.map(f => ear[f * 6 + 2] + ear[f * 6 + 3])), 2) : 0;
  const nw = r.curves.widths, noteW = [];
  for (let i = 0; i < nw.length; i += 6) noteW.push(nw[i + 2] + nw[i + 3]);
  const hits = {};
  for (const k of Object.keys(TYPES)) hits[k] = r.hits.filter(h => h[1] === k && h[3] >= 1).length;
  const notesByStem = {};
  NOTE_STEMS.forEach((n, i) => { notesByStem[n] = segs.filter(s => s[12] === i).length; });
  const song = r.song;
  return {
    format: 'song-overprint-pack', version: 15, source: 'pitchscape-js',
    models: {stems: 'htdemucs_6s', drums: 'ADTOF Frame_RNN', notes: 'Basic Pitch ICASSP 2022', bass: 'pYIN, Basic Pitch', voice: 'CREPE',
      guitarLine: 'CREPE', loudness: 'librosa CQT, HPSS (Driedger 2014)', width: 'Glasberg & Moore roex excitation patterns',
      words: r.words ? 'LRCLIB, aligned by CTC' : null},
    noteStems: NOTE_STEMS,
    title: song.title || r.title || '', artist: song.artist || '',
    audio: null, song: {...song, lrclib: (r.found || {}).lrclib ?? null},
    dur: r.dur, dt: DT, frames: F, stereo: true, noiseRef: L.noiseRef,
    segStride: SEGW, eventStride: EVW,
    arrays: {bassN: b64f32(r.bassN), bassHz: b64f32(r.bassHz), bassBr: b64f32(r.bassBr),
      leadHz: b64f32(L.leadHz), leadP: b64f32(L.leadP), leadL: b64f32(L.leadL), leadN: b64f32(L.leadN),
      leadBr: b64f32(L.leadBr), leadNz: b64f32(L.leadNz),
      gtrHz: b64f32(r.gtr.leadHz), gtrP: b64f32(r.gtr.leadP), gtrL: b64f32(r.gtr.leadL),
      events: b64f32(flat(r.events)), segs: b64f32(flat(segs)), onsets: b64f32(flat(L.onsets))},
    earDb: EAR_DB,
    bytes: {bends: u8(r.curves.bends, -8, 8), holds: u8(r.curves.holds, 0, 1), noteEar: u8(nw, 0, EAR_SPAN),
      leadEar: u8(r.leadEar, 0, EAR_SPAN), bassEar: u8(r.bassEar, 0, EAR_SPAN),
      noteLvl: u8(Lo.lvl, 0, 1), noteNz: u8(Lo.nz, 0, 1),
      ...Object.fromEntries(Object.entries(Lo.lineLvl).map(([s, a]) => [s + 'Lvl', u8(a, 0, 1)])),
      ...Object.fromEntries(Object.entries(Lo.lineNz).map(([s, a]) => [s + 'Nz', u8(a, 0, 1)]))},
    // loudness (pack 14): each stem's noise share per frame, and its strikes (frames x strikeBands, 8 semitones each
    // from 27.5 Hz), 0..1
    noiseShare: Object.fromEntries(Object.entries(Lo.share).map(([s, a]) => [s, u8(a, 0, 1)])),
    strikes: Object.fromEntries(Object.entries(Lo.strikes).map(([s, a]) => [s, u8(a, 0, 1)])), strikeBands: 11,
    timing: null, lyrics: r.lyrics,
    floors: FLOORS,
    stats: {seconds: round(r.seconds, 1), hits, notes: segs.length, voiced: r.voiced, notesByStem,
      echoes: segs.filter(s => s[13] < 7).length, lyrics: r.found,
      earWidth3dB: {voice: width3(r.leadEar, leadOn), bass: width3(r.bassEar, bassOn), notes: noteW.length ? round(median(noteW), 2) : 0},
      ...(r.timing ? {timing: r.timing} : {})},
  };
}
