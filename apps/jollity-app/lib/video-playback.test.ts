// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("./telemetry", async () => (await import("./telemetry/testing")).fakeTelemetryModule())

import { recorded, resetRecorded } from "./telemetry/testing"
import { playVideo, releaseVideo, resetVideoPlaybackForTests } from "./video-playback"

const refusal = () => new DOMException("The request is not allowed by the user agent", "NotAllowedError")
const flush = async () => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve()
}

/** a paused video on a stream; `answers` is what each play() does, in turn */
function video(...answers: ("play" | "refuse" | "abort")[]) {
  const attrs = new Map<string, string>()
  const events = new EventTarget()
  let call = 0
  const el = {
    addEventListener: events.addEventListener.bind(events),
    /** the element's own media event, as the browser fires it */
    fire: (type: string) => events.dispatchEvent(new Event(type)),
    paused: true,
    ended: false,
    srcObject: {} as unknown,
    currentSrc: "",
    isConnected: true,
    play: vi.fn(async () => {
      const answer = answers[Math.min(call++, answers.length - 1)]
      if (answer === "refuse") throw refusal()
      if (answer === "abort") throw new DOMException("replaced", "AbortError")
      el.paused = false
    }),
    getAttribute: (name: string) => attrs.get(name) ?? null,
    setAttribute: (name: string, value: string) => void attrs.set(name, value),
    removeAttribute: (name: string) => void attrs.delete(name),
    hidden: () => attrs.has("data-playback-refused"),
  }
  return el
}
type FakeVideo = ReturnType<typeof video>
const play = (el: FakeVideo, doc: EventTarget) => playVideo(el as unknown as HTMLVideoElement, doc as unknown as Document)
const tap = async (doc: EventTarget, type = "touchend") => {
  doc.dispatchEvent(new Event(type))
  await flush()
}

let doc: EventTarget
beforeEach(() => {
  resetVideoPlaybackForTests()
  resetRecorded()
  doc = new EventTarget()
})
afterEach(() => resetVideoPlaybackForTests())

describe("a game video the phone refuses to play (iOS Low Power Mode)", () => {
  it("plays a paused video and leaves it shown", async () => {
    const el = video("play")
    play(el, doc)
    await flush()
    expect(el.play).toHaveBeenCalledTimes(1)
    expect(el.hidden()).toBe(false)
    await tap(doc)
    expect(el.play).toHaveBeenCalledTimes(1)
  })

  it("hides a refused video, and plays and shows it on the next tap", async () => {
    const el = video("refuse", "play")
    play(el, doc)
    await flush()
    expect(el.hidden()).toBe(true)
    expect(recorded.metrics).toContainEqual(expect.objectContaining({ name: "video.play_refused", value: 1 }))

    await tap(doc, "click")
    expect(el.play).toHaveBeenCalledTimes(2)
    expect(el.hidden()).toBe(false)
    // shown and playing: a later tap asks nothing more of it
    await tap(doc)
    expect(el.play).toHaveBeenCalledTimes(2)
  })

  it("keeps a video hidden while taps are still refused, and counts the refusal once", async () => {
    const el = video("refuse", "refuse", "play")
    play(el, doc)
    await flush()
    await tap(doc)
    expect(el.hidden()).toBe(true)
    await tap(doc)
    expect(el.hidden()).toBe(false)
    expect(el.play).toHaveBeenCalledTimes(3)
    expect(recorded.metrics.filter((m) => m.name === "video.play_refused")).toHaveLength(1)
  })

  it("never hides a video another play() call already started", async () => {
    const el = video("refuse")
    play(el, doc)
    el.paused = false // another play() call won the race with the refused one
    await flush()
    expect(el.hidden()).toBe(false)
    await tap(doc)
    expect(el.play).toHaveBeenCalledTimes(1)
  })

  it("shows a hidden video again however it starts playing", async () => {
    const el = video("refuse")
    play(el, doc)
    await flush()
    expect(el.hidden()).toBe(true)
    el.paused = false
    el.fire("playing")
    expect(el.hidden()).toBe(false)
    // nothing left to retry on a tap
    await tap(doc)
    expect(el.play).toHaveBeenCalledTimes(1)
  })

  it("takes an AbortError for a new source, not a refusal", async () => {
    const el = video("abort")
    play(el, doc)
    await flush()
    expect(el.hidden()).toBe(false)
    await tap(doc)
    expect(el.play).toHaveBeenCalledTimes(1)
  })

  it("stops retrying a video that is released, or that left the page", async () => {
    const released = video("refuse", "play")
    const gone = video("refuse", "play")
    play(released, doc)
    play(gone, doc)
    await flush()
    releaseVideo(released as unknown as HTMLVideoElement)
    gone.isConnected = false

    await tap(doc)
    expect(released.hidden()).toBe(false)
    expect(gone.hidden()).toBe(false)
    expect(released.play).toHaveBeenCalledTimes(1)
    expect(gone.play).toHaveBeenCalledTimes(1)
  })

  it("asks nothing of a playing, ended or sourceless video", async () => {
    const playing = video("play")
    playing.paused = false
    const ended = video("play")
    ended.ended = true
    const empty = video("play")
    empty.srcObject = null
    for (const el of [playing, ended, empty]) play(el, doc)
    await flush()
    expect(playing.play).not.toHaveBeenCalled()
    expect(ended.play).not.toHaveBeenCalled()
    expect(empty.play).not.toHaveBeenCalled()
  })
})
