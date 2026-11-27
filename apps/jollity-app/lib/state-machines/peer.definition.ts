// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import fc from "fast-check"
import { createPeerActorState, stepPeerActor, type PeerActorCommand, type PeerActorEvent, type PeerActorState, type PeerLink } from "./peer-actor"
import { clockOf, snapshotOf, tickOf as tickFrom, timesOf, withTimes, type SupervisorTickFacts } from "./peer-actor.test-helper"
import { backoffMs } from "../webrtc/supervisor-timing"
import { createModelPeerState, stepModelPeer, type ModelPeerEvent, type ModelPeerState } from "./peer.model"
import { defineTransitionTable, type MachineDefinition, type NamedInvariant, type NamedSequence } from "./framework"

/** What the actor decides from its link: whether it is closed
 *  (stepPeerActor's first guard), and nothing more for any fact Mesh sends
 *  with the runner. The link is still observed (state.link) and names every
 *  witness, but it keys no row. */
export type PeerStateKey = PeerLink
const peerStateKey = (link: PeerLink): PeerStateKey => link

/** A named scenario: each witness and regression is one, and maps onto the
 *  table cell of its fact's type and declared outcome (peerCellKey). */
export type PeerEventKey =
  | "heard"
  | "heard-said-short"
  | "stale-room"
  | "stale-connection"
  | "description"
  | "departed-description"
  | "statement-offer-received"
  | "lane-offer-received"
  | "peer-session-changed"
  | "new-session-offer"
  | "new-session-answer"
  | "connected"
  | "connected-stamps-up"
  | "connected-again"
  | "link-disconnected-never-up"
  | "link-connecting"
  | "link-new-idle"
  | "link-disconnected"
  | "link-failed"
  | "link-down-again"
  | "channel-open"
  | "statement-offer-requested"
  | "lane-offer-requested"
  | "glare-rebuild"
  | "glare-rollback"
  | "glare-ignore"
  | "statement-glare-away"
  | "lane-glare-stall"
  | "codec-rollback"
  | "frame-reset"
  | "old-stats"
  | "no-video-rebuild"
  | "unseen-no-stat"
  | "unseen-no-stat-hard"
  | "unseen-zero-stat"
  | "lane-answer-received"
  | "lane-answer-said"
  | "lane-offer-said"
  | "no-video-standby"
  | "stall-restart-one"
  | "stall-rebuild"
  | "stall-rebuild-spent"
  | "stall-rebuild-offer-pending"
  | "unseen-spent"
  | "unseen-sees-us"
  | "unseen-later"
  | "unseen-refill"
  | "unseen-offer-pending"
  | "frozen-ask"
  | "frozen-ask-answerer"
  | "frozen-ask-camera-off"
  | "frozen-ask-after-reset"
  | "frozen-rebuild"
  | "frozen-rebuild-packets-flat"
  | "frozen-rebuild-answerer-early"
  | "frozen-rebuild-answerer"
  | "frozen-healed"
  | "frozen-held"
  | "frozen-asked-held"
  | "frozen-packets-flat"
  | "frozen-packets-unread"
  | "frozen-hidden-held"
  | "frozen-away-held"
  | "frozen-standby-held"
  | "frozen-asked-hidden-held"
  | "frozen-hide-ends-episode"
  | "frozen-budget-spent"
  | "one-way-hard"
  | "one-way-restart"
  | "camera-came-up"
  | "hidden-stats-held"
  | "resume-eight"
  | "resume-over-eight"
  | "resume-over-eight-said"
  | "standby"
  | "network-restart"
  | "network-rebuild"
  | "round-change"
  | "completion"
  | "old-completion"
  | "overtaken-completion"
  | "rejected-media-completion"
  | "unstamped-rejection"
  | "restart-rejected-rebuild"
  | "restart-rejected-network"
  | "restart-rejected-answerer"
  | "restart-rejected-logged"
  | "restart-rejected-unseen-logged"
  | "lane-offer-hard-rejected"
  | "lane-srd-hard-rejected"
  | "codec-rollback-hard-rejected"
  | "lane-hard-spent"
  | "lane-hard-old-round"
  | "lane-soft-rejected"
  | "statement-offer-sent-rejected"
  | "offer-refused-virgin"
  | "offer-refused-invalid-access"
  | "offer-refused-other"
  | "offer-retry-refused"
  | "statement-answer-rejected"
  | "answer-refused"
  | "answer-refused-spent"
  | "answer-displaced"
  | "answer-displaced-impolite"
  | "answer-stale-newer"
  | "no-video-offer-pending"
  | "no-video-spent"
  | "no-video-offer-pending-spent"
  | "codec-guard-stale"
  | "statement-offer-applied"
  | "lane-offer-applied"
  | "rejoin-offer-applied"
  | "remote-answer-applied"
  | "answer-sent"
  | "rejoin-answer-sent"
  | "rejoin-answer-stale"
  | "lane-answer-hard-rejected"
  | "statement-answer-step-rejected"
  | "lane-offer-superseded"
  | "lane-offer-superseded-left"
  | "tick-connected-idle"
  | "tick-hidden-held"
  | "tick-restart"
  | "tick-grace"
  | "tick-restarts-spent"
  | "tick-closed-lane"
  | "tick-no-restart-api"
  | "tick-failed"
  | "tick-backoff"
  | "tick-gather-stalled"
  | "tick-gather-stalled-answerer"
  | "tick-gather-stall-early"
  | "tick-gather-srflx"
  | "tick-gather-no-turn"
  | "tick-gather-relay-only"
  | "tick-gather-complete"
  | "tick-gather-no-facts"
  | "tick-gather-spent"
  | "tick-gather-backoff"
  | "tick-gather-failed"
  | "tick-gather-hidden"
  | "local-description-set"
  | "local-description-set-again"
  | "resume-gather-shift"
  | "round-change-gather"
  | "resume-gather-after-deadline"
  | "rollback-clears-local-description"
  | "tick-backoff-over"
  | "tick-backoff-cap"
  | "tick-said"
  | "tick-away"
  | "tick-away-boundary"
  | "tick-away-already"
  | "tick-away-never-up"
  | "tick-gone"
  | "tick-fresh-boundary"
  | "tick-just-dropped"
  | "tick-stranded"
  | "tick-stranded-early"
  | "tick-stranded-backoff"
  | "tick-stranded-channel"
  | "tick-stranded-described"
  | "tick-never-due"
  | "tick-never-initial-boundary"
  | "tick-never-quiet"
  | "tick-never-offer-waiting"
  | "tick-never-offer-overdue"
  | "tick-never-answerer-heard"
  | "tick-never-answerer-unheard"
  | "tick-connect-by-ever"
  | "tick-connect-by-ever-early"
  | "tick-yield"
  | "tick-yield-early"
  | "tick-yield-lane-open"
  | "tick-cno"
  | "tick-cno-early"
  | "tick-cno-spent"
  | "tick-cno-video"
  | "tick-cno-said"
  | "tick-cno-backoff"
  | "tick-mesh-backoff-copy"
  | "tick-cno-mesh-copy"
  | "resume-never-away"
  | "away-back"
  | "session-nothing-negotiated"
  | "resume-timeout-back"
  | "connected-present"
  | "network-answerer"
  | "network-inferred-on-new"
  | "network-inferred-connected"
  | "network-inferred-down"
  | "stall-answerer"
  | "stall-rebuild-answerer"
  | "no-video-answerer"
  | "glare-rebuild-answerer"
  | "session-over-our-offer"
  | "promote-keeps-heals"
  | "remove-budgets"
  | "unseen-stall-reset"
  | "remove"
  | "after-close"
  | "replaced-externally"
  | "replaced-externally-known"
  | "replaced-externally-older"
  | "room-close"
  | "policy-unchanged"

type PeerTestTimes = Partial<Pick<PeerActorState,
  "lastSignalAt" | "lastAttemptAt" | "upAt" | "connectingSince" | "disconnectedAt" |
  "lastRecvDescAt" | "offerSentAt" | "yieldedAt" | "downAt" | "everConnected" | "firstHeardAt"
>>

export interface PeerTestEvent {
  key: PeerEventKey
  event: PeerActorEvent
  relative?: boolean
  /** a sweep's: the times Mesh had, which the actor takes first (sequence) */
  times?: PeerTestTimes
}
export interface PeerObservation {
  state: {
    link: string
    away: string
    roomEpoch: number
    roundGeneration: number
    connectionEpoch: number
    commandEpoch: number
    openCommands: Record<string, number>
    hidden: boolean
    standby: boolean
    laneOpen: boolean
    remoteOffer: string | null
    rejoinAnswer: boolean
    lastSignalAt: number | null
    lastAttemptAt: number | null
    upAt: number | null
    connectingSince: number | null
    disconnectedAt: number | null
    lastRecvDescAt: number | null
    offerSentAt: number | null
    yieldedAt: number | null
    downAt: number | null
    everConnected: boolean
    firstHeardAt: number | null
    framesSeen: number
    stallSamples: number
    frozenSamples: number
    frozenAsked: boolean
    framesReadSequence: number
    budgets: Record<string, number>
    localDescribedAt: number | null
    remoteDescribedAt: number | null
    gatherHiddenMs: number
  }
  commands: string[]
  ignored: string | null
}
const normalizeCommand = (command: PeerActorCommand): string => {
  const suffix = `@${command.commandEpoch}:${command.connectionEpoch}`
  switch (command.kind) {
    case "restart-ice": return `restart-ice:${command.cause}${suffix}`
    case "replace-connection": return `replace-connection:${command.cause}:${command.initiate ? "offer" : "answer"}${command.answererMayOffer ? ":leave" : ""}${suffix}`
    case "set-remote-description": return `set-remote-description:${command.lane ? "lane" : "statement"}${suffix}`
    case "rollback": return `rollback:${command.cause}${suffix}`
    case "send-offer": return `send-offer:${command.lane ? "lane" : "statement"}${suffix}`
    case "send-answer": return `send-answer:${command.lane ? "lane" : "statement"}${suffix}`
    case "replace-video-track": return `replace-video-track:${command.track ?? "none"}${suffix}`
    default: return `${command.kind}${suffix}`
  }
}

function observeActor(result: ReturnType<typeof stepPeerActor>): PeerObservation {
  const state = result.state
  return {
    state: {
      link: state.link,
      away: state.away,
      roomEpoch: state.scope.roomEpoch,
      roundGeneration: state.roundGeneration,
      connectionEpoch: state.connectionEpoch,
      commandEpoch: state.commandEpoch,
      openCommands: state.openCommands as Record<string, number>,
      hidden: state.hidden,
      standby: state.standby,
      laneOpen: state.laneOpen,
      remoteOffer: state.remoteOffer,
      rejoinAnswer: state.rejoinAnswer,
      lastSignalAt: state.lastSignalAt,
      lastAttemptAt: state.lastAttemptAt,
      upAt: state.upAt,
      connectingSince: state.connectingSince,
      disconnectedAt: state.disconnectedAt,
      lastRecvDescAt: state.lastRecvDescAt,
      offerSentAt: state.offerSentAt,
      yieldedAt: state.yieldedAt,
      downAt: state.downAt,
      everConnected: state.everConnected,
      firstHeardAt: state.firstHeardAt,
      framesSeen: state.framesSeen,
      stallSamples: state.stallSamples,
      frozenSamples: state.frozenSamples,
      frozenAsked: state.frozenAsked,
      framesReadSequence: state.framesReadSequence,
      budgets: { ...state.budgets },
      localDescribedAt: state.localDescribedAt,
      remoteDescribedAt: state.remoteDescribedAt,
      gatherHiddenMs: state.gatherHiddenMs,
    },
    commands: result.commands.map(normalizeCommand),
    ignored: result.ignored ?? null,
  }
}

function observeModel(result: ReturnType<typeof stepModelPeer>): PeerObservation {
  const state = result.state
  return {
    state: {
      link: state.link,
      away: state.away,
      roomEpoch: state.roomEpoch,
      roundGeneration: state.roundGeneration,
      connectionEpoch: state.connectionEpoch,
      commandEpoch: state.commandEpoch,
      openCommands: state.open,
      hidden: state.hidden,
      standby: state.standby,
      laneOpen: state.laneOpen,
      remoteOffer: state.remoteOffer,
      rejoinAnswer: state.rejoinAnswer,
      lastSignalAt: state.lastSignalAt,
      lastAttemptAt: state.lastAttemptAt,
      upAt: state.upAt,
      connectingSince: state.connectingSince,
      disconnectedAt: state.disconnectedAt,
      lastRecvDescAt: state.lastRecvDescAt,
      offerSentAt: state.offerSentAt,
      yieldedAt: state.yieldedAt,
      downAt: state.downAt,
      everConnected: state.everConnected,
      firstHeardAt: state.firstHeardAt,
      framesSeen: state.framesSeen,
      stallSamples: state.stallSamples,
      frozenSamples: state.frozenSamples,
      frozenAsked: state.frozenAsked,
      framesReadSequence: state.framesReadSequence,
      budgets: { ...state.budgets },
      localDescribedAt: state.localDescribedAt,
      remoteDescribedAt: state.remoteDescribedAt,
      gatherHiddenMs: state.gatherHiddenMs,
    },
    commands: result.commands,
    ignored: result.ignored ?? null,
  }
}

const baseActor = (): PeerActorState => createPeerActorState({ game: 42, roomEpoch: 1, peer: "peer-a" }, { connectingSince: 90_000 })

export const peerConnectionInitialStates = [
  "connecting",
  "connected",
  "link-down",
  "yielded",
] as const satisfies readonly Exclude<PeerLink, "closed">[]

function actor(overrides: Partial<PeerActorState> = {}): PeerActorState {
  const base = baseActor()
  return withTimes({ ...base, ...overrides, scope: { ...base.scope, ...overrides.scope }, budgets: { ...base.budgets, ...overrides.budgets } })
}

function modelFrom(real: PeerActorState): ModelPeerState {
  return createModelPeerState({
    roomEpoch: real.scope.roomEpoch,
    roundGeneration: real.roundGeneration,
    connectionEpoch: real.connectionEpoch,
    commandEpoch: real.commandEpoch,
    open: { ...real.openCommands } as Record<string, number>,
    link: real.link,
    away: real.away,
    hidden: real.hidden,
    standby: real.standby,
    initiator: real.initiator,
    cameraLive: real.cameraLive,
    laneOpen: real.laneOpen,
    remoteOffer: real.remoteOffer,
    rejoinAnswer: real.rejoinAnswer,
    lastSignalAt: real.lastSignalAt,
    lastAttemptAt: real.lastAttemptAt,
    upAt: real.upAt,
    connectingSince: real.connectingSince,
    disconnectedAt: real.disconnectedAt,
    lastRecvDescAt: real.lastRecvDescAt,
    offerSentAt: real.offerSentAt,
    yieldedAt: real.yieldedAt,
    downAt: real.downAt,
    everConnected: real.everConnected,
    firstHeardAt: real.firstHeardAt,
    framesSeen: real.framesSeen,
    stallSamples: real.stallSamples,
    frozenSamples: real.frozenSamples,
    frozenAsked: real.frozenAsked,
    framesReadSequence: real.framesReadSequence,
    budgets: { ...real.budgets },
    localDescribedAt: real.localDescribedAt,
    remoteDescribedAt: real.remoteDescribedAt,
    gatherHiddenMs: real.gatherHiddenMs,
  })
}

const initial = (overrides: Partial<PeerActorState> = {}) => {
  const real = actor(overrides)
  return { real, model: modelFrom(real) }
}

/** Every witness fact is stamped at Mesh's clock 100 s, the sweeps' now. */
const WITNESS_NOW = 100_000
const current = <Event extends Omit<PeerActorEvent, "roomEpoch" | "connectionEpoch">>(key: PeerEventKey, event: Event, connectionEpoch = 1): PeerTestEvent => ({
  key,
  event: { now: WITNESS_NOW, ...event, roomEpoch: 1, connectionEpoch } as PeerActorEvent,
})

/** A sequence that opens with a sweep starts from a peer that saw every fact
 *  Mesh did: its own times are the sweep's, unless named. */
const sequence = (name: string, events: readonly PeerTestEvent[], overrides: Partial<PeerActorState> = {}): NamedSequence<PeerTestEvent, PeerActorState, ModelPeerState> => {
  const seen = events[0]?.times ?? {}
  return { name, events, initial: initial({ ...seen, ...overrides }) }
}

/** A sweep over a peer whose link was up and dropped a second ago, with its
 *  lane open, heard a second ago: the supervisor's facts, at now = 100 s. */
export const tickFacts = (overrides: Partial<SupervisorTickFacts> = {}): SupervisorTickFacts => ({
  now: 100_000,
  browserConnectionState: "disconnected",
  haveLocalOffer: false,
  localDescription: true,
  remoteDescription: true,
  hasChannel: true,
  laneOpen: true,
  everConnected: true,
  away: null,
  framesSeen: 10,
  sawVideoThisRound: false,
  canRestartIce: true,
  lastSignalAt: 99_000,
  firstHeardAt: 10_000,
  lastRecvDescAt: 50_000,
  offerSentAt: null,
  yieldedAt: null,
  upAt: 0,
  downAt: 99_000,
  disconnectedAt: 99_000,
  ...overrides,
})
const tick = (key: PeerEventKey, overrides: Partial<SupervisorTickFacts> & { connectingSince?: number | null } = {}): PeerTestEvent => {
  const { connectingSince, ...facts } = overrides
  const clock = clockOf(tickFacts(facts))
  return { ...current(key, clock), times: { ...timesOf(clock), ...(connectingSince === undefined ? {} : { connectingSince }) } }
}
/** #1562: a fresh connection of a peer that was connected before (heard
 *  long ago), started 18 s ago, nothing of theirs received and no offer out */
const freshEverUp = (connectingSince: number): Partial<SupervisorTickFacts> & { connectingSince: number } => ({ browserConnectionState: "new", everConnected: true, laneOpen: false, hasChannel: false, localDescription: false, remoteDescription: false, downAt: 0, disconnectedAt: 0, firstHeardAt: 10_000, connectingSince, lastRecvDescAt: null, offerSentAt: null })
/** a link that never connected, heard 19 s ago, nothing of theirs received */
const neverUp: Partial<SupervisorTickFacts> & { connectingSince: number } = { browserConnectionState: "new", everConnected: false, laneOpen: false, hasChannel: true, localDescription: true, remoteDescription: false, downAt: 0, disconnectedAt: 0, firstHeardAt: 81_000, connectingSince: 80_000, lastRecvDescAt: null, offerSentAt: null }
/** a yielded, responder-only connection that took no description */
const yielded: Partial<SupervisorTickFacts> = { ...neverUp, hasChannel: false, localDescription: false, firstHeardAt: null, yieldedAt: 70_000 }
/** our statement offer, sent 30 s ago over a closed lane, still unanswered */
const unanswered: Partial<SupervisorTickFacts> = { laneOpen: false, haveLocalOffer: true, offerSentAt: 70_000, disconnectedAt: 0 }
/** connected 23 s with no channel open and no video */
const stalledChannel: Partial<SupervisorTickFacts> = { browserConnectionState: "connected", laneOpen: false, framesSeen: 0, upAt: 77_000, downAt: 0, disconnectedAt: 0 }
/** #1951: a link never up, checking, both descriptions in, made with TURN
 *  (not relay only), host candidates only and its gathering not complete */
const gatherStalled: Partial<SupervisorTickFacts> & { connectingSince: number } = { ...neverUp, browserConnectionState: "connecting", remoteDescription: true, firstHeardAt: 96_000, connectingSince: 93_000, srflxOrRelaySeen: false, gatheringComplete: false, turnConfigured: true, relayOnly: false }
/** both descriptions in: ours a second before theirs, applied at `remote` */
const describedAt = (remote: number): Partial<PeerActorState> => ({ localDescribedAt: remote - 1_000, remoteDescribedAt: remote })

const baseWitnesses: readonly NamedSequence<PeerTestEvent, PeerActorState, ModelPeerState>[] = [
  sequence("heard refreshes the last signal, orthogonal to away", [current("heard", { type: "peer-heard", at: 10 })]),
  sequence("recent signal does not flatten explicit away", [current("heard-said-short", { type: "peer-heard", at: 10 })], { away: "said", lastSignalAt: 1 }),
  sequence("stale room cannot mutate", [{ key: "stale-room", event: { type: "peer-heard", at: 10, roomEpoch: 0, connectionEpoch: 1 } }]),
  sequence("stale connection cannot mutate", [current("stale-connection", { type: "peer-heard", at: 10 }, 0)]),
  sequence("accepted description clears away", [current("description", { type: "description-observed", lane: false })], { away: "said" }),
  sequence("departed session SDP is inert", [current("departed-description", { type: "description-observed", departedSession: true, lane: false })]),
  sequence("lane answer is applied and keeps the stall count", [current("lane-answer-received", { type: "description-observed", lane: true, description: "answer" })], { stallSamples: 3 }),
  sequence("a hidden peer's lane answer is not the peer back: away and the last attempt stay", [current("lane-answer-said", { type: "description-observed", lane: true, description: "answer" })], { away: "said", lastAttemptAt: 100_000, budgets: { failCount: 1 } as PeerActorState["budgets"] }),
  sequence("a hidden peer's lane offer is not the peer back either: away and the last attempt stay", [current("lane-offer-said", { type: "description-observed", lane: true, description: "offer" })], { away: "said", lastAttemptAt: 100_000, budgets: { failCount: 1 } as PeerActorState["budgets"] }),
  sequence("statement offer is applied and answered", [current("statement-offer-received", { type: "description-observed", lane: false, description: "offer" })]),
  sequence("lane offer is applied and answered, and restarts the stall count", [current("lane-offer-received", { type: "description-observed", lane: true, description: "offer" })], { stallSamples: 3 }),
  sequence("new signalling session restores presence and replaces the connection", [current("peer-session-changed", { type: "peer-session-changed",  at: 10 })], { away: "said", lastSignalAt: 1, budgets: { failCount: 2 } as PeerActorState["budgets"] }),
  sequence("an offer from a new remote session replaces the connection and is applied", [current("new-session-offer", { type: "description-observed", lane: false, description: "offer", newRemoteSession: { at: 10 } })], { away: "timeout", lastSignalAt: 1, budgets: { failCount: 2 } as PeerActorState["budgets"] }),
  sequence("an answer from a new remote session replaces the connection and lets the answerer offer", [current("new-session-answer", { type: "description-observed", lane: false, description: "answer", newRemoteSession: { at: 10 } })], { initiator: false, lastSignalAt: 1 }),
  sequence("a connection Mesh replaced itself is adopted: the connection's facts start over, the peer's and the round's budgets stay", [current("replaced-externally", { type: "connection-replaced-externally" }, 2)], { initiator: false, link: "connected", laneOpen: true, framesSeen: 40, stallSamples: 2, framesReadSequence: 3, commandEpoch: 2, openCommands: { "send-answer": 2 }, remoteOffer: "statement", rejoinAnswer: true, lastAttemptAt: 50_000, budgets: { failCount: 2, stallHeals: 2, unseenHeals: 1, noVideoRebuilds: 1, glareRebuilds: 1 } as PeerActorState["budgets"] }),
  sequence("an actor ahead of Mesh moves back to the connection Mesh holds, with Mesh's own last attempt", [current("replaced-externally-older", { type: "connection-replaced-externally", lastAttemptAt: null }, 2)], { initiator: false, connectionEpoch: 3, link: "connected", laneOpen: true, framesSeen: 40, stallSamples: 2, framesReadSequence: 3, commandEpoch: 2, openCommands: { "send-answer": 2 }, remoteOffer: "statement", rejoinAnswer: true, lastAttemptAt: 50_000, budgets: { failCount: 2, stallHeals: 2, unseenHeals: 1, noVideoRebuilds: 1, glareRebuilds: 1 } as PeerActorState["budgets"] }),
  sequence("a connection the actor replaced itself is not adopted again", [current("replaced-externally-known", { type: "connection-replaced-externally" })], { initiator: false, link: "connected", laneOpen: true, framesSeen: 40, stallSamples: 2, framesReadSequence: 3, commandEpoch: 2, openCommands: { "send-answer": 2 }, remoteOffer: "statement", rejoinAnswer: true, lastAttemptAt: 50_000, budgets: { failCount: 2, stallHeals: 2, unseenHeals: 1, noVideoRebuilds: 1, glareRebuilds: 1 } as PeerActorState["budgets"] }),
  sequence("connected resets attempts", [current("connected", { type: "connection-observed", state: "connected" })], { away: "timeout", lastAttemptAt: 50_000, budgets: { failCount: 3 } as PeerActorState["budgets"] }),
  // the times each browser state writes (Mesh's onconnectionstatechange)
  sequence("connected stamps the link's up time once, and ends the grace and the drop", [current("connected-stamps-up", { type: "connection-observed", state: "connected" })], { link: "link-down", disconnectedAt: 95_000, downAt: 95_000, everConnected: true }),
  sequence("a second connected keeps the first up time", [current("connected-again", { type: "connection-observed", state: "connected" })], { link: "connected", upAt: 90_000, everConnected: true }),
  sequence("the browser checking again ends the grace, and leaves the up time, the region and the drop", [current("link-connecting", { type: "connection-observed", state: "connecting" })], { link: "link-down", upAt: 90_000, disconnectedAt: 95_000, downAt: 95_000, everConnected: true }),
  sequence("a fresh connection reading new with nothing up changes nothing", [current("link-new-idle", { type: "connection-observed", state: "new" })], { link: "connecting", downAt: 95_000, everConnected: true }),
  sequence("disconnected starts the grace and, on a link that was up, the drop", [current("link-disconnected", { type: "connection-observed", state: "disconnected" })], { link: "connected", upAt: 50_000, everConnected: true }),
  sequence("a link never up starts the grace but no drop", [current("link-disconnected-never-up", { type: "connection-observed", state: "disconnected" })], { link: "connecting" }),
  sequence("failed keeps the grace and the drop that were already running", [current("link-failed", { type: "connection-observed", state: "failed" })], { link: "link-down", disconnectedAt: 95_000, downAt: 90_000, everConnected: true }),
  sequence("a link down again after a restart keeps the drop it had (the away clock runs through)", [current("link-down-again", { type: "connection-observed", state: "disconnected" })], { link: "connecting", downAt: 90_000, everConnected: true }),
  sequence("connected with the peer present keeps the last attempt", [current("connected-present", { type: "connection-observed", state: "connected" })], { lastAttemptAt: 50_000, budgets: { failCount: 3 } as PeerActorState["budgets"] }),
  sequence("a peer back drops its failures and its last attempt, and is shown back (mark-back)", [current("away-back", { type: "peer-away", away: "back" })], { away: "timeout", lastAttemptAt: 50_000, budgets: { failCount: 3 } as PeerActorState["budgets"] }),
  // a new signalling session, and a peer back after a long absence
  sequence("a new signalling session on a connection that negotiated nothing leaves it, and the peer, alone", [current("session-nothing-negotiated", { type: "peer-session-changed",  at: 10, negotiated: false })], { away: "said", lastSignalAt: 1, lastAttemptAt: 50_000, budgets: { failCount: 2 } as PeerActorState["budgets"] }),
  sequence("a long absence shows a timed-out peer back", [current("resume-timeout-back", { type: "visibility-changed", hidden: false, hiddenForMs: 8_001 })], { hidden: true, away: "timeout", framesSeen: 3, budgets: { failCount: 2 } as PeerActorState["budgets"] }),
  sequence("open lane adopts connected state", [current("channel-open", { type: "channel-observed", state: "open" })]),
  sequence("statement offer request enters statement negotiation", [current("statement-offer-requested", { type: "local-offer-requested", lane: false })]),
  sequence("lane offer request enters lane negotiation, and keeps the stall count", [current("lane-offer-requested", { type: "local-offer-requested", lane: true })], { stallSamples: 3 }),
  sequence("video glare rebuilds once", [current("glare-rebuild", { type: "glare-observed", remoteCarriesVideo: true, lane: true })], { link: "connecting" }),
  sequence("remaining glare fallback rolls back", [current("glare-rollback", { type: "glare-observed", remoteCarriesVideo: true, lane: true })], { link: "connecting", budgets: { glareRebuilds: 1 } as PeerActorState["budgets"] }),
  sequence("impolite glare ignores the offer", [current("glare-ignore", { type: "glare-observed", remoteCarriesVideo: true, polite: false, lane: true })], { link: "connecting" }),
  sequence("statement glare is the peer coming back and ignores the offer", [current("statement-glare-away", { type: "glare-observed", remoteCarriesVideo: false, polite: false, lane: false })], { away: "timeout", link: "connecting", budgets: { failCount: 3 } as PeerActorState["budgets"] }),
  sequence("lane glare restarts the stall count and leaves presence alone", [current("lane-glare-stall", { type: "glare-observed", remoteCarriesVideo: false, polite: false, lane: true })], { away: "timeout", link: "connecting", stallSamples: 3, budgets: { failCount: 3 } as PeerActorState["budgets"] }),
  sequence("codec guard remains same-epoch rollback", [current("codec-rollback", { type: "codec-guard-rtx" })], { link: "connecting" }),
  sequence("lower positive frame count is replacement progress", [current("frame-reset", { type: "stats-observed", readSequence: 4, framesDecoded: 2, browserConnectionState: "connected" })], { link: "connected", framesSeen: 40, framesReadSequence: 3 }),
  sequence("older stats completion is inert", [current("old-stats", { type: "stats-observed", readSequence: 2, framesDecoded: 80, browserConnectionState: "connected" })], { link: "connected", framesSeen: 40, framesReadSequence: 3 }),
  sequence("connected no-video spends one round rebuild", [current("no-video-rebuild", { type: "stats-observed", readSequence: 1, framesDecoded: -1, browserConnectionState: "connected", noVideoDeadline: true })], { link: "connected", laneOpen: true }),
  sequence("unseen heal waits for an inbound video stat", [current("unseen-no-stat", { type: "stats-observed", readSequence: 1, framesDecoded: -1, browserConnectionState: "connected", peerCannotSeeUs: true })], { link: "connected", laneOpen: true }),
  sequence("unseen hard-SDP rebuild waits for an inbound video stat", [current("unseen-no-stat-hard", { type: "stats-observed", readSequence: 1, framesDecoded: -1, browserConnectionState: "connected", peerCannotSeeUs: true })], { link: "connected", laneOpen: true, budgets: { negotiationImmediate: 1 } as PeerActorState["budgets"] }),
  sequence("a stat of zero frames still heals an unseen link", [current("unseen-zero-stat", { type: "stats-observed", readSequence: 1, framesDecoded: 0, browserConnectionState: "connected", peerCannotSeeUs: true })], { link: "connected", laneOpen: true }),
  sequence("a connected link our unanswered offer holds gets a second no-video rebuild in the round", [current("no-video-offer-pending", { type: "stats-observed", readSequence: 1, framesDecoded: 0, browserConnectionState: "connected", noVideoDeadline: true, haveLocalOffer: true })], { link: "connected", laneOpen: true, budgets: { noVideoRebuilds: 1 } as PeerActorState["budgets"] }),
  sequence("a spent no-video rebuild with no offer of ours pending goes on to the heals", [current("no-video-spent", { type: "stats-observed", readSequence: 1, framesDecoded: 0, browserConnectionState: "connected", noVideoDeadline: true, haveLocalOffer: false })], { link: "connected", laneOpen: true, budgets: { noVideoRebuilds: 1 } as PeerActorState["budgets"] }),
  sequence("both no-video rebuilds spent, an offer still pending goes on to the heals", [current("no-video-offer-pending-spent", { type: "stats-observed", readSequence: 1, framesDecoded: 0, browserConnectionState: "connected", noVideoDeadline: true, haveLocalOffer: true })], { link: "connected", laneOpen: true, budgets: { noVideoRebuilds: 2 } as PeerActorState["budgets"] }),
  sequence("standby exempts no-video rebuild", [current("no-video-standby", { type: "stats-observed", readSequence: 1, framesDecoded: -1, browserConnectionState: "connected", noVideoDeadline: true })], { link: "connected", standby: true }),
  sequence("first decoded-frame stall restarts ICE", [current("stall-restart-one", { type: "stats-observed", readSequence: 2, framesDecoded: 4, browserConnectionState: "connected", recoveryDue: true, stallAfter: 1 })], { link: "connected", framesSeen: 4, framesReadSequence: 1 }),
  sequence("second decoded-frame stall rebuilds (#1523 F5: one ICE restart per stall)", [current("stall-rebuild", { type: "stats-observed", readSequence: 3, framesDecoded: 4, browserConnectionState: "connected", recoveryDue: true, stallAfter: 1 })], { link: "connected", framesSeen: 4, framesReadSequence: 2, budgets: { stallHeals: 1 } as PeerActorState["budgets"] }),
  // #1917: frozen video on a live link (packets rising, frames flat): a keyframe ask, then a rebuild, never an ICE restart
  sequence("a frozen link's stall asks the peer for a keyframe", [current("frozen-ask", { type: "stats-observed", readSequence: 2, framesDecoded: 131, browserConnectionState: "connected", recoveryDue: true, healDue: true, stallAfter: 2, packetsMoving: true })], { link: "connected", laneOpen: true, framesSeen: 131, framesReadSequence: 1, stallSamples: 1, frozenSamples: 1 }),
  sequence("an answerer's frozen stall asks after two sweeps, as the initiator's does", [current("frozen-ask-answerer", { type: "stats-observed", readSequence: 3, framesDecoded: 131, browserConnectionState: "connected", recoveryDue: true, healDue: true, stallAfter: 6, frozenAskAfter: 2, packetsMoving: true })], { link: "connected", laneOpen: true, initiator: false, framesSeen: 131, framesReadSequence: 2, stallSamples: 1, frozenSamples: 1 }),
  sequence("an answerer's asked episode waits for its sixth flat sweep to rebuild", [current("frozen-rebuild-answerer-early", { type: "stats-observed", readSequence: 6, framesDecoded: 131, browserConnectionState: "connected", recoveryDue: true, healDue: true, stallAfter: 6, frozenAskAfter: 2, packetsMoving: true })], { link: "connected", laneOpen: true, initiator: false, framesSeen: 131, framesReadSequence: 5, frozenAsked: true, stallSamples: 2 }),
  sequence("an answerer's asked episode rebuilds at its sixth flat sweep", [current("frozen-rebuild-answerer", { type: "stats-observed", readSequence: 7, framesDecoded: 131, browserConnectionState: "connected", recoveryDue: true, healDue: true, stallAfter: 6, frozenAskAfter: 2, packetsMoving: true })], { link: "connected", laneOpen: true, initiator: false, framesSeen: 131, framesReadSequence: 6, frozenAsked: true, stallSamples: 3 }),
  sequence("a frozen stall asks without our own camera", [current("frozen-ask-camera-off", { type: "stats-observed", readSequence: 2, framesDecoded: 131, browserConnectionState: "connected", recoveryDue: false, healDue: true, stallAfter: 2, packetsMoving: true, cameraLive: false })], { link: "connected", laneOpen: true, cameraLive: false, framesSeen: 131, framesReadSequence: 1, stallSamples: 1, frozenSamples: 1 }),
  sequence("a frozen run longer than the stall window (its count restarted by a lane offer) is still frozen", [current("frozen-ask-after-reset", { type: "stats-observed", readSequence: 5, framesDecoded: 131, browserConnectionState: "connected", recoveryDue: true, healDue: true, stallAfter: 2, packetsMoving: true })], { link: "connected", laneOpen: true, framesSeen: 131, framesReadSequence: 4, stallSamples: 1, frozenSamples: 3 }),
  sequence("a frozen link still flat after the ask is rebuilt through recover", [current("frozen-rebuild", { type: "stats-observed", readSequence: 3, framesDecoded: 131, browserConnectionState: "connected", recoveryDue: true, healDue: true, stallAfter: 2, packetsMoving: true })], { link: "connected", laneOpen: true, framesSeen: 131, framesReadSequence: 2, frozenAsked: true }),
  sequence("after the ask, a flat read with packets flat too still rebuilds", [current("frozen-rebuild-packets-flat", { type: "stats-observed", readSequence: 3, framesDecoded: 131, browserConnectionState: "connected", recoveryDue: true, healDue: true, stallAfter: 2, packetsMoving: false })], { link: "connected", laneOpen: true, framesSeen: 131, framesReadSequence: 2, frozenAsked: true }),
  sequence("frames rising after the ask end the frozen episode", [current("frozen-healed", { type: "stats-observed", readSequence: 3, framesDecoded: 140, browserConnectionState: "connected", recoveryDue: true, healDue: true, stallAfter: 2, packetsMoving: true })], { link: "connected", laneOpen: true, framesSeen: 131, framesReadSequence: 2, frozenAsked: true, frozenSamples: 0 }),
  sequence("a frozen stall waits for the heal window", [current("frozen-held", { type: "stats-observed", readSequence: 2, framesDecoded: 131, browserConnectionState: "connected", recoveryDue: false, healDue: false, stallAfter: 2, packetsMoving: true })], { link: "connected", laneOpen: true, framesSeen: 131, framesReadSequence: 1, stallSamples: 1, frozenSamples: 1 }),
  sequence("an asked episode never falls to the ICE-restart ladder while the window is shut", [current("frozen-asked-held", { type: "stats-observed", readSequence: 3, framesDecoded: 131, browserConnectionState: "connected", recoveryDue: true, healDue: false, stallAfter: 1, packetsMoving: true })], { link: "connected", laneOpen: true, framesSeen: 131, framesReadSequence: 2, frozenAsked: true }),
  sequence("one stall sweep with packets flat is a dead transport: today's ICE restart", [current("frozen-packets-flat", { type: "stats-observed", readSequence: 2, framesDecoded: 131, browserConnectionState: "connected", recoveryDue: true, healDue: true, stallAfter: 2, packetsMoving: false })], { link: "connected", laneOpen: true, framesSeen: 131, framesReadSequence: 1, stallSamples: 1, frozenSamples: 1 }),
  sequence("a read with no packet reading is not a frozen one", [current("frozen-packets-unread", { type: "stats-observed", readSequence: 2, framesDecoded: 131, browserConnectionState: "connected", recoveryDue: true, healDue: true, stallAfter: 2 })], { link: "connected", laneOpen: true, framesSeen: 131, framesReadSequence: 1, stallSamples: 1, frozenSamples: 1 }),
  sequence("a frozen read while hidden asks nothing", [current("frozen-hidden-held", { type: "stats-observed", readSequence: 2, framesDecoded: 131, browserConnectionState: "connected", recoveryDue: true, healDue: true, stallAfter: 2, packetsMoving: true })], { link: "connected", laneOpen: true, hidden: true, framesSeen: 131, framesReadSequence: 1, frozenSamples: 1 }),
  sequence("a frozen read of a peer away asks nothing", [current("frozen-away-held", { type: "stats-observed", readSequence: 2, framesDecoded: 131, browserConnectionState: "connected", recoveryDue: true, healDue: true, stallAfter: 2, packetsMoving: true })], { link: "connected", laneOpen: true, away: "said", framesSeen: 131, framesReadSequence: 1, frozenSamples: 1 }),
  sequence("a held read ends an asked episode, so the return asks afresh", [current("frozen-asked-hidden-held", { type: "stats-observed", readSequence: 3, framesDecoded: 131, browserConnectionState: "connected", recoveryDue: true, healDue: true, stallAfter: 2, packetsMoving: true })], { link: "connected", laneOpen: true, hidden: true, framesSeen: 131, framesReadSequence: 2, frozenAsked: true }),
  sequence("hiding the page ends a frozen episode", [current("frozen-hide-ends-episode", { type: "visibility-changed", hidden: true })], { link: "connected", laneOpen: true, framesSeen: 131, frozenAsked: true, frozenSamples: 1, stallSamples: 1 }),
  sequence("a frozen link whose round's two rebuilds are spent gets no ask, and no ICE restart", [current("frozen-budget-spent", { type: "stats-observed", readSequence: 2, framesDecoded: 131, browserConnectionState: "connected", recoveryDue: true, healDue: true, stallAfter: 2, frozenAskAfter: 2, packetsMoving: true })], { link: "connected", laneOpen: true, framesSeen: 131, framesReadSequence: 1, stallSamples: 1, frozenSamples: 1, budgets: { frozenRebuilds: 2 } as PeerActorState["budgets"] }),
  sequence("a frozen read of a standby link asks nothing", [current("frozen-standby-held", { type: "stats-observed", readSequence: 2, framesDecoded: 131, browserConnectionState: "connected", recoveryDue: true, healDue: true, stallAfter: 2, packetsMoving: true })], { link: "connected", laneOpen: true, standby: true, framesSeen: 131, framesReadSequence: 1, frozenSamples: 1 }),
  sequence("one-way claim spends authorised hard SDP rebuild", [current("one-way-hard", { type: "stats-observed", readSequence: 1, framesDecoded: 2, browserConnectionState: "connected", peerCannotSeeUs: true })], { link: "connected", budgets: { negotiationImmediate: 1 } as PeerActorState["budgets"] }),
  sequence("bare one-way claim uses bounded ICE", [current("one-way-restart", { type: "stats-observed", readSequence: 2, framesDecoded: 3, browserConnectionState: "connected", peerCannotSeeUs: true })], { link: "connected", framesSeen: 2, framesReadSequence: 1 }),
  sequence("our camera up after the start lets the unseen heal run", [current("camera-came-up", { type: "stats-observed", readSequence: 2, framesDecoded: 3, browserConnectionState: "connected", peerCannotSeeUs: true, cameraLive: true })], { link: "connected", framesSeen: 2, framesReadSequence: 1, cameraLive: false }),
  sequence("hidden stats spend no watchdog budget", [current("hidden-stats-held", { type: "stats-observed", readSequence: 2, framesDecoded: 3, browserConnectionState: "connected", peerCannotSeeUs: true })], { link: "connected", hidden: true }),
  sequence("exactly eight seconds requests keyframe only", [current("resume-eight", { type: "visibility-changed", hidden: false, hiddenForMs: 8_000 })], { hidden: true, away: "timeout", lastAttemptAt: 50_000, budgets: { failCount: 2 } as PeerActorState["budgets"] }),
  sequence("strictly over eight seconds kicks and sweeps", [current("resume-over-eight", { type: "visibility-changed", hidden: false, hiddenForMs: 8_001 })], { hidden: true, away: "timeout", lastAttemptAt: 50_000, budgets: { failCount: 2 } as PeerActorState["budgets"] }),
  sequence("a page never marked away sweeps after a long absence, with no keyframe", [current("resume-never-away", { type: "visibility-changed", hidden: false, hiddenForMs: 8_001, keyframe: false })], { away: "timeout", lastAttemptAt: 50_000, budgets: { failCount: 2 } as PeerActorState["budgets"] }),
  sequence("strictly over eight seconds preserves explicit said-away", [current("resume-over-eight-said", { type: "visibility-changed", hidden: false, hiddenForMs: 8_001 })], { hidden: true, away: "said", budgets: { failCount: 2 } as PeerActorState["budgets"] }),
  sequence("standby holds outbound video", [current("standby", { type: "standby-changed", standby: true })], { link: "connected" }),
  sequence("a promotion restarts the stall count and keeps the stall's heals", [current("promote-keeps-heals", { type: "standby-changed", standby: false })], { link: "connected", standby: true, stallSamples: 2, budgets: { stallHeals: 1 } as PeerActorState["budgets"] }),
  sequence("an unseen ICE restart restarts the stall count", [current("unseen-stall-reset", { type: "stats-observed", readSequence: 2, framesDecoded: 4, browserConnectionState: "connected", peerCannotSeeUs: true, stallAfter: 6, recoveryDue: true })], { link: "connected", laneOpen: true, framesSeen: 4, framesReadSequence: 1, stallSamples: 1 }),
  // #1523: the per-episode unseen budget's refill — a sweep whose peer view
  // says it decodes our video again sets unseenHeals back to 0
  sequence("#1523 the unseen budget refills once the peer sees our video again", [current("unseen-refill", { type: "stats-observed", readSequence: 2, framesDecoded: 3, browserConnectionState: "connected", peerSeesUs: true })], { link: "connected", laneOpen: true, framesSeen: 2, framesReadSequence: 1, budgets: { unseenHeals: 1 } as PeerActorState["budgets"] }),
  // #1523 F5: no unseen ICE restart while our lane offer is unanswered
  sequence("#1523 no unseen ICE restart while our lane offer is unanswered", [current("unseen-offer-pending", { type: "stats-observed", readSequence: 2, framesDecoded: 3, browserConnectionState: "connected", peerCannotSeeUs: true, haveLocalOffer: true })], { link: "connected", laneOpen: true, framesSeen: 2, framesReadSequence: 1 }),
  sequence("network change preserves open lane", [current("network-restart", { type: "network-changed" })], { link: "connected", laneOpen: true }),
  sequence("network change rebuilds closed lane", [current("network-rebuild", { type: "network-changed" })], { link: "link-down", laneOpen: false }),
  // every recovery Mesh grants the answerer's offer on
  // #1608: a change inferred from a new local address leaves working links alone
  sequence("an inferred network change leaves a link already on the new network", [current("network-inferred-on-new", { type: "network-changed", inferred: true, onNewNetwork: true, browserConnectionState: "connecting" })], { link: "connecting", laneOpen: false }),
  sequence("an inferred network change leaves a connected link to its supervision", [current("network-inferred-connected", { type: "network-changed", inferred: true, onNewNetwork: false, browserConnectionState: "connected" })], { link: "connected", laneOpen: true }),
  sequence("an inferred network change still repairs a link that dropped", [current("network-inferred-down", { type: "network-changed", inferred: true, onNewNetwork: false, browserConnectionState: "disconnected" })], { link: "link-down", laneOpen: true }),
  sequence("a network change on the answerer's side recovers as on the initiator's", [current("network-answerer", { type: "network-changed" })], { link: "connected", laneOpen: true, initiator: false }),
  sequence("a stall restart on the answerer's side recovers as on the initiator's", [current("stall-answerer", { type: "stats-observed", readSequence: 2, framesDecoded: 4, browserConnectionState: "connected", recoveryDue: true, stallAfter: 1 })], { link: "connected", framesSeen: 4, framesReadSequence: 1, initiator: false }),
  sequence("a stall rebuild on the answerer's side recovers as on the initiator's", [current("stall-rebuild-answerer", { type: "stats-observed", readSequence: 3, framesDecoded: 4, browserConnectionState: "connected", recoveryDue: true, stallAfter: 1 })], { link: "connected", framesSeen: 4, framesReadSequence: 2, initiator: false, budgets: { stallHeals: 1 } as PeerActorState["budgets"] }),
  sequence("a no-video rebuild on the answerer's side recovers as on the initiator's", [current("no-video-answerer", { type: "stats-observed", readSequence: 1, framesDecoded: -1, browserConnectionState: "connected", noVideoDeadline: true })], { link: "connected", laneOpen: true, initiator: false }),
  sequence("a glare rebuild on the answerer's side recovers as on the initiator's", [current("glare-rebuild-answerer", { type: "glare-observed", remoteCarriesVideo: true, lane: true })], { link: "connecting", initiator: false }),
  sequence("a new signalling session over our offer lets the answerer offer", [current("session-over-our-offer", { type: "peer-session-changed", at: 10, localOffer: true })], { initiator: false }),
  sequence("a relay policy change configures the link and rebuilds nothing", [current("policy-unchanged", { type: "ice-policy-changed" })], { link: "connected", laneOpen: true }),
  sequence("round resets only round budgets", [current("round-change", { type: "round-changed", roundGeneration: 2 })], { roundGeneration: 1, budgets: { unseenHeals: 1, noVideoRebuilds: 1, negotiationImmediate: 1, negotiationUnseen: 1, glareRebuilds: 1 } as PeerActorState["budgets"] }),
  sequence("current completion lands", [current("completion", { type: "command-completed", commandEpoch: 1, commandKind: "send-offer", outcome: "resolved" })], { commandEpoch: 1, openCommands: { "send-offer": 1 } }),
  sequence("old completion cannot land", [current("old-completion", { type: "command-completed", commandEpoch: 1, commandKind: "send-offer", outcome: "resolved" })], { commandEpoch: 2, openCommands: { "send-offer": 2 } }),
  sequence("an older command's result lands after another kind completed", [current("overtaken-completion", { type: "command-completed", commandEpoch: 2, commandKind: "send-offer", outcome: "rejected" })], { link: "connecting", commandEpoch: 3, openCommands: { "send-offer": 2 } }),
  sequence("rejected media command keeps the connection", [current("rejected-media-completion", { type: "command-completed", commandEpoch: 1, commandKind: "request-keyframe", outcome: "rejected" })], { commandEpoch: 1, openCommands: { "request-keyframe": 1 }, link: "connected", laneOpen: true }),
  // a rejected command's outcome depends on the site that ran it; a site
  // that only logs, or no stamp, changes nothing.
  sequence("an unstamped rejected connection command is only logged", [current("unstamped-rejection", { type: "command-completed", commandEpoch: 1, commandKind: "set-remote-description", outcome: "rejected" })], { commandEpoch: 1, openCommands: { "set-remote-description": 1 }, link: "connecting" }),
  sequence("the supervisor's ICE restart that throws falls back to a rebuild", [current("restart-rejected-rebuild", { type: "command-completed", commandEpoch: 1, commandKind: "restart-ice", outcome: "rejected", site: "supervisor-recovery" })], { commandEpoch: 1, openCommands: { "restart-ice": 1 }, link: "connecting", laneOpen: true, budgets: { failCount: 1 } as PeerActorState["budgets"] }),
  sequence("a network change's ICE restart that throws falls back to a rebuild", [current("restart-rejected-network", { type: "command-completed", commandEpoch: 1, commandKind: "restart-ice", outcome: "rejected", site: "network-change" })], { commandEpoch: 1, openCommands: { "restart-ice": 1 }, link: "connecting", laneOpen: true }),
  sequence("an answerer whose restart failed may offer on the rebuilt connection", [current("restart-rejected-answerer", { type: "command-completed", commandEpoch: 1, commandKind: "restart-ice", outcome: "rejected", site: "network-change" })], { commandEpoch: 1, openCommands: { "restart-ice": 1 }, link: "connecting", laneOpen: true, initiator: false }),
  sequence("a media-stall ICE restart that throws is only logged", [current("restart-rejected-logged", { type: "command-completed", commandEpoch: 1, commandKind: "restart-ice", outcome: "rejected", site: "media-stall" })], { commandEpoch: 1, openCommands: { "restart-ice": 1 }, link: "connecting", laneOpen: true }),
  sequence("an unseen heal's ICE restart that throws is only logged", [current("restart-rejected-unseen-logged", { type: "command-completed", commandEpoch: 1, commandKind: "restart-ice", outcome: "rejected", site: "peer-no-video" })], { commandEpoch: 1, openCommands: { "restart-ice": 1 }, link: "connecting", laneOpen: true }),
  sequence("a hard SDP error on a lane offer spends the round's immediate rebuild", [current("lane-offer-hard-rejected", { type: "command-completed", commandEpoch: 1, commandKind: "send-offer", outcome: "rejected", site: "lane", reason: "hard-sdp", roundGeneration: 0 })], { commandEpoch: 1, openCommands: { "send-offer": 1 }, link: "connecting", laneOpen: true, initiator: false }),
  sequence("a hard SDP error applying a lane description spends the round's immediate rebuild", [current("lane-srd-hard-rejected", { type: "command-completed", commandEpoch: 1, commandKind: "set-remote-description", outcome: "rejected", site: "lane", reason: "hard-sdp", roundGeneration: 0 })], { commandEpoch: 1, openCommands: { "set-remote-description": 1 }, link: "connecting", laneOpen: true }),
  sequence("a hard SDP error on the codec guard's rollback spends the round's immediate rebuild", [current("codec-rollback-hard-rejected", { type: "command-completed", commandEpoch: 1, commandKind: "rollback", outcome: "rejected", site: "lane", reason: "hard-sdp", roundGeneration: 0 })], { commandEpoch: 2, openCommands: { rollback: 1, "send-offer": 2 }, link: "connecting", laneOpen: true }),
  sequence("a hard lane SDP error with the immediate rebuild spent is only logged", [current("lane-hard-spent", { type: "command-completed", commandEpoch: 1, commandKind: "set-remote-description", outcome: "rejected", site: "lane", reason: "hard-sdp", roundGeneration: 0 })], { commandEpoch: 1, openCommands: { "set-remote-description": 1 }, link: "connecting", laneOpen: true, budgets: { negotiationImmediate: 1 } as PeerActorState["budgets"] }),
  sequence("a hard lane SDP error from an earlier round is only logged", [current("lane-hard-old-round", { type: "command-completed", commandEpoch: 1, commandKind: "send-offer", outcome: "rejected", site: "lane", reason: "hard-sdp", roundGeneration: 1 })], { commandEpoch: 1, openCommands: { "send-offer": 1 }, link: "connecting", laneOpen: true, roundGeneration: 2 }),
  sequence("a lane SDP error that is not a hard one is only logged", [current("lane-soft-rejected", { type: "command-completed", commandEpoch: 1, commandKind: "send-offer", outcome: "rejected", site: "lane", reason: "other", roundGeneration: 0 })], { commandEpoch: 1, openCommands: { "send-offer": 1 }, link: "connecting", laneOpen: true }),
  sequence("a hard SDP error on our statement offer is only logged", [current("statement-offer-sent-rejected", { type: "command-completed", commandEpoch: 1, commandKind: "send-offer", outcome: "rejected", site: "statement-offer-sent", reason: "hard-sdp" })], { commandEpoch: 1, openCommands: { "send-offer": 1 }, link: "connecting" }),
  sequence("a virgin connection that refuses a statement offer is re-initiated", [current("offer-refused-virgin", { type: "command-completed", commandEpoch: 1, commandKind: "set-remote-description", outcome: "rejected", site: "statement-offer-received", reason: "virgin-pc" })], { commandEpoch: 1, openCommands: { "set-remote-description": 1 }, link: "connecting", initiator: false }),
  sequence("a statement offer refused with InvalidAccessError is applied to a rebuilt responder", [current("offer-refused-invalid-access", { type: "command-completed", commandEpoch: 1, commandKind: "set-remote-description", outcome: "rejected", site: "statement-offer-received", reason: "invalid-access", at: 10 })], { commandEpoch: 1, openCommands: { "set-remote-description": 1 }, link: "connecting", away: "timeout", lastSignalAt: 1, budgets: { failCount: 2 } as PeerActorState["budgets"] }),
  sequence("any other refusal of a statement offer is rethrown and logged", [current("offer-refused-other", { type: "command-completed", commandEpoch: 1, commandKind: "set-remote-description", outcome: "rejected", site: "statement-offer-received", reason: "other" })], { commandEpoch: 1, openCommands: { "set-remote-description": 1 }, link: "connecting" }),
  sequence("a refusal on the connection rebuilt for the offer is rethrown and logged", [current("offer-retry-refused", { type: "command-completed", commandEpoch: 1, commandKind: "set-remote-description", outcome: "rejected", site: "statement-offer-retried", reason: "invalid-access" })], { commandEpoch: 1, openCommands: { "set-remote-description": 1 }, link: "connecting" }),
  sequence("a statement answer refused on a connection past our offer is logged", [current("statement-answer-rejected", { type: "command-completed", commandEpoch: 1, commandKind: "set-remote-description", outcome: "rejected", site: "statement-answer", reason: "hard-sdp", haveLocalOffer: false })], { commandEpoch: 1, openCommands: { "set-remote-description": 1 }, link: "connecting" }),
  sequence("a statement answer refused while our offer holds the connection rebuilds it as an offerer at once", [current("answer-refused", { type: "command-completed", commandEpoch: 1, commandKind: "set-remote-description", outcome: "rejected", site: "statement-answer", reason: "hard-sdp", haveLocalOffer: true })], { commandEpoch: 1, openCommands: { "set-remote-description": 1 }, link: "connecting", offerSentAt: 95_000, budgets: { failCount: 1 } as PeerActorState["budgets"] }),
  sequence("a refused answer with the round's immediate rebuild spent is only logged", [current("answer-refused-spent", { type: "command-completed", commandEpoch: 1, commandKind: "set-remote-description", outcome: "rejected", site: "statement-answer", reason: "other", haveLocalOffer: true })], { commandEpoch: 1, openCommands: { "set-remote-description": 1 }, link: "connecting", budgets: { negotiationImmediate: 1 } as PeerActorState["budgets"] }),
  sequence("the polite side whose answer its own offer displaced answers the peer's offer on a fresh responder", [current("answer-displaced", { type: "command-completed", commandEpoch: 2, commandKind: "send-answer", outcome: "stale", site: "statement-answer", displaced: true })], { commandEpoch: 2, openCommands: { "send-answer": 2 }, link: "connecting", initiator: false, lastRecvDescAt: 99_000, budgets: { failCount: 1 } as PeerActorState["budgets"] }),
  sequence("the impolite side whose answer its own offer displaced leaves it to its offer", [current("answer-displaced-impolite", { type: "command-completed", commandEpoch: 2, commandKind: "send-answer", outcome: "stale", site: "statement-answer", displaced: true })], { commandEpoch: 2, openCommands: { "send-answer": 2 }, link: "connecting" }),
  sequence("an answer dropped for a newer offer, which its own run answers, changes nothing", [current("answer-stale-newer", { type: "command-completed", commandEpoch: 2, commandKind: "send-answer", outcome: "stale", site: "statement-answer" })], { commandEpoch: 2, openCommands: { "send-answer": 2 }, link: "connecting", initiator: false }),
  sequence("a stale codec guard closes its offer and sends nothing", [current("codec-guard-stale", { type: "command-completed", commandEpoch: 2, commandKind: "send-offer", outcome: "stale", site: "lane" })], { commandEpoch: 2, openCommands: { "send-offer": 2 }, link: "connecting", laneOpen: true }),
  // the applied remote offer is answered, and the answer lands
  // where Mesh sends it, bails stale or is refused.
  sequence("an applied statement offer is answered", [current("statement-offer-applied", { type: "command-completed", commandEpoch: 1, commandKind: "set-remote-description", outcome: "resolved" })], { commandEpoch: 1, openCommands: { "set-remote-description": 1 }, remoteOffer: "statement", link: "connecting" }),
  sequence("an applied lane offer is answered on the lane", [current("lane-offer-applied", { type: "command-completed", commandEpoch: 1, commandKind: "set-remote-description", outcome: "resolved" })], { commandEpoch: 1, openCommands: { "set-remote-description": 1 }, remoteOffer: "lane", link: "connecting", laneOpen: true }),
  sequence("an offer applied to the connection rebuilt for it is answered, and the rejoin carries on", [current("rejoin-offer-applied", { type: "command-completed", commandEpoch: 2, commandKind: "set-remote-description", outcome: "resolved" }, 2)], { connectionEpoch: 2, commandEpoch: 2, openCommands: { "set-remote-description": 2 }, remoteOffer: "statement", rejoinAnswer: true, link: "connecting", initiator: false }),
  sequence("an applied remote answer is not answered", [current("remote-answer-applied", { type: "command-completed", commandEpoch: 1, commandKind: "set-remote-description", outcome: "resolved" })], { commandEpoch: 1, openCommands: { "set-remote-description": 1 }, link: "connecting" }),
  sequence("a sent answer closes its command", [current("answer-sent", { type: "command-completed", commandEpoch: 2, commandKind: "send-answer", outcome: "resolved" })], { commandEpoch: 2, openCommands: { "send-answer": 2 }, link: "connecting" }),
  sequence("after the rejoin's answer, this side makes its channel and may offer", [current("rejoin-answer-sent", { type: "command-completed", commandEpoch: 3, commandKind: "send-answer", outcome: "resolved" }, 2)], { connectionEpoch: 2, commandEpoch: 3, openCommands: { "send-answer": 3 }, rejoinAnswer: true, link: "connecting", initiator: false }),
  sequence("a rejoin answer that bailed stale makes no channel", [current("rejoin-answer-stale", { type: "command-completed", commandEpoch: 3, commandKind: "send-answer", outcome: "stale", site: "statement-answer" }, 2)], { connectionEpoch: 2, commandEpoch: 3, openCommands: { "send-answer": 3 }, rejoinAnswer: true, link: "connecting", initiator: false }),
  sequence("a hard SDP error setting the lane answer spends the round's immediate rebuild", [current("lane-answer-hard-rejected", { type: "command-completed", commandEpoch: 2, commandKind: "send-answer", outcome: "rejected", site: "lane", reason: "hard-sdp", roundGeneration: 0 })], { commandEpoch: 2, openCommands: { "send-answer": 2 }, link: "connecting", laneOpen: true, initiator: false }),
  sequence("a statement answer whose local description or gather fails is logged", [current("statement-answer-step-rejected", { type: "command-completed", commandEpoch: 2, commandKind: "send-answer", outcome: "rejected", site: "statement-answer", reason: "hard-sdp" })], { commandEpoch: 2, openCommands: { "send-answer": 2 }, link: "connecting" }),
  // a lane offer superseded after it was set
  sequence("a superseded lane offer still set is rolled back", [current("lane-offer-superseded", { type: "local-offer-superseded", haveLocalOffer: true })], { commandEpoch: 1, link: "connecting", laneOpen: true }),
  sequence("a superseded lane offer the connection already left is inert", [current("lane-offer-superseded-left", { type: "local-offer-superseded", haveLocalOffer: false })], { commandEpoch: 1, link: "connecting", laneOpen: true }),
  // the supervisor's causes, decided from the facts of the sweep
  sequence("a sweep delivered while the page is hidden holds", [tick("tick-hidden-held", { browserConnectionState: "failed" })], { hidden: true }),
  sequence("a sweep over a healthy connected link does nothing", [tick("tick-connected-idle", { browserConnectionState: "connected", upAt: 10_000, downAt: 0, disconnectedAt: 0 })]),
  sequence("a disconnected link past its grace with the lane open restarts ICE", [tick("tick-restart", { disconnectedAt: 95_999 })]),
  sequence("a disconnected link inside its grace is left to mend", [tick("tick-grace", { disconnectedAt: 96_000 })]),
  sequence("a disconnected link with its restarts spent is rebuilt", [tick("tick-restarts-spent", { disconnectedAt: 90_000 })], { budgets: { failCount: 1 } as PeerActorState["budgets"] }),
  sequence("a disconnected link whose lane is closed is rebuilt", [tick("tick-closed-lane", { disconnectedAt: 90_000, laneOpen: false })]),
  sequence("a disconnected link that cannot restart ICE is rebuilt", [tick("tick-no-restart-api", { disconnectedAt: 90_000, canRestartIce: false })]),
  sequence("a failed link is rebuilt", [tick("tick-failed", { browserConnectionState: "failed" })]),
  sequence("a due link inside its backoff waits", [tick("tick-backoff", { browserConnectionState: "failed" })], { lastAttemptAt: 94_001, budgets: { failCount: 1 } as PeerActorState["budgets"] }),
  // #1951 / #1956: gatherStallBy, 5 s after both descriptions are in, on a
  // connection made with TURN that gathered host candidates only
  sequence("#1951 a stalled gathering is rebuilt at gatherStallBy as a failure, cause gathering-stalled", [tick("tick-gather-stalled", gatherStalled)], describedAt(95_000)),
  // no role gate: only the stalled side reads its own candidates, and in #1951 that was the answerer
  sequence("#1951 the answerer's stalled gathering is rebuilt too", [tick("tick-gather-stalled-answerer", { ...gatherStalled, lastRecvDescAt: 95_000 })], { ...describedAt(95_000), initiator: false }),
  sequence("#1951 a stalled gathering waits for gatherStallBy", [tick("tick-gather-stall-early", gatherStalled)], describedAt(95_001)),
  sequence("#1951 a connection that gathered a srflx or relay candidate is no stall", [tick("tick-gather-srflx", { ...gatherStalled, srflxOrRelaySeen: true })], describedAt(95_000)),
  sequence("#1951 a connection made without TURN is no stall", [tick("tick-gather-no-turn", { ...gatherStalled, turnConfigured: false })], describedAt(95_000)),
  sequence("#1951 a relay-only connection is no stall", [tick("tick-gather-relay-only", { ...gatherStalled, relayOnly: true })], describedAt(95_000)),
  sequence("#1951 a completed gathering is no stall", [tick("tick-gather-complete", { ...gatherStalled, gatheringComplete: true })], describedAt(95_000)),
  sequence("#1951 a sweep that carries no gather facts reads no stall", [tick("tick-gather-no-facts", { ...gatherStalled, srflxOrRelaySeen: undefined, gatheringComplete: undefined, turnConfigured: undefined, relayOnly: undefined })], describedAt(95_000)),
  sequence("#1951 a stalled gathering is rebuilt early once a round", [tick("tick-gather-spent", gatherStalled)], { ...describedAt(95_000), budgets: { gatherStallRebuilds: 1 } as PeerActorState["budgets"] }),
  sequence("#1951 a stalled gathering inside the backoff waits", [tick("tick-gather-backoff", gatherStalled)], { ...describedAt(95_000), lastAttemptAt: 94_001, budgets: { failCount: 1 } as PeerActorState["budgets"] }),
  sequence("#1951 a failed link whose gathering stalled keeps the cause failed", [tick("tick-gather-failed", { ...gatherStalled, browserConnectionState: "failed" })], describedAt(95_000)),
  sequence("#1951 a stalled gathering is held while the page is hidden", [tick("tick-gather-hidden", gatherStalled)], { ...describedAt(95_000), hidden: true }),
  sequence("#1951 our first local description on a connection is stamped", [current("local-description-set", { type: "local-description-set" })]),
  sequence("#1951 a later local description on the same connection keeps the first", [current("local-description-set-again", { type: "local-description-set" })], { localDescribedAt: 90_000 }),
  sequence("#1951 the time the page was hidden after both descriptions were in does not count", [current("resume-gather-shift", { type: "visibility-changed", hidden: false, hiddenForMs: 4_000 })], { ...describedAt(97_000), hidden: true }),
  sequence("#1951 hidden time after the deadline had passed does not shift it", [current("resume-gather-after-deadline", { type: "visibility-changed", hidden: false, hiddenForMs: 4_000 })], { ...describedAt(90_000), hidden: true }),
  sequence("#1951 a rolled-back local offer of ours is forgotten: the next local description starts the clock", [current("rollback-clears-local-description", { type: "local-offer-superseded", haveLocalOffer: true })], { ...describedAt(97_000), laneOpen: true }),
  sequence("#1951 a new round gives the peer its early rebuild back", [current("round-change-gather", { type: "round-changed", roundGeneration: 1 })], { ...describedAt(95_000), budgets: { gatherStallRebuilds: 1 } as PeerActorState["budgets"] }),
  sequence("a due link past its backoff is attempted", [tick("tick-backoff-over", { disconnectedAt: 90_000 })], { lastAttemptAt: 94_000, budgets: { failCount: 1 } as PeerActorState["budgets"] }),
  sequence("the backoff stops doubling at twenty seconds", [tick("tick-backoff-cap", { browserConnectionState: "failed" })], { lastAttemptAt: 80_000, budgets: { failCount: 5 } as PeerActorState["budgets"] }),
  sequence("a peer who said it left is not healed", [tick("tick-said", { browserConnectionState: "failed", away: "said" })]),
  sequence("a link down past AWAY_AFTER marks the peer away, and a peer still heard is healed", [tick("tick-away", { downAt: 91_999, disconnectedAt: 91_999 })]),
  sequence("a link down for exactly AWAY_AFTER is not away yet", [tick("tick-away-boundary", { downAt: 92_000, disconnectedAt: 92_000 })]),
  sequence("a peer already timed out is not marked again, and is still healed", [tick("tick-away-already", { away: "timeout", downAt: 90_000, disconnectedAt: 90_000 })], { away: "timeout" }),
  sequence("a link that was never up is not marked away", [tick("tick-away-never-up", { everConnected: false, downAt: 90_000, disconnectedAt: 0, firstHeardAt: null })]),
  sequence("a peer not heard for 45 s whose link dropped 30 s ago is left to presence", [tick("tick-gone", { browserConnectionState: "failed", lastSignalAt: 55_000, downAt: 70_000, away: "timeout" })], { away: "timeout" }),
  sequence("a peer heard just under 45 s ago is still chased", [tick("tick-fresh-boundary", { browserConnectionState: "failed", lastSignalAt: 55_001, downAt: 70_000, away: "timeout" })], { away: "timeout" }),
  sequence("a link that dropped just under 30 s ago is chased before a hello", [tick("tick-just-dropped", { browserConnectionState: "failed", lastSignalAt: null, downAt: 70_001, away: "timeout" })], { away: "timeout" }),
  sequence("a yield unanswered for 30 s re-initiates the peer", [tick("tick-stranded", yielded)]),
  sequence("a yield unanswered re-initiates even inside the backoff", [tick("tick-stranded-backoff", yielded)], { lastAttemptAt: 99_000, budgets: { failCount: 2 } as PeerActorState["budgets"] }),
  sequence("a yield unanswered for under 30 s waits", [tick("tick-stranded-early", { ...yielded, yieldedAt: 70_001 })]),
  sequence("a yielded connection that has a channel is left as it is", [tick("tick-stranded-channel", { ...yielded, hasChannel: true })]),
  sequence("a yielded connection that took the peer's offer is not stranded", [tick("tick-stranded-described", { ...yielded, remoteDescription: true })]),
  sequence("the initiator rebuilds a link that never connected when nothing came back", [tick("tick-never-due", neverUp)]),
  sequence("a link is rebuilt exactly at connectBy", [tick("tick-never-initial-boundary", { ...neverUp, firstHeardAt: 82_000 })]),
  sequence("a description of theirs under 15 s old lets that negotiation finish", [tick("tick-never-quiet", { ...neverUp, lastRecvDescAt: 85_001 })]),
  sequence("the initiator waits out the answer to its offer", [tick("tick-never-offer-waiting", { ...neverUp, offerSentAt: 70_001 })]),
  sequence("the initiator rebuilds once its offer is 30 s unanswered", [tick("tick-never-offer-overdue", { ...neverUp, offerSentAt: 70_000 })]),
  sequence("the answerer leaves a link it heard the initiator on", [tick("tick-never-answerer-heard", { ...neverUp, lastRecvDescAt: 80_000 })], { initiator: false }),
  sequence("the answerer rebuilds a link it never heard the initiator on, and may offer", [tick("tick-never-answerer-unheard", neverUp)], { initiator: false }),
  sequence("a fresh connection of a peer connected before is rebuilt as an offerer at its connectBy", [tick("tick-connect-by-ever", freshEverUp(82_000))], { initiator: false }),
  sequence("a fresh connection of a peer connected before waits for its own connectBy, not the peer's first hello", [tick("tick-connect-by-ever-early", freshEverUp(82_001))], { initiator: false }),
  sequence("an offer unanswered for 30 s yields to the peer", [tick("tick-yield", unanswered)]),
  sequence("an offer unanswered for under 30 s waits", [tick("tick-yield-early", { ...unanswered, offerSentAt: 70_001 })]),
  sequence("an offer over an open lane has no answer wait", [tick("tick-yield-lane-open", { ...unanswered, laneOpen: true })]),
  sequence("a connected link whose channel never opened is rebuilt, spending the round's no-video rebuild", [tick("tick-cno", stalledChannel)]),
  sequence("a connected link without a channel for under 23 s waits", [tick("tick-cno-early", { ...stalledChannel, upAt: 77_001 })]),
  sequence("a channel stall is rebuilt once a round", [tick("tick-cno-spent", stalledChannel)], { budgets: { noVideoRebuilds: 1 } as PeerActorState["budgets"] }),
  sequence("a link that showed video this round is no channel stall", [tick("tick-cno-video", { ...stalledChannel, sawVideoThisRound: true })]),
  sequence("a channel stall is rebuilt even for a peer who said it left", [tick("tick-cno-said", { ...stalledChannel, away: "said" })], { away: "said" }),
  sequence("a channel stall waits out the backoff", [tick("tick-cno-backoff", stalledChannel)], { lastAttemptAt: 88_001, budgets: { failCount: 2 } as PeerActorState["budgets"] }),
  // the sweep decides from the actor's own budgets (the tick carries no
  // copies of them from Mesh)
  sequence("a sweep waits out the actor's own backoff", [tick("tick-mesh-backoff-copy", { disconnectedAt: 90_000 })], { lastAttemptAt: 99_999, budgets: { failCount: 4 } as PeerActorState["budgets"] }),
  sequence("a channel stall spends the actor's own no-video rebuild", [tick("tick-cno-mesh-copy", stalledChannel)], { budgets: { noVideoRebuilds: 1 } as PeerActorState["budgets"] }),
  sequence("remove closes actor", [current("remove", { type: "peer-removed" })]),
  sequence("a removal forgets the peer's failures and unseen heals, and keeps the round's budgets", [current("remove-budgets", { type: "peer-removed" })], { initiator: false, lastAttemptAt: 50_000, away: "timeout", lastSignalAt: 40_000, budgets: { failCount: 2, unseenHeals: 1, noVideoRebuilds: 1, glareRebuilds: 1, negotiationImmediate: 1 } as PeerActorState["budgets"] }),
  sequence("closed actor ignores later facts", [current("after-close", { type: "peer-heard", at: 20 })], { link: "closed" }),
  sequence("a closing room closes the actor", [current("room-close", { type: "room-closed" })], { link: "connected", laneOpen: true }),
]

type PeerOutcome = "transition" | "no-op"
type PeerFactKey = PeerActorEvent["type"]
export type PeerCellKey = `${PeerFactKey}:${PeerOutcome}` | "clock:connect-by" | "clock:gather-stall"

const factKey = (event: PeerActorEvent): PeerFactKey => event.type

const witnessAt = (
  template: NamedSequence<PeerTestEvent, PeerActorState, ModelPeerState>,
  connection: PeerLink,
): NamedSequence<PeerTestEvent, PeerActorState, ModelPeerState> => {
  // the deadlines follow the region, as every step re-arms them (gatherStallBy is armed only while connecting)
  const real = withTimes({ ...template.initial!.real, link: connection })
  return { name: `${connection}: ${template.name}`, events: template.events, initial: { real, model: modelFrom(real) } }
}
const inEveryRegion = (scenarios: readonly NamedSequence<PeerTestEvent, PeerActorState, ModelPeerState>[]) => [
  ...peerConnectionInitialStates.flatMap((connection) => scenarios.map((scenario) => witnessAt(scenario, connection))),
  ...scenarios.map((scenario) => witnessAt(scenario, "closed")),
]
/** Every named scenario. */
export const peerScenarios: readonly NamedSequence<PeerTestEvent, PeerActorState, ModelPeerState>[] = baseWitnesses

/** Each scenario in every region: the region keys no row, and these
 *  witnesses are the evidence that it decides nothing. */
export const peerWitnesses: readonly NamedSequence<PeerTestEvent, PeerActorState, ModelPeerState>[] = inEveryRegion(baseWitnesses)

const allRegressions = [
  // #245, decided on the sweep: a peer only timed out (not said away)
  // and still heard is healed
  sequence("#245 a timed-out peer still heard keeps healing", [tick("tick-away-already", { away: "timeout", downAt: 90_000, disconnectedAt: 90_000 })], { away: "timeout", link: "link-down", laneOpen: true }),
  // #1163, decided on the sweep: the yield is an attempt and waits out
  // the actor's backoff (it does not yield at once on the answer deadline); the
  // stranded re-initiation waits for its own 30 s, not the backoff
  sequence("#1163 an unanswered offer yields despite prior failures, once past the backoff", [tick("tick-yield", unanswered)], { link: "connecting", lastAttemptAt: 80_000, budgets: { failCount: 3 } as PeerActorState["budgets"] }),
  sequence("#1163 an unanswered offer waits out the backoff of prior failures", [tick("tick-backoff", unanswered)], { link: "connecting", lastAttemptAt: 80_001, budgets: { failCount: 3 } as PeerActorState["budgets"] }),
  sequence("#1163 a yielded connection re-initiates only on its separate wait", [tick("tick-stranded-early", { ...yielded, yieldedAt: 70_001 })], { link: "yielded", budgets: { failCount: 4 } as PeerActorState["budgets"] }),
  sequence("#1163 an unanswered offer is held while hidden", [tick("tick-hidden-held", unanswered)], { link: "connecting", hidden: true, budgets: { failCount: 3 } as PeerActorState["budgets"] }),
  sequence("#1163 an unanswered offer to a said-away peer is left", [tick("tick-said", { ...unanswered, away: "said" })], { link: "connecting", away: "said", budgets: { failCount: 3 } as PeerActorState["budgets"] }),
  sequence("#1163 a yielded connection is held while hidden", [tick("tick-hidden-held", yielded)], { link: "yielded", hidden: true, budgets: { failCount: 4 } as PeerActorState["budgets"] }),
  sequence("#1163 a yielded connection to a said-away peer is left", [tick("tick-said", { ...yielded, away: "said" })], { link: "yielded", away: "said", budgets: { failCount: 4 } as PeerActorState["budgets"] }),
  sequence("#1163 a yielded connection that took the peer's offer is not re-initiated", [tick("tick-stranded-described", { ...yielded, remoteDescription: true })], { link: "connecting", budgets: { failCount: 4 } as PeerActorState["budgets"] }),
  sequence("#1186 after-video glare rebuilds once", [current("glare-rebuild", { type: "glare-observed", remoteCarriesVideo: true, lane: true })], { link: "connecting" }),
  sequence("connected channel-never-opened rebuild precedes said-away skip", [tick("tick-cno-said", { ...stalledChannel, away: "said" })], { link: "connected", away: "said" }),
  sequence("connected channel-never-opened rebuild is once per round", [tick("tick-cno-spent", stalledChannel)], { link: "connected", budgets: { noVideoRebuilds: 1 } as PeerActorState["budgets"] }),
  sequence("bare one-way report cannot authorise hard SDP rebuild", [current("one-way-restart", { type: "stats-observed", readSequence: 2, framesDecoded: 3, browserConnectionState: "connected", peerCannotSeeUs: true })], { link: "connected", framesSeen: 2, framesReadSequence: 1 }),
  sequence("resume sweep preserves said-away", [current("resume-over-eight-said", { type: "visibility-changed", hidden: false, hiddenForMs: 8_001 })], { hidden: true, away: "said", budgets: { failCount: 2 } as PeerActorState["budgets"] }),
  sequence("said-away hello stays said inside 20 seconds", [current("heard", { type: "peer-heard", at: 20_000 })], { away: "said", lastSignalAt: 1 }),
  sequence("said-away hello clears strictly after 20 seconds", [current("heard", { type: "peer-heard", at: 20_002 })], { away: "said", lastSignalAt: 1 }),
  sequence("#1284 session change after timeout-away clears the failure budget", [current("peer-session-changed", { type: "peer-session-changed",  at: 10 })], { away: "timeout", laneOpen: true, link: "link-down", budgets: { failCount: 2 } as PeerActorState["budgets"] }),
  sequence("#1284 session change for a present peer keeps the failure budget", [current("peer-session-changed", { type: "peer-session-changed",  at: 10 })], { away: "here", laneOpen: true, link: "link-down", budgets: { failCount: 2 } as PeerActorState["budgets"] }),
  sequence("a supervisor ICE restart that throws rebuilds instead of failing the connection", [current("restart-rejected-rebuild", { type: "command-completed", commandEpoch: 1, commandKind: "restart-ice", outcome: "rejected", site: "supervisor-recovery" })], { commandEpoch: 1, openCommands: { "restart-ice": 1 }, link: "connecting", laneOpen: true, budgets: { failCount: 1 } as PeerActorState["budgets"] }),
  sequence("a hard lane SDP error rebuilds once, as laneNegotiationFailed does", [current("lane-srd-hard-rejected", { type: "command-completed", commandEpoch: 1, commandKind: "set-remote-description", outcome: "rejected", site: "lane", reason: "hard-sdp", roundGeneration: 0 })], { commandEpoch: 1, openCommands: { "set-remote-description": 1 }, link: "connecting", laneOpen: true }),
  sequence("a stale codec guard closes its offer", [current("codec-guard-stale", { type: "command-completed", commandEpoch: 2, commandKind: "send-offer", outcome: "stale", site: "lane" })], { commandEpoch: 2, openCommands: { "send-offer": 2 }, link: "connecting", laneOpen: true }),
  sequence("a hard SDP error setting the lane answer rebuilds, as laneNegotiationFailed does (#1367's open gap)", [current("lane-answer-hard-rejected", { type: "command-completed", commandEpoch: 2, commandKind: "send-answer", outcome: "rejected", site: "lane", reason: "hard-sdp", roundGeneration: 0 })], { commandEpoch: 2, openCommands: { "send-answer": 2 }, link: "connecting", laneOpen: true }),
  sequence("the answer on a connection rebuilt for a refused offer is followed by this side's channel", [current("rejoin-answer-sent", { type: "command-completed", commandEpoch: 3, commandKind: "send-answer", outcome: "resolved" }, 2)], { connectionEpoch: 2, commandEpoch: 3, openCommands: { "send-answer": 3 }, rejoinAnswer: true, link: "connecting", initiator: false }),
  sequence("a superseded lane offer is rolled back", [current("lane-offer-superseded", { type: "local-offer-superseded", haveLocalOffer: true })], { link: "connecting", laneOpen: true }),
  sequence("a yield unanswered re-initiates with a channel only, the offer being Mesh's own (the stranded-yield divergence)", [tick("tick-stranded", yielded)]),
  sequence("initiateStrandedPeer's early return: a yielded connection that has a channel is left", [tick("tick-stranded-channel", { ...yielded, hasChannel: true })]),
  sequence("a channel that never opened spends the round's no-video rebuild (it was reported as never-connected)", [tick("tick-cno", stalledChannel)]),
  sequence("#245 a timed-out peer still heard is marked away and healed in the same sweep", [tick("tick-away", { downAt: 91_999, disconnectedAt: 91_999 })]),
  sequence("a new signalling session grants no leave unless it was over our offer", [current("peer-session-changed", { type: "peer-session-changed", at: 10 })], { initiator: false, link: "connected", laneOpen: true }),
  sequence("a new signalling session rebuilds the answerer as an offerer, as onPeerSession does", [current("peer-session-changed", { type: "peer-session-changed", at: 10 })], { initiator: false, link: "connected", laneOpen: true }),
  // One failure on a disconnected link with its lane open: attempt 1's lane
  // offer is still pending, so a second ICE restart would send no offer (it
  // did not, in every observed case). Rebuild instead.
  // #1458: a completion carried no clock, so the replace it made stamped no
  // attempt while Mesh's rebuildPeer timed the fresh connection. The runner
  // stamps every completion: the next attempt waits out its backoff from
  // this replace.
  sequence("#1458 a refused stranded offer's re-initiation is an attempt at the completion's clock", [current("offer-refused-virgin", { type: "command-completed", commandEpoch: 1, commandKind: "set-remote-description", outcome: "rejected", site: "statement-offer-received", reason: "virgin-pc" })], { commandEpoch: 1, openCommands: { "set-remote-description": 1 }, link: "connecting", initiator: false, lastAttemptAt: 50_000, budgets: { failCount: 1 } as PeerActorState["budgets"] }),
  sequence("#1458 a hard lane error's immediate rebuild is an attempt at the completion's clock", [current("lane-srd-hard-rejected", { type: "command-completed", commandEpoch: 1, commandKind: "set-remote-description", outcome: "rejected", site: "lane", reason: "hard-sdp", roundGeneration: 0 })], { commandEpoch: 1, openCommands: { "set-remote-description": 1 }, link: "connecting", laneOpen: true }),
  sequence("#1458 a refused offer's rejoin is an attempt at the completion's clock", [current("offer-refused-invalid-access", { type: "command-completed", commandEpoch: 1, commandKind: "set-remote-description", outcome: "rejected", site: "statement-offer-received", reason: "invalid-access", at: 99_000 })], { commandEpoch: 1, openCommands: { "set-remote-description": 1 }, link: "connecting", lastSignalAt: 1 }),
  sequence("one failure on a disconnected link with its lane open rebuilds, not a second ICE restart", [tick("tick-backoff-over", { disconnectedAt: 90_000 })], { link: "connecting", laneOpen: true, lastAttemptAt: 94_000, budgets: { failCount: 1 } as PeerActorState["budgets"] }),
  // #1562: our rejoin offer refused by our own setLocalDescription after the
  // peer's reload left a fresh connection with no offer out and nothing of
  // theirs; everConnected kept the never-connected rule off and the pair
  // stayed dark until the browser's ICE gave up. connectBy judges every
  // connection, so it is rebuilt as an offerer 18 s in.
  sequence("#1562 a fresh connection of a peer connected before, with no offer out, is rebuilt as an offerer at connectBy", [tick("tick-connect-by-ever", freshEverUp(82_000))], { link: "connecting", initiator: false }),
  sequence("#1562 an ever-connected answerer on a fresh connection is not rebuilt before its connectBy", [tick("tick-connect-by-ever-early", freshEverUp(82_001))], { link: "connecting", initiator: false }),
  // #1605: the explorer's half-open leaf (a browser reports it as "Failed
  // to set SSL role"): b's answer is refused, our offer still holds a's
  // connection, and nothing answered it again until connect-by, 20 s later.
  sequence("#1605 a refused answer to our held offer rebuilds as offerer at once, not at connect-by", [current("answer-refused", { type: "command-completed", commandEpoch: 3, commandKind: "set-remote-description", outcome: "rejected", site: "statement-answer", reason: "hard-sdp", haveLocalOffer: true })], { commandEpoch: 3, openCommands: { "set-remote-description": 3 }, link: "connecting", everConnected: true, offerSentAt: 99_000, lastRecvDescAt: 100_000, firstHeardAt: 10_000 }),
  // #1606: the explorer's ice-failed leaf: b (polite) applied a's offer and
  // set its answer, then its own offer took the answer's place; a ignores
  // b's offer and waits for an answer, and the pair stayed dark ~30 s.
  sequence("#1606 the polite side's displaced answer is made again on a fresh responder, not left to the answer wait", [current("answer-displaced", { type: "command-completed", commandEpoch: 4, commandKind: "send-answer", outcome: "stale", site: "statement-answer", displaced: true })], { commandEpoch: 4, openCommands: { "send-answer": 4, "send-offer": 3 }, link: "connecting", initiator: false, everConnected: true, firstHeardAt: 10_000, lastRecvDescAt: 99_000 }),
  // #1607: a link rebuilt for no video connected and opened its lane,
  // our lane offer went unanswered, and with the round's no-video rebuild
  // spent nothing acted until ICE failed 47 s later.
  // #1917: RTP kept arriving with low loss while framesDecoded
  // stayed at 131; the media-stall ICE restart fired and the seat read Can't
  // connect. The frozen shape now asks for a keyframe, then rebuilds, and
  // never restarts ICE.
  sequence("#1917 packets rising and frames flat on a connected link never restart ICE", [
    current("frozen-ask", { type: "stats-observed", readSequence: 2, framesDecoded: 131, browserConnectionState: "connected", recoveryDue: true, healDue: true, stallAfter: 2, packetsMoving: true }),
    current("frozen-ask", { type: "stats-observed", readSequence: 3, framesDecoded: 131, browserConnectionState: "connected", recoveryDue: true, healDue: true, stallAfter: 2, packetsMoving: true }),
    current("frozen-rebuild", { type: "stats-observed", readSequence: 4, framesDecoded: 131, browserConnectionState: "connected", recoveryDue: true, healDue: true, stallAfter: 2, packetsMoving: true }),
  ], { link: "connected", laneOpen: true, everConnected: true, framesSeen: 131, framesReadSequence: 1 }),
  // #1917 code review: an asked episode survived a trip to the background, so
  // the first flat read after the return rebuilt without a fresh ask
  sequence("#1917 an asked frozen episode ends when the page hides: the return asks afresh", [
    current("frozen-ask", { type: "stats-observed", readSequence: 2, framesDecoded: 131, browserConnectionState: "connected", recoveryDue: true, healDue: true, stallAfter: 2, frozenAskAfter: 2, packetsMoving: true }),
    current("frozen-hide-ends-episode", { type: "visibility-changed", hidden: true }),
    current("frozen-hide-ends-episode", { type: "visibility-changed", hidden: false, hiddenForMs: 1000 }),
    current("frozen-held", { type: "stats-observed", readSequence: 3, framesDecoded: 131, browserConnectionState: "connected", recoveryDue: true, healDue: true, stallAfter: 2, frozenAskAfter: 2, packetsMoving: true }),
    current("frozen-ask", { type: "stats-observed", readSequence: 4, framesDecoded: 131, browserConnectionState: "connected", recoveryDue: true, healDue: true, stallAfter: 2, frozenAskAfter: 2, packetsMoving: true }),
  ], { link: "connected", laneOpen: true, everConnected: true, framesSeen: 131, framesReadSequence: 1, stallSamples: 1, frozenSamples: 1 }),
  sequence("#1607 a connected link our unanswered offer holds is rebuilt again for no video in the same round", [current("no-video-offer-pending", { type: "stats-observed", readSequence: 4, framesDecoded: -1, browserConnectionState: "connected", noVideoDeadline: true, haveLocalOffer: true })], { link: "connected", laneOpen: true, everConnected: true, framesReadSequence: 3, budgets: { noVideoRebuilds: 1 } as PeerActorState["budgets"] }),
  // #1951: one phone's gathering towards one peer stopped after a single
  // host candidate on five rebuilds in a row, each found only when ICE failed
  // about 15 s later (89 s in all). With TURN configured, the connection is
  // rebuilt 5 s after both descriptions are in, and only once a round.
  sequence("#1951 a never-connected link holding one host candidate is rebuilt 5 s after its descriptions, not at the ICE timeout", [tick("tick-gather-stalled", gatherStalled)], { ...describedAt(95_000), link: "connecting" }),
  sequence("#1951 the early rebuild spent, the next stall in the round waits for ICE", [tick("tick-gather-spent", gatherStalled)], { ...describedAt(95_000), link: "connecting", budgets: { failCount: 1, gatherStallRebuilds: 1 } as PeerActorState["budgets"], lastAttemptAt: 80_000 }),
  // #1523 F5: one ICE restart per stall and per unseen episode, then the next
  // rung (or nothing) — a second restart sends no offer while the first's
  // lane offer is unanswered
  sequence("#1523 a second stall arriving while our offer is still unanswered rebuilds, not a second ICE restart", [current("stall-rebuild-offer-pending", { type: "stats-observed", readSequence: 3, framesDecoded: 4, browserConnectionState: "connected", recoveryDue: true, stallAfter: 1, haveLocalOffer: true })], { link: "connected", framesSeen: 4, framesReadSequence: 2, budgets: { stallHeals: 1 } as PeerActorState["budgets"] }),
  sequence("#1523 an unseen report with the one unseen heal of the episode spent issues nothing", [current("unseen-spent", { type: "stats-observed", readSequence: 2, framesDecoded: 3, browserConnectionState: "connected", peerCannotSeeUs: true })], { link: "connected", laneOpen: true, framesSeen: 2, framesReadSequence: 1, budgets: { unseenHeals: 1 } as PeerActorState["budgets"] }),
  sequence("#1523 the unseen budget refills once the peer sees our video again, so a later episode gets its one restart", [
    current("unseen-sees-us", { type: "stats-observed", readSequence: 2, framesDecoded: 3, browserConnectionState: "connected", peerSeesUs: true }),
    current("unseen-later", { type: "stats-observed", readSequence: 3, framesDecoded: 4, browserConnectionState: "connected", peerCannotSeeUs: true }),
  ], { link: "connected", laneOpen: true, framesSeen: 2, framesReadSequence: 1, budgets: { unseenHeals: 1 } as PeerActorState["budgets"] }),
  sequence("#1523 an unseen report while our lane offer is unanswered issues nothing and keeps the budget", [current("unseen-offer-pending", { type: "stats-observed", readSequence: 2, framesDecoded: 3, browserConnectionState: "connected", peerCannotSeeUs: true, haveLocalOffer: true })], { link: "connected", laneOpen: true, framesSeen: 2, framesReadSequence: 1 }),
]
export const peerRegressionCorpus = allRegressions

type ClockEvent = Extract<PeerActorEvent, { type: "clock" }>
/** A sweep as the old tick read it: its snapshot, and the actor's own times. */
const tickOf = (state: PeerActorState, event: PeerActorEvent) => tickFrom(state, (event as ClockEvent).now, (event as ClockEvent).snapshot)
/** A sweep with some of its tick's facts changed: the browser's reads on the
 *  clock fact, the times on the actor, which decides from its own. */
const stepWithTick = (state: PeerActorState, event: PeerActorEvent, facts: Partial<SupervisorTickFacts>) => {
  const clock = event as ClockEvent
  const changed = { ...tickOf(state, event), ...facts }
  const snapshot = snapshotOf(changed)
  const times = Object.fromEntries(Object.entries(timesOf(clockOf(changed))).filter(([key]) => key in facts))
  return stepPeerActor(withTimes(state, times), { ...clock, snapshot })
}

type ActorMutation = (state: PeerActorState, event: PeerActorEvent) => ReturnType<typeof stepPeerActor>

const executableMutation = (mutation: string, witness: PeerEventKey, mutate: ActorMutation) => ({
  mutation,
  witness,
  detected(): boolean {
    const scenario = baseWitnesses.find((entry) => entry.events[0]!.key === witness)!
    const testEvent = scenario.events[0]!
    const real = scenario.initial!.real
    const model = scenario.initial!.model
    const actorEvent = testEvent.relative
      ? { ...testEvent.event, roomEpoch: real.scope.roomEpoch, connectionEpoch: real.connectionEpoch }
      : testEvent.event
    const modelEvent = testEvent.relative
      ? { ...testEvent.event, roomEpoch: model.roomEpoch, connectionEpoch: model.connectionEpoch }
      : testEvent.event
    return JSON.stringify(observeActor(mutate(real, actorEvent))) !== JSON.stringify(observeModel(stepModelPeer(model, modelEvent as ModelPeerEvent)))
  },
})

/** Executable source-level fault simulations: each probe plants one named
 * fault and must be told apart from the model. (A source-mutation runner is
 * not part of this repository; these probes stand on their own.) */
export const peerMutationProbes = [
  executableMutation("remove stale connection epoch check", "stale-connection", (state, event) =>
    stepPeerActor(state, { ...event, connectionEpoch: state.connectionEpoch })),
  executableMutation("flatten away on a short signal gap", "heard-said-short", (state, event) => {
    const result = stepPeerActor(state, event)
    return { ...result, state: { ...result.state, away: "here" } }
  }),
  executableMutation("spend watchdog budget while hidden", "hidden-stats-held", (state, event) =>
    stepPeerActor(withTimes({ ...state, hidden: false }), event)),
  executableMutation("remove hard-SDP authorisation for one-way rebuild", "one-way-restart", (state, event) =>
    stepPeerActor(withTimes({ ...state, budgets: { ...state.budgets, negotiationImmediate: 1 } }), event)),
  executableMutation("change strict eight-second resume boundary", "resume-eight", (state, event) =>
    stepPeerActor(state, { ...event, hiddenForMs: 8_001 } as PeerActorEvent)),
  executableMutation("reject lower positive replacement counter", "frame-reset", (state, event) =>
    stepPeerActor(state, { ...event, framesDecoded: state.framesSeen } as PeerActorEvent)),
  executableMutation("exclude timeout-away from supervision", "tick-away-already", (state, event) =>
    stepWithTick(state, event, { away: "said" })),
  executableMutation("reset peer unseen budget at round change", "round-change", (state, event) => {
    const result = stepPeerActor(state, event)
    return { ...result, state: { ...result.state, budgets: { ...result.state.budgets, unseenHeals: 0 } } }
  }),
  // #1523: the unseen budget is per episode — it refills when the peer sees us
  executableMutation("never refill the unseen budget when the peer sees us again", "unseen-refill", (state, event) => {
    const result = stepPeerActor(state, { ...event, peerSeesUs: undefined } as PeerActorEvent)
    return result
  }),
  executableMutation("restart ICE for an unseen peer while our offer is unanswered", "unseen-offer-pending", (state, event) =>
    stepPeerActor(state, { ...event, haveLocalOffer: undefined } as PeerActorEvent)),
  executableMutation("keep away failure budget across session change", "peer-session-changed", (state, event) => {
    const result = stepPeerActor(state, event)
    return { ...result, state: { ...result.state, budgets: { ...result.state.budgets, failCount: state.budgets.failCount } } }
  }),
  executableMutation("rebuild for a new signalling session in the side's own role", "session-over-our-offer", (state, event) => {
    const result = stepPeerActor(state, event)
    if (event.type !== "peer-session-changed") return result
    return { ...result, commands: result.commands.map((command) => command.kind === "replace-connection" ? { ...command, initiate: state.initiator } : command) }
  }),
  executableMutation("drop the leave a new signalling session over our offer grants", "session-over-our-offer", (state, event) => {
    const result = stepPeerActor(state, event)
    if (event.type !== "peer-session-changed") return result
    return { ...result, commands: result.commands.map((command) => command.kind === "replace-connection" ? { ...command, answererMayOffer: undefined } : command) }
  }),
  executableMutation("ignore a new remote session on a description", "new-session-offer", (state, event) =>
    stepPeerActor(state, { ...event, newRemoteSession: undefined } as PeerActorEvent)),
  executableMutation("apply a new-session answer to the fresh connection", "new-session-answer", (state, event) => {
    const result = stepPeerActor(state, event)
    return { ...result, commands: [...result.commands, { kind: "set-remote-description", lane: false, commandEpoch: result.state.commandEpoch + 1, connectionEpoch: result.state.connectionEpoch }] }
  }),
  executableMutation("drop the remote lane offer stall reset", "lane-offer-received", (state, event) => {
    const result = stepPeerActor(state, event)
    return { ...result, state: { ...result.state, stallSamples: state.stallSamples } }
  }),
  executableMutation("drop the inbound-stat gate on the unseen heal", "unseen-no-stat", (state, event) =>
    stepPeerActor(state, { ...event, framesDecoded: 0 } as PeerActorEvent)),
  executableMutation("drop the inbound-stat gate on the unseen hard-SDP rebuild", "unseen-no-stat-hard", (state, event) =>
    stepPeerActor(state, { ...event, framesDecoded: 0 } as PeerActorEvent)),
  executableMutation("require positive frames for the unseen heal", "unseen-zero-stat", (state, event) =>
    stepPeerActor(state, { ...event, framesDecoded: -1 } as PeerActorEvent)),
  // #1917: the frozen path
  executableMutation("restart ICE on a frozen link", "frozen-ask", (state, event) =>
    stepPeerActor(state, { ...event, packetsMoving: false } as PeerActorEvent)),
  executableMutation("gate the keyframe ask on our camera", "frozen-ask-camera-off", (state, event) =>
    stepPeerActor(state, { ...event, healDue: (event as { recoveryDue?: boolean }).recoveryDue } as PeerActorEvent)),
  executableMutation("ask for a keyframe again instead of rebuilding", "frozen-rebuild", (state, event) =>
    stepPeerActor({ ...state, frozenAsked: false, stallSamples: 1, frozenSamples: 1 }, event)),
  executableMutation("keep the frozen episode when frames rise", "frozen-healed", (state, event) => {
    const result = stepPeerActor(state, event)
    return { ...result, state: { ...result.state, frozenAsked: true } }
  }),
  executableMutation("ask for a keyframe inside the heal hold", "frozen-held", (state, event) =>
    stepPeerActor(state, { ...event, healDue: true } as PeerActorEvent)),
  executableMutation("let an asked episode restart ICE", "frozen-asked-held", (state, event) =>
    stepPeerActor({ ...state, frozenAsked: false, stallSamples: 1, frozenSamples: 0 }, event)),
  executableMutation("read a flat-packet sweep as frozen", "frozen-packets-flat", (state, event) =>
    stepPeerActor(state, { ...event, packetsMoving: true } as PeerActorEvent)),
  executableMutation("rebuild the answerer's asked episode on the next flat sweep", "frozen-rebuild-answerer-early", (state, event) =>
    stepPeerActor(state, { ...event, stallAfter: 2 } as PeerActorEvent)),
  executableMutation("keep the frozen episode across a held sweep", "frozen-asked-hidden-held", (state, event) => {
    const result = stepPeerActor(state, event)
    return { ...result, state: { ...result.state, frozenAsked: state.frozenAsked } }
  }),
  executableMutation("keep the frozen episode when the page hides", "frozen-hide-ends-episode", (state, event) => {
    const result = stepPeerActor(state, event)
    return { ...result, state: { ...result.state, frozenAsked: state.frozenAsked } }
  }),
  executableMutation("ask on a frozen link past the round's rebuild budget", "frozen-budget-spent", (state, event) =>
    stepPeerActor({ ...state, budgets: { ...state.budgets, frozenRebuilds: 0 } }, event)),
  executableMutation("reset the stall count on any lane description", "lane-answer-received", (state, event) => {
    const result = stepPeerActor(state, event)
    return { ...result, state: { ...result.state, stallSamples: 0 } }
  }),
  executableMutation("fail the connection on any rejected command", "rejected-media-completion", (state, event) => {
    const result = stepPeerActor(state, event)
    return event.type === "command-completed" && event.outcome === "rejected" ? { ...result, state: { ...result.state, link: "link-down" } } : result
  }),
  executableMutation("fail the connection on an unstamped negotiation rejection", "unstamped-rejection", (state, event) => {
    const result = stepPeerActor(state, event)
    return { ...result, state: { ...result.state, link: "link-down" } }
  }),
  executableMutation("log a supervisor ICE restart that throws", "restart-rejected-rebuild", (state, event) =>
    stepPeerActor(state, { ...event, site: "media-stall" } as PeerActorEvent)),
  executableMutation("rebuild on a media-stall ICE restart that throws", "restart-rejected-logged", (state, event) =>
    stepPeerActor(state, { ...event, site: "supervisor-recovery" } as PeerActorEvent)),
  executableMutation("rebuild on a lane error that is not a hard SDP one", "lane-soft-rejected", (state, event) =>
    stepPeerActor(state, { ...event, reason: "hard-sdp" } as PeerActorEvent)),
  executableMutation("rebuild again with the immediate budget spent", "lane-hard-spent", (state, event) =>
    stepPeerActor(withTimes({ ...state, budgets: { ...state.budgets, negotiationImmediate: 0 } }), event)),
  executableMutation("ignore the round a hard lane error began in", "lane-hard-old-round", (state, event) =>
    stepPeerActor(state, { ...event, roundGeneration: state.roundGeneration } as PeerActorEvent)),
  executableMutation("treat our statement offer's hard error as a lane one", "statement-offer-sent-rejected", (state, event) =>
    stepPeerActor(state, { ...event, site: "lane", roundGeneration: state.roundGeneration } as PeerActorEvent)),
  executableMutation("rebuild a virgin connection as a rejoin", "offer-refused-virgin", (state, event) =>
    stepPeerActor(state, { ...event, reason: "invalid-access" } as PeerActorEvent)),
  executableMutation("drop the offer re-applied after a rejoin rebuild", "offer-refused-invalid-access", (state, event) => {
    const result = stepPeerActor(state, event)
    return { ...result, commands: result.commands.filter((command) => command.kind !== "set-remote-description") }
  }),
  executableMutation("keep the away state on a refused offer's rejoin", "offer-refused-invalid-access", (state, event) => {
    const result = stepPeerActor(state, event)
    return { ...result, state: { ...result.state, away: state.away, lastSignalAt: state.lastSignalAt, budgets: { ...result.state.budgets, failCount: state.budgets.failCount } } }
  }),
  executableMutation("fail the connection on a stale codec guard", "codec-guard-stale", (state, event) => {
    const result = stepPeerActor(state, event)
    return { ...result, state: { ...result.state, link: "link-down" } }
  }),
  executableMutation("keep the away state on a statement glare", "statement-glare-away", (state, event) => {
    const result = stepPeerActor(state, event)
    return { ...result, state: { ...result.state, away: state.away, budgets: { ...result.state.budgets, failCount: state.budgets.failCount } } }
  }),
  executableMutation("drop the lane glare stall reset", "lane-glare-stall", (state, event) => {
    const result = stepPeerActor(state, event)
    return { ...result, state: { ...result.state, stallSamples: state.stallSamples } }
  }),
  executableMutation("send no answer for an applied remote offer", "statement-offer-applied", (state, event) => {
    const result = stepPeerActor(state, event)
    return { ...result, commands: result.commands.filter((command) => command.kind !== "send-answer") }
  }),
  executableMutation("answer a remote answer", "remote-answer-applied", (state, event) =>
    stepPeerActor(withTimes({ ...state, remoteOffer: "statement" }), event)),
  executableMutation("answer a lane offer on the statement wire", "lane-offer-applied", (state, event) =>
    stepPeerActor(withTimes({ ...state, remoteOffer: "statement" }), event)),
  executableMutation("forget the rejoin when its offer is applied", "rejoin-offer-applied", (state, event) => {
    const result = stepPeerActor(state, event)
    return { ...result, state: { ...result.state, rejoinAnswer: false } }
  }),
  executableMutation("log the lane answer's hard SDP error", "lane-answer-hard-rejected", (state, event) =>
    stepPeerActor(state, { ...event, site: "statement-answer" } as PeerActorEvent)),
  executableMutation("drop the rejoin's channel after its answer", "rejoin-answer-sent", (state, event) => {
    const result = stepPeerActor(state, event)
    return { ...result, commands: result.commands.filter((command) => command.kind !== "create-channel") }
  }),
  executableMutation("make the rejoin's channel after a stale answer", "rejoin-answer-stale", (state, event) =>
    stepPeerActor(state, { ...event, outcome: "resolved" } as PeerActorEvent)),
  executableMutation("keep a superseded lane offer", "lane-offer-superseded", (state) =>
    ({ state, commands: [] })),
  executableMutation("roll back a superseded offer the connection already left", "lane-offer-superseded-left", (state, event) =>
    stepPeerActor(state, { ...event, haveLocalOffer: true } as PeerActorEvent)),
  // the supervisor's rules, one probe per boundary and branch
  executableMutation("recover while the page is hidden", "tick-hidden-held", (state, event) =>
    stepPeerActor(withTimes({ ...state, hidden: false }), event)),
  executableMutation("restart inside the disconnect grace", "tick-grace", (state, event) =>
    stepWithTick(state, event, { disconnectedAt: tickOf(state, event).disconnectedAt - 1 })),
  executableMutation("restart with the restarts spent", "tick-restarts-spent", (state, event) =>
    stepPeerActor(withTimes({ ...state, budgets: { ...state.budgets, failCount: 0 } }), event)),
  executableMutation("restart ICE over a closed lane", "tick-closed-lane", (state, event) =>
    stepWithTick(state, event, { laneOpen: true })),
  executableMutation("restart ICE without restartIce", "tick-no-restart-api", (state, event) =>
    stepWithTick(state, event, { canRestartIce: true })),
  executableMutation("ignore the backoff", "tick-backoff", (state, event) =>
    stepPeerActor(withTimes({ ...state, lastAttemptAt: null }), event)),
  executableMutation("wait one more millisecond of backoff", "tick-backoff-over", (state, event) =>
    stepPeerActor(withTimes({ ...state, lastAttemptAt: (state.lastAttemptAt ?? 0) + 1 }), event)),
  executableMutation("double the backoff past twenty seconds", "tick-backoff-cap", (state, event) =>
    stepPeerActor(withTimes({ ...state, lastAttemptAt: (state.lastAttemptAt ?? 0) + 1 }), event)),
  executableMutation("heal a peer who said it left", "tick-said", (state, event) =>
    stepWithTick(state, event, { away: null })),
  executableMutation("never mark a peer away", "tick-away", (state, event) =>
    stepWithTick(state, event, { away: "timeout" })),
  executableMutation("mark away at exactly AWAY_AFTER", "tick-away-boundary", (state, event) =>
    stepWithTick(state, event, { downAt: tickOf(state, event).downAt - 1 })),
  executableMutation("mark a timed-out peer away again", "tick-away-already", (state, event) =>
    stepWithTick(state, event, { away: null })),
  executableMutation("mark away a link that was never up", "tick-away-never-up", (state, event) =>
    stepWithTick(state, event, { everConnected: true })),
  executableMutation("chase a peer gone 45 s", "tick-gone", (state, event) =>
    stepWithTick(state, event, { lastSignalAt: (tickOf(state, event).lastSignalAt ?? 0) + 1 })),
  executableMutation("stop chasing at under 45 s", "tick-fresh-boundary", (state, event) =>
    stepWithTick(state, event, { lastSignalAt: (tickOf(state, event).lastSignalAt ?? 0) - 1 })),
  executableMutation("drop the just-dropped chase", "tick-just-dropped", (state, event) =>
    stepWithTick(state, event, { downAt: tickOf(state, event).downAt - 1 })),
  executableMutation("offer again after the yield as well", "tick-stranded", (state, event) => {
    const result = stepPeerActor(state, event)
    return { ...result, commands: [...result.commands, { kind: "send-offer", lane: false, commandEpoch: result.state.commandEpoch + 1, connectionEpoch: result.state.connectionEpoch }] }
  }),
  executableMutation("gate the stranded re-initiation on the backoff", "tick-stranded-backoff", (state) =>
    ({ state, commands: [] })),
  executableMutation("re-initiate a yield under 30 s", "tick-stranded-early", (state, event) =>
    stepWithTick(state, event, { yieldedAt: (tickOf(state, event).yieldedAt ?? 0) - 1 })),
  executableMutation("re-initiate a yielded connection that has a channel", "tick-stranded-channel", (state, event) =>
    stepWithTick(state, event, { hasChannel: false })),
  executableMutation("re-initiate a yielded connection that took an offer", "tick-stranded-described", (state, event) =>
    stepWithTick(state, event, { remoteDescription: false })),
  executableMutation("wait one more millisecond at connectBy", "tick-never-initial-boundary", (state, event) =>
    stepPeerActor(withTimes(state, { connectingSince: Math.max(state.connectingSince ?? 0, state.firstHeardAt ?? 0) + 1 }), event)),
  executableMutation("keep the everConnected gate on connectBy (#1562)", "tick-connect-by-ever", (state, event) =>
    stepPeerActor(state.everConnected ? { ...state, deadlines: { ...state.deadlines, connectBy: null } } : state, event)),
  executableMutation("anchor connectBy on the first hello alone", "tick-connect-by-ever-early", (state, event) =>
    stepPeerActor(withTimes(state, { connectingSince: 0 }), event)),
  executableMutation("ignore the negotiation quiet", "tick-never-quiet", (state, event) =>
    stepWithTick(state, event, { lastRecvDescAt: (tickOf(state, event).lastRecvDescAt ?? 0) - 1 })),
  executableMutation("rebuild before the initiator's answer wait", "tick-never-offer-waiting", (state, event) =>
    stepWithTick(state, event, { offerSentAt: (tickOf(state, event).offerSentAt ?? 0) - 1 })),
  executableMutation("read the never-sent offer as just sent", "tick-never-due", (state, event) =>
    stepWithTick(state, event, { offerSentAt: tickOf(state, event).now })),
  executableMutation("rebuild an answerer that heard the initiator", "tick-never-answerer-heard", (state, event) =>
    stepWithTick(state, event, { lastRecvDescAt: null })),
  executableMutation("yield under 30 s", "tick-yield-early", (state, event) =>
    stepWithTick(state, event, { offerSentAt: (tickOf(state, event).offerSentAt ?? 0) - 1 })),
  executableMutation("yield over an open lane", "tick-yield-lane-open", (state, event) =>
    stepWithTick(state, event, { laneOpen: false })),
  executableMutation("rebuild instead of yielding", "tick-yield", (state, event) =>
    stepWithTick(state, event, { browserConnectionState: "failed" })),
  executableMutation("rebuild a channel stall under 23 s", "tick-cno-early", (state, event) =>
    stepWithTick(state, event, { upAt: tickOf(state, event).upAt - 1 })),
  executableMutation("rebuild a channel stall twice a round", "tick-cno-spent", (state, event) =>
    stepPeerActor(withTimes({ ...state, budgets: { ...state.budgets, noVideoRebuilds: 0 } }), event)),
  executableMutation("take a link that showed video for a channel stall", "tick-cno-video", (state, event) =>
    stepWithTick(state, event, { sawVideoThisRound: false })),
  executableMutation("spare a said-away channel stall", "tick-cno-said", (state) =>
    ({ state, commands: [] })),
  executableMutation("rebuild a channel stall inside its backoff", "tick-cno-backoff", (state, event) =>
    stepPeerActor(withTimes({ ...state, lastAttemptAt: null }), event)),
  executableMutation("leave the round's no-video rebuild unspent on a channel stall", "tick-cno", (state, event) => {
    const result = stepPeerActor(state, event)
    return { ...result, state: { ...result.state, budgets: { ...result.state.budgets, noVideoRebuilds: 0 } } }
  }),
  executableMutation("count no failure on a supervisor recovery", "tick-restart", (state, event) => {
    const result = stepPeerActor(state, event)
    return { ...result, state: { ...result.state, budgets: { ...result.state.budgets, failCount: state.budgets.failCount } } }
  }),
  // the budgets the sweep reads are the actor's own
  executableMutation("decide the sweep's backoff from Mesh's copies", "tick-mesh-backoff-copy", (state, event) =>
    stepPeerActor(withTimes({ ...state, lastAttemptAt: null, budgets: { ...state.budgets, failCount: 0 } }), event)),
  // the backoff clock, lastAttemptAt
  executableMutation("leave the backoff clock on a supervisor restart", "tick-restart", (state, event) => {
    const result = stepPeerActor(state, event)
    return { ...result, state: { ...result.state, lastAttemptAt: state.lastAttemptAt } }
  }),
  executableMutation("stamp no attempt on a network restart", "network-restart", (state, event) => {
    const result = stepPeerActor(state, event)
    return { ...result, state: { ...result.state, lastAttemptAt: state.lastAttemptAt } }
  }),
  executableMutation("keep the backoff clock when the peer is back", "away-back", (state, event) => {
    const result = stepPeerActor(state, event)
    return { ...result, state: { ...result.state, lastAttemptAt: state.lastAttemptAt } }
  }),
  executableMutation("ask for a keyframe on a kick the page was never away for", "resume-never-away", (state, event) =>
    stepPeerActor(state, { ...event, keyframe: undefined } as PeerActorEvent)),
  executableMutation("keep the failures on a kick the page was never away for", "resume-never-away", (state, event) => {
    const result = stepPeerActor(state, event)
    return { ...result, state: { ...result.state, lastAttemptAt: state.lastAttemptAt, budgets: { ...result.state.budgets, failCount: state.budgets.failCount } } }
  }),
  executableMutation("keep the backoff clock on a kick", "resume-over-eight", (state, event) => {
    const result = stepPeerActor(state, event)
    return { ...result, state: { ...result.state, lastAttemptAt: state.lastAttemptAt } }
  }),
  executableMutation("forgive a said-away peer on its lane answer", "lane-answer-said", (state, event) => {
    const result = stepPeerActor(state, event)
    return { ...result, state: { ...result.state, away: "here", lastAttemptAt: null, budgets: { ...result.state.budgets, failCount: 0 } } }
  }),
  executableMutation("forgive a said-away peer on its lane offer", "lane-offer-said", (state, event) => {
    const result = stepPeerActor(state, event)
    return { ...result, state: { ...result.state, away: "here", lastAttemptAt: null, budgets: { ...result.state.budgets, failCount: 0 } } }
  }),
  executableMutation("clear the backoff clock on a present peer's connected", "connected-present", (state, event) => {
    const result = stepPeerActor(state, event)
    return { ...result, state: { ...result.state, lastAttemptAt: null } }
  }),
  // stallHeals, the removal, and the stall count
  executableMutation("reset the stall heals on promotion", "promote-keeps-heals", (state, event) => {
    const result = stepPeerActor(state, event)
    return { ...result, state: { ...result.state, budgets: { ...result.state.budgets, stallHeals: 0 } } }
  }),
  executableMutation("keep the failures after a removal", "remove-budgets", (state, event) => {
    const result = stepPeerActor(state, event)
    return { ...result, state: { ...result.state, lastAttemptAt: state.lastAttemptAt, budgets: { ...result.state.budgets, failCount: state.budgets.failCount } } }
  }),
  executableMutation("keep the unseen heals after a removal", "remove-budgets", (state, event) => {
    const result = stepPeerActor(state, event)
    return { ...result, state: { ...result.state, budgets: { ...result.state.budgets, unseenHeals: state.budgets.unseenHeals } } }
  }),
  executableMutation("keep the peer's presence after a removal", "remove-budgets", (state, event) => {
    const result = stepPeerActor(state, event)
    return { ...result, state: { ...result.state, away: state.away, lastSignalAt: state.lastSignalAt } }
  }),
  executableMutation("drop the round's budgets on a removal", "remove-budgets", (state, event) => {
    const result = stepPeerActor(state, event)
    return { ...result, state: { ...result.state, budgets: { ...result.state.budgets, noVideoRebuilds: 0, glareRebuilds: 0, negotiationImmediate: 0 } } }
  }),
  executableMutation("keep the stall count on an unseen restart", "unseen-stall-reset", (state, event) => {
    const result = stepPeerActor(state, event)
    return { ...result, state: { ...result.state, stallSamples: state.stallSamples + 1 } }
  }),
  executableMutation("reset the stall count on our own lane offer", "lane-offer-requested", (state, event) => {
    const result = stepPeerActor(state, event)
    return { ...result, state: { ...result.state, stallSamples: 0 } }
  }),
  executableMutation("decide the channel stall from Mesh's no-video copy", "tick-cno-mesh-copy", (state, event) =>
    stepPeerActor(withTimes({ ...state, budgets: { ...state.budgets, noVideoRebuilds: 0 } }), event)),
  executableMutation("ignore our camera's stamp on a sweep", "camera-came-up", (state, event) =>
    stepPeerActor(state, event.type === "stats-observed" ? { ...event, cameraLive: undefined } : event)),
  executableMutation("ignore a connection Mesh replaced itself", "replaced-externally", (state) =>
    ({ state, commands: [], ignored: "stale-connection" })),
  executableMutation("keep the stall heals across Mesh's own replace", "replaced-externally", (state, event) => {
    const result = stepPeerActor(state, event)
    return { ...result, state: { ...result.state, budgets: { ...result.state.budgets, stallHeals: state.budgets.stallHeals } } }
  }),
  executableMutation("drop the peer's failures on Mesh's own replace", "replaced-externally", (state, event) => {
    const result = stepPeerActor(state, event)
    return { ...result, state: { ...result.state, budgets: { ...result.state.budgets, failCount: 0 } } }
  }),
  executableMutation("leave the backoff clock on Mesh's own replace", "replaced-externally", (state, event) => {
    const result = stepPeerActor(state, event)
    return { ...result, state: { ...result.state, lastAttemptAt: state.lastAttemptAt } }
  }),
  executableMutation("adopt a connection the actor already holds", "replaced-externally-known", (state, event) =>
    stepPeerActor(state, { ...event, connectionEpoch: state.connectionEpoch + 1 })),
  executableMutation("stay ahead of the connection Mesh holds", "replaced-externally-older", (state) =>
    ({ state, commands: [], ignored: "stale-connection" })),
  // a new signalling session, and a peer back
  executableMutation("replace a connection that negotiated nothing", "session-nothing-negotiated", (state, event) =>
    stepPeerActor(state, { ...event, negotiated: undefined } as PeerActorEvent)),
  executableMutation("leave Mesh's away mark on a peer back", "away-back", (state, event) => {
    const result = stepPeerActor(state, event)
    return { ...result, commands: [] }
  }),
  executableMutation("leave a timed-out peer away after a long absence", "resume-timeout-back", (state, event) => {
    const result = stepPeerActor(state, event)
    return { ...result, state: { ...result.state, away: state.away } }
  }),
  // #1951
  executableMutation("rebuild a stalled gathering twice a round", "tick-gather-spent", (state, event) =>
    stepPeerActor(withTimes({ ...state, budgets: { ...state.budgets, gatherStallRebuilds: 0 } }), event)),
  executableMutation("count the page-hidden time towards the gathering stall", "resume-gather-shift", (state, event) => {
    const result = stepPeerActor(state, event)
    return { ...result, state: { ...result.state, gatherHiddenMs: state.gatherHiddenMs } }
  }),
  executableMutation("keep a later local description of the connection", "local-description-set-again", (state, event) =>
    stepPeerActor({ ...state, localDescribedAt: null }, event)),
] as const

/** Contract outcomes transcribed from the approved recovery table, not
 * inferred from actor results or witness execution. */
const NO_OP_EVENT_KEYS = new Set<PeerEventKey>([
  "stale-room",
  "session-nothing-negotiated",
  "stale-connection",
  "departed-description",
  "old-stats",
  "no-video-standby",
  "hidden-stats-held",
  "old-completion",
  "lane-offer-superseded-left",
  "tick-connected-idle",
  "link-new-idle",
  "tick-hidden-held",
  "tick-grace",
  "tick-backoff",
  "tick-gather-stall-early",
  "tick-gather-srflx",
  "tick-gather-no-turn",
  "tick-gather-relay-only",
  "tick-gather-complete",
  "tick-gather-no-facts",
  "tick-gather-spent",
  "tick-gather-backoff",
  "tick-gather-hidden",
  "local-description-set-again",
  "tick-said",
  "tick-away-never-up",
  "tick-gone",
  "tick-stranded-early",
  "tick-stranded-channel",
  "tick-stranded-described",
  "tick-never-quiet",
  "tick-never-offer-waiting",
  "tick-never-answerer-heard",
  "tick-connect-by-ever-early",
  "tick-yield-early",
  "tick-yield-lane-open",
  "tick-cno-early",
  "tick-cno-spent",
  "tick-cno-video",
  "tick-cno-backoff",
  "tick-mesh-backoff-copy",
  "tick-cno-mesh-copy",
  "replaced-externally-known",
  "network-inferred-on-new",
  "network-inferred-connected",
])
/** The scenario's cell: its fact's type and its declared outcome, from the
 *  recovery table transcribed above. */
const CONNECT_BY_EVENT_KEYS: ReadonlySet<PeerEventKey> = new Set([
  "tick-never-due",
  "tick-never-initial-boundary",
  "tick-never-offer-overdue",
  "tick-never-answerer-unheard",
  "tick-connect-by-ever",
])
/** #1951: the gathering-stall rebuild acts only on a connection that has not
 *  connected (link connecting), as connect-by does */
const GATHER_STALL_EVENT_KEYS: ReadonlySet<PeerEventKey> = new Set([
  "tick-gather-stalled",
  "tick-gather-stalled-answerer",
])
const peerCellKey = (testEvent: PeerTestEvent): PeerCellKey => CONNECT_BY_EVENT_KEYS.has(testEvent.key)
  ? "clock:connect-by"
  : GATHER_STALL_EVENT_KEYS.has(testEvent.key)
  ? "clock:gather-stall"
  : `${factKey(testEvent.event)}:${NO_OP_EVENT_KEYS.has(testEvent.key) ? "no-op" : "transition"}`

/** What an open actor does with each fact Mesh sends with the runner, by
 *  type and outcome. A closed one ignores every fact. */
const OPEN_ROW = {
  "peer-heard:transition": "transition",
  "peer-heard:no-op": "no-op",
  "peer-away:transition": "transition",
  "description-observed:transition": "transition",
  "description-observed:no-op": "no-op",
  "peer-session-changed:transition": "transition",
  "peer-session-changed:no-op": "no-op",
  "connection-observed:transition": "transition",
  "connection-observed:no-op": "no-op",
  "channel-observed:transition": "transition",
  "local-offer-requested:transition": "transition",
  "clock:transition": "transition",
  "clock:no-op": "no-op",
  "clock:connect-by": "transition",
  "clock:gather-stall": "transition",
  "local-description-set:transition": "transition",
  "local-description-set:no-op": "no-op",
  "glare-observed:transition": "transition",
  "codec-guard-rtx:transition": "transition",
  "local-offer-superseded:transition": "transition",
  "local-offer-superseded:no-op": "no-op",
  "stats-observed:transition": "transition",
  "stats-observed:no-op": "no-op",
  "visibility-changed:transition": "transition",
  "standby-changed:transition": "transition",
  "network-changed:transition": "transition",
  "network-changed:no-op": "no-op",
  "ice-policy-changed:transition": "transition",
  "round-changed:transition": "transition",
  "command-completed:transition": "transition",
  "command-completed:no-op": "no-op",
  "peer-removed:transition": "transition",
  "room-closed:transition": "transition",
  "connection-replaced-externally:transition": "transition",
  "connection-replaced-externally:no-op": "no-op",
} as const satisfies Partial<Record<PeerCellKey, PeerOutcome>>
type PeerLiveCellKey = keyof typeof OPEN_ROW
export type PeerTableKey = PeerLiveCellKey

const NON_CONNECTING_ROW = { ...OPEN_ROW, "clock:connect-by": "no-op", "clock:gather-stall": "no-op" } as const
const CLOSED_ROW = Object.fromEntries(Object.keys(OPEN_ROW).map((key) => [key, "no-op"])) as Record<PeerLiveCellKey, "no-op">
export const peerTransitionTable = defineTransitionTable<PeerStateKey, PeerTableKey>()({
  connecting: OPEN_ROW,
  connected: NON_CONNECTING_ROW,
  "link-down": NON_CONNECTING_ROW,
  yielded: NON_CONNECTING_ROW,
  closed: CLOSED_ROW,
})
const peerTableKey = (testEvent: PeerTestEvent): PeerTableKey => peerCellKey(testEvent) as PeerLiveCellKey

/** Sites that act on a rejection; every other site only logs it. */
const ACTING_REJECTION_SITES: ReadonlySet<string> = new Set(["supervisor-recovery", "network-change", "lane", "statement-offer-received", "statement-answer"])

const invariants: readonly NamedInvariant<PeerActorState, ModelPeerState, PeerTestEvent, PeerObservation, string, string>[] = [
  {
    name: "a rejected command never fails the connection",
    specClause: "a rejected command is rebuilt or logged, per site; no site marks the link failed",
    check: ({ event, previousReal, real }) => {
      if (event.event.type === "command-completed" && real.link === "link-down" && previousReal.link !== "link-down") throw new Error("rejection failed the connection")
    },
  },
  {
    name: "a completion issues only the answer, the rejoin's channel, or an acting site's rejection program",
    specClause: "an applied offer is answered; refusedAndRebuilt makes a channel after the sent answer; the supervisor's recovery, a network change, laneNegotiationFailed, a refused remote offer and a refused answer that leaves our offer held (#1605) act on a rejection; the rest log it; the polite side's displaced answer (#1606) takes the peer's offer again on a fresh responder",
    check: ({ event, realObservation }) => {
      const completion = event.event
      if (completion.type !== "command-completed" || realObservation.commands.length === 0) return
      if (completion.outcome === "rejected") {
        if (!ACTING_REJECTION_SITES.has(completion.site ?? "")) throw new Error("a logged rejection issued commands")
        return
      }
      const only = (prefix: string) => realObservation.commands.length === 1 && realObservation.commands[0]!.startsWith(prefix)
      const answer = completion.outcome === "resolved" && completion.commandKind === "set-remote-description" && only("send-answer:")
      const channel = completion.outcome === "resolved" && completion.commandKind === "send-answer" && only("create-channel")
      const displaced = completion.outcome === "stale" && completion.displaced === true &&
        realObservation.commands.length === 2 &&
        realObservation.commands[0]!.startsWith("replace-connection:answer-displaced-rejoin:answer@") &&
        realObservation.commands[1]!.startsWith("set-remote-description:statement@")
      if (!answer && !channel && !displaced) throw new Error("a completion issued commands it may not")
    },
  },
  {
    name: "an answer is sent only for an applied remote offer",
    specClause: "the statement and lane paths answer only after the peer's offer is set as the remote description",
    check: ({ event, previousReal, realObservation }) => {
      if (!realObservation.commands.some((command) => command.startsWith("send-answer:"))) return
      const completion = event.event
      if (completion.type !== "command-completed" || completion.commandKind !== "set-remote-description" || completion.outcome !== "resolved" || previousReal.remoteOffer === null) throw new Error("answer without an applied offer")
    },
  },
  {
    name: "a superseded lane offer is rolled back only while it is still set",
    specClause: "offerOnLane rolls back only when signalingState is have-local-offer",
    check: ({ event, realObservation }) => {
      if (event.event.type === "local-offer-superseded" && !event.event.haveLocalOffer && realObservation.commands.length > 0) throw new Error("rolled back an offer the connection had left")
    },
  },
  {
    name: "a rejection spends the immediate hard-SDP rebuild at most once a round",
    specClause: "#485: one immediate rebuild per peer per round",
    check: ({ event, previousReal, realObservation }) => {
      if (event.event.type === "command-completed" && previousReal.budgets.negotiationImmediate > 0 && realObservation.commands.some((command) => command.startsWith("replace-connection:hard-sdp"))) throw new Error("spent immediate rebuild used again")
    },
  },
  {
    name: "a supervisor sweep while the page is hidden issues nothing",
    specClause: "Mesh.supervise: in the background nothing is attempted, and so nothing is counted",
    check: ({ event, previousReal, realObservation }) => {
      if (event.event.type === "clock" && previousReal.hidden && realObservation.commands.length > 0) throw new Error("hidden sweep acted")
    },
  },
  {
    name: "a supervisor sweep inside the backoff only marks away or re-initiates a yield",
    specClause: "Mesh.supervise: an attempt waits 3 s doubling per failure, at most 20 s, after the last; the away mark and the stranded yield come before that gate. The failures and the last attempt are the actor's own",
    check: ({ event, previousReal, realObservation }) => {
      // the sweep as the actor took it: a generated one is moved past the backoff
      const tick = factFor(event, previousReal.scope.roomEpoch, previousReal.connectionEpoch, previousReal.lastAttemptAt).event
      if (tick.type !== "clock" || previousReal.lastAttemptAt === null) return
      const backoff = backoffMs(previousReal.budgets.failCount)
      const ungated = (command: string) => command.startsWith("mark-away") || command.startsWith("replace-connection:stranded-yield-unanswered") || command.startsWith("create-channel")
      const acted = realObservation.commands.some((command) => !ungated(command))
      if (tick.now - previousReal.lastAttemptAt < backoff && acted) throw new Error("attempt inside the backoff")
    },
  },
  {
    name: "a peer who said it left is only rebuilt for a channel that never opened",
    specClause: "#229: no restart or rebuild against a phone that said it left; the channel stall comes before that check",
    check: ({ event, realObservation }) => {
      const tick = event.event
      if (tick.type === "clock" && tick.snapshot.away === "said" && realObservation.commands.some((command) => !command.startsWith("replace-connection:channel-never-opened"))) throw new Error("healed a said-away peer")
    },
  },
  {
    name: "only a link that was up and stays down marks the peer away",
    specClause: "#229: away after AWAY_AFTER_MS for a link that was up; a link never up is not away",
    check: ({ event, previousReal, realObservation }) => {
      const tick = event.event
      const everConnected = event.times?.everConnected ?? previousReal.everConnected
      if (tick.type === "clock" && realObservation.commands.some((command) => command.startsWith("mark-away")) && (!everConnected || tick.snapshot.away !== null || tick.snapshot.browserConnectionState === "connected")) throw new Error("marked away without a dropped link")
    },
  },
  {
    name: "the backoff clock moves only with an attempt, and is cleared only with the failures",
    specClause: "lastAttemptAt is set by every recovery attempt (ICE restart, yield, rebuild, network change, and Mesh's own replace outside an actor command), and dropped with failCount when the peer is back",
    check: ({ event, previousReal, real, realObservation }) => {
      if (real.lastAttemptAt === previousReal.lastAttemptAt) return
      // Mesh's own replace is an attempt too, with no command of the actor's,
      // or carries the last attempt Mesh made on that connection
      const meshReplaced = event.event.type === "connection-replaced-externally"
      if (meshReplaced) return
      if (real.lastAttemptAt === null) {
        if (real.budgets.failCount !== 0) throw new Error("last attempt dropped with failures left")
        return
      }
      if (!realObservation.commands.some((command) => /^(restart-ice|replace-connection|yield-responder)/.test(command))) throw new Error("last attempt moved without an attempt")
      // Mesh stamps its clock only on the facts that may make an attempt
      if (!ATTEMPT_EVENT_TYPES_FOR_INVARIANT.has(event.event.type)) throw new Error(`an attempt on ${event.event.type}, which Mesh does not time`)
    },
  },
  {
    name: "a budget grows only on the command that spends it",
    specClause: "a failure is counted on every recovery, yield and rebuild, a heal only where it heals, and a round's rebuild only where it rebuilds",
    check: ({ previousReal, real, realObservation }) => {
      const spent: Record<keyof PeerActorState["budgets"], RegExp> = {
        failCount: /^(restart-ice|replace-connection|yield-responder)/,
        stallHeals: /^(restart-ice|replace-connection):media-stall/,
        unseenHeals: /^restart-ice:peer-no-video/,
        noVideoRebuilds: /^replace-connection:(connected-no-video|channel-never-opened)/,
        glareRebuilds: /^replace-connection:lane-glare-video/,
        frozenRebuilds: /^replace-connection:media-frozen/,
        negotiationImmediate: /^replace-connection:(hard-sdp-immediate|answer-refused)/,
        negotiationUnseen: /^replace-connection:(hard-sdp-unseen|peer-no-video-hard-sdp)/,
        gatherStallRebuilds: /^replace-connection:gathering-stalled/,
      }
      for (const [budget, command] of Object.entries(spent) as [keyof PeerActorState["budgets"], RegExp][]) {
        if (real.budgets[budget] > previousReal.budgets[budget] && !realObservation.commands.some((issued) => command.test(issued))) throw new Error(`${budget} grew without its command`)
      }
    },
  },
  {
    name: "a frozen link never restarts ICE",
    specClause: "#1917 (spec part 3): a connected link whose frames stayed flat while its packets rose on every stall sweep is asked for a keyframe, then rebuilt; an ICE restart cannot mend a decoder waiting for a keyframe",
    check: ({ event, previousReal, realObservation }) => {
      const read = event.event
      if (read.type !== "stats-observed" || !realObservation.commands.some((command) => command.startsWith("restart-ice:media-stall"))) return
      if (previousReal.frozenAsked) throw new Error("an asked frozen episode restarted ICE")
      if (read.packetsMoving === true && previousReal.frozenSamples >= previousReal.stallSamples) throw new Error("a frozen link restarted ICE")
    },
  },
  {
    name: "the frozen path asks once an episode, inside the heal window, and spends no stall heal",
    specClause: "#1917 (spec part 3): one keyframe ask and one rebuild per frozen episode, held in a flag of its own; the heal hold and MEDIA_HEAL_BACKOFF_MS still space heals; the frozen path does not increment stallHeals",
    check: ({ event, previousReal, real, realObservation }) => {
      const asked = realObservation.commands.some((command) => command.startsWith("ask-keyframe"))
      const rebuilt = realObservation.commands.some((command) => command.startsWith("replace-connection:media-frozen"))
      if (!asked && !rebuilt) return
      const read = event.event
      if (read.type !== "stats-observed" || read.healDue !== true) throw new Error("frozen heal outside the heal window")
      if (asked && previousReal.frozenAsked) throw new Error("a second keyframe ask in one episode")
      if (rebuilt && !previousReal.frozenAsked) throw new Error("a frozen rebuild with no keyframe ask first")
      if (real.budgets.stallHeals > previousReal.budgets.stallHeals) throw new Error("the frozen path spent a stall heal")
    },
  },
  {
    name: "epochs never decrease",
    specClause: "room, connection and command epochs never decrease; only Mesh's own connection, told by connection-replaced-externally, may move an actor that got ahead of it back",
    check: ({ event, previousReal, real }) => {
      if ((real.connectionEpoch < previousReal.connectionEpoch && event.event.type !== "connection-replaced-externally") || real.commandEpoch < previousReal.commandEpoch || real.roundGeneration < previousReal.roundGeneration) throw new Error("epoch decreased")
    },
  },
  {
    name: "stale facts emit no effects",
    specClause: "stale events never mutate current state or emit effects",
    check: ({ event, realObservation }) => {
      if ((event.key.startsWith("stale-") || event.key.startsWith("old-")) && realObservation.commands.length > 0) throw new Error("stale event emitted command")
    },
  },
  {
    name: "presentation has no recovery authority",
    specClause: "presentation cannot initiate recovery",
    check: ({ event, realObservation }) => {
      if (event.key === "standby" && realObservation.commands.some((command) => command.startsWith("restart-ice") || command.startsWith("replace-connection"))) throw new Error("presentation initiated recovery")
    },
  },
  {
    name: "round reset retains peer unseen budget",
    specClause: "budget lifetimes: unseenHeals clears on peer removal/room close, or on a sweep whose peer freshly sees us (#1523), never at a round change",
    check: ({ event, previousReal, real }) => {
      if (event.key === "round-change" && real.budgets.unseenHeals !== previousReal.budgets.unseenHeals) throw new Error("peer-lifetime budget reset at round")
    },
  },
]

const SWEEP_TIMES = ["lastSignalAt", "firstHeardAt", "lastRecvDescAt", "offerSentAt", "yieldedAt", "upAt", "connectingSince", "downAt", "disconnectedAt"] as const

const ATTEMPT_EVENT_TYPES_FOR_INVARIANT: ReadonlySet<PeerActorEvent["type"]> = new Set([
  "description-observed",
  "peer-session-changed",
  "clock",
  "glare-observed",
  "stats-observed",
  "network-changed",
  "command-completed",
  "connection-replaced-externally",
])

/** A generated fact for the peer as it now is: its current epochs, and a sweep
 *  moved past the actor's backoff (its clock and its times shifted together,
 *  so it means what its witness means) now that the backoff is the actor's own. */
function relativeTo(testEvent: PeerTestEvent, roomEpoch: number, connectionEpoch: number, lastAttemptAt: number | null): { event: PeerActorEvent; times: PeerTestTimes } {
  const relative = { ...testEvent.event, roomEpoch, connectionEpoch }
  const times = testEvent.times ?? {}
  if (relative.type !== "clock" || lastAttemptAt === null) return { event: relative, times }
  const shift = Math.max(0, lastAttemptAt + 20_000 - relative.now)
  const shifted: Record<string, unknown> = { ...times }
  for (const key of SWEEP_TIMES) {
    const at = times[key]
    if (at !== null && at !== undefined) shifted[key] = at + shift
  }
  return { event: { ...relative, now: relative.now + shift }, times: shifted as PeerTestTimes }
}

/** The fact a step takes: a generated one relative to the peer as it is. */
const factFor = (testEvent: PeerTestEvent, roomEpoch: number, connectionEpoch: number, lastAttemptAt: number | null) =>
  testEvent.relative ? relativeTo(testEvent, roomEpoch, connectionEpoch, lastAttemptAt) : { event: testEvent.event, times: {} }

export const peerMachineDefinition: MachineDefinition<PeerActorState, ModelPeerState, PeerTestEvent, ReturnType<typeof stepPeerActor>, ReturnType<typeof stepModelPeer>, PeerObservation, PeerStateKey, PeerTableKey> = {
  name: "webrtc-peer-actor",
  initialReal: baseActor,
  initialModel: () => modelFrom(baseActor()),
  initialArbitrary: fc.record({
    roomEpoch: fc.integer({ min: 1, max: 3 }),
    connectionEpoch: fc.integer({ min: 1, max: 3 }),
    roundGeneration: fc.integer({ min: 0, max: 3 }),
    link: fc.constantFrom(...peerConnectionInitialStates),
    away: fc.constantFrom("here" as const, "said" as const, "timeout" as const),
    failCount: fc.integer({ min: 0, max: 6 }),
    unseenHeals: fc.integer({ min: 0, max: 1 }),
    noVideoRebuilds: fc.integer({ min: 0, max: 1 }),
    negotiationImmediate: fc.integer({ min: 0, max: 1 }),
    negotiationUnseen: fc.integer({ min: 0, max: 1 }),
  }).map(({ roomEpoch, connectionEpoch, roundGeneration, link, away, failCount, unseenHeals, noVideoRebuilds, negotiationImmediate, negotiationUnseen }) => {
    const real = actor({
      scope: { game: 42, roomEpoch, peer: "peer-a" },
      connectionEpoch,
      roundGeneration,
      link,
      away,
      budgets: { failCount, unseenHeals, noVideoRebuilds, negotiationImmediate, negotiationUnseen } as PeerActorState["budgets"],
    })
    return { real, model: modelFrom(real) }
  }),
  realStep: (state, testEvent) => {
    // a generated sweep means what its witness means: the peer has seen the
    // facts its times say, on the actor and the model alike
    const { event, times } = factFor(testEvent, state.scope.roomEpoch, state.connectionEpoch, state.lastAttemptAt)
    const seen = event.type === "clock" && testEvent.relative ? withTimes(state, times) : state
    const output = stepPeerActor(seen, event)
    // a sweep that changed nothing is a no-op on the state it was given
    return { state: output.state === seen ? state : output.state, output }
  },
  modelStep: (state, testEvent) => {
    const { event, times } = factFor(testEvent, state.roomEpoch, state.connectionEpoch, state.lastAttemptAt)
    const seen = event.type === "clock" && testEvent.relative ? { ...state, ...times } : state
    const output = stepModelPeer(seen, event as ModelPeerEvent)
    return { state: output.state === seen ? state : output.state, output }
  },
  classifyRealStep: (previous, result) => result.state === previous && result.output.commands.length === 0 ? "no-op" : "transition",
  observeReal: (result) => observeActor(result.output),
  observeModel: (result) => observeModel(result.output),
  realStateKey: (state) => peerStateKey(state.link),
  modelStateKey: (state) => peerStateKey(state.link as PeerLink),
  eventKey: peerTableKey,
  transitionTable: peerTransitionTable,
  witnesses: peerWitnesses,
  regressions: peerRegressionCorpus,
  invariants,
  // A channel stall is rebuilt once a round, by the actor's own budget,
  // and no round changes in a generated sequence: its witnesses
  // cover it, the generator leaves it out.
  sequenceArbitrary: fc.array(
    fc.constantFrom(
      ...["heard", "description", "connected", "channel-open", "glare-rebuild", "codec-rollback", "standby", "network-restart", "policy-unchanged", "remove", "stale-room", "stale-connection", "tick-restart", "tick-away", "tick-yield", "tick-stranded"]
        .map((key) => baseWitnesses.find((witness) => witness.events[0]!.key === key)!.events[0]!)
        .map((event) => event.key.startsWith("stale-") ? event : { ...event, relative: true }),
    ),
    { minLength: 0, maxLength: 60 },
  ),
  numRuns: 250,
}

