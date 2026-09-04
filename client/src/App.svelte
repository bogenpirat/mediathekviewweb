<script lang="ts">
  import { setCastConsentProvider } from '$lib/cast';
  import CastConsentDialog from '$lib/components/CastConsentDialog.svelte';
  import ContactDialog from '$lib/components/ContactDialog.svelte';
  import CookieDialog from '$lib/components/CookieDialog.svelte';
  import Datenschutz from '$lib/components/Datenschutz.svelte';
  import Dialog from '$lib/components/Dialog.svelte';
  import DonateDialog from '$lib/components/DonateDialog.svelte';
  import Header from '$lib/components/Header.svelte';
  import HelpDialog from '$lib/components/HelpDialog.svelte';
  import Impressum from '$lib/components/Impressum.svelte';
  import ResultsContainer from '$lib/components/ResultsContainer.svelte';
  import RssFeedDialog from '$lib/components/RssFeedDialog.svelte';
  import SearchBar from '$lib/components/SearchBar.svelte';
  import VideoPlayer from '$lib/components/VideoPlayer.svelte';
  import WatchPartyDialog from '$lib/components/WatchPartyDialog.svelte';
  import { appState } from '$lib/store.svelte';
  import type { VideoPayload } from '$lib/types';
  import { initializeAnalytics, parseURIHash, trackEvent } from '$lib/utils';
  import { partyVideoToVideoPayload, watchParty } from '$lib/watchParty.svelte';
  import { onMount, untrack } from 'svelte';
  import { MediaQuery } from 'svelte/reactivity';

  let cookieDialog: CookieDialog;
  let contactDialog: ContactDialog;
  let donateDialog: DonateDialog;
  let helpDialog: HelpDialog;
  let rssFeedDialog: RssFeedDialog;
  let castConsentDialog: CastConsentDialog;
  let watchPartyDialog: WatchPartyDialog;
  let mainElement: HTMLElement;
  let legalDialog = $state<Dialog>();

  let videoToPlay = $state<VideoPayload | null>(null);
  let pageToView = $state<'datenschutz' | 'impressum' | null>(null);

  const prefersDark = new MediaQuery('(prefers-color-scheme: dark)');

  // The host owns which episode the party watches, so guests follow whatever video arrives.
  $effect(() => {
    const hostVideo = watchParty.hostVideo;

    if (!hostVideo || watchParty.isHost) {
      return;
    }

    if (untrack(() => videoToPlay?.url) !== hostVideo.url) {
      videoToPlay = partyVideoToVideoPayload(hostVideo);
    }
  });

  // Keep the party id in the URL hash so the invite link survives a reload and can be shared.
  $effect(() => {
    appState.partyId = watchParty.partyId ?? undefined;
  });

  async function hostParty(payload: VideoPayload) {
    // The party has to exist before the player mounts, otherwise the player does not yet know it
    // belongs to a party and starts playing on its own instead of waiting for the host.
    const hosting = await watchParty.host(payload);

    videoToPlay = payload;

    if (hosting) {
      watchPartyDialog.show();
    }
  }

  function closePlayer() {
    // Leaving the player means leaving the party: the host stops sharing, a guest stops following.
    if (watchParty.active) {
      watchParty.leave();
    }

    videoToPlay = null;
  }

  $effect(() => {
    document.documentElement.classList.toggle('dark', prefersDark.current);
  });

  $effect(() => {
    const mainClassList = document.querySelector('main')?.classList;
    const navContainerClassList = document.querySelector('#nav-container')?.classList;
    if (mainClassList && navContainerClassList) {
      const isList = appState.viewMode === 'list';
      mainClassList.toggle('max-w-screen-2xl', isList);
      mainClassList.toggle('max-w-7xl', !isList);
      navContainerClassList.toggle('max-w-screen-2xl', isList);
      navContainerClassList.toggle('max-w-7xl', !isList);
    }
  });

  $effect(() => {
    // Scroll to top when changing the pagination page.
    appState.currentPage;
    mainElement?.scrollIntoView({ behavior: 'instant' });
  });

  $effect(() => {
    if (pageToView) {
      legalDialog?.show();
    } else {
      legalDialog?.close();
    }
  });

  function showImpressum() {
    pageToView = 'impressum';
  }

  function showDatenschutz() {
    pageToView = 'datenschutz';
  }

  onMount(() => {
    // Remove the browser warning now that JS is running
    document.getElementById('browserWarning')?.remove();

    initializeAnalytics();

    // This now correctly starts the reactive effects and returns a cleanup function
    const destroyStore = appState.init();

    // An invite link lands here with #party=<id>; the player opens once the host's video arrives.
    // Read straight from the URL so this does not depend on effect ordering during mount.
    const hashParams = parseURIHash(window.location.hash);
    const inviteParty = hashParams['party'];

    if (inviteParty) {
      // The invite is single use, so it is spent on connect and then dropped from the URL by
      // the store's hash sync - leaving a used token in the address bar helps nobody.
      void watchParty.join(inviteParty, hashParams['invite']);
    }

    setCastConsentProvider(
      () =>
        new Promise((resolve) => {
          castConsentDialog.show((choice) => {
            trackEvent('Cast Consent', { consent: choice });
            resolve(choice);
          });
        }),
    );

    // Cookie consent
    try {
      const allowCookies = localStorage.getItem('allowCookies');
      const lastAsked = parseInt(localStorage.getItem('allowCookiesAsked') || '0', 10);
      // Re-ask for consent after 7 days if it was denied previously.
      if (allowCookies === 'true') {
        addAdSense();
      } else if (allowCookies !== 'false' || isNaN(lastAsked) || lastAsked < Date.now() - 7 * 24 * 60 * 60 * 1000) {
        cookieDialog.show();
      }
    } catch (e) {
      console.warn('Could not access localStorage. Ads will not be shown.', e);
    }

    // This function will be called when the component is unmounted
    return () => {
      destroyStore();
    };
  });

  function addAdSense() {
    const adsense = document.createElement('script');
    adsense.type = 'text/javascript';
    adsense.setAttribute('data-ad-client', 'ca-pub-2430783446079517');
    adsense.async = true;
    adsense.crossOrigin = 'anonymous';
    adsense.src = 'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js';
    document.head.appendChild(adsense);
  }

  function handleCookieConsent(accepted: boolean) {
    trackEvent('Cookie Consent', { consent: accepted ? 'accept' : 'deny' });
    try {
      localStorage.setItem('allowCookies', String(accepted));
      localStorage.setItem('allowCookiesAsked', Date.now().toString());
    } catch (e) {
      /* ignore */
    }

    cookieDialog.close();

    if (accepted) {
      addAdSense();
    }
  }
</script>

<svelte:head>
  <title>{videoToPlay ? `${videoToPlay.title} – MediathekViewWeb` : appState.query ? `${appState.query} – MediathekViewWeb` : 'MediathekViewWeb'}</title>
</svelte:head>

<div class:blur={!!videoToPlay}>
  <Header showContact={() => contactDialog.show()} showDonate={() => donateDialog.show()} showHelp={() => helpDialog.show()} {showImpressum} {showDatenschutz} />

  <main bind:this={mainElement} class="mx-auto py-6 px-4 sm:px-6 lg:px-8">
    <div>
      <SearchBar showHelp={() => helpDialog.show()} showRssFeed={() => rssFeedDialog.show()} />
      <ResultsContainer onPlayVideo={(payload) => (videoToPlay = payload)} onHostParty={hostParty} />
    </div>
  </main>
</div>

<VideoPlayer videoPayload={videoToPlay} onClose={closePlayer} onOpenParty={() => watchPartyDialog.show()} />
<WatchPartyDialog bind:this={watchPartyDialog} />
<CookieDialog bind:this={cookieDialog} onConsent={handleCookieConsent} {showImpressum} {showDatenschutz} />
<HelpDialog bind:this={helpDialog} />
<RssFeedDialog bind:this={rssFeedDialog} />
<CastConsentDialog bind:this={castConsentDialog} />
<ContactDialog bind:this={contactDialog} />
<DonateDialog bind:this={donateDialog} />

{#if pageToView}
  <Dialog bind:this={legalDialog} limitWidth={false} title={pageToView === 'impressum' ? 'Impressum' : 'Datenschutzerklärung'} icon={pageToView === 'impressum' ? 'person-lines-fill' : 'shield-shaded'} onclose={() => (pageToView = null)} class="max-w-4xl">
    <div class="max-h-[70vh] overflow-y-auto -mx-6 -my-8 md:-mx-8 p-6 md:p-8">
      {#if pageToView === 'impressum'}
        <Impressum />
      {:else if pageToView === 'datenschutz'}
        <Datenschutz />
      {/if}
    </div>
  </Dialog>
{/if}

<style>
  @reference "./app.css";

  .blur {
    filter: blur(3px) !important;
    transition: all 0.4s ease-in-out;
  }
</style>
