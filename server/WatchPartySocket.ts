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

/**
 * Validates and normalises a video descriptor coming from the host. Everything here is echoed to
 * other clients, so unknown fields are dropped and strings are length capped rather than trusted.
 */
function parseVideo(value: unknown): PartyVideo | null {
  if ((value == null) || (typeof value != 'object')) {
    return null;
  }

  const raw = value as Record<string, unknown>;
  const text = (key: string, maxLength = 500): string => (typeof raw[key] == 'string') ? (raw[key] as string).slice(0, maxLength) : '';

  const url = text('url', 2000);
  const id = text('id', 100);

  if ((url.length == 0) || (id.length == 0)) {
    return null;
  }

  return {
    id,
    channel: text('channel', 100),
    topic: text('topic'),
    title: text('title'),
    url,
    quality: text('quality', 10),
    url_website: text('url_website', 2000) || undefined,
    url_subtitle: text('url_subtitle', 2000) || undefined
  };
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

function handleMessage(registry: WatchPartyRegistry, member: Member, raw: string): void {
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

      registry.setHostState(member, { video: parseVideo(message['video']), position: message['position'], paused: message['paused'] });

      return;
    }

    case 'resync-all':
      registry.resyncAll(member);
      return;

    case 'request-resync':
      registry.requestResync(member);
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
export function attachWatchPartySocket(httpServer: http.Server, registry: WatchPartyRegistry): void {
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
      const hostToken = requestUrl.searchParams.get('token') ?? undefined;

      // A `closed` message is always terminal, so the transport tears the socket down with it.
      const attachResult = registry.attach(partyId, (message) => {
        send(webSocket, message);

        if (message.type == 'closed') {
          webSocket.close(CLOSE_CODE_PARTY_CLOSED, message.reason);
        }
      }, hostToken);

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

      partySocket.on('message', (data) => {
        if (!withinRateLimit(partySocket)) {
          partySocket.close(CLOSE_CODE_PARTY_CLOSED, 'rate-limit');
          return;
        }

        handleMessage(registry, member, data.toString());
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
