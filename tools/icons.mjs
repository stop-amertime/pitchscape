// Writes the page's icons (Lucide, ISC licence: https://lucide.dev, npm lucide-static) into src/app.html as one
// hidden SVG sprite between <!--ICONS--> and <!--/ICONS-->, so the page carries them itself (no font or CDN). The page
// uses an icon as <svg class="i"><use href="#i-NAME"/></svg>; this finds every such NAME in app.html, so add the
// <use> and run `node tools/icons.mjs` (after `npm install`).
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = path.join(root, 'src', 'app.html');
const dir = path.join(root, 'node_modules', 'lucide-static', 'icons');
const version = JSON.parse(fs.readFileSync(path.join(root, 'node_modules', 'lucide-static', 'package.json'), 'utf8')).version;
let app = fs.readFileSync(file, 'utf8');
const names = [...new Set([...app.matchAll(/href="#i-([a-z0-9-]+)"/g)].map(m => m[1]))].sort();
const symbols = names.map(n => {
  const svg = fs.readFileSync(path.join(dir, n + '.svg'), 'utf8');
  const inner = svg.slice(svg.indexOf('>', svg.indexOf('<svg')) + 1, svg.lastIndexOf('</svg>')).replace(/\s+/g, ' ').replace(/ \/>/g, '/>').trim();
  return `<symbol id="i-${n}" viewBox="0 0 24 24">${inner}</symbol>`;
});
const sprite = `<!--ICONS--><!-- Lucide ${version} (ISC licence, lucide.dev), written by tools/icons.mjs -->` +
  `<svg width="0" height="0" style="position:absolute" aria-hidden="true" focusable="false">\n${symbols.join('\n')}\n</svg><!--/ICONS-->`;
const a = app.indexOf('<!--ICONS-->'), b = app.indexOf('<!--/ICONS-->');
if (a < 0 || b < a) throw new Error('src/app.html has no <!--ICONS--> ... <!--/ICONS--> block');
app = app.slice(0, a) + sprite + app.slice(b + '<!--/ICONS-->'.length);
fs.writeFileSync(file, app);
console.log(`icons: ${names.join(', ')}`);
