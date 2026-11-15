// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { GatherTracker } from "./gather"
import { OfferClock } from "./offer-clock"
import { decodeChannelMessage, encodeChannelMessage } from "@jollity/statement-core"
import { AWAY_AFTER_MS, Mesh } from "./mesh"
import { backoffMs } from "./supervisor-timing"
import { USE_CASE_PEER_AWAY, encodeAway } from "./away-frame"
import { chromeStats, first } from "./test-stats"
import { VIDEO_RUNGS } from "./send-adaptation-classifier"
import { actorCommands, FakeChannel, FakePC, FakeVideoTrack, sdp, setupMesh, actorTakesMeshTimes } from "./test-pc"

describe("the peer data channel", () => {
  afterEach(() => vi.unstubAllGlobals())

  it("uses ordered fully reliable delivery for renegotiation frames", async () => {
    const { mesh, pc } = await setupMesh("a", "b")

    expect(pc.channelCreations).toEqual([{ label: "data", options: { ordered: true } }])
    expect(pc.channelCreations[0]?.options).not.toHaveProperty("maxRetransmits")
    mesh.close()
  })
})

describe("a connected open channel without inbound video", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.advanceTimersByTime(60_000)
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  const camera = () => {
    const track = new FakeVideoTrack("camera") as unknown as MediaStreamTrack
    Object.assign(track, { readyState: "live", enabled: true, muted: false })
    return { getVideoTracks: () => [track], getTracks: () => [track] } as unknown as MediaStream
  }

  it("rebuilds from the channel-open clock without depending on our own camera", async () => {
    const { mesh, pc } = await setupMesh("a", "b")
    pc.connectionState = "connected"
    pc.onconnectionstatechange?.()
    await vi.advanceTimersByTimeAsync(8_000)
    pc.channels[0]!.readyState = "open"
    pc.channels[0]!.onopen?.()
    pc.stats = new Map() as never

    await vi.advanceTimersByTimeAsync(15_999)
    expect(FakePC.last).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)

    expect(FakePC.last).toHaveLength(2)
    expect(pc.close).toHaveBeenCalledTimes(1)
    mesh.close()
  })

  it("logs the round's first video on the link rebuilt when the far end re-offers", async () => {
    const logs = vi.spyOn(console, "log").mockImplementation(() => {})
    const { mesh, pc } = await setupMesh("a", "b")
    mesh.setRound(0)
    await pc.onnegotiationneeded?.()
    await mesh.onRtc("b", { rtc: { desc: { type: "answer", sdp: sdp("111") } } } as never)
    const channel = pc.channels[0]!
    channel.readyState = "open"
    channel.onopen?.()
    pc.connectionState = "connected"
    pc.onconnectionstatechange?.()

    await mesh.onRtc("b", { rtc: { desc: { type: "offer", sdp: sdp("222") } } } as never)
    expect(FakePC.last).toHaveLength(2)
    const rebuilt = FakePC.last[1]!
    const offered = new FakeChannel()
    offered.readyState = "open"
    ;(rebuilt.ondatachannel as (event: { channel: FakeChannel }) => void)({ channel: offered })
    rebuilt.connectionState = "connected"
    rebuilt.onconnectionstatechange?.()
    rebuilt.stats = chromeStats({ t: 1, decoded: 1, lost: 0, received: 1, bytesSent: 1, freezes: 0, cpu: 0 }) as never
    await mesh.report()

    expect(logs.mock.calls.map((parts) => parts.join(" "))).toContain("[jollity-rtc] round-link stage=first-video round=1 peer=b")
    mesh.close()
  })

  it("rebuilds a peer at most once per round, even when the rebuilt link also has no video", async () => {
    const { mesh, pc } = await setupMesh("a", "b")
    mesh.setRound(1)
    pc.channels[0]!.readyState = "open"
    pc.channels[0]!.onopen?.()
    pc.connectionState = "connected"
    pc.onconnectionstatechange?.()
    pc.stats = new Map() as never
    await vi.advanceTimersByTimeAsync(16_000)
    expect(FakePC.last).toHaveLength(2)

    const rebuilt = FakePC.last[1]!
    rebuilt.channels[0]!.readyState = "open"
    rebuilt.channels[0]!.onopen?.()
    rebuilt.connectionState = "connected"
    rebuilt.onconnectionstatechange?.()
    rebuilt.stats = new Map() as never
    await vi.advanceTimersByTimeAsync(24_000)
    expect(FakePC.last).toHaveLength(2)

    mesh.setRound(2)
    await vi.advanceTimersByTimeAsync(4_000)
    expect(FakePC.last).toHaveLength(3)
    mesh.close()
  })

  it("also rebuilds when Chrome exposes the inbound stream but it stays at zero decoded frames", async () => {
    const { mesh, pc } = await setupMesh("a", "b", {}, camera())
    pc.channels[0]!.readyState = "open"
    pc.channels[0]!.onopen?.()
    pc.connectionState = "connected"
    pc.onconnectionstatechange?.()
    pc.stats = chromeStats({ t: 1, decoded: 0, lost: 0, received: 0, bytesSent: 1, freezes: 0, cpu: 0 }) as never

    await vi.advanceTimersByTimeAsync(20_000)

    expect(FakePC.last).toHaveLength(2)
    mesh.close()
  })

  it("does not rebuild a clean link whose decoded frames keep advancing", async () => {
    const { mesh, pc } = await setupMesh("a", "b", {}, camera())
    pc.channels[0]!.readyState = "open"
    pc.channels[0]!.onopen?.()
    pc.connectionState = "connected"
    pc.onconnectionstatechange?.()
    for (let sample = 1; sample <= 7; sample++) {
      pc.stats = chromeStats({ t: sample * 3_000, decoded: sample, lost: 0, received: sample, bytesSent: sample, freezes: 0, cpu: 0 }) as never
      await vi.advanceTimersByTimeAsync(3_000)
    }

    expect(FakePC.last).toHaveLength(1)
    mesh.close()
  })

  it("bounds a connected link whose data channel never opens and rebuilds it at most once per round", async () => {
    const logs = vi.spyOn(console, "log").mockImplementation(() => {})
    const { mesh, pc } = await setupMesh("a", "b", {}, camera())
    mesh.setRound(1)
    pc.connectionState = "connected"
    pc.onconnectionstatechange?.()
    pc.stats = new Map() as never

    await vi.advanceTimersByTimeAsync(23_999)
    expect(FakePC.last).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)

    expect(FakePC.last).toHaveLength(2)
    expect(logs.mock.calls.map((parts) => parts.join(" "))).toContain(
      "[jollity-rtc] channel-stall: never-open peer=b signalingState=stable round=2 → rebuild",
    )

    const rebuilt = FakePC.last[1]!
    rebuilt.connectionState = "connected"
    rebuilt.onconnectionstatechange?.()
    rebuilt.stats = new Map() as never
    await vi.advanceTimersByTimeAsync(30_000)
    expect(FakePC.last).toHaveLength(2)

    mesh.setRound(2)
    await vi.advanceTimersByTimeAsync(3_000)
    expect(FakePC.last).toHaveLength(3)
    mesh.close()
  })

  it("starts a fresh no-video grace window when a dropped open link reconnects", async () => {
    const { mesh, pc } = await setupMesh("a", "b")
    pc.channels[0]!.readyState = "open"
    pc.channels[0]!.onopen?.()
    pc.connectionState = "connected"
    pc.onconnectionstatechange?.()
    pc.stats = new Map() as never

    await vi.advanceTimersByTimeAsync(12_000)
    pc.connectionState = "disconnected"
    pc.onconnectionstatechange?.()
    expect((mesh as unknown as { conns: Map<string, { channelOpenAt: number }> }).conns.get("b")?.channelOpenAt).toBe(0)
    pc.connectionState = "connected"
    pc.onconnectionstatechange?.()

    await vi.advanceTimersByTimeAsync(15_999)
    expect(FakePC.last).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)

    expect(FakePC.last).toHaveLength(2)
    mesh.close()
  })
})

describe("Mesh.report", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.advanceTimersByTime(60_000) // a device that has been up a while: the monotonic clock reads well above 0
  })
  afterEach(() => vi.useRealTimers())

  it("calls getStats once per peer per report, as before, and carries the quality sample", async () => {
    const mesh = new Mesh("a", { getVideoTracks: () => [] } as unknown as MediaStream, {}, () => {}, () => {}, () => {}, () => {}, {})
    const getStats = vi.fn(async () => first as unknown as RTCStatsReport)
    const pc = {
      connectionState: "connected",
      iceConnectionState: "connected",
      iceGatheringState: "complete",
      signalingState: "stable",
      getSenders: () => [],
      getReceivers: () => [],
      getStats,
      close: () => {},
    }
    const conns = (mesh as unknown as { conns: Map<string, { pc: typeof pc; gather: GatherTracker }> }).conns
    conns.set("b", { pc, gather: new GatherTracker() })
    conns.set("c", { pc: { ...pc }, gather: new GatherTracker() })
    const rows = await mesh.report()
    expect(getStats).toHaveBeenCalledTimes(2)
    expect(rows.map((row) => [row.id, row.pair, row.frames, row.quality?.rttMs])).toEqual([
      ["b", "relay/srflx", 200, expect.closeTo(182)],
      ["c", "relay/srflx", 200, expect.closeTo(182)],
    ])
    // the same connection keeps its link number; another one has its own
    const again = await mesh.report()
    expect(getStats).toHaveBeenCalledTimes(4)
    expect(again[0].quality?.link).toBe(rows[0].quality?.link)
    expect(rows[1].quality?.link).not.toBe(rows[0].quality?.link)
    mesh.close()
  })

  it("carries matching inbound-video sender-report clock evidence from that same stats read", async () => {
    const mesh = new Mesh("a", { getVideoTracks: () => [] } as unknown as MediaStream, {}, () => {}, () => {}, () => {}, () => {}, {})
    const report = new Map([
      ["inbound-video", { id: "inbound-video", type: "inbound-rtp", kind: "video", remoteId: "sender-report" }],
      ["sender-report", { id: "sender-report", type: "remote-outbound-rtp", remoteTimestamp: 10_000, timestamp: 14_800, roundTripTime: 0.08 }],
    ]) as unknown as RTCStatsReport
    const pc = {
      connectionState: "connected", iceConnectionState: "connected", iceGatheringState: "complete", signalingState: "stable",
      getSenders: () => [], getReceivers: () => [], getStats: vi.fn(async () => report), close: () => {},
    }
    ;(mesh as unknown as { conns: Map<string, { pc: typeof pc; gather: GatherTracker }> }).conns.set("b", { pc, gather: new GatherTracker() })

    const [row] = await mesh.report()
    expect(pc.getStats).toHaveBeenCalledTimes(1)
    expect(row?.rtcpClock).toEqual({ samples: [expect.objectContaining({ offsetMs: 4_760, rttMs: 80, source: "remote-outbound-rtp" })] })
    mesh.close()
  })

  it("contains a throwing stats read and carries its unavailable reason", async () => {
    const mesh = new Mesh("a", { getVideoTracks: () => [] } as unknown as MediaStream, {}, () => {}, () => {}, () => {}, () => {}, {})
    const pc = {
      connectionState: "connected", iceConnectionState: "connected", iceGatheringState: "complete", signalingState: "stable",
      getSenders: () => [], getReceivers: () => [], getStats: vi.fn(async () => { throw new Error("closed") }), close: () => {},
    }
    ;(mesh as unknown as { conns: Map<string, { pc: typeof pc; gather: GatherTracker }> }).conns.set("b", { pc, gather: new GatherTracker() })

    await expect(mesh.report()).resolves.toEqual([expect.objectContaining({
      id: "b", statsLink: 1, rtcpClock: { samples: [], unavailableReason: "stats-threw" },
    })])
    mesh.close()
  })
})

describe("adaptive video rungs", () => {
  const camera = (width = 720, height = 1280) => {
    const track = new FakeVideoTrack("camera", width, height) as unknown as MediaStreamTrack
    return { getVideoTracks: () => [track], getTracks: () => [track] } as unknown as MediaStream
  }

  it("applies one rung to every live sender and inherits it through stable signalling", async () => {
    const results: unknown[] = []
    const { mesh, pc } = await setupMesh("a", "b", { onVideoRungResult: (result) => results.push(result) }, camera())
    pc.channels[0]!.readyState = "open"
    pc.channels[0]!.onopen?.()
    await mesh.whenVideoRungSettled()

    await expect(mesh.applyVideoRung(VIDEO_RUNGS[2]!)).resolves.toMatchObject({
      requested: 2,
      senders: [{ id: "b:0", status: "applied" }],
      uniform: true,
    })
    expect(pc.senders[0]!.parameters.encodings[0]).toMatchObject({ maxBitrate: 140_000, scaleResolutionDownBy: 3, maxFramerate: 18 })

    pc.signalingState = "have-local-offer"
    pc.dispatch("signalingstatechange")
    pc.signalingState = "stable"
    pc.dispatch("signalingstatechange")
    await mesh.whenVideoRungSettled()
    expect(pc.senders[0]!.parameters.encodings[0]).toMatchObject({ maxBitrate: 140_000, scaleResolutionDownBy: 3, maxFramerate: 18 })
    expect(results.length).toBeGreaterThan(0)
    mesh.close()
  })

  it("reports only connected peers that currently hold a video sender", async () => {
    const counts: number[] = []
    const { mesh, pc } = await setupMesh("a", "b", { onActiveVideoSendersChanged: (count) => counts.push(count) }, camera())
    pc.channels[0]!.readyState = "open"
    pc.channels[0]!.onopen?.()
    expect(counts.at(-1)).toBe(0)
    pc.connectionState = "connected"
    pc.onconnectionstatechange?.()
    expect(counts.at(-1)).toBe(1)
    pc.connectionState = "connecting"
    pc.onconnectionstatechange?.()
    expect(counts.at(-1)).toBe(0)
    mesh.close()
  })

  it("returns pending for Safari-style empty encodings, then applies on stable", async () => {
    const { mesh, pc } = await setupMesh("a", "b", {}, camera())
    pc.channels[0]!.readyState = "open"
    pc.channels[0]!.onopen?.()
    await mesh.whenVideoRungSettled()
    const sender = pc.senders[0]!
    sender.emptyBeforeStable = true
    pc.signalingState = "have-local-offer"
    await expect(mesh.applyVideoRung(VIDEO_RUNGS[3]!)).resolves.toMatchObject({ senders: [{ status: "pending" }], uniform: false })
    pc.signalingState = "stable"
    pc.dispatch("signalingstatechange")
    await mesh.whenVideoRungSettled()
    expect(sender.parameters.encodings[0]).toMatchObject({ maxBitrate: 80_000, scaleResolutionDownBy: 4, maxFramerate: 12 })
    mesh.close()
  })

  it("falls back from optional sender fields without discarding bitrate success", async () => {
    const { mesh, pc } = await setupMesh("a", "b", {}, camera())
    pc.channels[0]!.readyState = "open"
    pc.channels[0]!.onopen?.()
    await mesh.whenVideoRungSettled()
    pc.senders[0]!.rejectOnce.add("maxFramerate")
    await expect(mesh.applyVideoRung(VIDEO_RUNGS[3]!)).resolves.toMatchObject({
      senders: [{ status: "partial", appliedFields: ["maxBitrate", "scaleResolutionDownBy"], refusedFields: ["maxFramerate"] }],
      uniform: false,
    })
    expect(pc.senders[0]!.parameters.encodings[0]).toMatchObject({ maxBitrate: 80_000, scaleResolutionDownBy: 4 })
    mesh.close()
  })

  it("recomputes scale after a camera reopen", async () => {
    const { mesh, pc } = await setupMesh("a", "b", {}, camera())
    pc.channels[0]!.readyState = "open"
    pc.channels[0]!.onopen?.()
    await mesh.applyVideoRung(VIDEO_RUNGS[3]!)
    expect(pc.senders[0]!.parameters.encodings[0].scaleResolutionDownBy).toBe(4)
    await mesh.setLocalStream(camera(360, 360))
    expect(pc.senders[0]!.parameters.encodings[0].scaleResolutionDownBy).toBe(2)
    mesh.close()
  })

  it("skips an idempotent rung write", async () => {
    const { mesh, pc } = await setupMesh("a", "b", {}, camera())
    pc.channels[0]!.readyState = "open"
    pc.channels[0]!.onopen?.()
    await mesh.whenVideoRungSettled()
    await mesh.applyVideoRung(VIDEO_RUNGS[2]!)
    const writes = pc.senders[0]!.setParameters.mock.calls.length
    await mesh.applyVideoRung(VIDEO_RUNGS[2]!)
    expect(pc.senders[0]!.setParameters).toHaveBeenCalledTimes(writes)
    mesh.close()
  })

  it("bounds a hung sender write so later writes can proceed", async () => {
    vi.useFakeTimers()
    const { mesh, pc } = await setupMesh("a", "b", {}, camera())
    pc.channels[0]!.readyState = "open"
    pc.channels[0]!.onopen?.()
    await mesh.whenVideoRungSettled()
    const sender = pc.senders[0]!
    sender.setParameters.mockImplementationOnce(() => new Promise<void>(() => {}))
    const hung = mesh.applyVideoRung(VIDEO_RUNGS[2]!)
    const rejected = expect(hung).rejects.toThrow("sender write timed out")
    await vi.advanceTimersByTimeAsync(5_001)
    await rejected
    await expect(mesh.applyVideoRung(VIDEO_RUNGS[3]!)).resolves.toMatchObject({ requested: 3 })
    mesh.close()
    vi.useRealTimers()
  })

  it("does not let a timed-out old rung retry after a newer rung applies", async () => {
    vi.useFakeTimers()
    const { mesh, pc } = await setupMesh("a", "b", {}, camera())
    pc.channels[0]!.readyState = "open"
    pc.channels[0]!.onopen?.()
    await mesh.whenVideoRungSettled()
    const sender = pc.senders[0]!
    const writes: number[] = []
    sender.setParameters.mockImplementationOnce(
      (parameters) =>
        new Promise<void>((_, reject) => {
          writes.push(parameters.encodings[0]!.maxBitrate!)
          setTimeout(() => reject(new DOMException("late old-rung rejection", "InvalidModificationError")), 6_000)
        }),
    )
    const old = mesh.applyVideoRung(VIDEO_RUNGS[2]!)
    const oldRejected = expect(old).rejects.toThrow("sender write timed out")
    await vi.advanceTimersByTimeAsync(5_001)
    await oldRejected
    sender.setParameters.mockImplementation(async (parameters) => {
      writes.push(parameters.encodings[0]!.maxBitrate!)
      sender.parameters = structuredClone(parameters)
    })
    await mesh.applyVideoRung(VIDEO_RUNGS[3]!)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(writes).toEqual([140_000, 80_000])
    expect(sender.parameters.encodings[0]!.maxBitrate).toBe(80_000)
    mesh.close()
    vi.useRealTimers()
  })

  it("repairs the current rung when a timed-out write lands after six seconds", async () => {
    vi.useFakeTimers()
    const { mesh, pc } = await setupMesh("a", "b", {}, camera())
    pc.channels[0]!.readyState = "open"
    pc.channels[0]!.onopen?.()
    await mesh.whenVideoRungSettled()
    const sender = pc.senders[0]!
    sender.setParameters.mockImplementationOnce(
      (parameters) =>
        new Promise<void>((resolve) => {
          setTimeout(() => {
            sender.parameters = structuredClone(parameters)
            resolve()
          }, 6_000)
        }),
    )
    const old = mesh.applyVideoRung(VIDEO_RUNGS[2]!)
    const oldRejected = expect(old).rejects.toThrow("sender write timed out")
    await vi.advanceTimersByTimeAsync(5_001)
    await oldRejected
    await mesh.applyVideoRung(VIDEO_RUNGS[3]!)

    // Reproduce a blocked ordinary mutation lane when the old write lands.
    ;(mesh as unknown as { senderWrites: WeakMap<RTCRtpSender, Promise<void>> }).senderWrites.set(
      sender as unknown as RTCRtpSender,
      new Promise<void>(() => {}),
    )
    await vi.advanceTimersByTimeAsync(1_000)

    expect(mesh.videoRung()).toBe(3)
    expect(sender.parameters.encodings[0]).toMatchObject({ maxBitrate: 80_000, scaleResolutionDownBy: 4, maxFramerate: 12 })
    mesh.close()
    vi.useRealTimers()
  })

  it("bounds a rung queued behind a hung track swap", async () => {
    vi.useFakeTimers()
    const { mesh, pc } = await setupMesh("a", "b", {}, camera())
    pc.channels[0]!.readyState = "open"
    pc.channels[0]!.onopen?.()
    await mesh.whenVideoRungSettled()
    const sender = pc.senders[0]!
    sender.replaceTrack.mockImplementationOnce(() => new Promise<void>(() => {}))
    const internals = mesh as unknown as {
      conns: Map<string, { swapping: boolean }>
      swapTrack: (conn: { swapping: boolean }, sender: RTCRtpSender) => Promise<void>
    }
    const conn = internals.conns.get("b")!
    let swapOutcome = "pending"
    void internals.swapTrack(conn, sender as unknown as RTCRtpSender).then(
      () => {
        swapOutcome = "resolved"
      },
      () => {
        swapOutcome = "rejected"
      },
    )
    let rungOutcome = "pending"
    void mesh.applyVideoRung(VIDEO_RUNGS[2]!).then(
      () => {
        rungOutcome = "resolved"
      },
      () => {
        rungOutcome = "rejected"
      },
    )
    expect(conn.swapping).toBe(true)
    await vi.advanceTimersByTimeAsync(5_001)
    expect(swapOutcome).toBe("rejected")
    expect(rungOutcome).toBe("rejected")
    expect(conn.swapping).toBe(false)
    mesh.close()
    vi.useRealTimers()
  })

  it("restores the current track when a timed-out removal lands after six seconds", async () => {
    vi.useFakeTimers()
    const stream = camera()
    const expectedTrack = stream.getVideoTracks()[0]!
    const { mesh, pc } = await setupMesh("a", "b", {}, stream)
    pc.channels[0]!.readyState = "open"
    pc.channels[0]!.onopen?.()
    await mesh.whenVideoRungSettled()
    const sender = pc.senders[0]!
    sender.replaceTrack.mockImplementationOnce(
      (track) =>
        new Promise<void>((resolve) => {
          setTimeout(() => {
            sender.track = track
            sender.replacements.push(track)
            resolve()
          }, 6_000)
        }),
    )
    const internals = mesh as unknown as {
      conns: Map<string, { swapping: boolean }>
      senderWrites: WeakMap<RTCRtpSender, Promise<void>>
      swapTrack: (conn: { swapping: boolean }, sender: RTCRtpSender) => Promise<void>
    }
    const conn = internals.conns.get("b")!
    const swap = internals.swapTrack(conn, sender as unknown as RTCRtpSender)
    const swapRejected = expect(swap).rejects.toThrow("sender write timed out")
    await vi.advanceTimersByTimeAsync(5_001)
    await swapRejected
    expect(conn.swapping).toBe(false)

    // Reproduce a blocked ordinary mutation lane when the late null lands.
    internals.senderWrites.set(sender as unknown as RTCRtpSender, new Promise<void>(() => {}))
    await vi.advanceTimersByTimeAsync(1_000)

    expect(sender.track).toBe(expectedTrack)
    mesh.close()
    vi.useRealTimers()
  })
})

// ── a player who left shows as away, and the self-heal leaves them alone (#229) ──
// The mesh is driven through its private parts here, the way the report test
// above does: a real RTCPeerConnection needs a browser, and what is under test
// is the mesh's own bookkeeping.
type Internals = {
  conns: Map<string, Record<string, unknown>>
  attachChannel: (peerId: string, conn: Record<string, unknown>, channel: unknown) => void
  supervise: () => void
  rebuildPeer: (peerId: string) => void
  startActor: (peerId: string, conn: Record<string, unknown>) => void
}

/** The peers the actor heals from now (an ICE restart or a rebuild), in
 *  order. The heals are held, not run: the hand-built connections here have
 *  no RTCPeerConnection to rebuild with. */
function heals(mesh: Mesh) {
  const commands = actorCommands(mesh, ["restart-ice", "replace-connection"])
  return () => commands.flatMap(({ peer, command }) => command.kind === "restart-ice" || command.kind === "replace-connection" ? [peer] : [])
}

function fakeChannel() {
  const channel = { readyState: "open", binaryType: "", send: vi.fn(), close: vi.fn(), onopen: null, onclose: null, onmessage: null as null | ((e: { data: unknown }) => void) }
  return channel
}

function setup(peerIds: string[] = ["b"], connectionState: RTCPeerConnectionState = "connected") {
  const away = vi.fn()
  const messages = vi.fn()
  const mesh = new Mesh("a", { getVideoTracks: () => [], getTracks: () => [] } as unknown as MediaStream, {}, () => {}, () => {}, () => {}, messages, { onAway: away })
  const internals = mesh as unknown as Internals
  // hand-built connections whose times the scenarios back-date: the actor takes them
  actorTakesMeshTimes(mesh)
  const channels: Record<string, ReturnType<typeof fakeChannel>> = {}
  for (const id of peerIds) {
    const channel = fakeChannel()
    channels[id] = channel
    const conn: Record<string, unknown> = {
      pc: { connectionState, getSenders: () => [1], restartIce: vi.fn(), close: vi.fn() },
      channel: null, outbox: [], everConnected: true, gaveEndpoint: true,
      lastSignalAt: performance.now(), createdAt: performance.now(), disconnectedAt: 0, downAt: 0,
      makingOffer: false, ignoreOffer: false, polite: false, pendingCands: [], offer: new OfferClock(), decisionConnectionEpoch: 1, away: null,
    }
    internals.conns.set(id, conn)
    internals.startActor(id, conn) // as addPeer does: the actor decides for this peer
    internals.attachChannel(id, conn, channel)
  }
  return { mesh, internals, away, messages, channels }
}

/** what a peer's phone puts on the channel when it says away / back */
const frame = (away: boolean) => encodeAway(away)

describe("a peer who says it is away", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.advanceTimersByTime(60_000) // a device that has been up a while: the monotonic clock reads well above 0
  })
  afterEach(() => vi.useRealTimers())

  it("is marked away, and the supervisor stops healing it", () => {
    const { mesh, internals, away, channels, messages } = setup(["b"], "disconnected")
    const conn = internals.conns.get("b")!
    conn.disconnectedAt = performance.now() - 20_000
    conn.downAt = performance.now() - 20_000
    channels.b.onmessage!({ data: frame(true).buffer })
    expect(away).toHaveBeenCalledWith("b", "said")
    expect(messages).not.toHaveBeenCalled() // the mesh's own lane: the caller never sees it
    const recover = heals(mesh)
    internals.supervise()
    expect(recover()).toEqual([])
    mesh.close()
  })

  it("is healed again once it says back", () => {
    const { mesh, internals, away, channels } = setup(["b"], "disconnected")
    const conn = internals.conns.get("b")!
    conn.disconnectedAt = performance.now() - 20_000
    conn.downAt = performance.now() - 20_000
    channels.b.onmessage!({ data: frame(true).buffer })
    channels.b.onmessage!({ data: frame(false).buffer })
    expect(away).toHaveBeenLastCalledWith("b", null)
    const recover = heals(mesh)
    internals.supervise()
    expect(recover()).toEqual(["b"])
    mesh.close()
  })

  it("an offer from an away peer clears it, and the offer is still applied", async () => {
    const { mesh, internals, away, channels } = setup(["b"], "disconnected")
    channels.b.onmessage!({ data: frame(true).buffer })
    const conn = internals.conns.get("b") as { pc: Record<string, unknown> }
    conn.pc.setRemoteDescription = vi.fn(async () => {})
    conn.pc.setLocalDescription = vi.fn(async () => {})
    conn.pc.iceGatheringState = "complete"
    conn.pc.signalingState = "stable"
    conn.pc.localDescription = { type: "answer", sdp: "x" }
    await mesh.onRtc("b", { rtc: { desc: { type: "offer", sdp: "v=0" } } } as never)
    expect(away).toHaveBeenLastCalledWith("b", null)
    expect(conn.pc.setRemoteDescription).toHaveBeenCalled()
    mesh.close()
  })

  it("a message it does not know is handed on, marks nobody away and throws nothing", () => {
    const { mesh, away, channels, messages } = setup()
    const other = new Uint8Array(encodeChannelMessage({ id: "some_other_use_case", data: new Uint8Array([1]) }))
    expect(() => channels.b.onmessage!({ data: other.buffer })).not.toThrow()
    expect(() => channels.b.onmessage!({ data: new Uint8Array([9, 9, 9]).buffer })).not.toThrow()
    expect(away).not.toHaveBeenCalled()
    expect(messages).toHaveBeenCalledTimes(2)
    mesh.close()
  })
})

describe("a link that stays down", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.advanceTimersByTime(60_000) // a device that has been up a while: the monotonic clock reads well above 0
  })
  afterEach(() => vi.useRealTimers())

  it("marks the peer away after AWAY_AFTER_MS, and keeps healing while they are still heard (#245's deadlock)", () => {
    const { mesh, internals, away } = setup(["b"], "disconnected")
    const conn = internals.conns.get("b")!
    const recover = heals(mesh)
    conn.disconnectedAt = performance.now() - (AWAY_AFTER_MS - 1000)
    conn.downAt = performance.now() - (AWAY_AFTER_MS - 1000)
    internals.supervise()
    expect(away).not.toHaveBeenCalled() // a blip is still a blip
    conn.disconnectedAt = performance.now() - (AWAY_AFTER_MS + 1000)
    conn.downAt = performance.now() - (AWAY_AFTER_MS + 1000)
    internals.supervise()
    expect(away).toHaveBeenCalledWith("b", "timeout")
    const before = recover().length
    vi.advanceTimersByTime(backoffMs(before)) // past the actor's backoff
    conn.lastSignalAt = performance.now()
    internals.supervise()
    expect(recover().slice(before)).toEqual(["b"]) // their hellos still come: they have not left
    mesh.close()
  })

  it("stops healing a peer not heard for PRESENCE_FRESH whose link dropped long ago", () => {
    const { mesh, internals } = setup(["b"], "disconnected")
    const conn = internals.conns.get("b")!
    const recover = heals(mesh)
    conn.lastSignalAt = performance.now() - 46_000
    conn.disconnectedAt = performance.now() - 31_000
    conn.downAt = performance.now() - 31_000
    internals.supervise()
    expect(recover()).toEqual([])
    mesh.close()
  })

  it("a peer heard again after a silence is back: the away mark goes, and the next sweep heals it", () => {
    const { mesh, internals, away } = setup(["b"], "disconnected")
    const conn = internals.conns.get("b")!
    const recover = heals(mesh)
    conn.lastSignalAt = performance.now() - 50_000
    conn.disconnectedAt = performance.now() - 55_000
    conn.downAt = performance.now() - 55_000
    internals.supervise()
    expect(away).toHaveBeenLastCalledWith("b", "timeout")
    expect(recover()).toEqual([])
    mesh.markSeen("b")
    expect(away).toHaveBeenLastCalledWith("b", null)
    internals.supervise()
    expect(recover()).toEqual(["b"])
    mesh.close()
  })

  it("our page back in front clears the timed-out marks and sweeps at once", () => {
    const { mesh, internals, away } = setup(["b"], "disconnected")
    const conn = internals.conns.get("b")!
    const recover = heals(mesh)
    conn.disconnectedAt = performance.now() - 20_000
    conn.downAt = performance.now() - (AWAY_AFTER_MS + 1000)
    internals.supervise() // marked away, and a first heal: the actor now backs off
    expect(away).toHaveBeenLastCalledWith("b", "timeout")
    expect(recover()).toEqual(["b"])
    internals.supervise()
    expect(recover()).toEqual(["b"]) // backing off: the sweep alone waits
    mesh.setSelfAway(false, 20_000) // back after a long absence
    expect(away).toHaveBeenLastCalledWith("b", null)
    expect(recover()).toEqual(["b", "b"])
    mesh.close()
  })

  it("a peer that never connected is not away", () => {
    const { mesh, internals, away } = setup(["b"], "new")
    const conn = internals.conns.get("b")!
    conn.everConnected = false
    conn.downAt = performance.now() - 60_000
    internals.supervise()
    expect(away).not.toHaveBeenCalled()
    mesh.close()
  })

  it("a link that comes back by itself clears the mark, and only the state change does it", async () => {
    // a real addPeer, so the PC's own state handler is the one under test
    class FakePc {
      connectionState = "new"
      getSenders = () => [1]
      createDataChannel = () => fakeChannel()
      close = () => {}
    }
    vi.stubGlobal("RTCPeerConnection", FakePc)
    vi.resetModules()
    const { Mesh: Fresh } = await import("./mesh")
    const away = vi.fn()
    const mesh = new Fresh("a", { getVideoTracks: () => [], getTracks: () => [] } as unknown as MediaStream, {}, () => {}, () => {}, () => {}, () => {}, { onAway: away })
    mesh.addPeer("b")
    const internals = mesh as unknown as Internals
    // the link "was up" by hand, with no connected fact: the actor takes Mesh's times
    actorTakesMeshTimes(mesh)
    const conn = internals.conns.get("b") as { everConnected: boolean; pc: { connectionState: string; onconnectionstatechange: () => void } }
    conn.everConnected = true
    conn.pc.connectionState = "disconnected"
    conn.pc.onconnectionstatechange()
    vi.advanceTimersByTime(AWAY_AFTER_MS + 1000)
    internals.supervise()
    expect(away).toHaveBeenLastCalledWith("b", "timeout")
    // the sweeps that ran meanwhile may have rebuilt the PC: take the live one
    const live = internals.conns.get("b") as typeof conn
    live.pc.connectionState = "connected"
    internals.supervise() // the sweep does not clear it
    expect(away).toHaveBeenLastCalledWith("b", "timeout")
    live.pc.onconnectionstatechange()
    expect(away).toHaveBeenLastCalledWith("b", null)
    mesh.close()
    vi.unstubAllGlobals()
  })
})

describe("this phone leaving", () => {
  it("says away on every open channel, and back when it returns", () => {
    const { mesh, channels } = setup(["b", "c"])
    mesh.setSelfAway(true)
    expect(channels.b.send).toHaveBeenCalledTimes(1)
    expect(channels.c.send).toHaveBeenCalledTimes(1)
    expect(decodeChannelMessage(channels.b.send.mock.calls[0][0])).toMatchObject({ id: USE_CASE_PEER_AWAY, data: new Uint8Array([1]) })
    mesh.setSelfAway(false)
    expect(decodeChannelMessage(channels.c.send.mock.calls[1][0])).toMatchObject({ id: USE_CASE_PEER_AWAY, data: new Uint8Array([0]) })
    mesh.close()
  })

  it("skips a channel that is not open, and tells it on opening", () => {
    const { mesh, internals } = setup(["b"])
    const late = fakeChannel()
    late.readyState = "connecting"
    internals.attachChannel("b", internals.conns.get("b")!, late)
    mesh.setSelfAway(true)
    expect(late.send).not.toHaveBeenCalled()
    late.readyState = "open"
    ;(late.onopen as unknown as () => void)()
    expect(late.send).toHaveBeenCalledTimes(1)
    expect(decodeChannelMessage(late.send.mock.calls[0][0])).toMatchObject({ id: USE_CASE_PEER_AWAY, data: new Uint8Array([1]) })
    mesh.close()
  })

  it("says nothing twice for the same state", () => {
    const { mesh, channels } = setup(["b"])
    mesh.setSelfAway(true)
    mesh.setSelfAway(true)
    expect(channels.b.send).toHaveBeenCalledTimes(1)
    mesh.close()
  })
})

// ── a page that has just loaded: the monotonic clock reads near 0 (#319) ──
// "never happened" must not look like "just happened" however young the page is.
describe("the supervisor on a freshly loaded page", () => {
  beforeEach(() => vi.useFakeTimers()) // no advance: uptime is 0
  afterEach(() => vi.useRealTimers())

  it("does not chase a roster peer it has never seen or heard from", () => {
    const { mesh, internals } = setup(["b"], "failed")
    const conn = internals.conns.get("b")!
    Object.assign(conn, { everConnected: false, lastSignalAt: -Infinity, createdAt: -100_000 })
    const recover = heals(mesh)
    internals.supervise()
    expect(recover()).toEqual([])
    mesh.close()
  })

  it("makes a first recovery attempt at once, with no earlier attempt to back off from", () => {
    const { mesh, internals } = setup(["b"], "failed")
    const recover = heals(mesh)
    internals.supervise()
    expect(recover()).toEqual(["b"])
    mesh.close()
  })
})
