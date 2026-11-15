// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Back from the background (#557): a keyframe forced on our senders, the
 * media-stall heal held for KEYFRAME_GRACE_MS, and the time to the first new
 * frame sent as a `resume` event. Driven through the fake RTCPeerConnection.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { chromeStats } from "./test-stats"
import { FakePC, setupMesh } from "./test-pc"
import type { RtcEvent } from "./rtc-events"

const live = { readyState: "live" }
const camera = { getVideoTracks: () => [live], getTracks: () => [] }

/** a video sender whose encoder counts a key frame on each switch back on */
function sender(pc: FakePC, opts: { toggleThrows?: boolean; replaceThrows?: boolean; countsKeyFrames?: boolean } = {}) {
  const track = { kind: "video" }
  const encodings = [{ active: true }]
  const calls: string[] = []
  let keyFrames = 0
  const s = {
    track: track as unknown,
    getParameters: () => ({ encodings }),
    setParameters: vi.fn(async (params: { encodings: { active: boolean }[] }) => {
      calls.push(`active=${params.encodings[0].active}`)
      if (opts.toggleThrows) throw new DOMException("unsupported", "OperationError")
      if (params.encodings[0].active && opts.countsKeyFrames !== false) keyFrames++
    }),
    replaceTrack: vi.fn(async (t: unknown) => {
      calls.push(t ? "replace:track" : "replace:null")
      if (opts.replaceThrows) throw new DOMException("no", "InvalidStateError")
      s.track = t
      if (t && opts.countsKeyFrames !== false) keyFrames++
    }),
  }
  pc.getSenders = () => [s] as never
  pc.getStats = async () => {
    const stats = chromeStats({ t: 1000 + flow.decoded, decoded: flow.decoded, lost: 0, received: 10, bytesSent: 0, freezes: 0, cpu: 0 })
    if (opts.countsKeyFrames !== false) stats.get("OT01V")!.keyFramesEncoded = keyFrames
    return stats as unknown as RTCStatsReport
  }
  return { s, calls, track }
}

/** the frames the far end's video has decoded so far */
const flow = { decoded: 50 }

async function connected(myId: string, peerId: string, events: [string, RtcEvent][] = []) {
  const made = await setupMesh(myId, peerId, { onRtcEvent: (id, e) => events.push([id, e]) }, camera)
  flow.decoded = 50
  made.pc.connectionState = "connected"
  made.pc.onconnectionstatechange!()
  return made
}

describe("back from the background", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.advanceTimersByTime(60_000)
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it("switches the encoder off and on at the return, and records the method", async () => {
    const events: [string, RtcEvent][] = []
    const { mesh, pc } = await connected("a", "b", events)
    const { calls } = sender(pc)
    await vi.advanceTimersByTimeAsync(4000)
    mesh.setSelfAway(true)
    mesh.setSelfAway(false)
    await vi.advanceTimersByTimeAsync(600)
    expect(calls).toEqual(["active=false", "active=true"])
    flow.decoded = 80 // their video is back
    await vi.advanceTimersByTimeAsync(4100) // the next media sweep reads the frames
    const resume = events.find(([, e]) => e.kind === "resume")?.[1]
    expect(resume).toMatchObject({ kind: "resume", side: "self", keyframe: { method: "active-toggle", verified: "true" } })
    expect((resume as { ms: number }).ms).toBeGreaterThan(0)
    mesh.close()
  })

  it("falls back to replacing the track when setParameters throws", async () => {
    const events: [string, RtcEvent][] = []
    const { mesh, pc } = await connected("a", "b", events)
    const { calls, s } = sender(pc, { toggleThrows: true })
    mesh.setSelfAway(true)
    mesh.setSelfAway(false)
    await vi.advanceTimersByTimeAsync(1500)
    expect(calls).toContain("replace:null")
    expect(s.track).toBe(live) // the mesh's camera track is back on the sender
    flow.decoded = 80
    await vi.advanceTimersByTimeAsync(4100)
    expect(events.find(([, e]) => e.kind === "resume")?.[1]).toMatchObject({ keyframe: { method: "replace-track", verified: "true" } })
    mesh.close()
  })

  it("says none when neither method works", async () => {
    const events: [string, RtcEvent][] = []
    const { mesh, pc } = await connected("a", "b", events)
    sender(pc, { toggleThrows: true, replaceThrows: true })
    mesh.setSelfAway(true)
    mesh.setSelfAway(false)
    await vi.advanceTimersByTimeAsync(1500)
    flow.decoded = 80
    await vi.advanceTimersByTimeAsync(4100)
    expect(events.find(([, e]) => e.kind === "resume")?.[1]).toMatchObject({ keyframe: { method: "none" } })
    mesh.close()
  })

  it("moves on to the track swap when the toggle did not raise keyFramesEncoded", async () => {
    const events: [string, RtcEvent][] = []
    const { mesh, pc } = await connected("a", "b", events)
    const { s } = sender(pc)
    // the encoder ignores the toggle but counts the swap
    let keyFrames = 0
    s.setParameters = vi.fn(async () => {})
    s.replaceTrack = vi.fn(async (t: unknown) => {
      s.track = t
      if (t) keyFrames++
    })
    pc.getStats = async () => {
      const stats = chromeStats({ t: 1000 + flow.decoded, decoded: flow.decoded, lost: 0, received: 10, bytesSent: 0, freezes: 0, cpu: 0 })
      stats.get("OT01V")!.keyFramesEncoded = keyFrames
      return stats as unknown as RTCStatsReport
    }
    mesh.setSelfAway(true)
    mesh.setSelfAway(false)
    await vi.advanceTimersByTimeAsync(1500)
    flow.decoded = 80
    await vi.advanceTimersByTimeAsync(4100)
    expect(events.find(([, e]) => e.kind === "resume")?.[1]).toMatchObject({ keyframe: { method: "replace-track", verified: "true" } })
    mesh.close()
  })

  it("does not heal inside the grace window", async () => {
    const { mesh, pc } = await connected("a", "b")
    sender(pc)
    await vi.advanceTimersByTimeAsync(4000) // sweep: frames seen
    await vi.advanceTimersByTimeAsync(3000) // t+7s: one stalled sweep done at +8s next
    mesh.setSelfAway(true)
    mesh.setSelfAway(false) // hold until +9s (7 + 2)
    await vi.advanceTimersByTimeAsync(1500) // sweep at +8s: second stalled sweep, inside the grace
    expect(pc.restartIce).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(4000) // sweep at +12s, grace over, still no frames
    expect(pc.restartIce).toHaveBeenCalledTimes(1)
    mesh.close()
  })

  it("times a peer's return from the moment its away flag clears, side peer", async () => {
    const events: [string, RtcEvent][] = []
    const { mesh, pc } = await connected("a", "b", events)
    sender(pc)
    pc.channels[0].readyState = "open"
    pc.channels[0].onopen?.()
    const { encodeAway } = await import("./away-frame")
    const message = (away: boolean) => (pc.channels[0].onmessage as (e: { data: ArrayBuffer }) => void)({ data: encodeAway(away).buffer as ArrayBuffer })
    message(true)
    await vi.advanceTimersByTimeAsync(5000)
    message(false)
    await vi.advanceTimersByTimeAsync(1100)
    flow.decoded = 90
    await vi.advanceTimersByTimeAsync(4100) // the next media sweep reads the frames
    const resume = events.filter(([, e]) => e.kind === "resume").map(([, e]) => e)
    expect(resume).toHaveLength(1)
    expect(resume[0]).toMatchObject({ side: "peer" })
    expect(resume[0]).not.toHaveProperty("keyframe")
    expect((resume[0] as { ms: number }).ms).toBeGreaterThanOrEqual(1100)
    mesh.close()
  })

  it("puts the CURRENT camera track back after the swap, not the one it took off", async () => {
    const { mesh, pc } = await connected("a", "b")
    const { s, calls } = sender(pc, { toggleThrows: true })
    const fresh = { kind: "video", readyState: "live" }
    // the camera is reopened while the sender is bare
    s.replaceTrack = vi.fn(async (t: unknown) => {
      calls.push(t ? "replace:track" : "replace:null")
      s.track = t
      if (!t) void mesh.setLocalStream({ getVideoTracks: () => [fresh], getTracks: () => [fresh] } as unknown as MediaStream)
    })
    mesh.setSelfAway(true)
    mesh.setSelfAway(false)
    await vi.advanceTimersByTimeAsync(1500)
    expect(s.track).toBe(fresh)
    mesh.close()
  })

  it("does not add a second video sender while the swap has the track off", async () => {
    const { mesh, pc } = await connected("a", "b")
    const { s } = sender(pc, { toggleThrows: true })
    const addTrack = vi.fn(() => {
      throw new Error("a second sender was added")
    })
    ;(pc as unknown as { addTrack: unknown }).addTrack = addTrack
    const track = { kind: "video", readyState: "live" }
    const local = { getVideoTracks: () => [track], getTracks: () => [track] }
    ;(mesh as unknown as { local: unknown }).local = local
    let during = 0
    s.replaceTrack = vi.fn(async (t: unknown) => {
      s.track = t
      if (!t) {
        try {
          ;(mesh as unknown as { addLocalTracks: (c: unknown) => void }).addLocalTracks((mesh as unknown as { conns: Map<string, unknown> }).conns.get("b"))
        } catch {
          // the throw is the mock's: a second video sender was added
        }
        during = addTrack.mock.calls.length
      }
    })
    mesh.setSelfAway(true)
    mesh.setSelfAway(false)
    await vi.advanceTimersByTimeAsync(1500)
    expect(during).toBe(0)
    mesh.close()
  })

  it("changes nothing when nobody was away", async () => {
    const events: [string, RtcEvent][] = []
    const { mesh, pc } = await connected("a", "b", events)
    const { s } = sender(pc)
    mesh.setSelfAway(false) // never away: no return
    flow.decoded = 90
    await vi.advanceTimersByTimeAsync(5000)
    expect(s.setParameters).not.toHaveBeenCalled()
    expect(s.replaceTrack).not.toHaveBeenCalled()
    expect(events.some(([, e]) => e.kind === "resume")).toBe(false)
    mesh.close()
  })
})
