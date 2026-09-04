<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import videojs from 'video.js';
  import type Player from 'video.js/dist/types/player';

  import type { VideoPayload } from '$lib/types';
  import { trackEvent, withBase } from '$lib/utils';
  import { DRIFT_THRESHOLD_SECONDS, videoPayloadToPartyVideo, watchParty } from '$lib/watchParty.svelte';
  import ChannelTag from './ChannelTag.svelte';
  import Icon from './Icon.svelte';
  import WatchPartyIndicator from './WatchPartyIndicator.svelte';

  let { videoPayload, onClose, onOpenParty } = $props<{ videoPayload: VideoPayload | null; onClose: () => void; onOpenParty: () => void }>();

  const CAPTIONS_STORAGE_KEY = 'captionsEnabled';
  const VOLUME_STORAGE_KEY = 'playerVolume';
  const MUTED_STORAGE_KEY = 'playerMuted';

  let dialog: HTMLDialogElement;
  let videoElement = $state<HTMLVideoElement>();
  let player: Player | null = null;
  let playStartTimestamp = 0;

  /**
   * Set while a remote state is being applied, so the resulting play/pause/seeked events are not
   * echoed straight back to the server as if the local user had caused them.
   */
  let applyingRemoteUntil = 0;

  function isApplyingRemote(): boolean {
    return Date.now() < applyingRemoteUntil;
  }

  /** Publishes this client's playback as the party's authoritative state. Hosts only. */
  function publishHostState() {
    if (!player || player.isDisposed() || !videoPayload || !watchParty.isHost || isApplyingRemote()) {
      return;
    }

    watchParty.publishHostState(videoPayloadToPartyVideo(videoPayload), Number(player.currentTime()) || 0, player.paused());
  }

  /**
   * Becoming the host of a party the player is already open on has no playback event to ride on,
   * so publish as soon as the role is known. Guests take the opposite path and ask to be placed
   * on the host's position.
   */
  $effect(() => {
    if (!watchParty.connected || !videoPayload) {
      return;
    }

    if (watchParty.isHost) {
      publishHostState();
    } else if (watchParty.active) {
      watchParty.requestResync();
    }
  });

  function readCaptionsPreference(): boolean {
    try {
      return localStorage.getItem(CAPTIONS_STORAGE_KEY) === 'true';
    } catch {
      return false;
    }
  }

  function writeCaptionsPreference(enabled: boolean): void {
    try {
      localStorage.setItem(CAPTIONS_STORAGE_KEY, String(enabled));
    } catch {
      /* ignore */
    }
  }

  function readVolumePreference(): { volume: number; muted: boolean } | null {
    try {
      const stored = localStorage.getItem(VOLUME_STORAGE_KEY);

      if (stored == null) {
        return null;
      }

      const volume = Number(stored);

      if (!Number.isFinite(volume)) {
        return null;
      }

      return { volume: Math.min(1, Math.max(0, volume)), muted: localStorage.getItem(MUTED_STORAGE_KEY) === 'true' };
    } catch {
      return null;
    }
  }

  function writeVolumePreference(volume: number, muted: boolean): void {
    try {
      localStorage.setItem(VOLUME_STORAGE_KEY, String(volume));
      localStorage.setItem(MUTED_STORAGE_KEY, String(muted));
    } catch {
      /* ignore */
    }
  }

  $effect(() => {
    if (videoPayload && dialog && !dialog.open) {
      dialog.showModal();
      playStartTimestamp = Date.now();
    }
  });

  onMount(() => {
    function handleKeydown(e: KeyboardEvent) {
      // Only act when the video dialog is open and a video is present.
      if (!dialog.open || !player || player.isDisposed()) {
        return;
      }

      // Do not trigger hotkeys if Ctrl, Alt or Meta keys are pressed, to avoid conflicts with browser shortcuts.
      if (e.altKey || e.ctrlKey || e.metaKey) {
        return;
      }

      const target = e.target as HTMLElement;
      // Prevent shortcuts when a text input field is focused.
      if (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) {
        return;
      }

      // Handle number keys 0-9 for jumping to a percentage of the video
      if (e.key >= '0' && e.key <= '9') {
        e.preventDefault();

        const percentage = parseInt(e.key) / 10;
        const duration = Number(player.duration());

        if (!Number.isNaN(duration)) {
          player.currentTime(duration * percentage);
        }

        return;
      }

      const key = e.key.toLowerCase();
      switch (key) {
        case ' ':
          e.preventDefault();
          player.paused() ? player.play() : player.pause();
          break;

        case 'arrowleft': {
          e.preventDefault();

          const currentTime = Number(player.currentTime());

          if (!Number.isNaN(currentTime)) {
            player.currentTime(currentTime - 10);
          }

          break;
        }

        case 'arrowright': {
          e.preventDefault();

          const currentTime = Number(player.currentTime());

          if (!Number.isNaN(currentTime)) {
            player.currentTime(currentTime + 10);
          }

          break;
        }

        case 'arrowup': {
          e.preventDefault();

          const currentVolume = Number(player.volume());

          if (!Number.isNaN(currentVolume)) {
            player.volume(Math.min(1, currentVolume + 0.1));
          }

          break;
        }

        case 'arrowdown': {
          e.preventDefault();

          const currentVolume = Number(player.volume());

          if (!Number.isNaN(currentVolume)) {
            player.volume(Math.max(0, currentVolume - 0.1));
          }

          break;
        }

        case 'm': {
          player.muted(!player.muted());
          break;
        }

        case 'f': {
          player.isFullscreen() ? player.exitFullscreen() : player.requestFullscreen();
          break;
        }
      }
    }

    window.addEventListener('keydown', handleKeydown);

    dialog.addEventListener('close', () => {
      const playDuration = Date.now() - playStartTimestamp;

      if (playDuration >= 3000) {
        trackEvent('Close Video', { playDuration: Math.floor(playDuration / 1000) });
      }

      // The ad refresh must not fire during a party - it would restart the video for this client.
      if (playDuration >= 30000 && !watchParty.active) {
        location.reload();
      }
      onClose();
    });

    dialog.addEventListener('cancel', (e) => {
      if (player?.isFullscreen()) {
        e.preventDefault();
        player.exitFullscreen();
      }
    });

    return () => {
      window.removeEventListener('keydown', handleKeydown);
    };
  });

  $effect(() => {
    if (videoPayload && videoElement) {
      const payload = videoPayload as VideoPayload;

      // A party never starts on its own: the host presses play once everyone is there, and a guest
      // is placed on the host's position by the first state that arrives. `starting` covers the
      // host, whose party is still being created while this player opens. Untracked, so a party
      // beginning or ending never rebuilds the player mid-video.
      const inParty = untrack(() => watchParty.active || watchParty.starting);

      const p = videojs(videoElement, {
        controls: true,
        preload: 'auto',
        fluid: true,
        autoplay: !inParty,
        enableSmoothSeeking: true,
        skipButtons: true,
      });

      player = p;

      p.src({ src: payload.url, type: payload.url.endsWith('m3u8') ? 'application/x-mpegURL' : undefined });

      // --- volume ---------------------------------------------------------------------------
      // Like captions, the volume the user last settled on carries to the next video and the next visit.
      const storedVolume = readVolumePreference();

      if (storedVolume) {
        p.volume(storedVolume.volume);
        p.muted(storedVolume.muted);
      }

      p.on('volumechange', () => writeVolumePreference(Number(p.volume()) || 0, p.muted() === true));

      // --- captions -------------------------------------------------------------------------
      // Captions stay off unless the user asked for them, and that choice carries to the next video.
      const textTracks = p.textTracks();

      // The list is index accessible at runtime, but its type carries no index signature.
      function captionTracks(): TextTrack[] {
        const list = textTracks as unknown as { length: number; [index: number]: TextTrack };
        const tracks: TextTrack[] = [];

        for (let index = 0; index < list.length; index++) {
          const track = list[index];

          if (track && (track.kind === 'captions' || track.kind === 'subtitles')) {
            tracks.push(track);
          }
        }

        return tracks;
      }

      function applyCaptionsPreference() {
        const enabled = readCaptionsPreference();

        for (const track of captionTracks()) {
          track.mode = enabled ? 'showing' : 'disabled';
        }
      }

      function persistCaptionsPreference() {
        writeCaptionsPreference(captionTracks().some((track) => track.mode === 'showing'));
      }

      p.one('loadedmetadata', applyCaptionsPreference);
      textTracks.addEventListener('addtrack', applyCaptionsPreference);
      textTracks.addEventListener('change', persistCaptionsPreference);

      // --- watch party sync -----------------------------------------------------------------
      p.on('play', publishHostState);
      p.on('pause', publishHostState);
      p.on('seeked', publishHostState);

      // A freshly loaded source is either the host announcing it or a guest asking where to be.
      p.one('loadedmetadata', () => {
        if (watchParty.isHost) {
          publishHostState();
        } else if (watchParty.active) {
          watchParty.requestResync();
        }
      });

      const unbindParty = watchParty.bindPlayer({
        readPlayback: () => ({ position: Number(p.currentTime()) || 0, paused: p.paused(), videoId: payload.id }),
        applyState: ({ video, position, paused, hard }) => {
          // A different episode is handled by the parent, which swaps `videoPayload` and rebuilds
          // this player; nothing to apply against the current source.
          if (video && video.url !== payload.url) {
            return;
          }

          if (p.isDisposed()) {
            return;
          }

          const currentTime = Number(p.currentTime()) || 0;

          // Only seek on a real divergence, otherwise every host tick would jitter the playhead.
          if (hard || Math.abs(currentTime - position) > DRIFT_THRESHOLD_SECONDS) {
            applyingRemoteUntil = Date.now() + 500;
            p.currentTime(position);
          }

          if (paused !== p.paused()) {
            applyingRemoteUntil = Date.now() + 500;
            paused ? p.pause() : void p.play()?.catch(() => undefined);
          }
        },
      });

      return () => {
        unbindParty();
        textTracks.removeEventListener('addtrack', applyCaptionsPreference);
        textTracks.removeEventListener('change', persistCaptionsPreference);

        if (p && !p.isDisposed()) {
          p.dispose();
        }

        player = null;
      };
    }
  });

  /** Guests use this to jump to the host's position from the drift indicator. */
  function resyncSelf() {
    watchParty.requestResync();
  }
</script>

<dialog bind:this={dialog} class="px-[4vw] bg-transparent max-w-none max-h-none w-full h-full backdrop:bg-black/85">
  <div class="absolute top-8 right-8 z-10 flex items-center gap-4">
    <WatchPartyIndicator onResyncSelf={resyncSelf} onOpenDetails={onOpenParty} />

    <button type="button" aria-label="Player schließen" onclick={() => dialog.close()} class="text-white cursor-pointer opacity-70 hover:opacity-100 transition-opacity">
      <Icon icon="x-lg" size="3xl" />
    </button>
  </div>

  {#if videoPayload}
    <div class="max-w-[calc(3/5*100%+6rem)] h-full m-auto py-12 space-y-8">
      <div>
        <ChannelTag href={videoPayload.url_website} target="_blank" rel="noopener noreferrer" channel={videoPayload.channel} class="text-base!" />
        <div class="mt-4 text-gray-50/80">{videoPayload.topic}</div>
        <div class="text-lg font-semibold">{videoPayload.title}</div>
      </div>

      <!-- key={videoPayload.url} ensures the video element is re-created when the source changes -->
      {#key videoPayload.url}
        <!-- svelte-ignore a11y_media_has_caption -->
        <video-js bind:this={videoElement} class="vjs-big-play-centered w-full rounded-lg overflow-clip">
          {#if videoPayload.id && videoPayload.url_subtitle}
            <!-- Served via /api/subtitle: broadcaster files are usually TTML, which browsers reject. -->
            <track kind="captions" src={withBase(`/api/subtitle?id=${encodeURIComponent(videoPayload.id)}`)} srclang="de" label="Untertitel" />
          {/if}
        </video-js>
      {/key}
    </div>
  {/if}
</dialog>
