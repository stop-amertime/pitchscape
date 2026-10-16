// The page (src/page) built by Vite into docs/, which GitHub Pages serves: docs/index.html and docs/app/*.
// src/pipeline (the analysis the page runs on this computer) is copied beside it as plain files, since its Workers
// load it by URL; in dev it is served from src/pipeline as is.
import {defineConfig} from 'vite';
import {svelte, vitePreprocess} from '@sveltejs/vite-plugin-svelte';
import Icons from 'unplugin-icons/vite';
import fs from 'node:fs';
import path from 'node:path';

const root = import.meta.dirname, docs = path.join(root, 'docs');

const pipeline = {
  name: 'pitchscape-pipeline',
  configureServer(server) {
    server.middlewares.use('/pipeline', (req, res, next) => {
      const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '');
      const f = path.join(root, 'src', 'pipeline', rel);
      if (rel.includes('..') || !fs.existsSync(f) || !fs.statSync(f).isFile()) return next();
      res.setHeader('Content-Type', /\.m?js$/.test(f) ? 'text/javascript' : /\.wasm$/.test(f) ? 'application/wasm' : 'application/octet-stream');
      fs.createReadStream(f).pipe(res);
    });
  },
  buildStart() { fs.rmSync(path.join(docs, 'app'), {recursive: true, force: true}); },
  closeBundle() {
    const out = path.join(docs, 'pipeline');
    fs.rmSync(out, {recursive: true, force: true});
    fs.cpSync(path.join(root, 'src', 'pipeline'), out, {recursive: true, filter: f => !/runtime\.node\.mjs$/.test(f)});
  },
};

export default defineConfig({
  root: path.join(root, 'src', 'page'),
  base: './',
  plugins: [svelte({preprocess: vitePreprocess()}), Icons({compiler: 'svelte'}), pipeline],
  build: {outDir: docs, emptyOutDir: false, assetsDir: 'app'},
  server: {fs: {allow: [root]}},
});
