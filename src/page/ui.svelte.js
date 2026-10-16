// What the Svelte parts of the page show, set by the page's script (legacy.js), and what they can ask it to do (api,
// filled in by legacy.js when it starts).
export const ui = $state({
  splash: true,       // the splash (pick a song) is open
  hasSong: false,     // a song is open behind it, so it offers Back
  where: 'server',    // where songs are analysed: 'here' | 'server'
  local: false,       // the page is served by this computer's own server (no key)
  hasKey: false,      // a server key is saved on this device
  askKey: 0,          // counts up when a song waits for the key: the key field is shown and focused
  here: {done: false, ok: false, gpu: '', why: '', small: false, mem: 0, cores: 0, mb: 0},
  // a song loading: {label, p (0..1), note, song, steps: [{k, label, state: '' | 'on' | 'now'}] | null}, or null
  status: null,
});

/** file(f), link(url, title), demo(), back(), say(text, isErr), setWhere('here' | 'server'), setKey(text) */
export const api = {};
