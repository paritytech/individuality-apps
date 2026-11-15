// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Mesh.probeStaleFrames (#672, the story is in its doc in mesh.ts), driven
 * through the fake RTCPeerConnection of test-pc.ts as mesh-seat.test.ts is.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { chromeStats } from "./test-stats"
import { FakePC, setupMesh } from "./test-pc"
import { seatState, settleSeat } from "./seat-state"
import { seatTakesTap } from "../tile-tap"

type Made = Awaited<ReturnType<typeof setupMesh>>

const camera = { getVideoTracks: () => [{ readyState: "live", enabled: true, muted: false }], getTracks: () => [] }
const state = (pc: FakePC, next: RTCPeerConnectionState) => {
  pc.connectionState = next
  pc.onconnectionstatechange!()
}
/** their frames decoded so far, and ours sent (our own video: never theirs) */
const report = (decoded: number, bytesSent = 0) =>
  chromeStats({ t: 1000 + decoded + bytesSent, decoded, lost: 0, received: 10, bytesSent, freezes: 0, cpu: 0 })
const decoding = (pc: FakePC, decoded: number, bytesSent = 0) => {
  pc.stats = report(decoded, bytesSent)
}
/** getStats answers only when told: `answer(i, decoded)` resolves the i-th read made since */
const deferStats = (pc: FakePC) => {
  const pending: ((report: RTCStatsReport) => void)[] = []
  pc.getStats = vi.fn(() => new Promise<RTCStatsReport>((resolve) => pending.push(resolve)))
  return { pending, answer: (i: number, decoded: number) => pending[i](report(decoded) as unknown as RTCStatsReport) }
}
const seatOf = (mesh: Made["mesh"]) => seatState(mesh.seats().get("b"), { now: performance.now() + 1, heardFrom: 0, selfSuspect: false, weak: false })

/** a linked peer we still hear, whose video stopped 25 s ago with the link kept up: Can't connect */
async function stalled(): Promise<Made> {
  // no camera of our own: no media-stall heal restarts or rebuilds the link meanwhile
  const made = await setupMesh("a", "b")
  made.mesh.markSeen("b")
  decoding(made.pc, 30)
  state(made.pc, "connected")
  await vi.advanceTimersByTimeAsync(4000) // the sweep sees their frames
  for (let i = 0; i < 5; i++) {
    await vi.advanceTimersByTimeAsync(5000) // no new frames
    made.mesh.markSeen("b") // their hellos keep coming
  }
  expect(seatOf(made.mesh)).toBe("cant-connect")
  return made
}

describe("a co-player's video back on a link that stayed up (#672)", () => {
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

  it("reads live, and takes a tap, on the tick that sees their frames, not a sweep later", async () => {
    const { mesh, pc } = await stalled()
    const shown = settleSeat(undefined, "cant-connect", performance.now() + 1)
    expect(seatTakesTap(shown.state)).toBe(false)
    decoding(pc, 31) // their first frame after the stall
    const resumedAt = performance.now() + 1
    expect(await mesh.probeStaleFrames()).toBe(true) // the 1 s tick's look, no timer passed
    expect(mesh.seats().get("b")!.lastFrameAt - resumedAt).toBeLessThan(1000)
    expect(seatOf(mesh)).toBe("live")
    const next = settleSeat(shown, seatOf(mesh), performance.now() + 1)
    expect(next.state).toBe("live") // up into live shows at once
    expect(seatTakesTap(next.state)).toBe(true)
    mesh.close()
  })

  it("stays Can't connect while their frames do not move, however much of our own video goes out", async () => {
    const { mesh, pc } = await stalled()
    decoding(pc, 30, 900_000) // our outbound frames rise; their inbound count does not
    expect(await mesh.probeStaleFrames()).toBe(false)
    expect(seatOf(mesh)).toBe("cant-connect")
    expect(seatTakesTap(seatOf(mesh))).toBe(false)
    mesh.close()
  })

  it("does not look at a link whose seat is live: the healthy cadence stays the sweep's", async () => {
    const { mesh, pc } = await setupMesh("a", "b")
    decoding(pc, 30)
    state(pc, "connected")
    await vi.advanceTimersByTimeAsync(4000)
    const stats = vi.spyOn(pc, "getStats")
    expect(await mesh.probeStaleFrames()).toBe(false)
    expect(stats).not.toHaveBeenCalled()
    mesh.close()
  })

  it("does not mark the seat live from a look that a rebuild overtook", async () => {
    const { mesh, pc } = await stalled()
    const before = mesh.seats().get("b")!.lastFrameAt
    const { answer } = deferStats(pc)
    const look = mesh.probeStaleFrames()
    expect(await mesh.probeStaleFrames()).toBe(false) // one look per link at a time
    expect(pc.getStats).toHaveBeenCalledTimes(1)
    state(pc, "failed")
    await vi.advanceTimersByTimeAsync(3100) // the supervisor rebuilds: a new link, a new connection
    expect(FakePC.last).toHaveLength(2)
    answer(0, 40)
    expect(await look).toBe(false)
    expect(mesh.seats().get("b")!.lastFrameAt).toBe(before)
    mesh.close()
  })

  it("does not mark anything from a look that outlived the mesh", async () => {
    const { mesh, pc } = await stalled()
    const { answer } = deferStats(pc)
    const look = mesh.probeStaleFrames()
    mesh.close()
    answer(0, 40)
    expect(await look).toBe(false)
  })

  it("does not take an older read that lands after a newer one for an advance", async () => {
    const { mesh, pc } = await stalled()
    const { pending, answer } = deferStats(pc)
    const look = mesh.probeStaleFrames() // read 0: the probe
    await vi.advanceTimersByTimeAsync(4000) // read 1: the sweep, issued later
    expect(pending).toHaveLength(2)
    answer(1, 35) // the sweep's newer read lands first: their frames moved
    await vi.advanceTimersByTimeAsync(0)
    const seen = mesh.seats().get("b")!.lastFrameAt
    answer(0, 31) // the probe's older, lower read: not a counter reset
    expect(await look).toBe(false)
    expect(mesh.seats().get("b")!.lastFrameAt).toBe(seen)
    mesh.close()
  })

  it("starts a new stall's heals over when a look saw their frames in between", async () => {
    // our camera is live, so a stall is healed: two ICE restarts, then a rebuild
    const { mesh, pc } = await setupMesh("a", "b", {}, camera)
    let decoded = 30
    decoding(pc, decoded)
    state(pc, "connected")
    await vi.advanceTimersByTimeAsync(4000) // the sweep sees their frames
    for (let stall = 0; stall < 3; stall++) {
      // the video stops: two sweeps and the heal backoff later, one heal
      const restarts = pc.restartIce.mock.calls.length
      for (let s = 0; s < 4 && pc.restartIce.mock.calls.length === restarts; s++) await vi.advanceTimersByTimeAsync(4000)
      expect(pc.restartIce).toHaveBeenCalledTimes(restarts + 1)
      // one frame comes through, seen by the tick's look alone, and the video dies again
      await vi.advanceTimersByTimeAsync(3000)
      decoding(pc, ++decoded)
      expect(await mesh.probeStaleFrames()).toBe(true)
    }
    // three stalls, each healed from the first step: never a rebuild
    expect(FakePC.last).toHaveLength(1)
    mesh.close()
  })
})

describe("a link that never shows their video", () => {
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

  /** how many of `ticks` looks read the link's stats */
  const reads = async (mesh: Made["mesh"], pc: FakePC, ticks: number) => {
    const stats = vi.spyOn(pc, "getStats")
    for (let i = 0; i < ticks; i++) await mesh.probeStaleFrames()
    const n = stats.mock.calls.length
    stats.mockRestore()
    return n
  }

  it("is looked at every tick for 5 ticks, then every 4th", async () => {
    const { mesh, pc } = await setupMesh("a", "b")
    decoding(pc, 0) // camera off, no away frame: no video ever comes
    state(pc, "connected")
    expect(await reads(mesh, pc, 12)).toBe(7) // ticks 1–5, 8 and 12
    mesh.close()
  })

  it("is looked at every tick again once their frames come", async () => {
    const { mesh, pc } = await setupMesh("a", "b")
    decoding(pc, 0)
    state(pc, "connected")
    await reads(mesh, pc, 12)
    decoding(pc, 30)
    expect(await mesh.probeStaleFrames()).toBe(false) // tick 13: backed off
    expect(await reads(mesh, pc, 3)).toBe(1) // tick 16 sees them
    await vi.advanceTimersByTimeAsync(8000) // then the video stops: their seat is no longer live
    expect(await reads(mesh, pc, 6)).toBe(6)
    mesh.close()
  })

  it("is looked at every tick again on a rebuilt link", async () => {
    const { mesh, pc } = await setupMesh("a", "b")
    decoding(pc, 0)
    state(pc, "connected")
    await reads(mesh, pc, 12)
    state(pc, "failed")
    await vi.advanceTimersByTimeAsync(3100) // the supervisor rebuilds
    const fresh = FakePC.last[1]
    decoding(fresh, 0)
    state(fresh, "connected")
    expect(await reads(mesh, fresh, 5)).toBe(5)
    mesh.close()
  })
})
