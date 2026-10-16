// A song file's tags and facts, as server/pipeline.py reads them with ffprobe (probe, song_tags, song_info), without
// ffprobe: the same reader in Node and in the browser. It follows FFmpeg's own demuxers (FFmpeg 9.0's libavformat: id3v2.c, id3v1.c,
// mp3dec.c, mov.c, flacdec.c, oggparsevorbis.c, vorbiscomment.c, riffdec.c) so the keys and values are the ones ffprobe
// prints: ID3v2.2/3/4 frames under FFmpeg's names (unknown text frames under their own ids, TXXX under its
// description, COMM as comment or under its descriptor, USLT as lyrics-[descriptor-]lang, PRIV as id3v2_priv.<owner>
// with bytes escaped), ID3v1 when there is no ID3v2, the LAME tag's encoder; MP4 ilst atoms and freeform ---- tags;
// FLAC and Ogg Vorbis comments; WAV LIST INFO. Duration and bit rate are computed as FFmpeg does for each format.
// tools/parity.py words compares it with ffprobe.

const GENRES = [
"Blues","Classic Rock","Country","Dance","Disco","Funk","Grunge","Hip-Hop","Jazz","Metal","New Age","Oldies","Other",
"Pop","R&B","Rap","Reggae","Rock","Techno","Industrial","Alternative","Ska","Death Metal","Pranks","Soundtrack",
"Euro-Techno","Ambient","Trip-Hop","Vocal","Jazz+Funk","Fusion","Trance","Classical","Instrumental","Acid","House",
"Game","Sound Clip","Gospel","Noise","AlternRock","Bass","Soul","Punk","Space","Meditative","Instrumental Pop",
"Instrumental Rock","Ethnic","Gothic","Darkwave","Techno-Industrial","Electronic","Pop-Folk","Eurodance","Dream",
"Southern Rock","Comedy","Cult","Gangsta","Top 40","Christian Rap","Pop/Funk","Jungle","Native American","Cabaret",
"New Wave","Psychedelic","Rave","Showtunes","Trailer","Lo-Fi","Tribal","Acid Punk","Acid Jazz","Polka","Retro",
"Musical","Rock & Roll","Hard Rock","Folk","Folk-Rock","National Folk","Swing","Fast Fusion","Bebob","Latin",
"Revival","Celtic","Bluegrass","Avantgarde","Gothic Rock","Progressive Rock","Psychedelic Rock","Symphonic Rock",
"Slow Rock","Big Band","Chorus","Easy Listening","Acoustic","Humour","Speech","Chanson","Opera","Chamber Music",
"Sonata","Symphony","Booty Bass","Primus","Porn Groove","Satire","Slow Jam","Club","Tango","Samba","Folklore",
"Ballad","Power Ballad","Rhythmic Soul","Freestyle","Duet","Punk Rock","Drum Solo","A cappella","Euro-House",
"Dance Hall","Goa","Drum & Bass","Club-House","Hardcore Techno","Terror","Indie","BritPop","Negerpunk","Polsk Punk",
"Beat","Christian Gangsta Rap","Heavy Metal","Black Metal","Crossover","Contemporary Christian","Christian Rock",
"Merengue","Salsa","Thrash Metal","Anime","Jpop","Synthpop","Abstract","Art Rock","Baroque","Bhangra","Big Beat",
"Breakbeat","Chillout","Downtempo","Dub","EBM","Eclectic","Electro","Electroclash","Emo","Experimental","Garage",
"Global","IDM","Illbient","Industro-Goth","Jam Band","Krautrock","Leftfield","Lounge","Math Rock","New Romantic",
"Nu-Breakz","Post-Punk","Post-Rock","Psytrance","Shoegaze","Space Rock","Trop Rock","World Music","Neoclassical",
"Audiobook","Audio Theatre","Neue Deutsche Welle","Podcast","Indie Rock","G-Funk","Dubstep","Garage Rock","Psybient",
];

// FFmpeg's metadata conversion tables (id3v2.c, vorbiscomment.c, riff.c)
const ID3_34 = {TALB: 'album', TCOM: 'composer', TCON: 'genre', TCOP: 'copyright', TENC: 'encoded_by', TIT2: 'title',
  TLAN: 'language', TPE1: 'artist', TPE2: 'album_artist', TPE3: 'performer', TPOS: 'disc', TPUB: 'publisher',
  TRCK: 'track', TSSE: 'encoder', USLT: 'lyrics'};
const ID3_22 = {TAL: 'album', TCO: 'genre', TCP: 'compilation', TT2: 'title', TEN: 'encoded_by', TP1: 'artist',
  TP2: 'album_artist', TP3: 'performer', TRK: 'track'};
const ID3_4 = {TCMP: 'compilation', TDRC: 'date', TDRL: 'date', TDEN: 'creation_time', TSOA: 'album-sort',
  TSOP: 'artist-sort', TSOT: 'title-sort', TIT1: 'grouping'};
const VORBIS = {ALBUMARTIST: 'album_artist', TRACKNUMBER: 'track', DISCNUMBER: 'disc', DISCSUBTITLE: 'disc_subtitle',
  DESCRIPTION: 'comment'};
const RIFF_INFO = {IART: 'artist', ICMT: 'comment', ICOP: 'copyright', ICRD: 'date', IGNR: 'genre', ILNG: 'language',
  INAM: 'title', IPRD: 'album', IPRT: 'track', ITRK: 'track', ISFT: 'encoder', ISMP: 'timecode', ITCH: 'encoded_by'};
const PICTURE_TYPES = ['Other', "32x32 pixels 'file icon'", 'Other file icon', 'Cover (front)', 'Cover (back)',
  'Leaflet page', 'Media (e.g. label side of CD)', 'Lead artist/lead performer/soloist', 'Artist/performer',
  'Conductor', 'Band/Orchestra', 'Composer', 'Lyricist/text writer', 'Recording Location', 'During recording',
  'During performance', 'Movie/video screen capture', 'A bright coloured fish', 'Illustration',
  'Band/artist logotype', 'Publisher/Studio logotype'];
const IMAGE_MIME = {'image/gif': 'gif', 'image/jpeg': 'mjpeg', 'image/jpg': 'mjpeg', 'image/png': 'png',
  'image/tiff': 'tiff', 'image/bmp': 'bmp', 'image/webp': 'webp', 'image/jxl': 'jpegxl', JPG: 'mjpeg', PNG: 'png'};

/** FFmpeg's AVDictionary, as far as the readers here use it: keys compared without case, insertion order kept. */
class Dict {
  constructor() { this.e = []; }
  find(k) { const l = k.toLowerCase(); return this.e.findIndex(([x]) => x.toLowerCase() === l); }
  get(k) { const i = this.find(k); return i < 0 ? undefined : this.e[i][1]; }
  has(k) { return this.find(k) >= 0; }
  /** av_dict_set: replaces (the last entry moves into the old one's place, the new one goes last), or keeps the old
   * value with keep (AV_DICT_DONT_OVERWRITE), or appends to it with append (AV_DICT_APPEND). */
  set(k, v, {keep = false, append = false} = {}) {
    const i = this.find(k);
    if (i >= 0) {
      if (keep) return;
      if (append) { this.e[i][1] += v; return; }
      const last = this.e.pop();
      if (i < this.e.length) this.e[i] = last;
    }
    this.e.push([k, v]);
  }
  del(k) { const i = this.find(k); if (i >= 0) { const last = this.e.pop(); if (i < this.e.length) this.e[i] = last; } }
  /** ff_metadata_conv: every key found in conv (without case) renamed, the dictionary rebuilt in order. */
  conv(table) {
    const d = new Dict(), up = Object.fromEntries(Object.entries(table).map(([k, v]) => [k.toUpperCase(), v]));
    for (const [k, v] of this.e) d.set(up[k.toUpperCase()] ?? k, v);
    this.e = d.e;
  }
  obj() { return Object.fromEntries(this.e); }
}

const latin1 = (u, a = 0, b = u.length) => { let s = ''; for (let i = a; i < b; i++) s += String.fromCharCode(u[i]); return s; };
const utf8 = (u, a = 0, b = u.length) => new TextDecoder('utf-8').decode(u.subarray(a, b));
const ascii4 = (u, i) => String.fromCharCode(u[i], u[i + 1], u[i + 2], u[i + 3]);
const be32 = (u, i) => ((u[i] << 24) >>> 0) + (u[i + 1] << 16) + (u[i + 2] << 8) + u[i + 3];
const le32 = (u, i) => (u[i] | u[i + 1] << 8 | u[i + 2] << 16 | u[i + 3] << 24) >>> 0;
const be64 = (u, i) => be32(u, i) * 2 ** 32 + be32(u, i + 4);

// ------------------------------------------------------------------ ID3v2 (id3v2.c)
/** decode_str: a string in an ID3 encoding from u[p], up to max bytes or its terminating NUL.
 * Returns [text, bytes used] or null (a bad BOM). */
function id3str(u, p, max, enc) {
  const end = p + max;
  if (enc === 0 || enc === 3) {
    let q = p;
    while (q < end && u[q]) q++;
    const s = enc === 0 ? latin1(u, p, q) : utf8(u, p, q);
    return [s, Math.min(end, q + 1) - p];
  }
  let le = false, q = p;
  if (enc === 1) {
    if (max < 2) return null;
    const bom = u[p] << 8 | u[p + 1];
    q += 2;
    if (bom === 0xfffe) le = true;
    else if (bom === 0) return ['', 2];
    else if (bom !== 0xfeff) return null;
  } else if (enc !== 2) return ['', 0];
  const units = [];
  while (q + 1 < end) {
    const c = le ? u[q] | u[q + 1] << 8 : u[q] << 8 | u[q + 1];
    q += 2;
    if (!c) break;
    units.push(c);
  }
  return [String.fromCharCode(...units.slice(0, 65536)) + (units.length > 65536 ? String.fromCharCode(...units.slice(65536)) : ''), q - p];
}

/** id3v2_parse: one ID3v2 tag's frames into meta (a Dict), pictures and PRIV frames into extra. */
function id3v2Parse(u, p, len, version, flags, meta, extra) {
  const end = p + len;
  if (version < 2 || version > 4 || (version === 2 && flags & 0x40)) return end;
  const v34 = version > 2, hdr = v34 ? 10 : 6, unsync = flags & 0x80;
  if (v34 && flags & 0x40) {
    let ext = version === 4 ? syncsafe(u, p) - 4 : be32(u, p);
    p += 4 + ext;
    len -= ext + 4;
    if (len < 0) return end;
  }
  const comm = v34 ? 'COMM' : 'COM';
  while (len >= hdr) {
    let tag, tlen, tflags = 0;
    if (v34) {
      tag = latin1(u, p, p + 4).replace(/\0.*$/s, '');
      tlen = be32(u, p + 4);
      if (version === 4 && tlen > 0x7f) {
        if (tlen < len) {
          const cur = p + 8;
          if (isTag(u, cur + 2 + toSyncsafe(tlen))) tlen = toSyncsafe(tlen);
          else if (!isTag(u, cur + 2 + tlen)) break;
        } else tlen = toSyncsafe(tlen);
      }
      tflags = u[p + 8] << 8 | u[p + 9];
      p += 10;
    } else {
      tag = latin1(u, p, p + 3).replace(/\0.*$/s, '');
      tlen = u[p + 3] << 16 | u[p + 4] << 8 | u[p + 5];
      p += 6;
    }
    if (tlen > 1 << 28) break;
    len -= hdr + tlen;
    if (len < 0) break;
    const next = p + tlen;
    if (!tlen) continue;
    let body = u.subarray(p, next);
    if (tflags & 0x0001) {                                       // data length indicator
      if (body.length < 4) break;
      body = body.subarray(4);
    }
    const encr = tflags & 0x0004, comp = tflags & 0x0008;
    if (encr || comp) { p = next; continue; }                    // (zlib-compressed frames are rare: skipped)
    const known = tag[0] === 'T' || tag === 'USLT' || tag === comm ||
      (v34 ? ['APIC', 'PRIV'] : ['PIC', 'PRIV']).includes(tag);
    if (known) {
      if (unsync || tflags & 0x0002) {
        const out = [];
        for (let i = 0; i < body.length; i++) {
          out.push(body[i]);
          if (body[i] === 0xff && i + 1 < body.length && body[i + 1] === 0) i++;
        }
        body = Uint8Array.from(out);
      }
      if (tag[0] === 'T') readTtag(body, meta, tag);
      else if (tag === 'USLT') readUslt(body, meta);
      else if (tag === comm) readComment(body, meta);
      else if (tag === 'APIC' || tag === 'PIC') readApic(body, v34, extra);
      else if (tag === 'PRIV') readPriv(body, extra);
    } else if (!tag[0]) break;                                   // padding
    p = next;
  }
  return end + (version === 4 && flags & 0x10 ? 10 : 0);
}

const syncsafe = (u, i) => (u[i] & 0x7f) << 21 | (u[i + 1] & 0x7f) << 14 | (u[i + 2] & 0x7f) << 7 | (u[i + 3] & 0x7f);
const toSyncsafe = n => (n & 0x7f) | (n >> 8 & 0x7f) << 7 | (n >> 16 & 0x7f) << 14 | (n >> 24 & 0x7f) << 21;
function isTag(u, i) {                                           // check_tag: four [A-Z0-9] or all zero
  if (i + 4 > u.length) return false;
  const s = [u[i], u[i + 1], u[i + 2], u[i + 3]];
  return s.every(c => c >= 65 && c <= 90 || c >= 48 && c <= 57) || s.every(c => !c);
}

function readTtag(b, meta, key) {
  if (b.length < 1) return;
  const enc = b[0];
  let r = id3str(b, 1, b.length - 1, enc);
  if (!r) return;
  let [dst, used] = r, g;
  if ((key === 'TCON' || key === 'TCO') && (g = /^\((\d+)\)/.exec(dst) || /^\s*[+-]?(\d+)/.exec(dst)) && +g[1] <= 191) {
    dst = GENRES[+g[1]];
  } else if (key === 'TXXX' || key === 'TXX') {
    key = dst;
    r = id3str(b, 1 + used, b.length - 1 - used, enc);
    if (!r) return;
    dst = r[0];
  } else if (!dst) return;
  meta.set(key, dst, {keep: true});
}

// FFmpeg 9.0's read_comment and read_uslt (later versions key comments by language too)
function readComment(b, meta) {
  if (b.length < 4) return;
  const enc = b[0];
  const d = id3str(b, 4, b.length - 4, enc);
  if (!d) return;
  const t = id3str(b, 4 + d[1], b.length - 4 - d[1], enc);
  if (!t) return;
  meta.set(d[0] || 'comment', t[0], {keep: true});
}

function readUslt(b, meta) {
  if (b.length < 4) return;
  const enc = b[0], lang = latin1(b, 1, 4).replace(/ .*$/s, '');
  const d = id3str(b, 4, b.length - 4, enc);
  if (!d) return;
  const t = id3str(b, 4 + d[1], b.length - 4 - d[1], enc);
  if (!t) return;
  meta.set(`lyrics-${d[0] ? d[0] + '-' : ''}${lang}`, t[0]);
}

function readApic(b, v34, extra) {
  if (b.length <= 4 || (!v34 && b.length <= 6)) return;
  const enc = b[0];
  let p = 1, mime;
  if (v34) {
    let q = p;
    while (q < b.length && b[q]) q++;
    if (q >= b.length - 1) return;
    mime = latin1(b, p, q);
    p = q + 1;
  } else { mime = latin1(b, p, p + 3); p += 3; }
  const codec = Object.entries(IMAGE_MIME).find(([k]) => k.toLowerCase() === mime.toLowerCase())?.[1];
  if (!codec) return;
  let type = b[p++];
  if (type >= PICTURE_TYPES.length) type = 0;
  const d = id3str(b, p, b.length - p, enc);
  if (!d) return;
  p += d[1];
  if (p >= b.length) return;
  const png = b[p] === 0x89 && b[p + 1] === 0x50 && b[p + 2] === 0x4e && b[p + 3] === 0x47;
  extra.push({tag: 'APIC', codec: png ? 'png' : codec, description: d[0].replace(/ +$/, ''), type: PICTURE_TYPES[type]});
}

function readPriv(b, extra) {
  let q = 0;
  while (q < b.length && b[q]) q++;
  const owner = latin1(b, 0, q);
  let s = '';
  for (let i = Math.min(b.length, q + 1); i < b.length; i++) {
    const c = b[i];
    s += c < 32 || c > 126 || c === 92 ? '\\x' + c.toString(16).padStart(2, '0') : String.fromCharCode(c);
  }
  extra.push({tag: 'PRIV', owner, value: s});
}

/** id3v2_read_internal: every ID3v2 tag at the start of the file. Returns {meta, extra, end} (end: where they stop). */
function id3v2Read(u) {
  const meta = new Dict(), extra = [];
  let p = 0;
  while (p + 10 <= u.length && u[p] === 0x49 && u[p + 1] === 0x44 && u[p + 2] === 0x33 && u[p + 3] !== 0xff &&
         u[p + 4] !== 0xff && !(u[p + 6] & 0x80) && !(u[p + 7] & 0x80) && !(u[p + 8] & 0x80) && !(u[p + 9] & 0x80)) {
    p = id3v2Parse(u, p + 10, syncsafe(u, p + 6), u[p + 3], u[p + 5], meta, extra);
  }
  meta.conv(ID3_34);
  meta.conv(ID3_22);
  meta.conv(ID3_4);
  mergeDate(meta);
  return {meta, extra, end: p};
}

function mergeDate(m) {
  const four = k => { const i = m.e.findIndex(([x]) => x === k); return i >= 0 && /^\d{4}$/.test(m.e[i][1]) ? m.e[i][1] : null; };
  const y = four('TYER') ?? four('TYE');
  if (y == null) return;
  let date = y;
  m.del('TYER'); m.del('TYE');
  const d = four('TDAT') ?? four('TDA');
  if (d != null) {
    date += `-${d.slice(2, 4)}-${d.slice(0, 2)}`;
    m.del('TDAT'); m.del('TDA');
    const t = four('TIME') ?? four('TIM');
    if (t != null) { date += ` ${t.slice(0, 2)}:${t.slice(2, 4)}`; m.del('TIME'); m.del('TIM'); }
  }
  m.set('date', date);
}

/** id3v1.c parse_tag */
function id3v1(u, meta) {
  if (u.length <= 128) return;
  const b = u.subarray(u.length - 128);
  if (b[0] !== 0x54 || b[1] !== 0x41 || b[2] !== 0x47) return;
  const str = (k, a, n) => {
    let q = a;
    while (q < a + n && b[q]) q++;
    const s = latin1(b, a, q).replace(/ +$/, '');
    if (s) meta.set(k, s);
  };
  str('title', 3, 30); str('artist', 33, 30); str('album', 63, 30); str('date', 93, 4); str('comment', 97, 30);
  if (b[125] === 0 && b[126] !== 0) meta.set('track', String(b[126]));
  if (b[127] <= 191) meta.set('genre', GENRES[b[127]]);
}

// ------------------------------------------------------------------ MPEG audio (mp3dec.c, mpegaudiodecheader.c)
const MPA_RATES = [44100, 48000, 32000];
const MPA_BITRATE = [   // [lsf][layer-1][index], kbit/s
  [[0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
   [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
   [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]],
  [[0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
   [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
   [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]],
];

/** An MPEG audio frame header at u[p]: {sr, channels, layer, lsf, bitrate, size} or null. */
function mpaHeader(u, p) {
  if (p + 4 > u.length) return null;
  const h = be32(u, p);
  if ((h & 0xffe00000) >>> 0 !== 0xffe00000 || (h & (3 << 17)) === 0 || (h & (0xf << 12)) === (0xf << 12) ||
      (h & (3 << 10)) === (3 << 10)) return null;
  const mpeg25 = !(h & (1 << 20)), lsf = (h & (1 << 19)) ? 0 : 1, layer = 4 - (h >> 17 & 3);
  const sr = MPA_RATES[h >> 10 & 3] >> (lsf + (mpeg25 ? 1 : 0)), bi = h >> 12 & 0xf, pad = h >> 9 & 1;
  const channels = (h >> 6 & 3) === 3 ? 1 : 2;
  if (!bi) return {sr, channels, layer, lsf, bitrate: 0, size: 0, mpeg25};
  const kbps = MPA_BITRATE[lsf][layer - 1][bi];
  let size;
  if (layer === 1) size = (Math.floor(kbps * 12000 / sr) + pad) * 4;
  else if (layer === 2) size = Math.floor(kbps * 144000 / sr) + pad;
  else size = Math.floor(kbps * 144000 / (sr << lsf)) + pad;
  return {sr, channels, layer, lsf, bitrate: kbps * 1000, size, mpeg25};
}

/** ff_crcA001_update over a range (the LAME tag's CRC-16). */
function crcA001(u, a, b) {
  let c = 0;
  for (let i = a; i < b; i++) {
    c ^= u[i];
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xa001 : c >>> 1;
  }
  return c;
}

function mp3(u, id3end, meta, extra) {
  const stream = {codec_type: 'audio', codec_name: 'mp3', tags: new Dict()};
  // the first frame: where mp3_read_header starts (after ID3v2 tags; FFmpeg's probe also skips junk before it)
  let p = id3end, h = null;
  for (let i = 0; i < 65536 && p + i + 4 <= u.length; i++) {
    const a = mpaHeader(u, p + i);
    if (a && a.size && mpaHeader(u, p + i + a.size)) { p += i; h = a; break; }
  }
  if (!h) return null;
  stream.sample_rate = h.sr;
  stream.channels = h.channels;
  if (h.layer !== 3) stream.codec_name = h.layer === 2 ? 'mp2' : 'mp1';
  const spf = h.layer === 3 ? (h.lsf ? 576 : 1152) : h.layer === 1 ? 384 : 1152;
  // Xing / Info / LAME tag (mp3_parse_info_tag), VBRI (mp3_parse_vbri_tag)
  let frames = 0, hsize = 0, startPad = 0, endPad = 0, isCbr = false, skip = 0;
  if (h.layer === 3) {
    const off = [[32, 17], [17, 9]][h.lsf === 1 ? 1 : 0][h.channels === 1 ? 1 : 0];
    let q = p + 4 + off;
    const fsize = Math.max(0, u.length - (p + 4));
    const v = ascii4(u, q);
    isCbr = v === 'Info';
    if (v === 'Xing' || isCbr) {
      const fl = be32(u, q + 4);
      q += 8;
      if (fl & 1) { frames = be32(u, q); q += 4; }
      if (fl & 2) { hsize = be32(u, q); q += 4; }
      if (fsize && hsize) {
        const min = Math.min(fsize, hsize), delta = Math.max(fsize, hsize) - min;
        if (fsize > hsize && delta > min / 16) frames = 0;
      }
      if (fl & 4) q += 100;
      if (fl & 8) q += 4;
      const version = latin1(u, q, q + 9);
      const delays = u[q + 21] << 16 | u[q + 22] << 8 | u[q + 23];
      if (/^(LAME|Lavf|Lavc)/.test(version)) {
        startPad = delays >> 12;
        endPad = delays & 4095;
        skip = startPad + 528 + 1;
      }
      const crcAt = q + 34;
      if (crcAt + 2 <= u.length && crcA001(u, p, crcAt) === (u[crcAt] << 8 | u[crcAt + 1])) {
        stream.tags.set('encoder', version.replace(/\0.*$/s, ''));
      }
    }
    if (ascii4(u, p + 36) === 'VBRI' && (u[p + 40] << 8 | u[p + 41]) === 1) {
      hsize = be32(u, p + 46);
      frames = be32(u, p + 50);
    }
  }
  const TB = 14112000;                       // mp3's time base: 1/14112000 s
  let dur = null, start = skip ? Math.round(skip * TB / h.sr) : 0;
  if (frames) dur = Math.round((frames * spf - startPad - endPad) * TB / h.sr);
  if (frames && hsize && !isCbr) stream.bit_rate = Math.round(hsize * 8 * h.sr / (frames * spf));
  else stream.bit_rate = h.bitrate;
  let fmtDur;
  if (dur != null) fmtDur = Math.round(dur * 1e6 / TB);
  else {
    // estimate_timings_from_bit_rate: the whole file at the first frame's bit rate
    if (!h.bitrate) return null;
    const d = Math.floor((u.length - id3end) * 8 * TB / h.bitrate);
    dur = d;
    fmtDur = Math.round(d * 1e6 / TB);
    start = 0;
  }
  return {format_name: 'mp3', durationUs: fmtDur, start: start / TB, streams: [stream], streamDur: dur / TB,
          dataOffset: id3end};
}

// ------------------------------------------------------------------ MP4 (mov.c)
function* atoms(u, a, b) {
  let p = a;
  while (p + 8 <= b) {
    let size = be32(u, p), hdr = 8;
    const type = latin1(u, p + 4, p + 8);
    if (size === 1) { size = be64(u, p + 8); hdr = 16; } else if (size === 0) size = b - p;
    if (size < hdr || p + size > b) break;
    yield {type, start: p + hdr, end: p + size};
    p += size;
  }
}
const child = (u, a, type, skip = 0) => { for (const x of atoms(u, a.start + skip, a.end)) if (x.type === type) return x; return null; };

const MOV_KEYS = {aART: 'album_artist', catg: 'category', cpil: 'compilation', cprt: 'copyright', desc: 'description',
  disk: 'disc', gnre: 'genre', keyw: 'keywords', ldes: 'synopsis', pcst: 'podcast', pgap: 'gapless_playback',
  purd: 'purchase_date', rtng: 'rating', soaa: 'sort_album_artist', soal: 'sort_album', soar: 'sort_artist',
  soco: 'sort_composer', sonm: 'sort_name', sosn: 'sort_show', stik: 'media_type', trkn: 'track', tven: 'episode_id',
  tves: 'episode_sort', tvnn: 'network', tvsh: 'show', tvsn: 'season_number', '©ART': 'artist', '©PRD': 'producer',
  '©alb': 'album', '©aut': 'artist', '©chp': 'chapter', '©cmt': 'comment', '©com': 'composer', '©cpy': 'copyright',
  '©day': 'date', '©dir': 'director', '©dis': 'disclaimer', '©ed1': 'edit_date', '©enc': 'encoder',
  '©fmt': 'original_format', '©gen': 'genre', '©grp': 'grouping', '©hst': 'host_computer', '©inf': 'comment',
  '©lyr': 'lyrics', '©mak': 'make', '©mod': 'model', '©nam': 'title', '©ope': 'original_artist', '©prd': 'producer',
  '©prf': 'performers', '©req': 'playback_requirements', '©src': 'original_source', '©st3': 'subtitle',
  '©swr': 'encoder', '©too': 'encoder', '©trk': 'track', '©url': 'URL', '©wrn': 'warning', '©wrt': 'composer',
  '©xyz': 'location'};
const INT8 = new Set(['cpil', 'pcst', 'pgap', 'rtng', 'stik', 'tves', 'tvsn']);

function mp4(u) {
  const ftyp = [...atoms(u, 0, Math.min(u.length, 4096))].find(a => a.type === 'ftyp');
  const moov = [...atoms(u, 0, u.length)].find(a => a.type === 'moov');
  if (!moov) return null;
  const meta = new Dict(), streams = [];
  if (ftyp) {
    meta.set('major_brand', latin1(u, ftyp.start, ftyp.start + 4));
    meta.set('minor_version', String(be32(u, ftyp.start + 4)));
    meta.set('compatible_brands', latin1(u, ftyp.start + 8, ftyp.end).replace(/\0/g, ''));
  }
  let durationUs = null;
  const mvhd = child(u, moov, 'mvhd');
  if (mvhd) {
    const v = u[mvhd.start], q = mvhd.start + 4;
    const ctime = v === 1 ? be64(u, q) : be32(u, q), ts = be32(u, q + (v === 1 ? 16 : 8));
    const d = v === 1 ? be64(u, q + 20) : be32(u, q + 12);
    if (ctime) meta.set('creation_time', isoTime(ctime));
    if (ts && d) durationUs = Math.round(d * 1e6 / ts);
  }
  const udta = child(u, moov, 'udta');
  // udta/meta (a full box in MP4, a plain one in QuickTime files) / ilst
  const metaAtom = udta && child(u, udta, 'meta');
  const ilst = metaAtom && (child(u, metaAtom, 'ilst', 4) || child(u, metaAtom, 'ilst'));
  if (ilst) {
    for (const it of atoms(u, ilst.start, ilst.end)) {
      if (it.type === '----') {
        let name = null, val = null;
        for (const x of atoms(u, it.start, it.end)) {
          if (x.type === 'name') name = utf8(u, x.start + 4, x.end);
          else if (x.type === 'data' && val == null) val = utf8(u, x.start + 8, x.end);
        }
        if (name && val != null) meta.set(name, val);
        continue;
      }
      const key = MOV_KEYS[it.type];
      if (!key) continue;
      const data = [...atoms(u, it.start, it.end)].find(x => x.type === 'data');
      if (!data) continue;
      const type = be32(u, data.start) & 0xffffff, a = data.start + 8, b = data.end;
      let v;
      if (it.type === 'trkn' || it.type === 'disk') {
        if (b - a < 6) continue;
        const n = u[a + 2] << 8 | u[a + 3], t = u[a + 4] << 8 | u[a + 5];
        v = t ? `${n}/${t}` : String(n);
      } else if (it.type === 'gnre') {
        const g = u[a] << 8 | u[a + 1];
        if (!g || g > 192) continue;
        v = GENRES[g - 1];
      } else if (INT8.has(it.type)) v = String(u[b - 1]);
      else if (type === 21 || type === 22) v = String(b - a === 1 ? u[a] : b - a === 2 ? u[a] << 8 | u[a + 1] : be32(u, a));
      else v = utf8(u, a, b);
      meta.set(key, v);
    }
  }
  let cover = false;
  for (const trak of atoms(u, moov.start, moov.end)) {
    if (trak.type !== 'trak') continue;
    const mdia = child(u, trak, 'mdia');
    const hdlr = mdia && child(u, mdia, 'hdlr'), mdhd = mdia && child(u, mdia, 'mdhd');
    const minf = mdia && child(u, mdia, 'minf'), stbl = minf && child(u, minf, 'stbl'), stsd = stbl && child(u, stbl, 'stsd');
    if (!hdlr || !stsd) continue;
    const kind = latin1(u, hdlr.start + 8, hdlr.start + 12);
    const tags = new Dict();
    if (mdhd) {
      const v = u[mdhd.start], at = mdhd.start + (v === 1 ? 32 : 20), l = u[at] << 8 | u[at + 1];
      tags.set('language', l < 0x400 ? 'und' : String.fromCharCode((l >> 10 & 31) + 96, (l >> 5 & 31) + 96, (l & 31) + 96));
    }
    let hn = hdlr.start + 24;
    tags.set('handler_name', latin1(u, hn, hdlr.end).replace(/\0.*$/s, ''));
    const entry = [...atoms(u, stsd.start + 8, stsd.end)][0];
    if (kind === 'soun' && entry) {
      const vendor = u.subarray(entry.start + 12, entry.start + 16);
      if (vendor.some(c => c)) tags.set('vendor_id', [...vendor].map(c => c >= 32 && c < 127 ? String.fromCharCode(c) : `[${c}]`).join(''));
      const codec = {mp4a: 'aac', alac: 'alac', 'fLaC': 'flac', Opus: 'opus', '.mp3': 'mp3', 'ac-3': 'ac3', 'ec-3': 'eac3'}[entry.type] || entry.type;
      const s = {codec_type: 'audio', codec_name: codec, channels: u[entry.start + 17], sample_rate: be32(u, entry.start + 24) >>> 16, tags};
      if (entry.type === 'alac') {                              // ALAC's own header holds the real values
        const c = [...atoms(u, entry.start + 28, entry.end)].find(x => x.type === 'alac');
        if (c) { s.channels = u[c.start + 4 + 9]; s.sample_rate = be32(u, c.start + 4 + 20); }
      }
      streams.push(s);
    } else if (kind === 'vide') streams.push({codec_type: 'video', codec_name: entry?.type, tags});
  }
  // cover art in ilst (covr) becomes an attached picture stream
  if (ilst) for (const it of atoms(u, ilst.start, ilst.end)) {
    if (it.type !== 'covr') continue;
    for (const d of atoms(u, it.start, it.end)) if (d.type === 'data') {
      const t = be32(u, d.start) & 0xffffff;
      streams.push({codec_type: 'video', codec_name: t === 14 ? 'png' : t === 27 ? 'bmp' : 'mjpeg', attached_pic: 1, tags: new Dict()});
      cover = true;
    }
  }
  return {format_name: 'mov,mp4,m4a,3gp,3g2,mj2', durationUs, meta, streams, cover};
}

const isoTime = s => new Date((s - 2082844800) * 1000).toISOString().replace(/\.\d{3}Z$/, '.000000Z');

// ------------------------------------------------------------------ FLAC (flacdec.c) and Ogg (oggparse*.c)
function vorbisComments(u, a, b, meta, pics) {
  if (b - a < 8) return;
  let p = a + 4 + le32(u, a);
  let n = le32(u, p);
  p += 4;
  while (b - p >= 4 && n > 0) {
    const s = le32(u, p);
    p += 4;
    if (b - p < s) break;
    const c = utf8(u, p, p + s), eq = c.indexOf('=');
    p += s;
    n--;
    if (eq <= 0 || eq === c.length - 1) continue;
    const k = c.slice(0, eq), v = c.slice(eq + 1);
    if (k.toUpperCase() === 'METADATA_BLOCK_PICTURE') { pics.push(picture(Uint8Array.from(atob(v), ch => ch.charCodeAt(0)), 0, null)); continue; }
    if (/^CHAPTER\d\d\d/i.test(k)) continue;
    if (meta.has(k)) meta.set(k, ';', {append: true});
    meta.set(k, v, {append: true});
  }
  meta.conv(VORBIS);
}

/** A FLAC PICTURE block (also base64 in Vorbis comments): the attached picture's stream. */
function picture(u, a) {
  const type = be32(u, a), ml = be32(u, a + 4), mime = latin1(u, a + 8, a + 8 + ml);
  const dl = be32(u, a + 8 + ml), desc = utf8(u, a + 12 + ml, a + 12 + ml + dl);
  const tags = new Dict();
  if (desc) tags.set('title', desc);
  tags.set('comment', PICTURE_TYPES[type] ?? 'Other');
  const codec = IMAGE_MIME[mime.toLowerCase()] ?? 'mjpeg';
  return {codec_type: 'video', codec_name: codec, attached_pic: 1, tags};
}

function flac(u, at) {
  const meta = new Dict(), pics = [];
  let p = at + 4, sr = 0, ch = 0, samples = 0, last = false;
  while (!last && p + 4 <= u.length) {
    last = !!(u[p] & 0x80);
    const type = u[p] & 0x7f, len = u[p + 1] << 16 | u[p + 2] << 8 | u[p + 3], a = p + 4;
    if (type === 0) {
      sr = u[a + 10] << 12 | u[a + 11] << 4 | u[a + 12] >> 4;
      ch = (u[a + 12] >> 1 & 7) + 1;
      samples = (u[a + 13] & 15) * 2 ** 32 + be32(u, a + 14);
    } else if (type === 4) vorbisComments(u, a, a + len, meta, pics);
    else if (type === 6) pics.push(picture(u, a));
    p = a + len;
  }
  const stream = {codec_type: 'audio', codec_name: 'flac', sample_rate: sr, channels: ch, tags: new Dict()};
  return {format_name: 'flac', durationUs: samples && sr ? Math.round(samples * 1e6 / sr) : null, meta,
          streams: [stream, ...pics]};
}

function ogg(u) {
  // pages -> the first logical stream's packets (headers), and its last granule position
  const packets = [];
  let p = 0, serial = null, cur = [], lastGranule = 0;
  while (p + 27 <= u.length && ascii4(u, p) === 'OggS') {
    const nseg = u[p + 26], s = le32(u, p + 14), lace = u.subarray(p + 27, p + 27 + nseg);
    const granule = le32(u, p + 6) + le32(u, p + 10) * 2 ** 32;
    let q = p + 27 + nseg;
    if (serial == null) serial = s;
    if (s === serial) {
      if (granule !== 2 ** 64 - 1 && le32(u, p + 10) !== 0xffffffff) lastGranule = granule;
      for (const l of lace) {
        if (packets.length < 3) cur.push(u.subarray(q, q + l));
        q += l;
        if (l < 255 && packets.length < 3) {
          const n = cur.reduce((a, b) => a + b.length, 0), pk = new Uint8Array(n);
          let o = 0;
          for (const c of cur) { pk.set(c, o); o += c.length; }
          packets.push(pk);
          cur = [];
        }
      }
    }
    p = p + 27 + nseg + lace.reduce((a, b) => a + b, 0);
  }
  if (!packets.length) return null;
  const tags = new Dict(), pics = [];
  let stream;
  const h = packets[0];
  if (latin1(h, 1, 7) === 'vorbis') {
    stream = {codec_type: 'audio', codec_name: 'vorbis', channels: h[11], sample_rate: le32(h, 12), tags};
    if (packets[1]) vorbisComments(packets[1], 7, packets[1].length - 1, tags, pics);
    stream.durationUs = Math.round(lastGranule * 1e6 / stream.sample_rate);
  } else if (latin1(h, 0, 8) === 'OpusHead') {
    const pre = h[10] | h[11] << 8;
    stream = {codec_type: 'audio', codec_name: 'opus', channels: h[9], sample_rate: 48000, tags};
    if (packets[1]) vorbisComments(packets[1], 8, packets[1].length, tags, pics);
    stream.durationUs = Math.round(lastGranule * 1e6 / 48000);   // FFmpeg's start time is -pre-skip: the span is the granule
  } else if (h[0] === 0x7f && latin1(h, 1, 5) === 'FLAC') {
    const fl = flac(h.subarray(9), 0);
    stream = {...fl.streams[0], tags};
    for (const [k, v] of fl.meta.e) tags.set(k, v);
    stream.durationUs = Math.round(lastGranule * 1e6 / stream.sample_rate);
  } else return null;
  return {format_name: 'ogg', durationUs: stream.durationUs, meta: new Dict(), streams: [stream, ...pics]};
}

// ------------------------------------------------------------------ WAV (wavdec.c, riffdec.c)
function wavFile(u) {
  const meta = new Dict();
  let fmt = null, data = 0, p = 12, extra = [], id3 = null;
  while (p + 8 <= u.length) {
    const id = ascii4(u, p), len = le32(u, p + 4), a = p + 8;
    if (id === 'fmt ') fmt = {tag: u[a] | u[a + 1] << 8, ch: u[a + 2] | u[a + 3] << 8, sr: le32(u, a + 4),
      byteRate: le32(u, a + 8), bits: u[a + 14] | u[a + 15] << 8};
    else if (id === 'data') data = Math.min(len, u.length - a);
    else if (id === 'LIST' && ascii4(u, a) === 'INFO') {
      for (let q = a + 4; q + 8 <= a + len;) {
        const k = ascii4(u, q), l = le32(u, q + 4), v = latin1(u, q + 8, q + 8 + l).replace(/\0.*$/s, '');
        if (v) meta.set(k, v);
        q += 8 + l + (l & 1);
      }
    } else if (id === 'id3 ' || id === 'ID3 ') id3 = id3v2Read(u.subarray(a, a + len));
    p = a + len + (len & 1);
  }
  if (!fmt) return null;
  meta.conv(RIFF_INFO);
  if (id3) for (const [k, v] of id3.meta.e) meta.set(k, v), extra = id3.extra;
  const codec = fmt.tag === 3 ? `pcm_f${fmt.bits}le` : fmt.tag === 1 ? (fmt.bits === 8 ? 'pcm_u8' : `pcm_s${fmt.bits}le`) : 'unknown';
  const stream = {codec_type: 'audio', codec_name: codec, sample_rate: fmt.sr, channels: fmt.ch, tags: new Dict(),
                  bit_rate: fmt.byteRate * 8};
  return {format_name: 'wav', durationUs: fmt.byteRate ? Math.round(data * 1e6 / fmt.byteRate) : null, meta,
          streams: [stream, ...pictures(extra)], bitRate: fmt.byteRate * 8};
}

function pictures(extra) {
  return extra.filter(x => x.tag === 'APIC').map(x => {
    const tags = new Dict();
    if (x.description) tags.set('title', x.description);
    tags.set('comment', x.type);
    return {codec_type: 'video', codec_name: x.codec, attached_pic: 1, tags};
  });
}

// ------------------------------------------------------------------ the file
/** ffprobe -show_format -show_streams, as far as song_info reads it: {format: {format_name, duration, bit_rate, tags},
 * streams: [{codec_type, codec_name, sample_rate, channels, disposition: {attached_pic}, tags}]}. Unknown files give
 * {} (as ffprobe failing does in pipeline.probe). */
export function readTags(bytes) {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes.buffer ?? bytes, bytes.byteOffset ?? 0, bytes.byteLength);
  const id3 = id3v2Read(u);
  let r = null;
  const at = id3.end;
  if (ascii4(u, at) === 'fLaC') r = flac(u, at);
  else if (ascii4(u, 0) === 'OggS') r = ogg(u);
  else if (ascii4(u, 0) === 'RIFF' && ascii4(u, 8) === 'WAVE') r = wavFile(u);
  else if (ascii4(u, 4) === 'ftyp') r = mp4(u);
  else {
    r = mp3(u, at, id3.meta, id3.extra);
    if (r) {
      // mp3_read_header: the ID3v2 tags, or ID3v1 when they hold nothing; then pictures and PRIV frames
      r.meta = id3.meta;
      if (!r.meta.e.length) id3v1(u, r.meta);
      r.streams.push(...pictures(id3.extra));
      for (const x of id3.extra) if (x.tag === 'PRIV') r.meta.set('id3v2_priv.' + x.owner, x.value, {keep: true});
    }
  }
  if (!r) return {};
  if (r.format_name === 'flac' && !r.meta.e.length && id3.meta.e.length) r.meta = id3.meta;   // ID3 before fLaC
  const format = {format_name: r.format_name};
  if (r.durationUs != null && r.durationUs > 0) {
    format.duration = (r.durationUs / 1e6).toFixed(6);
    // update_stream_timings: the file's size over its duration, truncated
    format.bit_rate = String(Math.trunc(u.length * 8 * 1e6 / r.durationUs));
  } else if (r.bitRate) format.bit_rate = String(r.bitRate);
  if (r.meta.e.length) format.tags = r.meta.obj();
  const streams = r.streams.map(s => {
    const o = {codec_type: s.codec_type, codec_name: s.codec_name};
    if (s.sample_rate) o.sample_rate = String(s.sample_rate);
    if (s.channels) o.channels = s.channels;
    o.disposition = {attached_pic: s.attached_pic ? 1 : 0};
    if (s.tags.e.length) o.tags = s.tags.obj();
    return o;
  });
  return {format, streams};
}

/** pipeline.probe: (the ffprobe-like view, every tag with its name lowercased, the file's first, then each stream's). */
export function probe(bytes) {
  const j = readTags(bytes), tags = {};
  for (const d of [j.format?.tags ?? {}, ...(j.streams ?? []).map(s => s.tags ?? {})]) {
    for (const [k, v] of Object.entries(d)) {
      const l = k.toLowerCase();
      if (!(l in tags)) tags[l] = pyStrip(String(v));
    }
  }
  return [j, tags];
}

// Python's str.strip(): whitespace as Python counts it
const pyStrip = s => s.replace(/^[\s\x1c-\x1f\x85]+|[\s\x1c-\x1f\x85]+$/g, '');

/** pipeline.song_tags: [artist, title, album] from the tags, the gaps filled from a file name "Artist - Title". */
export function songTags(tags, name) {
  let artist = tags.artist || tags.album_artist || '', title = tags.title || '';
  const base = String(name || '').split(/[\\/]/).pop();
  const dot = base.lastIndexOf('.');
  const root = dot > 0 && !/^\.+$/.test(base.slice(0, dot)) ? base.slice(0, dot) : base;    // os.path.splitext
  const stem = root.replace(/_/g, ' ').replace(/^\s*\d{1,3}\s*[-._)]?\s+/, '');
  const i = stem.indexOf(' - ');
  if (i >= 0) {
    const a = stem.slice(0, i), t = stem.slice(i + 3);
    artist = artist || pyStrip(a);
    title = title || pyStrip(t);
  }
  return [artist, title, tags.album || ''];
}

/** pipeline.song_info: what identifies this recording. bytes: the file (ArrayBuffer or Uint8Array), name: its file
 * name, sha256: its hash (hex). */
export async function songInfo(bytes, name, sha256 = null) {
  const [j, tags] = probe(bytes);
  const fmt = j.format ?? {}, streams = j.streams ?? [];
  const audio = streams.find(s => s.codec_type === 'audio') ?? {};
  const tag = (...names) => { for (const n of names) if (tags[n]) return tags[n]; return null; };
  const [artist, title, album] = songTags(tags, name);
  const mb = {recording: tag('musicbrainz_trackid', 'musicbrainz track id', 'musicbrainz_recordingid'),
    release: tag('musicbrainz_albumid', 'musicbrainz album id'), artist: tag('musicbrainz_artistid', 'musicbrainz artist id'),
    track: tag('musicbrainz_releasetrackid', 'musicbrainz release track id')};
  return {
    title: title || null, artist: artist || null, album: album || null,
    albumArtist: tag('album_artist', 'albumartist', 'album artist'), track: tag('track', 'tracknumber'),
    disc: tag('disc', 'discnumber'), date: tag('date', 'year', 'originaldate', 'tdor'), genre: tag('genre'),
    composer: tag('composer'), label: tag('label', 'publisher', 'organization'),
    isrc: tag('isrc', 'tsrc'),
    musicbrainz: Object.fromEntries(Object.entries(mb).filter(([, v]) => v)),
    duration: fmt.duration ? parseFloat(fmt.duration) : null,
    file: {name: String(name || '').split(/[\\/]/).pop(), sha256, format: fmt.format_name ?? null,
           codec: audio.codec_name ?? null, bitrate: fmt.bit_rate ? parseInt(fmt.bit_rate) : null,
           sampleRate: audio.sample_rate ? parseInt(audio.sample_rate) : null, channels: audio.channels ?? null,
           cover: streams.some(s => s.disposition?.attached_pic)},
    tags,
  };
}
