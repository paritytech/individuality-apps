// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, describe, expect, it, vi } from "vitest"
import { observeCameraFrames } from "./camera-frame"

type Callback = VideoFrameRequestCallback

function video(withRvfc = true) {
  let callback: Callback | undefined
  const el = {
    currentTime: 0,
    requestVideoFrameCallback: withRvfc ? vi.fn((next: Callback) => ((callback = next), 7)) : undefined,
    cancelVideoFrameCallback: vi.fn(),
  } as unknown as HTMLVideoElement
  return { el, frame: () => callback?.(performance.now(), {} as VideoFrameCallbackMetadata) }
}

afterEach(() => vi.useRealTimers())

describe("camera frame observer", () => {
  it("uses a presented frame rather than metadata as proof", () => {
    vi.useFakeTimers()
    const v = video()
    const first = vi.fn()
    const timeout = vi.fn()
    const watcher = observeCameraFrames(v.el, { onFirstFrame: first, onTimeout: timeout, watchActivity: () => () => {} })
    vi.advanceTimersByTime(2_000)
    v.frame()
    vi.advanceTimersByTime(2_000)
    expect(first).toHaveBeenCalledOnce()
    expect(timeout).not.toHaveBeenCalled()
    watcher.stop()
  })

  it("falls back to currentTime advancing", () => {
    vi.useFakeTimers()
    const v = video(false)
    const first = vi.fn()
    const window = vi.fn()
    const watcher = observeCameraFrames(v.el, { onFirstFrame: first, onWindow: window, onTimeout: vi.fn(), watchActivity: () => () => {} })
    v.el.currentTime = 0.1
    vi.advanceTimersByTime(100)
    expect(first).toHaveBeenCalledOnce()
    vi.advanceTimersByTime(10_000)
    expect(window).not.toHaveBeenCalled()
    watcher.stop()
  })

  it("times out after three visible seconds", () => {
    vi.useFakeTimers()
    const timeout = vi.fn()
    const watcher = observeCameraFrames(video().el, { onFirstFrame: vi.fn(), onTimeout: timeout, watchActivity: () => () => {} })
    vi.advanceTimersByTime(2_999)
    expect(timeout).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(timeout).toHaveBeenCalledOnce()
    watcher.stop()
  })

  it("does not charge hidden time or allow late callbacks", () => {
    vi.useFakeTimers()
    let activity: ((hidden: boolean, suspended: boolean) => void) | undefined
    const v = video()
    const timeout = vi.fn()
    const first = vi.fn()
    const watcher = observeCameraFrames(v.el, {
      onFirstFrame: first,
      onTimeout: timeout,
      watchActivity: (next) => ((activity = next), () => {}),
    })
    vi.advanceTimersByTime(2_000)
    activity?.(true, false)
    v.frame()
    vi.advanceTimersByTime(20_000)
    expect(first).not.toHaveBeenCalled()
    expect(timeout).not.toHaveBeenCalled()
    activity?.(false, false)
    vi.advanceTimersByTime(2_999)
    expect(timeout).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(timeout).toHaveBeenCalledOnce()
    watcher.stop()
  })

  it("resumes with a fresh budget after a silent suspension", () => {
    vi.useFakeTimers()
    let activity: ((hidden: boolean, suspended: boolean) => void) | undefined
    const timeout = vi.fn()
    const watcher = observeCameraFrames(video().el, {
      onFirstFrame: vi.fn(),
      onTimeout: timeout,
      watchActivity: (next) => ((activity = next), () => {}),
    })
    vi.advanceTimersByTime(2_900)
    activity?.(true, true)
    vi.advanceTimersByTime(20_000)
    activity?.(false, true)
    vi.advanceTimersByTime(2_999)
    expect(timeout).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(timeout).toHaveBeenCalledOnce()
    watcher.stop()
  })

  it("reports frames in ten-second visible windows", () => {
    vi.useFakeTimers()
    const v = video()
    const window = vi.fn()
    const watcher = observeCameraFrames(v.el, { onFirstFrame: vi.fn(), onWindow: window, onTimeout: vi.fn(), watchActivity: () => () => {} })
    v.frame()
    v.frame()
    vi.advanceTimersByTime(10_000)
    expect(window).toHaveBeenCalledWith(2, 10_000)
    watcher.stop()
  })
})
