import crypto from 'node:crypto';
import net from 'node:net';

/** Maximum number of clients (host included) that may be attached to a single party. */
const MAX_MEMBERS_PER_PARTY = 20;

/** Global ceiling on concurrent parties, so a flood of create requests cannot exhaust memory. */
const MAX_PARTIES = 500;

/**
 * Parties one network may host at once. Several browsers behind one NAT each get their own party,
 * but a single address (or IPv6 /64) cannot occupy the whole global pool.
 */
const MAX_PARTIES_PER_HOST_NETWORK = 5;

/** How long a party survives without its host attached, so a reload does not end it. */
const HOST_GRACE_MS = 90 * 1000;

/** Parties without any host activity for this long are collected by the sweeper. */
const IDLE_TIMEOUT_MS = 4 * 60 * 60 * 1000;

/** Interval of the background sweep for grace-expired and idle parties. */
const SWEEP_INTERVAL_MS = 30 * 1000;

/** Upper bound on invites a host can mint, so the map cannot grow without limit. */
const MAX_INVITES_PER_PARTY = 50;

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

export type CloseReason = 'host-left' | 'expired' | 'not-found' | 'full' | 'disabled' | 'invite-required' | 'invite-invalid';

/**
 * A single-use claim on a seat in the party. The host hands one out per guest; claiming it
 * mints that guest a private member token, so a shoulder-surfed link is worthless once used.
 */
export type Invite = {
  token: string,
  createdAt: number,
  /** Member token of the guest that claimed it, or null while unclaimed. */
  claimedBy: string | null,
};

export type MemberRole = 'host' | 'guest';

export type ServerMessage =
  | { type: 'welcome', clientId: string, role: MemberRole, memberCount: number, hostState: HostState | null, memberToken?: string }
  | { type: 'invites', invites: { token: string, claimed: boolean }[] }
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
  /** Private token this guest reconnects with. Undefined for the host, which uses its host token. */
  readonly memberToken?: string,
  /** Last position reported by this member, in media seconds. Null until the first tick. */
  position: number | null,
  paused: boolean,
  videoId: string | null,
  lastSeenAt: number,
};

type Party = {
  id: string,
  hostToken: string,
  /** Network the host created the party from, see `hostNetworkOf`. */
  hostNetwork: string,
  createdAt: number,
  hostState: HostState,
  members: Map<string, Member>,
  /** Unclaimed and claimed invites, keyed by invite token. */
  invites: Map<string, Invite>,
  /** Member tokens minted for guests that claimed an invite, keyed by member token. */
  guestTokens: Map<string, { inviteToken: string, createdAt: number }>,
  /** Time after which a party with no host attached is collected. Null while a host is attached. */
  hostGraceUntil: number | null,
};

export type AttachCredentials = {
  hostToken?: string,
  /** Single-use invite handed out by the host. Consumed on first successful attach. */
  inviteToken?: string,
  /** Private token a guest received when it claimed an invite; lets it reconnect. */
  memberToken?: string,
};

export type AttachResult =
  | { status: 'attached', member: Member, memberToken?: string }
  | { status: 'rejected', reason: CloseReason };

/**
 * Reduces an address to the unit one subscriber controls: the address itself for IPv4, the /64
 * for IPv6, where a single connection can rotate through the lower 64 bits at will.
 */
export function hostNetworkOf(ip: string): string {
  const address = ip.replace(/%.*$/, '');
  const mappedIpv4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);

  if (mappedIpv4 != null) {
    return mappedIpv4[1]!;
  }

  if (!net.isIPv6(address)) {
    return address;
  }

  // A trailing dotted IPv4 part stands in for two groups.
  const groupsOf = (part: string): string[] => (part.length == 0) ? [] : part.split(':').flatMap((group) => group.includes('.') ? ['0', '0'] : [group]);
  const [head = '', tail] = address.split('::');
  const headGroups = groupsOf(head);
  const tailGroups = groupsOf(tail ?? '');
  const groups = (tail == undefined) ? headGroups : [...headGroups, ...Array<string>(8 - headGroups.length - tailGroups.length).fill('0'), ...tailGroups];

  return `${groups.slice(0, 4).map((group) => parseInt(group, 16).toString(16)).join(':')}::/64`;
}

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

  /** The video the party currently shows, if `member` is its attached host. */
  currentVideo(member: Member): PartyVideo | null {
    const party = this.partyOf(member);

    return ((party != undefined) && (member.role == 'host')) ? party.hostState.video : null;
  }

  /**
   * Creates a party for `hostIp`. Every browser gets its own party, even behind a shared address;
   * only the number of parties per network is capped. Joining is never IP limited.
   */
  createParty(hostIp: string): { partyId: string, hostToken: string, inviteToken: string } | { error: 'capacity' | 'network-limit' } {
    if (this.parties.size >= MAX_PARTIES) {
      return { error: 'capacity' };
    }

    const hostNetwork = hostNetworkOf(hostIp);
    const hostedByNetwork = [...this.parties.values()].filter((party) => party.hostNetwork == hostNetwork).length;

    if (hostedByNetwork >= MAX_PARTIES_PER_HOST_NETWORK) {
      return { error: 'network-limit' };
    }

    const partyId = randomId(6);
    const hostToken = randomId(16);
    const firstInvite: Invite = { token: randomId(16), createdAt: Date.now(), claimedBy: null };
    const now = Date.now();

    this.parties.set(partyId, {
      id: partyId,
      hostToken,
      hostNetwork,
      createdAt: now,
      hostState: { video: null, position: 0, paused: true, receivedAt: now },
      members: new Map(),
      invites: new Map([[firstInvite.token, firstInvite]]),
      guestTokens: new Map(),
      hostGraceUntil: now + HOST_GRACE_MS
    });

    return { partyId, hostToken, inviteToken: firstInvite.token };
  }

  /**
   * Attaches a connection to a party. A caller must present one of three credentials:
   * the host token, a single-use invite token, or the private member token minted when an
   * invite was claimed. The party id alone is deliberately not enough - it travels in a link
   * that may be read over someone's shoulder.
   */
  attach(partyId: string, send: Send, credentials: AttachCredentials = {}): AttachResult {
    const party = this.parties.get(partyId);

    if (party == undefined) {
      return { status: 'rejected', reason: 'not-found' };
    }

    const isHost = (typeof credentials.hostToken == 'string')
      && (credentials.hostToken.length > 0)
      && tokensMatch(credentials.hostToken, party.hostToken);

    const guest = isHost ? null : this.resolveGuest(party, credentials);

    if (guest?.status == 'rejected') {
      return guest;
    }

    // One live connection per credential: a reconnecting host or guest replaces its old socket,
    // so a leaked token cannot be used to watch alongside its owner.
    const replaces = isHost
      ? (existing: Member) => existing.role == 'host'
      : (existing: Member) => (guest?.memberToken != undefined) && (existing.memberToken == guest.memberToken);

    const replaced = [...party.members.values()].filter(replaces);

    // Checked before an invite is claimed, so a full party does not burn the link, and without the
    // connections about to be replaced, so a full party cannot lock out its own reconnecting members.
    if ((party.members.size - replaced.length) >= MAX_MEMBERS_PER_PARTY) {
      return { status: 'rejected', reason: 'full' };
    }

    const memberToken = (guest == null) ? undefined : (guest.memberToken ?? this.claimInvite(party, guest.invite!));

    for (const existing of replaced) {
      party.members.delete(existing.id);
    }

    if (isHost) {
      party.hostGraceUntil = null;
    }

    const member: Member = {
      id: randomId(8),
      role: isHost ? 'host' : 'guest',
      partyId,
      send,
      memberToken,
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
      hostState: (party.hostState.video != null) ? party.hostState : null,
      memberToken
    });

    if (!isHost && (party.hostState.video != null)) {
      // A joining guest starts from wherever the host currently is.
      send({ type: 'state', video: party.hostState.video, position: this.projectedHostPosition(party), paused: party.hostState.paused });
    }

    this.broadcastMemberCount(party);

    // Keeps the host's invite list current, including which links have just been claimed.
    this.sendInvites(party);

    return { status: 'attached', member, memberToken };
  }

  /**
   * Checks a guest's credentials without spending anything: either a known member token, or an
   * unclaimed invite for the caller to claim once the guest is actually admitted.
   */
  private resolveGuest(party: Party, credentials: AttachCredentials): { status: 'ok', memberToken?: string, invite?: Invite } | { status: 'rejected', reason: CloseReason } {
    const { memberToken, inviteToken } = credentials;

    // A returning guest reconnects with the token it was given, not with its spent invite.
    if ((typeof memberToken == 'string') && party.guestTokens.has(memberToken)) {
      return { status: 'ok', memberToken };
    }

    if ((typeof inviteToken != 'string') || (inviteToken.length == 0)) {
      return { status: 'rejected', reason: 'invite-required' };
    }

    const invite = party.invites.get(inviteToken);

    if ((invite == undefined) || (invite.claimedBy != null)) {
      return { status: 'rejected', reason: 'invite-invalid' };
    }

    return { status: 'ok', invite };
  }

  /** Spends an invite and mints the private member token its guest reconnects with. */
  private claimInvite(party: Party, invite: Invite): string {
    const issued = randomId(16);
    invite.claimedBy = issued;
    party.guestTokens.set(issued, { inviteToken: invite.token, createdAt: Date.now() });

    return issued;
  }

  /**
   * The party `member` belongs to, provided it is still the live connection for its credential.
   * A connection replaced by a reconnect keeps its socket open for a while and must lose its rights.
   */
  private partyOf(member: Member): Party | undefined {
    const party = this.parties.get(member.partyId);

    return (party?.members.get(member.id) === member) ? party : undefined;
  }

  /** Host only: mints a fresh single-use invite. */
  createInvite(member: Member): Invite | null {
    const party = this.partyOf(member);

    if ((party == undefined) || (member.role != 'host')) {
      return null;
    }

    if (party.invites.size >= MAX_INVITES_PER_PARTY) {
      // Drop the oldest claimed invite to make room; unclaimed ones are still wanted.
      const stale = [...party.invites.values()].filter((invite) => invite.claimedBy != null).sort((a, b) => a.createdAt - b.createdAt)[0];

      if (stale == undefined) {
        return null;
      }

      party.invites.delete(stale.token);
    }

    const invite: Invite = { token: randomId(16), createdAt: Date.now(), claimedBy: null };
    party.invites.set(invite.token, invite);

    this.sendInvites(party);

    return invite;
  }

  /**
   * Host only: invalidates invites. Without a token every unclaimed invite is dropped, which is
   * what the host wants after sharing a link with the wrong person.
   */
  revokeInvites(member: Member, token?: string): void {
    const party = this.partyOf(member);

    if ((party == undefined) || (member.role != 'host')) {
      return;
    }

    if (typeof token == 'string') {
      party.invites.delete(token);
    }
    else {
      for (const invite of [...party.invites.values()]) {
        if (invite.claimedBy == null) {
          party.invites.delete(invite.token);
        }
      }
    }

    this.sendInvites(party);
  }

  /** True when the party has an unclaimed invite with this token. */
  isInviteClaimable(partyId: string, token: string): boolean {
    const invite = this.parties.get(partyId)?.invites.get(token);

    return (invite != undefined) && (invite.claimedBy == null);
  }

  /** Pushes the invite list to every attached host connection. Guests never see it. */
  private sendInvites(party: Party): void {
    const invites = [...party.invites.values()].map((invite) => ({ token: invite.token, claimed: invite.claimedBy != null }));

    for (const member of party.members.values()) {
      if (member.role == 'host') {
        member.send({ type: 'invites', invites });
      }
    }
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
    const party = this.partyOf(member);

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
    const party = this.partyOf(member);

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
    const party = this.partyOf(member);

    if ((party == undefined) || (party.hostState.video == null)) {
      return;
    }

    member.send({ type: 'resync', position: this.projectedHostPosition(party), paused: party.hostState.paused });
  }

  /** Host forces every guest to jump to the host's current position. */
  resyncAll(member: Member): void {
    const party = this.partyOf(member);

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
  }

  /** Ends the party a member is hosting. Guests calling this are ignored. */
  closeByHost(member: Member): void {
    const party = this.partyOf(member);

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
