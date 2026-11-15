// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * peer.definition.ts's peerMutationProbes, copied verbatim with `executableMutation` renamed `probe`: there each probe
 * keeps its mutated step inside a `detected()` closure run on its witness,
 * and the search needs the step itself. "keeps the probe list in step" in
 * actor.test.ts fails when the two lists' names drift apart.
 */
import { stepPeerActor, type PeerActorEvent, type PeerActorState } from "../../state-machines/peer-actor"
import { clockOf, snapshotOf, tickOf as tickFrom, timesOf, withTimes, type SupervisorTickFacts } from "../../state-machines/peer-actor.test-helper"
import type { PeerEventKey } from "../../state-machines/peer.definition"

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

export type ActorMutation = (state: PeerActorState, event: PeerActorEvent) => ReturnType<typeof stepPeerActor>

const probe = (mutation: string, witness: PeerEventKey, mutate: ActorMutation) => ({ mutation, witness, mutate })

export const ACTOR_MUTATIONS = [
  probe("remove stale connection epoch check", "stale-connection", (state, event) =>
    stepPeerActor(state, { ...event, connectionEpoch: state.connectionEpoch })),
  probe("flatten away on a short signal gap", "heard-said-short", (state, event) => {
    const result = stepPeerActor(state, event)
    return { ...result, state: { ...result.state, away: "here" } }
  }),
  probe("spend watchdog budget while hidden", "hidden-stats-held", (state, event) =>
    stepPeerActor(withTimes({ ...state, hidden: false }), event)),
  probe("remove hard-SDP authorisation for one-way rebuild", "one-way-restart", (state, event) =>
    stepPeerActor(withTimes({ ...state, budgets: { ...state.budgets, negotiationImmediate: 1 } }), event)),
  probe("change strict eight-second resume boundary", "resume-eight", (state, event) =>
    stepPeerActor(state, { ...event, hiddenForMs: 8_001 } as PeerActorEvent)),
  probe("reject lower positive replacement counter", "frame-reset", (state, event) =>
    stepPeerActor(state, { ...event, framesDecoded: state.framesSeen } as PeerActorEvent)),
  probe("exclude timeout-away from supervision", "tick-away-already", (state, event) =>
    stepWithTick(state, event, { away: "said" })),
  probe("reset peer unseen budget at round change", "round-change", (state, event) => {
    const result = stepPeerActor(state, event)
    return { ...result, state: { ...result.state, budgets: { ...result.state.budgets, unseenHeals: 0 } } }
  }),
  probe("keep away failure budget across session change", "peer-session-changed", (state, event) => {
    const result = stepPeerActor(state, event)
    return { ...result, state: { ...result.state, budgets: { ...result.state.budgets, failCount: state.budgets.failCount } } }
  }),
  probe("rebuild for a new signalling session in the side's own role", "session-over-our-offer", (state, event) => {
    const result = stepPeerActor(state, event)
    if (event.type !== "peer-session-changed") return result
    return { ...result, commands: result.commands.map((command) => command.kind === "replace-connection" ? { ...command, initiate: state.initiator } : command) }
  }),
  probe("drop the leave a new signalling session over our offer grants", "session-over-our-offer", (state, event) => {
    const result = stepPeerActor(state, event)
    if (event.type !== "peer-session-changed") return result
    return { ...result, commands: result.commands.map((command) => command.kind === "replace-connection" ? { ...command, answererMayOffer: undefined } : command) }
  }),
  probe("ignore a new remote session on a description", "new-session-offer", (state, event) =>
    stepPeerActor(state, { ...event, newRemoteSession: undefined } as PeerActorEvent)),
  probe("apply a new-session answer to the fresh connection", "new-session-answer", (state, event) => {
    const result = stepPeerActor(state, event)
    return { ...result, commands: [...result.commands, { kind: "set-remote-description", lane: false, commandEpoch: result.state.commandEpoch + 1, connectionEpoch: result.state.connectionEpoch }] }
  }),
  probe("drop the remote lane offer stall reset", "lane-offer-received", (state, event) => {
    const result = stepPeerActor(state, event)
    return { ...result, state: { ...result.state, stallSamples: state.stallSamples } }
  }),
  probe("drop the inbound-stat gate on the unseen heal", "unseen-no-stat", (state, event) =>
    stepPeerActor(state, { ...event, framesDecoded: 0 } as PeerActorEvent)),
  probe("drop the inbound-stat gate on the unseen hard-SDP rebuild", "unseen-no-stat-hard", (state, event) =>
    stepPeerActor(state, { ...event, framesDecoded: 0 } as PeerActorEvent)),
  probe("require positive frames for the unseen heal", "unseen-zero-stat", (state, event) =>
    stepPeerActor(state, { ...event, framesDecoded: -1 } as PeerActorEvent)),
  probe("reset the stall count on any lane description", "lane-answer-received", (state, event) => {
    const result = stepPeerActor(state, event)
    return { ...result, state: { ...result.state, stallSamples: 0 } }
  }),
  probe("fail the connection on any rejected command", "rejected-media-completion", (state, event) => {
    const result = stepPeerActor(state, event)
    return event.type === "command-completed" && event.outcome === "rejected" ? { ...result, state: { ...result.state, connection: "link-down" } } : result
  }),
  probe("fail the connection on an unstamped negotiation rejection", "unstamped-rejection", (state, event) => {
    const result = stepPeerActor(state, event)
    return { ...result, state: { ...result.state, connection: "link-down" } }
  }),
  probe("log a supervisor ICE restart that throws", "restart-rejected-rebuild", (state, event) =>
    stepPeerActor(state, { ...event, site: "media-stall" } as PeerActorEvent)),
  probe("rebuild on a media-stall ICE restart that throws", "restart-rejected-logged", (state, event) =>
    stepPeerActor(state, { ...event, site: "supervisor-recovery" } as PeerActorEvent)),
  probe("rebuild on a lane error that is not a hard SDP one", "lane-soft-rejected", (state, event) =>
    stepPeerActor(state, { ...event, reason: "hard-sdp" } as PeerActorEvent)),
  probe("rebuild again with the immediate budget spent", "lane-hard-spent", (state, event) =>
    stepPeerActor(withTimes({ ...state, budgets: { ...state.budgets, negotiationImmediate: 0 } }), event)),
  probe("ignore the round a hard lane error began in", "lane-hard-old-round", (state, event) =>
    stepPeerActor(state, { ...event, roundGeneration: state.roundGeneration } as PeerActorEvent)),
  probe("treat our statement offer's hard error as a lane one", "statement-offer-sent-rejected", (state, event) =>
    stepPeerActor(state, { ...event, site: "lane", roundGeneration: state.roundGeneration } as PeerActorEvent)),
  probe("rebuild a virgin connection as a rejoin", "offer-refused-virgin", (state, event) =>
    stepPeerActor(state, { ...event, reason: "invalid-access" } as PeerActorEvent)),
  probe("drop the offer re-applied after a rejoin rebuild", "offer-refused-invalid-access", (state, event) => {
    const result = stepPeerActor(state, event)
    return { ...result, commands: result.commands.filter((command) => command.kind !== "set-remote-description") }
  }),
  probe("keep the away state on a refused offer's rejoin", "offer-refused-invalid-access", (state, event) => {
    const result = stepPeerActor(state, event)
    return { ...result, state: { ...result.state, away: state.away, lastSignalAt: state.lastSignalAt, budgets: { ...result.state.budgets, failCount: state.budgets.failCount } } }
  }),
  probe("fail the connection on a stale codec guard", "codec-guard-stale", (state, event) => {
    const result = stepPeerActor(state, event)
    return { ...result, state: { ...result.state, connection: "link-down" } }
  }),
  probe("keep the away state on a statement glare", "statement-glare-away", (state, event) => {
    const result = stepPeerActor(state, event)
    return { ...result, state: { ...result.state, away: state.away, budgets: { ...result.state.budgets, failCount: state.budgets.failCount } } }
  }),
  probe("drop the lane glare stall reset", "lane-glare-stall", (state, event) => {
    const result = stepPeerActor(state, event)
    return { ...result, state: { ...result.state, stallSamples: state.stallSamples } }
  }),
  probe("send no answer for an applied remote offer", "statement-offer-applied", (state, event) => {
    const result = stepPeerActor(state, event)
    return { ...result, commands: result.commands.filter((command) => command.kind !== "send-answer") }
  }),
  probe("answer a remote answer", "remote-answer-applied", (state, event) =>
    stepPeerActor(withTimes({ ...state, remoteOffer: "statement" }), event)),
  probe("answer a lane offer on the statement wire", "lane-offer-applied", (state, event) =>
    stepPeerActor(withTimes({ ...state, remoteOffer: "statement" }), event)),
  probe("forget the rejoin when its offer is applied", "rejoin-offer-applied", (state, event) => {
    const result = stepPeerActor(state, event)
    return { ...result, state: { ...result.state, rejoinAnswer: false } }
  }),
  probe("log the lane answer's hard SDP error", "lane-answer-hard-rejected", (state, event) =>
    stepPeerActor(state, { ...event, site: "statement-answer" } as PeerActorEvent)),
  probe("drop the rejoin's channel after its answer", "rejoin-answer-sent", (state, event) => {
    const result = stepPeerActor(state, event)
    return { ...result, commands: result.commands.filter((command) => command.kind !== "create-channel") }
  }),
  probe("make the rejoin's channel after a stale answer", "rejoin-answer-stale", (state, event) =>
    stepPeerActor(state, { ...event, outcome: "resolved" } as PeerActorEvent)),
  probe("keep a superseded lane offer", "lane-offer-superseded", (state) =>
    ({ state, commands: [] })),
  probe("roll back a superseded offer the connection already left", "lane-offer-superseded-left", (state, event) =>
    stepPeerActor(state, { ...event, haveLocalOffer: true } as PeerActorEvent)),
  // the supervisor's rules, one probe per boundary and branch
  probe("recover while the page is hidden", "tick-hidden-held", (state, event) =>
    stepPeerActor(withTimes({ ...state, hidden: false }), event)),
  probe("restart inside the disconnect grace", "tick-grace", (state, event) =>
    stepWithTick(state, event, { disconnectedAt: tickOf(state, event).disconnectedAt - 1 })),
  probe("restart with the restarts spent", "tick-restarts-spent", (state, event) =>
    stepPeerActor(withTimes({ ...state, budgets: { ...state.budgets, failCount: 0 } }), event)),
  probe("restart ICE over a closed lane", "tick-closed-lane", (state, event) =>
    stepWithTick(state, event, { laneOpen: true })),
  probe("restart ICE without restartIce", "tick-no-restart-api", (state, event) =>
    stepWithTick(state, event, { canRestartIce: true })),
  probe("ignore the backoff", "tick-backoff", (state, event) =>
    stepPeerActor(withTimes({ ...state, lastAttemptAt: null }), event)),
  probe("wait one more millisecond of backoff", "tick-backoff-over", (state, event) =>
    stepPeerActor(withTimes({ ...state, lastAttemptAt: (state.lastAttemptAt ?? 0) + 1 }), event)),
  probe("double the backoff past twenty seconds", "tick-backoff-cap", (state, event) =>
    stepPeerActor(withTimes({ ...state, lastAttemptAt: (state.lastAttemptAt ?? 0) + 1 }), event)),
  probe("heal a peer who said it left", "tick-said", (state, event) =>
    stepWithTick(state, event, { away: null })),
  probe("never mark a peer away", "tick-away", (state, event) =>
    stepWithTick(state, event, { away: "timeout" })),
  probe("mark away at exactly AWAY_AFTER", "tick-away-boundary", (state, event) =>
    stepWithTick(state, event, { downAt: tickOf(state, event).downAt - 1 })),
  probe("mark a timed-out peer away again", "tick-away-already", (state, event) =>
    stepWithTick(state, event, { away: null })),
  probe("mark away a link that was never up", "tick-away-never-up", (state, event) =>
    stepWithTick(state, event, { everConnected: true })),
  probe("chase a peer gone 45 s", "tick-gone", (state, event) =>
    stepWithTick(state, event, { lastSignalAt: (tickOf(state, event).lastSignalAt ?? 0) + 1 })),
  probe("stop chasing at under 45 s", "tick-fresh-boundary", (state, event) =>
    stepWithTick(state, event, { lastSignalAt: (tickOf(state, event).lastSignalAt ?? 0) - 1 })),
  probe("drop the just-dropped chase", "tick-just-dropped", (state, event) =>
    stepWithTick(state, event, { downAt: tickOf(state, event).downAt - 1 })),
  probe("offer again after the yield as well", "tick-stranded", (state, event) => {
    const result = stepPeerActor(state, event)
    return { ...result, commands: [...result.commands, { kind: "send-offer", lane: false, commandEpoch: result.state.commandEpoch + 1, connectionEpoch: result.state.connectionEpoch }] }
  }),
  probe("gate the stranded re-initiation on the backoff", "tick-stranded-backoff", (state) =>
    ({ state, commands: [] })),
  probe("re-initiate a yield under 30 s", "tick-stranded-early", (state, event) =>
    stepWithTick(state, event, { yieldedAt: (tickOf(state, event).yieldedAt ?? 0) - 1 })),
  probe("re-initiate a yielded connection that has a channel", "tick-stranded-channel", (state, event) =>
    stepWithTick(state, event, { hasChannel: false })),
  probe("re-initiate a yielded connection that took an offer", "tick-stranded-described", (state, event) =>
    stepWithTick(state, event, { remoteDescription: false })),
  probe("wait one more millisecond at connectBy", "tick-never-initial-boundary", (state, event) =>
    stepPeerActor(withTimes(state, { connectingSince: Math.max(state.connectingSince ?? 0, state.firstHeardAt ?? 0) + 1 }), event)),
  probe("keep the everConnected gate on connectBy (#1562)", "tick-connect-by-ever", (state, event) =>
    stepPeerActor(state.everConnected ? { ...state, deadlines: { ...state.deadlines, connectBy: null } } : state, event)),
  probe("anchor connectBy on the first hello alone", "tick-connect-by-ever-early", (state, event) =>
    stepPeerActor(withTimes(state, { connectingSince: 0 }), event)),
  probe("ignore the negotiation quiet", "tick-never-quiet", (state, event) =>
    stepWithTick(state, event, { lastRecvDescAt: (tickOf(state, event).lastRecvDescAt ?? 0) - 1 })),
  probe("rebuild before the initiator's answer wait", "tick-never-offer-waiting", (state, event) =>
    stepWithTick(state, event, { offerSentAt: (tickOf(state, event).offerSentAt ?? 0) - 1 })),
  probe("read the never-sent offer as just sent", "tick-never-due", (state, event) =>
    stepWithTick(state, event, { offerSentAt: tickOf(state, event).now })),
  probe("rebuild an answerer that heard the initiator", "tick-never-answerer-heard", (state, event) =>
    stepWithTick(state, event, { lastRecvDescAt: null })),
  probe("yield under 30 s", "tick-yield-early", (state, event) =>
    stepWithTick(state, event, { offerSentAt: (tickOf(state, event).offerSentAt ?? 0) - 1 })),
  probe("yield over an open lane", "tick-yield-lane-open", (state, event) =>
    stepWithTick(state, event, { laneOpen: false })),
  probe("rebuild instead of yielding", "tick-yield", (state, event) =>
    stepWithTick(state, event, { browserConnectionState: "failed" })),
  probe("rebuild a channel stall under 23 s", "tick-cno-early", (state, event) =>
    stepWithTick(state, event, { upAt: tickOf(state, event).upAt - 1 })),
  probe("rebuild a channel stall twice a round", "tick-cno-spent", (state, event) =>
    stepPeerActor(withTimes({ ...state, budgets: { ...state.budgets, noVideoRebuilds: 0 } }), event)),
  probe("take a link that showed video for a channel stall", "tick-cno-video", (state, event) =>
    stepWithTick(state, event, { sawVideoThisRound: false })),
  probe("spare a said-away channel stall", "tick-cno-said", (state) =>
    ({ state, commands: [] })),
  probe("rebuild a channel stall inside its backoff", "tick-cno-backoff", (state, event) =>
    stepPeerActor(withTimes({ ...state, lastAttemptAt: null }), event)),
  probe("leave the round's no-video rebuild unspent on a channel stall", "tick-cno", (state, event) => {
    const result = stepPeerActor(state, event)
    return { ...result, state: { ...result.state, budgets: { ...result.state.budgets, noVideoRebuilds: 0 } } }
  }),
  probe("count no failure on a supervisor recovery", "tick-restart", (state, event) => {
    const result = stepPeerActor(state, event)
    return { ...result, state: { ...result.state, budgets: { ...result.state.budgets, failCount: state.budgets.failCount } } }
  }),
  // the budgets the sweep reads are the actor's own
  probe("decide the sweep's backoff from Mesh's copies", "tick-mesh-backoff-copy", (state, event) =>
    stepPeerActor(withTimes({ ...state, lastAttemptAt: null, budgets: { ...state.budgets, failCount: 0 } }), event)),
  // the backoff clock, lastAttemptAt
  probe("leave the backoff clock on a supervisor restart", "tick-restart", (state, event) => {
    const result = stepPeerActor(state, event)
    return { ...result, state: { ...result.state, lastAttemptAt: state.lastAttemptAt } }
  }),
  probe("stamp no attempt on a network restart", "network-restart", (state, event) => {
    const result = stepPeerActor(state, event)
    return { ...result, state: { ...result.state, lastAttemptAt: state.lastAttemptAt } }
  }),
  probe("keep the backoff clock when the peer is back", "away-back", (state, event) => {
    const result = stepPeerActor(state, event)
    return { ...result, state: { ...result.state, lastAttemptAt: state.lastAttemptAt } }
  }),
  probe("ask for a keyframe on a kick the page was never away for", "resume-never-away", (state, event) =>
    stepPeerActor(state, { ...event, keyframe: undefined } as PeerActorEvent)),
  probe("keep the failures on a kick the page was never away for", "resume-never-away", (state, event) => {
    const result = stepPeerActor(state, event)
    return { ...result, state: { ...result.state, lastAttemptAt: state.lastAttemptAt, budgets: { ...result.state.budgets, failCount: state.budgets.failCount } } }
  }),
  probe("keep the backoff clock on a kick", "resume-over-eight", (state, event) => {
    const result = stepPeerActor(state, event)
    return { ...result, state: { ...result.state, lastAttemptAt: state.lastAttemptAt } }
  }),
  probe("forgive a said-away peer on its lane answer", "lane-answer-said", (state, event) => {
    const result = stepPeerActor(state, event)
    return { ...result, state: { ...result.state, away: "here", lastAttemptAt: null, budgets: { ...result.state.budgets, failCount: 0 } } }
  }),
  probe("forgive a said-away peer on its lane offer", "lane-offer-said", (state, event) => {
    const result = stepPeerActor(state, event)
    return { ...result, state: { ...result.state, away: "here", lastAttemptAt: null, budgets: { ...result.state.budgets, failCount: 0 } } }
  }),
  probe("clear the backoff clock on a present peer's connected", "connected-present", (state, event) => {
    const result = stepPeerActor(state, event)
    return { ...result, state: { ...result.state, lastAttemptAt: null } }
  }),
  // stallHeals, the removal, and the stall count
  probe("reset the stall heals on promotion", "promote-keeps-heals", (state, event) => {
    const result = stepPeerActor(state, event)
    return { ...result, state: { ...result.state, budgets: { ...result.state.budgets, stallHeals: 0 } } }
  }),
  probe("keep the failures after a removal", "remove-budgets", (state, event) => {
    const result = stepPeerActor(state, event)
    return { ...result, state: { ...result.state, lastAttemptAt: state.lastAttemptAt, budgets: { ...result.state.budgets, failCount: state.budgets.failCount } } }
  }),
  probe("keep the unseen heals after a removal", "remove-budgets", (state, event) => {
    const result = stepPeerActor(state, event)
    return { ...result, state: { ...result.state, budgets: { ...result.state.budgets, unseenHeals: state.budgets.unseenHeals } } }
  }),
  probe("keep the peer's presence after a removal", "remove-budgets", (state, event) => {
    const result = stepPeerActor(state, event)
    return { ...result, state: { ...result.state, away: state.away, lastSignalAt: state.lastSignalAt } }
  }),
  probe("drop the round's budgets on a removal", "remove-budgets", (state, event) => {
    const result = stepPeerActor(state, event)
    return { ...result, state: { ...result.state, budgets: { ...result.state.budgets, noVideoRebuilds: 0, glareRebuilds: 0, negotiationImmediate: 0 } } }
  }),
  probe("keep the stall count on an unseen restart", "unseen-stall-reset", (state, event) => {
    const result = stepPeerActor(state, event)
    return { ...result, state: { ...result.state, stallSamples: state.stallSamples + 1 } }
  }),
  probe("reset the stall count on our own lane offer", "lane-offer-requested", (state, event) => {
    const result = stepPeerActor(state, event)
    return { ...result, state: { ...result.state, stallSamples: 0 } }
  }),
  probe("decide the channel stall from Mesh's no-video copy", "tick-cno-mesh-copy", (state, event) =>
    stepPeerActor(withTimes({ ...state, budgets: { ...state.budgets, noVideoRebuilds: 0 } }), event)),
  probe("ignore our camera's stamp on a sweep", "camera-came-up", (state, event) =>
    stepPeerActor(state, event.type === "stats-observed" ? { ...event, cameraLive: undefined } : event)),
  probe("ignore a connection Mesh replaced itself", "replaced-externally", (state) =>
    ({ state, commands: [], ignored: "stale-connection" })),
  probe("keep the stall heals across Mesh's own replace", "replaced-externally", (state, event) => {
    const result = stepPeerActor(state, event)
    return { ...result, state: { ...result.state, budgets: { ...result.state.budgets, stallHeals: state.budgets.stallHeals } } }
  }),
  probe("drop the peer's failures on Mesh's own replace", "replaced-externally", (state, event) => {
    const result = stepPeerActor(state, event)
    return { ...result, state: { ...result.state, budgets: { ...result.state.budgets, failCount: 0 } } }
  }),
  probe("leave the backoff clock on Mesh's own replace", "replaced-externally", (state, event) => {
    const result = stepPeerActor(state, event)
    return { ...result, state: { ...result.state, lastAttemptAt: state.lastAttemptAt } }
  }),
  probe("adopt a connection the actor already holds", "replaced-externally-known", (state, event) =>
    stepPeerActor(state, { ...event, connectionEpoch: state.connectionEpoch + 1 })),
  probe("stay ahead of the connection Mesh holds", "replaced-externally-older", (state) =>
    ({ state, commands: [], ignored: "stale-connection" })),
  // a new signalling session, and a peer back
  probe("replace a connection that negotiated nothing", "session-nothing-negotiated", (state, event) =>
    stepPeerActor(state, { ...event, negotiated: undefined } as PeerActorEvent)),
  probe("leave Mesh's away mark on a peer back", "away-back", (state, event) => {
    const result = stepPeerActor(state, event)
    return { ...result, commands: [] }
  }),
  probe("leave a timed-out peer away after a long absence", "resume-timeout-back", (state, event) => {
    const result = stepPeerActor(state, event)
    return { ...result, state: { ...result.state, away: state.away } }
  }),
] as const
