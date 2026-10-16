<!-- The splash: pick a song (a file, a link, or one of ours) and where it is analysed. It opens first, and again from
     Change song; picking a song starts it straight away. -->
<script>
  import {fade, fly} from 'svelte/transition';
  import {ui, api} from './ui.svelte.js';
  import {motion} from './motion.js';
  import Where from './Where.svelte';
  import Upload from '~icons/lucide/upload';
  import ArrowRight from '~icons/lucide/arrow-right';

  // freely licensed recordings, each tried and tested
  const SONGS = [
    {title: 'Dropping Out of School', by: 'Brad Sucks', url: 'https://archive.org/download/bs-out-of-it-remastered/01%20Dropping%20Out%20of%20School.mp3'},
    {title: 'Incoherent', by: 'Josh Woodward', url: 'https://archive.org/download/JoshWoodwardSelection/20-JoshWoodward-HereToday-01-Incoherent.mp3'},
    {title: 'Goldberg Variations: Aria', by: 'Kimiko Ishizaka', url: 'https://archive.org/download/OpenGoldbergVariations/Kimiko%20Ishizaka%20-%20J.S.%20Bach-%20-Open-%20Goldberg%20Variations%2C%20BWV%20988%20%28Piano%29%20-%2001%20Aria.mp3'},
    {title: 'Invincible', by: 'Gigatop Arthur', url: 'https://archive.org/download/jamendo-140090/01-1165390-Gigatop%20Arthur-Invincible.mp3'},
  ];

  let link = $state('');
  function open(e) {
    e.preventDefault();
    const v = link.trim();
    if (!/^https?:\/\/\S+$/i.test(v)) { api.say('Paste a link that starts with https://', true); return; }
    api.link(v);
  }

  // if tapping Upload opens nothing (some in-app viewers block file pickers), say so instead of failing silently
  let pickTimer = 0, pickLeft = false;
  function picking() {
    pickLeft = false; clearTimeout(pickTimer);
    pickTimer = setTimeout(() => { if (!pickLeft) api.say('No file picker? Open this page in your browser to load songs.', true); }, 2500);
  }
  function picked(e) {
    clearTimeout(pickTimer);
    const f = e.currentTarget.files?.[0];
    e.currentTarget.value = '';
    if (f) api.file(f);
  }
  $effect(() => {
    const left = () => { pickLeft = true; }, hid = () => { if (document.hidden) pickLeft = true; };
    addEventListener('blur', left); document.addEventListener('visibilitychange', hid);
    return () => { removeEventListener('blur', left); document.removeEventListener('visibilitychange', hid); };
  });

  const rise = i => ({y: 10, duration: motion(320), delay: motion(60 + i * 70)});
</script>

{#if ui.splash}
  <section class="splash" aria-labelledby="splashTitle" out:fade={{duration: motion(160)}}>
    <div class="in">
      <h1 class="title" id="splashTitle" data-text="Pitchscape" in:fly={rise(0)}>Pitchscape</h1>

      <div class="box pick" in:fly={rise(1)}>
        <label class="btn btn-primary upload">
          <Upload class="ic" aria-hidden="true" />Upload a song
          <input type="file" accept="audio/*,.mp3,.m4a,.aac,.wav,.ogg,.oga,.flac,.opus" onclick={picking} onchange={picked}>
        </label>
        <form class="link" onsubmit={open}>
          <input type="url" bind:value={link} inputmode="url" autocomplete="off" spellcheck="false" placeholder="or paste a link to an audio file" aria-label="Link to an audio file">
          <button class="btn go" type="submit" aria-label="Open the link"><ArrowRight class="ic" aria-hidden="true" /></button>
        </form>
      </div>

      <div class="box" in:fly={rise(2)}>
        <h2 class="eyebrow">Or try one of ours</h2>
        <div class="songs">
          <button class="song" type="button" onclick={() => api.demo()}>Demo song <span>made here</span></button>
          {#each SONGS as s}
            <button class="song" type="button" onclick={() => api.link(s.url, s.title)}>{s.title} <span>{s.by}</span></button>
          {/each}
        </div>
      </div>

      <div in:fly={rise(3)}><Where withKey id="where-splash" /></div>

      {#if ui.hasSong}
        <button class="btn btn-small btn-quiet back" type="button" onclick={() => api.back()}>Back to the song</button>
      {/if}
    </div>
  </section>
{/if}

<style lang="scss">
  .splash { position: fixed; z-index: 4; inset: 0; overflow-y: auto; overscroll-behavior: contain; background: var(--paper); }
  .in {
    box-sizing: border-box; max-width: 460px; min-height: 100%; margin: 0 auto; display: flex; flex-direction: column; gap: 14px;
    padding: max(28px, env(safe-area-inset-top, 0px)) max(16px, env(safe-area-inset-right, 0px)) max(18px, env(safe-area-inset-bottom, 0px)) max(16px, env(safe-area-inset-left, 0px));
  }
  .title { margin: 4px 0 6px; font-size: 44px !important; }

  .box { display: grid; gap: 10px; padding: 14px; background: var(--sheet); border: 1px solid var(--rule); border-radius: 10px;
    .eyebrow { margin: 0; } }

  .upload {
    overflow: hidden; justify-content: center; min-height: 50px; font-size: 15.5px; cursor: pointer;
    :global(.ic) { width: 19px; height: 19px; }
    input { position: absolute; inset: 0; width: 100%; height: 100%; opacity: 0; cursor: pointer; font-size: 100px; }
    &:has(input:focus-visible) { outline: 2px solid var(--pink); outline-offset: 2px; }
  }
  .link {
    display: flex; gap: 6px; margin: 0;
    input { flex: 1; min-width: 0; min-height: 42px; box-sizing: border-box; padding: 0 12px; font: 400 14.5px var(--display); color: var(--ink); background: var(--paper); border: 1px solid var(--rule); border-radius: 6px;
      &:focus-visible { outline: 2px solid var(--pink); outline-offset: 1px; } }
    .go { width: 42px; padding: 0; justify-content: center; border-width: 1px; border-color: var(--rule); :global(.ic) { width: 18px; height: 18px; } }
  }

  .songs { display: grid; }
  .song {
    display: flex; align-items: baseline; gap: 10px; min-height: 42px; padding: 9px 2px; box-sizing: border-box; text-align: left;
    background: none; border: 0; border-top: 1px solid var(--rule); color: var(--ink); cursor: pointer; font: 600 14.5px/1.25 var(--display);
    transition: color 120ms ease, padding 160ms ease;
    &:first-child { border-top: 0; }
    span { margin-left: auto; font: 500 11.5px/1.25 var(--mono); color: var(--muted); text-align: right; }
    &:hover { color: var(--blue); padding-left: 6px; }
    &:focus-visible { outline: 2px solid var(--pink); outline-offset: 2px; }
  }
  .back { align-self: flex-start; }

  @media (prefers-reduced-motion: reduce) { .song { transition: none; &:hover { padding-left: 2px; } } }
</style>
