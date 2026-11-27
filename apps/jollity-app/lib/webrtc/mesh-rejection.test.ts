// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Step 4.3 stage 3b, step 1, with the peer actor driving (step 9; until then
 * these were shadow comparisons): a rejected connection command has the
 * outcome Mesh gives it at the site that issued it, and the actor's program
 * follows from it. Each scenario runs the real Mesh on the fake
 * RTCPeerConnection.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { encodeChannelMessage, encodePeerConnectionSignal, USE_CASE_RENEGOTIATION } from "@jollity/statement-core"
import type { PeerRoomRunner } from "../state-machines/peer-runner"
import { chromeStats } from "./test-stats"
import { actorEvents, FakeChannel, FakePC, sdp, setupMesh } from "./test-pc"

const sendLane = (pc: FakePC, tag: "Offer" | "Answer", value: string) => {
  const frame = encodeChannelMessage({ id: USE_CASE_RENEGOTIATION, data: encodePeerConnectionSignal({ tag, value }) })
  ;(pc.channels[0]!.onmessage as (event: { data: unknown }) => void)({ data: new Uint8Array(frame).buffer })
}
const settle = async () => { for (let i = 0; i < 6; i++) await Promise.resolve() }
const state = (pc: FakePC, next: RTCPeerConnectionState) => {
  pc.connectionState = next
  pc.onconnectionstatechange!()
}
const open = (pc: FakePC) => {
  pc.channels[0]!.readyState = "open"
  ;(pc.channels[0]!.onopen as () => void)()
}

async function driven(myId: string, peerId: string, local?: unknown) {
  const made = await setupMesh(myId, peerId, {
    decisionRoom: "g7",
    decisionRoomEpoch: 3,
  }, local)
  /** the events the actor stepped on, completions included */
  return { ...made, inputs: actorEvents(made.mesh) }
}

describe("a rejected command's outcome, per site, with the peer actor driving", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(console, "log").mockImplementation(() => {})
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  describe("lane descriptions", () => {
    const laneOffered = async () => {
      const made = await driven("a", "b")
      made.mesh.setRound(1)
      made.pc.channels[0]!.readyState = "open"
      await made.pc.onnegotiationneeded!()
      return made
    }

    it("rebuilds once on a hard SDP error applying the lane answer, as the actor decides", async () => {
      const { mesh, pc } = await laneOffered()
      vi.spyOn(pc, "setRemoteDescription").mockRejectedValueOnce(new DOMException("ssrc", "InvalidAccessError"))
      sendLane(pc, "Answer", sdp("222", { media: ["video"] }))
      await settle()
      expect(FakePC.last).toHaveLength(2)
      mesh.close()
    })

    it("rebuilds on a hard lane error for a peer added after the round began, as useMesh adds them", async () => {
      // useMesh calls setRound before setPeers, so every peer's actor is
      // created after the round change it must still be in.
      vi.resetModules()
      FakePC.last = []
      vi.stubGlobal("RTCPeerConnection", FakePC)
      const { Mesh } = await import("./mesh")
      const mesh = new Mesh("a", { getVideoTracks: () => [], getTracks: () => [] } as unknown as MediaStream, {}, () => {}, () => {}, () => {}, () => {}, {
        decisionRoom: "g7",
        decisionRoomEpoch: 3,
      })
      mesh.setRound(2)
      mesh.addPeer("b")
      const pc = FakePC.last[0]!
      pc.channels[0]!.readyState = "open"
      await pc.onnegotiationneeded!()
      vi.spyOn(pc, "setRemoteDescription").mockRejectedValueOnce(new DOMException("ssrc", "InvalidAccessError"))
      sendLane(pc, "Answer", sdp("222", { media: ["video"] }))
      await settle()
      expect(FakePC.last).toHaveLength(2)
      mesh.close()
    })

    it("spends the round's one immediate rebuild once, on the stamped completion", async () => {
      const { mesh, pc, inputs } = await laneOffered()
      inputs.length = 0
      vi.spyOn(pc, "setRemoteDescription").mockRejectedValueOnce(new DOMException("ssrc", "InvalidAccessError"))
      sendLane(pc, "Answer", sdp("222", { media: ["video"] }))
      await settle()
      // the rejected completion rebuilds
      expect(inputs.map(({ event }) => event)).toContainEqual(expect.objectContaining({ type: "command-completed", commandKind: "set-remote-description", outcome: "rejected" }))
      expect(FakePC.last).toHaveLength(2)
      mesh.close()
    })

    it("only logs a lane answer that fails with an error that is not a hard SDP one", async () => {
      const { mesh, pc } = await laneOffered()
      vi.spyOn(pc, "setRemoteDescription").mockRejectedValueOnce(new Error("transient"))
      sendLane(pc, "Answer", sdp("222", { media: ["video"] }))
      await settle()
      expect(FakePC.last).toHaveLength(1)
      mesh.close()
    })

    it("spends the immediate rebuild once a round: a second hard error on the fresh link is logged", async () => {
      const { mesh, pc } = await laneOffered()
      vi.spyOn(pc, "setRemoteDescription").mockRejectedValueOnce(new DOMException("first", "InvalidAccessError"))
      sendLane(pc, "Answer", sdp("222", { media: ["video"] }))
      await settle()
      const fresh = FakePC.last[1]!
      fresh.channels[0]!.readyState = "open"
      await fresh.onnegotiationneeded!()
      vi.spyOn(fresh, "setRemoteDescription").mockRejectedValueOnce(new DOMException("second", "OperationError"))
      sendLane(fresh, "Answer", sdp("333", { media: ["video"] }))
      await settle()
      expect(FakePC.last).toHaveLength(2)
      mesh.close()
    })

    it("rebuilds the answerer on a hard SDP error applying a lane offer", async () => {
      const { mesh, pc } = await driven("b", "a")
      mesh.setRound(1)
      const channel = new FakeChannel()
      channel.readyState = "open"
      pc.channels.push(channel)
      ;(pc.ondatachannel as (event: { channel: FakeChannel }) => void)({ channel })
      vi.spyOn(pc, "setRemoteDescription").mockRejectedValueOnce(new DOMException("offer refused", "InvalidAccessError"))
      sendLane(pc, "Offer", sdp("111", { media: ["video"] }))
      await settle()
      expect(FakePC.last).toHaveLength(2)
      mesh.close()
    })
  })

  describe("ICE restarts", () => {
    it("falls back to a rebuild when the supervisor's ICE restart throws", async () => {
      const { mesh, pc } = await driven("a", "b")
      open(pc)
      state(pc, "connected")
      state(pc, "disconnected")
      pc.restartIce.mockImplementationOnce(() => { throw new Error("restart refused") })
      await vi.advanceTimersByTimeAsync(9000)
      expect(pc.restartIce).toHaveBeenCalledTimes(1)
      expect(FakePC.last).toHaveLength(2)
      mesh.close()
    })

    it("falls back to a rebuild when a network change's ICE restart throws", async () => {
      const { mesh, pc } = await driven("a", "b")
      open(pc)
      pc.restartIce.mockImplementationOnce(() => { throw new Error("restart refused") })
      mesh.networkChanged()
      expect(FakePC.last).toHaveLength(2)
      mesh.close()
    })

    it("closes the restart the actor issued when a network change's ICE restart works", async () => {
      const { mesh, pc, inputs } = await driven("a", "b")
      open(pc)
      mesh.networkChanged()
      expect(pc.restartIce).toHaveBeenCalledTimes(1)
      expect(inputs.map(({ event }) => event).filter((event) => event.type === "command-completed").at(-1)).toMatchObject({ commandKind: "restart-ice", outcome: "resolved" })
      mesh.close()
    })

    it("only logs a media-stall ICE restart that throws, and the next stall rebuilds (#1523 F5)", async () => {
      const video = { kind: "video", readyState: "live" }
      const { mesh, pc, inputs } = await driven("a", "b", { getVideoTracks: () => [video], getTracks: () => [video] })
      vi.advanceTimersByTime(60_000)
      open(pc)
      state(pc, "connected")
      pc.stats = chromeStats({ t: 2_000, decoded: 50, lost: 0, received: 10, bytesSent: 0, freezes: 0, cpu: 0 })
      await vi.advanceTimersByTimeAsync(4000)
      pc.restartIce.mockImplementationOnce(() => { throw new Error("restart refused") })
      await vi.advanceTimersByTimeAsync(16_000)
      expect(pc.restartIce).toHaveBeenCalled()
      expect(FakePC.last).toHaveLength(2) // the throwing restart spent the one heal: the next stall rebuilds
      expect(inputs.map(({ event }) => event)).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "command-completed", commandKind: "restart-ice", outcome: "rejected", site: "media-stall" }),
      ]))
      mesh.close()
    })
  })

  describe("a remote statement offer the connection refuses", () => {
    it("rebuilds a virgin connection and offers on it (initiateStrandedPeer)", async () => {
      const { mesh, pc } = await driven("b", "a")
      vi.spyOn(pc, "setRemoteDescription").mockRejectedValueOnce(new DOMException("unusable offer", "OperationError"))
      await mesh.onRtc("a", { rtc: { desc: { type: "offer", sdp: sdp("remote-1") } } })
      await settle()
      expect(FakePC.last).toHaveLength(2)
      expect(FakePC.last[1]!.channels).toHaveLength(1)
      mesh.close()
    })

    it("stamps a refusal as not virgin when the connection was replaced during the await, as initiateStrandedPeer then does nothing", async () => {
      const { mesh, pc, inputs } = await driven("b", "a")
      vi.spyOn(pc, "setRemoteDescription").mockImplementationOnce(async () => {
        mesh.networkChanged() // channel down: a fresh connection replaces this one
        throw new DOMException("unusable offer", "OperationError")
      })
      await mesh.onRtc("a", { rtc: { desc: { type: "offer", sdp: sdp("remote-1") } } })
      await settle()
      expect(FakePC.last).toHaveLength(2) // the network change's rebuild only
      expect(inputs.map(({ event }) => event)).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "command-completed", commandKind: "set-remote-description", reason: "other" }),
      ]))
      mesh.close()
    })

    it.each(["said", "timeout"] as const)("brings a %s-away peer back when its refused offer is applied to a rebuilt responder", async (away) => {
      const { mesh } = await driven("b", "a")
      await mesh.onRtc("a", { rtc: { desc: { type: "offer", sdp: sdp("remote-1", { media: ["video"] }) } } })
      await settle()
      const internals = mesh as unknown as {
        conns: Map<string, { away: string | null }>
        setAway(peer: string, conn: unknown, away: string | null): void
        runner: PeerRoomRunner
      }
      const old = internals.conns.get("a")!
      internals.setAway("a", old, away)
      // same session, fewer m-lines than were negotiated: refused with InvalidAccessError
      await mesh.onRtc("a", { rtc: { desc: { type: "offer", sdp: sdp("remote-1") } } })
      await settle()
      expect(FakePC.last).toHaveLength(2)
      const fresh = internals.conns.get("a")!
      const actor = internals.runner.state("a")!
      expect(fresh.away).toBeNull()
      expect(actor).toMatchObject({ away: "here", budgets: { failCount: 0 } })
      expect(actor.lastSignalAt).not.toBeNull()
      mesh.close()
    })

    it("rebuilds as responder and applies the offer again on InvalidAccessError (rebuildForRejoin)", async () => {
      const { mesh, pc } = await driven("b", "a")
      await mesh.onRtc("a", { rtc: { desc: { type: "offer", sdp: sdp("remote-1", { media: ["video"] }) } } })
      await settle()
      expect(pc.remoteDescription).not.toBeNull()
      // same session, but fewer m-lines than were negotiated: the fake refuses it as Chrome does
      await mesh.onRtc("a", { rtc: { desc: { type: "offer", sdp: sdp("remote-1") } } })
      await settle()
      expect(FakePC.last).toHaveLength(2)
      expect(FakePC.last[1]!.remoteDescription).not.toBeNull()
      mesh.close()
    })
  })

  describe("the codec guard", () => {
    const rtxOffer = "v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96 97\r\na=rtpmap:97 rtx/90000\r\na=fmtp:97 apt=96\r\n"
    const exposed = async () => {
      vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (Linux; Android 12; wv) Chrome/120.0 Mobile", onLine: true })
      const made = await driven("a", "b")
      Object.assign(made.pc, { createOffer: vi.fn(async () => ({ type: "offer", sdp: rtxOffer })) })
      // the lane is open, so negotiationneeded offers on it (offerOnStatement -> offerOnLane)
      return { ...made, offer: () => made.pc.onnegotiationneeded!() }
    }
    const setsRtxOffer = (pc: FakePC) => async () => {
      pc.localDescription = { type: "offer", sdp: rtxOffer }
      pc.signalingState = "have-local-offer"
    }

    it("rolls back, sets the stripped offer and sends it", async () => {
      const { mesh, pc, offer } = await exposed()
      open(pc)
      vi.spyOn(pc, "setLocalDescription").mockImplementationOnce(setsRtxOffer(pc))
      await offer()
      expect(pc.channels[0]!.send).toHaveBeenCalled()
      mesh.close()
    })

    it("sends nothing and reports a stale guard when the connection moved on during the rollback", async () => {
      const { mesh, pc, offer } = await exposed()
      open(pc)
      vi.spyOn(pc, "setLocalDescription")
        .mockImplementationOnce(setsRtxOffer(pc))
        .mockImplementationOnce(async () => { pc.localDescription = null; pc.signalingState = "have-remote-offer" })
      await offer()
      expect(pc.channels[0]!.send).not.toHaveBeenCalled()
      mesh.close()
    })

    it("follows the lane rule when its replacement offer is refused with a hard SDP error", async () => {
      const { mesh, pc, offer } = await exposed()
      mesh.setRound(1)
      open(pc)
      vi.spyOn(pc, "setLocalDescription")
        .mockImplementationOnce(setsRtxOffer(pc))
        .mockImplementationOnce(async () => { pc.localDescription = null; pc.signalingState = "stable" })
        .mockRejectedValueOnce(new DOMException("stripped offer refused", "InvalidAccessError"))
      await offer()
      expect(FakePC.last).toHaveLength(2)
      mesh.close()
    })
  })
})
