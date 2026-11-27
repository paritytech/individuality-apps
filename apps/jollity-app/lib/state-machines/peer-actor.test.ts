// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { createPeerActorState, stepPeerActor, type PeerActorCommand, type PeerActorEvent, type PeerActorState } from "./peer-actor"
import { clockOf, decideFromTick, timesOf, withTimes, type SupervisorTickFacts } from "./peer-actor.test-helper"
import { tickFacts } from "./peer.definition"

const initial = (overrides: Partial<PeerActorState> = {}) => {
  const state = createPeerActorState({ game: 1, roomEpoch: 1, peer: "peer" })
  return withTimes({ ...state, ...overrides, scope: { ...state.scope, ...overrides.scope }, budgets: { ...state.budgets, ...overrides.budgets } })
}

const event = <Event extends Omit<PeerActorEvent, "roomEpoch" | "connectionEpoch">>(value: Event, connectionEpoch = 1): PeerActorEvent => ({
  ...value,
  roomEpoch: 1,
  connectionEpoch,
}) as PeerActorEvent

/** The clock fact of a tick's facts, at these epochs. */
const clockAt = (facts: SupervisorTickFacts, connectionEpoch = 1): PeerActorEvent => clockOf(facts, { roomEpoch: 1, connectionEpoch })
/** A supervisor sweep at Mesh's clock 100 s (tickFacts), with these facts. */
const tick = (facts: Partial<SupervisorTickFacts> = {}, connectionEpoch = 1): PeerActorEvent => clockAt(tickFacts(facts), connectionEpoch)
/** A sweep over an actor that saw every fact Mesh did: its own times are the
 *  tick's (design B, B1: the actor decides from its own times). */
const sweep = (state: PeerActorState, sweepEvent: PeerActorEvent) =>
  stepPeerActor(withTimes(state, timesOf(sweepEvent)), sweepEvent)
/** our statement offer, sent 30 s ago over a closed lane, is still unanswered */
const unanswered: Partial<SupervisorTickFacts> = { laneOpen: false, haveLocalOffer: true, offerSentAt: 70_000, disconnectedAt: 0 }
/** a yielded, responder-only connection that took no description, yielded 30 s ago */
const yielded: Partial<SupervisorTickFacts> = { browserConnectionState: "new", everConnected: false, laneOpen: false, hasChannel: false, localDescription: false, remoteDescription: false, downAt: 0, disconnectedAt: 0, firstHeardAt: null, lastRecvDescAt: null, yieldedAt: 70_000 }
/** connected 23 s with no channel open and no video */
const stalledChannel: Partial<SupervisorTickFacts> = { browserConnectionState: "connected", laneOpen: false, framesSeen: 0, upAt: 77_000, downAt: 0, disconnectedAt: 0 }

describe("what a command carries for Mesh's log lines and heal records (design B, B2)", () => {
  /** a connected link with frames seen, its stall due on the next flat read */
  const flowing = () => initial({ link: "connected", laneOpen: true, framesSeen: 815, cameraLive: true })
  const stall = (state: PeerActorState, readSequence: number, now: number) =>
    stepPeerActor(state, event({ type: "stats-observed", readSequence, framesDecoded: 815, browserConnectionState: "connected", recoveryDue: true, stallAfter: 1, now }))

  it("stamps every command with the clock of the fact it was decided on, and none without one", () => {
    const failed = { ...tickFacts({ browserConnectionState: "failed", downAt: 90_000, disconnectedAt: 0 }), now: 100_000 }
    const step = sweep(initial({ everConnected: true, lastSignalAt: 99_000 }), clockAt(failed))
    expect(step.commands.length).toBeGreaterThan(0)
    for (const command of step.commands) expect(command.at).toBe(100_000)
    const { now: _now, ...unstamped } = event({ type: "network-changed" }) as PeerActorEvent & { now?: number }
    void _now
    for (const command of stepPeerActor(initial({ laneOpen: true }), unstamped as PeerActorEvent).commands) expect(command.at).toBeUndefined()
  })

  it("carries the failures after this attempt's count on a restart, a rebuild and a yield", () => {
    const disconnected = { ...tickFacts({ browserConnectionState: "disconnected", disconnectedAt: 95_000, downAt: 95_000, laneOpen: true }), now: 100_000 }
    const restart = sweep(initial({ everConnected: true, lastSignalAt: 99_000, laneOpen: true }), clockAt(disconnected))
    expect(restart.commands).toEqual([expect.objectContaining({ kind: "restart-ice", cause: "soft-disconnect", attempt: 1 })])
    const rebuild = sweep({ ...restart.state, lastAttemptAt: 50_000 }, clockAt(disconnected))
    expect(rebuild.commands).toEqual([expect.objectContaining({ kind: "replace-connection", cause: "soft-disconnect", attempt: 2 })])
    const yielded = sweep(initial({ link: "connecting", budgets: { failCount: 3 } as PeerActorState["budgets"], lastAttemptAt: 80_000 }), tick(unanswered))
    expect(yielded.commands.map((command) => [command.kind, command.attempt])).toEqual([["yield-responder", 4], ["replace-connection", 4]])
  })

  it("carries a stall's heal count: one ICE restart, then the rebuild (#1523 F5)", () => {
    const first = stall(flowing(), 1, 1_000)
    expect(first.commands).toEqual([expect.objectContaining({ kind: "restart-ice", cause: "media-stall", heal: 1 })])
    const second = stall(first.state, 2, 2_000)
    expect(second.commands).toEqual([expect.objectContaining({ kind: "replace-connection", cause: "media-stall", heal: 2, attempt: 1, at: 2_000 })])
    expect(second.state.budgets.stallHeals).toBe(0)
  })

  it("carries the unseen heal's count, one ICE restart only (#1523 F5)", () => {
    const unseen = (state: PeerActorState, readSequence: number) =>
      stepPeerActor(state, event({ type: "stats-observed", readSequence, framesDecoded: 815 + readSequence, browserConnectionState: "connected", peerCannotSeeUs: true, now: 1_000 * readSequence }))
    const first = unseen(flowing(), 1)
    expect(first.commands).toEqual([expect.objectContaining({ kind: "restart-ice", cause: "peer-no-video", heal: 1 })])
    const second = unseen(first.state, 2)
    expect(second.commands).toEqual([])
    expect(second.state.budgets.unseenHeals).toBe(1)
  })
})

describe("pure WebRTC peer actor", () => {
  describe("B4 connect-by deadline", () => {
    const freshConnection = () => stepPeerActor(
      initial({ initiator: false, everConnected: true, firstHeardAt: 1_000, lastSignalAt: 79_000 }),
      event({ type: "connection-replaced-externally", now: 80_000 }, 2),
    ).state

    it("stamps each fresh connection and arms connectBy from the later of first heard and connection start", () => {
      expect(freshConnection()).toMatchObject({
        link: "connecting",
        connectingSince: 80_000,
        deadlines: { connectBy: 98_000 },
      })
    })

    it("closes #1562: an ever-connected answerer stays up for the full connection deadline, then rebuilds as offerer", () => {
      const fresh = freshConnection()
      const snapshot = tickFacts({
        now: 97_999,
        browserConnectionState: "new",
        laneOpen: false,
        localDescription: false,
        remoteDescription: false,
        hasChannel: false,
        firstHeardAt: 1_000,
        lastSignalAt: 79_000,
        lastRecvDescAt: null,
        everConnected: true,
      })
      expect(sweep(fresh, clockAt(snapshot, 2))).toMatchObject({ commands: [], ignored: "idle" })
      const due = sweep(fresh, clockAt({ ...snapshot, now: 98_000 }, 2))
      expect(due.commands).toEqual([expect.objectContaining({
        kind: "replace-connection",
        cause: "connect-by-deadline",
        initiate: true,
      })])
    })

    it("keeps the late-hearer quiet and unanswered-offer guards after connectBy", () => {
      const initiator = { ...freshConnection(), initiator: true }
      const heard = { ...initiator, lastRecvDescAt: 95_000 }
      expect(sweep(heard, tick({ now: 109_999, browserConnectionState: "new", downAt: 0, disconnectedAt: 0, firstHeardAt: 1_000, lastRecvDescAt: 95_000 }, 2))).toMatchObject({ commands: [], ignored: "idle" })
      expect(sweep(heard, tick({ now: 110_000, browserConnectionState: "new", downAt: 0, disconnectedAt: 0, firstHeardAt: 1_000, lastRecvDescAt: 95_000 }, 2)).commands)
        .toEqual([expect.objectContaining({ kind: "replace-connection", cause: "connect-by-deadline", initiate: true })])

      const offering = { ...initiator, offerSentAt: 90_000 }
      expect(sweep(offering, tick({ now: 119_999, browserConnectionState: "new", downAt: 0, disconnectedAt: 0, firstHeardAt: 1_000, lastRecvDescAt: null, offerSentAt: 90_000 }, 2))).toMatchObject({ commands: [], ignored: "idle" })
      expect(sweep(offering, tick({ now: 120_000, browserConnectionState: "new", downAt: 0, disconnectedAt: 0, firstHeardAt: 1_000, lastRecvDescAt: null, offerSentAt: 90_000 }, 2)).commands)
        .toEqual([expect.objectContaining({ kind: "replace-connection", cause: "connect-by-deadline", initiate: true })])
    })
  })

  // #1163, on the sweep since 3b step 4: the yield is an attempt, so it waits
  // out the actor's backoff like any other (the old answer-deadline fact
  // yielded at once); the stranded re-initiation does not wait
  it("yields on #1163 whatever the prior failures once past the backoff, then re-initiates only on the separate stranded wait", () => {
    const failed = { link: "connecting" as const, budgets: { failCount: 3 } as PeerActorState["budgets"] }
    expect(sweep(initial({ ...failed, lastAttemptAt: 99_000 }), tick(unanswered))).toMatchObject({ commands: [], ignored: "idle" })
    const first = sweep(initial({ ...failed, lastAttemptAt: 80_000 }), tick(unanswered))
    expect(first.state).toMatchObject({ link: "yielded", connectionEpoch: 2, lastAttemptAt: 100_000, budgets: { failCount: 4 } })
    expect(first.commands).toEqual([
      expect.objectContaining({ kind: "yield-responder" }),
      expect.objectContaining({ kind: "replace-connection", initiate: false, cause: "answer-timeout-yield" }),
    ])

    expect(sweep(first.state, tick({ ...yielded, yieldedAt: 70_001 }, 2))).toMatchObject({ commands: [], ignored: "idle" })
    const second = sweep(first.state, tick(yielded, 2))
    expect(second.state).toMatchObject({ connectionEpoch: 3, budgets: { failCount: 4 } })
    expect(second.commands.map((command) => command.kind)).toEqual(["replace-connection", "create-channel"])
  })

  it("holds both #1163 sweeps while hidden", () => {
    const waitingAnswer = initial({ link: "connecting", hidden: true, budgets: { failCount: 3 } as PeerActorState["budgets"] })
    expect(stepPeerActor(waitingAnswer, tick(unanswered))).toEqual({ state: waitingAnswer, commands: [], ignored: "held" })
    const stranded = initial({ link: "yielded", hidden: true, budgets: { failCount: 4 } as PeerActorState["budgets"] })
    expect(stepPeerActor(stranded, tick(yielded))).toEqual({ state: stranded, commands: [], ignored: "held" })
  })

  it("leaves both #1163 sweeps idle for a peer who said it left", () => {
    const waitingAnswer = initial({ link: "connecting", away: "said", budgets: { failCount: 3 } as PeerActorState["budgets"] })
    expect(stepPeerActor(waitingAnswer, tick({ ...unanswered, away: "said" }))).toEqual({ state: waitingAnswer, commands: [], ignored: "idle" })
    const stranded = initial({ link: "yielded", away: "said", budgets: { failCount: 4 } as PeerActorState["budgets"] })
    expect(stepPeerActor(stranded, tick({ ...yielded, away: "said" }))).toEqual({ state: stranded, commands: [], ignored: "idle" })
  })

  it("takes a statement glare as the peer coming back, and a lane glare as a stall restart only", () => {
    const away = initial({ link: "connecting", away: "timeout", stallSamples: 3, budgets: { failCount: 3 } as PeerActorState["budgets"] })
    const statement = stepPeerActor(away, event({ type: "glare-observed", remoteCarriesVideo: false, polite: false, lane: false }))
    expect(statement.state).toMatchObject({ away: "here", stallSamples: 3, budgets: { failCount: 0 } })
    expect(statement.commands.map((command) => command.kind)).toEqual(["ignore-offer"])
    const lane = stepPeerActor(away, event({ type: "glare-observed", remoteCarriesVideo: false, polite: false, lane: true }))
    expect(lane.state).toMatchObject({ away: "timeout", stallSamples: 0, budgets: { failCount: 3 } })
    expect(lane.commands.map((command) => command.kind)).toEqual(["ignore-offer"])
  })

  it("a held sweep between two frozen ones restarts the stall count, so the sweep after it does not restart ICE (game 1521)", () => {
    const sweep = (state: PeerActorState, readSequence: number, browserConnectionState = "connected") =>
      stepPeerActor(state, event({ type: "stats-observed", readSequence, framesDecoded: 815, browserConnectionState, stallAfter: 2, recoveryDue: true }))
    let state = initial({ link: "connected", laneOpen: true, framesSeen: 815, framesReadSequence: 1 })
    state = sweep(state, 2).state
    expect(state.stallSamples).toBe(1)
    const held = sweep(state, 3, "disconnected")
    expect(held.commands).toEqual([])
    expect(held.state.stallSamples).toBe(0)
    state = stepPeerActor(held.state, event({ type: "connection-observed", state: "connected" })).state
    const after = sweep(state, 4)
    expect(after.commands).toEqual([])
    expect(after.state.stallSamples).toBe(1)
  })

  it("an ICE-only connection-observed connected does not restart the stall count", () => {
    const start = initial({ link: "connected", laneOpen: true, framesSeen: 815, stallSamples: 1 })
    const next = stepPeerActor(start, event({ type: "connection-observed", state: "connected" }))
    expect(next.state.stallSamples).toBe(1)
  })

  it("reads a glare with no lane field, as saved before the lane was recorded, as a lane glare", () => {
    const away = initial({ link: "connecting", away: "timeout", stallSamples: 3, budgets: { failCount: 3 } as PeerActorState["budgets"] })
    const { lane: _lane, ...saved } = event({ type: "glare-observed", remoteCarriesVideo: false, polite: false, lane: true }) as unknown as Record<string, unknown>
    const result = stepPeerActor(away, saved as never)
    expect(result.state).toMatchObject({ away: "timeout", stallSamples: 0, budgets: { failCount: 3 } })
  })

  it("leaves a yielded connection alone once it took the peer's statement offer", () => {
    const negotiating = initial({ link: "connecting", budgets: { failCount: 4 } as PeerActorState["budgets"] })
    expect(stepPeerActor(negotiating, tick({ ...yielded, remoteDescription: true }))).toEqual({
      state: negotiating,
      commands: [],
      ignored: "idle",
    })
  })

  it("a hidden peer's lane answer is not the peer coming back: away and the last attempt stay (game 1590)", () => {
    const said = initial({ link: "connecting", away: "said", lastAttemptAt: 100_000, budgets: { failCount: 1 } as PeerActorState["budgets"] })
    const lane = stepPeerActor(said, event({ type: "description-observed", lane: true, description: "answer" }))
    expect(lane.state).toMatchObject({ away: "said", lastAttemptAt: 100_000, budgets: { failCount: 1 } })
    const statement = stepPeerActor(said, event({ type: "description-observed", lane: false, description: "answer" }))
    expect(statement.state).toMatchObject({ away: "here", lastAttemptAt: null, budgets: { failCount: 0 } })
  })

  it("keeps said-away on resume and lets channel-never-opened rebuild exactly once", () => {
    const resumed = stepPeerActor(initial({ hidden: true, away: "said", budgets: { failCount: 2 } as PeerActorState["budgets"] }), event({ type: "visibility-changed", hidden: false, hiddenForMs: 8_001 }))
    expect(resumed.state).toMatchObject({ away: "said", budgets: { failCount: 0 } })
    const first = sweep(initial({ link: "connected", away: "said" }), tick({ ...stalledChannel, away: "said" }))
    expect(first.commands).toEqual([expect.objectContaining({ kind: "replace-connection", cause: "channel-never-opened" })])
    const second = sweep(initial({ link: "connected", away: "said", budgets: { noVideoRebuilds: 1 } as PeerActorState["budgets"] }), tick({ ...stalledChannel, away: "said" }))
    expect(second).toMatchObject({ commands: [], ignored: "idle" })
  })

  it("requires hard SDP evidence before a one-way claim may rebuild", () => {
    const fact = { type: "stats-observed" as const, readSequence: 2, framesDecoded: 3, browserConnectionState: "connected" as const, peerCannotSeeUs: true }
    const bare = stepPeerActor(initial({ link: "connected", framesSeen: 2, framesReadSequence: 1 }), event(fact))
    expect(bare.commands).toEqual([expect.objectContaining({ kind: "restart-ice", cause: "peer-no-video" })])
    const authorised = stepPeerActor(initial({ link: "connected", framesSeen: 2, framesReadSequence: 1, budgets: { negotiationImmediate: 1 } as PeerActorState["budgets"] }), event(fact))
    expect(authorised.commands).toEqual([expect.objectContaining({ kind: "replace-connection", cause: "peer-no-video-hard-sdp" })])
  })

  it("resets stall samples at every legacy reset boundary", () => {
    const stalled = initial({ link: "connected", stallSamples: 3, framesSeen: 2 })
    // our own lane offer is not one: offerOnLane leaves the count (game 1512, 3c step 5)
    expect(stepPeerActor(stalled, event({ type: "local-offer-requested", lane: true })).state.stallSamples).toBe(3)
    expect(stepPeerActor(stalled, event({ type: "visibility-changed", hidden: true })).state.stallSamples).toBe(0)
    expect(stepPeerActor({ ...stalled, standby: true }, event({ type: "standby-changed", standby: false })).state.stallSamples).toBe(0)
    expect(stepPeerActor({ ...stalled, link: "link-down" }, event({ type: "stats-observed", readSequence: 1, framesDecoded: 2, browserConnectionState: "failed" })).state.stallSamples).toBe(0)
  })

  describe("an answerer's stall count when the remote side renegotiates the lane", () => {
    const run = (description: "offer" | "answer") => {
      let state = initial({ link: "connected", laneOpen: true, initiator: false })
      let sequence = 0
      const stats = (framesDecoded: number) => {
        const result = stepPeerActor(state, event({
          type: "stats-observed", readSequence: ++sequence, framesDecoded,
          browserConnectionState: "connected", stallAfter: 6, recoveryDue: true,
        }))
        state = result.state
        return result.commands
      }
      stats(1000); stats(1181)
      for (let i = 0; i < 5; i++) expect(stats(1181)).toEqual([])
      state = stepPeerActor(state, event({ type: "description-observed", lane: true, description })).state
      return { stats, samples: () => state.stallSamples }
    }

    it("starts over when the initiator's lane offer arrives, so a heal already under way is not doubled", () => {
      const { stats, samples } = run("offer")
      expect(samples()).toBe(0)
      expect(stats(1181)).toEqual([])
      for (let i = 0; i < 4; i++) expect(stats(1181)).toEqual([])
      expect(stats(1181)).toEqual([expect.objectContaining({ kind: "restart-ice", cause: "media-stall" })])
    })

    it("keeps counting through a remote lane answer, which is not a renegotiation of this side", () => {
      const { stats, samples } = run("answer")
      expect(samples()).toBe(5)
      expect(stats(1181)).toEqual([expect.objectContaining({ kind: "restart-ice", cause: "media-stall" })])
    })
  })

  describe("healing an unseen link waits for an inbound video stat", () => {
    const sweep = (state: PeerActorState, framesDecoded: number, readSequence: number) => stepPeerActor(state, event({
      type: "stats-observed", readSequence, framesDecoded,
      browserConnectionState: "connected", stallAfter: 2, recoveryDue: true, peerCannotSeeUs: true,
    }))

    it("spends nothing while no inbound stat exists, then restarts ICE once one does", () => {
      const waiting = sweep(initial({ link: "connected", laneOpen: true, initiator: true }), -1, 1)
      expect(waiting.commands).toEqual([])
      expect(waiting.state.budgets.unseenHeals).toBe(0)
      const healed = sweep(waiting.state, 34, 2)
      expect(healed.commands).toEqual([expect.objectContaining({ kind: "restart-ice", cause: "peer-no-video" })])
      expect(healed.state.budgets.unseenHeals).toBe(1)
    })

    it("does not rebuild for a hard SDP while no inbound stat exists", () => {
      const waiting = sweep(initial({ link: "connected", laneOpen: true, initiator: true, budgets: { negotiationImmediate: 1 } as PeerActorState["budgets"] }), -1, 1)
      expect(waiting.commands).toEqual([])
      expect(waiting.state.budgets.negotiationUnseen).toBe(0)
    })

    it("heals with frames of zero, which is a stat, not a missing one", () => {
      const result = sweep(initial({ link: "connected", laneOpen: true, initiator: true }), 0, 1)
      expect(result.commands).toEqual([expect.objectContaining({ kind: "restart-ice", cause: "peer-no-video" })])
    })

    it("heals an unseen link when the no-video rebuild is already spent this round", () => {
      const spent = initial({ link: "connected", laneOpen: true, initiator: true, budgets: { noVideoRebuilds: 1 } as PeerActorState["budgets"] })
      const result = stepPeerActor(spent, event({
        type: "stats-observed", readSequence: 1, framesDecoded: 0,
        browserConnectionState: "connected", noVideoDeadline: true, stallAfter: 2, recoveryDue: true, peerCannotSeeUs: true,
      }))
      expect(result.commands).toEqual([expect.objectContaining({ kind: "restart-ice", cause: "peer-no-video" })])
    })

    it("does not count a stall off a missing stat once recovery is due", () => {
      let state = initial({ link: "connected", laneOpen: true, initiator: true })
      const stats = (framesDecoded: number, recoveryDue: boolean, readSequence: number) => {
        const result = stepPeerActor(state, event({
          type: "stats-observed", readSequence, framesDecoded,
          browserConnectionState: "connected", stallAfter: 2, recoveryDue,
        }))
        state = result.state
        return result.commands
      }
      stats(100, false, 1)
      expect(stats(100, false, 2)).toEqual([])
      expect(stats(100, false, 3)).toEqual([])
      expect(stats(-1, true, 4)).toEqual([])
      expect(state.framesReadSequence).toBe(4)
    })

    it("still rebuilds a connected link with no video once the no-video deadline passes", () => {
      const result = stepPeerActor(initial({ link: "connected", laneOpen: true, initiator: true }), event({
        type: "stats-observed", readSequence: 1, framesDecoded: -1,
        browserConnectionState: "connected", noVideoDeadline: true, peerCannotSeeUs: true,
      }))
      expect(result.commands).toEqual([expect.objectContaining({ kind: "replace-connection", cause: "connected-no-video" })])
    })
  })

  it("uses the stamped browser connection for stats after actor recovery transitions", () => {
    const recovering = initial({
      link: "connecting",
      framesSeen: 4,
      framesReadSequence: 1,
      budgets: { stallHeals: 1 } as PeerActorState["budgets"],
    })
    const secondStall = stepPeerActor(recovering, event({
      type: "stats-observed",
      readSequence: 2,
      framesDecoded: 4,
      browserConnectionState: "connected",
      recoveryDue: true,
      stallAfter: 1,
    }))
    expect(secondStall.commands).toEqual([expect.objectContaining({ kind: "replace-connection", cause: "media-stall" })])

    const actorStillConnected = initial({ link: "connected", framesSeen: 4, stallSamples: 2 })
    expect(stepPeerActor(actorStillConnected, event({
      type: "stats-observed",
      readSequence: 2,
      framesDecoded: 4,
      browserConnectionState: "disconnected",
      recoveryDue: true,
      stallAfter: 1,
    }))).toMatchObject({ commands: [], ignored: "held", state: { stallSamples: 0 } })
  })

  it("keeps the last signal and away orthogonal at the exact return boundary", () => {
    const said = initial({ away: "said", lastSignalAt: 1 })
    const boundary = stepPeerActor(said, event({ type: "peer-heard", at: 20_001 }))
    expect(boundary.state).toMatchObject({ lastSignalAt: 20_001, away: "said" })
    const beyond = stepPeerActor(said, event({ type: "peer-heard", at: 20_002 }))
    expect(beyond.state).toMatchObject({ lastSignalAt: 20_002, away: "here" })
  })

  it("lets timeout-away heal while said-away alone is excluded", () => {
    const link = { link: "link-down" as const, laneOpen: true }
    const said = sweep(initial({ ...link, away: "said" }), tick({ disconnectedAt: 90_000, away: "said" }))
    const timeout = sweep(initial({ ...link, away: "timeout" }), tick({ disconnectedAt: 90_000, away: "timeout" }))
    expect(said).toMatchObject({ commands: [], ignored: "idle" })
    expect(timeout.commands).toEqual([expect.objectContaining({ kind: "restart-ice" })])
  })

  // #1608: a change inferred from one link's new local address (no OS event)
  // must not break the links that already work
  it("on an inferred network change, leaves a link already on the new network or connected, and repairs the rest", () => {
    const onNew = stepPeerActor(initial({ link: "connected", laneOpen: true }), event({ type: "network-changed", inferred: true, onNewNetwork: true, browserConnectionState: "connecting" }))
    expect(onNew).toMatchObject({ commands: [], ignored: "idle" })
    const connected = stepPeerActor(initial({ link: "connected", laneOpen: true, lastAttemptAt: 1_000 }), event({ type: "network-changed", inferred: true, onNewNetwork: false, browserConnectionState: "connected" }))
    expect(connected).toMatchObject({ commands: [], ignored: "idle" })
    expect(connected.state.lastAttemptAt).toBe(1_000) // no attempt was made
    const dropped = stepPeerActor(initial({ link: "link-down", laneOpen: true }), event({ type: "network-changed", inferred: true, onNewNetwork: false, browserConnectionState: "disconnected" }))
    expect(dropped.commands).toEqual([expect.objectContaining({ kind: "restart-ice", cause: "network-change" })])
    const announced = stepPeerActor(initial({ link: "connected", laneOpen: true }), event({ type: "network-changed" }))
    expect(announced.commands).toEqual([expect.objectContaining({ kind: "restart-ice", cause: "network-change" })])
  })

  it("drops stale connection and command completions before any effect", () => {
    const staleConnection = stepPeerActor(initial({ connectionEpoch: 3 }), event({ type: "network-changed" }, 2))
    expect(staleConnection).toMatchObject({ commands: [], ignored: "stale-connection" })
    const staleCommand = stepPeerActor(initial({ commandEpoch: 4 }), event({ type: "command-completed", commandEpoch: 3, commandKind: "send-offer", outcome: "resolved" }))
    expect(staleCommand).toMatchObject({ commands: [], ignored: "stale-command" })
  })

  it("clears the failure budget when an away peer starts a new session, as legacy setAway does", () => {
    let state = initial({ link: "link-down", laneOpen: true })
    // one ICE restart; the second attempt now rebuilds (Q2)
    state = sweep(state, tick({ now: 100_000, disconnectedAt: 90_000, downAt: 99_000, lastSignalAt: 99_000 })).state
    state = stepPeerActor(state, event({ type: "peer-away", away: "timeout" })).state
    expect(state.budgets.failCount).toBe(1)

    const newSession = stepPeerActor(state, event({ type: "peer-session-changed",  at: 10 }))
    const latePeerBack = stepPeerActor(newSession.state, event({ type: "peer-away", away: "back" }, state.connectionEpoch))

    expect(newSession.state).toMatchObject({ link: "connecting", connectionEpoch: state.connectionEpoch + 1, away: "here", budgets: { failCount: 0 } })
    expect(latePeerBack).toMatchObject({ commands: [], ignored: "stale-connection" })
  })

  it("clears the failure budget when a said-away peer starts a new session", () => {
    const state = initial({ link: "link-down", laneOpen: true, away: "said", budgets: { failCount: 2 } as PeerActorState["budgets"] })

    const newSession = stepPeerActor(state, event({ type: "peer-session-changed",  at: 10 }))

    expect(newSession.state).toMatchObject({ away: "here", budgets: { failCount: 0 } })
  })

  it("keeps the failure budget when a present peer starts a new session", () => {
    const state = initial({ link: "link-down", laneOpen: true, away: "here", budgets: { failCount: 2 } as PeerActorState["budgets"] })

    const newSession = stepPeerActor(state, event({ type: "peer-session-changed",  at: 10 }))

    expect(newSession.state).toMatchObject({ link: "connecting", away: "here", budgets: { failCount: 2 } })
  })

  it("rebuilds for a new signalling session as an offerer on either side, as onPeerSession does (Mesh's mayOffer decides the channel)", () => {
    for (const initiator of [true, false]) {
      const state = initial({ link: "connected", laneOpen: true, initiator })
      const newSession = stepPeerActor(state, event({ type: "peer-session-changed", at: 10 }))
      // the answerer gets no leave to offer from the rebuild alone
      expect(newSession.commands).toEqual([expect.objectContaining({ kind: "replace-connection", cause: "signalling-session-rejoin", initiate: true })])
      expect(newSession.commands[0]).not.toHaveProperty("answererMayOffer")
    }
  })

  it("keeps the connection when a media or diagnostic command is rejected", () => {
    for (const commandKind of ["request-keyframe", "sweep", "configure-ice", "replace-video-track"] as const) {
      const result = stepPeerActor(initial({ link: "connected", laneOpen: true, commandEpoch: 1, openCommands: { [commandKind]: 1 } }), event({ type: "command-completed", commandEpoch: 1, commandKind, outcome: "rejected" }))
      expect(result.state).toMatchObject({ link: "connected" })
    }
  })

  describe("a rejected command has legacy's outcome for its site (3b step 1)", () => {
    type Kind = PeerActorCommand["kind"]
    const rejected = (commandKind: Kind, stamp: Partial<Pick<Extract<PeerActorEvent, { type: "command-completed" }>, "site" | "reason" | "roundGeneration">>, overrides: Partial<PeerActorState> = {}) =>
      stepPeerActor(
        initial({ link: "connecting", commandEpoch: 1, openCommands: { [commandKind]: 1 }, ...overrides }),
        event({ type: "command-completed", commandEpoch: 1, commandKind, outcome: "rejected", ...stamp }),
      )
    const kinds = (result: ReturnType<typeof stepPeerActor>) => result.commands.map((command) => command.kind === "replace-connection" ? `replace:${command.cause}:${command.initiate}` : command.kind)

    it("never fails the connection: an unstamped rejection of any kind is only logged", () => {
      for (const commandKind of ["restart-ice", "yield-responder", "replace-connection", "set-remote-description", "rollback", "ignore-offer", "create-channel", "send-offer"] as const) {
        const result = rejected(commandKind, {})
        expect(result.state).toMatchObject({ link: "connecting", openCommands: {} })
        expect(result.commands).toEqual([])
      }
    })

    it("rebuilds when recover()'s or a network change's ICE restart throws", () => {
      for (const site of ["supervisor-recovery", "network-change"] as const) {
        const result = rejected("restart-ice", { site }, { link: "connecting", laneOpen: true, budgets: { failCount: 1 } as PeerActorState["budgets"] })
        expect(kinds(result)).toEqual([`replace:${site}-restart-failed:true`])
        expect(result.state).toMatchObject({ link: "connecting", connectionEpoch: 2, laneOpen: false, budgets: { failCount: 1 } })
      }
    })

    it("only logs when the media-stall or unseen heal's ICE restart throws", () => {
      for (const site of ["media-stall", "peer-no-video"] as const) {
        const result = rejected("restart-ice", { site }, { link: "connecting", laneOpen: true })
        expect(result.commands).toEqual([])
        expect(result.state).toMatchObject({ link: "connecting", connectionEpoch: 1, openCommands: {} })
      }
    })

    it("spends the round's immediate rebuild on a hard SDP error at any lane step", () => {
      for (const commandKind of ["send-offer", "set-remote-description", "rollback"] as const) {
        const result = rejected(commandKind, { site: "lane", reason: "hard-sdp", roundGeneration: 0 }, { link: "connecting", initiator: false })
        expect(kinds(result)).toEqual(["replace:hard-sdp-immediate:true"])
        expect(result.state).toMatchObject({ connectionEpoch: 2, budgets: { negotiationImmediate: 1 } })
      }
    })

    it("only logs a lane rejection that is not a hard SDP error, a spent budget, or an earlier round's", () => {
      const lane = { link: "connecting" as const, roundGeneration: 2 }
      expect(rejected("send-offer", { site: "lane", reason: "other", roundGeneration: 2 }, lane).commands).toEqual([])
      expect(rejected("send-offer", { site: "lane", reason: "hard-sdp", roundGeneration: 2 }, { ...lane, budgets: { negotiationImmediate: 1 } as PeerActorState["budgets"] }).commands).toEqual([])
      expect(rejected("set-remote-description", { site: "lane", reason: "hard-sdp", roundGeneration: 1 }, lane).commands).toEqual([])
    })

    it("only logs a hard SDP error on our statement offer, which never reaches laneNegotiationFailed", () => {
      const result = rejected("send-offer", { site: "statement-offer-sent", reason: "hard-sdp" })
      expect(result.commands).toEqual([])
      expect(result.state.budgets.negotiationImmediate).toBe(0)
    })

    it("re-initiates a virgin connection that refused a remote statement offer", () => {
      const result = rejected("set-remote-description", { site: "statement-offer-received", reason: "virgin-pc" }, { initiator: false })
      expect(kinds(result)).toEqual(["replace:stranded-offer-refused:false", "create-channel"])
      expect(result.commands[1]).toMatchObject({ connectionEpoch: 2 })
      expect(result.state).toMatchObject({ link: "connecting" })
    })

    it("rebuilds as responder and applies the offer again on InvalidAccessError", () => {
      const result = rejected("set-remote-description", { site: "statement-offer-received", reason: "invalid-access" })
      expect(kinds(result)).toEqual(["replace:offer-refused-rejoin:false", "set-remote-description"])
      expect(result.commands[1]).toMatchObject({ lane: false, connectionEpoch: 2 })
      expect(result.state).toMatchObject({ link: "connecting", openCommands: { "set-remote-description": 3 } })
    })

    it("only logs (rethrows) any other refusal of a statement offer, and a refusal on the rebuilt connection", () => {
      expect(rejected("set-remote-description", { site: "statement-offer-received", reason: "other" }).commands).toEqual([])
      expect(rejected("set-remote-description", { site: "statement-offer-retried", reason: "invalid-access" }).commands).toEqual([])
      expect(rejected("set-remote-description", { site: "statement-answer", reason: "hard-sdp" }).commands).toEqual([])
    })

    it("closes the codec guard's offer on a stale bail and does nothing else", () => {
      const result = stepPeerActor(
        initial({ link: "connecting", commandEpoch: 2, openCommands: { "send-offer": 2 } }),
        event({ type: "command-completed", commandEpoch: 2, commandKind: "send-offer", outcome: "stale", site: "lane" }),
      )
      expect(result.commands).toEqual([])
      expect(result.state).toMatchObject({ link: "connecting", openCommands: {} })
    })
  })

  it("lands an older command's result after a command of another kind completed, but never twice", () => {
    const state = initial({ link: "connecting", commandEpoch: 3, openCommands: { "send-offer": 2 } })

    const late = stepPeerActor(state, event({ type: "command-completed", commandEpoch: 2, commandKind: "send-offer", outcome: "rejected" }))
    const again = stepPeerActor(late.state, event({ type: "command-completed", commandEpoch: 2, commandKind: "send-offer", outcome: "rejected" }))

    expect(late.state).toMatchObject({ link: "connecting", openCommands: {} })
    expect(again).toMatchObject({ commands: [], ignored: "stale-command" })
  })

  it("drops the result of an attempt a newer command of the same kind superseded", () => {
    const result = stepPeerActor(initial({ link: "connecting", commandEpoch: 5, openCommands: { "send-offer": 5 } }), event({ type: "command-completed", commandEpoch: 2, commandKind: "send-offer", outcome: "rejected" }))

    expect(result).toMatchObject({ commands: [], ignored: "stale-command" })
  })

  it("forgets the old connection's open commands when the connection is replaced", () => {
    const result = stepPeerActor(initial({ link: "connecting", commandEpoch: 2, openCommands: { "send-offer": 2, rollback: 1 } }), event({ type: "glare-observed", remoteCarriesVideo: true, lane: true }))

    expect(result.state.openCommands).toEqual({ "replace-connection": 3 })
  })

  it("replaces the connection and applies an offer from a new remote session", () => {
    const state = initial({ link: "connected", laneOpen: true, away: "timeout", lastSignalAt: 1, budgets: { failCount: 2 } as PeerActorState["budgets"] })

    const result = stepPeerActor(state, event({ type: "description-observed", lane: false, description: "offer", newRemoteSession: { at: 5_000 } }))

    expect(result.commands.map(({ kind }) => kind)).toEqual(["replace-connection", "set-remote-description"])
    expect(result.commands[0]).toMatchObject({ cause: "description-session-rejoin", initiate: false })
    expect(result.state).toMatchObject({ link: "connecting", connectionEpoch: state.connectionEpoch + 1, away: "here", lastSignalAt: 5_000, budgets: { failCount: 0 } })
  })

  it("replaces the connection without applying an answer from a new remote session", () => {
    for (const initiator of [false, true]) {
      const result = stepPeerActor(initial({ link: "connecting", initiator }), event({ type: "description-observed", lane: false, description: "answer", newRemoteSession: { at: 5_000 } }))

      expect(result.commands).toEqual([expect.objectContaining({ kind: "replace-connection", cause: "description-session-rejoin", initiate: true })])
      expect(result.state).toMatchObject({ link: "connecting" })
    }
  })

  it("treats a positive lower counter on a replacement stream as progress", () => {
    const result = stepPeerActor(
      initial({ link: "connected", framesSeen: 90, framesReadSequence: 4 }),
      event({ type: "stats-observed", readSequence: 5, framesDecoded: 2, browserConnectionState: "connected" }),
    )
    expect(result.state).toMatchObject({ framesSeen: 2, framesReadSequence: 5 })
  })

  it("keeps the strict resume threshold and hidden watchdog hold", () => {
    const hidden = initial({ hidden: true, away: "timeout", budgets: { failCount: 2 } as PeerActorState["budgets"] })
    const boundary = stepPeerActor(hidden, event({ type: "visibility-changed", hidden: false, hiddenForMs: 8_000 }))
    expect(boundary.commands.map((command) => command.kind)).toEqual(["request-keyframe"])
    expect(boundary.state).toMatchObject({ away: "timeout", budgets: { failCount: 2 } })
    const beyond = stepPeerActor(hidden, event({ type: "visibility-changed", hidden: false, hiddenForMs: 8_001 }))
    expect(beyond.commands.map((command) => command.kind)).toEqual(["request-keyframe", "sweep"])
    expect(beyond.state).toMatchObject({ away: "here", budgets: { failCount: 0 } })
    const watchdog = stepPeerActor(hidden, event({ type: "stats-observed", readSequence: 1, framesDecoded: 1, browserConnectionState: "connected", peerCannotSeeUs: true }))
    expect(watchdog).toMatchObject({ commands: [], ignored: "held" })
  })

  it("retains peer budgets while resetting round budgets", () => {
    const before = initial({ roundGeneration: 1, budgets: { unseenHeals: 1, failCount: 3, noVideoRebuilds: 1, negotiationImmediate: 1, negotiationUnseen: 1, glareRebuilds: 1 } as PeerActorState["budgets"] })
    const result = stepPeerActor(before, event({ type: "round-changed", roundGeneration: 2 }))
    expect(result.state.budgets).toMatchObject({ unseenHeals: 1, failCount: 3, noVideoRebuilds: 0, negotiationImmediate: 0, negotiationUnseen: 0, glareRebuilds: 0 })
  })

  describe("the answer to a remote offer (3b step 2)", () => {
    const applied = (lane: boolean, overrides: Partial<PeerActorState> = {}) => {
      const offered = stepPeerActor(initial({ link: "connected", laneOpen: lane, ...overrides }), event({ type: "description-observed", lane, description: "offer" }))
      const srd = offered.commands.find(({ kind }) => kind === "set-remote-description")!
      return stepPeerActor(offered.state, event({ type: "command-completed", commandEpoch: srd.commandEpoch, commandKind: "set-remote-description", outcome: "resolved" }))
    }
    const answerCompleted = (state: PeerActorState, outcome: "resolved" | "rejected" | "stale", stamp: Record<string, unknown> = {}) =>
      stepPeerActor(state, event({ type: "command-completed", commandEpoch: state.openCommands["send-answer"]!, commandKind: "send-answer", outcome, ...stamp }, state.connectionEpoch))

    it.each([[false], [true]])("sends the answer once the remote offer is applied (lane %s), landing on waiting-connected", (lane) => {
      const result = applied(lane)
      expect(result.commands).toEqual([expect.objectContaining({ kind: "send-answer", lane })])
      expect(result.state.remoteOffer).toBeNull()
    })

    it("sends nothing when a remote answer is applied, or the offer's description was refused", () => {
      const answered = stepPeerActor(initial({ link: "connecting" }), event({ type: "description-observed", lane: false, description: "answer" }))
      expect(answered.state.remoteOffer).toBeNull()
      expect(stepPeerActor(answered.state, event({ type: "command-completed", commandEpoch: 1, commandKind: "set-remote-description", outcome: "resolved" })).commands).toEqual([])
      const offered = stepPeerActor(initial(), event({ type: "description-observed", lane: false, description: "offer" }))
      const refused = stepPeerActor(offered.state, event({ type: "command-completed", commandEpoch: 1, commandKind: "set-remote-description", outcome: "rejected", site: "statement-offer-received", reason: "other" }))
      expect(refused.commands).toEqual([])
      expect(refused.state.remoteOffer).toBeNull()
    })

    it("answers the offer of a lane glare it rolled back for, and of a new remote session", () => {
      const glare = stepPeerActor(initial({ link: "connecting", laneOpen: true, budgets: { glareRebuilds: 1 } as PeerActorState["budgets"] }), event({ type: "glare-observed", remoteCarriesVideo: true, lane: true }))
      expect(glare.state.remoteOffer).toBe("lane")
      const session = stepPeerActor(initial({ link: "connected" }), event({ type: "description-observed", lane: false, description: "offer", newRemoteSession: { at: 5 } }))
      expect(session.state.remoteOffer).toBe("statement")
    })

    it("closes the answer on its stale bail and on its send, and does nothing else", () => {
      for (const outcome of ["resolved", "stale"] as const) {
        const result = answerCompleted(applied(false).state, outcome, { site: "statement-answer" })
        expect(result.commands).toEqual([])
        expect(result.state.openCommands["send-answer"]).toBeUndefined()
      }
    })

    it("spends the round's immediate rebuild on a hard SDP error setting the lane answer, as laneNegotiationFailed does", () => {
      const result = answerCompleted(applied(true, { initiator: false }).state, "rejected", { site: "lane", reason: "hard-sdp", roundGeneration: 0 })
      expect(result.commands).toEqual([expect.objectContaining({ kind: "replace-connection", cause: "hard-sdp-immediate", initiate: true })])
      expect(result.state).toMatchObject({ budgets: { negotiationImmediate: 1 } })
    })

    it("only logs a statement answer whose local description or gather fails", () => {
      expect(answerCompleted(applied(false).state, "rejected", { site: "statement-answer", reason: "hard-sdp" }).commands).toEqual([])
    })

    it("after an offer refused with InvalidAccessError, answers on the rebuilt responder, then grants its own offer and makes its channel", () => {
      const refused = stepPeerActor(
        initial({ link: "connecting", initiator: false, commandEpoch: 1, openCommands: { "set-remote-description": 1 }, remoteOffer: "statement" }),
        event({ type: "command-completed", commandEpoch: 1, commandKind: "set-remote-description", outcome: "rejected", site: "statement-offer-received", reason: "invalid-access" }),
      )
      expect(refused.state).toMatchObject({ remoteOffer: "statement", rejoinAnswer: true, connectionEpoch: 2 })
      const srd = refused.commands.find(({ kind }) => kind === "set-remote-description")!
      const answering = stepPeerActor(refused.state, event({ type: "command-completed", commandEpoch: srd.commandEpoch, commandKind: "set-remote-description", outcome: "resolved" }, 2))
      expect(answering.commands.map(({ kind }) => kind)).toEqual(["send-answer"])
      const sent = answerCompleted(answering.state, "resolved")
      expect(sent.commands).toEqual([expect.objectContaining({ kind: "create-channel" })])
      expect(sent.state).toMatchObject({ rejoinAnswer: false })
    })

    it("makes no channel when the rejoin's answer bailed stale, as legacy returns before it", () => {
      const state = initial({ link: "connecting", commandEpoch: 3, openCommands: { "send-answer": 3 }, rejoinAnswer: true })
      const result = answerCompleted(state, "stale", { site: "statement-answer" })
      expect(result.commands).toEqual([])
      expect(result.state).toMatchObject({ rejoinAnswer: false })
    })

    it("forgets the offer being applied when the connection is replaced", () => {
      const offered = stepPeerActor(initial({ link: "connected" }), event({ type: "description-observed", lane: false, description: "offer" }))
      const replaced = stepPeerActor({ ...offered.state, rejoinAnswer: true }, event({ type: "network-changed" }))
      expect(replaced.state).toMatchObject({ remoteOffer: null, rejoinAnswer: false })
    })
  })

  describe("a lane offer superseded after it was set (3b step 3)", () => {
    it("rolls the local offer back when it is still set, landing on stable", () => {
      const result = stepPeerActor(initial({ link: "connecting", laneOpen: true }), event({ type: "local-offer-superseded", haveLocalOffer: true }))
      expect(result.commands).toEqual([expect.objectContaining({ kind: "rollback", cause: "superseded" })])
      // the link moves only on the browser's word (design B)
      expect(result.state.link).toBe("connecting")
    })

    it("does nothing when the connection already left the offer", () => {
      const state = initial({ link: "connecting", laneOpen: true })
      expect(stepPeerActor(state, event({ type: "local-offer-superseded", haveLocalOffer: false }))).toEqual({ state, commands: [] })
    })

    it("follows the lane rule when the rollback is refused with a hard SDP error", () => {
      const rolled = stepPeerActor(initial({ link: "connecting", laneOpen: true }), event({ type: "local-offer-superseded", haveLocalOffer: true }))
      const result = stepPeerActor(rolled.state, event({ type: "command-completed", commandEpoch: 1, commandKind: "rollback", outcome: "rejected", site: "lane", reason: "hard-sdp", roundGeneration: 0 }))
      expect(result.commands).toEqual([expect.objectContaining({ kind: "replace-connection", cause: "hard-sdp-immediate" })])
    })
  })

  describe("a supervisor sweep (3b step 4)", () => {
    const facts: SupervisorTickFacts = {
      now: 100_000, browserConnectionState: "disconnected", haveLocalOffer: false, localDescription: true, remoteDescription: true,
      hasChannel: true, laneOpen: true, everConnected: true, away: null, framesSeen: 10, sawVideoThisRound: false,
      canRestartIce: true, lastSignalAt: 99_000, firstHeardAt: 10_000, lastRecvDescAt: 50_000, offerSentAt: null,
      yieldedAt: null, upAt: 0, downAt: 99_000, disconnectedAt: 99_000,
    }

    it("is idle when it takes no action, and returns the very state it was given", () => {
      const before = initial({ link: "link-down", laneOpen: true })
      const result = stepPeerActor(before, clockAt(facts))
      expect(result).toEqual({ state: before, commands: [], ignored: "idle" })
      expect(result.state).toBe(before)
    })

    it("holds while the page is hidden, whatever the sweep's facts", () => {
      const hidden = stepPeerActor(initial({ link: "link-down", laneOpen: true }), event({ type: "visibility-changed", hidden: true })).state
      expect(stepPeerActor(hidden, clockAt({ ...facts, browserConnectionState: "failed" }))).toEqual({ state: hidden, commands: [], ignored: "held" })
    })

    it("marks a peer away before healing it, in one program", () => {
      const result = sweep(initial({ link: "link-down", laneOpen: true }), clockAt({ ...facts, downAt: 91_999, disconnectedAt: 91_999 }))
      expect(result.commands.map((command) => command.kind)).toEqual(["mark-away", "restart-ice"])
      // an ICE restart is an attempt, not a place: the link stays down (design B)
      expect(result.state).toMatchObject({ away: "timeout", link: "link-down", budgets: { failCount: 1 } })
    })

    it("rebuilds a disconnected link on its second attempt instead of wasting another ICE restart (Q2)", () => {
      const decision = decideFromTick({ ...facts, disconnectedAt: 90_000 }, { initiator: true, lastAttemptAt: 94_000, budgets: { failCount: 1, noVideoRebuilds: 0 } })
      expect(decision).toEqual({ markAway: false, act: "rebuild", cause: "soft-disconnect" })
      const result = sweep(initial({ link: "connecting", laneOpen: true, lastAttemptAt: 94_000, budgets: { failCount: 1 } as PeerActorState["budgets"] }), clockAt({ ...facts, disconnectedAt: 90_000 }))
      expect(result.commands).toEqual([expect.objectContaining({ kind: "replace-connection", cause: "soft-disconnect" })])
    })

    it("decides from the actor's own failures, last attempt and no-video rebuild (3c step 5, design B, B3a)", () => {
      const own = (failCount: number, lastAttemptAt: number | null = null, noVideoRebuilds = 0) => ({ initiator: true, lastAttemptAt, budgets: { failCount, noVideoRebuilds } })
      const decide = (tick: SupervisorTickFacts, view: ReturnType<typeof own>) => decideFromTick(tick, view)
      expect(decide({ ...facts, disconnectedAt: 90_000 }, own(2))).toEqual({ markAway: false, act: "rebuild", cause: "soft-disconnect" })
      expect(decide({ ...facts, disconnectedAt: 90_000 }, own(0)).act).toBe("restart-ice")
      expect(decide({ ...facts, disconnectedAt: 90_000 }, own(1, 99_000)).act).toBe("none")
      expect(decide({ ...facts, disconnectedAt: 90_000 }, own(0, 99_999)).act).toBe("none")
      const stalled = { ...facts, browserConnectionState: "connected" as const, laneOpen: false, framesSeen: 0, upAt: 77_000, downAt: 0, disconnectedAt: 0 }
      expect(decide(stalled, own(0)).act).toBe("channel-never-opened")
      expect(decide(stalled, own(0, null, 1)).act).toBe("none")
    })

    it("decides from the actor's own times, which the clock fact does not carry (design B, B1, B3b)", () => {
      const own = { initiator: true, lastAttemptAt: null, budgets: { failCount: 0, noVideoRebuilds: 0 } }
      // the tick's grace has run out, the actor's has not, and the reverse
      expect(decideFromTick({ ...facts, disconnectedAt: 90_000 }, { ...own, disconnectedAt: 99_000 }).act).toBe("none")
      expect(decideFromTick({ ...facts, disconnectedAt: 99_000 }, { ...own, disconnectedAt: 90_000 }).act).toBe("restart-ice")
      // the tick says the link was down 9 s, the actor 1 s: no away mark
      expect(decideFromTick({ ...facts, downAt: 91_000 }, { ...own, downAt: 99_000 }).markAway).toBe(false)
      expect(decideFromTick({ ...facts, downAt: 99_000 }, { ...own, downAt: 91_000 }).markAway).toBe(true)
      // a channel stall reads the actor's upAt
      const stalled = { ...facts, browserConnectionState: "connected" as const, laneOpen: false, framesSeen: 0, upAt: 99_000, downAt: 0, disconnectedAt: 0 }
      expect(decideFromTick(stalled, { ...own, upAt: 77_000 }).act).toBe("channel-never-opened")
      // presence reads the actor's last signal
      const gone = { ...facts, browserConnectionState: "failed" as const, lastSignalAt: 99_000, downAt: 0 }
      expect(decideFromTick(gone, { ...own, lastSignalAt: 50_000 }).act).toBe("none")
    })
  })

  // design B, B1: the actor stamps each time the supervisor reads from the
  // fact that moves it, as Mesh writes its own copy (the note's 2.2 table)
  describe("the actor's own recovery times (design B, B1)", () => {
    const at = (now: number) => ({ now })
    const step = <Event extends Omit<PeerActorEvent, "roomEpoch" | "connectionEpoch">>(state: PeerActorState, fact: Event) => stepPeerActor(state, event(fact, state.connectionEpoch))
    const connected = (now = 10_000) => step(initial({ initiator: true }), { type: "connection-observed", state: "connected", ...at(now) }).state

    it("upAt: the first connected stamps it, a second keeps it, connecting and new keep it, the other states clear it", () => {
      const up = connected(10_000)
      expect(up).toMatchObject({ upAt: 10_000, everConnected: true })
      expect(step(up, { type: "connection-observed", state: "connected", ...at(12_000) }).state.upAt).toBe(10_000)
      for (const state of ["connecting", "new"] as const) {
        expect(step(up, { type: "connection-observed", state, ...at(12_000) }).state.upAt, state).toBe(10_000)
      }
      for (const state of ["disconnected", "failed", "closed"] as const) {
        expect(step(up, { type: "connection-observed", state, ...at(12_000) }).state.upAt, state).toBeNull()
      }
    })

    it("downAt: the first drop of a link that was up stamps it; a replace keeps it; connected clears it", () => {
      const down = step(connected(), { type: "connection-observed", state: "disconnected", ...at(20_000) }).state
      expect(down.downAt).toBe(20_000)
      // failed after it, and a restart's second drop, keep the first
      expect(step(down, { type: "connection-observed", state: "failed", ...at(25_000) }).state.downAt).toBe(20_000)
      const rebuilt = step({ ...down, laneOpen: false }, clockOf(tickFacts({ now: 25_000, downAt: 20_000, disconnectedAt: 20_000, lastSignalAt: 24_000, laneOpen: false }))).state
      expect(rebuilt.connectionEpoch).toBe(2)
      expect(rebuilt.downAt).toBe(20_000)
      expect(step(rebuilt, { type: "connection-observed", state: "connected", ...at(30_000) }).state.downAt).toBeNull()
      // a link never up drops no "away" clock
      expect(step(initial(), { type: "connection-observed", state: "failed", ...at(20_000) }).state.downAt).toBeNull()
    })

    it("downAt restarts when the peer is shown back while the link is still down (markBack), and only then", () => {
      const down = { ...step(connected(), { type: "connection-observed", state: "disconnected", ...at(20_000) }).state, away: "timeout" as const }
      expect(step(down, { type: "peer-away", away: "back", ...at(29_000) }).state.downAt).toBe(29_000)
      expect(step(down, { type: "description-observed", lane: false, description: "offer", ...at(29_000) }).state.downAt).toBe(29_000)
      expect(step(down, { type: "glare-observed", remoteCarriesVideo: false, polite: false, lane: false, ...at(29_000) }).state.downAt).toBe(29_000)
      expect(step(down, { type: "peer-heard", at: 50_000, ...at(50_000) }).state.downAt).toBe(20_000) // heard 20 s ago: not back
      expect(step({ ...down, lastSignalAt: 20_000 }, { type: "peer-heard", at: 40_001, ...at(40_001) }).state.downAt).toBe(40_001)
      // a peer already here: nothing restarts
      const here = { ...down, away: "here" as const }
      expect(step(here, { type: "description-observed", lane: false, description: "offer", ...at(29_000) }).state.downAt).toBe(20_000)
      // a lane description is not the peer back
      expect(step(down, { type: "description-observed", lane: true, description: "offer", ...at(29_000) }).state.downAt).toBe(20_000)
    })

    it("disconnectedAt: the first disconnected starts the grace; connecting, new and connected end it; failed keeps it", () => {
      const down = step(connected(), { type: "connection-observed", state: "disconnected", ...at(20_000) }).state
      expect(down.disconnectedAt).toBe(20_000)
      expect(step(down, { type: "connection-observed", state: "disconnected", ...at(21_000) }).state.disconnectedAt).toBe(20_000)
      expect(step(down, { type: "connection-observed", state: "failed", ...at(21_000) }).state.disconnectedAt).toBe(20_000)
      for (const state of ["connecting", "new", "connected"] as const) {
        expect(step(down, { type: "connection-observed", state, ...at(21_000) }).state.disconnectedAt, state).toBeNull()
      }
    })

    it("connecting and new have their own arm: the region and the drop stay, and with nothing to clear the step is a no-op", () => {
      const down = step(connected(), { type: "connection-observed", state: "disconnected", ...at(20_000) }).state
      const checking = step(down, { type: "connection-observed", state: "connecting", ...at(21_000) })
      expect(checking.state).toMatchObject({ link: "link-down", downAt: 20_000, upAt: null, disconnectedAt: null })
      expect(checking.commands).toEqual([])
      const again = stepPeerActor(checking.state, event({ type: "connection-observed", state: "new", ...at(22_000) }))
      expect(again).toEqual({ state: checking.state, commands: [] })
    })

    it("everConnected and firstHeardAt are the peer's: a replace keeps them, a new actor takes Mesh's history", () => {
      const heard = step(connected(), { type: "peer-heard", at: 11_000, ...at(11_000) }).state
      expect(heard.firstHeardAt).toBe(11_000)
      expect(step(heard, { type: "peer-heard", at: 12_000, ...at(12_000) }).state.firstHeardAt).toBe(11_000)
      const replaced = step(heard, { type: "network-changed", ...at(13_000) }).state
      expect(replaced).toMatchObject({ connectionEpoch: 2, everConnected: true, firstHeardAt: 11_000 })
      expect(createPeerActorState({ game: 1, roomEpoch: 1, peer: "p" }, { everConnected: true, firstHeardAt: 5_000 })).toMatchObject({ everConnected: true, firstHeardAt: 5_000 })
    })

    it("lastRecvDescAt: applying a description of the peer's stamps it; the refused offer's retry does not; a replace clears it", () => {
      const fresh = initial({ link: "connecting" })
      expect(step(fresh, { type: "description-observed", lane: false, description: "offer", ...at(5_000) }).state.lastRecvDescAt).toBe(5_000)
      expect(step(fresh, { type: "description-observed", lane: true, description: "answer", ...at(5_000) }).state.lastRecvDescAt).toBe(5_000)
      expect(step(fresh, { type: "glare-observed", remoteCarriesVideo: false, lane: true, ...at(5_000) }).state.lastRecvDescAt).toBe(5_000)
      // a new remote session's offer is applied to the fresh connection, and timed there
      const rejoined = step({ ...fresh, lastRecvDescAt: 1_000 }, { type: "description-observed", lane: false, description: "offer", newRemoteSession: { at: 5_000 }, ...at(5_000) }).state
      expect(rejoined).toMatchObject({ connectionEpoch: 2, lastRecvDescAt: 5_000 })
      const applying = { ...fresh, lastRecvDescAt: 1_000, commandEpoch: 1, openCommands: { "set-remote-description": 1 } }
      const retried = step(applying, { type: "command-completed", commandEpoch: 1, commandKind: "set-remote-description", outcome: "rejected", site: "statement-offer-received", reason: "invalid-access", at: 6_000, ...at(6_000) }).state
      expect(retried).toMatchObject({ connectionEpoch: 2, lastRecvDescAt: null })
      expect(step({ ...fresh, lastRecvDescAt: 1_000 }, { type: "network-changed", ...at(7_000) }).state.lastRecvDescAt).toBeNull()
    })

    it("offerSentAt: our statement offer going out stamps it, our lane offer set clears it, a replace clears it", () => {
      const offering = initial({ link: "connecting", commandEpoch: 1, openCommands: { "send-offer": 1 } })
      const sent = step(offering, { type: "command-completed", commandEpoch: 1, commandKind: "send-offer", outcome: "resolved", offer: "sent-statement", ...at(8_000) }).state
      expect(sent.offerSentAt).toBe(8_000)
      // a statement offer that did not go out (stale) starts no wait
      expect(step(offering, { type: "command-completed", commandEpoch: 1, commandKind: "send-offer", outcome: "stale", ...at(8_000) }).state.offerSentAt).toBeNull()
      const lane = { ...sent, commandEpoch: 2, openCommands: { "send-offer": 2 } }
      for (const outcome of ["resolved", "stale", "rejected"] as const) {
        expect(step(lane, { type: "command-completed", commandEpoch: 2, commandKind: "send-offer", outcome, site: "lane", offer: "set-lane", ...at(9_000) }).state.offerSentAt, outcome).toBeNull()
      }
      // a lane offer whose setLocalDescription threw set nothing, and leaves the wait
      expect(step(lane, { type: "command-completed", commandEpoch: 2, commandKind: "send-offer", outcome: "rejected", site: "lane", reason: "other", ...at(9_000) }).state.offerSentAt).toBe(8_000)
      expect(step(sent, { type: "network-changed", ...at(9_000) }).state.offerSentAt).toBeNull()
    })

    it("offerSentAt: the codec guard holds a lane offer that is set, so the answer wait has ended", () => {
      const result = step(initial({ link: "connected", laneOpen: true, offerSentAt: 8_000 }), { type: "codec-guard-rtx", ...at(9_000) })
      expect(result.state.offerSentAt).toBeNull()
      expect(result.commands.map((command) => command.kind)).toEqual(["rollback", "send-offer"])
    })

    it("yieldedAt: the yield's responder-only connection is stamped at the sweep that yielded", () => {
      const waiting = initial({ link: "connecting", offerSentAt: 70_000, everConnected: true, lastSignalAt: 99_000 })
      const yielded = step(waiting, clockOf(tickFacts({ laneOpen: false, haveLocalOffer: true, offerSentAt: 70_000, disconnectedAt: 0 }))).state
      expect(yielded).toMatchObject({ link: "yielded", yieldedAt: 100_000, offerSentAt: null })
    })

    it("lastSignalAt: a stranded re-initiation takes the peer as just heard (heardOnFresh)", () => {
      const refusing = initial({ link: "connecting", initiator: false, commandEpoch: 1, openCommands: { "set-remote-description": 1 }, lastSignalAt: 1_000 })
      const stranded = step(refusing, { type: "command-completed", commandEpoch: 1, commandKind: "set-remote-description", outcome: "rejected", site: "statement-offer-received", reason: "virgin-pc", ...at(9_000) }).state
      expect(stranded).toMatchObject({ connectionEpoch: 2, lastSignalAt: 9_000 })
    })

    // #1458: the runner stamps every completion, so these replaces are timed
    it.each([
      ["stranded-offer-refused", { site: "statement-offer-received", reason: "virgin-pc" }],
      ["offer-refused-rejoin", { site: "statement-offer-received", reason: "invalid-access", at: 9_000 }],
      ["hard-sdp-immediate", { site: "lane", reason: "hard-sdp", roundGeneration: 0 }],
    ] as const)("#1458: the %s replace a completion makes is an attempt at the completion's clock", (cause, stamp) => {
      const before = initial({ link: "connecting", commandEpoch: 1, openCommands: { "set-remote-description": 1 }, lastAttemptAt: 2_000, budgets: { failCount: 1 } as PeerActorState["budgets"] })
      const result = step(before, { type: "command-completed", commandEpoch: 1, commandKind: "set-remote-description", outcome: "rejected", ...stamp, ...at(9_000) })
      expect(result.commands).toContainEqual(expect.objectContaining({ kind: "replace-connection", cause }))
      expect(result.state.lastAttemptAt).toBe(9_000)
      // a trace saved before completions carried a clock keeps the last attempt
      const unclocked = stepPeerActor(before, event({ type: "command-completed", commandEpoch: 1, commandKind: "set-remote-description", outcome: "rejected", ...stamp }))
      expect(unclocked.state.lastAttemptAt).toBe(2_000)
    })

    // A split outage: the
    // media path is dead, signalling works. Every statement answer of the
    // peer's shows it back, which restarts downAt (markBack), so the 8 s
    // away mark re-arms and the loop runs every ~9-12 s for the whole outage.
    // B1 keeps that loop exactly (away-flicker option (a) is a later PR).
    it("keeps the split-outage flicker: a signalling back during an outage restarts downAt, and the away mark re-arms 8 s later", () => {
      const sweepAt = (state: PeerActorState, now: number) => stepPeerActor(state, clockAt(tickFacts({ now, browserConnectionState: "failed", laneOpen: false, canRestartIce: false, away: state.away === "here" ? null : state.away }), state.connectionEpoch))
      let state = step(connected(1_000), { type: "connection-observed", state: "failed", ...at(10_000) }).state
      state = step(state, { type: "peer-heard", at: 10_000, ...at(10_000) }).state
      expect(state.downAt).toBe(10_000)
      const marks: number[] = []
      for (let now = 13_000; now <= 70_000; now += 3_000) {
        // the peer, shown away, answers on the statement wire (signalling still works)
        if (state.away === "timeout") state = step(state, { type: "description-observed", lane: false, description: "answer", ...at(now) }).state
        state = step(state, { type: "peer-heard", at: now, ...at(now) }).state
        const swept = sweepAt(state, now)
        if (swept.commands.some((command) => command.kind === "mark-away")) marks.push(now)
        state = swept.state
      }
      // away at 19 s (down 9 s), back by the answer at 22 s (downAt 22 s), away
      // again at 31 s, back at 34 s ... the loop, every 12 s on a 3 s sweep
      expect(marks).toEqual([19_000, 31_000, 43_000, 55_000, 67_000])
      // the last back, at 70 s, restarted it again; the link itself never came back
      expect(state).toMatchObject({ downAt: 70_000, away: "here", upAt: null })
    })
  })
})

describe("frozen video on a live link (#1917)", () => {
  /** a connected link that showed 131 frames, as the receiver in #1917 did */
  const flowing = (overrides: Partial<PeerActorState> = {}) => initial({ link: "connected", laneOpen: true, framesSeen: 131, framesReadSequence: 0, ...overrides })
  /** one media sweep: frames decoded, packets moving or not, the heal window open or not */
  const read = (state: PeerActorState, readSequence: number, frames: number, packetsMoving: boolean, extra: Partial<Extract<PeerActorEvent, { type: "stats-observed" }>> = {}) =>
    stepPeerActor(state, event({ type: "stats-observed", readSequence, framesDecoded: frames, browserConnectionState: "connected", stallAfter: 2, recoveryDue: true, healDue: true, packetsMoving, cameraLive: true, now: 100_000 + readSequence * 4000, ...extra }, state.connectionEpoch))
  const kinds = (commands: readonly PeerActorCommand[]) => commands.map((command) => command.kind === "restart-ice" || command.kind === "replace-connection" ? `${command.kind}:${command.cause}` : command.kind)

  it("packets rising and frames flat ask for a keyframe and never restart ICE", () => {
    const one = read(flowing(), 1, 131, true)
    expect(one.commands).toEqual([])
    const two = read(one.state, 2, 131, true)
    expect(kinds(two.commands)).toEqual(["ask-keyframe"])
    expect(two.state.frozenAsked).toBe(true)
    expect(two.state.budgets.stallHeals).toBe(0)
    expect(two.state.budgets.failCount).toBe(0)
  })

  it("rebuilds through recover on the next flat sweep after the ask, with no ICE restart first", () => {
    const asked = read(read(flowing(), 1, 131, true).state, 2, 131, true).state
    const rebuilt = read(asked, 3, 131, true)
    expect(kinds(rebuilt.commands)).toEqual(["replace-connection:media-frozen"])
    expect(rebuilt.commands[0]).toMatchObject({ initiate: true, attempt: 1 })
    expect(rebuilt.state.budgets.failCount).toBe(1)
    // a fresh connection starts the episode over
    expect(rebuilt.state).toMatchObject({ frozenAsked: false, frozenSamples: 0, connectionEpoch: 2 })
  })

  it("rebuilds after the ask even when the packets stop too", () => {
    const asked = read(read(flowing(), 1, 131, true).state, 2, 131, true).state
    expect(kinds(read(asked, 3, 131, false).commands)).toEqual(["replace-connection:media-frozen"])
  })

  it("ends the episode when frames rise after the ask: no rebuild", () => {
    const asked = read(read(flowing(), 1, 131, true).state, 2, 131, true).state
    const healed = read(asked, 3, 140, true)
    expect(healed.commands).toEqual([])
    expect(healed.state).toMatchObject({ frozenAsked: false, frozenSamples: 0, framesSeen: 140 })
    // a later freeze is a new episode: a new ask, not a rebuild
    const again = read(read(healed.state, 4, 140, true).state, 5, 140, true)
    expect(kinds(again.commands)).toEqual(["ask-keyframe"])
  })

  it("holds the ask and the rebuild while the heal window is closed (the grace, the backoff)", () => {
    const one = read(flowing(), 1, 131, true, { healDue: false, recoveryDue: false })
    const two = read(one.state, 2, 131, true, { healDue: false, recoveryDue: false })
    expect(two.commands).toEqual([])
    const asked = read(two.state, 3, 131, true)
    expect(kinds(asked.commands)).toEqual(["ask-keyframe"])
    const held = read(asked.state, 4, 131, true, { healDue: false, recoveryDue: false })
    expect(held.commands).toEqual([])
    expect(kinds(read(held.state, 5, 131, true).commands)).toEqual(["replace-connection:media-frozen"])
  })

  it("does not wait for our own camera (there can never be a camera off)", () => {
    const one = read(flowing({ cameraLive: false }), 1, 131, true, { recoveryDue: false, cameraLive: false })
    const two = read(one.state, 2, 131, true, { recoveryDue: false, cameraLive: false })
    expect(kinds(two.commands)).toEqual(["ask-keyframe"])
  })

  it("leaves a dead transport to today's ladder: one sweep with packets flat in the window", () => {
    const one = read(flowing(), 1, 131, true)
    const two = read(one.state, 2, 131, false)
    expect(kinds(two.commands)).toEqual(["restart-ice:media-stall"])
    const flat = read(read(flowing(), 1, 131, false).state, 2, 131, true)
    expect(kinds(flat.commands)).toEqual(["restart-ice:media-stall"])
  })

  it("treats a read with no packet reading as packets flat (older facts, a browser without the counter)", () => {
    const one = read(flowing(), 1, 131, true, { packetsMoving: undefined })
    const two = read(one.state, 2, 131, true, { packetsMoving: undefined })
    expect(kinds(two.commands)).toEqual(["restart-ice:media-stall"])
  })

  it("asks nothing while hidden, away or in standby, and starts the count over", () => {
    for (const held of [{ hidden: true }, { away: "said" as const }, { standby: true }]) {
      const state = flowing({ ...held, stallSamples: 1, frozenSamples: 1 })
      const step = read(state, 1, 131, true)
      expect(step.commands).toEqual([])
      expect(step.ignored).toBe("held")
      expect(step.state).toMatchObject({ stallSamples: 0 })
    }
  })

  it("an answerer asks after two frozen sweeps, and rebuilds only at its sixth (the ask cannot cause the mutual-restart glare)", () => {
    const answerer = (state: PeerActorState, sequence: number) => read(state, sequence, 131, true, { stallAfter: 6, frozenAskAfter: 2 })
    const one = answerer(flowing({ initiator: false }), 1)
    expect(one.commands).toEqual([])
    const two = answerer(one.state, 2)
    expect(kinds(two.commands)).toEqual(["ask-keyframe"])
    let state = two.state
    for (let sequence = 3; sequence <= 5; sequence++) {
      const step = answerer(state, sequence)
      expect(step.commands).toEqual([])
      state = step.state
    }
    expect(kinds(answerer(state, 6).commands)).toEqual(["replace-connection:media-frozen"])
  })

  it("an initiator told to ask after two sweeps still rebuilds on the next flat sweep", () => {
    const initiator = (state: PeerActorState, sequence: number) => read(state, sequence, 131, true, { stallAfter: 2, frozenAskAfter: 2 })
    const asked = initiator(initiator(flowing(), 1).state, 2)
    expect(kinds(asked.commands)).toEqual(["ask-keyframe"])
    expect(kinds(initiator(asked.state, 3).commands)).toEqual(["replace-connection:media-frozen"])
  })

  it("an answerer's dead transport still waits its six sweeps for the ICE restart", () => {
    let state = flowing({ initiator: false })
    for (let sequence = 1; sequence <= 5; sequence++) {
      const step = read(state, sequence, 131, false, { stallAfter: 6, frozenAskAfter: 2 })
      expect(step.commands).toEqual([])
      state = step.state
    }
    expect(kinds(read(state, 6, 131, false, { stallAfter: 6, frozenAskAfter: 2 }).commands)).toEqual(["restart-ice:media-stall"])
  })

  it("without frozenAskAfter (a trace saved before) the ask waits the full stall window", () => {
    let state = flowing({ initiator: false })
    for (let sequence = 1; sequence <= 5; sequence++) {
      const step = read(state, sequence, 131, true, { stallAfter: 6 })
      expect(step.commands).toEqual([])
      state = step.state
    }
    expect(kinds(read(state, 6, 131, true, { stallAfter: 6 }).commands)).toEqual(["ask-keyframe"])
  })

  describe("after code review", () => {
    const asked = () => read(read(flowing(), 1, 131, true).state, 2, 131, true).state

    it("a held sweep ends the episode: after the return a fresh ask, not a rebuild", () => {
      const held = read({ ...asked(), hidden: true }, 3, 131, true)
      expect(held.state).toMatchObject({ frozenAsked: false, frozenSamples: 0, stallSamples: 0 })
      const back = { ...held.state, hidden: false }
      const first = read(back, 4, 131, true)
      expect(first.commands).toEqual([])
      expect(kinds(read(first.state, 5, 131, true).commands)).toEqual(["ask-keyframe"])
    })

    it("hiding the page ends the episode", () => {
      const hidden = stepPeerActor(asked(), event({ type: "visibility-changed", hidden: true }))
      expect(hidden.state).toMatchObject({ frozenAsked: false, frozenSamples: 0 })
      const shown = stepPeerActor(hidden.state, event({ type: "visibility-changed", hidden: false, hiddenForMs: 1000 })).state
      expect(read(shown, 3, 131, true).commands).toEqual([])
    })

    it("a promotion, a lane offer, a lane glare and an unseen ICE restart end the episode too", () => {
      const promoted = stepPeerActor({ ...asked(), standby: true }, event({ type: "standby-changed", standby: false }))
      expect(promoted.state).toMatchObject({ frozenAsked: false, frozenSamples: 0 })
      const offer = stepPeerActor(asked(), event({ type: "description-observed", lane: true, description: "offer" }))
      expect(offer.state).toMatchObject({ frozenAsked: false, frozenSamples: 0 })
      const glare = stepPeerActor(asked(), event({ type: "glare-observed", remoteCarriesVideo: false, polite: false, lane: true }))
      expect(glare.state).toMatchObject({ frozenAsked: false, frozenSamples: 0 })
      const unseen = read(asked(), 3, 131, true, { healDue: false, peerCannotSeeUs: true })
      expect(kinds(unseen.commands)).toEqual(["restart-ice:peer-no-video"])
      expect(unseen.state).toMatchObject({ frozenAsked: false, frozenSamples: 0 })
    })

    it("rebuilds a frozen link at most twice a round; then the frozen path stops until the next round", () => {
      const rebuildOnce = (state: PeerActorState) => {
        let s1 = read(read(state, 1, 131, true).state, 2, 131, true).state
        expect(s1.frozenAsked).toBe(true)
        const rebuilt = read(s1, 3, 131, true)
        expect(kinds(rebuilt.commands)).toEqual(["replace-connection:media-frozen"])
        s1 = rebuilt.state
        // the fresh link connects, shows frames, then freezes again
        return { ...s1, link: "connected" as const, framesSeen: 131, framesReadSequence: 0 }
      }
      const once = rebuildOnce(flowing())
      expect(once.budgets.frozenRebuilds).toBe(1)
      const twice = rebuildOnce({ ...once, connectionEpoch: once.connectionEpoch })
      expect(twice.budgets.frozenRebuilds).toBe(2)
      // spent: no ask, no rebuild, and still no ICE restart on a frozen link
      let state: PeerActorState = twice
      for (let sequence = 1; sequence <= 4; sequence++) {
        const step = stepPeerActor(state, event({ type: "stats-observed", readSequence: sequence, framesDecoded: 131, browserConnectionState: "connected", stallAfter: 2, recoveryDue: true, healDue: true, packetsMoving: true, frozenAskAfter: 2, now: 100_000 + sequence * 4000 }, state.connectionEpoch))
        expect(step.commands).toEqual([])
        state = step.state
      }
      const nextRound = stepPeerActor(state, event({ type: "round-changed", roundGeneration: 1 }, state.connectionEpoch)).state
      expect(nextRound.budgets.frozenRebuilds).toBe(0)
    })
  })
})
