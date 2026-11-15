// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { runTap, type TapFrame } from "./sps-tap-core"

const hex = (s: string) => Uint8Array.from(s.match(/../g)!.map((b) => parseInt(b, 16)))
// Chrome's OpenH264 key frame as its receiver's transform saw it: SPS, PPS, IDR
const H264_KEY = hex("000000016742c01e8c68170bf9658078442350" + "00" + "0000000168ce3c80" + "0000000165b8000405388c")
const H264_DELTA = hex("00000001419a0102")

let serial = 0
function frame(type: "key" | "delta", bytes: Uint8Array, mimeType: string | null = "video/H264"): TapFrame & { serial: number } {
  return { serial: serial++, type, data: bytes.slice().buffer, getMetadata: () => (mimeType ? { mimeType } : {}) }
}

/** a source that yields `frames` then (optionally) stays open, and a sink that records */
function pipeline(frames: TapFrame[], { close = true } = {}) {
  const seen: TapFrame[] = []
  let arrived: () => void = () => {}
  const allArrived = new Promise<void>((resolve) => (arrived = resolve))
  const readable = new ReadableStream<TapFrame>({
    start(controller) {
      for (const f of frames) controller.enqueue(f)
      if (close) controller.close()
    },
  })
  const writable = new WritableStream<TapFrame>({
    write(f) {
      seen.push(f)
      if (seen.length === frames.length) arrived()
    },
  })
  return { readable, writable, seen, allArrived }
}

function clock(step = 1) {
  let t = 0
  return () => (t += step)
}

describe("runTap", () => {
  it("hands every frame on unchanged and in order, the ones after the key frame included", async () => {
    const frames = [frame("delta", H264_DELTA), frame("key", H264_KEY), frame("delta", H264_DELTA), frame("delta", H264_DELTA)]
    const bytesBefore = frames.map((f) => new Uint8Array(f.data).join(","))
    const { readable, writable, seen, allArrived } = pipeline(frames)
    const result = await runTap({ readable, writable, now: clock() })
    await allArrived
    expect(seen).toEqual(frames)
    seen.forEach((f, i) => expect(f).toBe(frames[i]))
    expect(seen.map((f) => new Uint8Array(f.data).join(","))).toEqual(bytesBefore)
    expect(result).toMatchObject({ outcome: "sps", frames: 2, mime: "video/H264" })
    expect(result.sps).toMatchObject({ pocType: 2, maxNumReorderFrames: 0, maxDecFrameBuffering: 1 })
  })

  it("stops inspecting at the first key frame: what follows is piped, never read by the tap", async () => {
    let reads = 0
    const frames = [frame("key", H264_KEY), frame("delta", H264_DELTA), frame("delta", H264_DELTA)]
    const { readable, writable, allArrived } = pipeline(frames)
    const result = await runTap({
      readable,
      writable,
      now: clock(),
      parse: () => {
        reads++
        return null
      },
    })
    await allArrived
    expect(reads).toBe(1)
    expect(result.frames).toBe(1)
  })

  it("does not parse a key frame of another codec", async () => {
    const { readable, writable, seen, allArrived } = pipeline([frame("key", hex("9d012a0102"), "video/VP8")])
    const result = await runTap({ readable, writable, now: clock(), parse: () => { throw new Error("must not parse") } })
    await allArrived
    expect(seen).toHaveLength(1)
    expect(result).toMatchObject({ outcome: "not-h264", mime: "video/VP8" })
    expect(result.sps).toBeUndefined()
  })

  it("parses when the engine gives no mime type, and says no-sps when the key frame has none", async () => {
    const { readable, writable } = pipeline([frame("key", hex("0000000165b8"), null)])
    const result = await runTap({ readable, writable, now: clock() })
    expect(result).toMatchObject({ outcome: "no-sps", mime: "unknown" })
  })

  it("gives up after maxFrames with no key frame, still passing every frame", async () => {
    const frames = Array.from({ length: 6 }, () => frame("delta", H264_DELTA))
    const { readable, writable, seen, allArrived } = pipeline(frames)
    const result = await runTap({ readable, writable, now: clock(), maxFrames: 3 })
    await allArrived
    expect(seen).toHaveLength(6)
    expect(result).toMatchObject({ outcome: "no-key", frames: 3 })
  })

  it("says ended when the stream closes before a key frame", async () => {
    const { readable, writable } = pipeline([frame("delta", H264_DELTA)])
    expect((await runTap({ readable, writable, now: clock() })).outcome).toBe("ended")
  })

  it("asks for a key frame once inspection is over, and says how that went", async () => {
    let asked = 0
    const sent = pipeline([frame("key", H264_KEY)])
    expect((await runTap({ ...sent, now: clock(), requestKeyFrame: () => void asked++ })).keyFrameRequest).toBe("sent")
    expect(asked).toBe(1)

    const refused = pipeline([frame("key", H264_KEY), frame("delta", H264_DELTA)])
    const result = await runTap({ ...refused, now: clock(), requestKeyFrame: () => Promise.reject(new Error("InvalidStateError")) })
    await refused.allArrived
    expect(result.keyFrameRequest).toBe("failed")
    expect(refused.seen).toHaveLength(2)

    const none = pipeline([frame("key", H264_KEY)])
    expect((await runTap({ ...none, now: clock() })).keyFrameRequest).toBe("unsupported")
  })

  it("asks for a key frame exactly once per link, and swallows a request that throws synchronously", async () => {
    let asked = 0
    const frames = [frame("delta", H264_DELTA), frame("key", H264_KEY), frame("key", H264_KEY), frame("delta", H264_DELTA)]
    const io = pipeline(frames)
    const result = await runTap({
      ...io,
      now: clock(),
      requestKeyFrame: () => {
        asked++
        throw new DOMException("no", "InvalidStateError")
      },
    })
    await io.allArrived
    expect(asked).toBe(1)
    expect(result.keyFrameRequest).toBe("failed")
    expect(io.seen).toEqual(frames)
  })

  it("keeps the frames flowing when the parser throws", async () => {
    const frames = [frame("key", H264_KEY), frame("delta", H264_DELTA)]
    const { readable, writable, seen, allArrived } = pipeline(frames)
    const result = await runTap({ readable, writable, now: clock(), parse: () => { throw new Error("boom") } })
    await allArrived
    expect(seen).toEqual(frames)
    expect(result.outcome).toBe("error")
  })

  it("measures its own time: per-frame work, the parse, and the wait for the key frame", async () => {
    // every now() call advances 1 ms
    const { readable, writable } = pipeline([frame("delta", H264_DELTA), frame("delta", H264_DELTA), frame("key", H264_KEY)])
    const result = await runTap({ readable, writable, now: clock() })
    expect(result.parseMs).toBe(1)
    expect(result.inspectMs).toBeGreaterThanOrEqual(3)
    expect(result.toKeyMs).toBeGreaterThan(0)
    expect(Number.isFinite(result.inspectMs)).toBe(true)
  })
})
