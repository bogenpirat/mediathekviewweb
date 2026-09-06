<script lang="ts">
  import { watchParty } from '$lib/watchParty.svelte';
  import Button from './Button.svelte';
  import Dialog from './Dialog.svelte';
  import Icon from './Icon.svelte';

  let dialog = $state<Dialog>();
  let copiedToken = $state<string | null>(null);
  let copyFailedToken = $state<string | null>(null);
  let copyResetTimer: number | null = null;

  export function show() {
    dialog?.show();
  }

  export function close() {
    dialog?.close();
  }

  async function copyInvite(token: string) {
    try {
      await navigator.clipboard.writeText(watchParty.inviteUrl(token));
      copiedToken = token;
      copyFailedToken = null;
    } catch (error) {
      console.error('Failed to copy invite link', error);
      copyFailedToken = token;
      copiedToken = null;
    }

    if (copyResetTimer != null) {
      clearTimeout(copyResetTimer);
    }

    copyResetTimer = window.setTimeout(() => {
      copiedToken = null;
      copyFailedToken = null;
    }, 2000);
  }

  function leave() {
    watchParty.leave();
    dialog?.close();
  }
</script>

<Dialog bind:this={dialog} title="Watch-Party" icon="people-fill" closeOnClickOutside>
  {#if watchParty.active}
    <div class="space-y-6">
      {#if watchParty.isHost}
        <p class="text-sm text-gray-600 dark:text-gray-300">
          Jeder Link funktioniert <strong>genau einmal</strong>. Erstelle pro Gast einen eigenen Link — er wird hier nicht angezeigt, sondern nur kopiert, damit ihn niemand von deinem Bildschirm abliest.
        </p>

        <div class="space-y-2">
          {#each watchParty.invites as invite, index (invite.token)}
            <div class="flex items-center gap-2">
              {#if invite.claimed}
                <span class="flex min-w-0 flex-1 items-center gap-2 rounded-md bg-gray-100 px-3 py-2 text-sm text-gray-500 dark:bg-gray-900 dark:text-gray-400">
                  <Icon icon="link-45deg" /> Link {index + 1}
                </span>
                <span class="inline-flex items-center gap-1 text-sm whitespace-nowrap text-green-600 dark:text-green-500">
                  <Icon icon="person-check-fill" /> benutzt
                </span>
              {:else}
                <span class="flex min-w-0 flex-1 items-center gap-2 rounded-md border border-gray-300 bg-gray-50 px-3 py-2 text-sm text-gray-500 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-400">
                  <Icon icon="link-45deg" /> Link {index + 1}
                  <span class="truncate font-mono tracking-widest select-none" aria-hidden="true">••••••••••••</span>
                </span>
                <Button variant={copiedToken === invite.token ? 'success' : 'secondary'} onclick={() => copyInvite(invite.token)} title="Einladungslink kopieren">
                  {#if copiedToken === invite.token}
                    <Icon icon="check-lg" />
                  {:else if copyFailedToken === invite.token}
                    <Icon icon="x-lg" />
                  {:else}
                    <Icon icon="link-45deg" />
                  {/if}
                </Button>
                <Button variant="secondary" onclick={() => watchParty.revokeInvites(invite.token)} title="Diesen Link zurückziehen">
                  <Icon icon="trash3" />
                </Button>
              {/if}
            </div>
          {:else}
            <p class="text-sm text-gray-500 dark:text-gray-400">Noch kein Link erstellt.</p>
          {/each}
        </div>

        <div class="flex flex-wrap gap-2">
          <Button variant="secondary" onclick={() => watchParty.createInvite()}>
            <Icon icon="plus-lg" class="mr-2" /> Neuen Link erstellen
          </Button>
          {#if watchParty.unclaimedInvites.length > 0}
            <Button variant="secondary" onclick={() => watchParty.revokeInvites()} title="Alle noch nicht benutzten Links ungültig machen">
              <Icon icon="x-circle" class="mr-2" /> Unbenutzte zurückziehen
            </Button>
          {/if}
        </div>
      {:else}
        <p class="text-sm text-gray-600 dark:text-gray-300">Du bist Gast in dieser Party. Dein Player folgt automatisch dem Host.</p>
      {/if}

      <dl class="grid grid-cols-2 gap-4 border-t border-gray-200 pt-4 text-sm dark:border-gray-700">
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
