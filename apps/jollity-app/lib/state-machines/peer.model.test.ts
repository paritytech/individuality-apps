// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { runStateMachineSuite } from "./framework"
import { createModelPeerState, stepModelPeer } from "./peer.model"
import {
  peerConnectionInitialStates,
  peerMachineDefinition,
  peerMutationProbes,
  peerRegressionCorpus,
  peerScenarios,
  peerTransitionTable,
  peerWitnesses,
} from "./peer.definition"

const REGIONS = [...peerConnectionInitialStates, "closed"]
const SCENARIOS = 163
const declaredCells = (table: Record<string, Record<string, string>>) =>
  Object.entries(table).flatMap(([state, row]) => Object.entries(row).filter(([, declaration]) => declaration !== "impossible").map(([event, declaration]) => `${state}::${event}::${declaration}`))

describe("WebRTC peer actor definition and independent model", () => {
  it("matches the independent model, invariants, generated sequences and transition coverage", async () => {
    const { coverage } = await runStateMachineSuite(peerMachineDefinition)
    expect(coverage.missing).toEqual([])
    expect(coverage.impossibleObserved).toEqual([])
    expect(coverage.hit).toBe(coverage.declared)
    expect(coverage.generatedSequenceLengths).toMatchObject({ count: 250, min: 0 })
    expect(coverage.generatedSequenceLengths?.max).toBeGreaterThanOrEqual(8)
  })

  it("keys the table by what the actor decides: open or closed, and the fact's type and outcome", () => {
    expect(Object.keys(peerTransitionTable)).toEqual(REGIONS)
    // a closed actor ignores everything; an open one decides from the fact alone
    expect(new Set(Object.values(peerTransitionTable.closed))).toEqual(new Set(["no-op"]))
    expect(declaredCells(peerTransitionTable)).toHaveLength(160)
  })

  it("runs every named scenario in every region", () => {
    const keys = peerScenarios.map((scenario) => scenario.events[0]!.key)
    expect(new Set(keys).size).toBe(keys.length)
    expect(peerScenarios).toHaveLength(SCENARIOS)
    const scenarioName = (witness: { name: string }) => witness.name.slice(witness.name.indexOf(": ") + 2)
    for (const scenario of peerScenarios) {
      const witnesses = peerWitnesses.filter((witness) => scenarioName(witness) === scenario.name)
      expect(witnesses.map((witness) => witness.initial!.real.link), scenario.name).toEqual(REGIONS)
    }
    expect(peerWitnesses).toHaveLength(SCENARIOS * REGIONS.length)
  })

  it("keeps the named legacy regressions in the always-run corpus", () => {
    expect(peerRegressionCorpus.map((entry) => entry.name)).toEqual([
      "#245 a timed-out peer still heard keeps healing",
      "#1163 an unanswered offer yields despite prior failures, once past the backoff",
      "#1163 an unanswered offer waits out the backoff of prior failures",
      "#1163 a yielded connection re-initiates only on its separate wait",
      "#1163 an unanswered offer is held while hidden",
      "#1163 an unanswered offer to a said-away peer is left",
      "#1163 a yielded connection is held while hidden",
      "#1163 a yielded connection to a said-away peer is left",
      "#1163 a yielded connection that took the peer's offer is not re-initiated",
      "#1186 after-video glare rebuilds once",
      "connected channel-never-opened rebuild precedes said-away skip",
      "connected channel-never-opened rebuild is once per round",
      "bare one-way report cannot authorise hard SDP rebuild",
      "resume sweep preserves said-away",
      "said-away hello stays said inside 20 seconds",
      "said-away hello clears strictly after 20 seconds",
      "#1284 session change after timeout-away clears the failure budget",
      "#1284 session change for a present peer keeps the failure budget",
      "a supervisor ICE restart that throws rebuilds instead of failing the connection",
      "a hard lane SDP error rebuilds once, as laneNegotiationFailed does",
      "a stale codec guard closes its offer",
      "a hard SDP error setting the lane answer rebuilds, as laneNegotiationFailed does (#1367's open gap)",
      "the answer on a connection rebuilt for a refused offer is followed by this side's channel",
      "a superseded lane offer is rolled back",
      "a yield unanswered re-initiates with a channel only, the offer being Mesh's own (the stranded-yield divergence)",
      "initiateStrandedPeer's early return: a yielded connection that has a channel is left",
      "a channel that never opened spends the round's no-video rebuild (it was reported as never-connected)",
      "#245 a timed-out peer still heard is marked away and healed in the same sweep",
      "a new signalling session grants no leave unless it was over our offer",
      "a new signalling session rebuilds the answerer as an offerer, as onPeerSession does",
      "#1458 a refused stranded offer's re-initiation is an attempt at the completion's clock",
      "#1458 a hard lane error's immediate rebuild is an attempt at the completion's clock",
      "#1458 a refused offer's rejoin is an attempt at the completion's clock",
      "one failure on a disconnected link with its lane open rebuilds, not a second ICE restart",
      "#1562 a fresh connection of a peer connected before, with no offer out, is rebuilt as an offerer at connectBy",
      "#1562 an ever-connected answerer on a fresh connection is not rebuilt before its connectBy",
      "#1605 a refused answer to our held offer rebuilds as offerer at once, not at connect-by",
      "#1606 the polite side's displaced answer is made again on a fresh responder, not left to the answer wait",
      "#1607 a connected link our unanswered offer holds is rebuilt again for no video in the same round",
    ])
  })

  it("generates alternate initial states for every open link (design B)", () => {
    expect(peerConnectionInitialStates).toEqual([
      "connecting",
      "connected",
      "link-down",
      "yielded",
    ])
  })

  describe("an answerer's stall count when the remote side renegotiates the lane", () => {
    const run = (description: "offer" | "answer") => {
      let state = createModelPeerState({ link: "connected", laneOpen: true, initiator: false })
      let sequence = 0
      const stats = (framesDecoded: number) => {
        const step = stepModelPeer(state, {
          type: "stats-observed", roomEpoch: 1, connectionEpoch: 1, readSequence: ++sequence, framesDecoded,
          browserConnectionState: "connected", stallAfter: 6, recoveryDue: true,
        })
        state = step.state
        return step.commands
      }
      stats(1000); stats(1181)
      for (let i = 0; i < 5; i++) expect(stats(1181)).toEqual([])
      state = stepModelPeer(state, { type: "description-observed", roomEpoch: 1, connectionEpoch: 1, lane: true, description }).state
      return { stats, samples: () => state.stallSamples }
    }

    it("starts over when the initiator's lane offer arrives", () => {
      const { stats, samples } = run("offer")
      expect(samples()).toBe(0)
      for (let i = 0; i < 5; i++) expect(stats(1181)).toEqual([])
      expect(stats(1181).map((command) => command.split("@")[0])).toEqual(["restart-ice:media-stall"])
    })

    it("keeps counting through a remote lane answer", () => {
      const { stats, samples } = run("answer")
      expect(samples()).toBe(5)
      expect(stats(1181).map((command) => command.split("@")[0])).toEqual(["restart-ice:media-stall"])
    })
  })

  describe("a glare on the wire", () => {
    const glare = (lane: boolean) => stepModelPeer(
      createModelPeerState({ link: "connecting", away: "timeout", stallSamples: 3, budgets: { failCount: 3 } as never }),
      { type: "glare-observed", roomEpoch: 1, connectionEpoch: 1, remoteCarriesVideo: false, polite: false, lane },
    )

    it("a statement glare is the peer coming back, and the offer is still ignored", () => {
      const result = glare(false)
      expect(result.state).toMatchObject({ away: "here", stallSamples: 3, budgets: { failCount: 0 } })
      expect(result.commands.map((command) => command.split("@")[0])).toEqual(["ignore-offer"])
    })

    it("a lane glare restarts the stall count and leaves presence and failures alone", () => {
      const result = glare(true)
      expect(result.state).toMatchObject({ away: "timeout", stallSamples: 0, budgets: { failCount: 3 } })
      expect(result.commands.map((command) => command.split("@")[0])).toEqual(["ignore-offer"])
    })
  })

  describe("healing an unseen link waits for an inbound video stat", () => {
    const sweep = (state: ReturnType<typeof createModelPeerState>, framesDecoded: number, readSequence: number) => stepModelPeer(state, {
      type: "stats-observed", roomEpoch: 1, connectionEpoch: 1, readSequence, framesDecoded,
      browserConnectionState: "connected", stallAfter: 2, recoveryDue: true, peerCannotSeeUs: true,
    })

    it("spends nothing while no inbound stat exists, then restarts ICE once one does", () => {
      const waiting = sweep(createModelPeerState({ link: "connected", laneOpen: true, initiator: true }), -1, 1)
      expect(waiting.commands).toEqual([])
      expect(waiting.state.budgets.unseenHeals).toBe(0)
      const healed = sweep(waiting.state, 34, 2)
      expect(healed.commands.map((command) => command.split("@")[0])).toEqual(["restart-ice:peer-no-video"])
    })

    it("heals with frames of zero, which is a stat, not a missing one", () => {
      const result = sweep(createModelPeerState({ link: "connected", laneOpen: true, initiator: true }), 0, 1)
      expect(result.commands.map((command) => command.split("@")[0])).toEqual(["restart-ice:peer-no-video"])
    })

    it("heals an unseen link when the no-video rebuild is already spent this round", () => {
      const spent = createModelPeerState({ link: "connected", laneOpen: true, initiator: true, budgets: { noVideoRebuilds: 1 } as never })
      const result = stepModelPeer(spent, {
        type: "stats-observed", roomEpoch: 1, connectionEpoch: 1, readSequence: 1, framesDecoded: 0,
        browserConnectionState: "connected", noVideoDeadline: true, stallAfter: 2, recoveryDue: true, peerCannotSeeUs: true,
      })
      expect(result.commands.map((command) => command.split("@")[0])).toEqual(["restart-ice:peer-no-video"])
    })

    it("does not count a stall off a missing stat once recovery is due", () => {
      let state = createModelPeerState({ link: "connected", laneOpen: true, initiator: true })
      const stats = (framesDecoded: number, recoveryDue: boolean, readSequence: number) => {
        const step = stepModelPeer(state, {
          type: "stats-observed", roomEpoch: 1, connectionEpoch: 1, readSequence, framesDecoded,
          browserConnectionState: "connected", stallAfter: 2, recoveryDue,
        })
        state = step.state
        return step.commands
      }
      stats(100, false, 1)
      expect(stats(100, false, 2)).toEqual([])
      expect(stats(100, false, 3)).toEqual([])
      expect(stats(-1, true, 4)).toEqual([])
      expect(state.framesReadSequence).toBe(4)
    })

    it("does not rebuild for a hard SDP while no inbound stat exists", () => {
      const waiting = sweep(createModelPeerState({ link: "connected", laneOpen: true, initiator: true, budgets: { negotiationImmediate: 1 } }), -1, 1)
      expect(waiting.commands).toEqual([])
      expect(waiting.state.budgets.negotiationUnseen).toBe(0)
    })
  })

  it("maps every approved peer mutation probe to an executable witness", () => {
    const witnessed = new Set(peerScenarios.flatMap((scenario) => scenario.events.map((event) => event.key)))
    expect(peerMutationProbes.map((probe) => probe.mutation)).toEqual([
      "remove stale connection epoch check",
      "flatten away on a short signal gap",
      "spend watchdog budget while hidden",
      "remove hard-SDP authorisation for one-way rebuild",
      "change strict eight-second resume boundary",
      "reject lower positive replacement counter",
      "exclude timeout-away from supervision",
      "reset peer unseen budget at round change",
      "keep away failure budget across session change",
      "rebuild for a new signalling session in the side's own role",
      "drop the leave a new signalling session over our offer grants",
      "ignore a new remote session on a description",
      "apply a new-session answer to the fresh connection",
      "drop the remote lane offer stall reset",
      "drop the inbound-stat gate on the unseen heal",
      "drop the inbound-stat gate on the unseen hard-SDP rebuild",
      "require positive frames for the unseen heal",
      "reset the stall count on any lane description",
      "fail the connection on any rejected command",
      "fail the connection on an unstamped negotiation rejection",
      "log a supervisor ICE restart that throws",
      "rebuild on a media-stall ICE restart that throws",
      "rebuild on a lane error that is not a hard SDP one",
      "rebuild again with the immediate budget spent",
      "ignore the round a hard lane error began in",
      "treat our statement offer's hard error as a lane one",
      "rebuild a virgin connection as a rejoin",
      "drop the offer re-applied after a rejoin rebuild",
      "keep the away state on a refused offer's rejoin",
      "fail the connection on a stale codec guard",
      "keep the away state on a statement glare",
      "drop the lane glare stall reset",
      "send no answer for an applied remote offer",
      "answer a remote answer",
      "answer a lane offer on the statement wire",
      "forget the rejoin when its offer is applied",
      "log the lane answer's hard SDP error",
      "drop the rejoin's channel after its answer",
      "make the rejoin's channel after a stale answer",
      "keep a superseded lane offer",
      "roll back a superseded offer the connection already left",
      "recover while the page is hidden",
      "restart inside the disconnect grace",
      "restart with the restarts spent",
      "restart ICE over a closed lane",
      "restart ICE without restartIce",
      "ignore the backoff",
      "wait one more millisecond of backoff",
      "double the backoff past twenty seconds",
      "heal a peer who said it left",
      "never mark a peer away",
      "mark away at exactly AWAY_AFTER",
      "mark a timed-out peer away again",
      "mark away a link that was never up",
      "chase a peer gone 45 s",
      "stop chasing at under 45 s",
      "drop the just-dropped chase",
      "offer again after the yield as well",
      "gate the stranded re-initiation on the backoff",
      "re-initiate a yield under 30 s",
      "re-initiate a yielded connection that has a channel",
      "re-initiate a yielded connection that took an offer",
      "wait one more millisecond at connectBy",
      "keep the everConnected gate on connectBy (#1562)",
      "anchor connectBy on the first hello alone",
      "ignore the negotiation quiet",
      "rebuild before the initiator's answer wait",
      "read the never-sent offer as just sent",
      "rebuild an answerer that heard the initiator",
      "yield under 30 s",
      "yield over an open lane",
      "rebuild instead of yielding",
      "rebuild a channel stall under 23 s",
      "rebuild a channel stall twice a round",
      "take a link that showed video for a channel stall",
      "spare a said-away channel stall",
      "rebuild a channel stall inside its backoff",
      "leave the round's no-video rebuild unspent on a channel stall",
      "count no failure on a supervisor recovery",
      "decide the sweep's backoff from Mesh's copies",
      "leave the backoff clock on a supervisor restart",
      "stamp no attempt on a network restart",
      "keep the backoff clock when the peer is back",
      "ask for a keyframe on a kick the page was never away for",
      "keep the failures on a kick the page was never away for",
      "keep the backoff clock on a kick",
      "forgive a said-away peer on its lane answer",
      "forgive a said-away peer on its lane offer",
      "clear the backoff clock on a present peer's connected",
      "reset the stall heals on promotion",
      "keep the failures after a removal",
      "keep the unseen heals after a removal",
      "keep the peer's presence after a removal",
      "drop the round's budgets on a removal",
      "keep the stall count on an unseen restart",
      "reset the stall count on our own lane offer",
      "decide the channel stall from Mesh's no-video copy",
      "ignore our camera's stamp on a sweep",
      "ignore a connection Mesh replaced itself",
      "keep the stall heals across Mesh's own replace",
      "drop the peer's failures on Mesh's own replace",
      "leave the backoff clock on Mesh's own replace",
      "adopt a connection the actor already holds",
      "stay ahead of the connection Mesh holds",
      "replace a connection that negotiated nothing",
      "leave Mesh's away mark on a peer back",
      "leave a timed-out peer away after a long absence",
    ])
    expect(peerMutationProbes.every((probe) => witnessed.has(probe.witness))).toBe(true)
    expect(peerMutationProbes.filter((probe) => !probe.detected()).map((probe) => probe.mutation)).toEqual([])
  })
})
