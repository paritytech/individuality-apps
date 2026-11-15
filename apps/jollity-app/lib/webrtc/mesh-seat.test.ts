// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * What a seat reads of a peer's video (Mesh.seats → seat-state.ts): it holds
 * across a rebuild, because the tile still shows their face; it comes back the
 * moment a new track receives; and a link back up is looked at for frames
 * before the next sweep. Driven through the fake RTCPeerConnection of
 * test-pc.ts, as mesh-heal.test.ts does.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { chromeStats } from "./test-stats"
import { FakePC, setupMesh } from "./test-pc"

const camera = { getVideoTracks: () => [{ readyState: "live", enabled: true, muted: false }], getTracks: () => [] }
const state = (pc: FakePC, next: RTCPeerConnectionState) => {
  pc.connectionState = next
  pc.onconnectionstatechange!()
}
const decoding = (pc: FakePC, decoded: number) => {
  pc.stats = chromeStats({ t: 1000 + decoded, decoded, lost: 0, received: 10, bytesSent: 0, freezes: 0, cpu: 0 })
}
const videoTrack = () => Object.assign(new EventTarget(), { kind: "video" })
const lastFrameAt = (mesh: Awaited<ReturnType<typeof setupMesh>>["mesh"]) => mesh.seats().get("b")!.lastFrameAt

describe("a seat's view of a peer's video", () => {
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

  it("keeps the last time their video came through across a rebuild", async () => {
    const { mesh, pc } = await setupMesh("a", "b", {}, camera)
    decoding(pc, 30)
    state(pc, "connected")
    await vi.advanceTimersByTimeAsync(4000) // their frames are seen
    const seen = lastFrameAt(mesh)
    expect(Number.isFinite(seen)).toBe(true)
    state(pc, "failed")
    await vi.advanceTimersByTimeAsync(3100) // the supervisor rebuilds: a new link, no frames on it yet
    expect(FakePC.last).toHaveLength(2)
    expect(lastFrameAt(mesh)).toBe(seen)
    mesh.close()
  })

  it("marks their video back the moment a new track receives, and not for a track of a link since replaced", async () => {
    const { mesh, pc } = await setupMesh("a", "b", {}, camera)
    const track = videoTrack()
    ;(pc.ontrack as (e: { track: unknown; streams: unknown[] }) => void)({ track, streams: [] })
    expect(Number.isFinite(lastFrameAt(mesh))).toBe(false)
    await vi.advanceTimersByTimeAsync(500)
    const before = performance.now()
    track.dispatchEvent(new Event("unmute")) // its first packets
    expect(lastFrameAt(mesh)).toBeGreaterThanOrEqual(before)

    const marked = lastFrameAt(mesh)
    state(pc, "connected")
    state(pc, "failed")
    await vi.advanceTimersByTimeAsync(3100) // a link that dropped is rebuilt
    expect(FakePC.last).toHaveLength(2)
    track.dispatchEvent(new Event("unmute")) // the old link's track, late
    expect(lastFrameAt(mesh)).toBe(marked)
    mesh.close()
  })

  it("takes a decoded count that went back, with frames on it, as video flowing: a new stream's own count", async () => {
    const { mesh, pc } = await setupMesh("a", "b", {}, camera)
    decoding(pc, 3000)
    state(pc, "connected")
    await vi.advanceTimersByTimeAsync(4000)
    const before = lastFrameAt(mesh)
    decoding(pc, 40) // a replaced stream, counting from 0
    await vi.advanceTimersByTimeAsync(4000)
    expect(lastFrameAt(mesh)).toBeGreaterThan(before)
    mesh.close()
  })

  it("looks at a link back up for frames well before the next sweep", async () => {
    const { mesh, pc } = await setupMesh("a", "b", {}, camera)
    decoding(pc, 30)
    state(pc, "connected")
    await vi.advanceTimersByTimeAsync(1600) // the sweep runs every 4 s
    expect(Number.isFinite(lastFrameAt(mesh))).toBe(true)
    mesh.close()
  })
})
