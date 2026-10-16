// Load a song in the page on a phone-sized screen and save the print at given times, controls hidden.
// Needs tools/preview_server.py running. Usage:
//   node tools/render_frames.cjs SONG.mp3 OUT_PREFIX 12,40,95 ['{"hold":0.15}'] [http://localhost:8010/]
// Writes OUT_PREFIX-<time>.png for each time; the optional JSON sets Lab levers.
let pw; try { pw = require('playwright'); } catch (e) { pw = require('/opt/node22/lib/node_modules/playwright'); }
const fs = require('fs'), os = require('os'), path = require('path');
(async () => {
  const [song, out, times, lab, site] = process.argv.slice(2);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'pitchscape-'));
  const exe = fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined;
  const ctx = await pw.chromium.launchPersistentContext(profile, { executablePath: exe, viewport: { width: 390, height: 750 }, deviceScaleFactor: 2 });
  const p = ctx.pages()[0] || await ctx.newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.goto(site || 'http://localhost:8010/');
  await p.evaluate((lab) => { localStorage.setItem('pitchscape:key', JSON.stringify('test')); if (lab) localStorage.setItem('pitchscape:lab', JSON.stringify({ v: 2, set: JSON.parse(lab) })); }, lab || '');
  await p.reload(); await p.waitForTimeout(1200);
  await p.setInputFiles('#file', song);
  const base = path.basename(song).replace(/\.[^.]+$/, '');
  for (let i = 0; i < 240; i++) {
    if (await p.evaluate(() => !document.getElementById('play').disabled)) break;
    await p.waitForTimeout(250);
  }
  await p.waitForTimeout(400);
  for (const t of times.split(',').map(Number)) {
    await p.evaluate((t) => { const s = document.getElementById('seek'); s.value = t; s.dispatchEvent(new Event('input')); document.getElementById('hud').classList.add('away'); }, t);
    await p.waitForTimeout(450);
    await (await p.$('#plate')).screenshot({ path: `${out}-${t}.png` });
  }
  const lyr = await p.evaluate(() => document.getElementById('lyrSrc').textContent);
  console.log(base, '| lyrics:', lyr || '(none)', '| errors:', errs.length ? errs.join(' | ') : 'none');
  await ctx.close(); fs.rmSync(profile, { recursive: true, force: true });
})();
