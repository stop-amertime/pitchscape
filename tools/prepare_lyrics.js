// usage: node tools/prepare_lyrics.js LYRICS.txt WORKDIR
// Cleans pasted lyrics (a whole lyrics web page is fine) and splits them exactly the way the page does.
// Writes into WORKDIR: lines.json (distinct lines, first-sung order), written.json ([{h, n}] per line), page_words.json
const DSP = require('../src/dsp.js'), fs = require('fs'), path = require('path');
const [src, work] = process.argv.slice(2);
if (!src || !work) { console.error('usage: node tools/prepare_lyrics.js LYRICS.txt WORKDIR'); process.exit(1); }
const lines = DSP.parseLyrics(DSP.cleanPastedLyrics(fs.readFileSync(src, 'utf8')).text);
const seen = new Set(), distinct = [];
lines.forEach((l) => { const h = DSP.lineHash(l.text); if (!seen.has(h)) { seen.add(h); distinct.push(l.text); } });
fs.writeFileSync(path.join(work, 'lines.json'), JSON.stringify(distinct));
fs.writeFileSync(path.join(work, 'written.json'), JSON.stringify(lines.map((l) => ({ h: DSP.lineHash(l.text), n: l.words.length }))));
fs.writeFileSync(path.join(work, 'page_words.json'), JSON.stringify(lines.map((l) => l.words.map((w) => w.text))));
console.log(`lyrics: ${lines.length} lines (${distinct.length} distinct), ${lines.reduce((a, l) => a + l.words.length, 0)} words`);
