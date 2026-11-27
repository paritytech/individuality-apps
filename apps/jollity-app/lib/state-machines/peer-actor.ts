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
  /** #1951: max(localDescribedAt, remoteDescribedAt) + gatherStallMs +
   *  gatherHiddenMs: a connection not yet connected whose gathering holds no
   *  srflx and no relay candidate is rebuilt at it. Armed only on a
   *  connecting link with the round's early rebuild unspent. */
  gatherStallBy: number | null
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
  /** #1951: the early rebuild of a stalled gathering, once a round */
  gatherStallRebuilds: number
  /** #1917: the frozen-link rebuilds this round; at FROZEN_REBUILDS_PER_ROUND the frozen path stops */
  frozenRebuilds: number
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
  /** #1917: the flat-frame sweeps in a row, ending at the latest, on which
   *  inbound packets still rose. A stall whose every sweep counts here is a
   *  frozen decoder on a live link, not a dead transport. */
  frozenSamples: number
  /** #1917: this frozen episode's keyframe ask went out, and the next flat
   *  sweep rebuilds. Rising frames end the episode; a fresh connection starts
   *  without it. */
  frozenAsked: boolean
  framesReadSequence: number
  budgets: PeerBudgets
  deadlines: PeerDeadlines
  /** #1951, this connection's: our first local description was set */
  localDescribedAt: number | null
  /** #1951, this connection's: the peer's first description was applied
   *  (its set-remote-description resolved) */
  remoteDescribedAt: number | null
  /** #1951, this connection's: how long the page was hidden after both
   *  descriptions were in, which the gathering-stall deadline does not count */
  gatherHiddenMs: number
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
  round: ["noVideoRebuilds", "negotiationImmediate", "negotiationUnseen", "glareRebuilds", "frozenRebuilds", "gatherStallRebuilds"],
} as const satisfies Record<string, readonly (keyof PeerBudgets)[]>
type ScopedBudget = (typeof PEER_BUDGET_SCOPE)[keyof typeof PEER_BUDGET_SCOPE][number]
const everyBudgetScoped: Exclude<keyof PeerBudgets, ScopedBudget> extends never ? true : never = true
void everyBudgetScoped

/** The peer's own state besides its budgets, kept across its connections
 *  (rebuildPeer carries presence over) and forgotten with them when it
 *  leaves (removePeer). */
const PEER_LIFETIME_FIELDS = ["lastAttemptAt", "away", "lastSignalAt", "downAt", "everConnected", "firstHeardAt"] as const satisfies readonly (keyof PeerActorState)[]

/** The times that belong to one connection: a replace starts them over. */
export const CONNECTION_TIMES = ["upAt", "connectingSince", "disconnectedAt", "lastRecvDescAt", "offerSentAt", "yieldedAt", "localDescribedAt", "remoteDescribedAt"] as const satisfies readonly (keyof PeerActorState)[]

interface EventEpochs {
  roomEpoch: number
  connectionEpoch: number
  /** Mesh's monotonic clock when it stamped the fact: an attempt the event
   *  makes, and every time the actor keeps, is timed by it. The runner
   *  stamps a completion with its clock. An older saved trace has none on
   *  most facts: the actor then stamps nothing. */
  now?: number
}

/** #1917: a decoder that refreezes is rebuilt at most this often a round; then
 *  the frozen path stops (no ask, no rebuild) and the seat's own rules apply */
export const FROZEN_REBUILDS_PER_ROUND = 2

/** #1523 F5: one ICE restart per stall, then the rebuild — a second restart
 *  while the first's lane offer is still unanswered sends no offer, so the
 *  rebuild would come one attempt late. */
export const STALL_ICE_RESTARTS = 1

/** #1523 F5: one ICE restart per continuously present peer, then nothing until
 *  it leaves (no rebuild rung without hard-SDP authorisation). */
export const UNSEEN_ICE_RESTARTS = 1

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
  /** #1951, one of this connection's candidate and ICE facts as the sweep
   *  reads them (absent, from a trace saved before: no stall): a srflx or
   *  relay candidate was gathered (a relay over TCP or TLS too) */
  srflxOrRelaySeen?: boolean
  /** iceGatheringState is complete */
  gatheringComplete?: boolean
  /** the configuration this connection was made with holds a TURN server */
  turnConfigured?: boolean
  /** relay-only path mode, this connection's or Mesh's now */
  relayOnly?: boolean
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
  | { act: "rebuild"; cause: "failed" | "soft-disconnect" | "connect-by-deadline" | "gathering-stalled" }
)

/** The deadlines of a state, from its times and failures. */
export function armDeadlines(state: Pick<PeerActorState, "disconnectedAt" | "downAt" | "lastSignalAt" | "offerSentAt" | "yieldedAt" | "upAt" | "lastAttemptAt" | "firstHeardAt" | "connectingSince" | "lastRecvDescAt"> & Partial<Pick<PeerActorState, "link" | "localDescribedAt" | "remoteDescribedAt" | "gatherHiddenMs">> & { budgets: Pick<PeerBudgets, "failCount"> & Partial<Pick<PeerBudgets, "gatherStallRebuilds">> }): PeerDeadlines {
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
    gatherStallBy: gatherStallBy(state),
  }
}

/** #1951: when both descriptions of this connection were first in, or null */
const describedAt = (state: Partial<Pick<PeerActorState, "localDescribedAt" | "remoteDescribedAt">>): number | null =>
  state.localDescribedAt == null || state.remoteDescribedAt == null ? null : Math.max(state.localDescribedAt, state.remoteDescribedAt)

/** #1951: the gathering-stall deadline, armed on a connecting link whose
 *  round's early rebuild is unspent, once both descriptions are in. */
function gatherStallBy(state: Partial<Pick<PeerActorState, "link" | "localDescribedAt" | "remoteDescribedAt" | "gatherHiddenMs">> & { budgets: Partial<Pick<PeerBudgets, "gatherStallRebuilds">> }): number | null {
  const from = describedAt(state)
  if (from === null || state.link !== "connecting" || (state.budgets.gatherStallRebuilds ?? 0) > 0) return null
  return from + SUPERVISOR_TIMING.gatherStallMs + (state.gatherHiddenMs ?? 0)
}

/** Every instant at which one of the actor's time comparisons flips, by
 *  whole milliseconds: its deadlines (a strict rule one millisecond after),
 *  the peer-heard return gap. The explorer advances its clock to these. */
export function deadlineInstants(state: PeerActorState): number[] {
  const deadlines = Object.values(state.deadlines).filter((time): time is number => time !== null)
  if (state.lastSignalAt !== null) deadlines.push(state.lastSignalAt + RETURN_GAP_MS + 1)
  return deadlines
}

/** The first instant after `now` at which a comparison flips, or null. */
export function nextDeadline(state: PeerActorState, now: number): number | null {
  let next: number | null = null
  for (const time of deadlineInstants(state)) if (time > now && (next === null || time < next)) next = time
  return next
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
  /** #1951: gatherStallBy is reached (armed only on a connecting link whose
   *  round's early rebuild is unspent), and this connection's gathering holds
   *  no srflx and no relay candidate, has not completed, was made with TURN
   *  and is not relay only (relay only gathers no srflx at all, and a TCP/TLS
   *  relay may take longer: those wait for the ICE timeout) */
  const gatherStalled = reached(d.gatherStallBy) &&
    snapshot.srflxOrRelaySeen === false && snapshot.gatheringComplete === false && snapshot.turnConfigured === true && snapshot.relayOnly === false
  const due = browser === "failed" ||
    (browser === "disconnected" && reached(d.graceBy)) ||
    connectByDue() ||
    gatherStalled
  const unanswered = !due && state.everConnected && !snapshot.laneOpen && snapshot.haveLocalOffer && reached(d.unansweredBy)
  if ((!due && !unanswered) || !backedOff) return done("none")
  if (unanswered) return done("yield")
  // a stalled gathering is rebuilt: an ICE restart would gather on the same connection
  const restart = !gatherStalled && browser === "disconnected" && snapshot.canRestartIce && state.budgets.failCount + 1 <= rules.restartTries && snapshot.laneOpen
  if (restart) return done("restart-ice")
  if (gatherStalled && browser !== "failed") return { markAway, act: "rebuild", cause: "gathering-stalled" }
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
   *  after the actor started. */
  /** haveLocalOffer: the connection holds our offer (signalingState
   *  have-local-offer) at the read. */
  /** packetsMoving (#1917): inbound video packets rose since the sweep
   *  before, read from the same getStats as the frames (absent: not moving).
   *  healDue: the media heals' window is open (no keyframe on its way, the
   *  last heal backed off), without recoveryDue's camera gate on our own
   *  camera; Mesh closes it for a peer whose own view says its camera is off.
   *  frozenAskAfter: the frozen sweeps before the keyframe ask, on either side
   *  (absent: stallAfter); the rebuild still waits for stallAfter in all. */
  | ({ type: "stats-observed"; readSequence: number; framesDecoded: number; browserConnectionState: RTCPeerConnectionState; peerCannotSeeUs?: boolean; noVideoDeadline?: boolean; stallAfter?: number; recoveryDue?: boolean; cameraLive?: boolean; haveLocalOffer?: boolean; packetsMoving?: boolean; healDue?: boolean; frozenAskAfter?: number } & EventEpochs)
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
  /** #1951: our local description was set on this connection (Mesh's
   *  onsignalingstatechange); the actor keeps the first */
  | ({ type: "local-description-set" } & EventEpochs)
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
  /** #1917: ask the peer for a keyframe over the data channel; Mesh holds the
   *  media heals for KEYFRAME_GRACE_MS */
  | { kind: "ask-keyframe" }
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
    frozenSamples: 0,
    frozenAsked: false,
    framesReadSequence: 0,
    budgets: {
      failCount: 0,
      stallHeals: 0,
      unseenHeals: 0,
      noVideoRebuilds: 0,
      negotiationImmediate: 0,
      negotiationUnseen: 0,
      glareRebuilds: 0,
      frozenRebuilds: 0,
      gatherStallRebuilds: 0,
    },
    localDescribedAt: null,
    remoteDescribedAt: null,
    gatherHiddenMs: 0,
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

  // #1951: only the first local description of a connection is kept
  if (event.type === "local-description-set" && (previous.localDescribedAt !== null || event.now === undefined)) return { state: previous, commands: [] }

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
    // #1951: our local offer rolled back is no description of ours: the next one starts the clock
    if (command.kind === "rollback") state.localDescribedAt = null
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
  /** #1917: a frozen episode ends wherever the stall count starts over (a
   *  held sweep, the page hidden, a promotion, a lane renegotiation, an ICE
   *  restart): the next freeze asks afresh, and nothing blocks the ladder. */
  const endFrozenEpisode = () => {
    state.frozenSamples = 0
    state.frozenAsked = false
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
    state.frozenSamples = 0
    state.frozenAsked = false
    state.framesReadSequence = 0
    for (const budget of PEER_BUDGET_SCOPE.connection) state.budgets[budget] = 0
    state.gatherHiddenMs = 0
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
      if (event.lane && event.description === "offer") endFrozenEpisode()
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
          if (decision.cause === "gathering-stalled") state.budgets.gatherStallRebuilds = 1
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
      if (event.lane !== false) endFrozenEpisode()
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
        if (state.stallSamples === 0 && state.frozenSamples === 0 && !state.frozenAsked && state.cameraLive === previous.cameraLive) return { state: previous, commands: [], ignored: "held" }
        state.stallSamples = 0
        endFrozenEpisode()
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
      // #1917: frozen video on a live link. A flat-frame sweep with packets
      // still rising extends the run; one with packets flat (or unread) breaks
      // it, and the stall is a dead transport's, left to the ladder below.
      // Frames rising end the episode.
      if (progress) {
        state.frozenSamples = 0
        state.frozenAsked = false
      } else if (state.framesSeen > 0) state.frozenSamples = event.packetsMoving === true ? state.frozenSamples + 1 : 0
      // The ask comes after frozenAskAfter sweeps on either side: it cannot
      // cause the two ends restarting each other that the answerer's longer
      // wait is for. The rebuild still waits for stallAfter flat sweeps over
      // the episode (the next one past the ask on the initiator).
      const askAfter = event.frozenAskAfter ?? event.stallAfter
      const frozenWindow = !progress && state.framesSeen > 0 && Boolean(askAfter && state.stallSamples >= askAfter && state.frozenSamples >= state.stallSamples)
      const rebuildDue = state.frozenAsked && !progress && state.stallSamples >= Math.max(1, (event.stallAfter ?? 0) - (askAfter ?? 0))
      const frozenBudget = state.budgets.frozenRebuilds < FROZEN_REBUILDS_PER_ROUND
      if ((rebuildDue || (frozenWindow && !state.frozenAsked)) && event.healDue === true && frozenBudget) {
        // no camera gate (recoveryDue's), no stallHeals, never an ICE restart:
        // a keyframe ask, then on the next flat sweep a rebuild through recover()
        state.framesReadSequence = event.readSequence
        state.stallSamples = 0
        state.frozenSamples = 0
        if (state.frozenAsked) {
          state.budgets.frozenRebuilds += 1
          recover("media-frozen", false)
        } else {
          state.frozenAsked = true
          emit({ kind: "ask-keyframe" })
        }
        break
      }
      const stalled = !frozenWindow && !state.frozenAsked && Boolean(event.recoveryDue && event.stallAfter && state.stallSamples >= event.stallAfter)
      if (stalled) {
        state.framesReadSequence = event.readSequence
        state.stallSamples = 0
        state.budgets.stallHeals += 1
        // the rebuild goes through recover
        if (state.budgets.stallHeals <= STALL_ICE_RESTARTS) {
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
        } else if (state.budgets.unseenHeals < UNSEEN_ICE_RESTARTS) {
          state.budgets.unseenHeals += 1
          // the unseen heal restarts the stall count with its ICE restart
          state.stallSamples = 0
          endFrozenEpisode()
          emit({ kind: "restart-ice", cause: "peer-no-video", heal: state.budgets.unseenHeals })
        }
      }
      break
    }
    case "visibility-changed":
      state.hidden = event.hidden
      if (event.hidden) {
        state.stallSamples = 0
        endFrozenEpisode()
      } else {
        // #1951: the time hidden while the gathering-stall deadline was
        // pending does not count: from both descriptions in, or the hide if
        // later, to now, when the page hid before the deadline
        const from = describedAt(state)
        const by = previous.deadlines.gatherStallBy
        if (from !== null && by !== null && now !== undefined && event.hiddenForMs) {
          const hiddenAt = now - event.hiddenForMs
          if (hiddenAt < by) state.gatherHiddenMs += Math.max(0, now - Math.max(hiddenAt, from))
        }
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
      if (!event.standby) endFrozenEpisode()
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
    case "local-description-set":
      state.localDescribedAt = now!
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
        // #1951: the peer's first description on this connection is applied
        if (event.outcome === "resolved" && state.remoteDescribedAt === null && now !== undefined) state.remoteDescribedAt = now
        // The peer's offer is applied: answer it (answerOffer, onLane).
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
