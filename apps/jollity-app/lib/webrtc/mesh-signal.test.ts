// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The time from an offer going out to its answer coming back (#262), on the
 * signalling wire and on the data channel, driven through the fake
 * RTCPeerConnection of test-pc.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { encodeChannelMessage, encodePeerConnectionSignal, USE_CASE_RENEGOTIATION } from "@jollity/statement-core"
import { setupMesh } from "./test-pc"
import type { SignalRttEvent } from "./rtc-events"

async function setup() {
  const rtts: Array<[string, SignalRttEvent]> = []
  const made = await setupMesh("a", "b", { onRtcEvent: (peer, { kind, ...event }) => kind === "signal_rtt" && rtts.push([peer, event as SignalRttEvent]) })
  return { ...made, rtts }
}
const answer = { rtc: { desc: { type: "answer", sdp: "v=0" } } } as never

describe("signalling round trip", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it("is the time from the offer leaving on the statement store to the answer arriving", async () => {
    const { mesh, pc, rtts } = await setup()
    await pc.onnegotiationneeded!()
    vi.advanceTimersByTime(4200)
    await mesh.onRtc("b", answer)
    expect(rtts).toEqual([["b", { ms: 4200, via: "statement", peerPresent: false }]])
    mesh.close()
  })

  it("is the same on a device whose wall clock is 75 s fast or slow, or steps mid-flight (#319)", async () => {
    const results: number[] = []
    for (const skewMs of [0, 75_000, -75_000]) {
      const { mesh, pc, rtts } = await setup()
      vi.setSystemTime(new Date(1_800_000_000_000 + skewMs)) // this phone's wall clock
      await pc.onnegotiationneeded!()
      vi.advanceTimersByTime(2000)
      vi.setSystemTime(Date.now() + skewMs) // the OS corrects (steps) the clock while the offer is out
      await mesh.onRtc("b", answer)
      results.push(rtts[0][1].ms)
      mesh.close()
    }
    expect(results).toEqual([2000, 2000, 2000])
  })

  it("leaves the stage timings alone when the wall clock steps mid-funnel (#319)", async () => {
    const stageMs = async (stepMs: number) => {
      const stages: number[] = []
      const { mesh, pc } = await setupMesh("a", "b", { onRtcEvent: (_peer, e) => e.kind === "stage" && stages.push(e.ms) })
      vi.advanceTimersByTime(1000)
      vi.setSystemTime(Date.now() + stepMs)
      await pc.onnegotiationneeded!() // the offer stage
      mesh.close()
      return stages
    }
    const base = await stageMs(0)
    expect(base.length).toBeGreaterThan(0)
    expect(await stageMs(75_000)).toEqual(base)
    expect(await stageMs(-75_000)).toEqual(base)
  })

  it("counts from the offer being sent, not from the gathering that came before it", async () => {
    const { mesh, pc, rtts } = await setup()
    pc.iceGatheringState = "gathering" // the offer waits out the short gather budget
    const negotiating = pc.onnegotiationneeded!()
    await vi.advanceTimersByTimeAsync(750)
    await negotiating
    vi.advanceTimersByTime(500)
    await mesh.onRtc("b", answer)
    expect(rtts[0][1].ms).toBe(500)
    mesh.close()
  })

  it("posts the initial offer within 750 ms and trickles a relay candidate that arrives later", async () => {
    const { mesh, pc, signals } = await setup()
    pc.iceGatheringState = "gathering"
    const negotiating = pc.onnegotiationneeded!()
    await vi.advanceTimersByTimeAsync(749)
    expect(signals).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    await negotiating
    expect(signals).toEqual([{ rtc: { desc: { type: "offer", sdp: "v=0" } } }])

    pc.onicecandidate!({
      candidate: {
        type: "relay",
        protocol: "udp",
        address: "203.0.113.1",
        candidate: "candidate:1 1 udp 1 203.0.113.1 3478 typ relay",
        toJSON: () => ({ candidate: "candidate:1 1 udp 1 203.0.113.1 3478 typ relay" }),
      },
    })
    expect(signals[1]).toEqual({ rtc: { cand: { candidate: "candidate:1 1 udp 1 203.0.113.1 3478 typ relay" } } })
    mesh.close()
  })

  it("posts an answer within the same 750 ms gather budget", async () => {
    const { mesh, pc, signals } = await setup()
    pc.iceGatheringState = "gathering"
    const responding = mesh.onRtc("b", { rtc: { desc: { type: "offer", sdp: "v=0" } } } as never)
    await vi.advanceTimersByTimeAsync(749)
    expect(signals).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    await responding
    expect(signals).toEqual([{ rtc: { desc: { type: "answer", sdp: "v=0" } } }])
    mesh.close()
  })

  it("reports one answer once, and an answer to no offer of ours not at all", async () => {
    const { mesh, pc, rtts } = await setup()
    await mesh.onRtc("b", answer) // we never offered
    expect(rtts).toEqual([])
    await pc.onnegotiationneeded!()
    pc.signalingState = "have-local-offer"
    await mesh.onRtc("b", answer)
    pc.signalingState = "have-local-offer"
    await mesh.onRtc("b", answer) // a repeat
    expect(rtts).toHaveLength(1)
    mesh.close()
  })

  it("times a lane offer and its answer as a channel round trip, kept apart from the statement store's", async () => {
    const { mesh, pc, rtts } = await setup()
    const channel = pc.channels[0]
    channel.readyState = "open"
    await pc.onnegotiationneeded!() // the channel is open, so the offer rides it
    vi.advanceTimersByTime(180)
    const frame = encodeChannelMessage({ id: USE_CASE_RENEGOTIATION, data: encodePeerConnectionSignal({ tag: "Answer", value: "v=0" }) })
    ;(channel.onmessage as (event: { data: unknown }) => void)({ data: new Uint8Array(frame).buffer })
    await vi.advanceTimersByTimeAsync(0)
    expect(rtts).toEqual([["b", { ms: 180, via: "channel", peerPresent: true }]])
    mesh.close()
  })

  it("flags an offer posted while the peer was live in the room as present", async () => {
    const { mesh, pc, rtts } = await setup()
    mesh.markSeen("b") // its presence statement
    vi.advanceTimersByTime(5000)
    await pc.onnegotiationneeded!()
    vi.advanceTimersByTime(800)
    await mesh.onRtc("b", answer)
    expect(rtts).toEqual([["b", { ms: 800, via: "statement", peerPresent: true }]])
    mesh.close()
  })

  it("flags an offer posted before the peer was seen, and also times the answer from its first frame (game 206)", async () => {
    const { mesh, pc, rtts } = await setup()
    await pc.onnegotiationneeded!() // the peer's app is in the background
    vi.advanceTimersByTime(70_000)
    mesh.markSeen("b") // it comes back
    vi.advanceTimersByTime(300)
    await mesh.onRtc("b", answer)
    expect(rtts).toEqual([["b", { ms: 70_300, via: "statement", peerPresent: false, fromSeenMs: 300 }]])
    mesh.close()
  })

  it("does not call a peer present whose last frame is older than the presence window", async () => {
    const { mesh, pc, rtts } = await setup()
    mesh.markSeen("b")
    const conn = (mesh as unknown as { conns: Map<string, { lastSignalAt: number }> }).conns.get("b")!
    conn.lastSignalAt -= 45_000 // its last frame was 45 s ago (the supervisor would have rebuilt the link by waiting that long)
    await pc.onnegotiationneeded!()
    pc.signalingState = "have-local-offer"
    await mesh.onRtc("b", answer)
    expect(rtts[0][1].peerPresent).toBe(false)
    mesh.close()
  })

  it("keeps the mesh going when the observer throws", async () => {
    const { mesh, pc } = await setupMesh("a", "b", {
      onRtcEvent: () => {
        throw new Error("boom")
      },
    })
    await pc.onnegotiationneeded!()
    await expect(mesh.onRtc("b", answer)).resolves.toBeUndefined()
    mesh.close()
  })
})
