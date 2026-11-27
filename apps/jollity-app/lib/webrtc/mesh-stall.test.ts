// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * A video that stops on a connected link (rank 9 of the game logs): one side
 * heals it, a bounded number of times. Both ends restarting each other was the
 * ping-pong of games 159–166. Driven through the fake RTCPeerConnection of
 * test-pc.ts, as mesh-heal.test.ts does.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { chromeStats } from "./test-stats"
import { FakePC, setupMesh } from "./test-pc"

const live = { readyState: "live" }
const camera = { getVideoTracks: () => [live], getTracks: () => [] }

async function connected(myId: string, peerId: string) {
  const made = await setupMesh(myId, peerId, {}, camera)
  made.pc.connectionState = "connected"
  made.pc.onconnectionstatechange!()
  return made
}
const frames = (pc: FakePC, decoded: number) => {
  pc.stats = chromeStats({ t: 1000 + decoded, decoded, lost: 0, received: 10, bytesSent: 0, freezes: 0, cpu: 0 })
}

describe("a video that stops on a connected link", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.advanceTimersByTime(60_000) // a device that has been up a while
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it("is not a stall before the link's first frame", async () => {
    const { mesh, pc } = await connected("a", "b")
    frames(pc, 0) // connected, no video decoded yet
    await vi.advanceTimersByTimeAsync(30_000)
    expect(pc.restartIce).not.toHaveBeenCalled()
    mesh.close()
  })

  it("is not a stall while the browser omits the inbound video stat after frames flowed", async () => {
    const { mesh, pc } = await connected("a", "b")
    frames(pc, 50)
    await vi.advanceTimersByTimeAsync(4000) // frames seen
    pc.stats = new Map() // no inbound-rtp video report: unknown, not zero frames
    await vi.advanceTimersByTimeAsync(30_000)
    expect(pc.restartIce).not.toHaveBeenCalled()
    mesh.close()
  })

  it("is left to the initiator by the answerer at first", async () => {
    const { mesh, pc } = await connected("b", "a") // b answers a
    frames(pc, 50)
    await vi.advanceTimersByTimeAsync(4000) // frames seen
    await vi.advanceTimersByTimeAsync(12_000) // three sweeps with none new: the initiator's turn
    expect(pc.restartIce).not.toHaveBeenCalled()
    mesh.close()
  })

  it("is healed by the answerer when the stall outlasts the initiator's turn (a one-way stall)", async () => {
    const { mesh, pc } = await connected("b", "a")
    frames(pc, 50)
    await vi.advanceTimersByTimeAsync(4000)
    await vi.advanceTimersByTimeAsync(28_000)
    expect(pc.restartIce).toHaveBeenCalledTimes(1)
    mesh.close()
  })

  it("gets one ICE restart and one rebuild from the initiator, then no more until frames flow (#1523 F5)", async () => {
    const { mesh, pc } = await connected("a", "b")
    frames(pc, 50)
    await vi.advanceTimersByTimeAsync(4000)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(pc.restartIce).toHaveBeenCalledTimes(1)
    expect(FakePC.last).toHaveLength(2) // the rebuild
    const rebuilt = FakePC.last[1]
    rebuilt.connectionState = "connected"
    rebuilt.onconnectionstatechange!()
    await vi.advanceTimersByTimeAsync(60_000) // the fresh link shows no frame: nothing more to try
    expect(FakePC.last).toHaveLength(2)
    expect(rebuilt.restartIce).not.toHaveBeenCalled()
    mesh.close()
  })

  it("cannot produce the two statement generations late-signal needs inside its old 30-second RTP stall", async () => {
    const { mesh, pc } = await connected("a", "b")
    frames(pc, 50)
    await vi.advanceTimersByTimeAsync(4000) // establish the frame baseline at a real watchdog sweep
    await vi.advanceTimersByTimeAsync(30_000)
    expect(pc.restartIce).toHaveBeenCalledTimes(1) // same PC, the offer rides the open lane
    expect(FakePC.last).toHaveLength(2) // the second stall's rebuild: only one replacement generation
    mesh.close()
  })

  it("starts its count over once frames flow again", async () => {
    const { mesh, pc } = await connected("a", "b")
    frames(pc, 50)
    await vi.advanceTimersByTimeAsync(4000) // frames seen
    await vi.advanceTimersByTimeAsync(8_000) // first stall: one ICE restart
    expect(pc.restartIce).toHaveBeenCalledTimes(1)
    frames(pc, 90) // healed before the second stall
    await vi.advanceTimersByTimeAsync(4000)
    await vi.advanceTimersByTimeAsync(12_000) // past the heal backoff: a new stall, a new first restart, not the rebuild
    expect(pc.restartIce).toHaveBeenCalledTimes(2)
    expect(FakePC.last).toHaveLength(1)
    mesh.close()
  })
})
