// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Step 4.3 stage 3b, steps 2 and 3, with the peer actor driving (step 9;
 * until then these were shadow comparisons): the answer to a remote offer and
 * the rollback of a superseded lane offer are commands the actor issues and
 * Mesh performs. Each scenario runs the real Mesh on the fake
 * RTCPeerConnection.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { encodeChannelMessage, encodePeerConnectionSignal, USE_CASE_RENEGOTIATION } from "@jollity/statement-core"
import type { PeerActorEvent } from "../state-machines/peer-actor"
import { actorEvents, FakeChannel, FakePC, sdp, setupMesh } from "./test-pc"

const sendLane = (pc: FakePC, tag: "Offer" | "Answer", value: string) => {
  const frame = encodeChannelMessage({ id: USE_CASE_RENEGOTIATION, data: encodePeerConnectionSignal({ tag, value }) })
  ;(pc.channels[0]!.onmessage as (event: { data: unknown }) => void)({ data: new Uint8Array(frame).buffer })
}
const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }

type Inputs = readonly { peer: string; event: PeerActorEvent }[]

async function driven(myId: string, peerId: string, opts: Record<string, unknown> = {}) {
  const made = await setupMesh(myId, peerId, {
    decisionRoom: "g7",
    decisionRoomEpoch: 3,
    ...opts,
  })
  /** the events the actor stepped on, completions included */
  return { ...made, inputs: actorEvents(made.mesh) }
}

const answerCompletions = (inputs: Inputs) =>
  inputs.flatMap(({ event }) => event.type === "command-completed" && event.commandKind === "send-answer" ? [event.outcome] : [])

const answersSent = (signals: readonly unknown[]) =>
  signals.filter((signal) => (signal as { rtc?: { desc?: { type?: string } } }).rtc?.desc?.type === "answer").length

/** the answerer of the pair, with the lane open */
async function laneAnswerer() {
  const made = await driven("b", "a")
  made.mesh.setRound(1)
  const channel = new FakeChannel()
  channel.readyState = "open"
  made.pc.channels.push(channel)
  ;(made.pc.ondatachannel as (event: { channel: FakeChannel }) => void)({ channel })
  return made
}

describe("the peer actor answers remote offers and rolls back superseded lane offers", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(console, "log").mockImplementation(() => {})
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  describe("a statement offer (answerOffer)", () => {
    it("sends the answer the actor issued, and lands its completion on it", async () => {
      const { mesh, signals, inputs } = await driven("b", "a")
      await mesh.onRtc("a", { rtc: { desc: { type: "offer", sdp: sdp("remote-1") } } })
      await settle()
      expect(answersSent(signals)).toBe(1)
      expect(answerCompletions(inputs)).toEqual(["resolved"])
      mesh.close()
    })

    it("closes the actor's answer as rejected when the signal call throws", async () => {
      const { mesh, signals, inputs } = await driven("b", "a")
      signals.push = () => { throw new Error("transport refused") }
      await mesh.onRtc("a", { rtc: { desc: { type: "offer", sdp: sdp("remote-1") } } })
      await settle()
      expect(answerCompletions(inputs)).toEqual(["rejected"])
      mesh.close()
    })

    it("makes no rejoin channel when the rejoin's answer cannot be signalled", async () => {
      const { mesh, pc, signals, inputs } = await driven("b", "a")
      await mesh.onRtc("a", { rtc: { desc: { type: "offer", sdp: sdp("remote-1", { media: ["video"] }) } } })
      await settle()
      expect(pc.remoteDescription).not.toBeNull()
      signals.push = () => { throw new Error("transport refused") }
      // same session, fewer m-lines than were negotiated: refused with InvalidAccessError
      await mesh.onRtc("a", { rtc: { desc: { type: "offer", sdp: sdp("remote-1") } } })
      await settle()
      expect(FakePC.last).toHaveLength(2)
      expect(FakePC.last[1]!.channels).toHaveLength(0)
      expect(answerCompletions(inputs).at(-1)).toBe("rejected")
      mesh.close()
    })

    it("closes the answer as stale when a self-heal replaced the connection during the gather", async () => {
      const { mesh, pc, signals, inputs } = await driven("b", "a")
      pc.iceGatheringState = "gathering"
      const answering = mesh.onRtc("a", { rtc: { desc: { type: "offer", sdp: sdp("remote-1") } } })
      await settle()
      mesh.networkChanged() // the lane is not open: the connection is rebuilt
      expect(FakePC.last).toHaveLength(2)
      pc.iceGatheringState = "complete"
      pc.dispatch("icegatheringstatechange")
      await answering
      await settle()
      expect(answersSent(signals)).toBe(0)
      expect(answerCompletions(inputs)).toEqual(["stale"])
      mesh.close()
    })

    it("closes the older answer as stale when a newer offer was applied during its gather, and sends the newer one", async () => {
      const { mesh, pc, signals, inputs } = await driven("b", "a")
      pc.iceGatheringState = "gathering"
      const first = mesh.onRtc("a", { rtc: { desc: { type: "offer", sdp: sdp("remote-1") } } })
      await settle()
      const second = mesh.onRtc("a", { rtc: { desc: { type: "offer", sdp: sdp("remote-1", { ufrag: "u2" }) } } })
      await settle()
      pc.iceGatheringState = "complete"
      pc.dispatch("icegatheringstatechange")
      await Promise.all([first, second])
      await settle()
      expect(answersSent(signals)).toBe(1)
      expect(answerCompletions(inputs)).toEqual(["stale", "resolved"])
      // the bail is the older answer's, the send the newer one's
      const [older, newer] = inputs.flatMap(({ event }) => event.type === "command-completed" && event.commandKind === "send-answer" ? [event.commandEpoch] : [])
      expect(older).toBeLessThan(newer!)
      mesh.close()
    })

    it("game 1559: two offers applied before either answer leave one actor answer, and the older bail never lands on it", async () => {
      const { mesh, pc, signals, inputs } = await driven("b", "a")
      pc.iceGatheringState = "gathering"
      // the second offer is applied once the first run has set its answer, as
      // in the live game (~12-24 ms apart)
      let applySecond!: () => void
      const firstAnswerSet = new Promise<void>((resolve) => { applySecond = resolve })
      const setRemote = pc.setRemoteDescription.bind(pc)
      vi.spyOn(pc, "setRemoteDescription")
        .mockImplementationOnce(setRemote)
        .mockImplementationOnce(async (desc) => { await firstAnswerSet; return setRemote(desc) })
      const setLocal = pc.setLocalDescription.bind(pc)
      vi.spyOn(pc, "setLocalDescription").mockImplementationOnce(async (desc) => { await setLocal(desc); applySecond() })
      const first = mesh.onRtc("a", { rtc: { desc: { type: "offer", sdp: sdp("remote-1") } } })
      const second = mesh.onRtc("a", { rtc: { desc: { type: "offer", sdp: sdp("remote-1", { ufrag: "u2" }) } } })
      // both offers applied before either gather ends (the actor's program
      // takes a few more microtasks to apply the second than legacy did)
      await settle()
      await settle()
      expect((mesh as unknown as { conns: Map<string, { offersApplied: number }> }).conns.get("a")!.offersApplied).toBe(2)
      pc.iceGatheringState = "complete"
      pc.dispatch("icegatheringstatechange")
      await Promise.all([first, second])
      await settle()
      expect(answersSent(signals)).toBe(1)
      // A description waits for the peer's offer being answered (games
      // 1565/1571/1575): the second offer is observed once the first answer's
      // setLocalDescription resolved, not before either is applied. So the
      // older answer bails and the newer sends, each closing its own
      // send-answer, as in the test above.
      expect(answerCompletions(inputs)).toEqual(["stale", "resolved"])
      mesh.close()
    })

    it("after an offer refused with InvalidAccessError, answers on the rebuilt responder, then makes its channel and offers", async () => {
      const { mesh, pc, signals, inputs } = await driven("b", "a")
      await mesh.onRtc("a", { rtc: { desc: { type: "offer", sdp: sdp("remote-1", { media: ["video"] }) } } })
      await settle()
      expect(pc.remoteDescription).not.toBeNull()
      signals.length = 0
      // same session, fewer m-lines than were negotiated: refused as Chrome does
      await mesh.onRtc("a", { rtc: { desc: { type: "offer", sdp: sdp("remote-1") } } })
      await settle()
      const fresh = FakePC.last[1]!
      expect(fresh.channels).toHaveLength(1)
      expect(signals.map((signal) => (signal as { rtc: { desc: { type: string } } }).rtc.desc.type)).toEqual(["answer", "offer"])
      // the refusal is invalid-access, and the same offer's retry on the
      // rebuilt responder resolves (the reachability witness's row 33): the
      // retry site is never reached, so the refusal is classified once
      const applied = inputs.flatMap(({ event }) => event.type === "command-completed" && event.commandKind === "set-remote-description" ? [event] : [])
      expect(applied, "row 33: the refused offer is invalid-access, and its retry on the fresh responder resolves").toEqual([
        expect.objectContaining({ outcome: "resolved", connectionEpoch: 1 }),
        expect.objectContaining({ outcome: "rejected", site: "statement-offer-received", reason: "invalid-access", connectionEpoch: 1 }),
        expect.objectContaining({ outcome: "resolved", connectionEpoch: 2 }),
      ])
      mesh.close()
    })
  })

  describe("a lane offer (onLane)", () => {
    it("sends the lane answer the actor issued", async () => {
      const { mesh, pc, inputs } = await laneAnswerer()
      sendLane(pc, "Offer", sdp("111", { media: ["video"] }))
      await settle()
      expect(pc.channels[0]!.send).toHaveBeenCalled()
      expect(answerCompletions(inputs)).toEqual(["resolved"])
      mesh.close()
    })

    it("lands a throw from the lane send as a rejected answer, which follows the lane rule", async () => {
      const { mesh, pc, inputs } = await laneAnswerer()
      const channel = pc.channels[0]!
      let state = channel.readyState
      // the send itself throws: sendLane's read of the channel state fails
      Object.defineProperty(channel, "readyState", {
        get: () => { if (new Error().stack?.includes("Mesh.sendLane")) throw new DOMException("send refused", "InvalidStateError"); return state },
        set: (value: string) => { state = value },
      })
      sendLane(pc, "Offer", sdp("111", { media: ["video"] }))
      await settle()
      expect(answerCompletions(inputs)).toEqual(["rejected"])
      expect(FakePC.last).toHaveLength(2) // the actor's lane rule rebuilt
      mesh.close()
    })

    it("does not count the lane answer as sent when the channel closed before the send", async () => {
      const { mesh, pc, inputs } = await laneAnswerer()
      const setLocal = pc.setLocalDescription.bind(pc)
      vi.spyOn(pc, "setLocalDescription").mockImplementationOnce(async (desc) => {
        await setLocal(desc)
        pc.channels[0]!.readyState = "closing"
      })
      sendLane(pc, "Offer", sdp("111", { media: ["video"] }))
      await settle()
      expect(pc.channels[0]!.send).not.toHaveBeenCalled()
      expect(answerCompletions(inputs)).toEqual(["stale"])
      mesh.close()
    })

    it("rebuilds once on a hard SDP error setting the lane answer, as the actor decides (#1367's open gap)", async () => {
      const { mesh, pc, inputs } = await laneAnswerer()
      vi.spyOn(pc, "setLocalDescription").mockRejectedValueOnce(new DOMException("answer refused", "InvalidStateError"))
      sendLane(pc, "Offer", sdp("111", { media: ["video"] }))
      await settle()
      expect(FakePC.last).toHaveLength(2)
      expect(answerCompletions(inputs)).toEqual(["rejected"])
      mesh.close()
    })

    it("only logs a lane answer whose local description fails with an error that is not a hard SDP one", async () => {
      const { mesh, pc } = await laneAnswerer()
      vi.spyOn(pc, "setLocalDescription").mockRejectedValueOnce(new Error("transient"))
      sendLane(pc, "Offer", sdp("111", { media: ["video"] }))
      await settle()
      expect(FakePC.last).toHaveLength(1)
      mesh.close()
    })
  })
})
