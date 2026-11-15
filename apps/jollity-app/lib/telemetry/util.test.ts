// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, describe, expect, it, vi } from "vitest"
import { pageHidden, percentile, whenIdle } from "./util"

afterEach(() => vi.unstubAllGlobals())

describe("percentile", () => {
  it("is nearest-rank over an unsorted array, q in 0-1", () => {
    const values = [100, 16, 16, 60, 16, 16, 16, 16, 16, 16]
    expect(percentile(values, 0.5)).toBe(16)
    expect(percentile(values, 0.95)).toBe(100)
    expect(percentile(values, 0.9)).toBe(60)
    expect(percentile(values, 0)).toBe(16)
    expect(percentile(values, 1)).toBe(100)
    expect(values[0]).toBe(100) // the input is not sorted in place
  })
  it("takes a typed array as already sorted", () => {
    const sorted = Float32Array.from([1, 2, 3, 4])
    expect(percentile(sorted, 0.5)).toBe(2)
    expect(percentile(sorted, 0.95)).toBe(4)
  })
  it("is undefined for no values", () => {
    expect(percentile([], 0.5)).toBeUndefined()
    expect(percentile(new Float32Array(0), 0.5)).toBeUndefined()
  })
})

describe("pageHidden", () => {
  it("is true only for a hidden document", () => {
    expect(pageHidden()).toBe(false) // no document
    vi.stubGlobal("document", { visibilityState: "visible" })
    expect(pageHidden()).toBe(false)
    vi.stubGlobal("document", { visibilityState: "hidden" })
    expect(pageHidden()).toBe(true)
  })
})

describe("whenIdle", () => {
  it("runs on requestIdleCallback where there is one, and cancels", () => {
    const queued: Array<() => void> = []
    const cancel = vi.fn()
    vi.stubGlobal("requestIdleCallback", (fn: () => void) => queued.push(fn))
    vi.stubGlobal("cancelIdleCallback", cancel)
    const work = vi.fn()
    const stop = whenIdle(work, 3000)
    queued[0]()
    expect(work).toHaveBeenCalledTimes(1)
    stop()
    expect(cancel).toHaveBeenCalledTimes(1)
  })
  it("falls back to a timer, which the stop clears", () => {
    vi.useFakeTimers()
    try {
      const work = vi.fn()
      whenIdle(work, 3000)
      vi.advanceTimersByTime(2999)
      expect(work).not.toHaveBeenCalled()
      vi.advanceTimersByTime(1)
      expect(work).toHaveBeenCalledTimes(1)
      const later = vi.fn()
      whenIdle(later, 3000)()
      vi.advanceTimersByTime(5000)
      expect(later).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})
