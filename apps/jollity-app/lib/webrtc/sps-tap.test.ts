// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it, vi } from "vitest"
import { createSpsTap, nextTapTag, parseTapRate, spsTapDecision, spsTapEngine, untappedEvent, type SpsTapEvent, type TapWorker } from "./sps-tap"

class FakeWorker implements TapWorker {
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: ((event: unknown) => void) | null = null
  posted: Array<{ message: unknown; transfer?: unknown[] }> = []
  terminated = false
  failPost = false
  postMessage(message: unknown, transfer?: unknown[]) {
    if (this.failPost && (message as { kind: string }).kind === "streams") throw new DOMException("no", "DataCloneError")
    this.posted.push({ message, transfer })
  }
  terminate() {
    this.terminated = true
  }
  reply(data: unknown) {
    this.onmessage?.({ data } as MessageEvent)
  }
}

class FakeScriptTransform {
  constructor(
    public worker: unknown,
    public options: unknown,
  ) {}
}

const RESULT = { outcome: "sps", mime: "video/H264", frames: 1, inspectMs: 0.2, parseMs: 0.05, toKeyMs: 0, keyFrameRequest: "sent", sps: { profileIdc: 66, constraintFlags: 0xc0, levelIdc: 30, pocType: 2, complete: true } }

function setup(engine: "script" | "encoded") {
  const worker = new FakeWorker()
  const events: Array<[string, SpsTapEvent]> = []
  const tap = createSpsTap({
    engine,
    createWorker: () => worker,
    ScriptTransform: FakeScriptTransform as unknown as typeof RTCRtpScriptTransform,
    now: () => 10,
    onResult: (peer, event) => events.push([peer, event]),
  })!
  return { worker, events, tap }
}

describe("spsTapEngine", () => {
  it("prefers RTCRtpScriptTransform, falls back to createEncodedStreams where the build allows it, else nothing", () => {
    const receiverWith = { prototype: { createEncodedStreams() {} } }
    expect(spsTapEngine({ Worker: class {}, RTCRtpScriptTransform: class {}, RTCRtpReceiver: receiverWith })).toBe("script")
    expect(spsTapEngine({ Worker: class {}, RTCRtpReceiver: receiverWith }, true)).toBe("encoded")
    expect(spsTapEngine({ Worker: class {}, RTCRtpReceiver: { prototype: {} } }, true)).toBeNull()
    expect(spsTapEngine({ RTCRtpScriptTransform: class {} })).toBeNull() // no Worker
    expect(spsTapEngine({})).toBeNull()
  })

  it("leaves the createEncodedStreams path off by default: it cannot ask for the key frame that ends the freeze", () => {
    expect(spsTapEngine({ Worker: class {}, RTCRtpReceiver: { prototype: { createEncodedStreams() {} } } })).toBeNull()
  })
})

describe("the sampling", () => {
  it("reads the build rate: a fraction, and 0 (no real player taps) when unset or unreadable", () => {
    expect(parseTapRate(undefined)).toBe(0)
    expect(parseTapRate("")).toBe(0)
    expect(parseTapRate("0")).toBe(0)
    expect(parseTapRate("1")).toBe(1)
    expect(parseTapRate("0.25")).toBe(0.25)
    expect(parseTapRate("lots")).toBe(0)
    expect(parseTapRate("7")).toBe(1)
    expect(parseTapRate("-1")).toBe(0)
  })

  it("taps a session drawn under the rate, and none the engine cannot", () => {
    expect(spsTapDecision({ rate: 0.1, engine: "script", random: 0.05 })).toBe("on")
    expect(spsTapDecision({ rate: 0.1, engine: "script", random: 0.5 })).toBe("off")
    expect(spsTapDecision({ rate: 0, engine: "script", random: 0 })).toBe("off")
    expect(spsTapDecision({ rate: 1, engine: null, random: 0 })).toBe("unsupported")
  })

  it("the kill switch stops every tap", () => {
    expect(spsTapDecision({ rate: 1, engine: "script", random: 0, disabled: true })).toBe("off")
  })
})

describe("createSpsTap", () => {
  it("attaches nothing until the worker has answered (a worker that never starts would black the video)", () => {
    const { worker, tap } = setup("script")
    expect(worker.posted[0].message).toEqual({ kind: "ping" })
    const receiver = { transform: null } as unknown as RTCRtpReceiver
    expect(tap.attach("bob", receiver)).toBe("not-ready")
    expect(receiver.transform).toBeNull()
  })

  it("puts a script transform on the receiver once ready, and files its result under the peer", () => {
    const { worker, tap, events } = setup("script")
    worker.reply({ kind: "ready" })
    const receiver = { transform: null } as unknown as RTCRtpReceiver
    expect(tap.attach("bob", receiver)).toBe("attached")
    const transform = receiver.transform as unknown as FakeScriptTransform
    expect(transform).toBeInstanceOf(FakeScriptTransform)
    expect(transform.worker).toBe(worker)
    const { id } = transform.options as { id: number }

    worker.reply({ kind: "result", id, result: RESULT })
    expect(events).toEqual([["bob", { ...RESULT, engine: "script", attachMs: 0 }]])
    // a result for an id it never gave out goes nowhere
    worker.reply({ kind: "result", id: 999, result: RESULT })
    expect(events).toHaveLength(1)
  })

  it("hands the encoded streams to the worker, transferred, on the Chromium fallback", () => {
    const { worker, tap, events } = setup("encoded")
    worker.reply({ kind: "ready" })
    const streams = { readable: {}, writable: {} }
    const receiver = { createEncodedStreams: vi.fn(() => streams) } as unknown as RTCRtpReceiver
    expect(tap.attach("carol", receiver)).toBe("attached")
    const sent = worker.posted.at(-1)!
    expect(sent.message).toMatchObject({ kind: "streams", readable: streams.readable, writable: streams.writable })
    expect(sent.transfer).toEqual([streams.readable, streams.writable])
    worker.reply({ kind: "result", id: (sent.message as { id: number }).id, result: RESULT })
    expect(events[0]).toEqual(["carol", { ...RESULT, engine: "encoded", attachMs: 0 }])
  })

  it("pipes the encoded streams on the main thread when they cannot be transferred", () => {
    const { worker, tap } = setup("encoded")
    worker.reply({ kind: "ready" })
    worker.failPost = true
    const pipeTo = vi.fn(() => Promise.resolve())
    const writable = {}
    const receiver = { createEncodedStreams: () => ({ readable: { pipeTo }, writable }) } as unknown as RTCRtpReceiver
    expect(tap.attach("dan", receiver)).toBe("post-failed")
    expect(pipeTo).toHaveBeenCalledWith(writable)
  })

  it("attaches nothing when the engine refuses (createEncodedStreams throws without its flag)", () => {
    const { worker, tap } = setup("encoded")
    worker.reply({ kind: "ready" })
    const receiver = {
      createEncodedStreams: () => {
        throw new DOMException("Too late to create encoded streams", "InvalidStateError")
      },
    } as unknown as RTCRtpReceiver
    expect(tap.attach("erin", receiver)).toBe("attach-threw")
  })

  it("stops attaching once the worker has failed, and terminates it on close", () => {
    const { worker, tap } = setup("script")
    worker.reply({ kind: "ready" })
    worker.onerror?.({} as never)
    const receiver = { transform: null } as unknown as RTCRtpReceiver
    expect(tap.attach("bob", receiver)).toBe("worker-failed")
    tap.close()
    expect(worker.terminated).toBe(true)
  })

  it("is null when the worker cannot be created", () => {
    expect(
      createSpsTap({
        engine: "script",
        createWorker: () => {
          throw new Error("CSP")
        },
        onResult: () => {},
      }),
    ).toBeNull()
  })
})

describe("sessionSpsTap", () => {
  it("draws once per page and keeps the answer", async () => {
    vi.resetModules()
    const random = vi.spyOn(Math, "random").mockReturnValue(0)
    vi.stubGlobal("RTCRtpScriptTransform", class {})
    vi.stubGlobal("Worker", class {})
    const { sessionSpsTap } = await import("./sps-tap")
    expect(sessionSpsTap()).toBe("off") // default rate 0
    expect(sessionSpsTap()).toBe("off") // drawn once: the page keeps its answer
    expect(random).toHaveBeenCalledTimes(1)
    random.mockRestore()
    vi.unstubAllGlobals()
  })
})

describe("the session tag", () => {
  it("is on only once a link was really tapped; a failure before that reads failed, after it changes nothing", () => {
    expect(nextTapTag("pending", "failed")).toBe("failed")
    expect(nextTapTag("failed", "attached")).toBe("on")
    expect(nextTapTag("pending", "attached")).toBe("on")
    expect(nextTapTag("on", "failed")).toBe("on")
  })

  it("reports a change once, then nothing until it changes again", async () => {
    vi.resetModules()
    const { noteSessionTap, sessionTapTag } = await import("./sps-tap")
    expect(sessionTapTag()).toBe("pending")
    expect(noteSessionTap("failed")).toBe("failed")
    expect(noteSessionTap("failed")).toBeNull()
    expect(noteSessionTap("attached")).toBe("on")
    expect(noteSessionTap("failed")).toBeNull()
  })
})

describe("untappedEvent", () => {
  it("is an rtc.sps row that says why, with no cost", () => {
    expect(untappedEvent("script", "not-ready")).toMatchObject({ outcome: "untapped", reason: "not-ready", engine: "script", frames: 0, inspectMs: 0 })
  })
})
