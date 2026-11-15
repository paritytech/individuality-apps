// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * A pure reducer for one remote peer: `stepPeerActor(state, event) →
 * {state, commands}`. Mesh's runner (peer-runner.ts) feeds it every browser,
 * signalling and timer fact and executes its commands (replace, ICE restart,
 * offer, answer, yield). It owns the link axis, the recovery deadlines and the
 * per-connection, per-peer and per-round budgets, and is the mesh's only
 * recovery decision path.
 */
import { backoffMs, RETURN_GAP_MS, SUPERVISOR_TIMING } from "../webrtc/supervisor-timing"

/** The one link axis: where this peer's connection is, moved
 *  only by the browser's facts, a replace, the yield and the close. A
 *  negotiation in flight is what openCommands and remoteOffer hold, and an
 *  ICE restart or a media heal is an attempt (failCount, lastAttemptAt), not a
 *  place. "closed" is the first guard, and the connect-by deadline reads
 *  "connecting" (one deadline per connection). */
export type PeerLink =
  /** this connection has not reached connected yet: created, or any replace */
  | "connecting"
  /** the browser read connected */
  | "connected"
  /** the browser read disconnected or failed (the browser checking again,
   *  connecting or new, leaves it here: a named exemption from the
   *  recovery invariant, missingRecoveryDeadline) */
  | "link-down"
  /** the yield's responder-only connection, waiting for the peer's offer */
  | "yielded"
  /** removed, or the room closed */
  | "closed"

/** The actor's deadlines: one field each, Mesh's
 *  clock, null while unarmed. Each is a function of the actor's own times and
 *  failures, re-armed at the end of every step that moves the state
 *  (armDeadlines), so Mesh never writes one. decideClock reads each as due
 *  at it; a rule with a strict ">" (graceBy, awayBy) has its deadline armed
 *  1 ms past the bound. */
export interface PeerDeadlines {
  /** disconnectedAt + disconnectGraceMs + 1: a disconnected link is due at it */
  graceBy: number | null
  /** downAt + awayAfterMs + 1: the peer is marked away at it */
  awayBy: number | null
  /** downAt + dropChaseMs: a peer just dropped is chased until it */
  chaseUntil: number | null
  /** lastSignalAt + presenceFreshMs: the peer is fresh until it */
  freshUntil: number | null
  /** offerSentAt + answerWaitMs: our statement offer is unanswered at it */
  unansweredBy: number | null
  /** yieldedAt + answerWaitMs: the yield is stranded at it */
  strandedBy: number | null
  /** upAt + connectedWithoutChannelMs: a link up with no channel is rebuilt at it */
  channelBy: number | null
  /** lastAttemptAt + backoffMs(failCount): the next attempt may come at it */
  nextAttemptAt: number | null
  /** max(firstHeardAt, connectingSince) + initialTimeoutMs: this connection
   *  must reach connected by it */
  connectBy: number | null
  /** lastRecvDescAt + negotiationQuietMs: a late description may finish by it */
  quietUntil: number | null
}

type PeerAway = "here" | "said" | "timeout"

export interface PeerActorScope {
  game: number
  roomEpoch: number
  peer: string
}
export interface PeerBudgets {
  failCount: number
  stallHeals: number
  unseenHeals: number
  noVideoRebuilds: number
  negotiationImmediate: number
  negotiationUnseen: number
  glareRebuilds: number
}

export interface PeerActorState {
  scope: PeerActorScope
  roundGeneration: number
  connectionEpoch: number
  commandEpoch: number
  /** The latest issued command of each kind that has not completed yet. A
   *  completion counts only for that command: one for an older attempt of the
   *  same kind, or a second one, is stale. Kinds complete independently. */
  openCommands: Partial<Record<PeerActorCommand["kind"], number>>
  link: PeerLink
  away: PeerAway
  hidden: boolean
  standby: boolean
  initiator: boolean
  cameraLive: boolean
  laneOpen: boolean
  /** The open set-remote-description applies the peer's offer on this wire:
   *  once it is applied, this side answers it. */
  remoteOffer: "statement" | "lane" | null
  /** That offer was refused by the old connection and is applied to the one
   *  rebuilt for it: after the answer, this side makes its own channel and
   *  offers (refusedAndRebuilt). */
  rejoinAnswer: boolean
  lastSignalAt: number | null
  /** When recovery was last attempted on this peer, by Mesh's clock (null:
   *  never). With failCount it is the supervisor's backoff. */
  lastAttemptAt: number | null
  /** The recovery times the supervisor decides from, each
   *  stamped from the fact that moves it, by Mesh's clock (null: never).
   *  This connection's: */
  /** the link last reached connected; null while it is not connected */
  upAt: number | null
  /** this connection started connecting */
  connectingSince: number | null
  /** the link read disconnected (the grace clock); cleared by connected, connecting and new */
  disconnectedAt: number | null
  /** a description of the peer's was last applied to this connection */
  lastRecvDescAt: number | null
  /** our statement offer went out on this connection; a lane offer clears it */
  offerSentAt: number | null
  /** this connection is the yield's responder-only one */
  yieldedAt: number | null
  /** The peer's own, over its connections: */
  /** the link went down after it had been up: the clock "away" reads. Kept
   *  over a replace, cleared by connected, and restarted when the peer comes
   *  back while the link is still down (markBack) */
  downAt: number | null
  /** the link to this peer reached connected at least once */
  everConnected: boolean
  /** the peer was first heard */
  firstHeardAt: number | null
  framesSeen: number
  stallSamples: number
  framesReadSequence: number
  budgets: PeerBudgets
  deadlines: PeerDeadlines
}

/** How long each of a peer's budgets lives, as Mesh keeps them:
 *  per connection (conn), per peer until it leaves (history and the per-peer
 *  maps, which removePeer clears), or per round (the maps setRound clears).
 *  A replace starts the connection's over (the actor's own, and one Mesh
 *  makes itself, told by connection-replaced-externally), a removal the
 *  peer's, a round change the round's. A budget not listed fails to compile. */
const PEER_BUDGET_SCOPE = {
  connection: ["stallHeals"],
  peer: ["failCount", "unseenHeals"],
  round: ["noVideoRebuilds", "negotiationImmediate", "negotiationUnseen", "glareRebuilds"],
} as const satisfies Record<string, readonly (keyof PeerBudgets)[]>
type ScopedBudget = (typeof PEER_BUDGET_SCOPE)[keyof typeof PEER_BUDGET_SCOPE][number]
const everyBudgetScoped: Exclude<keyof PeerBudgets, ScopedBudget> extends never ? true : never = true
void everyBudgetScoped

/** The peer's own state besides its budgets, kept across its connections
 *  (rebuildPeer carries presence over) and forgotten with them when it
 *  leaves (removePeer). */
const PEER_LIFETIME_FIELDS = ["lastAttemptAt", "away", "lastSignalAt", "downAt", "everConnected", "firstHeardAt"] as const satisfies readonly (keyof PeerActorState)[]

/** The times that belong to one connection: a replace starts them over. */
const CONNECTION_TIMES = ["upAt", "connectingSince", "disconnectedAt", "lastRecvDescAt", "offerSentAt", "yieldedAt"] as const satisfies readonly (keyof PeerActorState)[]

interface EventEpochs {
  roomEpoch: number
  connectionEpoch: number
  /** Mesh's monotonic clock when it stamped the fact: an attempt the event
   *  makes, and every time the actor keeps, is timed by it. The runner
   *  stamps a completion with its clock. An older saved trace has none on
   *  most facts: the actor then stamps nothing. */
  now?: number
}

/** Back after this long in the background, every link is swept at once
 *  instead of waiting out backoffs counted while the phone could not answer. */
export const KICK_AFTER_HIDDEN_MS = 8000

/** Stamped by the runner when a statement description comes from a remote
 *  session other than the one this connection holds: the connection belongs
 *  to the peer's previous boot and must be replaced first. */
interface NewRemoteSession {
  at: number
}

/** Where Mesh ran the command a completion reports. A rejected command has
 *  a different outcome at each site, and the actor's open command holds only
 *  its epoch, so Mesh stamps the site. */
export type PeerCommandSite =
  /** restart-ice: the supervisor's recovery */
  | "supervisor-recovery"
  /** restart-ice: watchMedia's stall heal */
  | "media-stall"
  /** restart-ice: the heal for a peer that cannot see our video */
  | "peer-no-video"
  /** restart-ice: networkChanged */
  | "network-change"
  /** our statement offer (offerOnStatement) */
  | "statement-offer-sent"
  /** a remote statement offer applied (the first try) */
  | "statement-offer-received"
  /** the same remote offer on the connection rebuilt for it */
  | "statement-offer-retried"
  /** a remote statement answer, or the local steps of our statement answer */
  | "statement-answer"
  /** any SDP step on the lane, the codec guard's among them */
  | "lane"

/** The class of a rejection, stamped by Mesh from the error and the PC at the
 *  call site: a hard SDP error (InvalidAccessError, InvalidStateError,
 *  OperationError), InvalidAccessError on a statement offer, a connection
 *  that never took a description or made a channel, or anything else. */
type PeerRejectionReason = "hard-sdp" | "invalid-access" | "virgin-pc" | "other"

/** What Mesh.supervise reads at one sweep that has no fact of its own: the
 *  browser's reads, Mesh's away mark, its video count and the
 *  round's video proof. Every time comes from the actor's own state. */
export interface ClockSnapshot {
  browserConnectionState: RTCPeerConnectionState
  /** the connection holds our offer (signalingState have-local-offer) */
  haveLocalOffer: boolean
  localDescription: boolean
  remoteDescription: boolean
  /** a data channel exists, open or not */
  hasChannel: boolean
  /** the data channel is open, as Mesh reads it at the sweep */
  laneOpen: boolean
  /** Mesh's away mark (the peer shown away), as it reads it at the sweep */
  away: "said" | "timeout" | null
  /** Mesh's decoded-frame count for the peer */
  framesSeen: number
  /** video from the peer was seen this round */
  sawVideoThisRound: boolean
  canRestartIce: boolean
}

/** What the supervisor does with one peer at one sweep. */
export type SupervisorDecision = {
  /** the link stayed down past awayAfterMs: the peer is marked away */
  markAway: boolean
} & (
  | { act: "none" }
  /** connected, the channel never opened: rebuild once a round */
  | { act: "channel-never-opened" }
  /** yielded and no offer came: re-initiate */
  | { act: "stranded" }
  /** our statement offer went unanswered: yield to the peer */
  | { act: "yield" }
  | { act: "restart-ice" }
  | { act: "rebuild"; cause: "failed" | "soft-disconnect" | "connect-by-deadline" }
)

/** The deadlines of a state, from its times and failures. */
export function armDeadlines(state: Pick<PeerActorState, "disconnectedAt" | "downAt" | "lastSignalAt" | "offerSentAt" | "yieldedAt" | "upAt" | "lastAttemptAt" | "firstHeardAt" | "connectingSince" | "lastRecvDescAt"> & { budgets: Pick<PeerBudgets, "failCount"> }): PeerDeadlines {
  const t = SUPERVISOR_TIMING
  const after = (at: number | null, ms: number) => (at === null ? null : at + ms)
  return {
    graceBy: after(state.disconnectedAt, t.disconnectGraceMs + 1),
    awayBy: after(state.downAt, t.awayAfterMs + 1),
    chaseUntil: after(state.downAt, t.dropChaseMs),
    freshUntil: after(state.lastSignalAt, t.presenceFreshMs),
    unansweredBy: after(state.offerSentAt, t.answerWaitMs),
    strandedBy: after(state.yieldedAt, t.answerWaitMs),
    channelBy: after(state.upAt, t.connectedWithoutChannelMs),
    nextAttemptAt: after(state.lastAttemptAt, backoffMs(state.budgets.failCount)),
    connectBy: state.firstHeardAt === null || state.connectingSince === null
      ? null
      : Math.max(state.firstHeardAt, state.connectingSince) + t.initialTimeoutMs,
    quietUntil: after(state.lastRecvDescAt, t.negotiationQuietMs),
  }
}

/** Every instant at which one of the actor's time comparisons flips, by
 *  whole milliseconds: its deadlines (a strict rule one millisecond after),
 *  the peer-heard return gap. The explorer advances its clock to these. */
export function deadlineInstants(state: PeerActorState): number[] {
  const deadlines = Object.values(state.deadlines).filter((time): time is number => time !== null)
  if (state.lastSignalAt !== null) deadlines.push(state.lastSignalAt + RETURN_GAP_MS + 1)
  return deadlines
}

/** Mesh.supervise's rules for one peer, in its order, from the actor's
 *  deadlines and the sweep's snapshot. A pure calculation. A connected link
 *  has one rule: a link up with no channel, no video and no frames past
 *  channelBy is rebuilt (channel-never-opened), once a round and after the
 *  backoff. Otherwise: mark away, said holds, the presence gate, stranded,
 *  due, unanswered, backoff, restart or rebuild. */
export function decideClock(state: PeerActorState, now: number, snapshot: ClockSnapshot): SupervisorDecision {
  const rules = SUPERVISOR_TIMING
  const d = state.deadlines
  const none: SupervisorDecision = { markAway: false, act: "none" }
  const reached = (deadline: number | null) => deadline !== null && now >= deadline
  const before = (deadline: number | null) => deadline !== null && now < deadline
  const backedOff = d.nextAttemptAt === null || now >= d.nextAttemptAt
  if (snapshot.browserConnectionState === "connected") {
    const neverOpened = !snapshot.sawVideoThisRound && snapshot.framesSeen === 0 && !snapshot.laneOpen && reached(d.channelBy)
    return neverOpened && state.budgets.noVideoRebuilds === 0 && backedOff ? { markAway: false, act: "channel-never-opened" } : none
  }
  const markAway = snapshot.away === null && state.everConnected && reached(d.awayBy)
  const done = (act: "none" | "stranded" | "yield" | "restart-ice"): SupervisorDecision => ({ markAway, act })
  if (snapshot.away === "said") return done("none")
  if (!before(d.freshUntil) && !before(d.chaseUntil)) return done("none")
  if (reached(d.strandedBy) && !snapshot.localDescription && !snapshot.remoteDescription) {
    // initiateStrandedPeer acts only on a connection with no channel
    return done(snapshot.hasChannel ? "none" : "stranded")
  }
  /** connectBy's late-hearer guards */
  const connectByDue = (): boolean => {
    // every connection not up yet; a link-down reading connecting again is the
    // named exemption, and a never-up peer is link-down
    // only by failed, which rebuilds at once
    if (state.link !== "connecting" || !reached(d.connectBy)) return false
    const heardBack = state.lastRecvDescAt !== null
    if (heardBack && before(d.quietUntil)) return false
    return state.initiator ? heardBack || !before(d.unansweredBy) : !heardBack
  }
  const browser = snapshot.browserConnectionState
  const due = browser === "failed" ||
    (browser === "disconnected" && reached(d.graceBy)) ||
    connectByDue()
  const unanswered = !due && state.everConnected && !snapshot.laneOpen && snapshot.haveLocalOffer && reached(d.unansweredBy)
  if ((!due && !unanswered) || !backedOff) return done("none")
  if (unanswered) return done("yield")
  const restart = browser === "disconnected" && snapshot.canRestartIce && state.budgets.failCount + 1 <= rules.restartTries && snapshot.laneOpen
  if (restart) return done("restart-ice")
  return { markAway, act: "rebuild", cause: browser === "failed" ? "failed" : browser === "disconnected" ? "soft-disconnect" : "connect-by-deadline" }
}

/** Design B's recovery invariant, for the explorer's D monitor and the
 *  room's liveness probe: an open actor whose link is not connected holds
 *  the deadline decideClock acts on for that link (connectBy, graceBy,
 *  strandedBy or unansweredBy; a failed PC acts at once), or one of the named
 *  exemptions holds it. The reason it fails, or null. */
export function missingRecoveryDeadline(state: PeerActorState, now: number, snapshot: ClockSnapshot): string | null {
  if (state.link === "connected" || state.link === "closed") return null
  if (state.hidden || snapshot.away === "said") return null
  const d = state.deadlines
  const before = (deadline: number | null) => deadline !== null && now < deadline
  // the presence gate: a peer neither heard lately nor just dropped is left to presence
  if (!before(d.freshUntil) && !before(d.chaseUntil)) return null
  if (snapshot.browserConnectionState === "failed") return null
  if (d.unansweredBy !== null && snapshot.haveLocalOffer) return null
  if (state.link === "yielded") return d.strandedBy !== null ? null : "yielded with no strandedBy"
  if (state.link === "connecting") return d.connectBy !== null ? null : "connecting with no connectBy"
  if (state.link === "link-down") {
    if (d.graceBy !== null) return null
    // the named exemption: an ever-connected link-down whose browser checks again
    if (snapshot.browserConnectionState === "connecting" || snapshot.browserConnectionState === "new") return null
  }
  return "link-down with no graceBy"
}

export type PeerActorEvent =
  | ({ type: "peer-heard"; at: number } & EventEpochs)
  | ({ type: "peer-away"; away: "said" | "timeout" | "back" } & EventEpochs)
  | ({ type: "description-observed"; departedSession?: boolean; lane: boolean; description?: "offer" | "answer"; newRemoteSession?: NewRemoteSession } & EventEpochs)
  /** localOffer: the connection held our offer, which went to the peer's old
   *  session (onPeerSession grants the answerer's offer then). negotiated
   *  false: the connection took no description, so it holds nothing of the
   *  old session (an older saved trace has none: negotiated). initiate is
   *  this side's role, which older saved traces carry: the rebuild is an
   *  offerer's on either side, so Mesh does not stamp it and the decision
   *  does not read it. */
  | ({ type: "peer-session-changed"; at: number; localOffer?: boolean; negotiated?: boolean } & EventEpochs)
  /** connecting and new: the browser is checking again (an ICE restart) or
   *  holds a fresh connection. Mesh restarts the grace and the link is not
   *  up; the actor's link stays as it was. */
  | ({ type: "connection-observed"; state: "connected" | "disconnected" | "failed" | "connecting" | "new" } & EventEpochs)
  | ({ type: "channel-observed"; state: "open" | "closed" } & EventEpochs)
  | ({ type: "local-offer-requested"; lane: boolean } & EventEpochs)
  /** The clock: one sweep of the supervisor over this
   *  peer, every 3 s while the page shows, with what it read of the browser.
   *  The actor decides every supervisor cause, the answer wait and the
   *  stranded yield from its deadlines at `now`. */
  | ({ type: "clock"; now: number; snapshot: ClockSnapshot } & EventEpochs)
  | ({ type: "glare-observed"; remoteCarriesVideo: boolean; polite?: boolean; lane: boolean } & EventEpochs)
  | ({ type: "codec-guard-rtx" } & EventEpochs)
  /** Our lane offer was set, and then the round or the connection moved on;
   *  haveLocalOffer: the connection still holds that offer. */
  | ({ type: "local-offer-superseded"; haveLocalOffer: boolean } & EventEpochs)
  /** cameraLive: our own camera as the sweep reads it (a live video track),
   *  when Mesh stamps it: the unseen heal waits for it, and it can come up
   *  after the actor started. haveLocalOffer: the connection holds our offer
   *  (signalingState have-local-offer) at the read. */
  | ({ type: "stats-observed"; readSequence: number; framesDecoded: number; browserConnectionState: RTCPeerConnectionState; peerCannotSeeUs?: boolean; noVideoDeadline?: boolean; stallAfter?: number; recoveryDue?: boolean; cameraLive?: boolean; haveLocalOffer?: boolean } & EventEpochs)
  /** keyframe false: the page was never marked away, so Mesh asks for no
   *  keyframe and only sweeps after a long absence (setSelfAway's kick). */
  | ({ type: "visibility-changed"; hidden: boolean; hiddenForMs?: number; keyframe?: false } & EventEpochs)
  | ({ type: "standby-changed"; standby: boolean } & EventEpochs)
  /** inferred: a link's gathering found a new local address, and the OS
   *  announced no change; onNewNetwork: this connection's own gathering
   *  already holds that new address; browserConnectionState: the
   *  connection's state as Mesh reads it then (#1608). */
  | ({ type: "network-changed"; inferred?: boolean; onNewNetwork?: boolean; browserConnectionState?: RTCPeerConnectionState } & EventEpochs)
  | ({ type: "ice-policy-changed" } & EventEpochs)
  | ({ type: "round-changed"; roundGeneration: number } & EventEpochs)
  | ({
      type: "command-completed"
      commandEpoch: number
      commandKind: PeerActorCommand["kind"]
      /** stale: Mesh bailed after an await because the PC moved on (the codec
       *  guard), and the command had no effect. */
      outcome: "resolved" | "rejected" | "stale"
      site?: PeerCommandSite
      reason?: PeerRejectionReason
      /** The round the lane operation began in: a hard lane error counts
       *  only in that round (laneNegotiationFailed). */
      roundGeneration?: number
      /** When Mesh heard the peer: a refused offer's rejoin takes it as the
       *  peer's last signal. */
      at?: number
      /** A send-offer's: our statement offer went out (makeStatementOffer),
       *  which starts its answer wait, or our lane offer was set
       *  (offerOnLane), which ends it. */
      offer?: "sent-statement" | "set-lane"
      /** A rejected statement answer's (applyStatementAnswer): the connection
       *  still holds our offer (have-local-offer), which no answer now completes. */
      haveLocalOffer?: boolean
      /** A stale statement answer's (sendStatementAnswer): our own offer took
       *  the answer's place on the connection, so the answer was never sent. */
      displaced?: true
    } & EventEpochs)
  | ({ type: "peer-removed" } & EventEpochs)
  | ({ type: "room-closed" } & EventEpochs)
  /** The connection Mesh holds is not the actor's: Mesh replaced it itself,
   *  outside any actor command (the manual Reconnect, the e2e rebuild hooks,
   *  the departed-session initiate), or the actor fell behind or ahead of it.
   *  connectionEpoch is MESH's connection; the actor adopts it as its own
   *  replace would, without a command (Mesh has rebuilt already). The
   *  attempt is `now`, or Mesh's own lastAttemptAt for a connection it made
   *  earlier (null: never). */
  | ({ type: "connection-replaced-externally" } & EventEpochs)

export type PeerActorCommand = (
  /** heal: the media heal's count after this one (the stall's stallHeals,
   *  the unseen heal's unseenHeals), which Mesh's "(heal n)" line prints */
  | { kind: "restart-ice"; cause: string; heal?: number }
  | { kind: "yield-responder" }
  /** answererMayOffer: the leave to offer this replace grants the answerer of
   *  the pair, decided from the fact it answers (a new signalling session over
   *  our offer); Mesh grants it at the replace. Mesh keeps the leave itself
   *  (its answererMayOffer set), and grants or clears it in its own effects
   *  for every other recovery: the actor keeps no copy. */
  | { kind: "replace-connection"; cause: string; initiate: boolean; answererMayOffer?: true; heal?: number }
  | { kind: "set-remote-description"; lane: boolean }
  | { kind: "rollback"; cause: "glare" | "codec-guard" | "superseded" }
  | { kind: "ignore-offer" }
  | { kind: "create-channel" }
  | { kind: "send-offer"; lane: boolean }
  | { kind: "send-answer"; lane: boolean }
  | { kind: "replace-video-track"; track: "camera" | null }
  | { kind: "request-keyframe" }
  | { kind: "sweep" }
  | { kind: "configure-ice" }
  | { kind: "close-connection" }
  /** the link stayed down: the peer is shown away (Mesh.setAway "timeout") */
  | { kind: "mark-away" }
  /** the peer is back: Mesh's away mark is cleared (Mesh.setAway(null)) */
  | { kind: "mark-back" }
) & {
  commandEpoch: number
  connectionEpoch: number
  /** the peer's failures when the command was emitted: the n of Mesh's
   *  "self-heal: … (attempt n)" lines */
  attempt?: number
  /** the clock of the fact the command was decided on: the attempt's
   *  instant, which Mesh times the heal record and the media backoff by
   *  An older saved trace has none. */
  at?: number
}

type UnstampedPeerActorCommand = PeerActorCommand extends infer Command
  ? Command extends { commandEpoch: number; connectionEpoch: number; attempt?: number; at?: number }
    ? Omit<Command, "commandEpoch" | "connectionEpoch" | "attempt" | "at">
    : never
  : never

export interface PeerActorStep {
  state: PeerActorState
  commands: PeerActorCommand[]
  ignored?: "closed" | "stale-room" | "stale-connection" | "stale-command" | "departed-session" | "held" | "idle"
}

/** `everConnected` and `firstHeardAt`: Mesh's history of a peer that left and
 *  rejoins, which its new actor starts from (startActor). */
export function createPeerActorState(scope: PeerActorScope, options: Partial<Pick<PeerActorState, "initiator" | "standby" | "cameraLive" | "connectionEpoch" | "everConnected" | "firstHeardAt" | "connectingSince">> = {}): PeerActorState {
  const state: Omit<PeerActorState, "deadlines"> = {
    scope,
    roundGeneration: 0,
    connectionEpoch: options.connectionEpoch ?? 1,
    commandEpoch: 0,
    openCommands: {},
    link: "connecting",
    away: "here",
    hidden: false,
    standby: options.standby ?? false,
    initiator: options.initiator ?? true,
    cameraLive: options.cameraLive ?? true,
    laneOpen: false,
    remoteOffer: null,
    rejoinAnswer: false,
    lastSignalAt: null,
    lastAttemptAt: null,
    upAt: null,
    connectingSince: options.connectingSince ?? null,
    disconnectedAt: null,
    lastRecvDescAt: null,
    offerSentAt: null,
    yieldedAt: null,
    downAt: null,
    everConnected: options.everConnected ?? false,
    firstHeardAt: options.firstHeardAt ?? null,
    framesSeen: 0,
    stallSamples: 0,
    framesReadSequence: 0,
    budgets: {
      failCount: 0,
      stallHeals: 0,
      unseenHeals: 0,
      noVideoRebuilds: 0,
      negotiationImmediate: 0,
      negotiationUnseen: 0,
      glareRebuilds: 0,
    },
  }
  return { ...state, deadlines: armDeadlines(state) }
}

const clone = (state: PeerActorState): PeerActorState => ({ ...state, scope: { ...state.scope }, budgets: { ...state.budgets }, openCommands: { ...state.openCommands } })

export function stepPeerActor(previous: PeerActorState, event: PeerActorEvent): PeerActorStep {
  if (previous.link === "closed") return { state: previous, commands: [], ignored: "closed" }
  if (event.roomEpoch !== previous.scope.roomEpoch) return { state: previous, commands: [], ignored: "stale-room" }
  if (event.type === "connection-replaced-externally") {
    // The fact names the connection Mesh holds: the one the actor holds
    // already (its own replace) is no news; any other, newer or older, is
    // Mesh's, and the actor moves to it.
    if (event.connectionEpoch === previous.connectionEpoch) return { state: previous, commands: [], ignored: "stale-connection" }
  } else if (event.connectionEpoch !== previous.connectionEpoch && event.type !== "round-changed" && event.type !== "room-closed") {
    return { state: previous, commands: [], ignored: "stale-connection" }
  }

  // A sweep delivered while the page is hidden (a replay, the runner) holds:
  // nothing is swept in the background.
  if (event.type === "clock" && previous.hidden) return { state: previous, commands: [], ignored: "held" }
  // A supervisor sweep that does nothing is the common case, every few
  // seconds per peer: it is decided before anything is copied.
  const sweep = event.type === "clock" ? decideClock(previous, event.now, event.snapshot) : null
  if (sweep && !sweep.markAway && sweep.act === "none") return { state: previous, commands: [], ignored: "idle" }

  // The browser checking again with nothing up and no grace running changes nothing.
  if (event.type === "connection-observed" && (event.state === "connecting" || event.state === "new") && previous.disconnectedAt === null) {
    return { state: previous, commands: [] }
  }

  const state = clone(previous)
  const commands: PeerActorCommand[] = []
  /** The fact's clock. A trace saved before every fact carried it has none,
   *  and then nothing is stamped. */
  const now = event.now
  /** Issue a command carrying the failures and fact clock that Mesh logs and
   *  times the attempt by. */
  const emit = (command: UnstampedPeerActorCommand) => {
    state.commandEpoch += 1
    state.openCommands[command.kind] = state.commandEpoch
    commands.push({ ...command, commandEpoch: state.commandEpoch, connectionEpoch: state.connectionEpoch, attempt: state.budgets.failCount, ...(now === undefined ? {} : { at: now }) } as PeerActorCommand)
  }
  /** An attempt, timed by the fact's stamp (recover, yieldToPeer, a network
   *  change and every replace set lastAttemptAt). The runner
   *  stamps a completion too (a rejected restart's or lane error's rebuild). */
  const attempted = () => {
    if (now !== undefined) state.lastAttemptAt = now
  }
  /** The peer is back (setAway(null), or the sweep after a return from the
   *  background): the failures and the last
   *  attempt were counted against a phone that was not there. */
  const forgive = () => {
    state.budgets.failCount = 0
    state.lastAttemptAt = null
  }
  /** The away mark goes back to here (Mesh's markBack): the failures are
   *  forgiven, and a link still down gets a fresh budget before it reads
   *  away again (its downAt restarts). */
  const comeBack = () => {
    if (state.away !== "here") {
      forgive()
      if (state.downAt !== null && now !== undefined) state.downAt = now
    }
    state.away = "here"
  }
  /** The peer left (removePeer): everything of its own starts over. */
  const forgetPeer = () => {
    const fresh = createPeerActorState(state.scope)
    const forget = <Field extends (typeof PEER_LIFETIME_FIELDS)[number]>(field: Field) => { state[field] = fresh[field] }
    for (const field of PEER_LIFETIME_FIELDS) forget(field)
    for (const budget of PEER_BUDGET_SCOPE.peer) state.budgets[budget] = fresh.budgets[budget]
  }
  /** A fresh connection at `epoch` (rebuildPeer): what the actor knew of the
   *  old one starts over, the peer's own and the round's stay. An attempt. */
  const startConnection = (epoch: number) => {
    attempted()
    // Commands issued for the old connection can no longer complete.
    state.openCommands = {}
    state.remoteOffer = null
    state.rejoinAnswer = false
    state.connectionEpoch = epoch
    state.link = "connecting"
    for (const time of CONNECTION_TIMES) state[time] = null
    if (now !== undefined) state.connectingSince = now
    state.laneOpen = false
    state.framesSeen = 0
    state.stallSamples = 0
    state.framesReadSequence = 0
    for (const budget of PEER_BUDGET_SCOPE.connection) state.budgets[budget] = 0
  }
  /** `heal`: a media heal's count, taken before the fresh connection zeroes it */
  const replace = (cause: string, initiate: boolean, grant = false, heal?: number) => {
    startConnection(state.connectionEpoch + 1)
    emit({ kind: "replace-connection", cause, initiate, ...(grant ? { answererMayOffer: true as const } : {}), ...(heal === undefined ? {} : { heal }) })
  }
  /** Apply a remote description; the peer's offer is answered once applied.
   *  Mesh times it as the peer's latest description on this connection,
   *  unless it retries an offer an old connection refused. */
  const applyRemote = (lane: boolean, offer: boolean, retry = false) => {
    state.remoteOffer = offer ? (lane ? "lane" : "statement") : null
    state.rejoinAnswer = false
    if (!retry && now !== undefined) state.lastRecvDescAt = now
    emit({ kind: "set-remote-description", lane })
  }
  /** yieldToPeer: our offer went unanswered, so a responder-only connection
   *  waits for the peer's offer. */
  const yieldToPeer = () => {
    state.budgets.failCount += 1
    emit({ kind: "yield-responder" })
    replace("answer-timeout-yield", false)
    state.link = "yielded"
    if (now !== undefined) state.yieldedAt = now
  }
  /** initiateStrandedPeer: a fresh connection this side offers on (Mesh
   *  grants its leave to offer with the channel), for a peer just heard
   *  (heardOnFresh). Its offer comes from the local-offer-requested Mesh
   *  sends then. */
  const reinitiate = (cause: string) => {
    replace(cause, false)
    if (now !== undefined) state.lastSignalAt = now
    emit({ kind: "create-channel" })
  }
  /** An ICE restart, or a rebuild (Mesh lets the answerer offer). */
  const recover = (cause: string, restart: boolean, heal?: number) => {
    state.budgets.failCount += 1
    if (restart) {
      attempted()
      emit({ kind: "restart-ice", cause })
    } else replace(cause, true, false, heal)
  }
  /** The peer is away, by its word or by a link that stayed down. */
  const setAway = (away: "said" | "timeout" | "back") => {
    if (away === "back") {
      // a "back" may land after another fact brought the peer here already:
      // the failures start over all the same
      forgive()
      comeBack()
    } else state.away = away
  }
  /** The peer started a new session: it is back, and the connection is replaced. */
  const startRemoteSession = (cause: string, initiate: boolean, at: number, grant = false) => {
    comeBack()
    state.lastSignalAt = at
    replace(cause, initiate, grant)
  }

  switch (event.type) {
    case "peer-heard": {
      const gap = state.lastSignalAt === null ? 0 : event.at - state.lastSignalAt
      if (gap > RETURN_GAP_MS && state.away !== "here") comeBack()
      state.lastSignalAt = event.at
      if (state.firstHeardAt === null) state.firstHeardAt = event.at
      break
    }
    case "peer-away":
      setAway(event.away)
      // Mesh sends "back" only while it shows the peer away, and its mark is
      // cleared by this command whatever the actor held (an earlier fact may
      // have brought the peer back here already)
      if (event.away === "back") emit({ kind: "mark-back" })
      break
    case "description-observed":
      if (event.departedSession) return { state: previous, commands: [], ignored: "departed-session" }
      if (event.newRemoteSession && !event.lane && event.description !== undefined) {
        // An answer was made for the old connection's offer: it is not applied
        // to the fresh one, and the answerer of the pair may offer anew.
        if (event.description === "answer") {
          startRemoteSession("description-session-rejoin", true, event.newRemoteSession.at)
          break
        }
        startRemoteSession("description-session-rejoin", false, event.newRemoteSession.at)
        applyRemote(false, true)
        break
      }
      // Mesh clears away and takes the signal as fresh only on a statement
      // description: a hidden phone's late lane frame is not the phone coming back.
      if (!event.lane) comeBack()
      // The initiator renegotiating the lane may be a stall heal of its own;
      // this side's count starts over so the answerer never doubles that
      // restart. A remote answer answers our offer and leaves the count alone.
      if (event.lane && event.description === "offer") state.stallSamples = 0
      applyRemote(event.lane, event.description === "offer")
      break
    case "peer-session-changed":
      // A connection that negotiated nothing holds nothing of the old
      // session: onPeerSession leaves it, and the peer, as they are.
      if (event.negotiated === false) return { state: previous, commands: [] }
      // onPeerSession: our offer went to the peer's old session, so the
      // answerer offers anew on the rebuilt connection. Either side rebuilds
      // as an offerer; Mesh's mayOffer
      // (the answerer's leave to offer) decides the channel.
      // That leave comes from this fact alone, not from a grant held since an
      // earlier recovery: the replace carries it to Mesh.
      startRemoteSession("signalling-session-rejoin", true, event.at, event.localOffer === true && !state.initiator)
      break
    case "connection-observed":
      if (event.state === "connected") {
        state.everConnected = true
        if (state.upAt === null && now !== undefined) state.upAt = now
        state.disconnectedAt = null
        state.downAt = null
        // a peer marked away is back with the link (setAway(null)); the
        // failures start over either way
        comeBack()
        state.link = "connected"
        state.budgets.failCount = 0
        break
      }
      if (event.state === "connecting" || event.state === "new") {
        // the grace restarts; the link stays as it was (a named exemption
        // from the recovery invariant); the actor's up time is kept
        state.disconnectedAt = null
        break
      }
      state.upAt = null
      if (now !== undefined) {
        // the grace runs from the first disconnected; "away" from the first
        // drop of a link that was up, through restarts and rebuilds
        if (event.state === "disconnected" && state.disconnectedAt === null) state.disconnectedAt = now
        if (state.downAt === null && state.everConnected) state.downAt = now
      }
      state.link = "link-down"
      break
    case "channel-observed":
      state.laneOpen = event.state === "open"
      break
    case "local-offer-requested":
      // our own offer leaves the stall count alone, as offerOnLane does
      emit({ kind: "send-offer", lane: event.lane })
      break
    case "clock": {
      const decision = sweep!
      if (decision.markAway) {
        setAway("timeout")
        emit({ kind: "mark-away" })
      }
      switch (decision.act) {
        case "channel-never-opened":
          state.budgets.noVideoRebuilds = 1
          recover("channel-never-opened", false)
          break
        case "stranded":
          reinitiate("stranded-yield-unanswered")
          break
        case "yield":
          yieldToPeer()
          break
        case "restart-ice":
          recover("soft-disconnect", true)
          break
        case "rebuild":
          recover(decision.cause, false)
          break
      }
      break
    }
    case "glare-observed":
      // A statement glare is a description from the peer, so it is the peer
      // back, as description-observed has it. A lane glare is an offer on the
      // open lane: it restarts the answerer's stall count before the
      // collision handling, and leaves presence and failures alone.
      if (event.lane === false) comeBack()
      else state.stallSamples = 0
      if (event.polite === false) {
        emit({ kind: "ignore-offer" })
      } else if (event.lane && event.remoteCarriesVideo && state.budgets.glareRebuilds === 0) {
        state.budgets.glareRebuilds = 1
        state.budgets.failCount += 1
        replace("lane-glare-video", true)
      } else {
        if (event.lane) {
          emit({ kind: "rollback", cause: "glare" })
          applyRemote(true, true)
        } else emit({ kind: "ignore-offer" })
      }
      break
    case "codec-guard-rtx":
      // the guard holds our lane offer, which is set: the statement offer's
      // answer wait ended with it (offerOnLane), whatever its completion says
      state.offerSentAt = null
      emit({ kind: "rollback", cause: "codec-guard" })
      emit({ kind: "send-offer", lane: true })
      break
    case "local-offer-superseded":
      // offerOnLane rolls a superseded offer back only while it is still set
      if (!event.haveLocalOffer) return { state: previous, commands: [] }
      emit({ kind: "rollback", cause: "superseded" })
      break
    case "stats-observed": {
      if (event.cameraLive !== undefined) state.cameraLive = event.cameraLive
      if (state.hidden || state.away !== "here" || state.standby || event.browserConnectionState !== "connected") {
        if (state.stallSamples === 0 && state.cameraLive === previous.cameraLive) return { state: previous, commands: [], ignored: "held" }
        state.stallSamples = 0
        return { state, commands: [], ignored: "held" }
      }
      if (event.readSequence < state.framesReadSequence) return { state: previous, commands: [], ignored: "stale-command" }
      if (event.noVideoDeadline && event.framesDecoded <= 0) {
        // A rebuild already spent this round is skipped, and the sweep carries
        // on to the heals below. #1607: a link that still holds our unanswered
        // offer gets a second one this round; its offer can only be answered
        // on a fresh connection, and nothing else acts on a connected link
        // (without it, a link stayed dark for most of a round).
        const spent = state.budgets.noVideoRebuilds
        if (spent === 0 || (spent === 1 && event.haveLocalOffer === true)) {
          // through recover
          state.budgets.noVideoRebuilds = spent + 1
          recover("connected-no-video", false)
          break
        }
      }
      // No inbound video stat yet: the link is still wiring up, and the
      // sweep moves on before either heal, so neither the stall count nor the
      // unseen heal runs. The read still counts as taken.
      if (event.framesDecoded < 0) {
        state.framesReadSequence = event.readSequence
        break
      }
      const progress = event.framesDecoded > state.framesSeen || (event.framesDecoded > 0 && event.framesDecoded < state.framesSeen)
      if (progress) state.stallSamples = 0
      else if (state.framesSeen > 0) state.stallSamples += 1
      const stalled = Boolean(event.recoveryDue && event.stallAfter && state.stallSamples >= event.stallAfter)
      if (stalled) {
        state.framesReadSequence = event.readSequence
        state.stallSamples = 0
        state.budgets.stallHeals += 1
        // the rebuild goes through recover
        if (state.budgets.stallHeals <= 2) {
          emit({ kind: "restart-ice", cause: "media-stall", heal: state.budgets.stallHeals })
        } else recover("media-stall", false, state.budgets.stallHeals)
        break
      }
      state.framesReadSequence = event.readSequence
      if (progress) {
        state.framesSeen = event.framesDecoded
        state.budgets.stallHeals = 0
      }
      if (event.peerCannotSeeUs && state.initiator && state.cameraLive) {
        if (state.budgets.negotiationImmediate > 0 && state.budgets.negotiationUnseen === 0) {
          state.budgets.negotiationUnseen = 1
          replace("peer-no-video-hard-sdp", true)
        } else if (state.budgets.unseenHeals < 2) {
          state.budgets.unseenHeals += 1
          // the unseen heal restarts the stall count with its ICE restart
          state.stallSamples = 0
          emit({ kind: "restart-ice", cause: "peer-no-video", heal: state.budgets.unseenHeals })
        }
      }
      break
    }
    case "visibility-changed":
      state.hidden = event.hidden
      if (event.hidden) {
        state.stallSamples = 0
      } else {
        if (event.keyframe !== false) emit({ kind: "request-keyframe" })
        if ((event.hiddenForMs ?? 0) > KICK_AFTER_HIDDEN_MS) {
          // the timeout mark and the failures were counted against our own
          // absence: the peer is shown back, and every link is swept now
          if (state.away === "timeout") setAway("back")
          else forgive()
          emit({ kind: "sweep" })
        }
      }
      break
    case "standby-changed":
      state.standby = event.standby
      // setStandby restarts the stall count on promotion; the heals a stall
      // had are left as they are
      if (!event.standby) state.stallSamples = 0
      emit({ kind: "replace-video-track", track: event.standby ? null : "camera" })
      break
    case "network-changed":
      // A link already gathered on the new network has nothing to repair, and
      // on a change only inferred from a new address a connected link is left
      // to its own supervision: repairing either breaks a working link (#1608)
      if (event.onNewNetwork || (event.inferred && event.browserConnectionState === "connected")) return { state: previous, commands: [], ignored: "idle" }
      // networkChanged times the attempt on every link, restart or rebuild
      attempted()
      if (state.laneOpen) {
        emit({ kind: "restart-ice", cause: "network-change" })
      } else replace("network-change", true)
      break
    case "ice-policy-changed":
      emit({ kind: "configure-ice" })
      break
    case "round-changed":
      if (event.roundGeneration <= state.roundGeneration) return { state: previous, commands: [], ignored: "stale-command" }
      state.roundGeneration = event.roundGeneration
      for (const budget of PEER_BUDGET_SCOPE.round) state.budgets[budget] = 0
      break
    case "command-completed":
      if (state.openCommands[event.commandKind] !== event.commandEpoch) {
        return { state: previous, commands: [], ignored: "stale-command" }
      }
      delete state.openCommands[event.commandKind]
      // our statement offer's answer wait starts when it goes out; a lane offer set ends it
      if (event.offer === "set-lane") state.offerSentAt = null
      else if (event.offer === "sent-statement" && now !== undefined) state.offerSentAt = now
      if (event.commandKind === "set-remote-description") {
        // The peer's offer is applied: answer it (statement or lane).
        const offer = state.remoteOffer
        state.remoteOffer = null
        if (offer !== null && event.outcome === "resolved") {
          emit({ kind: "send-answer", lane: offer === "lane" })
          break
        }
        state.rejoinAnswer = false
      } else if (event.commandKind === "send-answer") {
        // The answer to the offer a refusing connection was rebuilt for is
        // followed by this side's own channel and offer; a stale bail
        // returned before them. The offer comes from the local-offer-requested
        // Mesh sends then.
        const rejoin = state.rejoinAnswer
        state.rejoinAnswer = false
        if (rejoin && event.outcome === "resolved") {
          emit({ kind: "create-channel" })
          break
        }
        // #1606: our own offer took the answer's place, so the peer's offer is
        // never answered. The polite side's offer is ignored by the impolite
        // peer, which waits for an answer: a fresh responder takes the peer's
        // offer again and answers it. The impolite side's offer wins the glare
        // (the polite peer rolls back and answers), so it does nothing.
        if (event.outcome === "stale" && event.displaced === true && !state.initiator) {
          replace("answer-displaced-rejoin", false)
          applyRemote(false, true, true)
          break
        }
      }
      if (event.outcome !== "rejected") break
      // A rejection's outcome depends on the site that ran the command.
      // Every case not named here is only logged and changes nothing; an
      // unstamped rejection is one of those.
      switch (event.commandKind) {
        case "restart-ice":
          // the supervisor's recovery and a network change fall through to a rebuild; the stall
          // and unseen heals only log.
          if (event.site === "supervisor-recovery" || event.site === "network-change") {
            replace(`${event.site}-restart-failed`, true)
          }
          break
        case "send-offer":
        case "send-answer":
        case "rollback":
        case "set-remote-description":
          if (event.site === "lane") {
            // laneNegotiationFailed: a hard error in the round the operation
            // began in spends the round's immediate rebuild, as
            // the round's immediate hard-SDP budget does; anything else is logged.
            if (event.reason !== "hard-sdp" || (event.roundGeneration ?? state.roundGeneration) !== state.roundGeneration) break
            if (state.budgets.negotiationImmediate > 0) break
            state.budgets.negotiationImmediate = 1
            replace("hard-sdp-immediate", true)
          } else if (event.commandKind === "set-remote-description" && event.site === "statement-answer") {
            // #1605: the peer's answer refused while our offer still holds the
            // connection: nothing completes that offer, so a fresh connection
            // offers at once. A refusal on a connection that left the offer (a
            // late or second answer) is only logged. The round's immediate
            // hard-SDP rebuild bounds it, as on the lane.
            if (event.haveLocalOffer !== true || state.budgets.negotiationImmediate > 0) break
            state.budgets.negotiationImmediate = 1
            replace("answer-refused", true)
          } else if (event.commandKind === "set-remote-description" && event.site === "statement-offer-received") {
            if (event.reason === "virgin-pc") {
              reinitiate("stranded-offer-refused")
            } else if (event.reason === "invalid-access") {
              // A rejoin rebuild: the peer is back (Mesh clears its away mark
              // with the rebuild, as part of this replace), a fresh responder
              // hears it now, and the offer is applied to it; its answer is
              // followed by this side's channel and offer (refusedAndRebuilt).
              comeBack()
              if (event.at !== undefined) state.lastSignalAt = event.at
              replace("offer-refused-rejoin", false)
              applyRemote(false, true, true)
              state.rejoinAnswer = true
            }
          }
          break
      }
      break
    case "connection-replaced-externally":
      // Mesh rebuilt already: the actor takes the connection as its own
      // replace would, and issues nothing.
      startConnection(event.connectionEpoch)
      break
    case "peer-removed":
      // removePeer: a genuine leave forgets the peer's own; the round's stay
      forgetPeer()
    // falls through
    case "room-closed":
      state.link = "closed"
      emit({ kind: "close-connection" })
      break
    default:
      // a type the actor does not know, e.g. from an older saved trace
      throw new Error(`unsupported peer actor event: ${(event as { type: string }).type}`)
  }
  // every deadline follows the times and failures the step moved
  state.deadlines = armDeadlines(state)
  return { state, commands }
}
