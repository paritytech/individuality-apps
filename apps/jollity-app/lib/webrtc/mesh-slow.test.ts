// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * A slow peer (rank 6 of the game logs): a link that never connected is not
 * torn down while its negotiation can still complete. Every rebuild mints a new
 * generation, and a peer that hears everything late answers the one before
 * it: in the logs, and in the sim, that loop never ended. Driven through the
 * fake RTCPeerConnection of test-pc.ts, as mesh-heal.test.ts does.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { FakePC, sdp, setupMesh } from "./test-pc"

describe("a link that never connected, with a slow peer", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.advanceTimersByTime(60_000) // a device that has been up a while
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it("is rebuilt by the initiator only INITIAL_TIMEOUT after it first heard the peer, not after it added it", async () => {
    const { mesh } = await setupMesh("a", "b")
    await vi.advanceTimersByTimeAsync(20_000) // nothing heard yet: a late joiner, or a slow store
    mesh.markSeen("b") // first heard
    await vi.advanceTimersByTimeAsync(15_000)
    expect(FakePC.last).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(6_000)
    expect(FakePC.last).toHaveLength(2)
    mesh.close()
  })

  it("waits ANSWER_WAIT for the answer to its offer before the initiator rebuilds, though it hears the answerer", async () => {
    const { mesh, pc, signals } = await setupMesh("a", "b")
    await pc.onnegotiationneeded!() // our offer goes out over the store
    expect(signals).toHaveLength(1)
    for (let i = 0; i < 3; i++) {
      mesh.markSeen("b") // b's hellos arrive; b hears our offer late (game logs: an answer 27 s after the offer)
      await vi.advanceTimersByTimeAsync(8000)
    }
    mesh.markSeen("b")
    await vi.advanceTimersByTimeAsync(4000) // 28 s after the offer
    expect(FakePC.last).toHaveLength(1)
    mesh.markSeen("b")
    await vi.advanceTimersByTimeAsync(6000) // past ANSWER_WAIT with no answer: now a new offer
    expect(FakePC.last).toHaveLength(2)
    mesh.close()
  })

  it("re-offers after simultaneous rebuild glare even while the ignored offer is re-announced", async () => {
    const { mesh, pc, signals } = await setupMesh("a", "b") // a is the impolite initiator
    await pc.onnegotiationneeded!() // both rebuilt sides offer at once
    expect(pc.signalingState).toBe("have-local-offer")
    expect(signals).toHaveLength(1)

    const colliding = { rtc: { desc: { type: "offer", sdp: sdp("remote-rebuild") } } } as never
    await mesh.onRtc("b", colliding) // ignored: a keeps its own offer
    await vi.advanceTimersByTimeAsync(10_000)
    await mesh.onRtc("b", colliding) // the store heartbeat re-announces b's offer
    await vi.advanceTimersByTimeAsync(10_000)
    await mesh.onRtc("b", colliding)
    await vi.advanceTimersByTimeAsync(9_000)
    await mesh.onRtc("b", colliding)
    await vi.advanceTimersByTimeAsync(5_000) // past ANSWER_WAIT from a's unanswered offer

    expect(FakePC.last).toHaveLength(2) // the supervisor does not mistake ignored glare for negotiation progress
    const fresh = FakePC.last[1]!
    await fresh.onnegotiationneeded!()
    expect(signals).toHaveLength(2) // a re-offers from the fresh connection
    mesh.close()
  })

  it("is not rebuilt within NEGOTIATION_QUIET of a description arriving", async () => {
    const { mesh } = await setupMesh("a", "b")
    mesh.markSeen("b")
    await vi.advanceTimersByTimeAsync(16_000)
    await mesh.onRtc("b", { rtc: { desc: { type: "answer", sdp: sdp("s1") } } } as never) // a late answer lands
    await vi.advanceTimersByTimeAsync(13_000) // past INITIAL_TIMEOUT, inside the quiet window
    expect(FakePC.last).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(6_000)
    expect(FakePC.last).toHaveLength(2)
    mesh.close()
  })

  it("is left to the initiator by an answerer the initiator's offer reached", async () => {
    const { mesh, signals } = await setupMesh("b", "a") // b answers a
    await mesh.onRtc("a", { rtc: { desc: { type: "offer", sdp: sdp("s1") } } } as never)
    expect(signals).toHaveLength(1) // our answer went out
    for (let i = 0; i < 6; i++) {
      mesh.markSeen("a") // a's hellos keep coming: a is here, and slow
      await vi.advanceTimersByTimeAsync(8000)
    }
    expect(FakePC.last).toHaveLength(1) // no rebuild: a new offer of ours would only race a's answer
    mesh.close()
  })

  it("is offered on by an answerer that hears the initiator but never got its offer", async () => {
    const { mesh } = await setupMesh("b", "a")
    for (let i = 0; i < 4; i++) {
      mesh.markSeen("a")
      await vi.advanceTimersByTimeAsync(8000)
    }
    expect(FakePC.last.length).toBeGreaterThan(1) // rebuilt, and allowed to offer
    mesh.close()
  })
})
