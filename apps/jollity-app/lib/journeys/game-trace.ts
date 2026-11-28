// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * ONE GAME, ONE TRACE: journey.join, journey.game and journey.payoff for this
 * device, kept in module memory across /game, /prize-draw and /collectables
 * (client-side navigation keeps it; a reload starts afresh).
 *
 * The session (lib/game-session.ts), the mesh (lib/webrtc/useMesh.ts), the
 * camera (lib/camera.ts) and the payoff pages call the functions below at
 * the moments they already mark; this module decides which journey and step
 * each moment belongs to. Framework-free, no Sentry: it speaks lib/telemetry.
 */
import { devLog, getDevLogEntries } from "../debug/log-store"
import { beginInvariantSession, funnelOrderBreach, logStoppedBeforePayoff, noteInvariant, payoffForAnotherGame } from "../invariants"
import { pageHidden, watchPageHidden } from "../page-lifecycle"
import { enterScene, leaveAllScenes, leaveScene, recordHeap } from "../telemetry/smoothness"
import { clearGameSessionState, noteSessionChange, setSessionProbe } from "../telemetry/session-record"
import { connectionAttrs, flushMetrics, recordCount, recordDistribution, reportAwayPeriod, reportFailure, reportHealCohort, reportHealEpisode, reportLinkFailed, reportNoVideoChoice, sendGameLog, setGameIndex, startJourney, type Attrs, type Journey, type Step } from "../telemetry"
import { closeDeliveryHealthGame } from "../telemetry/delivery-health"
import { sendTelemetryHealth } from "../telemetry/health-event"
import type { CameraFailure } from "../webrtc/media"
import { observeIce, observeTurnOutcome, type IceEvent } from "../webrtc/ice"
import type { FunnelStage } from "../webrtc/funnel"
import type { StoreCalibration, StoreClockEvent, SubmitEvent } from "@jollity/statement-core"
import { gatheredAttr, UNSUPPORTED, type GatherSnapshot } from "../webrtc/gather"
import type { RtcEvent } from "../webrtc/rtc-events"
import { drawFacts, drawUnplayable, type DrawState } from "./payoff-facts"
import type { WheelCheck } from "../draw/wheel/rule"
import { rtcPath } from "./peer-path"
import { cleanReason, recordTurnOutcome } from "./turn-outcome"
import { recordFunnelStage, roleAttrs } from "./rtc-funnel"
import { resetDecoders, trackDecoders } from "./rtc-decoder"
import { resetImplChanges, trackImplChanges } from "./rtc-impl"
import { resetPaths, trackPaths } from "./rtc-path"
import { beginGameLogOutbox, checkpointGameLog } from "../telemetry/game-log-outbox"
import { pairAttrs } from "./rtc-pair"
import { spsTapAttrs } from "./rtc-sps"
import { recordSignalRtt, recordStoreCalibration, recordStoreClockEvent, recordSubmitEvent, submitFailureAttrs, recordStoreInterrupted, recordStoreResubscribe } from "./rtc-signal"
import { recordStall, recoveredVia, stallStartAttrs } from "./rtc-stall"
import { healAttrs, recordHeal } from "./rtc-heal"
import { recordGather } from "./rtc-gather"
import { watchNetwork, type NetChange } from "./net-changes"
import {
  closeRtcRound,
  countPathChange,
  flushRtcCoverageSlice,
  noteLinkSeen,
  noteLinkStage,
  observeRtc,
  isRtcStandby,
  openRtcRound,
  recordResume,
  rtcPeerIndex,
  startRtcGame,
  type RtcReading,
} from "./rtc-quality"

export { setRtcStandby } from "./rtc-quality"

export interface MeshObservation {
  /** per-peer connection state (Mesh.health()) */
  states: ReadonlyMap<string, RTCPeerConnectionState>
  /** per-peer rows with the selected candidate pair (Mesh.report()) */
  reports: readonly { id: string; ice: string; pair?: string; stage?: FunnelStage; gathered?: GatherSnapshot }[]
  /** peers with live evidence on the signalling channel */
  present: ReadonlySet<string>
  /** TURN servers configured for this room */
  turnServers: number
}

interface Trace {
  join: Journey<"join"> | null
  game: Journey<"game"> | null
  payoff: Journey<"payoff"> | null
  /** wall ms of the handover — the end-of-game log starts here */
  joinedAt: number
  gameIndex: number | null
  /** this device's own account (the mesh's id), for the pair id */
  self: string | null
  /** the round the mesh last opened for (0-based): the round of a join's links */
  meshRound: number | null
  clockOffset: string
  camera: Step | null
  cameraReadyAt: number | null
  meshOpen: boolean
  peerFirst: Step | null
  peerAll: Step | null
  /** the latest rows of the mesh's report: each peer's last funnel stage, for a
   *  join that ends with the peer still pending */
  reports: MeshObservation["reports"]
  /** what has already gone out once this mesh, keyed `<kind>|<key>` (see
   *  `once`): a peer's gathering (so the report's copy for a pair that never
   *  connected is not a second one), each distinct icecandidateerror and each
   *  failed submit, one step each */
  sent: Set<string>
  /** open rtc.peer steps, by peer */
  peers: Map<string, Step>
  /** connected peers whose rtc.peer waits for the candidate pair (the mesh
   *  reports it from an async getStats loop, a tick or more after connected) */
  awaitingPath: Map<string, AwaitingPath>
  /** every present peer connected while a pair was still on its way: the
   *  join ends full once the last one lands */
  fullPending: boolean
  /** the join opened once play had begun: it outlives the round start so its
   *  link timings can land, and ends "late" (full, or at LATE_JOIN_DEADLINE_MS) */
  lateJoin: boolean
  lateTimer: ReturnType<typeof setTimeout> | null
  failedPeers: Set<string>
  /** peers seen connected at least once */
  connectedOnce: Set<string>
  /** wall ms the first / the last-needed peer link came up (join's "video after X") */
  firstLinkAt: number | null
  allLinksAt: number | null
  /** peers connected at the last observation */
  connectedNow: number
  reconnects: Map<string, Step>
  /** one open span per peer that is away right now */
  aways: Map<string, Step>
  stopIce: (() => void) | null
  /** the network watcher (net-changes.ts): it outlives the join, which ends
   *  before the game does, so it is stopped by the game's end, not the join's */
  stopNet: (() => void) | null
  round: { index: number; step: Step } | null
  /** global turn on screen, for next-open restart diagnostics */
  turn: number | null
  stall: Step | null
  cameraRecover: Step | null
  confirm: Step | null
  landed: Step | null
  payoffGame: number | null
  /** wall ms the payoff journey began: the log-stops-before-payoff invariant's
   *  boundary (lib/invariants.ts) */
  payoffStartedAt: number | null
  /** the first stamp of each funnel stage each peer reached this mesh, for the
   *  ordering invariant: a stage stamped before the stage that causes it is a
   *  broken funnel (lib/invariants.ts FUNNEL_CAUSAL_PAIRS) */
  stages: Map<string, Map<FunnelStage, number>>
  attestations: Step | null
  attestationsTimer: ReturnType<typeof setTimeout> | null
  draw: Step | null
  collectables: Step | null
  stalledStage: string | null
  /** the sign-up's reason for skipping the draws, carried to the payoff */
  signupSkip: string | null
  /** draw-unplayable goes out once per trace */
  unplayableSent: boolean
  /** a lookup of this player's own key came back empty this join */
  ownKeyMissed: boolean
  /** own-key-missing went out: once per join */
  ownKeyReported: boolean
}

interface AwaitingPath {
  step: Step
  connectedAt: number
  timer: ReturnType<typeof setTimeout>
}

function fresh(): Trace {
  return {
    join: null,
    game: null,
    payoff: null,
    joinedAt: 0,
    gameIndex: null,
    self: null,
    meshRound: null,
    clockOffset: "0",
    camera: null,
    cameraReadyAt: null,
    meshOpen: false,
    peerFirst: null,
    peerAll: null,
    reports: [],
    sent: new Set(),
    peers: new Map(),
    awaitingPath: new Map(),
    fullPending: false,
    lateJoin: false,
    lateTimer: null,
    failedPeers: new Set(),
    connectedOnce: new Set(),
    firstLinkAt: null,
    allLinksAt: null,
    connectedNow: 0,
    reconnects: new Map(),
    aways: new Map(),
    stopIce: null,
    stopNet: null,
    round: null,
    turn: null,
    stall: null,
    cameraRecover: null,
    confirm: null,
    landed: null,
    payoffGame: null,
    payoffStartedAt: null,
    stages: new Map(),
    attestations: null,
    attestationsTimer: null,
    draw: null,
    collectables: null,
    stalledStage: null,
    signupSkip: null,
    unplayableSent: false,
    ownKeyMissed: false,
    ownKeyReported: false,
  }
}

let trace: Trace = fresh()

// The relay credential outcome of each mesh open goes to the join, or to the
// game once the join has ended (a later round's mesh asks again). One
// subscription for the page's life: with no journey open it does nothing.
observeTurnOutcome((outcome) => {
  const journey = live(trace.join) ?? live(trace.game)
  if (journey) recordTurnOutcome(journey, outcome, pairRound())
})
let leaveTimer: ReturnType<typeof setTimeout> | undefined
let pagehideInstalled = false

/** The journey while it is open, else null: nothing below records on one
 *  that has ended. */
function live<N extends "join" | "game" | "payoff">(journey: Journey<N> | null): Journey<N> | null {
  return journey && !journey.ended ? journey : null
}

// what the last-session record keeps of a game (lib/telemetry/session-record.ts):
// a live join or game, the game, and the video links the mesh last saw up
setSessionProbe(() => ({
  inGame: !!(live(trace.join) || live(trace.game)),
  gameIndex: trace.gameIndex ?? undefined,
  turn: trace.turn ?? undefined,
  liveVideo: trace.connectedNow,
}))

// ── the join ────────────────────────────────────────────────────────────────

export function beginJoin(start: { cameraWarm: boolean }): void {
  if (leaveTimer) {
    clearTimeout(leaveTimer)
    leaveTimer = undefined
  }
  if (live(trace.join) || live(trace.game)) return
  const signupSkip = trace.signupSkip
  // a payoff the player never finished belongs to the last game
  if (live(trace.payoff)) endPayoff(trace.stalledStage ?? openPayoffStage())
  trace = fresh()
  // a new game is a new session's worth of invariants (lib/invariants.ts):
  // the dedupe set must not swallow game N+1's line because game N had one
  beginInvariantSession()
  trace.stopNet = watchNetwork(noteNetworkChange)
  startRtcGame() // the peers are numbered from the join on: its funnel points carry the index
  resetPaths()
  resetDecoders()
  resetImplChanges()
  trace.signupSkip = signupSkip
  leaveAllScenes() // a game scene a previous game left open
  trace.joinedAt = Date.now()
  const warm = start.cameraWarm ? "true" : "false"
  trace.join = startJourney("join", { "camera.warm": warm, ...connectionAttrs() }, { ownsLifecycle: true })
  trace.camera = trace.join.step("camera.acquire", { "camera.warm": warm })
  // a miss of the player's own key that came before this join opened
  const held = heldOwnKeyMiss
  heldOwnKeyMiss = null
  if (held) claimOwnKeyMiss(trace.join, held.miss, held.signup)
  trace.stopIce = observeIce(iceStep)
  installPagehide()
  noteSessionChange()
}

export function noteGame(gameIndex: number, clockOffset: number, reportEnds?: number): void {
  if (trace.gameIndex === gameIndex) return
  const firstRead = trace.gameIndex === null
  trace.gameIndex = gameIndex
  // the first game/seat read at the handover: from /game mounting to the chain's answer
  if (firstRead) live(trace.join)?.step("chain.read", {}, { startedAt: trace.joinedAt }).end()
  trace.clockOffset = String(clockOffset)
  trace.join?.set({ "game.index": String(gameIndex), "clock.offset": trace.clockOffset, ...signUpAttrs() })
  setGameIndex(gameIndex)
  beginGameLogOutbox(gameIndex)
  // the marker the late log upload looks for (lib/telemetry/game-log.ts)
  const endsAt = reportEnds === undefined ? undefined : (reportEnds - clockOffset) * 1000
  devLog("telemetry", `game ${gameIndex} handover`, {
    game: gameIndex,
    at: trace.joinedAt,
    ...(endsAt === undefined ? {} : { endsAt }),
  })
  checkpointGameLog("handover")
}

export function cameraSettled(camera: { kind: "live" } | { kind: "unavailable"; reason: CameraFailure }): void {
  const step = trace.camera
  if (!step || step.ended) return
  if (camera.kind === "live") {
    trace.cameraReadyAt = Date.now()
    step.end({ "camera.state": "ready" })
  } else step.end({ "camera.state": "unavailable", "camera.reason": camera.reason })
}

/** wall ms the room's statement subscription opened (the first one wins), for
 *  `statements.first_page`. Outside Trace: the subscription can open before
 *  /game's join does. Cleared when a join ends, so it never reaches into the
 *  next game. */
let statementsOpenedAt: number | null = null
/** this join's first page already left: a later subscription is not a step */
let statementsDone = false

/** the caller of lib/host/statement-store.ts: the host subscription opened */
export function statementsSubscribed(): void {
  if (statementsDone) return
  statementsOpenedAt ??= Date.now()
}

/** the subscription delivered a page. Only the first counts, and only while
 *  a join is open. */
export function statementsFirstPage(): void {
  const openedAt = statementsOpenedAt
  if (openedAt === null) return
  statementsOpenedAt = null
  const join = live(trace.join)
  if (!join) return
  statementsDone = true
  join.step("statements.first_page", {}, { startedAt: openedAt }).end()
}

/** What `readSignUpSurface` (lib/host/game-registration.ts) found for a game. */
export interface SignUpFacts {
  surface: string
  humanityRead: string
}

/** the sign-up surface of the game it was read for (null: the game was not
 *  known). Outside Trace, like `statementsOpenedAt`: the first key lookup,
 *  which reads it, can run before /game's join opens, and a join then gets it
 *  once its game is known */
let signUpSurface: { gameIndex: number | null; facts: SignUpFacts } | null = null

/** the sign-up surface, when it was read for the game this trace is in (or
 *  either game is still unknown) */
function currentSignUp(): SignUpFacts | null {
  const known = signUpSurface
  if (!known) return null
  return known.gameIndex === null || trace.gameIndex === null || known.gameIndex === trace.gameIndex ? known.facts : null
}

function signUpAttrs(): Record<string, string> {
  const facts = currentSignUp()
  return facts ? { "signup.surface": facts.surface, "signup.humanity_read": facts.humanityRead } : {}
}

/** Which surface signed this player up for `gameIndex`, and how the read of
 *  Humanity's store went: `signup.surface` and `signup.humanity_read` on the
 *  join and the game. A refused read shows on every join, even when the
 *  surface is known from Jollity's own store. */
export function noteSignUpSurface(gameIndex: number | null, facts: SignUpFacts): void {
  signUpSurface = { gameIndex, facts }
  const attrs = signUpAttrs()
  live(trace.join)?.set(attrs)
  live(trace.game)?.set(attrs)
}

/** Why this player's own key was or was not found, and which kept key matched
 *  (lib/host/communication-key.ts `OwnKeyLookup`). */
export interface OwnKeyOutcome {
  cause: string
  source?: string
}

/** A lookup of this player's own key that found none: its cause, how the reads
 *  of the kept keys went, the host's words for a refusal, and the Humanity
 *  product whose storage was read. */
export interface OwnKeyMiss {
  cause: "no-identifier" | "read-refused" | "no-match" | "no-answer"
  reads?: { own: string; humanity: string }
  refusal?: string
  humanityProduct: string
}

/** a lookup of this player's own signalling key came back: "true" when it was
 *  not found (none kept matches the identifier on chain, none on chain, or the
 *  reads gave up), and its sealed signalling links with nobody; "false" once a
 *  later try finds it. Marked on the join and the game, so a report puts dark
 *  video down to the key, and not to ICE, only while the key was missing.
 *  With the `outcome`, `rtc.own_key.cause` says why, `rtc.own_key.source`
 *  which kept key matched, and `rtc.own_key.recovered` that a later try found
 *  a key a lookup of this join had missed. */
export function signallingKeyLookedUp(found: boolean, outcome?: OwnKeyOutcome): void {
  const attrs: Record<string, string> = { "rtc.no_signalling_key": found ? "false" : "true" }
  if (outcome) attrs["rtc.own_key.cause"] = outcome.cause
  if (found && outcome?.source) attrs["rtc.own_key.source"] = outcome.source
  if (found && trace.ownKeyMissed) attrs["rtc.own_key.recovered"] = "true"
  if (!found) trace.ownKeyMissed = true
  // a player whose key turned up sends nothing for a miss held for a join
  else heldOwnKeyMiss = null
  live(trace.join)?.set(attrs)
  live(trace.game)?.set(attrs)
}

/** a miss that came while no join or game was open: held for the next join,
 *  which claims it, so a later `beginJoin` cannot make it a second event */
let heldOwnKeyMiss: { miss: OwnKeyMiss; signup: Promise<SignUpFacts | null> } | null = null

/** The `own-key-missing` failure, at most once per join, on the first miss
 *  whose cause is not a read that gave no answer (a hung host read is not this
 *  bug, and the next try may well find the key). The join is claimed, and its
 *  span captured, at the miss; the event goes to that span once `signup`, the
 *  sign-up surface read for the game, is back. A miss with no join or game
 *  open waits for the next join. The values ride the event's context, never
 *  its message, so each cause is one issue. Never throws. */
export function ownKeyMissed(miss: OwnKeyMiss, signup: Promise<SignUpFacts | null>): void {
  if (miss.cause === "no-answer") return
  const journey = live(trace.join) ?? live(trace.game)
  if (!journey) {
    heldOwnKeyMiss ??= { miss, signup }
    return
  }
  claimOwnKeyMiss(journey, miss, signup)
}

function claimOwnKeyMiss(journey: Journey, miss: OwnKeyMiss, signup: Promise<SignUpFacts | null>): void {
  if (trace.ownKeyReported) return
  trace.ownKeyReported = true
  void signup
    .catch(() => null)
    .then((facts) => sendOwnKeyMissing(journey, miss, facts))
}

function sendOwnKeyMissing(journey: Journey, miss: OwnKeyMiss, signup: SignUpFacts | null): void {
  const context: Record<string, string> = { humanity_product: miss.humanityProduct }
  if (miss.reads) {
    context.own_read = miss.reads.own
    context.humanity_read = miss.reads.humanity
  }
  if (miss.refusal !== undefined) context.refusal = cleanReason(miss.refusal)
  if (signup) {
    context["signup.surface"] = signup.surface
    context["signup.humanity_read"] = signup.humanityRead
  }
  reportFailure("own-key-missing", { reason: miss.cause, context }, journey)
}

/** The game this trace is in, once the session has said (`noteGame`): what
 *  the sign-up surface is read for, without a chain read of its own. */
export function currentGameIndex(): number | null {
  return trace.gameIndex
}

function iceStep(event: IceEvent): void {
  const join = live(trace.join)
  if (!join) return
  if (event.kind === "cached") {
    join.set({ "turn.cached": "true" })
    return
  }
  join
    .step(event.kind === "proof" ? "turn.proof" : "turn.issue", { "turn.ok": event.ok ? "true" : "false" }, { startedAt: event.startedAt })
    .end({}, { endedAt: event.endedAt })
}

/** the pair id of this device and `peer`, in the round being played, or else
 *  the round the mesh opened for (a join's links are that round's) */
function pairIds(peer: string): Record<string, string> {
  return pairAttrs(trace.gameIndex, trace.self, peer, pairRound())
}

/** the 1-based round a link's telemetry is filed under right now */
function pairRound(): number {
  return (trace.round?.index ?? trace.meshRound ?? 0) + 1
}

/** the attributes of an rtc step about one peer: its index in this game
 *  (never its account), the pair, and `extra` */
const peerStepAttrs = (peer: string, extra: Attrs = {}): Attrs => ({ "rtc.peer": String(rtcPeerIndex(peer)), ...pairIds(peer), ...extra })

/** the attributes every rtc metric of a link carries */
const linkAttrs = (peer: string): Record<string, string> => ({ ...pairIds(peer), "rtc.peer": String(rtcPeerIndex(peer)), round: String(pairRound()) })

/** where an rtc step goes: the join, or the game once the join has ended */
const rtcJourney = () => live(trace.join) ?? live(trace.game)

/** true the first time `key` is seen of this `kind` since the mesh opened */
function once(kind: string, key: string): boolean {
  const id = `${kind}|${key}`
  if (trace.sent.has(id)) return false
  trace.sent.add(id)
  return true
}

/** the funnel's last word on a pair that did not connect: the last stage its
 *  mesh row reported, and what the connection had gathered (host/srflx/relay) */
const lastStageAttr = (peer: string): Record<string, string> => {
  const row = trace.reports.find((report) => report.id === peer)
  return { "rtc.last_stage": row?.stage ?? "none", ...(row?.gathered ? { "rtc.gathered": gatheredAttr(row.gathered.counts) } : {}) }
}

/**
 * Everything the mesh tells of a link (lib/webrtc/rtc-events.ts), one switch:
 *  - stage: a funnel step, as `rtc.funnel_ms` (lib/webrtc/funnel.ts), and a
 *    stamp for the round's rtc.link row (rtc-link.ts)
 *  - gather: a finished gathering, its candidates by type, time and errors
 *  - ice_error: an icecandidateerror, spanned once per distinct code and host
 *    on the join (or the game once that has ended); the counts ride the gathering
 *  - heal: a finished self-heal attempt, `rtc.heal_ms` and an `rtc.heal` span
 *  - heal_cohort: one typed Logs record for a near-simultaneous failure wave
 *  - link_failed: one typed Logs record for an established link that failed
 *    (lib/telemetry/link-failed.ts)
 *  - heal_episode: one typed Logs record and duration distribution per episode
 *  - away_period: one typed Logs record and duration distribution per period
 *  - resume: a link's video back after a return from the background,
 *    `rtc.resume_ms` (lib/journeys/rtc-quality.ts recordResume)
 *  - signal_rtt: an answer came back to an offer of ours, by the route it took
 *  - negotiation_error: a hard lane SDP failure, counted and put on the journey
 *  - sps: the first key frame's SPS on a link, from the tap (#629): once per
 *    pair, an rtc.sps count carrying its fields, the tap's cost, wait and
 *    frames read as distributions, and an rtc.sps step. A link the tap never
 *    attached to sends the count and step with outcome "untapped" and a reason
 *  - codec_guard: an RTX-unsafe engine whose codec preferences did not hold
 *    (#559), counted by reason and put on the journey
 */
export function recordMeshEvent(peerId: string, event: RtcEvent): void {
  const link = linkAttrs(peerId)
  switch (event.kind) {
    case "stage": {
      // the ordering invariant, before the stamp is kept: a stage that arrived
      // before a stage causing it is a broken funnel (lib/invariants.ts)
      let stamped = trace.stages.get(peerId)
      if (!stamped) trace.stages.set(peerId, (stamped = new Map()))
      const breach = funnelOrderBreach(stamped, event)
      if (breach) {
        noteInvariant({
          kind: "funnel-out-of-order",
          valueMs: Math.round(breach.causeMs - breach.effectMs),
          detail: {
            stage: breach.effect,
            "invariant.cause_stage": breach.cause,
            "invariant.stage_ms": Math.round(event.ms),
            "invariant.cause_ms": Math.round(breach.causeMs),
            "invariant.effect_ms": Math.round(breach.effectMs),
            ...(link["rtc.pair"] === undefined ? {} : { "rtc.pair": link["rtc.pair"] }),
          },
        })
      }
      // keep the FIRST stamp of each stage: a later re-stamp must not move a
      // stage's time and hide (or invent) the next breach
      if (!stamped.has(event.stage)) stamped.set(event.stage, event.ms)
      recordFunnelStage(event, { ...roleAttrs(trace.self, peerId), ...link, ...(isRtcStandby(peerId) ? { "rtc.standby": "true" } : {}) })
      noteLinkStage(peerId, pairRound() - 1, event.stage, event.ms) // for the round's rtc.link row
      return
    }
    case "gather":
      once("gather", peerId)
      recordGather(event, link)
      return
    case "ice_error":
      if (once("ice", `${link["rtc.pair"] ?? peerId}|${event.code}|${event.host}`))
        rtcJourney()?.step("rtc.ice_error", peerStepAttrs(peerId, { "rtc.error_code": event.code, "rtc.error_host": event.host })).end()
      return
    case "heal": {
      recordHeal(event, link)
      const endedAt = Date.now()
      rtcJourney()?.step("rtc.heal", peerStepAttrs(peerId, healAttrs(event)), { startedAt: endedAt - event.healMs }).end({}, { endedAt })
      return
    }
    case "heal_cohort":
      reportHealCohort(event)
      return
    case "link_failed":
      // the event's own `kind` is the mesh's discriminator: linkFailedAttributes reads failKind
      reportLinkFailed(event, link)
      return
    case "heal_episode":
      reportHealEpisode(event, link)
      recordDistribution("rtc.heal_episode_ms", event.ms, "millisecond", {
        ...link,
        "rtc.heal_episode_result": event.healed ? "healed" : "unhealed",
        "rtc.heal_end": event.end,
      })
      return
    case "away_period":
      reportAwayPeriod(event, link)
      recordDistribution("rtc.away_ms", event.ms, "millisecond", link)
      return
    case "resume":
      recordResume(event, link)
      return
    case "signal_rtt":
      recordSignalRtt(event, { ...roleAttrs(trace.self, peerId), ...link })
      return
    case "negotiation_error": {
      const attrs = {
        "rtc.error_name": event.name,
        "rtc.negotiation_stage": event.stage,
        "rtc.negotiation_operation": event.operation,
        "rtc.negotiation_reason": event.reason,
      }
      recordCount("rtc.negotiation_error", 1, { ...attrs, ...link })
      rtcJourney()?.step("rtc.negotiation_error", peerStepAttrs(peerId, attrs)).end()
      return
    }
    case "sps": {
      if (!once("sps", link["rtc.pair"] ?? peerId)) return
      const attrs = spsTapAttrs(event)
      const tap = { "rtc.sps.engine": event.engine, "rtc.sps.outcome": event.outcome, ...link }
      recordCount("rtc.sps", 1, { ...attrs, ...link })
      if (event.outcome !== "untapped") {
        recordDistribution("rtc.sps.cost_ms", event.inspectMs + event.attachMs, "millisecond", tap)
        recordDistribution("rtc.sps.to_key_ms", event.toKeyMs, "millisecond", tap)
        recordDistribution("rtc.sps.frames", event.frames, "none", tap)
      }
      rtcJourney()?.step("rtc.sps", peerStepAttrs(peerId, attrs)).end()
      return
    }
    case "codec_guard": {
      const attrs = { "rtc.codec_guard_reason": event.reason }
      recordCount("rtc.codec_guard", 1, { ...attrs, ...link })
      rtcJourney()?.step("rtc.codec_guard", peerStepAttrs(peerId, attrs)).end()
      return
    }
  }
}

/** A gathering that never completed (a pair that failed, or a join that ended
 *  with it pending) still says what it had by the time we gave up: its counts
 *  and errors go out from the mesh row, once, with no time. */
function sendUnfinishedGather(peer: string): void {
  const gathered = trace.reports.find((report) => report.id === peer)?.gathered
  if (gathered && once("gather", peer)) recordGather(gathered, linkAttrs(peer))
}

/** The statement store transport's submit pipe told us something (statement-core
 *  `onSubmit`): a back-off, a wait for a slot, or a failure. Counted per frame
 *  and reason, under the pair of the peer the frame was for; a failure is also
 *  spanned, once per frame and peer. */
export function signalSubmit(event: SubmitEvent): void {
  recordSubmitEvent(event, event.to ? linkAttrs(event.to) : { round: String(pairRound()) })
  if (event.kind !== "failed" || !once("submit", `${event.frame}|${event.to ?? ""}`)) return
  rtcJourney()?.step("rtc.signal", { ...(event.to ? peerStepAttrs(event.to) : {}), ...submitFailureAttrs(event) }).end()
}

/** The host ended the room's statement subscription; it is opened again
 *  (lib/host/statement-store.ts). Counted, since a room that hears nobody
 *  cannot connect anyone. */
export function statementsInterrupted(reason: string): void {
  recordStoreInterrupted(reason)
}

/** The statement subscription was opened again after the host ended it. */
export function statementsResubscribed(attempt: number): void {
  recordStoreResubscribe(attempt)
}

/** The store clock (lib/store-clock.ts) learned its acceptance margin, or a
 *  statement was rejected for time on both stamps: a metric, and a line in the
 *  debug sheet either way. */
export function storeClockEvent(event: StoreClockEvent): void {
  if (event.kind === "learned")
    devLog("statement", `store clock: margin ${event.marginMs} ms over ${event.base} time (was ${event.previousMs} ms)`)
  else devLog("statement", `store clock: rejected for time on both stamps (margin ${event.marginMs} ms): ${event.reason}`, undefined, "warn")
  recordStoreClockEvent(event)
}

/** The waiting room's store-clock calibration finished (lib/store-calibration.ts). */
export function storeCalibrated(result: StoreCalibration): void {
  devLog(
    "statement",
    `store calibration ${result.outcome} in ${result.durationMs} ms, margin ${result.marginMs} ms${result.reason ? `: ${result.reason}` : ""}`,
    undefined,
    result.outcome === "failed" || result.outcome === "rejected" ? "warn" : "info",
  )
  recordStoreCalibration(result)
}

/** `self` is this device's account and `round` the 0-based round the mesh
 *  opened for: together they name the pair on every rtc step and metric */
export function meshOpened(self: string, round: number | null): void {
  trace.self = self
  trace.meshRound = round
  trace.sent.clear() // a new mesh gathers and signals afresh
  trace.stages.clear() // and stamps its funnel afresh (the ordering invariant)
  const join = live(trace.join)
  if (!join || trace.meshOpen) return
  trace.meshOpen = true
  join.step("mesh.open", {}, { startedAt: trace.cameraReadyAt ?? trace.joinedAt }).end()
  trace.peerFirst = join.step("peer.first")
  trace.peerAll = join.step("peer.all")
}

/** how long a connected peer's rtc.peer waits for its candidate pair before
 *  it ends with rtc.path "unknown" (the mesh reports every 3 s) */
export const PEER_PATH_WAIT_MS = 10_000

function awaitPath(id: string, step: Step): void {
  const entry: AwaitingPath = {
    step,
    connectedAt: Date.now(),
    timer: setTimeout(() => {
      // a timer from an earlier trace, or a pair that already landed
      if (trace.awaitingPath.get(id) === entry) settlePath(id, undefined)
    }, PEER_PATH_WAIT_MS),
  }
  trace.awaitingPath.set(id, entry)
}

function endAwaiting(id: string, pair: string | undefined): void {
  const entry = trace.awaitingPath.get(id)
  if (!entry) return
  clearTimeout(entry.timer)
  trace.awaitingPath.delete(id)
  entry.step.end({ "rtc.outcome": "connected", "rtc.path": rtcPath(pair) }, { endedAt: entry.connectedAt })
}

function settlePath(id: string, pair: string | undefined): void {
  endAwaiting(id, pair)
  if (trace.fullPending && trace.awaitingPath.size === 0) finishJoin(fullOutcome())
}

/** one report of the mesh's 3 s getStats loop (Mesh.report()): the link
 *  quality of every peer rides it, with no timer of its own */
export function observeRtcReport(rows: readonly RtcReading[]): void {
  observeRtc(rows)
  observePaths(rows)
  observeDecoders(rows)
  observeImplChanges(rows)
}

/** A link's decoder, encoder, their hardware/software kind or a direction's
 *  codec changed mid-call (rtc-impl.ts): counted as `rtc.impl_change`, both
 *  directions, and an outbound one is an rtc.encoder_change step on the game
 *  (the inbound one already is rtc.decoder_change). */
function observeImplChanges(rows: readonly RtcReading[]): void {
  for (const { id, attrs } of trackImplChanges(rows)) {
    recordCount("rtc.impl_change", 1, { ...linkAttrs(id), ...attrs })
    if (attrs["rtc.direction"] === "out") live(trace.game)?.step("rtc.encoder_change", peerStepAttrs(id, attrs)).end()
  }
}

/** The session counted a co-player as seen (#603: video decoded in a shared
 *  open turn): said on the link's rtc.link rows from then on. */
export function peerSeen(peerId: string): void {
  noteLinkSeen(peerId)
}

/** a link's decoder or codec changed mid-game: an rtc.decoder_change step (#556) */
function observeDecoders(rows: readonly RtcReading[]): void {
  for (const { id, attrs } of trackDecoders(rows)) live(trace.game)?.step("rtc.decoder_change", peerStepAttrs(id, attrs)).end()
}

/** A peer's selected candidate pair was set or changed: a game-log line the
 *  link script reads, and, in the game, an rtc.path step. A path chosen during
 *  the join is on the join's rtc.peer step (its rtc.path, at connect). A change
 *  is also counted into the round (`rtc.path_changes`). */
function observePaths(rows: readonly RtcReading[]): void {
  for (const { id, attrs, line, change } of trackPaths(rows)) {
    devLog("rtc", line)
    if (change) countPathChange(id)
    live(trace.game)?.step("rtc.path", peerStepAttrs(id, attrs)).end()
  }
}

export function observeMesh(observation: MeshObservation): void {
  trace.reports = observation.reports
  const join = live(trace.join)
  const game = live(trace.game)
  const pairOf = (id: string) => observation.reports.find((report) => report.id === id)
  let connectedNow = 0
  for (const [id, state] of observation.states) {
    const report = pairOf(id)
    if (join && !trace.peers.has(id) && !trace.connectedOnce.has(id) && !trace.failedPeers.has(id))
      trace.peers.set(id, join.step("rtc.peer", peerStepAttrs(id, roleAttrs(trace.self, id))))
    if (state === "connected") {
      connectedNow += 1
      const path = rtcPath(report?.pair)
      const step = trace.peers.get(id)
      trace.peers.delete(id)
      if (step && !report?.pair) awaitPath(id, step)
      else step?.end({ "rtc.outcome": "connected", "rtc.path": path })
      trace.connectedOnce.add(id)
      trace.firstLinkAt ??= Date.now()
      trace.reconnects.get(id)?.end({ "rtc.outcome": "reconnected", "rtc.path": path })
      trace.reconnects.delete(id)
      if (trace.peerFirst && !trace.peerFirst.ended) trace.peerFirst.end({ "rtc.peer": String(rtcPeerIndex(id)) })
    } else if (state === "failed" && trace.peers.has(id)) {
      const path = rtcPath(report?.pair)
      trace.peers.get(id)?.end({ "rtc.outcome": "failed", "rtc.path": path, "rtc.ice": report?.ice ?? "unknown", ...lastStageAttr(id) })
      sendUnfinishedGather(id)
      trace.peers.delete(id)
      trace.failedPeers.add(id)
      reportFailure(
        "peer-failed",
        { reason: report?.ice ?? "failed", context: { peer: id, path, relays: String(observation.turnServers) } },
        join ?? undefined,
      )
    } else if ((state === "disconnected" || state === "failed") && game && trace.connectedOnce.has(id) && !trace.reconnects.has(id)) {
      // recovered, not failed: a reconnect is a span, and the game is sad
      trace.reconnects.set(id, game.step("rtc.reconnect", peerStepAttrs(id, { "rtc.from": state })))
      game.markSad("peer-reconnect")
    }
  }
  // a pair that arrived after its peer connected (whatever the peer's state now)
  for (const report of observation.reports) if (report.pair && trace.awaitingPath.has(report.id)) endAwaiting(report.id, report.pair)
  trace.connectedNow = connectedNow
  if (join) {
    const present = [...observation.present]
    if (present.length > 0 && present.every((id) => observation.states.get(id) === "connected")) {
      trace.peerAll?.end()
      trace.allLinksAt ??= Date.now()
      trace.fullPending = true
    }
    if (trace.fullPending && trace.awaitingPath.size === 0) finishJoin(fullOutcome())
  }
}

/** where a join that reached full lands: a late join stays "late" */
const fullOutcome = (): "full" | "late" => (trace.lateJoin ? "late" : "full")

function finishJoin(outcome: "full" | "partial" | "isolated" | "late"): void {
  const join = live(trace.join)
  if (!join) return
  noteSessionChange()
  // a join that reached full is full, whichever moment ends it
  if (trace.fullPending && outcome !== "isolated") outcome = fullOutcome()
  if (trace.lateTimer) clearTimeout(trace.lateTimer)
  trace.lateTimer = null
  for (const id of [...trace.awaitingPath.keys()]) endAwaiting(id, undefined)
  if (trace.fullPending) {
    trace.peerAll?.end()
    trace.allLinksAt ??= Date.now()
  }
  for (const [id, step] of trace.peers) {
    step.end({ "rtc.outcome": "pending", ...lastStageAttr(id) })
    sendUnfinishedGather(id)
  }
  trace.peers.clear()
  trace.stopIce?.()
  trace.stopIce = null
  statementsOpenedAt = null
  statementsDone = false
  join.end(outcome, {
    "join.connected": String(trace.connectedOnce.size),
    ...(trace.firstLinkAt !== null ? { "join.first_link_ms": trace.firstLinkAt - trace.joinedAt } : {}),
    ...(trace.allLinksAt !== null ? { "join.all_links_ms": trace.allLinksAt - trace.joinedAt } : {}),
  })
}

/** a join this young when play began arrived at kickoff or after it: the
 *  handover opens a minute before the first round, so a join that old is on
 *  time (#800) */
const LATE_JOIN_MS = 15_000
/** how long a late join stays open for its links after the round began */
export const LATE_JOIN_DEADLINE_MS = 60_000

/** the first round starts with the join open. A join that started after play
 *  began (round past 0, or opened at the round start) is late, never judged as
 *  isolated: it stays open, so the time to its first and all links is
 *  measured, and ends full or at the deadline. Any other join ends here. */
function joinAtRoundStart(round: number): void {
  if (!live(trace.join)) return
  if (round > 0 || Date.now() - trace.joinedAt < LATE_JOIN_MS) {
    trace.lateJoin = true
    if (trace.fullPending && trace.awaitingPath.size === 0) finishJoin("late")
    else if (!trace.lateTimer) trace.lateTimer = setTimeout(() => finishJoin("late"), LATE_JOIN_DEADLINE_MS)
    return
  }
  finishJoin(joinShortfall())
}

/** the join's outcome when it did not reach full */
function joinShortfall(): "partial" | "isolated" | "late" {
  if (trace.lateJoin) return "late"
  return trace.connectedNow > 0 ? "partial" : "isolated"
}

// ── leaving ─────────────────────────────────────────────────────────────────

function abandon(): void {
  if (live(trace.join)) finishJoin(joinShortfall())
  if (live(trace.game)) endGame("abandoned")
  stopWatchingNetwork() // also the join that never reached a game
}

/** /game unmounted. Deferred a macrotask, so a remount (StrictMode) keeps it. */
export function leftGame(): void {
  if (leaveTimer) return
  leaveTimer = setTimeout(() => {
    leaveTimer = undefined
    abandon()
  }, 0)
}

/**
 * A hidden page is abandoned only after this long. Locking the phone for a
 * moment mid-game is not leaving it: the game, and a payoff, go on.
 */
export const HIDDEN_ABANDON_MS = 60_000

/**
 * A hidden timer that runs this much later than it was set (by the wall clock)
 * did not run while hidden: the page was frozen (iOS suspends JS in the
 * background) and is resuming. Slack for ordinary timer jitter.
 */
const HIDDEN_RESUME_SLACK_MS = 5_000

let hiddenArmedAt = 0
let hiddenTimer: ReturnType<typeof setTimeout> | undefined

function clearHiddenTimer(): void {
  if (hiddenTimer) clearTimeout(hiddenTimer)
  hiddenTimer = undefined
}

/** the app is gone (a real unload, or a hide that outlasted the grace): end
 *  what is open, so what can still be sent is. */
function onAppGone(): void {
  clearHiddenTimer()
  const playing = live(trace.game) !== null
  flushRtcCoverageSlice()
  abandon()
  if (live(trace.payoff)) endPayoff(trace.stalledStage ?? openPayoffStage())
  // the last round's points leave before a WebView is killed (endGame did, if a game ended)
  if (!playing) flushMetrics()
}

/** one `app.hidden` span per open journey while the page is hidden: its
 *  duration is the hidden time, which dashboards can aggregate */
let hiddenSteps: Step[] = []

function endHiddenSteps(): void {
  for (const step of hiddenSteps) step.end()
  hiddenSteps = []
}

/** the page turned hidden: the open journeys note it (`journey.hidden`, an
 *  `app.hidden` span) and go on. They are sad, and end, only if the page
 *  stays hidden past the grace: a two-second app switch is not a bad game.
 *  (On iOS the grace timer is frozen in the background, so a sad mark on hide
 *  would land every time and the abandon almost never.)
 *
 *  A timer that fires far later than HIDDEN_ABANDON_MS (wall clock) was frozen,
 *  not running: the app is resuming, not gone, so the journeys are marked sad
 *  `app-suspended` (the player was away) and go on, with the hidden spans
 *  closed. Only a timer that fires on time while still hidden (Android keeps
 *  timers running) abandons, so the data leaves before the WebView is killed. */
function onAppHidden(): void {
  if (hiddenTimer) return
  for (const journey of [live(trace.join), live(trace.game), live(trace.payoff)]) {
    if (!journey) continue
    journey.set({ "journey.hidden": "true" })
    hiddenSteps.push(journey.step("app.hidden"))
  }
  hiddenArmedAt = Date.now()
  hiddenTimer = setTimeout(() => {
    hiddenTimer = undefined
    // a resumed webview can run an overdue timer before its visible event
    if (!pageHidden()) return
    const resumed = Date.now() - hiddenArmedAt > HIDDEN_ABANDON_MS + HIDDEN_RESUME_SLACK_MS
    for (const journey of [live(trace.join), live(trace.game), live(trace.payoff)]) journey?.markSad(resumed ? "app-suspended" : "app-hidden")
    if (resumed) {
      endHiddenSteps()
      return
    }
    onAppGone()
  }, HIDDEN_ABANDON_MS)
}

/** Remove the listeners of lib/journeys/net-changes.ts, on at the join: they
 *  run to the game's end (or to the leaving of a join that never became one). */
function stopWatchingNetwork(): void {
  trace.stopNet?.()
  trace.stopNet = null
}

/** the game-log line of a network change, read off its attributes */
function netLine(attrs: Record<string, string>): string {
  const now = attrs["net.connection"] ? "connection unsupported" : `${attrs["net.type"]} ${attrs["net.effective"]}`
  if (attrs["net.event"] !== "change") return `[jollity-net] ${attrs["net.event"]} (${now})`
  const from = attrs["net.from_type"] ? `${attrs["net.from_type"]} ${attrs["net.from_effective"]}` : UNSUPPORTED
  return `[jollity-net] change ${from} -> ${attrs["net.connection"] ? UNSUPPORTED : now}`
}

/** The page went offline or online, or its connection changed: a step on the
 *  join or the game, a game-log line and a count. */
function noteNetworkChange(change: NetChange): void {
  devLog("net", netLine(change.attrs))
  rtcJourney()?.step("net.change", change.attrs).end()
  recordCount("net.changes", 1, { "net.event": change.event, "net.type": change.attrs["net.type"] })
}

function installPagehide(): void {
  if (pagehideInstalled) return
  pagehideInstalled = true
  watchPageHidden(
    () => {
      // The foreground tracker records the partial slice first. Drain it on
      // the hide edge before iOS freezes the SDK's regular metric timer.
      flushRtcCoverageSlice()
      flushMetrics()
      onAppHidden()
    },
    () => {
      clearHiddenTimer()
      endHiddenSteps()
    },
    // Not verified on a device: WKWebView may fire pagehide on merely
    // backgrounding, which would end the journeys at once instead of after
    // the grace.
    onAppGone,
  )
}

// ── the game ────────────────────────────────────────────────────────────────

/** The round is over: its link summary goes out (lib/journeys/rtc-quality.ts)
 *  and onto the round step as `rtc.summary`. `end: false` leaves the step for
 *  the game's end to cut. */
function closeRound(end: boolean): void {
  const open = trace.round
  trace.round = null
  const closed = closeRtcRound()
  if (!open) return
  if (closed) open.step.set({ "rtc.summary": closed.summary })
  // what this browser's stats could not measure, said rather than left out
  if (closed?.unsupported) open.step.set({ "rtc.unsupported": closed.unsupported })
  if (end) open.step.end()
}

function endGame(outcome: "completed" | "abandoned" | "isolated"): void {
  const game = live(trace.game)
  if (!game) return
  noteSessionChange()
  closeRound(false)
  leaveScene("game.confirm")
  leaveScene("game.round")
  trace.stall = null
  trace.cameraRecover = null
  trace.reconnects.clear()
  peersBack()
  stopWatchingNetwork()
  game.end(outcome)
  flushMetrics() // the game's last round, before the page can go
  if (outcome === "completed" && trace.gameIndex !== null) {
    closeDeliveryHealthGame(trace.gameIndex)
    void sendTelemetryHealth(trace.gameIndex, false)
  }
}

/** the round on the game clock: a number, or null outside the rounds.
 *  `between`: the gap between two rounds (the rotation countdown). The round
 *  step ends there, but the game.round scene runs on: the FLIP and the new
 *  round's stagger are the heaviest frames of the game. It is left once the
 *  rounds are over (reporting, finished), at the confirm stage, or the end. */
export function roundChanged(round: number | null, between = false, turn?: number): void {
  if (trace.round?.index === 0 && round !== 0) checkpointGameLog("round-1")
  const nextTurn = turn ?? null
  if (trace.turn !== nextTurn) {
    trace.turn = nextTurn
    noteSessionChange()
  }
  if (round === null) {
    closeRound(true)
    if (!between) leaveScene("game.round")
    return
  }
  if (trace.round?.index === round) return
  joinAtRoundStart(round)
  if (trace.game?.ended) return // a finished game does not start again
  if (!trace.game) {
    trace.game = startJourney(
      "game",
      {
        "clock.offset": trace.clockOffset,
        "game.late": round > 0 ? "true" : "false",
        ...(trace.gameIndex !== null ? { "game.index": String(trace.gameIndex) } : {}),
        ...signUpAttrs(),
      },
      { sameTraceAs: trace.join, ownsLifecycle: true },
    )
  }
  closeRound(true)
  trace.round = { index: round, step: trace.game.step(`round.${round + 1}`) }
  enterScene("game.round")
  openRtcRound(
    round,
    (peer, round) => pairAttrs(trace.gameIndex, trace.self, peer, round),
    (peer) => roleAttrs(trace.self, peer),
  )
}

/** The diagnostic turn currently shown, when the game session has supplied one. */
export function currentGameTurn(): number | undefined {
  return trace.turn ?? undefined
}

/**
 * Health-ladder layer names, mapped at the doorway. The layer
 * `turn-credentials` (packages/jollity-statement-core/src/health.ts) contains a word
 * Sentry's scrubbing may blank (mask-text.ts), so it would arrive as an empty value. Every
 * layer name goes through `layerName()` before it becomes an attribute or a
 * failure reason; add any new masked layer here.
 */
export const LAYER_NAMES: Record<string, string> = {
  "turn-credentials": "turn-issue",
}

export function layerName(layer: string | null | undefined): string {
  return layer ? (LAYER_NAMES[layer] ?? layer) : "unknown"
}

export function stallChanged(event: { kind: "connection_stalled" | "connection_recovered"; layer: string; detail?: Record<string, unknown> }): void {
  const attrs = { round: String(pairRound()) }
  if (event.kind === "connection_stalled") {
    if (!trace.stall) trace.stall = rtcJourney()?.step("rtc.stall", { "rtc.layer": layerName(event.layer), ...attrs, ...stallStartAttrs(event.detail) }) ?? null
    return
  }
  if (!trace.stall) return
  trace.stall.end({ "rtc.recovered_via": recoveredVia(event.detail) })
  trace.stall = null
  recordStall(event.detail, layerName(event.layer), attrs)
}

/** a peer is away (it said so, or its link stayed down): one span for the
 *  period, so its duration is how long they were gone (#229). */
export function peerAway(peerId: string, reason: "said" | "timeout"): void {
  const game = live(trace.game)
  if (!game || trace.aways.has(peerId)) return
  trace.aways.set(peerId, game.step("game.peer.away", peerStepAttrs(peerId, { "away.reason": reason })))
}

/** the peer is back (or gone from the mesh): the period ends */
export function peerBack(peerId: string): void {
  trace.aways.get(peerId)?.end()
  trace.aways.delete(peerId)
}

/** every away period ends: a room closed, or the game did */
export function peersBack(): void {
  for (const step of trace.aways.values()) step.end()
  trace.aways.clear()
}

/** lib/camera.ts reopens a camera that had been live */
export function cameraRecovering(reason: string): void {
  const game = live(trace.game)
  if (!game || trace.cameraRecover) return
  trace.cameraRecover = game.step("camera.recover", { "camera.reason": reason })
  game.markSad("camera-recover")
}

/** the camera recovery reached its terminal result */
export function cameraRecovered(state: "ready" | "no-frame" | "open-failed" | "unresolved" = "ready"): void {
  trace.cameraRecover?.end({ "camera.state": state })
  trace.cameraRecover = null
}

/** the confirm stage opened: the confirm window starts */
export function confirmOpened(): void {
  const game = live(trace.game)
  if (!game || trace.confirm) return
  closeRound(true)
  trace.confirm = game.step("report.submit")
  enterScene("game.confirm")
}

/** What the vote trail adds up to, once the report is built (counts only). */
export interface ReportFacts {
  /** every tap this game, the confirm screen's overrides apart */
  taps: number
  /** NotPerson verdicts the end of a turn filed for the player */
  auto: number
  /** turns sealed */
  turns: number
  /** co-players filed Person / NotPerson */
  person: number
  notperson: number
  /** co-players filed NotPerson with no reject ever tapped */
  autoOnly: number
  ties: number
  unseen: number
  /** shared-turn co-players whose video never decoded, split by final choice */
  unseenDefault: number
  unseenFlipped: number
  /** One privacy-safe row per shared-turn No-video tile. */
  unseenChoices: readonly {
    choice: "default-notperson" | "flipped-person"
    everFlipped: boolean
  }[]
  filedBy: "auto-confirm" | "tap"
}

/** the report was built: what the player decided versus what the app did for
 *  them, as text attributes on the game journey (custom attributes are
 *  string-typed — filter and count, never sum) */
export function reportBuilt(facts: ReportFacts): void {
  const game = live(trace.game)
  if (!game) return
  game.set({
    "votes.taps": String(facts.taps),
    "votes.auto": String(facts.auto),
    "votes.turns": String(facts.turns),
    "report.person": String(facts.person),
    "report.notperson": String(facts.notperson),
    "report.auto_only": String(facts.autoOnly),
    "report.ties": String(facts.ties),
    "report.unseen": String(facts.unseen),
    "report.unseen_default": String(facts.unseenDefault),
    "report.unseen_flipped": String(facts.unseenFlipped),
    "report.filed_by": facts.filedBy,
  })
  for (const choice of facts.unseenChoices) {
    recordCount("report.no_video_choice", 1, {
      choice: choice.choice,
      ever_flipped: String(choice.everFlipped),
    })
    reportNoVideoChoice(choice.choice, choice.everFlipped)
  }
}

/** the page was hidden or frozen during the game, so the confirm stage will
 *  not file by itself (#201): the player confirms, or no report goes out.
 *  Says why the vote trail shows no `auto-confirm`, and why none may follow. */
export function autoConfirmOff(): void {
  live(trace.game)?.set({ "report.auto_confirm": "off-after-background" })
}

/** the report window closed with no report filed and the player moved on to
 *  the payoff (nothing was sent) */
export function reportWindowClosed(): void {
  live(trace.game)?.set({ "report.outcome": "window-closed" })
}

/** the report is being submitted (the auto-confirm fired, or a retry tap) */
export function reportSubmitting(): void {
  trace.confirm?.end()
  const game = live(trace.game)
  if (game && (!trace.landed || trace.landed.ended)) trace.landed = game.step("report.landed")
}

export function reportFailed(detail: string, reason: "refused" | "timeout" = "refused"): void {
  const game = live(trace.game)
  reportFailure("report-failed", { reason, context: { error: detail } }, game ?? undefined)
  trace.landed?.end({ "report.outcome": "failed" })
  trace.landed = null
  game?.markSad("report-retry")
}

/** The terminal failure the last page could not send before it went (#600),
 *  sent on the next open once the chain confirmed the miss
 *  (lib/report-failure-outbox.ts). No journey is live, so it goes bare. */
export function reportFailedAfterTheFact(failure: { gameIndex: number; reason: "refused" | "timeout"; detail: string }): void {
  reportFailure("report-failed", {
    reason: failure.reason,
    context: { error: failure.detail, "game.index": String(failure.gameIndex), "report.sent_by": "next-open" },
  })
}

export function reportLanded(gameIndex: number): void {
  // The game journey can already be closed (a hide that outlasted the grace
  // abandoned it, then the player came back and the report went on). Its
  // report steps are gone, so the landing is kept on the payoff journey.
  const closed = trace.game?.ended === true
  trace.landed?.end({ "report.outcome": "landed" })
  trace.landed = null
  endGame("completed")
  beginPayoff(gameIndex)
  if (closed) live(trace.payoff)?.set({ "report.after_abandon": "true", "report.outcome": "landed" })
  checkpointGameLog("report")
  // The log goes now, not only at the card: a page can freeze right after the
  // report lands and never reach it. The card sends the fuller copy.
  if (trace.payoff)
    void sendGameLog({ gameIndex, since: trace.joinedAt, trace: trace.payoff.trace, stage: "report" })
}

/** the isolation redirect to /connection-help fired */
export function isolated(layer: string | null): void {
  reportFailure("mesh-isolated", { reason: layerName(layer) }, live(trace.game) ?? live(trace.join) ?? undefined)
  if (live(trace.join)) finishJoin("isolated")
  endGame("isolated")
}

// ── the payoff ──────────────────────────────────────────────────────────────

/** attestations.ready open this long sends attestations-late, once */
export const ATTESTATIONS_LATE_MS = 60_000

function beginPayoff(gameIndex: number): void {
  if (trace.payoff) return
  const payoff = startJourney("payoff", { "game.index": String(gameIndex) }, { sameTraceAs: trace.game ?? trace.join, ownsLifecycle: true })
  trace.payoff = payoff
  trace.payoffGame = gameIndex
  trace.payoffStartedAt = Date.now()
  checkPayoffGame(gameIndex, "payoff.start")
  trace.draw = payoff.step("draw.show")
}

/** the doorway's gameSettled resolved: the chain holds what the collectables screen needs */
export function gameSettledFor(gameIndex: number): void {
  if (trace.payoffGame !== gameIndex) return
  trace.attestations?.end()
  if (trace.attestationsTimer) clearTimeout(trace.attestationsTimer)
  trace.attestationsTimer = null
}

/** the draw is on screen. A wheel that cannot reproduce the chain's draw is
 *  also the `draw-unplayable` failure, sent once per trace. A draw still
 *  loading ("Drawing the winners…") is not a result yet: draw.show ends at
 *  the first state that is one. */
export function drawShown(state: DrawState, check: WheelCheck | null, gameIndex: number | undefined): void {
  if (state.kind === "loading") return
  if (gameIndex !== undefined) checkPayoffGame(gameIndex, "draw")
  const unplayable = drawUnplayable(check)
  if (unplayable && !trace.unplayableSent) {
    trace.unplayableSent = true
    reportFailure("draw-unplayable", { reason: unplayable, context: { game: String(gameIndex ?? "last") } })
  }
  const payoff = live(trace.payoff)
  if (!payoff) return
  const firstResult = !!trace.draw && !trace.draw.ended
  const attrs = drawFacts(state, check, trace.signupSkip)
  trace.draw?.end(attrs)
  payoff.set(attrs)
  if (firstResult) checkpointGameLog("draw")
}

export function collectablesOpened(): void {
  const payoff = live(trace.payoff)
  if (!payoff || trace.collectables) return
  trace.attestations = payoff.step("attestations.ready")
  trace.attestationsTimer = setTimeout(() => {
    trace.attestationsTimer = null
    if (trace.attestations && !trace.attestations.ended)
      reportFailure("attestations-late", { reason: "60s", context: { seconds: "60" } }, live(trace.payoff) ?? undefined)
  }, ATTESTATIONS_LATE_MS)
  trace.collectables = payoff.step("chest.show")
}

export function collectablesShown(attrs: Attrs): void {
  const payoff = live(trace.payoff)
  if (!payoff) return
  const firstResult = !!trace.collectables && !trace.collectables.ended
  trace.collectables?.end(attrs)
  payoff.set(attrs)
  if (firstResult) checkpointGameLog("chest")
}

/** A bounded collectables read failed, but a later in-place read opened it. */
export function collectablesReadRecovered(elapsedMs: number): void {
  recordDistribution("chest.recovery_ms", Math.max(0, elapsedMs), "millisecond", {})
  const payoff = live(trace.payoff)
  if (!payoff) return
  payoff.set({ "chest.recovered": "true" })
}

/** a page's own stall escape fired at this stage */
export function payoffStalled(stage: string): void {
  const payoff = live(trace.payoff)
  if (!payoff) return
  trace.stalledStage ??= stage
  payoff.set({ "payoff.stage": trace.stalledStage })
}

/** INVARIANT: a payoff for a game this session did not play (lib/invariants.ts).
 *  A relaunch straight onto a payoff has no played game to compare (null) and
 *  says nothing; a session that played game N and is paid for game M is a
 *  broken hand-off. `where` names the screen that asked, for the report.
 *
 *  ONLY THE PAYOFF'S OWN START asserts it. A draw screen asked for a
 *  different game is a normal way to arrive — a chat link to game 4's draw
 *  after playing game 5 — and says nothing about the hand-off, so it is
 *  skipped. */
function checkPayoffGame(gameIndex: number, where: string): void {
  if (where !== "payoff.start") return
  if (!payoffForAnotherGame(trace.gameIndex, gameIndex)) return
  noteInvariant({
    kind: "payoff-without-join",
    detail: {
      "game.index": gameIndex,
      "invariant.played_game": trace.gameIndex as number,
      "invariant.asked_by": where,
    },
  })
}

/** INVARIANT: the device log stopped before the payoff began (lib/invariants).
 *  Read at the payoff's end: the newest line this page holds is older than the
 *  payoff's start, so nothing at all was logged while it ran. */
function checkLogStopsBeforePayoff(): void {
  try {
    const startedAt = trace.payoffStartedAt
    if (startedAt === null) return
    const newest = getDevLogEntries().at(-1)
    if (!logStoppedBeforePayoff(newest?.time ?? null, startedAt)) return
    noteInvariant({
      kind: "log-stops-before-payoff",
      valueMs: startedAt - (newest?.time ?? startedAt),
      detail: {
        "invariant.newest_line": newest?.tag ?? "none",
        ...(trace.payoffGame === null ? {} : { "game.index": trace.payoffGame }),
      },
    })
  } catch {
    /* diagnostic only */
  }
}

function endPayoff(stalledAt: string | null): void {
  const payoff = live(trace.payoff)
  if (!payoff) return
  checkLogStopsBeforePayoff()
  if (trace.attestationsTimer) clearTimeout(trace.attestationsTimer)
  trace.attestationsTimer = null
  recordHeap() // the payoff is the end of the session's heavy screens
  if (stalledAt) payoff.end("stalled", { "payoff.stage": stalledAt })
  else payoff.end("shown")
  clearGameSessionState()
}

/** the player left the collectables screen for Humanity: the payoff is over, and the
 *  game's log goes */
export function payoffHandedOff(): void {
  const payoff = live(trace.payoff)
  if (!payoff) return
  endPayoff(trace.stalledStage)
  if (trace.payoffGame !== null)
    void sendGameLog({ gameIndex: trace.payoffGame, since: trace.joinedAt, trace: payoff.trace, stage: "payoff" })
}

/** The player requested a hand-off to Humanity, from the collectables screen.
 *  The payoff has ended by now (payoffHandedOff ends it), so this is its own
 *  short journey in the same trace. The host/browser cannot reliably report
 *  destination arrival, so this records only the synchronous tap/request. */
export function humanityRequested({ target }: { target: "card" | "product" }): void {
  const attrs: Attrs = { "humanity.target": target, "humanity.action": "requested" }
  live(trace.payoff)?.set({ "membership.humanity": "requested" })
  const journey = startJourney(
    "humanity",
    { ...(trace.payoffGame === null ? {} : { "game.index": String(trace.payoffGame) }), "membership.humanity": "requested" },
    { sameTraceAs: trace.payoff ?? trace.game ?? trace.join },
  )
  journey.step("open", attrs).end()
  journey.end("requested", attrs)
}

/** what the sign-up carried into the draws (lib/game-source.ts onDraws) */
export function signupDraws(entered: number, skipped?: string): void {
  trace.signupSkip = entered > 0 ? null : (skipped ?? null)
}

export function currentSignupSkip(): string | null {
  return trace.signupSkip
}

/** the stage still open, for a payoff the app closed on */
function openPayoffStage(): string {
  if (trace.attestations && !trace.attestations.ended) return "attestations.ready"
  if (trace.draw && !trace.draw.ended) return "draw.show"
  if (trace.collectables && !trace.collectables.ended) return "chest.show"
  return "hand-off"
}

export function resetGameTraceForTests(): void {
  pagehideInstalled = false
  clearHiddenTimer()
  hiddenSteps = []
  if (leaveTimer) clearTimeout(leaveTimer)
  leaveTimer = undefined
  if (trace.attestationsTimer) clearTimeout(trace.attestationsTimer)
  for (const entry of trace.awaitingPath.values()) clearTimeout(entry.timer)
  trace.stopIce?.()
  stopWatchingNetwork()
  trace = fresh()
  statementsOpenedAt = null
  statementsDone = false
  signUpSurface = null
  heldOwnKeyMiss = null
  startRtcGame()
  resetPaths()
  resetDecoders()
  resetImplChanges()
}
