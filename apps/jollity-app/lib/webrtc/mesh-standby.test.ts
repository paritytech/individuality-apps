// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * A STANDBY peer (the game's session): a co-player of a LATER round, linked in the
 * clock so the link is up when their round opens. The link
 * negotiates in full (data channel, then media on the lane), but our camera
 * stays off its video sender (replaceTrack(null), no renegotiation) until the
 * peer leaves standby, and nothing reads the missing video as a stall: they
 * hold theirs back from us the same way.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { chromeStats } from "./test-stats"
import { FakePC, setupMesh } from "./test-pc"
import { encodeView, encodeViewFrame } from "./link-view"

interface FakeSender {
  track: MediaStreamTrack | null
  replaceTrack: (track: MediaStreamTrack | null) => Promise<void>
  getParameters: () => RTCRtpSendParameters
  setParameters: () => Promise<void>
}

const liveTrack = (id: string) => ({ kind: "video", id, readyState: "live", enabled: true, muted: false }) as unknown as MediaStreamTrack
function camera(id = "cam") {
  const track = liveTrack(id)
  return { getVideoTracks: () => [track], getTracks: () => [track], track }
}

/** addTrack and senders on a FakePC: every addTrack is a new sender */
function withSenders(pc: FakePC) {
  const senders: FakeSender[] = []
  Object.assign(pc, {
    getSenders: () => senders,
    addTrack: (track: MediaStreamTrack) => {
      const sender: FakeSender = {
        track,
        replaceTrack: vi.fn(async (next: MediaStreamTrack | null) => {
          sender.track = next
        }),
        getParameters: () => ({ encodings: [] }) as unknown as RTCRtpSendParameters,
        setParameters: async () => {},
      }
      senders.push(sender)
      return sender
    },
  })
  return senders
}

const open = (pc: FakePC) => {
  pc.channels[0]!.readyState = "open"
  ;(pc.channels[0]!.onopen as () => void)()
}
const up = (pc: FakePC) => {
  pc.connectionState = "connected"
  pc.onconnectionstatechange!()
}

describe("a standby peer", () => {
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

  it("does not count a standby link as one we send video on, and counts it once standby ends", async () => {
    // the adaptive upload sizes our video by this count: a held-back link sends nothing
    const counts: number[] = []
    const { mesh, pc } = await setupMesh("a", "b", { onActiveVideoSendersChanged: (n) => counts.push(n) }, camera())
    mesh.setStandby("b", true)
    withSenders(pc)
    open(pc)
    await vi.advanceTimersByTimeAsync(0)
    up(pc)
    await vi.advanceTimersByTimeAsync(0)
    expect(counts.at(-1)).toBe(0)
    mesh.setStandby("b", false)
    await vi.advanceTimersByTimeAsync(0)
    expect(counts.at(-1)).toBe(1)
    mesh.close()
  })

  it("negotiates media but sends none of our camera while on standby", async () => {
    const cam = camera()
    const { mesh, pc } = await setupMesh("a", "b", {}, cam)
    mesh.setStandby("b", true)
    const senders = withSenders(pc)
    open(pc)
    await vi.advanceTimersByTimeAsync(0)
    expect(senders).toHaveLength(1) // the m-section is there, so no renegotiation at the round
    expect(senders[0]!.track).toBeNull()
    mesh.close()
  })

  it("puts the camera on that same sender when standby ends, with no new offer", async () => {
    const cam = camera()
    const { mesh, pc, signals } = await setupMesh("a", "b", {}, cam)
    mesh.setStandby("b", true)
    const senders = withSenders(pc)
    open(pc)
    await vi.advanceTimersByTimeAsync(0)
    const sent = signals.length
    mesh.setStandby("b", false)
    await vi.advanceTimersByTimeAsync(0)
    expect(senders).toHaveLength(1)
    expect(senders[0]!.track).toBe(cam.track)
    expect(signals).toHaveLength(sent)
    expect(FakePC.last).toHaveLength(1) // the same connection
    mesh.close()
  })

  it("does not add a second video sender when the channel announces again", async () => {
    const { mesh, pc } = await setupMesh("a", "b", {}, camera())
    mesh.setStandby("b", true)
    const senders = withSenders(pc)
    open(pc)
    ;(pc.channels[0]!.onopen as () => void)()
    await vi.advanceTimersByTimeAsync(0)
    expect(senders).toHaveLength(1)
    mesh.close()
  })

  it("keeps a reopened camera off a standby sender, and takes the new one when standby ends", async () => {
    const { mesh, pc } = await setupMesh("a", "b", {}, camera("old"))
    mesh.setStandby("b", true)
    const senders = withSenders(pc)
    open(pc)
    await vi.advanceTimersByTimeAsync(0)
    const reopened = camera("new")
    await mesh.setLocalStream(reopened as unknown as MediaStream)
    expect(senders[0]!.track).toBeNull()
    mesh.setStandby("b", false)
    await vi.advanceTimersByTimeAsync(0)
    expect(senders[0]!.track).toBe(reopened.track)
    mesh.close()
  })

  it("a standby set before the peer is added still holds when it is added, and survives a rebuild", async () => {
    const { mesh } = await setupMesh("a", "x", {}, camera())
    mesh.setStandby("b", true)
    mesh.addPeer("b")
    const pc = FakePC.last.at(-1)!
    const senders = withSenders(pc)
    open(pc)
    await vi.advanceTimersByTimeAsync(0)
    expect(senders[0]!.track).toBeNull()
    // a reload on their side rebuilds the link: the fresh one is on standby too
    pc.localDescription = { type: "offer", sdp: "v=0" }
    mesh.onPeerSession("b")
    const fresh = FakePC.last.at(-1)!
    expect(fresh).not.toBe(pc)
    const freshSenders = withSenders(fresh)
    open(fresh)
    await vi.advanceTimersByTimeAsync(0)
    expect(freshSenders[0]!.track).toBeNull()
    mesh.close()
  })

  it("reads neither their silent video nor their 'I cannot see you' as a link to heal", async () => {
    const ROOM = ["a", "b"]
    const { mesh, pc } = await setupMesh("a", "b", { members: ROOM }, camera())
    mesh.setStandby("b", true)
    withSenders(pc)
    open(pc)
    up(pc)
    let decoded = 30
    pc.stats = chromeStats({ t: 1000, decoded, lost: 0, received: 10, bytesSent: 0, freezes: 0, cpu: 0 })
    await vi.advanceTimersByTimeAsync(4000) // frames seen once
    const unseen = encodeView(ROOM, (m) => (m === "a" ? "1" : "2"))
    for (let i = 0; i < 12; i++) {
      ;(pc.channels[0]!.onmessage as (e: { data: unknown }) => void)({ data: encodeViewFrame(unseen).buffer })
      decoded += 0 // their video does not move: they send none to a standby peer
      await vi.advanceTimersByTimeAsync(4000)
    }
    expect(pc.restartIce).not.toHaveBeenCalled()
    expect(FakePC.last).toHaveLength(1)
    mesh.close()
  })
})
