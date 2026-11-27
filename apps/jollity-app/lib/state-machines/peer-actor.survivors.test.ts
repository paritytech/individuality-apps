// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { createPeerActorState, stepPeerActor, type PeerActorEvent, type PeerActorState } from "./peer-actor"
import { clockOf, timesOf, withTimes, type SupervisorTickFacts } from "./peer-actor.test-helper"
import { tickFacts } from "./peer.definition"

/**
 * Guards of the peer actor that a mutation run (StrykerJS on peer-actor.ts)
 * found no test depending on. Each test names the behaviour it pins; the
 * comment above it names the guard.
 */

const initial = (overrides: Partial<PeerActorState> = {}) => {
  const state = createPeerActorState({ game: 1, roomEpoch: 1, peer: "peer" })
  return withTimes({ ...state, ...overrides, scope: { ...state.scope, ...overrides.scope }, budgets: { ...state.budgets, ...overrides.budgets } })
}
const budgets = (value: Partial<PeerActorState["budgets"]>) => value as PeerActorState["budgets"]

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
/** connected 23 s with no channel open and no video */
const stalledChannel: Partial<SupervisorTickFacts> = { browserConnectionState: "connected", laneOpen: false, framesSeen: 0, upAt: 77_000, downAt: 0, disconnectedAt: 0 }

const stats = (value: Partial<Extract<PeerActorEvent, { type: "stats-observed" }>> = {}) =>
  event({ type: "stats-observed", readSequence: 2, framesDecoded: 5, browserConnectionState: "connected", ...value })

/** A connected link carrying video: five frames seen, the first read taken. */
const watching = (overrides: Partial<PeerActorState> = {}) => initial({ link: "connected", laneOpen: true, framesSeen: 5, framesReadSequence: 1, ...overrides })

describe("peer actor guards found untested by mutation testing", () => {
  describe("the supervisor's decision (decideSupervisor)", () => {
    // line 254: framesSeen === 0
    it("does not rebuild a connected link for a never-opened channel once video frames were decoded", () => {
      const result = sweep(initial({ link: "connected" }), tick({ ...stalledChannel, framesSeen: 5 }))
      expect(result).toMatchObject({ commands: [], ignored: "idle" })
      // the same link with no frames decoded is rebuilt, so the guard is the frames
      const none = sweep(initial({ link: "connected" }), tick(stalledChannel))
      expect(none.commands).toEqual([expect.objectContaining({ kind: "replace-connection", cause: "channel-never-opened" })])
    })

    // line 257: actor.downAt !== null (legacy's downAt > 0)
    it("does not mark away a peer whose link never dropped", () => {
      const result = sweep(initial({ link: "link-down" }), tick({ browserConnectionState: "disconnected", downAt: 0, disconnectedAt: 0 }))
      expect(result).toMatchObject({ commands: [], ignored: "idle" })
    })

    // line 261: justDropped needs a drop (a downAt)
    it("chases a silent peer only when its link dropped: no drop, no chase before the hello", () => {
      // 5 s into the clock (inside the 30 s drop-chase window), the peer silent, the link failed but never dropped
      const result = sweep(initial({ link: "link-down" }), tick({ now: 5_000, browserConnectionState: "failed", lastSignalAt: null, downAt: 0, disconnectedAt: 0 }))
      expect(result).toMatchObject({ commands: [], ignored: "idle" })
      // a drop 1 s ago is chased even though the peer is silent
      const dropped = sweep(initial({ link: "link-down" }), tick({ now: 5_000, browserConnectionState: "failed", lastSignalAt: null, downAt: 4_000, disconnectedAt: 4_000 }))
      expect(dropped.commands).toEqual([expect.objectContaining({ kind: "replace-connection", cause: "failed" })])
    })

    // line 275: state === "disconnected"
    it("applies the disconnect grace only to a disconnected link, not to one still connecting", () => {
      const result = sweep(initial({ link: "connecting" }), tick({ browserConnectionState: "connecting", disconnectedAt: 90_000 }))
      expect(result).toMatchObject({ commands: [], ignored: "idle" })
      // disconnected for the same time is acted on
      const disconnected = sweep(initial({ link: "link-down" }), tick({ browserConnectionState: "disconnected", disconnectedAt: 90_000 }))
      expect(disconnected.commands).toEqual([expect.objectContaining({ kind: "restart-ice" })])
    })
  })

  describe("a fresh actor", () => {
    // line 405: rejoinAnswer: false
    it("starts with no rejoin answer pending, so a first answer is not followed by this side's own offer", () => {
      expect(createPeerActorState({ game: 1, roomEpoch: 1, peer: "peer" }).rejoinAnswer).toBe(false)
      const answering = initial({ openCommands: { "send-answer": 1 }, commandEpoch: 1 })
      const done = stepPeerActor(answering, event({ type: "command-completed", commandEpoch: 1, commandKind: "send-answer", outcome: "resolved" }))
      expect(done.commands).toEqual([])
    })
  })

  describe("stale-connection guard", () => {
    // line 433: event.type !== "round-changed"
    it("applies a round change that carries an older connection epoch, since the round outlives the connection", () => {
      const spent = initial({ connectionEpoch: 3, roundGeneration: 1, budgets: budgets({ noVideoRebuilds: 1, negotiationImmediate: 1 }) })
      const result = stepPeerActor(spent, event({ type: "round-changed", roundGeneration: 2 }, 2))
      expect(result.ignored).toBeUndefined()
      expect(result.state).toMatchObject({ roundGeneration: 2, budgets: { noVideoRebuilds: 0, negotiationImmediate: 0 } })
    })
  })

  describe("post-design-B decision survivors", () => {
    // mutant 429, line 535: removing the no-grace connecting/new fast path
    it.each([["connecting"], ["new"]] as const)("keeps the exact actor state when the browser is merely %s and no disconnect grace is running", (reported) => {
      const before = initial({ link: "connected", disconnectedAt: null })
      const result = stepPeerActor(before, event({ type: "connection-observed", state: reported }))
      expect(result.state).toBe(before)
      expect(result.commands).toEqual([])
    })

    // mutant 540, line 643: a repeated back fact must forgive even after another fact brought the peer here
    it("forgives a repeated back fact while the actor already reads the peer here", () => {
      const result = stepPeerActor(
        initial({ away: "here", lastAttemptAt: 5_000, budgets: budgets({ failCount: 3 }) }),
        event({ type: "peer-away", away: "back" }),
      )
      expect(result.state).toMatchObject({ lastAttemptAt: null, budgets: { failCount: 0 } })
      expect(result.commands).toEqual([expect.objectContaining({ kind: "mark-back" })])
    })

    // mutant 589, line 671: a lane description never starts a statement-session rebuild
    it("applies a lane answer from a new remote session without rebuilding the connection", () => {
      const result = stepPeerActor(initial(), event({
        type: "description-observed",
        lane: true,
        description: "answer",
        newRemoteSession: { at: 4_000 },
      }))
      expect(result.state.connectionEpoch).toBe(1)
      expect(result.commands).toEqual([expect.objectContaining({ kind: "set-remote-description", lane: true })])
    })

    // mutant 673, line 726: failed is not the start of disconnected grace
    it("does not stamp disconnected grace for a failed browser state", () => {
      const result = stepPeerActor(
        initial({ link: "connected", everConnected: true, disconnectedAt: null, downAt: null }),
        event({ type: "connection-observed", state: "failed", now: 5_000 }),
      )
      expect(result.state).toMatchObject({ link: "link-down", disconnectedAt: null, downAt: 5_000 })
    })

    // mutant 755, line 778: statement glare is ignored; only lane glare rolls back
    it("ignores a polite statement glare instead of running the lane rollback path", () => {
      const result = stepPeerActor(initial(), event({ type: "glare-observed", lane: false, polite: true, remoteCarriesVideo: false }))
      expect(result.commands).toEqual([expect.objectContaining({ kind: "ignore-offer" })])
    })

    // mutant 814, line 799: a held sample with a changed camera fact still has to copy it
    it("copies a held stats state when the camera-live fact changes", () => {
      const before = watching({ away: "timeout", cameraLive: false, stallSamples: 0 })
      const result = stepPeerActor(before, stats({ framesDecoded: 5, cameraLive: true }))
      expect(result.state).not.toBe(before)
      expect(result.state.cameraLive).toBe(true)
      expect(result.state.stallSamples).toBe(0)
      expect(result.ignored).toBe("held")
    })

    // mutants 864/866, line 823: zero prior frames do not accumulate a stall
    it("does not count a zero-frame stream as stalled before it has ever decoded a frame", () => {
      const result = stepPeerActor(watching({ framesSeen: 0, stallSamples: 0 }), stats({ framesDecoded: 0, recoveryDue: true, stallAfter: 1 }))
      expect(result.state).toMatchObject({ framesSeen: 0, stallSamples: 0, budgets: { stallHeals: 0 } })
      expect(result.commands).toEqual([])
    })

    // mutants 914/916, line 844: one unseen heal exhausts the budget (#1523 F5)
    it("does not issue a second unseen ICE restart", () => {
      const result = stepPeerActor(
        watching({ budgets: budgets({ unseenHeals: 1 }) }),
        stats({ framesDecoded: 6, peerCannotSeeUs: true }),
      )
      expect(result.state.budgets.unseenHeals).toBe(1)
      expect(result.commands).toEqual([])
    })

    // mutant 956, line 872: entering standby does not reset a pending stall count
    it("keeps the stall count when a peer enters standby", () => {
      const result = stepPeerActor(watching({ stallSamples: 2 }), event({ type: "standby-changed", standby: true }))
      expect(result.state.stallSamples).toBe(2)
      expect(result.commands).toEqual([expect.objectContaining({ kind: "replace-video-track", track: null })])
    })

    // mutant 1096, line 943: only set-remote-description takes the refusal recovery path
    it("does not treat another rejected statement-offer command as a refused remote description", () => {
      const before = initial({
        commandEpoch: 1,
        openCommands: { "send-answer": 1 },
      })
      const result = stepPeerActor(before, event({
        type: "command-completed",
        commandEpoch: 1,
        commandKind: "send-answer",
        outcome: "rejected",
        site: "statement-offer-received",
        reason: "invalid-access",
      }))
      expect(result.state.connectionEpoch).toBe(1)
      expect(result.commands).toEqual([])
    })
  })

  describe("peer-heard", () => {
    // line 549: forgive()
    it("forgives the failures and the last attempt when an away peer is heard after more than 20 s", () => {
      const away = initial({ away: "timeout", lastSignalAt: 1_000, lastAttemptAt: 5_000, budgets: budgets({ failCount: 3 }) })
      const result = stepPeerActor(away, event({ type: "peer-heard", at: 21_001 }))
      expect(result.state).toMatchObject({ away: "here", lastSignalAt: 21_001, lastAttemptAt: null, budgets: { failCount: 0 } })
    })
  })

  describe("peer-away", () => {
    // line 559: event.away === "back"
    it.each([["said"], ["timeout"]] as const)("issues no mark-back when the peer is %s, even if Mesh holds a mark", (away) => {
      const result = stepPeerActor(initial(), event({ type: "peer-away", away }))
      expect(result.commands).toEqual([])
      expect(result.state.away).toBe(away)
      // and "back" with the mark does issue it
      const back = stepPeerActor(initial({ away }), event({ type: "peer-away", away: "back" }))
      expect(back.commands).toEqual([expect.objectContaining({ kind: "mark-back" })])
    })
  })

  describe("description-observed", () => {
    // line 562: !event.accepted || event.departedSession
    it("ignores a description of a departed session and changes nothing", () => {
      const before = initial({ link: "connecting", away: "timeout", budgets: budgets({ failCount: 2 }) })
      const result = stepPeerActor(before, event({ type: "description-observed", lane: false, description: "offer", departedSession: true }))
      expect(result).toEqual({ state: before, commands: [], ignored: "departed-session" })
    })
  })

  describe("connection-observed", () => {
    // line 601: event.state === "connected"
    it.each([["failed"], ["disconnected"]] as const)("a %s report is a link down: it keeps the failures and the away mark", (reported) => {
      const before = initial({ link: "connected", away: "timeout", budgets: budgets({ failCount: 3 }) })
      const result = stepPeerActor(before, event({ type: "connection-observed", state: reported }))
      expect(result.state).toMatchObject({ link: "link-down", away: "timeout", budgets: { failCount: 3 } })
    })
  })

  describe("channel-observed", () => {
    // lines 611 and 612: state === "open" and if (state.laneOpen)
    it("a channel opens and closes the lane and leaves the link as it was (design B: only the browser's link facts move it)", () => {
      const before = initial({ link: "link-down", laneOpen: true })
      const result = stepPeerActor(before, event({ type: "channel-observed", state: "closed" }))
      expect(result.state).toMatchObject({ laneOpen: false, link: "link-down" })
      const open = stepPeerActor(initial({ link: "link-down" }), event({ type: "channel-observed", state: "open" }))
      expect(open.state).toMatchObject({ laneOpen: true, link: "link-down" })
    })
  })

  describe("glare-observed", () => {
    // line 659: state.away !== "here"
    it("a statement glare from a peer already here keeps the failures and the last attempt", () => {
      const here = initial({ link: "connecting", lastAttemptAt: 5_000, budgets: budgets({ failCount: 3 }) })
      const result = stepPeerActor(here, event({ type: "glare-observed", remoteCarriesVideo: false, polite: false, lane: false }))
      expect(result.state).toMatchObject({ away: "here", lastAttemptAt: 5_000, budgets: { failCount: 3 } })
    })
  })

  describe("local-offer-superseded", () => {
    // line 682: if (state.laneOpen)
    it("rolls back a superseded offer and leaves the link where the browser put it, lane open or not (design B: the link moves only on the browser's word)", () => {
      const result = stepPeerActor(initial({ link: "connecting", laneOpen: false }), event({ type: "local-offer-superseded", haveLocalOffer: true }))
      expect(result.state.link).toBe("connecting")
      expect(result.commands).toEqual([expect.objectContaining({ kind: "rollback", cause: "superseded" })])
      const open = stepPeerActor(initial({ link: "connecting", laneOpen: true }), event({ type: "local-offer-superseded", haveLocalOffer: true }))
      expect(open.state.link).toBe("connecting")
    })
  })

  describe("stats-observed", () => {
    // line 687: state.away !== "here"
    it.each([["timeout"], ["said"]] as const)("holds a stalled stats sample while the peer is %s: no restart, nothing changes", (away) => {
      const before = watching({ away, stallSamples: 2 })
      const result = stepPeerActor(before, stats({ framesDecoded: 5, recoveryDue: true, stallAfter: 1 }))
      expect(result.commands).toEqual([])
      expect(result.ignored).toBe("held")
      expect(result.state).toMatchObject({ stallSamples: 0, budgets: { stallHeals: 0 } })
    })

    // line 692: readSequence < framesReadSequence
    it("takes a read whose sequence equals the last taken one, and ignores only an older one", () => {
      const equal = stepPeerActor(watching({ framesReadSequence: 4 }), stats({ readSequence: 4, framesDecoded: 9 }))
      expect(equal.ignored).toBeUndefined()
      expect(equal.state).toMatchObject({ framesSeen: 9, framesReadSequence: 4 })
      const first = stepPeerActor(initial({ link: "connected", laneOpen: true }), stats({ readSequence: 0, framesDecoded: 3 }))
      expect(first.state.framesSeen).toBe(3)
      const older = stepPeerActor(watching({ framesReadSequence: 4 }), stats({ readSequence: 3, framesDecoded: 9 }))
      expect(older).toMatchObject({ commands: [], ignored: "stale-command" })
    })

    // line 693: event.framesDecoded <= 0
    it("does not rebuild at the no-video deadline once frames decode", () => {
      const result = stepPeerActor(watching(), stats({ framesDecoded: 6, noVideoDeadline: true }))
      expect(result.commands).toEqual([])
      expect(result.state.budgets.noVideoRebuilds).toBe(0)
      // with no frames decoded the deadline rebuilds, once
      const none = stepPeerActor(initial({ link: "connected", laneOpen: true }), stats({ readSequence: 1, framesDecoded: 0, noVideoDeadline: true }))
      expect(none.commands).toEqual([expect.objectContaining({ kind: "replace-connection", cause: "connected-no-video" })])
      expect(none.state.budgets.noVideoRebuilds).toBe(1)
    })

    // line 710: framesDecoded > 0 and >= 0 (the two mutants are one behaviour)
    it("counts a stream that falls to zero frames as a stall, not as progress, and heals it", () => {
      let state = watching({ framesSeen: 100, framesReadSequence: 1 })
      const commands: string[] = []
      for (const readSequence of [2, 3, 4]) {
        const step = stepPeerActor(state, stats({ readSequence, framesDecoded: 0, stallAfter: 3, recoveryDue: true }))
        state = step.state
        commands.push(...step.commands.map((command) => command.kind))
        // the stall count grows while the third sample heals and starts it over
        expect(state.framesSeen).toBe(100)
        expect(state.stallSamples).toBe(readSequence === 4 ? 0 : readSequence - 1)
      }
      expect(commands).toEqual(["restart-ice"])
      expect(state.budgets.stallHeals).toBe(1)
    })

    it("counts a positive lower counter as progress and resets the stall count", () => {
      const result = stepPeerActor(watching({ framesSeen: 100, stallSamples: 2 }), stats({ readSequence: 2, framesDecoded: 5, stallAfter: 3, recoveryDue: true }))
      expect(result.state).toMatchObject({ framesSeen: 5, stallSamples: 0 })
      expect(result.commands).toEqual([])
    })

    // line 731: state.budgets.negotiationUnseen === 0
    it("when the round's hard-SDP unseen rebuild is spent, an unseen peer gets an ICE restart instead of a second rebuild", () => {
      const spent = watching({ budgets: budgets({ negotiationImmediate: 1, negotiationUnseen: 1 }) })
      const result = stepPeerActor(spent, stats({ framesDecoded: 6, peerCannotSeeUs: true }))
      expect(result.commands).toEqual([expect.objectContaining({ kind: "restart-ice", cause: "peer-no-video" })])
      expect(result.state).toMatchObject({ connectionEpoch: 1, budgets: { negotiationUnseen: 1, unseenHeals: 1 } })
    })
  })

  describe("round-changed", () => {
    // line 778: roundGeneration <= current, in both mutants (false, and <)
    it.each([[2], [1]])("ignores generation %s when the actor is already at 2, and keeps the round's spent budgets", (generation) => {
      const spent = initial({ roundGeneration: 2, budgets: budgets({ noVideoRebuilds: 1, negotiationImmediate: 1, negotiationUnseen: 1, glareRebuilds: 1 }) })
      const result = stepPeerActor(spent, event({ type: "round-changed", roundGeneration: generation }))
      expect(result).toEqual({ state: spent, commands: [], ignored: "stale-command" })
    })
  })

  describe("command-completed", () => {
    // line 798: commandKind === "send-answer"
    it("the rejoin answer waits for the answer: another command kind completing does not consume it", () => {
      const rejoining = initial({ rejoinAnswer: true, commandEpoch: 3, openCommands: { "send-offer": 3, "send-answer": 2 } })
      const other = stepPeerActor(rejoining, event({ type: "command-completed", commandEpoch: 3, commandKind: "send-offer", outcome: "resolved" }))
      expect(other.commands).toEqual([])
      expect(other.state.rejoinAnswer).toBe(true)
      // the answer itself completes the rejoin with this side's own channel
      const answer = stepPeerActor(other.state, event({ type: "command-completed", commandEpoch: 2, commandKind: "send-answer", outcome: "resolved" }))
      expect(answer.commands).toEqual([expect.objectContaining({ kind: "create-channel" })])
      expect(answer.state.rejoinAnswer).toBe(false)
    })
  })
})
