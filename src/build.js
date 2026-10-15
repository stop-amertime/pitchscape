// Builds docs/index.html from src/app.html + src/dsp.js.
// The engine is inlined into <script id="dsp"> so the page can also start it as a Web Worker from that text.
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(__dirname, 'app.html'), 'utf8');
const dsp = fs.readFileSync(path.join(__dirname, 'dsp.js'), 'utf8');
if (/<\/script/i.test(dsp)) throw new Error('dsp.js must not contain a closing script tag');
const page = app.replace('/*DSP_SOURCE*/', () => dsp);
const cut = page.indexOf('<main class="app">');
if (cut < 0) throw new Error('could not find <main class="app">');
const head = page.slice(0, cut), body = page.slice(cut);
const reset = 'html{color-scheme:light}:root{padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}body{margin:0;font:14px system-ui}img{max-width:100%}[hidden]{display:none!important}';
const out = '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">\n<style>' + reset + '</style>\n' + head + '</head>\n<body>\n' + body + '</body>\n</html>\n';
fs.writeFileSync(path.join(root, 'docs', 'index.html'), out);
console.log('wrote docs/index.html', (out.length / 1024).toFixed(0) + ' KB');
