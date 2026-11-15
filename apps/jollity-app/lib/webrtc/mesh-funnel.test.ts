// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The funnel stages of a link, driven through the fake RTCPeerConnection of
 * test-pc.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { chromeStats } from "./test-stats"
import { setupMesh } from "./test-pc"
import type { StageEvent } from "./funnel"

async function setup(myId: string, peerId: string) {
  const stages: Array<[string, StageEvent]> = []
  const { mesh, pc, signals } = await setupMesh(myId, peerId, { onRtcEvent: (peer, event) => event.kind === "stage" && stages.push([peer, event]) })
  return { mesh, pc, stages, signals }
}

describe("the connection funnel", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it("stamps the five stages in order for an initiator, in ms from the mesh opening", async () => {
    const logs = vi.spyOn(console, "log").mockImplementation(() => {})
    const { mesh, pc, stages } = await setup("a", "b")
    mesh.setRound(0)
    pc.channels[0]!.readyState = "open"
    pc.channels[0]!.onopen?.()
    vi.advanceTimersByTime(100)
    await pc.onnegotiationneeded!() // the offer goes out
    vi.advanceTimersByTime(250)
    await mesh.onRtc("b", { rtc: { desc: { type: "answer", sdp: "v=0" } } } as never)
    vi.advanceTimersByTime(50)
    pc.iceConnectionState = "checking"
    pc.oniceconnectionstatechange!()
    vi.advanceTimersByTime(400)
    pc.connectionState = "connected"
    pc.onconnectionstatechange!()
    vi.advanceTimersByTime(600)
    pc.stats = chromeStats({ t: 2000, decoded: 30, lost: 0, received: 10, bytesSent: 0, freezes: 0, cpu: 0 })
    await mesh.report()
    const lines = logs.mock.calls.map((parts) => parts.join(" "))
    expect(lines).toContain("[jollity-rtc] round-link stage=channel-open round=1 peer=b")
    expect(lines).toContain("[jollity-rtc] round-link stage=first-video round=1 peer=b")
    expect(stages.map(([peer, event]) => [peer, event.stage, event.ms])).toEqual([
      ["b", "offer", 100],
      ["b", "answer", 350],
      ["b", "ice_checking", 400],
      ["b", "connected", 800],
      ["b", "first_frame", 1400],
    ])
    // the report names the furthest stage reached
    expect((await mesh.report())[0].stage).toBe("first_frame")
    mesh.close()
  })

  it("reads the same five stages from the answering side: the offer comes in, the answer goes out", async () => {
    const { mesh, pc, stages, signals } = await setup("b", "a")
    vi.advanceTimersByTime(200)
    await mesh.onRtc("a", { rtc: { desc: { type: "offer", sdp: "v=0" } } } as never)
    expect(signals).toHaveLength(1) // our answer
    pc.iceConnectionState = "checking"
    pc.oniceconnectionstatechange!()
    pc.connectionState = "connected"
    pc.onconnectionstatechange!()
    pc.stats = chromeStats({ t: 2000, decoded: 5, lost: 0, received: 10, bytesSent: 0, freezes: 0, cpu: 0 })
    await mesh.report()
    expect(stages.map(([, event]) => event.stage)).toEqual(["offer", "answer", "ice_checking", "connected", "first_frame"])
    mesh.close()
  })

  it("stamps a stage once per peer: a rebuild or a later offer does not repeat it", async () => {
    const { mesh, pc, stages } = await setup("a", "b")
    await pc.onnegotiationneeded!()
    await pc.onnegotiationneeded!() // a renegotiation
    pc.iceConnectionState = "checking"
    pc.oniceconnectionstatechange!()
    pc.oniceconnectionstatechange!()
    expect(stages.map(([, event]) => event.stage)).toEqual(["offer", "ice_checking"])
    mesh.close()
  })

  it("stops at the last stage a link reached when it never connects", async () => {
    const { mesh, pc, stages } = await setup("a", "b")
    await pc.onnegotiationneeded!()
    pc.iceConnectionState = "checking"
    pc.oniceconnectionstatechange!()
    pc.connectionState = "failed"
    pc.onconnectionstatechange!()
    expect(stages.map(([, event]) => event.stage)).toEqual(["offer", "ice_checking"])
    expect((await mesh.report())[0].stage).toBe("ice_checking") // where a pair that never connects stopped
    mesh.close()
  })

  it("says which repair formats the link negotiated, off its current descriptions, once they both exist", async () => {
    const { mesh, pc } = await setup("a", "b")
    expect((await mesh.report())[0].sdp).toBeUndefined()
    const video = (extra: string) => `v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96 97 98\r\na=rtpmap:96 H264/90000\r\n${extra}`
    const fake = pc as unknown as { currentLocalDescription: { sdp: string }; currentRemoteDescription: { sdp: string } }
    fake.currentLocalDescription = { sdp: video("a=rtpmap:97 rtx/90000\r\na=rtpmap:98 red/90000\r\n") }
    fake.currentRemoteDescription = { sdp: video("a=rtpmap:97 rtx/90000\r\n") }
    expect((await mesh.report())[0].sdp).toEqual({ rtx: true, red: false, ulpfec: false, flexfec: false })
    mesh.close()
  })
})
