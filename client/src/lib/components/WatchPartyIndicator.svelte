<script lang="ts">
  import { watchParty } from '$lib/watchParty.svelte';
  import Icon from './Icon.svelte';

  let { onResyncSelf, onOpenDetails } = $props<{ onResyncSelf: () => void; onOpenDetails: () => void }>();

  // Guests see their own drift, the host sees how many guests have fallen out of sync.
  const guestOutOfSync = $derived(!watchParty.isHost && watchParty.outOfSync);
  const hostOutOfSync = $derived(watchParty.isHost && watchParty.outOfSyncCount > 0);
  const alerting = $derived(guestOutOfSync || hostOutOfSync);

  const driftLabel = $derived.by(() => {
    if (watchParty.videoMismatch) {
      return 'Anderes Video';
    }

    const drift = watchParty.drift;

    if (drift == null) {
      return '';
    }

    const seconds = Math.round(Math.abs(drift));

    return drift < 0 ? `${seconds} s hinterher` : `${seconds} s voraus`;
  });
</script>

{#if watchParty.active}
  <div class="party-indicator" class:alerting>
    <button type="button" class="party-chip" title={watchParty.isHost ? 'Watch-Party verwalten' : 'Watch-Party'} onclick={onOpenDetails}>
      <Icon icon={watchParty.connected ? 'people-fill' : 'wifi-off'} size="sm" />
      <span>{watchParty.memberCount}</span>
    </button>

    {#if guestOutOfSync}
      <button type="button" class="party-action" onclick={onResyncSelf} title="Zur Position des Hosts springen">
        <Icon icon={watchParty.videoMismatch ? 'exclamation-triangle-fill' : 'arrow-repeat'} size="sm" />
        <span>{driftLabel}</span>
      </button>
    {:else if hostOutOfSync}
      <button type="button" class="party-action" onclick={() => watchParty.resyncAll()} title="Alle Teilnehmer zu deiner Position springen lassen">
        <Icon icon="arrow-repeat" size="sm" />
        <span>{watchParty.outOfSyncCount} nicht synchron</span>
      </button>
    {/if}
  </div>
{/if}

<style>
  @reference "../../app.css";

  .party-indicator {
    @apply pointer-events-auto flex items-center gap-1 rounded-full bg-black/50 p-1 text-xs text-white/70 backdrop-blur-sm transition-colors;
  }

  .party-indicator.alerting {
    @apply bg-amber-500/90 text-white;
  }

  .party-chip {
    @apply inline-flex cursor-pointer items-center gap-1.5 rounded-full px-2 py-1 tabular-nums transition-opacity hover:text-white;
  }

  .party-action {
    @apply inline-flex cursor-pointer items-center gap-1.5 rounded-full bg-white/20 px-2 py-1 font-medium whitespace-nowrap text-white hover:bg-white/30;
  }
</style>
