<!-- A song loading: the song, what is happening now, how far, and the analysis's steps (inked once started). -->
<script>
  import {fly, fade} from 'svelte/transition';
  import {ui} from './ui.svelte.js';
  import {motion} from './motion.js';
  import CircleDashed from '~icons/lucide/circle-dashed';
  import CircleCheck from '~icons/lucide/circle-check';
  import LoaderCircle from '~icons/lucide/loader-circle';

  const st = $derived(ui.status);
  const pct = $derived(st ? Math.round(st.p * 100) : 0);
</script>

{#if st}
  <div class="status" role="status" in:fly={{y: 12, duration: motion(260)}} out:fade={{duration: motion(160)}}>
    {#if st.song}<p class="song">{st.song}</p>{/if}
    {#key st.label}<p class="now" in:fly={{y: 6, duration: motion(220)}}>{st.label}</p>{/key}
    <div class="bar" role="progressbar" aria-label={st.label} aria-valuemin="0" aria-valuemax="100" aria-valuenow={pct}><i style:width="{pct}%"></i></div>
    <p class="meta"><span>{st.note}</span><span>{pct > 2 ? pct + '%' : ''}</span></p>
    {#if st.steps}
      <ol class="steps">
        {#each st.steps as s (s.k)}
          <li class={s.state}>
            {#if s.state === 'now'}<LoaderCircle class="ic spin" aria-hidden="true" />{:else if s.state}<CircleCheck class="ic" aria-hidden="true" />{:else}<CircleDashed class="ic" aria-hidden="true" />{/if}
            {s.label}
          </li>
        {/each}
      </ol>
    {/if}
  </div>
{/if}

<style lang="scss">
  .status {
    position: absolute; z-index: 1; left: 50%; top: 50%; width: min(360px, calc(100% - 32px)); box-sizing: border-box;
    translate: -50% -50%; padding: 18px 18px 16px;
    background: var(--sheet); border: 1px solid var(--ink); border-radius: 10px; box-shadow: 4px 4px 0 var(--pink);
  }
  p { margin: 0; }
  .song { font: 500 11px/1.3 var(--mono); letter-spacing: 0.06em; text-transform: uppercase; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .now { margin-top: 6px; font: 700 20px/1.2 var(--display); letter-spacing: -0.01em; text-wrap: balance; }

  // the bar: blue ink with a pink plate over it, a hair off register
  .bar {
    position: relative; height: 6px; margin-top: 14px; background: var(--rule); border-radius: 3px; overflow: hidden;
    i { position: relative; display: block; height: 100%; background: var(--blue); border-radius: 3px; transition: width 400ms cubic-bezier(.2, .7, .2, 1);
      &::after { content: ''; position: absolute; inset: 0; translate: 2px 0; background: var(--pink); mix-blend-mode: multiply; opacity: 0.7; border-radius: 3px; } }
  }
  .meta { display: flex; justify-content: space-between; gap: 12px; margin-top: 7px; min-height: 1.35em; font: 500 11.5px/1.35 var(--mono); color: var(--muted); font-variant-numeric: tabular-nums; }

  .steps {
    display: flex; flex-wrap: wrap; gap: 6px; margin: 14px 0 0; padding: 12px 0 0; border-top: 1px dashed var(--rule); list-style: none;
    li { display: inline-flex; align-items: center; gap: 5px; padding: 4px 8px 4px 6px; border: 1px solid var(--rule); border-radius: 12px; font: 500 11px/1 var(--mono); color: var(--muted);
      transition: color 200ms ease, background 200ms ease, border-color 200ms ease;
      :global(.ic) { width: 13px; height: 13px; }
      &.on { color: var(--ink); border-color: var(--ink); }
      &.now { color: var(--paper); background: var(--ink); border-color: var(--ink); } }
    :global(.spin) { animation: spin 1s linear infinite; }
  }
  @keyframes spin { to { rotate: 360deg; } }

  @media (prefers-reduced-motion: reduce) {
    .bar i, .steps li { transition: none; }
    .steps :global(.spin) { animation: none; }
  }
</style>
