// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The small fact world one real `stepPeerActor` runs in. The world stands for
 * Mesh with the actor driving: it stamps each fact as Mesh's observePeerInput
 * does, runs each command as executePeerCommand does, and completes the
 * awaited ones as the runner does (peer-runner.ts). Line numbers below refer
 * to mesh.ts as it was when the world was written and drift as it changes;
 * the named functions are the reliable pointer.
 *
 * What the world keeps beyond a minimal interface, each because a faithful
 * completion or follow-up needs it:
 * - `pending` entries carry the command's wire (`lane`), `cause`, the
 *   description it applies and the round it began in: the site and the
 *   round Mesh stamps on its completion come from them.
 * - `queue` is the runner's FIFO inside one drain: follow-up events an
 *   effect dispatches synchronously (mark-away's peer-away, create-channel's
 *   offer, a supervisor sweep's freshness fact) and synchronous results. A
 *   synchronous result with two possible outcomes (restart-ice) is a choice
 *   at the queue's head, and nothing else is enabled until it is taken.
 * - `mesh` is the rest of Mesh's per-connection bookkeeping the stamped facts
 *   depend on (signalling state, the held descriptions, the codec guard).
 */
import { armDeadlines, createPeerActorState, deadlineInstants, type PeerActorCommand, type PeerActorEvent, type PeerActorState, type PeerActorStep } from "../../state-machines/peer-actor"
import { snapshotOf, type SupervisorTickFacts } from "../../state-machines/peer-actor.test-helper"

export type PendingDescription = "offer" | "answer" | "retry"

/** An issued command whose completion the runner will reduce later. */
export interface PendingCommand {
  kind: PeerActorCommand["kind"]
  commandEpoch: number
  connectionEpoch: number
  /** the wire it runs on (set-remote-description, send-answer, send-offer) */
  lane?: boolean
  /** restart-ice's and rollback's cause: the site Mesh stamps */
  cause?: string
  /** what a set-remote-description applies: Mesh's held description */
  description?: PendingDescription
  /** the round a lane operation began in, stamped on its rejection */
  roundGeneration?: number
}

export type Queued =
  | { type: "event"; event: PeerActorEvent }
  /** a synchronous result with more than one possible outcome */
  | { type: "choice"; command: PendingCommand }
  /** supervise() over this peer, read when the drain reaches it (a kick's sweep) */
  | { type: "sweep" }
  /** the tick that follows a sweep's freshness fact */
  | { type: "tick" }

export type Signaling = "stable" | "have-local-offer" | "have-remote-offer"

export interface MeshBook {
  signaling: Signaling
  /** the type of the connection's local description (pc.localDescription.type) */
  localType: "offer" | "answer" | null
  /** the wire our outstanding local offer went on */
  localOfferWire: "statement" | "lane" | null
  /** Mesh's statementInbound / laneInbound: the description the next set-remote-description applies */
  statementInbound: "offer" | "answer" | null
  laneInbound: "offer" | "answer" | null
  /** statementAnswering / laneAnswering: an applied offer the next send-answer answers */
  statementAnswering: boolean
  laneAnswering: boolean
  /** refusedOffers: an offer the connection refused with InvalidAccessError, retried on the next one */
  refusedEpoch: number | null
  /** a lane description was applied on this connection (receivesVideo on the remote description) */
  laneMedia: boolean
  /** onnegotiationneeded is due: a channel or tracks were added, or ICE restarted */
  negotiationNeeded: boolean
  /** the codec guard holds this connection's lane offer (codecGuards) */
  codecGuard: boolean
  /** a superseded lane offer waits for its rollback (supersededOffers) */
  superseded: boolean
  /** our own camera has a live video track (watchMedia's localVideoLive, mesh.ts:3670) */
  cameraLive: boolean
  /** a supervisor sweep already ran at this instant */
  tickedAt: number | null
  /** Mesh's answererMayOffer for this peer, the answerer's leave to offer: a
   *  per-peer set, so it outlives the connection (meshLeave) */
  leave: boolean
}

export interface ActorWorld {
  actor: PeerActorState
  meshConnectionEpoch: number
  now: number
  facts: Omit<SupervisorTickFacts, "now">
  pending: PendingCommand[]
  nextReadSequence: number
  faultsLeft: number
  queue: Queued[]
  mesh: MeshBook
}

/** The pair's one room: sides a and b, game 42, the useMesh generation 1. */
export const ROOM = { game: 42, roomEpoch: 1 } as const
/** Mesh's monotonic clock when the actor starts. Any value works: keys hold distances. */
export const START_NOW = 100_000

/** A connection fresh from addPeer (mesh.ts:1632-1652), with what rebuildPeer
 *  carries over (3592-3617) given by the caller. */
export function freshFacts(carry: Partial<Pick<SupervisorTickFacts, "lastSignalAt" | "firstHeardAt" | "everConnected" | "downAt" | "away">> = {}, hasChannel = false): Omit<SupervisorTickFacts, "now"> {
  return {
    browserConnectionState: "new",
    haveLocalOffer: false,
    localDescription: false,
    remoteDescription: false,
    hasChannel,
    laneOpen: false,
    everConnected: carry.everConnected ?? false,
    away: carry.away ?? null,
    framesSeen: 0,
    sawVideoThisRound: false,
    canRestartIce: true,
    lastSignalAt: carry.lastSignalAt ?? null,
    firstHeardAt: carry.firstHeardAt ?? null,
    lastRecvDescAt: null,
    offerSentAt: null,
    yieldedAt: null,
    upAt: 0,
    downAt: carry.downAt ?? 0,
    disconnectedAt: 0,
  }
}

export function freshBook(negotiationNeeded: boolean, carry: Partial<Pick<MeshBook, "cameraLive" | "leave">> = {}): MeshBook {
  return {
    signaling: "stable",
    localType: null,
    localOfferWire: null,
    statementInbound: null,
    laneInbound: null,
    statementAnswering: false,
    laneAnswering: false,
    refusedEpoch: null,
    laneMedia: false,
    negotiationNeeded,
    codecGuard: false,
    superseded: false,
    cameraLive: carry.cameraLive ?? true,
    tickedAt: null,
    leave: carry.leave ?? false,
  }
}

/** The sides as startActor makes them (mesh.ts:4640-4650): the initiator
 *  (lower id) creates its channel at addPeer and so needs to offer; the
 *  answerer waits for the offer. Not standby, round 0. startActor seeds
 *  cameraLive from our live video track (4645): the initiator also starts
 *  once with the camera still off, since only the initiator's unseen heal
 *  reads it. */
export function initialWorlds(faults = 1): { label: string; world: ActorWorld }[] {
  const make = (initiator: boolean, cameraLive = true): ActorWorld => ({
    actor: createPeerActorState({ game: ROOM.game, roomEpoch: ROOM.roomEpoch, peer: initiator ? "b" : "a" }, { initiator, standby: false, cameraLive, connectionEpoch: 1, connectingSince: START_NOW }),
    meshConnectionEpoch: 1,
    now: START_NOW,
    facts: freshFacts({}, initiator),
    pending: [],
    nextReadSequence: 1,
    faultsLeft: faults,
    queue: [],
    mesh: freshBook(initiator, { cameraLive }),
  })
  return [
    { label: "initiator", world: make(true) },
    { label: "answerer", world: make(false) },
    { label: "initiator-camera-off", world: make(true, false) },
  ]
}

/** What the world holds constant, for the reader of the graph: a branch
 *  that reads one of these is uncovered for that reason, not dead. */
export const HELD_CONSTANTS: Record<string, string> = {
  "facts.canRestartIce": "always true: an engine without restartIce is not modelled",
}

/** The open regions the actor kept before its one link axis,
 *  as the link a world saved then holds. */
const LINK_OF_REGION: Record<string, PeerActorState["link"]> = {
  new: "connecting", negotiating: "connecting", recovering: "connecting", "waiting-stranded-offer": "yielded",
  connected: "connected", "link-down": "link-down", closed: "closed",
}

/** A world saved before the actor kept its own times (the committed anchor
 *  fixtures) takes them from its copy of Mesh's, which the actor then held
 *  as its own; one saved before its link axis takes
 *  the link of its region, and every world its deadlines. A world that has
 *  them all is left as it is. */
export function upgradeWorld(world: ActorWorld): ActorWorld {
  let actor = world.actor
  if (actor.link === undefined) {
    const { connection, ...rest } = actor as PeerActorState & { connection: string }
    actor = { ...rest, link: LINK_OF_REGION[connection]! } as PeerActorState
  }
  if (actor.connectingSince === undefined) actor = { ...actor, connectingSince: actor.lastAttemptAt ?? actor.firstHeardAt ?? START_NOW }
  if (actor.deadlines === undefined || actor.deadlines.connectBy === undefined) actor = { ...actor, deadlines: armDeadlines(actor) }
  // the copies of the actor's failures, last attempt and no-video rebuild that Mesh's tick once carried (older saved worlds hold them)
  const { failCount: _failCount, lastAttemptAt: _lastAttemptAt, noVideoRebuiltThisRound: _noVideo, ...facts } = world.facts as ActorWorld["facts"] & Record<"failCount" | "lastAttemptAt" | "noVideoRebuiltThisRound", unknown>
  void _failCount
  void _lastAttemptAt
  void _noVideo
  return { ...world, actor, facts }
}

export function cloneWorld(world: ActorWorld): ActorWorld {
  return {
    actor: world.actor,
    meshConnectionEpoch: world.meshConnectionEpoch,
    now: world.now,
    facts: { ...world.facts },
    pending: world.pending.map((entry) => ({ ...entry })),
    nextReadSequence: world.nextReadSequence,
    faultsLeft: world.faultsLeft,
    queue: [...world.queue],
    mesh: { ...world.mesh },
  }
}

export function setSignaling(world: ActorWorld, signaling: Signaling): void {
  world.mesh.signaling = signaling
  world.facts.haveLocalOffer = signaling === "have-local-offer"
  if (signaling !== "have-local-offer") world.mesh.localOfferWire = null
}

/** Mesh's mayOffer: the initiator, or an answerer granted the leave. */
export const mayOffer = (world: ActorWorld): boolean => world.actor.initiator || world.mesh.leave

/** The restarts and rebuilds Mesh grants the answerer its leave to offer
 *  with (the supervisor's recovery, the stall heal, networkChanged, the rebuilds and their
 *  fallbacks); the unseen heal, the yield and the refused offer's rejoin
 *  grant none. */
const GRANTING_RESTARTS: ReadonlySet<string> = new Set(["soft-disconnect", "media-stall", "network-change"])
const GRANTING_REPLACES: ReadonlySet<string> = new Set([
  "channel-never-opened", "failed", "soft-disconnect", "connect-by-deadline", "connected-no-video", "media-stall", "lane-glare-video",
  "hard-sdp-immediate", "hard-sdp-unseen", "network-change", "supervisor-recovery-restart-failed", "network-change-restart-failed",
])

/** Mesh's answererMayOffer after one actor step: granted with
 *  initiateStrandedPeer's and the rejoin's channel on either side, and to the
 *  answerer with a recovery or a new session over our offer; cleared on a
 *  link back up, on video flowing again and on removal. These are the rules
 *  the actor kept in its own copy until it dropped it: the lockstep
 *  differential of that change shows the two equal on every step. */
export function meshLeave(leave: boolean, before: PeerActorState, event: PeerActorEvent, step: PeerActorStep): boolean {
  if (step.ignored) return leave
  if (event.type === "connection-observed" && event.state === "connected") return false
  if (event.type === "peer-removed") return false
  const grants = (command: PeerActorCommand): boolean => {
    if (command.kind === "create-channel") return true
    if (before.initiator) return false
    if (command.kind === "restart-ice") return GRANTING_RESTARTS.has(command.cause)
    if (command.kind !== "replace-connection") return false
    if (command.cause === "description-session-rejoin") return command.initiate
    if (command.cause === "signalling-session-rejoin") return command.answererMayOffer === true
    return GRANTING_REPLACES.has(command.cause)
  }
  if (step.commands.some(grants)) return true
  if (event.type === "stats-observed") {
    // video flows again (sawFrames), unless the sweep healed a stall or a
    // missing video instead
    const healed = step.commands.some((command) => (command.kind === "restart-ice" || command.kind === "replace-connection") && (command.cause === "media-stall" || command.cause === "connected-no-video"))
    const progress = event.framesDecoded >= 0 && (event.framesDecoded > before.framesSeen || (event.framesDecoded > 0 && event.framesDecoded < before.framesSeen))
    if (progress && !healed) return false
  }
  return leave
}

/** Every instant at which one of the world's time comparisons flips:
 *  the actor's deadlineInstants (its clock decision's deadlines, the
 *  never-connected guards and its peer-heard gap). Mesh's markSeen return gap
 *  (mesh.ts:4029) and supervise's freshness fact (3459) flip at the same
 *  instants as the peer-heard gap and freshUntil. A strict `>` (or `<=`)
 *  flips one millisecond after its threshold. */
function deadlines(world: ActorWorld): number[] {
  // the actor's own: its deadlines, the never-connected
  // guards and the peer-heard gap
  return deadlineInstants(world.actor)
}

/** The next instant after `now` at which any comparison flips, or null. */
export function nextDeadline(world: ActorWorld): number | null {
  let next: number | null = null
  for (const time of deadlines(world)) if (time > world.now && (next === null || time < next)) next = time
  return next
}

/** When no comparison is left to flip, time still passes: the instant at
 *  which every real time the key holds has aged to SAT, or null when all
 *  have already. A sweep then decides as at the last flip, and the key
 *  saturates every distance at once. */
export function quietUntil(world: ActorWorld, sat: number): number | null {
  const { actor } = world
  const times = [actor.lastSignalAt, actor.lastAttemptAt, actor.upAt, actor.downAt, actor.disconnectedAt, actor.firstHeardAt, actor.lastRecvDescAt, actor.offerSentAt, actor.yieldedAt]
  let latest: number | null = null
  for (const time of times) if (time !== null && (latest === null || time > latest)) latest = time
  return latest !== null && world.now - latest < sat ? latest + sat : null
}

/** What Mesh stamps on a fact (observePeerInput, stampAttemptClock): its
 *  room generation, the connection it holds, and its clock (every fact
 *  carries it). */
export const stamp = (world: ActorWorld) => ({ roomEpoch: world.actor.scope.roomEpoch, connectionEpoch: world.meshConnectionEpoch, now: world.now })

/** The supervisor sweep Mesh builds from its facts (mesh.ts:3480-3514). */
export function tickEvent(world: ActorWorld): PeerActorEvent {
  return { type: "clock", snapshot: snapshotOf({ ...world.facts, now: world.now }), ...stamp(world) }
}

/** supervise's per-peer sweep at the world's `now`. */
export function superviseHead(world: ActorWorld): PeerActorEvent {
  world.mesh.tickedAt = world.now
  return tickEvent(world)
}
