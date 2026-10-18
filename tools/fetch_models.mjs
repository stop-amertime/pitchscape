// The models the pipeline runs under Node (server/local.py, tools/analyse_pack.mjs), from the published repository
// (https://huggingface.co/stopamertime/pitchscape-models) into models/, each checked against its SHA-256 in the
// manifest. Files already there and matching are kept; models/manifest.json gets the published entries merged in.
//   node tools/fetch_models.mjs [name ...]        (default: what an analysis under Node needs)
import {createHash} from 'node:crypto';
import {createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, createReadStream} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';

const REPO = 'https://huggingface.co/stopamertime/pitchscape-models/resolve/main/';
// rt.keeps is false under Node: the aligner's float32 file (the browser's is float16); keep in step with NODE_MODELS
// in server/modal_app.py
export const NODE_MODELS = ['vocals_mbr_f32', 'htdemucs_6s', 'adtof_frame_rnn', 'basic_pitch', 'crepe_full', 'align_en_f32'];
const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'models');

const sha256 = file => new Promise((res, rej) => {
  const h = createHash('sha256');
  createReadStream(file).on('data', d => h.update(d)).on('end', () => res(h.digest('hex'))).on('error', rej);
});

async function main(names) {
  mkdirSync(DIR, {recursive: true});
  const r = await fetch(REPO + 'manifest.json');
  if (!r.ok) throw new Error(`manifest.json: ${r.status}`);
  const published = await r.json();
  const local = existsSync(path.join(DIR, 'manifest.json')) ? JSON.parse(readFileSync(path.join(DIR, 'manifest.json'), 'utf8')) : {};
  for (const name of names) {
    const info = published[name];
    if (!info) throw new Error(`${name} is not in the published manifest`);
    const file = path.join(DIR, info.file);
    if (existsSync(file) && await sha256(file) === info.sha256) { local[name] = info; continue; }
    process.stdout.write(`fetching ${info.file} (${Math.round(info.bytes / 1e6)} MB)\n`);
    const res = await fetch(REPO + info.file);
    if (!res.ok) throw new Error(`${info.file}: ${res.status}`);
    await pipeline(Readable.fromWeb(res.body), createWriteStream(file + '.part'));
    if (await sha256(file + '.part') !== info.sha256) throw new Error(`${info.file}: the download does not match its SHA-256`);
    renameSync(file + '.part', file);
    local[name] = info;
  }
  writeFileSync(path.join(DIR, 'manifest.json'), JSON.stringify(local, null, 1));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const names = process.argv.slice(2);
  main(names.length ? names : NODE_MODELS).catch(e => { console.error(String(e.message || e)); process.exit(1); });
}
