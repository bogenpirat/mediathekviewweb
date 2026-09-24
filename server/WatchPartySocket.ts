import type http from 'node:http';

import { WebSocket, WebSocketServer } from 'ws';

import type { Member, PartyVideo, ServerMessage, WatchPartyRegistry } from './WatchPartyRegistry';

export const WATCH_PARTY_PATH = '/ws/party';

/** Inbound frames are tiny; anything larger is a client bug or an attack. */
const MAX_PAYLOAD_BYTES = 4096;

/** Clients tick at ~1Hz. This budget leaves ample headroom before a socket is dropped. */
const MAX_MESSAGES_PER_SECOND = 20;

const HEARTBEAT_INTERVAL_MS = 30 * 1000;

/** Close code sent when the party cannot be joined at all (unknown id, full, feature disabled). */
const CLOSE_CODE_REJECTED = 4004;

/** Close code sent when a live party ends underneath the client. */
const CLOSE_CODE_PARTY_CLOSED = 4000;

type Socket = WebSocket & { isAlive?: boolean, messageCredits?: number, creditsResetAt?: number };

function send(socket: WebSocket, message: ServerMessage): void {
  if (socket.readyState == WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

function isFiniteNumber(value: unknown): value is number {
  return (typeof value == 'number') && Number.isFinite(value);
}

/** Looks an entry up in the index by id; null when it does not exist. */
export type LookupEntry = (id: string) => Promise<Record<string, any> | null>;

type VideoQuality = 'HD' | 'SD' | 'LQ';

const urlFieldByQuality: Record<VideoQuality, string> = {
  HD: 'url_video_hd',
  SD: 'url_video',
  LQ: 'url_video_low'
};

function isVideoQuality(value: unknown): value is VideoQuality {
  return (typeof value == 'string') && Object.hasOwn(urlFieldByQuality, value);
}

function optionalText(value: unknown): string | undefined {
  return ((typeof value == 'string') && (value.length > 0)) ? value : undefined;
}

/**
 * Turns the host's `{ id, quality }` choice into the video guests are sent. Everything guests load
 * or render comes from the index, never from the host, so a host cannot point guests' players or
 * links at an address of its own choosing.
 */
async function resolveVideo(lookupEntry: LookupEntry, id: string, quality: VideoQuality): Promise<PartyVideo | null> {
  const entry = await lookupEntry(id);
  const url = entry?.[urlFieldByQuality[quality]];

  if ((typeof url != 'string') || (url.length == 0)) {
    return null;
  }

  return {
    id,
    channel: String(entry!['channel'] ?? ''),
    topic: String(entry!['topic'] ?? ''),
    title: String(entry!['title'] ?? ''),
    url,
    quality,
    url_website: optionalText(entry!['url_website']),
    url_subtitle: optionalText(entry!['url_subtitle'])
  };
}

/**
 * Parses the video part of a `host-state` message: null to clear the video, a video to switch to,
 * or undefined when the reference is malformed or unknown and the message must be dropped.
 */
async function parseHostVideo(registry: WatchPartyRegistry, lookupEntry: LookupEntry, member: Member, value: unknown): Promise<PartyVideo | null | undefined> {
  if (value == null) {
    return null;
  }

  if (typeof value != 'object') {
    return undefined;
  }

  const { id, quality } = value as Record<string, unknown>;

  if ((typeof id != 'string') || (id.length == 0) || (id.length > 100) || !isVideoQuality(quality)) {
    return undefined;
  }

  // Play, pause and seek all repeat the current video, so only a new episode needs the index.
  const current = registry.currentVideo(member);

  if ((current?.id == id) && (current.quality == quality)) {
    return current;
  }

  try {
    return (await resolveVideo(lookupEntry, id, quality)) ?? undefined;
  }
  catch (error) {
    console.error('watch party: failed to resolve video', error);
    return undefined;
  }
}

function withinRateLimit(socket: Socket): boolean {
  const now = Date.now();

  if ((socket.creditsResetAt == undefined) || (now >= socket.creditsResetAt)) {
    socket.creditsResetAt = now + 1000;
    socket.messageCredits = MAX_MESSAGES_PER_SECOND;
  }

  socket.messageCredits! -= 1;

  return socket.messageCredits! >= 0;
}

async function handleMessage(registry: WatchPartyRegistry, lookupEntry: LookupEntry, member: Member, raw: string): Promise<void> {
  let message: Record<string, unknown>;

  try {
    const parsed = JSON.parse(raw);

    if ((parsed == null) || (typeof parsed != 'object') || Array.isArray(parsed)) {
      return;
    }

    message = parsed as Record<string, unknown>;
  }
  catch {
    return;
  }

  switch (message['type']) {
    case 'tick': {
      if (!isFiniteNumber(message['position']) || (typeof message['paused'] != 'boolean')) {
        return;
      }

      const videoId = (typeof message['videoId'] == 'string') ? message['videoId'].slice(0, 100) : null;
      registry.tick(member, { position: message['position'], paused: message['paused'], videoId });

      return;
    }

    case 'host-state': {
      if (!isFiniteNumber(message['position']) || (typeof message['paused'] != 'boolean')) {
        return;
      }

      const video = await parseHostVideo(registry, lookupEntry, member, message['video']);

      if (video === undefined) {
        return;
      }

      registry.setHostState(member, { video, position: message['position'], paused: message['paused'] });

      return;
    }

    case 'resync-all':
      registry.resyncAll(member);
      return;

    case 'request-resync':
      registry.requestResync(member);
      return;

    case 'create-invite':
      registry.createInvite(member);
      return;

    case 'revoke-invites':
      registry.revokeInvites(member, (typeof message['token'] == 'string') ? message['token'] : undefined);
      return;

    case 'end-party':
      registry.closeByHost(member);
      return;

    default:
      return;
  }
}

/**
 * Attaches the watch party WebSocket endpoint to an existing HTTP server.
 *
 * `app.listen()` already returns an `http.Server`, so no restructuring of the Express setup is
 * needed - we just claim the upgrade requests for our own path and let everything else drop.
 */
export function attachWatchPartySocket(httpServer: http.Server, registry: WatchPartyRegistry, lookupEntry: LookupEntry): void {
  const webSocketServer = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD_BYTES });

  httpServer.on('upgrade', (request, socket, head) => {
    let requestUrl: URL;

    try {
      requestUrl = new URL(request.url ?? '', `http://${request.headers.host ?? 'localhost'}`);
    }
    catch {
      socket.destroy();
      return;
    }

    if (requestUrl.pathname != WATCH_PARTY_PATH) {
      socket.destroy();
      return;
    }

    webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
      const partyId = requestUrl.searchParams.get('party') ?? '';
      const credentials = {
        hostToken: requestUrl.searchParams.get('token') ?? undefined,
        inviteToken: requestUrl.searchParams.get('invite') ?? undefined,
        memberToken: requestUrl.searchParams.get('member') ?? undefined
      };

      // A `closed` message is always terminal, so the transport tears the socket down with it.
      const attachResult = registry.attach(partyId, (message) => {
        send(webSocket, message);

        if (message.type == 'closed') {
          webSocket.close(CLOSE_CODE_PARTY_CLOSED, message.reason);
        }
      }, credentials);

      if (attachResult.status == 'rejected') {
        send(webSocket, { type: 'closed', reason: attachResult.reason });
        webSocket.close(CLOSE_CODE_REJECTED, attachResult.reason);

        return;
      }

      const member = attachResult.member;
      const partySocket = webSocket as Socket;
      partySocket.isAlive = true;

      partySocket.on('pong', () => {
        partySocket.isAlive = true;
      });

      // Resolving a new video awaits the index, so messages are chained to keep their order: a
      // pause sent right after an episode change must not be overtaken by it.
      let processing = Promise.resolve();

      partySocket.on('message', (data) => {
        if (!withinRateLimit(partySocket)) {
          partySocket.close(CLOSE_CODE_PARTY_CLOSED, 'rate-limit');
          return;
        }

        const raw = data.toString();
        processing = processing.then(() => handleMessage(registry, lookupEntry, member, raw)).catch((error) => console.error('watch party: failed to handle message', error));
      });

      partySocket.on('close', () => registry.detach(member));

      partySocket.on('error', () => {
        registry.detach(member);
        partySocket.terminate();
      });
    });
  });

  const heartbeat = setInterval(() => {
    for (const client of webSocketServer.clients) {
      const partySocket = client as Socket;

      if (partySocket.isAlive === false) {
        partySocket.terminate();
        continue;
      }

      partySocket.isAlive = false;
      partySocket.ping();
    }
  }, HEARTBEAT_INTERVAL_MS);

  heartbeat.unref();

  httpServer.on('close', () => {
    clearInterval(heartbeat);
    webSocketServer.close();
  });
}
