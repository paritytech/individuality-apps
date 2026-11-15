// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Three links that sat dark until a long timer, now rebuilt at once, on the
 * real Mesh over the fake RTCPeerConnection. Each case has its negative
 * control: the healthy shape next to it does not rebuild.
 *
 * - #1605: the peer's answer is refused while our offer still holds the
 *   connection (the explorer's half-open leaf; nightly 41143999937's "Failed
 *   to set SSL role"). Before: connect-by, about 20 s later.
 * - #1606: the polite side's answer is displaced by its own offer, which the
 *   impolite peer ignores (the explorer's ice-failed leaf). Before: the
 *   answer wait, about 30 s.
 * - #1607: a connected link with its lane open, our offer unanswered and no
 *   video, after the round's no-video rebuild was spent (g284). Before:
 *   nothing until ICE failed, 47 s.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { PeerActorCommand } from "../state-machines/peer-actor"
import { FakePC, sdp, setupMesh } from "./test-pc"

const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }
const offer = (body: string, gen?: string) => ({ rtc: { desc: { type: "offer", sdp: body }, ...(gen ? { gen } : {}) } }) as never
const answer = (body: string) => ({ rtc: { desc: { type: "answer", sdp: body } } }) as never
const descriptions = (signals: unknown[]) => signals.flatMap((signal) => {
  const rtc = (signal as { rtc?: { desc?: { type: string }; gen?: string } }).rtc
  return rtc?.desc ? [{ type: rtc.desc.type, gen: rtc.gen }] : []
})
const state = (pc: FakePC, value: RTCPeerConnectionState) => {
  pc.connectionState = value
  pc.onconnectionstatechange!()
}
const openOwnChannel = (pc: FakePC) => {
  const channel = pc.channels[0]!
  channel.readyState = "open"
  ;(channel.onopen as () => void)()
}

type Internals = {
  conns: Map<string, { offersApplied: number }>
  executePeerCommand(peerId: string, command: PeerActorCommand): unknown
}

/** A Mesh for `myId` with `peerId` added; `rebuilds()` lists the actor's replace causes. */
async function driven(myId: string, peerId: string, local?: unknown) {
  const made = await setupMesh(myId, peerId, {}, local)
  const internals = made.mesh as unknown as Internals
  const commands: PeerActorCommand[] = []
  const execute = internals.executePeerCommand.bind(internals)
  vi.spyOn(internals, "executePeerCommand").mockImplementation((peer, command) => {
    commands.push(command)
    return execute(peer, command)
  })
  const rebuilds = () => commands.flatMap((command) => command.kind === "replace-connection" ? [command.cause] : [])
  return { ...made, internals, commands, rebuilds }
}

describe("prompt recovery of a link no answer can complete", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.advanceTimersByTime(60_000)
    vi.spyOn(console, "log").mockImplementation(() => {})
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  describe("#1605: the peer's answer refused", () => {
    it("rebuilds as offerer at once when the refusal leaves our offer holding the connection", async () => {
      const { mesh, pc, signals, rebuilds } = await driven("a", "b")
      await pc.onnegotiationneeded!() // our statement offer
      expect(pc.signalingState).toBe("have-local-offer")
      vi.spyOn(pc, "setRemoteDescription").mockRejectedValueOnce(new DOMException("Failed to set SSL role for the transport.", "OperationError"))
      signals.length = 0
      await mesh.onRtc("b", answer(sdp("222")))
      await settle()
      // no timer: the fresh connection and its offer come at the refusal
      expect(rebuilds()).toEqual(["answer-refused"])
      const fresh = FakePC.last[1]!
      expect(fresh.channels).toHaveLength(1)
      await fresh.onnegotiationneeded!()
      expect(descriptions(signals).map(({ type }) => type)).toEqual(["offer"])
      mesh.close()
    })

    it("spends the round's one immediate rebuild: a second refusal in the round waits for connect-by", async () => {
      const { mesh, pc, rebuilds } = await driven("a", "b")
      await pc.onnegotiationneeded!()
      vi.spyOn(pc, "setRemoteDescription").mockRejectedValueOnce(new DOMException("first", "InvalidAccessError"))
      await mesh.onRtc("b", answer(sdp("222")))
      await settle()
      const fresh = FakePC.last[1]!
      await fresh.onnegotiationneeded!()
      vi.spyOn(fresh, "setRemoteDescription").mockRejectedValueOnce(new DOMException("second", "InvalidAccessError"))
      await mesh.onRtc("b", answer(sdp("222")))
      await settle()
      expect(rebuilds()).toEqual(["answer-refused"])
      expect(FakePC.last).toHaveLength(2)
      mesh.close()
    })

    it("negative control: a late second answer refused on a connection past our offer is only logged", async () => {
      const { mesh, pc, rebuilds } = await driven("a", "b")
      await pc.onnegotiationneeded!()
      await mesh.onRtc("b", answer(sdp("222")))
      await settle()
      state(pc, "connected")
      expect(pc.signalingState).toBe("stable")
      vi.spyOn(pc, "setRemoteDescription").mockRejectedValueOnce(new DOMException("Called in wrong state: stable", "InvalidStateError"))
      await mesh.onRtc("b", answer(sdp("222")))
      await settle()
      await vi.advanceTimersByTimeAsync(6_000) // two supervisor sweeps: nothing comes due
      expect(rebuilds()).toEqual([])
      expect(FakePC.last).toHaveLength(1)
      mesh.close()
    })
  })

  describe("#1606: our answer displaced by our own offer", () => {
    /** The answer's setLocalDescription makes an offer instead: our own
     *  offer took the answer's place, as on the explorer's ice-failed leaf. */
    const displaceNextAnswer = (pc: FakePC) => {
      vi.spyOn(pc, "setLocalDescription").mockImplementationOnce(async () => {
        pc.localDescription = { type: "offer", sdp: sdp("ours") }
        pc.signalingState = "have-local-offer"
      })
    }

    it("the polite side answers the peer's offer again on a fresh responder at once", async () => {
      const { mesh, pc, signals, rebuilds } = await driven("b", "a") // b is polite
      displaceNextAnswer(pc)
      await mesh.onRtc("a", offer(sdp("111"), "A.1"))
      await settle()
      expect(rebuilds()).toEqual(["answer-displaced-rejoin"])
      const fresh = FakePC.last[1]!
      expect(fresh.channels).toHaveLength(0) // a responder: no offer of its own to displace the answer again
      expect(fresh.remoteDescription?.sdp).toBe(sdp("111"))
      // the peer's offer is answered, under its own gen, so the waiting offerer takes it
      expect(descriptions(signals)).toEqual([{ type: "answer", gen: "A.1" }])
      mesh.close()
    })

    it("negative control: the impolite side's offer wins the glare, so it does nothing", async () => {
      const { mesh, pc, rebuilds } = await driven("a", "b") // a is impolite
      // a holds no offer yet when b's offer lands, so it applies it
      displaceNextAnswer(pc)
      await mesh.onRtc("b", offer(sdp("222"), "B.1"))
      await settle()
      expect(rebuilds()).toEqual([])
      expect(FakePC.last).toHaveLength(1)
      mesh.close()
    })

    it("negative control: an answer dropped for a newer offer, which its own run answers, rebuilds nothing", async () => {
      const { mesh, pc, internals, rebuilds } = await driven("b", "a")
      const setLocal = pc.setLocalDescription.bind(pc)
      vi.spyOn(pc, "setLocalDescription").mockImplementationOnce(async (desc) => {
        await setLocal(desc)
        internals.conns.get("a")!.offersApplied += 1 // a newer offer applied during the gather
      })
      await mesh.onRtc("a", offer(sdp("111")))
      await settle()
      expect(rebuilds()).toEqual([])
      expect(FakePC.last).toHaveLength(1)
      mesh.close()
    })
  })

  describe("#1607: connected, lane open, our offer unanswered, no video", () => {
    /** a connected link whose own channel just opened, with no video stat */
    const darkLink = async (pc: FakePC) => {
      state(pc, "connected")
      openOwnChannel(pc)
      pc.stats = new Map() as never // no inbound video stat
    }

    it("gets a second no-video rebuild in the round, 16 s after its lane opened, instead of none", async () => {
      const { mesh, pc, rebuilds } = await driven("a", "b")
      await darkLink(pc)
      await vi.advanceTimersByTimeAsync(20_000)
      expect(rebuilds()).toEqual(["connected-no-video"]) // the round's one, as before
      const fresh = FakePC.last[1]!
      await darkLink(fresh)
      fresh.signalingState = "have-local-offer" // our lane offer, never answered (g284)
      const openedAt = Date.now()
      for (let waited = 0; FakePC.last.length < 3 && waited < 40_000; waited += 1_000) await vi.advanceTimersByTimeAsync(1_000)
      expect(rebuilds()).toEqual(["connected-no-video", "connected-no-video"])
      const recoveredIn = Date.now() - openedAt
      expect(recoveredIn).toBeGreaterThanOrEqual(16_000)
      expect(recoveredIn).toBeLessThanOrEqual(20_000)
      mesh.close()
    })

    it("negative control: with no offer of ours pending, the round's one no-video rebuild stays the only one", async () => {
      const { mesh, pc, rebuilds } = await driven("a", "b")
      await darkLink(pc)
      await vi.advanceTimersByTimeAsync(20_000)
      const fresh = FakePC.last[1]!
      await darkLink(fresh)
      await vi.advanceTimersByTimeAsync(40_000)
      expect(rebuilds()).toEqual(["connected-no-video"])
      expect(FakePC.last).toHaveLength(2)
      mesh.close()
    })

    it("stops at two: a third dark link in the round is left to the heals", async () => {
      const { mesh, pc, rebuilds } = await driven("a", "b")
      await darkLink(pc)
      await vi.advanceTimersByTimeAsync(20_000)
      for (const at of [1, 2]) {
        const fresh = FakePC.last[at]
        if (!fresh) break
        await darkLink(fresh)
        fresh.signalingState = "have-local-offer"
        await vi.advanceTimersByTimeAsync(40_000)
      }
      expect(rebuilds()).toEqual(["connected-no-video", "connected-no-video"])
      expect(FakePC.last).toHaveLength(3)
      mesh.close()
    })
  })
})
