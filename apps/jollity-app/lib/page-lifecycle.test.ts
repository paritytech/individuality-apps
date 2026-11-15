// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { FREEZE_SLACK_MS, pageFreezeThresholdMs, pageFroze, pageHidden, watchPageHidden } from "./page-lifecycle"

describe("pageFroze", () => {
  it("is false for a tick on time or a little late", () => {
    expect(pageFroze(1000, 1500, 500)).toBe(false)
    expect(pageFroze(1000, 1000 + 500 + FREEZE_SLACK_MS, 500)).toBe(false)
  })
  it("is true once the gap passes one tick plus the slack", () => {
    expect(pageFroze(1000, 1000 + 500 + FREEZE_SLACK_MS + 1, 500)).toBe(true)
    expect(pageFroze(1000, 121_000, 500)).toBe(true)
  })
})

describe("watchPageHidden", () => {
  let doc: EventTarget & { visibilityState: string }
  let win: EventTarget
  beforeEach(() => {
    doc = Object.assign(new EventTarget(), { visibilityState: "visible" })
    win = new EventTarget()
    vi.stubGlobal("document", doc)
    vi.stubGlobal("window", win)
  })
  afterEach(() => vi.unstubAllGlobals())
  const setVisibility = (state: string) => {
    doc.visibilityState = state
    doc.dispatchEvent(new Event("visibilitychange"))
  }

  it("reads the visibility", () => {
    expect(pageHidden()).toBe(false)
    doc.visibilityState = "hidden"
    expect(pageHidden()).toBe(true)
  })
  it("reports hidden and shown from visibilitychange, pagehide and pageshow", () => {
    const hidden = vi.fn()
    const shown = vi.fn()
    watchPageHidden(hidden, shown)
    setVisibility("hidden")
    expect([hidden.mock.calls.length, shown.mock.calls.length]).toEqual([1, 0])
    setVisibility("visible")
    expect([hidden.mock.calls.length, shown.mock.calls.length]).toEqual([1, 1])
    win.dispatchEvent(new Event("pagehide"))
    win.dispatchEvent(new Event("pageshow"))
    expect([hidden.mock.calls.length, shown.mock.calls.length]).toEqual([2, 2])
  })
  it("stops after the unsubscribe", () => {
    const hidden = vi.fn()
    const stop = watchPageHidden(hidden)
    stop()
    setVisibility("hidden")
    win.dispatchEvent(new Event("pagehide"))
    expect(hidden).not.toHaveBeenCalled()
  })
  it("can distinguish a real pagehide from a visibility hide", () => {
    const hidden = vi.fn()
    const gone = vi.fn()
    watchPageHidden(hidden, undefined, gone)
    setVisibility("hidden")
    win.dispatchEvent(new Event("pagehide"))
    expect(hidden).toHaveBeenCalledTimes(1)
    expect(gone).toHaveBeenCalledTimes(1)
  })
  it("passes the pagehide lifecycle evidence to its distinct handler", () => {
    const gone = vi.fn()
    watchPageHidden(vi.fn(), undefined, gone)
    const event = Object.assign(new Event("pagehide"), { persisted: true })
    win.dispatchEvent(event)
    expect(gone).toHaveBeenCalledWith(event)
  })
  it("is a no-op without a document", () => {
    vi.unstubAllGlobals()
    expect(() => watchPageHidden(() => {})()).not.toThrow()
  })
})

describe("pageFreezeThresholdMs", () => {
  it("is one tick plus the slack, and is the line pageFroze draws", () => {
    expect(pageFreezeThresholdMs(500)).toBe(500 + FREEZE_SLACK_MS)
    expect(pageFroze(0, pageFreezeThresholdMs(500), 500)).toBe(false)
    expect(pageFroze(0, pageFreezeThresholdMs(500) + 1, 500)).toBe(true)
  })
})
