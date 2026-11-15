// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it, vi } from "vitest"
import { ReplayReceiverObserver } from "./replay-receiver"
import type { InboundVideo, RtcSample } from "../webrtc/rtc-stats"

const scope = { roomKey: "game-17-round-0", selfId: "self", meshGeneration: 1 }
const sample = (at: number, incoming: Partial<InboundVideo> = {}, rest: Partial<RtcSample> = {}): RtcSample => ({
  link: 1, at, transportId: "pair-1", localType: "relay", remoteType: "srflx", protocol: "udp",
  inbound: { id: "in-1", width: 640, height: 480, fps: 30, framesDecoded: at * .03, packetsReceived: at, codec: "H264", ...incoming },
  ...rest,
})
const setup = (context = scope) => {
  const emit = vi.fn<(payload: Record<string, unknown>) => void>()
  const observer = new ReplayReceiverObserver(context, emit)
  const observe = (quality: RtcSample | undefined, now = quality?.at ?? 0, hidden = false, peer = "peer") => observer.observe([{ id: peer, quality }], now, hidden, 17, 0)
  return { emit, observer, observe, last: () => emit.mock.calls.at(-1)![0] }
}

describe("passive replay receiver evidence", () => {
  it("does not attribute an asynchronous poll straddling rounds to either round", () => {
    const { observer, last } = setup()
    observer.observe([{ id: "peer", quality: sample(3000) }], 3000, false, 17, 1, {
      startedMonotonicMs: 2500, completedMonotonicMs: 3000, roundAtRequest: 0, roundAtCompletion: 1,
    })
    expect(last()).toMatchObject({ round: null, poll: { roundAtRequest: 0, roundAtCompletion: 1 } })
  })
  it("captures first/change and bounded heartbeat, ignoring FPS jitter within a bucket", () => {
    const { observe, emit, last } = setup()
    observe(sample(0))
    expect(last()).toMatchObject({ reason: "first-observation", direction: "incoming", peerId: "peer", ...scope, fps: 30, fpsSource: "reported", decoding: "decoding" })
    for (const at of [3_000, 6_000, 9_000, 12_000]) observe(sample(at, { fps: 29 }))
    expect(emit).toHaveBeenCalledTimes(1)
    observe(sample(15_000, { fps: 28 }))
    expect(last()).toMatchObject({ reason: "heartbeat", reportedFps: 28, fps: 28, derivedFps: 30, windowMs: 3_000, windowStartTimestampMs: 12_000, windowEndTimestampMs: 15_000 })
    observe(sample(18_000, { width: 320, height: 240, fps: 12, codec: "VP8" }, { transportId: "pair-2" }))
    expect(emit).toHaveBeenCalledTimes(3)
    expect(last()).toMatchObject({ reason: "observed-change", width: 320, height: 240, fps: 12, fpsBucket: "8-15", codec: "VP8", path: { pairId: "pair-2" } })
    expect(last()).not.toHaveProperty("cause")
  })

  it("never uses outgoing dimensions/FPS as receiver quality", () => {
    const { observe, last } = setup()
    observe(sample(0, {}, { inbound: undefined, outbound: { id: "out", width: 1920, height: 1080, fps: 60 } }))
    expect(last()).toMatchObject({ inbound: false, sampleState: "missing", fpsBucket: "unknown", decoding: "unknown", counters: {} })
    expect(last().width).toBeUndefined()
    expect(last().fps).toBeUndefined()
  })

  it("retains explicit zero but never converts missing FPS/counters into zero", () => {
    const { observe, last } = setup()
    observe(sample(0, { fps: undefined, framesDecoded: undefined, packetsReceived: undefined }))
    observe(sample(3_000, { fps: undefined, framesDecoded: undefined, packetsReceived: undefined }))
    expect(last()).toMatchObject({ fpsBucket: "unknown", decoding: "unknown" })
    expect(last().fps).toBeUndefined()
    observe(sample(6_000, { fps: 0, framesDecoded: undefined }))
    expect(last()).toMatchObject({ reason: "observed-change", reportedFps: 0, fps: 0, fpsBucket: "zero", decoding: "no-decoded-frames" })
  })

  it("uses only a same-peer/link/stream finite timestamp window for derived FPS", () => {
    const { observe, last } = setup()
    observe(sample(0, { fps: undefined, framesDecoded: 10 }))
    observe(sample(3_000, { fps: undefined, framesDecoded: 40 }))
    expect(last()).toMatchObject({ fps: 10, fpsSource: "decoded-counter-window", framesDecodedDelta: 30, windowMs: 3_000 })
    observe(sample(6_000, { id: "in-2", fps: undefined, framesDecoded: 2 }))
    expect(last().fps).toBeUndefined()
    expect(last().windowMs).toBeUndefined()
    observe(sample(9_000, { id: "in-2", fps: undefined, framesDecoded: 3 }, { link: 2 }))
    expect(last().fps).toBeUndefined()
    observe(sample(12_000, { id: "in-2", fps: undefined, framesDecoded: 4 }, { link: 2 }), 12_000, false, "another-peer")
    expect(last()).toMatchObject({ peerId: "another-peer", reason: "first-observation" })
    expect(last().fps).toBeUndefined()
  })

  it("starts a mesh replacement from a new baseline even with reused link/stream IDs", () => {
    const first = setup()
    first.observe(sample(0, { fps: undefined, framesDecoded: 100 }))
    const next = setup({ ...scope, meshGeneration: 2, roomKey: "another-room" })
    next.observe(sample(3_000, { fps: undefined, framesDecoded: 200 }))
    expect(next.last()).toMatchObject({ meshGeneration: 2, roomKey: "another-room", reason: "first-observation" })
    expect(next.last().fps).toBeUndefined()
  })

  it("retains complete room/account identities even when rooms share a long prefix", () => {
    const shared = `g17:${Array.from({ length: 5 }, (_, i) => `0x${String(i).repeat(64)}`).join("_")}_`
    const firstRoom = `${shared}0x${"a".repeat(64)}`
    const secondRoom = `${shared}0x${"b".repeat(64)}`
    const selfId = `0x${"c".repeat(64)}`
    const peerId = `0x${"d".repeat(64)}`
    const first = setup({ ...scope, roomKey: firstRoom, selfId })
    const second = setup({ ...scope, roomKey: secondRoom, selfId })
    first.observe(sample(0), 0, false, peerId)
    second.observe(sample(0), 0, false, peerId)
    expect(first.last()).toMatchObject({ roomKey: firstRoom, selfId, peerId })
    expect(second.last()).toMatchObject({ roomKey: secondRoom, selfId, peerId })
    expect(first.last().roomKey).not.toBe(second.last().roomKey)
  })

  it("drops peer baselines when a peer disappears", () => {
    const { observer, observe, last } = setup()
    observe(sample(0, { fps: undefined }))
    observer.observe([], 3_000, false, 17, 0)
    observe(sample(6_000, { fps: undefined }))
    expect(last()).toMatchObject({ reason: "first-observation" })
    expect(last().fps).toBeUndefined()
  })

  it("rejects counter resets, duplicate/backwards timestamps and long gaps", () => {
    const { observe, last } = setup()
    observe(sample(3_000, { fps: undefined, framesDecoded: 300 }))
    observe(sample(6_000, { fps: undefined, framesDecoded: 2 }))
    // Force a heartbeat to inspect provenance even if quality stayed unknown.
    observe(sample(6_000, { fps: undefined, framesDecoded: 2 }), 18_000)
    expect(last()).toMatchObject({ sampleState: "stale", fpsBucket: "unknown" })
    expect(last().fps).toBeUndefined()
    expect(last().framesDecodedDelta).toBeUndefined()
    observe(sample(5_000, { fps: undefined, framesDecoded: 999 }), 21_000)
    observe(sample(9_000, { fps: undefined, framesDecoded: 32 }), 24_000)
    expect(last()).toMatchObject({ fps: 10, framesDecodedDelta: 30, windowStartTimestampMs: 6_000 })
    observe(sample(30_000, { fps: undefined, framesDecoded: 32 }), 30_000)
    expect(last().fps).toBeUndefined()
    expect(last().windowMs).toBeUndefined()
  })

  it("breaks continuity across hidden and missing input without reporting bogus zero", () => {
    const { observe, emit, last } = setup()
    observe(sample(0, { fps: undefined, framesDecoded: 10 }))
    observe(sample(3_000, { fps: undefined, framesDecoded: 40 }))
    const visibleRows = emit.mock.calls.length
    observe(sample(6_000, { fps: 0, framesDecoded: 40 }), 6_000, true)
    observe(sample(8_000, { fps: 0, framesDecoded: 40 }), 8_000, true)
    expect(emit).toHaveBeenCalledTimes(visibleRows)
    observe(sample(9_000, { fps: undefined, framesDecoded: 40 }))
    expect(last()).toMatchObject({ hidden: false, reason: "first-observation", sampleState: "baseline" })
    expect(last().fps).toBeUndefined()
    observe(undefined, 12_000)
    observe(sample(15_000, { fps: undefined, framesDecoded: 40 }))
    expect(last().fps).toBeUndefined()
    expect(last().framesDecodedDelta).toBeUndefined()
  })

  it("contains sink failures and keeps processing other peers", () => {
    const emit = vi.fn(() => { throw new Error("diagnostic sink failed") })
    const observer = new ReplayReceiverObserver(scope, emit)
    expect(() => observer.observe([{ id: "one", quality: sample(0) }, { id: "two", quality: sample(0) }], 0, false, 17, 0)).not.toThrow()
    expect(emit).toHaveBeenCalledTimes(2)
    observer.observe([{ id: "one", quality: sample(3_000) }], 3_000, false, 17, 0)
    expect(emit).toHaveBeenCalledTimes(2)
  })

  it("resets on a lifecycle edge even if no hidden stats poll ran", () => {
    const { observer, observe, last } = setup()
    observe(sample(0, { fps: undefined, framesDecoded: 10 }))
    observer.reset()
    observe(sample(3_000, { fps: undefined, framesDecoded: 10 }))
    expect(last()).toMatchObject({ reason: "first-observation", sampleState: "baseline" })
    expect(last().fps).toBeUndefined()
    expect(last().framesDecodedDelta).toBeUndefined()
  })

  it("does not coerce nonfinite measurements and captures real zero decoded-frame windows", () => {
    const { observe, last } = setup()
    observe(sample(0, { fps: NaN, framesDecoded: 0, width: Infinity }))
    observe(sample(3_000, { fps: NaN, framesDecoded: 0, width: Infinity }))
    expect(last()).toMatchObject({ fps: 0, decoding: "no-decoded-frames", framesDecodedDelta: 0 })
    expect(last().width).toBeUndefined()
  })

  it("bounds UTF-8 payload size below 4k even for oversized browser fields", () => {
    const huge = "😀".repeat(10_000)
    const roomKey = `g17:${Array.from({ length: 6 }, (_, i) => `0x${String(i).repeat(64)}`).join("_")}`
    const { observe, last } = setup({ roomKey, selfId: `0x${"c".repeat(64)}`, meshGeneration: 999 })
    observe(sample(3_000, { id: huge, codec: huge, codecFmtp: huge, decoderImplementation: huge }, { transportId: huge, localType: huge, remoteType: huge, protocol: huge, relayProtocol: huge, networkType: huge }), 3_000, false, `0x${"d".repeat(64)}`)
    expect(new TextEncoder().encode(JSON.stringify(last())).length).toBeLessThan(3_500)
  })

  it("bounds five steady peers to 20 heartbeat rows/minute and changed peers to 100", () => {
    const { observer, emit } = setup()
    const rows = (at: number, changed = false) => Array.from({ length: 5 }, (_, i) => ({ id: `peer-${i}`, quality: sample(at, { width: changed ? at : 640 }) }))
    observer.observe(rows(0), 0, false, 17, 0)
    for (let at = 3_000; at <= 60_000; at += 3_000) observer.observe(rows(at), at, false, 17, 0)
    expect(emit).toHaveBeenCalledTimes(5 + 20)
    emit.mockClear()
    for (let at = 63_000; at <= 120_000; at += 3_000) observer.observe(rows(at, true), at, false, 17, 0)
    expect(emit).toHaveBeenCalledTimes(100)
  })
})
