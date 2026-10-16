<!-- Where songs are analysed: this computer (its graphics card, read by the page) or the server, which asks for its
     key when chosen. On the splash and in the Lab. -->
<script>
  import {slide} from 'svelte/transition';
  import {ui, api} from './ui.svelte.js';
  import {motion} from './motion.js';
  import Monitor from '~icons/lucide/monitor';
  import Cloud from '~icons/lucide/cloud';
  import KeyRound from '~icons/lucide/key-round';

  let {withKey = false, id = 'where'} = $props();
  let editing = $state(false), draft = $state(''), keyEl = $state();

  const h = $derived(ui.here);
  const kit = $derived([h.gpu, h.cores ? `${h.cores} cores` : '', h.mem ? (h.mem >= 8 ? '8 GB+' : `${h.mem} GB`) : ''].filter(Boolean).join(' · '));
  const hereSub = $derived(!h.done ? 'Checking…' : !h.ok ? h.why : h.small ? 'Slow on a phone: use the server' : kit);
  const hereOff = $derived(h.done && (!h.ok || h.small));
  const serverSub = $derived(ui.local ? 'This machine' : ui.hasKey ? 'Key saved' : 'Needs a key');
  const showKey = $derived(withKey && !ui.local && ui.where === 'server');

  // a song waiting for the key: open the field and put the cursor in it
  $effect(() => { if (ui.askKey && withKey) { editing = true; queueMicrotask(() => keyEl?.focus()); } });

  function save() { api.setKey(draft.trim()); editing = false; }
  function change() { draft = ''; editing = true; queueMicrotask(() => keyEl?.focus()); }
</script>

<div class="where">
  <h2 class="eyebrow" id="{id}-h">Where songs are analysed</h2>
  <div class="cards" role="group" aria-labelledby="{id}-h">
    <button type="button" class="card" class:off={hereOff} aria-pressed={ui.where === 'here'} onclick={() => api.setWhere('here')}>
      <Monitor class="ic" aria-hidden="true" />
      <span class="t">This computer</span>
      <span class="s">{hereSub}</span>
      <i class="dot" aria-hidden="true"></i>
    </button>
    <button type="button" class="card" aria-pressed={ui.where === 'server'} onclick={() => api.setWhere('server')}>
      <Cloud class="ic" aria-hidden="true" />
      <span class="t">The server</span>
      <span class="s">{serverSub}</span>
      <i class="dot" aria-hidden="true"></i>
    </button>
  </div>
  {#if showKey}
    <div class="key" transition:slide={{duration: motion(180)}}>
      <KeyRound class="ic" aria-hidden="true" />
      {#if ui.hasKey && !editing}
        <span class="saved">Server key saved <button type="button" class="change" onclick={change}>Change</button></span>
      {:else}
        <form onsubmit={e => { e.preventDefault(); save(); }}>
          <input bind:this={keyEl} bind:value={draft} type="password" autocomplete="off" spellcheck="false" placeholder="Server key" aria-label="Server key" onchange={save} onblur={() => { if (ui.hasKey && !draft) editing = false; }}>
        </form>
      {/if}
    </div>
  {/if}
</div>

<style lang="scss">
  .where { display: grid; gap: 8px; }
  .eyebrow { margin: 6px 0 2px; }
  .cards { display: grid; gap: 8px; }

  .card {
    display: grid; grid-template-columns: auto minmax(0, 1fr) auto; column-gap: 12px; row-gap: 3px; align-items: center;
    min-height: 58px; padding: 10px 14px; box-sizing: border-box; text-align: left; color: var(--ink);
    background: var(--sheet); border: 1px solid var(--rule); border-radius: 10px; cursor: pointer;
    transition: transform 160ms ease, box-shadow 160ms ease, border-color 160ms ease;

    :global(.ic) { grid-row: 1 / span 2; width: 22px; height: 22px; color: var(--muted); }
    .t { font: 650 15px/1.15 var(--display); }
    .s { grid-column: 2; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 500 11px/1.25 var(--mono); letter-spacing: 0.02em; color: var(--muted); }
    .dot { grid-column: 3; grid-row: 1 / span 2; width: 16px; height: 16px; box-sizing: border-box; border: 1.5px solid var(--rule); border-radius: 50%; transition: border-width 160ms ease, border-color 160ms ease; }

    &:hover:not(:disabled) { border-color: var(--muted); }
    // the chosen one: inked, with its pink plate printed a little off register
    &[aria-pressed='true'] {
      border-color: var(--ink); box-shadow: 3px 3px 0 var(--pink); transform: translate(-1.5px, -1.5px);
      :global(.ic) { color: var(--blue); }
      .dot { border: 5px solid var(--blue); }
    }
    &:disabled { cursor: default; opacity: 0.55; }
    &.off .s { color: #B3262E; }
    &:focus-visible { outline: 2px solid var(--pink); outline-offset: 3px; }
  }

  .key {
    display: flex; align-items: center; gap: 10px; padding: 2px 14px 0; color: var(--muted);
    :global(.ic) { flex: none; width: 18px; height: 18px; }
    form { flex: 1; display: flex; }
    input { flex: 1; min-width: 0; min-height: 38px; padding: 0 10px; font: 400 14px var(--mono); color: var(--ink); background: var(--paper); border: 1px solid var(--rule); border-radius: 6px;
      &:focus-visible { outline: 2px solid var(--pink); outline-offset: 1px; } }
    .saved { font: 500 12px/1.3 var(--mono); color: var(--ink); }
    .change { margin-left: 6px; padding: 6px 2px; font: 600 13px/1 var(--display); color: var(--blue); background: none; border: 0; text-decoration: underline; text-underline-offset: 2px; cursor: pointer; }
  }

  @media (prefers-reduced-motion: reduce) {
    .card, .card .dot { transition: none; }
    .card[aria-pressed='true'] { transform: none; }
  }
</style>
