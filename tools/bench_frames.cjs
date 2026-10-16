// Time how long the page takes to draw the print, layer by layer, on a phone-sized screen.
// Needs tools/preview_server.py running and testsongs/packs/<song>.json. Usage:
//   node tools/bench_frames.cjs [--mode=paint|js|raf] [--gpu] SONG.mp3 [FROM,TO,STEP] [CPU_SLOWDOWN] ['{"edges":0}'] [URL]
// Draws a frame every STEP seconds from FROM to TO (default 20,80,0.2) and prints each layer's median and 95th
// percentile ms. CPU_SLOWDOWN (default 4) slows the page's JavaScript about to a mid-range phone's.
// --mode=paint (default): each layer's time includes painting it. js: its JavaScript alone. raf: one frame per
// animation frame as when playing, "frame" being the time between frames (never below the refresh interval).
// Plain headless Chromium paints the canvas in software, far slower than a phone's GPU; --gpu runs Chromium on this
// computer's GPU, closer to a phone (use it with --mode=raf or js: reading pixels back can move a canvas off the GPU).
let pw; try { pw = require('playwright'); } catch (e) { pw = require('/opt/node22/lib/node_modules/playwright'); }
const fs = require('fs'), os = require('os'), path = require('path');
(async () => {
  const args = process.argv.slice(2), flags = args.filter(a => a.startsWith('--')), [song, span, slow, lab, site] = args.filter(a => !a.startsWith('--'));
  const mode = (flags.find(a => a.startsWith('--mode=')) || '--mode=paint').slice(7), gpu = flags.includes('--gpu');
  const [from, to, step] = (span || '20,80,0.2').split(',').map(Number);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'pitchscape-'));
  const exe = fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined;
  const ctx = await pw.chromium.launchPersistentContext(profile, { executablePath: exe, ...(gpu ? { channel: 'chromium', args: ['--enable-gpu', '--ignore-gpu-blocklist'] } : {}), viewport: { width: 390, height: 750 }, deviceScaleFactor: 2 });
  const p = ctx.pages()[0] || await ctx.newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message));
  const url = (site || 'http://localhost:8010/') + '?bench';
  await p.goto(url);
  await p.evaluate((lab) => { localStorage.setItem('pitchscape:key', JSON.stringify('test')); localStorage.setItem('pitchscape:lab', JSON.stringify({ v: 2, set: lab ? JSON.parse(lab) : {} })); }, lab || '');
  await p.reload(); await p.waitForTimeout(1200);
  await p.setInputFiles('#file', song);
  for (let i = 0; i < 240; i++) {
    if (await p.evaluate(() => !document.getElementById('play').disabled)) break;
    await p.waitForTimeout(250);
  }
  await p.waitForTimeout(400);
  const cdp = await ctx.newCDPSession(p);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: Number(slow || 4) });
  const times = []; for (let t = from; t <= to + 1e-9; t += step) times.push(+t.toFixed(3));
  await p.evaluate(([t, m]) => window.pitchscapeBench(t.slice(0, 20), m), [times, mode]); // warm up
  const r = await p.evaluate(([t, m]) => window.pitchscapeBench(t, m), [times, mode]);
  const rows = Object.entries(r).sort((a, b) => (a[0] === 'frame') - (b[0] === 'frame') || b[1].med - a[1].med);
  console.log(path.basename(song), '| lab', lab || '{}', '| cpu x' + (slow || 4), '|', mode, gpu ? 'on GPU' : 'software', '|', times.length, 'frames', errs.length ? '| errors: ' + errs.join(' | ') : '');
  for (const [k, v] of rows) console.log('  %s %s ms  (p95 %s)', k.padEnd(8), v.med.toFixed(2).padStart(7), v.p95.toFixed(2));
  await ctx.close(); fs.rmSync(profile, { recursive: true, force: true });
})();
