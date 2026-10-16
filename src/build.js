// Builds the page (src/page, with Vite and Svelte) into docs/: docs/index.html, docs/app/* and docs/pipeline/.
// The same as `npm run build`; `npm run dev` serves it with live reload. See vite.config.mjs.
import('vite').then(({build}) => build({configFile: require('path').join(__dirname, '..', 'vite.config.mjs'), logLevel: 'warn'}))
  .then(() => console.log('built docs/'), e => { console.error(e); process.exit(1); });
