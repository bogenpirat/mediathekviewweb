import crypto from 'node:crypto';

/** Maximum number of clients (host included) that may be attached to a single party. */
const MAX_MEMBERS_PER_PARTY = 20;

/** Global ceiling on concurrent parties, so a flood of create requests cannot exhaust memory. */
const MAX_PARTIES = 500;

/** How long a party survives without its host attached, so a reload does not end it. */
const HOST_GRACE_MS = 90 * 1000;

/** Parties without any host activity for this long are collected by the sweeper. */
const IDLE_TIMEOUT_MS = 4 * 60 * 60 * 1000;

/** Interval of the background sweep for grace-expired and idle parties. */
const SWEEP_INTERVAL_MS = 30 * 1000;

/** Clients further away from the host than this are reported as out of sync. */
export const DRIFT_THRESHOLD_SECONDS = 2;

export type PartyVideo = {
  id: string,
  channel: string,
  topic: string,
  title: string,
  url: string,
  quality: string,
  url_website?: string,
  url_subtitle?: string,
};

export type HostState = {
  video: PartyVideo | null,
  position: number,
  paused: boolean,
  receivedAt: number,
};

export type CloseReason = 'host-left' | 'superseded' | 'expired' | 'not-found' | 'full' | 'disabled';

export type MemberRole = 'host' | 'guest';

export type ServerMessage =
  | { type: 'welcome', clientId: string, role: MemberRole, memberCount: number, hostState: HostState | null }
  | { type: 'state', video: PartyVideo | null, position: number, paused: boolean }
  | { type: 'resync', position: number, paused: boolean }
  | { type: 'drift', drift: number | null, videoMismatch: boolean }
  | { type: 'party-drift', outOfSyncCount: number, maxDriftAbs: number }
  | { type: 'members', count: number }
  | { type: 'closed', reason: CloseReason };

export type Send = (message: ServerMessage) => void;

export type Member = {
  readonly id: string,
  readonly role: MemberRole,
  readonly partyId: string,
  readonly send: Send,
  /** Last position reported by this member, in media seconds. Null until the first tick. */
  position: number | null,
  paused: boolean,
  videoId: string | null,
  lastSeenAt: number,
};

type Party = {
  id: string,
  hostToken: string,
  hostIp: string,
  createdAt: number,
  hostState: HostState,
  members: Map<string, Member>,
  /** Time after which a party with no host attached is collected. Null while a host is attached. */
  hostGraceUntil: number | null,
};

export type AttachResult =
  | { status: 'attached', member: Member }
  | { status: 'rejected', reason: CloseReason };

function randomId(bytes: number): string {
  return crypto.randomBytes(bytes).toString('hex');
}

/** Constant-time comparison that tolerates differing lengths without throwing. */
function tokensMatch(a: string, b: string): boolean {
  const bufferA = Buffer.from(a);
  const bufferB = Buffer.from(b);

  if (bufferA.length != bufferB.length) {
    return false;
  }

  return crypto.timingSafeEqual(bufferA, bufferB);
}

/**
 * Holds every running watch party. Deliberately transport agnostic: a member is just a `send`
 * callback, so this file can be reasoned about (and driven) without a WebSocket in the picture.
 *
 * All state is in-process. The server is a single non-clustered node, so this is a valid single
 * source of truth, but it also means a restart drops every party.
 */
export class WatchPartyRegistry {
  private readonly parties = new Map<string, Party>();

  /** Index of hosting IP to party id, backing the "one hosted party per IP" rule. */
  private readonly partyByHostIp = new Map<string, string>();

  private readonly sweepTimer: NodeJS.Timeout;

  constructor() {
    this.sweepTimer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    this.sweepTimer.unref();
  }

  get partyCount(): number {
    return this.parties.size;
  }

  get memberCount(): number {
    let count = 0;

    for (const party of this.parties.values()) {
      count += party.members.size;
    }

    return count;
  }

  has(partyId: string): boolean {
    return this.parties.has(partyId);
  }

  hasVideo(partyId: string): boolean {
    return this.parties.get(partyId)?.hostState.video != null;
  }

  /**
   * Creates a party for `hostIp`, closing any party that IP was already hosting.
   * Joining is never IP limited, only hosting is.
   */
  createParty(hostIp: string): { partyId: string, hostToken: string } | { error: 'capacity' } {
    const existingPartyId = this.partyByHostIp.get(hostIp);

    if (existingPartyId != undefined) {
      this.closeParty(existingPartyId, 'superseded');
    }

    if (this.parties.size >= MAX_PARTIES) {
      return { error: 'capacity' };
    }

    const partyId = randomId(6);
    const hostToken = randomId(16);
    const now = Date.now();

    this.parties.set(partyId, {
      id: partyId,
      hostToken,
      hostIp,
      createdAt: now,
      hostState: { video: null, position: 0, paused: true, receivedAt: now },
      members: new Map(),
      hostGraceUntil: now + HOST_GRACE_MS
    });

    this.partyByHostIp.set(hostIp, partyId);

    return { partyId, hostToken };
  }

  attach(partyId: string, send: Send, hostToken?: string): AttachResult {
    const party = this.parties.get(partyId);

    if (party == undefined) {
      return { status: 'rejected', reason: 'not-found' };
    }

    if (party.members.size >= MAX_MEMBERS_PER_PARTY) {
      return { status: 'rejected', reason: 'full' };
    }

    const isHost = (typeof hostToken == 'string') && (hostToken.length > 0) && tokensMatch(hostToken, party.hostToken);

    if (isHost) {
      // A reconnecting host takes the host slot back from any stale host connection.
      for (const existing of [...party.members.values()]) {
        if (existing.role == 'host') {
          party.members.delete(existing.id);
        }
      }

      party.hostGraceUntil = null;
    }

    const member: Member = {
      id: randomId(8),
      role: isHost ? 'host' : 'guest',
      partyId,
      send,
      position: null,
      paused: true,
      videoId: null,
      lastSeenAt: Date.now()
    };

    party.members.set(member.id, member);

    send({
      type: 'welcome',
      clientId: member.id,
      role: member.role,
      memberCount: party.members.size,
      hostState: (party.hostState.video != null) ? party.hostState : null
    });

    if (!isHost && (party.hostState.video != null)) {
      // A joining guest starts from wherever the host currently is.
      send({ type: 'state', video: party.hostState.video, position: this.projectedHostPosition(party), paused: party.hostState.paused });
    }

    this.broadcastMemberCount(party);

    return { status: 'attached', member };
  }

  detach(member: Member): void {
    const party = this.parties.get(member.partyId);

    if (party == undefined) {
      return;
    }

    // Only remove the member if it is still the registered one; a reconnecting host may already
    // have replaced it.
    if (party.members.get(member.id) === member) {
      party.members.delete(member.id);
    }

    if (member.role == 'host') {
      const hostStillAttached = [...party.members.values()].some((other) => other.role == 'host');

      if (!hostStillAttached) {
        party.hostGraceUntil = Date.now() + HOST_GRACE_MS;
      }
    }

    this.broadcastMemberCount(party);
  }

  /** Applies an authoritative state update from the host and pushes it to every guest. */
  setHostState(member: Member, update: { video: PartyVideo | null, position: number, paused: boolean }): void {
    const party = this.parties.get(member.partyId);

    if ((party == undefined) || (member.role != 'host')) {
      return;
    }

    party.hostState = {
      video: update.video,
      position: update.position,
      paused: update.paused,
      receivedAt: Date.now()
    };

    member.position = update.position;
    member.paused = update.paused;
    member.videoId = update.video?.id ?? null;
    member.lastSeenAt = Date.now();

    for (const other of party.members.values()) {
      if (other.role != 'host') {
        other.send({ type: 'state', video: update.video, position: update.position, paused: update.paused });
      }
    }
  }

  /**
   * Records a ~1Hz position report. Drift is computed here, against the server's own clock, so
   * client clock skew never enters the calculation: both sides report media time and the server
   * timestamps both reports itself.
   */
  tick(member: Member, update: { position: number, paused: boolean, videoId: string | null }): void {
    const party = this.parties.get(member.partyId);

    if (party == undefined) {
      return;
    }

    member.position = update.position;
    member.paused = update.paused;
    member.videoId = update.videoId;
    member.lastSeenAt = Date.now();

    if (member.role == 'host') {
      // Keep the projection anchor fresh so guests joining later land on the right position.
      party.hostState = { ...party.hostState, position: update.position, paused: update.paused, receivedAt: Date.now() };

      const summary = this.summarizeDrift(party);
      member.send({ type: 'party-drift', outOfSyncCount: summary.outOfSyncCount, maxDriftAbs: summary.maxDriftAbs });

      return;
    }

    const videoMismatch = this.isVideoMismatch(party, member);
    const drift = videoMismatch ? null : this.driftOf(party, member);

    member.send({ type: 'drift', drift, videoMismatch });
  }

  /** A single guest asks to be put back onto the host's current position. */
  requestResync(member: Member): void {
    const party = this.parties.get(member.partyId);

    if ((party == undefined) || (party.hostState.video == null)) {
      return;
    }

    member.send({ type: 'resync', position: this.projectedHostPosition(party), paused: party.hostState.paused });
  }

  /** Host forces every guest to jump to the host's current position. */
  resyncAll(member: Member): void {
    const party = this.parties.get(member.partyId);

    if ((party == undefined) || (member.role != 'host')) {
      return;
    }

    const position = this.projectedHostPosition(party);

    for (const other of party.members.values()) {
      if (other.role != 'host') {
        other.send({ type: 'resync', position, paused: party.hostState.paused });
      }
    }
  }

  closeParty(partyId: string, reason: CloseReason): void {
    const party = this.parties.get(partyId);

    if (party == undefined) {
      return;
    }

    for (const member of party.members.values()) {
      try {
        member.send({ type: 'closed', reason });
      }
      catch {
        // The socket may already be gone; closing the party must not depend on it.
      }
    }

    party.members.clear();
    this.parties.delete(partyId);

    if (this.partyByHostIp.get(party.hostIp) == partyId) {
      this.partyByHostIp.delete(party.hostIp);
    }
  }

  /** Ends the party a member is hosting. Guests calling this are ignored. */
  closeByHost(member: Member): void {
    const party = this.parties.get(member.partyId);

    if ((party != undefined) && (member.role == 'host')) {
      this.closeParty(party.id, 'host-left');
    }
  }

  private isVideoMismatch(party: Party, member: Member): boolean {
    const hostVideoId = party.hostState.video?.id;

    if (!hostVideoId || (member.videoId == null)) {
      return false;
    }

    return member.videoId != hostVideoId;
  }

  /** Where the host should be right now, extrapolating from their last report if they are playing. */
  private projectedHostPosition(party: Party): number {
    const { position, paused, receivedAt } = party.hostState;

    if (paused) {
      return position;
    }

    return position + ((Date.now() - receivedAt) / 1000);
  }

  private driftOf(party: Party, member: Member): number | null {
    if ((member.position == null) || (party.hostState.video == null)) {
      return null;
    }

    return member.position - this.projectedHostPosition(party);
  }

  private summarizeDrift(party: Party): { outOfSyncCount: number, maxDriftAbs: number } {
    let outOfSyncCount = 0;
    let maxDriftAbs = 0;

    for (const member of party.members.values()) {
      if (member.role == 'host') {
        continue;
      }

      if (this.isVideoMismatch(party, member)) {
        // A guest on a different video counts as out of sync, but has no meaningful drift value.
        outOfSyncCount += 1;
        continue;
      }

      const drift = this.driftOf(party, member);

      if (drift == null) {
        continue;
      }

      const driftAbs = Math.abs(drift);

      if (driftAbs > DRIFT_THRESHOLD_SECONDS) {
        outOfSyncCount += 1;
        maxDriftAbs = Math.max(maxDriftAbs, driftAbs);
      }
    }

    return { outOfSyncCount, maxDriftAbs };
  }

  private broadcastMemberCount(party: Party): void {
    for (const member of party.members.values()) {
      member.send({ type: 'members', count: party.members.size });
    }
  }

  private sweep(): void {
    const now = Date.now();

    for (const party of [...this.parties.values()]) {
      if ((party.hostGraceUntil != null) && (now > party.hostGraceUntil)) {
        this.closeParty(party.id, 'host-left');
        continue;
      }

      if ((now - party.hostState.receivedAt) > IDLE_TIMEOUT_MS) {
        this.closeParty(party.id, 'expired');
      }
    }
  }
}
