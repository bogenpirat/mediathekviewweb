<script lang="ts">
  import { watchParty } from '$lib/watchParty.svelte';
  import Button from './Button.svelte';
  import Dialog from './Dialog.svelte';
  import Icon from './Icon.svelte';

  let dialog = $state<Dialog>();
  let copyStatus = $state<'idle' | 'copied' | 'error'>('idle');
  let copyResetTimer: number | null = null;

  export function show() {
    dialog?.show();
  }

  export function close() {
    dialog?.close();
  }

  async function copyInviteUrl() {
    try {
      await navigator.clipboard.writeText(watchParty.inviteUrl);
      copyStatus = 'copied';
    } catch (error) {
      console.error('Failed to copy invite link', error);
      copyStatus = 'error';
    }

    if (copyResetTimer != null) {
      clearTimeout(copyResetTimer);
    }

    copyResetTimer = window.setTimeout(() => (copyStatus = 'idle'), 2000);
  }

  function leave() {
    watchParty.leave();
    dialog?.close();
  }
</script>

<Dialog bind:this={dialog} title="Watch-Party" icon="people-fill" closeOnClickOutside>
  {#if watchParty.active}
    <div class="space-y-6">
      <p class="text-sm text-gray-600 dark:text-gray-300">
        {#if watchParty.isHost}
          Teile diesen Link. Alle Teilnehmer folgen automatisch deinem Video, deiner Wiedergabe und deiner Position.
        {:else}
          Du bist Gast in dieser Party. Dein Player folgt automatisch dem Host.
        {/if}
      </p>

      {#if watchParty.isHost}
        <div class="flex gap-2">
          <input type="text" readonly value={watchParty.inviteUrl} class="min-w-0 flex-1 rounded-md border border-gray-300 bg-gray-50 px-3 py-2 font-mono text-sm dark:border-gray-600 dark:bg-gray-900" onfocus={(e) => e.currentTarget.select()} aria-label="Einladungslink" />
          <Button variant={copyStatus === 'copied' ? 'success' : 'secondary'} onclick={copyInviteUrl} title="Einladungslink kopieren">
            {#if copyStatus === 'idle'}
              <Icon icon="link-45deg" />
            {:else if copyStatus === 'copied'}
              <Icon icon="check-lg" />
            {:else}
              <Icon icon="x-lg" />
            {/if}
          </Button>
        </div>
      {/if}

      <dl class="grid grid-cols-2 gap-4 text-sm">
        <div>
          <dt class="text-gray-500 dark:text-gray-400">Teilnehmer</dt>
          <dd class="text-lg font-semibold tabular-nums">{watchParty.memberCount}</dd>
        </div>
        <div>
          <dt class="text-gray-500 dark:text-gray-400">Status</dt>
          <dd class="text-lg font-semibold">
            {#if !watchParty.connected}
              Verbinde…
            {:else if watchParty.isHost}
              {watchParty.outOfSyncCount === 0 ? 'Alle synchron' : `${watchParty.outOfSyncCount} nicht synchron`}
            {:else}
              {watchParty.outOfSync ? 'Nicht synchron' : 'Synchron'}
            {/if}
          </dd>
        </div>
      </dl>

      <div class="flex flex-wrap gap-2">
        {#if watchParty.isHost && watchParty.outOfSyncCount > 0}
          <Button variant="secondary" onclick={() => watchParty.resyncAll()}>
            <Icon icon="arrow-repeat" class="mr-2" /> Alle synchronisieren
          </Button>
        {/if}
        <Button variant="secondary" onclick={leave}>
          <Icon icon="box-arrow-right" class="mr-2" />
          {watchParty.isHost ? 'Party beenden' : 'Party verlassen'}
        </Button>
      </div>
    </div>
  {:else}
    <p class="text-sm text-gray-600 dark:text-gray-300">
      {watchParty.notice ?? 'Es läuft gerade keine Watch-Party.'}
    </p>
  {/if}
</Dialog>
