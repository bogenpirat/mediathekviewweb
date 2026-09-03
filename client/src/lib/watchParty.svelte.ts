import type { PartyRole, PartyVideo, VideoPayload } from './types';
import { trackEvent, withBase } from './utils';

/** Clients further from the host than this are shown as out of sync. Matches the server value. */
export const DRIFT_THRESHOLD_SECONDS = 2;

/** How often every client reports its position. */
const TICK_INTERVAL_MS = 1000;

const RECONNECT_MIN_DELAY_MS = 1000;
const RECONNECT_MAX_DELAY_MS = 15000;

const HOST_TOKEN_STORAGE_PREFIX = 'watchPartyHostToken:';

export type PartyCloseReason = 'host-left' | 'superseded' | 'expired' | 'not-found' | 'full' | 'disabled';

const closeReasonMessages: Record<PartyCloseReason, string> = {
  'host-left': 'Der Host hat die Party beendet.',
  superseded: 'Die Party wurde durch eine neue Party ersetzt.',
  expired: 'Die Party ist abgelaufen.',
  'not-found': 'Diese Party existiert nicht mehr.',
  full: 'Diese Party ist voll.',
  disabled: 'Watch-Partys sind auf diesem Server deaktiviert.',
};

type ServerMessage =
  | { type: 'welcome'; clientId: string; role: PartyRole; memberCount: number; hostState: { video: PartyVideo | null; position: number; paused: boolean } | null }
  | { type: 'state'; video: PartyVideo | null; position: number; paused: boolean }
  | { type: 'resync'; position: number; paused: boolean }
  | { type: 'drift'; drift: number | null; videoMismatch: boolean }
  | { type: 'party-drift'; outOfSyncCount: number; maxDriftAbs: number }
  | { type: 'members'; count: number }
  | { type: 'closed'; reason: PartyCloseReason };

/** What the player must do when the host's state changes. */
export type ApplyStateHandler = (state: { video: PartyVideo | null; position: number; paused: boolean; hard: boolean }) => void;

function readHostToken(partyId: string): string | null {
  try {
    return sessionStorage.getItem(`${HOST_TOKEN_STORAGE_PREFIX}${partyId}`);
  } catch {
    return null;
  }
}

function writeHostToken(partyId: string, token: string): void {
  try {
    sessionStorage.setItem(`${HOST_TOKEN_STORAGE_PREFIX}${partyId}`, token);
  } catch {
    /* a party still works for this tab without persistence, it just cannot survive a reload */
  }
}

function clearHostToken(partyId: string): void {
  try {
    sessionStorage.removeItem(`${HOST_TOKEN_STORAGE_PREFIX}${partyId}`);
  } catch {
    /* ignore */
  }
}

function createWatchParty() {
  let partyId = $state<string | null>(null);
  let role = $state<PartyRole | null>(null);
  let connected = $state(false);
  let memberCount = $state(0);
  let drift = $state<number | null>(null);
  let videoMismatch = $state(false);
  let outOfSyncCount = $state(0);
  let notice = $state<string | null>(null);
  let starting = $state(false);

  let socket: WebSocket | null = null;
  let reconnectDelay = RECONNECT_MIN_DELAY_MS;
  let reconnectTimer: number | null = null;
  let tickTimer: number | null = null;

  /** Set by the player so the store can drive it, and cleared when the player goes away. */
  let applyState: ApplyStateHandler | null = null;
  let readPlayback: (() => { position: number; paused: boolean; videoId: string | null }) | null = null;

  /** The video the host is currently sharing, so a late-joining player knows what to open. */
  let hostVideo = $state<PartyVideo | null>(null);

  function send(message: Record<string, unknown>): void {
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message));
    }
  }

  function stopTicking(): void {
    if (tickTimer != null) {
      clearInterval(tickTimer);
      tickTimer = null;
    }
  }

  function startTicking(): void {
    stopTicking();

    tickTimer = window.setInterval(() => {
      const playback = readPlayback?.();

      if (playback) {
        send({ type: 'tick', position: playback.position, paused: playback.paused, videoId: playback.videoId });
      }
    }, TICK_INTERVAL_MS);
  }

  function handleMessage(message: ServerMessage): void {
    switch (message.type) {
      case 'welcome':
        role = message.role;
        memberCount = message.memberCount;
        hostVideo = message.hostState?.video ?? null;
        reconnectDelay = RECONNECT_MIN_DELAY_MS;
        break;

      case 'state':
        hostVideo = message.video;
        applyState?.({ video: message.video, position: message.position, paused: message.paused, hard: false });
        break;

      case 'resync':
        applyState?.({ video: hostVideo, position: message.position, paused: message.paused, hard: true });
        break;

      case 'drift':
        drift = message.drift;
        videoMismatch = message.videoMismatch;
        break;

      case 'party-drift':
        outOfSyncCount = message.outOfSyncCount;
        break;

      case 'members':
        memberCount = message.count;
        break;

      case 'closed':
        notice = closeReasonMessages[message.reason] ?? 'Die Party wurde beendet.';
        teardown({ keepNotice: true });
        break;
    }
  }

  function connect(id: string): void {
    disconnectSocket();

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const token = readHostToken(id);
    const query = new URLSearchParams({ party: id });

    if (token) {
      query.set('token', token);
    }

    const ws = new WebSocket(`${protocol}//${window.location.host}${withBase('/ws/party')}?${query.toString()}`);
    socket = ws;

    ws.addEventListener('open', () => {
      connected = true;
      startTicking();
    });

    ws.addEventListener('message', (event) => {
      try {
        handleMessage(JSON.parse(event.data) as ServerMessage);
      } catch {
        /* ignore malformed frames */
      }
    });

    ws.addEventListener('close', () => {
      if (socket !== ws) {
        return;
      }

      connected = false;
      stopTicking();

      // `closed` already tore the party down; anything else is a network blip worth retrying.
      if (partyId != null) {
        scheduleReconnect(id);
      }
    });

    ws.addEventListener('error', () => ws.close());
  }

  function scheduleReconnect(id: string): void {
    if (reconnectTimer != null) {
      return;
    }

    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = null;

      if (partyId === id) {
        connect(id);
      }
    }, reconnectDelay);

    reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_DELAY_MS);
  }

  function disconnectSocket(): void {
    stopTicking();

    if (reconnectTimer != null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }

    if (socket) {
      const closing = socket;
      socket = null;
      closing.close();
    }

    connected = false;
  }

  function teardown({ keepNotice }: { keepNotice: boolean }): void {
    if (partyId != null) {
      clearHostToken(partyId);
    }

    disconnectSocket();

    partyId = null;
    role = null;
    memberCount = 0;
    drift = null;
    videoMismatch = false;
    outOfSyncCount = 0;
    hostVideo = null;
    reconnectDelay = RECONNECT_MIN_DELAY_MS;

    if (!keepNotice) {
      notice = null;
    }
  }

  return {
    get partyId() {
      return partyId;
    },
    get active() {
      return partyId != null;
    },
    get isHost() {
      return role === 'host';
    },
    get role() {
      return role;
    },
    get connected() {
      return connected;
    },
    get memberCount() {
      return memberCount;
    },
    get drift() {
      return drift;
    },
    get videoMismatch() {
      return videoMismatch;
    },
    get outOfSync() {
      return videoMismatch || (drift != null && Math.abs(drift) > DRIFT_THRESHOLD_SECONDS);
    },
    get outOfSyncCount() {
      return outOfSyncCount;
    },
    get hostVideo() {
      return hostVideo;
    },
    get notice() {
      return notice;
    },
    get starting() {
      return starting;
    },
    get inviteUrl() {
      return partyId == null ? '' : `${window.location.origin}${withBase('/')}#party=${partyId}`;
    },

    dismissNotice() {
      notice = null;
    },

    /** Called by the player to register itself as the thing being synchronised. */
    bindPlayer(handlers: { applyState: ApplyStateHandler; readPlayback: () => { position: number; paused: boolean; videoId: string | null } }): () => void {
      applyState = handlers.applyState;
      readPlayback = handlers.readPlayback;

      return () => {
        if (applyState === handlers.applyState) {
          applyState = null;
          readPlayback = null;
        }
      };
    },

    async host(video: PartyVideo): Promise<boolean> {
      starting = true;
      notice = null;

      try {
        const response = await fetch(withBase('/api/party'), { method: 'POST' });
        const data = await response.json();

        if (!response.ok || data.party == null) {
          notice = data?.error ?? 'Party konnte nicht gestartet werden.';
          return false;
        }

        teardown({ keepNotice: false });

        writeHostToken(data.party.partyId, data.party.hostToken);
        partyId = data.party.partyId;
        role = 'host';
        connect(data.party.partyId);

        trackEvent('Watch Party Host', { channel: video.channel, topic: video.topic, title: video.title });

        return true;
      } catch (error) {
        notice = 'Party konnte nicht gestartet werden.';
        console.error('Failed to start watch party', error);

        return false;
      } finally {
        starting = false;
      }
    },

    async join(id: string): Promise<boolean> {
      notice = null;

      try {
        const response = await fetch(withBase(`/api/party/${encodeURIComponent(id)}`));
        const data = await response.json();

        if (!response.ok || !data.exists) {
          notice = closeReasonMessages['not-found'];
          return false;
        }
      } catch (error) {
        notice = 'Party konnte nicht erreicht werden.';
        console.error('Failed to look up watch party', error);

        return false;
      }

      teardown({ keepNotice: false });

      partyId = id;
      role = 'guest';
      connect(id);

      trackEvent('Watch Party Join');

      return true;
    },

    /** Host only: publish the authoritative state after a play, pause, seek or episode change. */
    publishHostState(video: PartyVideo | null, position: number, paused: boolean): void {
      if (role !== 'host') {
        return;
      }

      send({ type: 'host-state', video, position, paused });
    },

    /** Guest only: ask the server to put this client back onto the host's position. */
    requestResync(): void {
      if (role === 'guest') {
        send({ type: 'request-resync' });
      }
    },

    /** Host only: make every guest jump to the host's position. */
    resyncAll(): void {
      if (role === 'host') {
        send({ type: 'resync-all' });
        trackEvent('Watch Party Resync');
      }
    },

    leave(): void {
      if (role === 'host') {
        send({ type: 'end-party' });
      }

      teardown({ keepNotice: false });
    },
  };
}

export function videoPayloadToPartyVideo(payload: VideoPayload): PartyVideo {
  return {
    id: payload.id,
    channel: payload.channel,
    topic: payload.topic,
    title: payload.title,
    url: payload.url,
    quality: payload.quality,
    url_website: payload.url_website,
    url_subtitle: payload.url_subtitle,
  };
}

export function partyVideoToVideoPayload(video: PartyVideo): VideoPayload {
  return {
    id: video.id,
    channel: video.channel,
    topic: video.topic,
    title: video.title,
    url: video.url,
    quality: (video.quality as VideoPayload['quality']) ?? 'SD',
    url_website: video.url_website,
    url_subtitle: video.url_subtitle,
  };
}

export const watchParty = createWatchParty();
