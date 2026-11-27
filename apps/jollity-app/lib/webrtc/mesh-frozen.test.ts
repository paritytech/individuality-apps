// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Frozen video on a live link (#1917): the RTP keeps arriving,
 * the decoded frames stay flat. An ICE restart cannot mend that, so the
 * receiver asks the sender for a keyframe over the data channel, and rebuilds
 * the link if the frames are still flat after the grace. The sender serves a
 * request with its forceKeyframe, once per link per KEYFRAME_GRACE_MS, and
 * never while hidden or in standby. Driven through the fake RTCPeerConnection
 * of test-pc.ts, as mesh-stall.test.ts does.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { chromeStats } from "./test-stats"
import { actorCommands, FakePC, setupMesh } from "./test-pc"
import { decodeKeyframeRequest, encodeKeyframeRequest } from "./keyframe-frame"
import type { RtcEvent } from "./rtc-events"
import type { SeatFacts } from "./seat-state"

const live = { readyState: "live" }
const camera = { getVideoTracks: () => [live], getTracks: () => [] }

/** what the far end's video looks like on the next read: decoded frames and packets received */
interface Flow { decoded: number; received: number; packetsPerRead: number }

/** Every read of this PC's stats: the frames as `flow` says, and the packets
 *  rising by `packetsPerRead` on each read (0: flat, a dead transport). */
function feed(pc: FakePC, flow: Flow) {
  pc.getStats = async () => {
    flow.received += flow.packetsPerRead
    return chromeStats({ t: 1000 + flow.received, decoded: flow.decoded, lost: 0, received: flow.received, bytesSent: 0, freezes: 0, cpu: 0 }) as unknown as RTCStatsReport
  }
}

async function connected(myId: string, peerId: string, events: [string, RtcEvent][] = []) {
  const made = await setupMesh(myId, peerId, { onRtcEvent: (id, e) => events.push([id, e]) }, camera)
  const flow: Flow = { decoded: 50, received: 100, packetsPerRead: 40 }
  feed(made.pc, flow)
  made.pc.connectionState = "connected"
  made.pc.onconnectionstatechange!()
  const channel = made.pc.channels[0]
  if (channel) {
    channel.readyState = "open"
    ;(channel.onopen as (() => void) | null)?.()
  }
  return { ...made, flow, channel }
}

const keyframeAsks = (pc: FakePC) => pc.channels.flatMap((channel) => channel.send.mock.calls.map(([data]) => data as Uint8Array)).filter((data) => data instanceof Uint8Array && decodeKeyframeRequest(data))

/** a video sender whose encoder counts a key frame on each switch back on */
function videoSender(pc: FakePC) {
  const encodings = [{ active: true }]
  const s = {
    track: { kind: "video" } as unknown,
    getParameters: () => ({ encodings }),
    setParameters: vi.fn(async () => {}),
    replaceTrack: vi.fn(async () => {}),
  }
  pc.getSenders = () => [s] as never
  return s
}

const seatOf = (mesh: unknown, peerId: string): SeatFacts => (mesh as { seats(): Map<string, SeatFacts> }).seats().get(peerId)!

describe("frozen video on a live link (#1917)", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.advanceTimersByTime(60_000) // a device that has been up a while
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it("packets rising and frames flat never restart ICE; a keyframe is asked for, then the link is rebuilt", async () => {
    const { mesh, pc } = await connected("a", "b")
    // the look after the link came up saw frames at 50; the sweeps at 4 s and 8 s read them flat, packets rising
    await vi.advanceTimersByTimeAsync(8000)
    expect(pc.restartIce).not.toHaveBeenCalled()
    expect(keyframeAsks(pc)).toHaveLength(1)
    expect(FakePC.last).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(4000) // past the grace, still flat
    expect(FakePC.last).toHaveLength(2) // rebuilt
    await vi.advanceTimersByTimeAsync(60_000)
    expect(pc.restartIce).not.toHaveBeenCalled()
    expect(FakePC.last[1]!.restartIce).not.toHaveBeenCalled()
    expect(keyframeAsks(pc)).toHaveLength(1)
    mesh.close()
  })

  it("ends the episode without a rebuild when frames rise after the ask", async () => {
    const { mesh, pc, flow } = await connected("a", "b")
    await vi.advanceTimersByTimeAsync(8000)
    expect(keyframeAsks(pc)).toHaveLength(1)
    flow.decoded = 80 // the keyframe landed
    await vi.advanceTimersByTimeAsync(4000)
    expect(FakePC.last).toHaveLength(1)
    expect(pc.restartIce).not.toHaveBeenCalled()
    mesh.close()
  })

  it("asks for a keyframe without our own camera (no camera gate)", async () => {
    const made = await setupMesh("a", "b", {}, { getVideoTracks: () => [], getTracks: () => [] })
    const flow: Flow = { decoded: 50, received: 100, packetsPerRead: 40 }
    feed(made.pc, flow)
    made.pc.connectionState = "connected"
    made.pc.onconnectionstatechange!()
    const channel = made.pc.channels[0]!
    channel.readyState = "open"
    ;(channel.onopen as (() => void) | null)?.()
    await vi.advanceTimersByTimeAsync(12_000)
    expect(keyframeAsks(made.pc)).toHaveLength(1)
    made.mesh.close()
  })

  it("leaves a dead transport (packets flat too) to today's ladder: an ICE restart, no keyframe ask", async () => {
    const { mesh, pc, flow } = await connected("a", "b")
    flow.packetsPerRead = 0
    await vi.advanceTimersByTimeAsync(4000)
    await vi.advanceTimersByTimeAsync(8000)
    expect(pc.restartIce).toHaveBeenCalledTimes(1)
    expect(keyframeAsks(pc)).toHaveLength(0)
    mesh.close()
  })

  it("on the answerer's side asks after two frozen sweeps, as the initiator does, and rebuilds only at the sixth", async () => {
    const { mesh, pc } = await connected("b", "a")
    // the answerer's channel comes from the initiator: the actor's ask is what is counted here
    const commands = actorCommands(mesh)
    const asks = () => commands.filter(({ command }) => command.kind === "ask-keyframe")
    await vi.advanceTimersByTimeAsync(4000) // one flat sweep
    expect(asks()).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(4000) // the second: the ask, before the seat's 20 s budget
    expect(asks()).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(12_000) // the fifth flat sweep
    expect(FakePC.last).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(4000) // the sixth
    expect(FakePC.last).toHaveLength(2)
    expect(asks()).toHaveLength(1)
    expect(pc.restartIce).not.toHaveBeenCalled()
    mesh.close()
  })

  it("on the answerer's side leaves a dead transport to its six-sweep ICE restart", async () => {
    const { mesh, pc, flow } = await connected("b", "a")
    flow.packetsPerRead = 0
    await vi.advanceTimersByTimeAsync(20_000) // five flat sweeps
    expect(pc.restartIce).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(4000) // the sixth
    expect(pc.restartIce).toHaveBeenCalledTimes(1)
    expect(FakePC.last).toHaveLength(1)
    mesh.close()
  })

  it("asks nothing while the page is hidden", async () => {
    const { mesh, pc } = await connected("a", "b")
    await vi.advanceTimersByTimeAsync(4000)
    vi.stubGlobal("document", { visibilityState: "hidden" })
    await vi.advanceTimersByTimeAsync(20_000)
    expect(keyframeAsks(pc)).toHaveLength(0)
    expect(pc.restartIce).not.toHaveBeenCalled()
    mesh.close()
  })

  it("asks nothing of a peer that said it is away, or of a standby link", async () => {
    const { mesh, pc, channel } = await connected("a", "b")
    await vi.advanceTimersByTimeAsync(4000)
    // the peer says it stepped away
    ;(channel!.onmessage as (event: { data: Uint8Array }) => void)({ data: (await import("./away-frame")).encodeAway(true) })
    await vi.advanceTimersByTimeAsync(20_000)
    expect(keyframeAsks(pc)).toHaveLength(0)
    mesh.close()

    const second = await connected("a", "c")
    second.mesh.setStandby("c", true)
    await vi.advanceTimersByTimeAsync(24_000)
    expect(keyframeAsks(second.pc)).toHaveLength(0)
    second.mesh.close()
  })

  it("shows the seat healing from the ask through the rebuild, and not once frames rise", async () => {
    const { mesh, flow } = await connected("a", "b")
    await vi.advanceTimersByTimeAsync(4000)
    expect(seatOf(mesh, "b").healing).toBeFalsy()
    await vi.advanceTimersByTimeAsync(4000) // the ask
    expect(seatOf(mesh, "b").healing).toBe(true)
    await vi.advanceTimersByTimeAsync(4000) // the rebuild
    expect(FakePC.last).toHaveLength(2)
    expect(seatOf(mesh, "b").healing).toBe(true)
    // the rebuilt link connects and its frames rise
    const rebuilt = FakePC.last[1]!
    feed(rebuilt, flow)
    flow.decoded = 10
    rebuilt.connectionState = "connected"
    rebuilt.onconnectionstatechange!()
    await vi.advanceTimersByTimeAsync(4000)
    expect(seatOf(mesh, "b").healing).toBeFalsy()
    mesh.close()
  })

  it("clears the seat's heal mark when the rebuild fails too", async () => {
    const { mesh } = await connected("a", "b")
    await vi.advanceTimersByTimeAsync(16_000) // the ask, then the rebuild
    expect(FakePC.last).toHaveLength(2)
    expect(seatOf(mesh, "b").healing).toBe(true)
    const rebuilt = FakePC.last[1]!
    rebuilt.connectionState = "failed"
    rebuilt.onconnectionstatechange!()
    expect(seatOf(mesh, "b").healing).toBeFalsy()
    mesh.close()
  })

  it("clears the seat's heal mark when the rebuilt link connects but shows no frame for the reconnect budget", async () => {
    const { mesh, flow } = await connected("a", "b")
    await vi.advanceTimersByTimeAsync(16_000)
    const rebuilt = FakePC.last[1]!
    feed(rebuilt, { ...flow, decoded: 0, packetsPerRead: 0 })
    rebuilt.connectionState = "connected"
    rebuilt.onconnectionstatechange!()
    expect(seatOf(mesh, "b").healing).toBe(true)
    await vi.advanceTimersByTimeAsync(20_000)
    expect(seatOf(mesh, "b").healing).toBeFalsy()
    mesh.close()
  })
})

describe("a keyframe request from the peer (#1917, the sender)", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.advanceTimersByTime(60_000)
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  const deliver = (channel: { onmessage: unknown }) => (channel.onmessage as (event: { data: Uint8Array }) => void)({ data: encodeKeyframeRequest() })

  it("forces a keyframe on that link's video senders, at most once per grace", async () => {
    const onMessage: unknown[] = []
    const { mesh, pc, channel } = await connected("a", "b")
    ;(mesh as unknown as { onMessage: (peer: string, bytes: Uint8Array) => void }).onMessage = (_peer, bytes) => onMessage.push(bytes)
    const sender = videoSender(pc)
    deliver(channel!)
    await vi.advanceTimersByTimeAsync(1000)
    expect(sender.setParameters).toHaveBeenCalledTimes(2) // off, then on
    deliver(channel!) // a repeat inside the grace is ignored
    await vi.advanceTimersByTimeAsync(500)
    expect(sender.setParameters).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1000) // the grace is over
    deliver(channel!)
    await vi.advanceTimersByTimeAsync(1000)
    expect(sender.setParameters).toHaveBeenCalledTimes(4)
    // the frame is the mesh's own: the caller never sees it
    expect(onMessage).toHaveLength(0)
    mesh.close()
  })

  it("is ignored while our page is hidden", async () => {
    const { mesh, pc, channel } = await connected("a", "b")
    const sender = videoSender(pc)
    vi.stubGlobal("document", { visibilityState: "hidden" })
    deliver(channel!)
    await vi.advanceTimersByTimeAsync(1000)
    expect(sender.setParameters).not.toHaveBeenCalled()
    mesh.close()
  })

  it("is ignored on a standby link", async () => {
    const { mesh, pc, channel } = await connected("a", "b")
    mesh.setStandby("b", true)
    const sender = videoSender(pc)
    deliver(channel!)
    await vi.advanceTimersByTimeAsync(1000)
    expect(sender.setParameters).not.toHaveBeenCalled()
    mesh.close()
  })
})

describe("after code review (#1917)", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.advanceTimersByTime(60_000)
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  const deliver = (channel: { onmessage: unknown }) => (channel.onmessage as (event: { data: Uint8Array }) => void)({ data: encodeKeyframeRequest() })

  it("ignores a request while a forced keyframe is still in flight on that link, past the grace", async () => {
    const { mesh, pc, channel, flow } = await connected("a", "b")
    // the peer's video to us keeps flowing: no heal of ours replaces this link meanwhile
    const tick = setInterval(() => (flow.decoded += 10), 1000)
    const sender = videoSender(pc)
    sender.setParameters.mockImplementation(() => new Promise((resolve) => setTimeout(resolve, 3000)))
    const runs = vi.spyOn(mesh as unknown as { forceKeyframe: () => Promise<unknown> }, "forceKeyframe")
    deliver(channel!)
    await vi.advanceTimersByTimeAsync(2500) // past KEYFRAME_GRACE_MS, the first encoder write still pending
    expect(runs).toHaveBeenCalledTimes(1)
    deliver(channel!)
    await vi.advanceTimersByTimeAsync(100)
    expect(runs).toHaveBeenCalledTimes(1) // in flight: ignored
    await vi.advanceTimersByTimeAsync(15_000) // the first run settles
    deliver(channel!)
    await vi.advanceTimersByTimeAsync(100)
    expect(runs).toHaveBeenCalledTimes(2)
    clearInterval(tick)
    mesh.close()
  })

  it("catches a forced keyframe that throws", async () => {
    const { mesh, pc, channel } = await connected("a", "b")
    pc.getSenders = () => {
      throw new Error("senders gone")
    }
    const rejections: unknown[] = []
    const onRejection = (reason: unknown) => rejections.push(reason)
    process.on("unhandledRejection", onRejection)
    deliver(channel!)
    await vi.advanceTimersByTimeAsync(1000)
    vi.useRealTimers()
    await new Promise((resolve) => setTimeout(resolve, 20))
    process.off("unhandledRejection", onRejection)
    expect(rejections).toEqual([])
    mesh.close()
  })

  it("asks nothing of a peer whose own view says its camera is off", async () => {
    const { mesh, pc } = await connected("a", "b")
    const { VIEW } = await import("./link-view")
    ;(mesh as unknown as { views: Map<string, unknown> }).views.set("b", { row: "", codes: new Map([["b", VIEW.selfCameraOff]]), at: 1e12, unseenSince: -Infinity, seenSince: -Infinity })
    await vi.advanceTimersByTimeAsync(24_000)
    expect(keyframeAsks(pc)).toHaveLength(0)
    expect(FakePC.last).toHaveLength(1)
    expect(pc.restartIce).not.toHaveBeenCalled()
    mesh.close()
  })

  it("opens no heal and no seat mark for an ask that found no open channel; the rebuild opens them", async () => {
    const { mesh } = await connected("b", "a") // the answerer: no channel of its own in the fake
    const commands = actorCommands(mesh)
    await vi.advanceTimersByTimeAsync(8000)
    expect(commands.filter(({ command }) => command.kind === "ask-keyframe")).toHaveLength(1)
    expect(seatOf(mesh, "a").healing).toBeFalsy()
    await vi.advanceTimersByTimeAsync(16_000) // the sixth flat sweep: the rebuild
    expect(FakePC.last).toHaveLength(2)
    expect(seatOf(mesh, "a").healing).toBe(true)
    mesh.close()
  })
})

