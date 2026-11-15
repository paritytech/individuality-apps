// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, describe, expect, it, vi } from "vitest"
import { KICK_AFTER_HIDDEN_MS } from "../state-machines/peer-actor"
import { watchPageAway } from "./page-away"

function pages() {
  const doc = Object.assign(new EventTarget(), { visibilityState: "visible" })
  const win = new EventTarget()
  vi.stubGlobal("document", doc) // page-lifecycle reads the globals
  vi.stubGlobal("window", win)
  const mesh = { setSelfAway: vi.fn() }
  const stop = watchPageAway(() => mesh)
  return { doc, win, mesh, stop }
}

describe("watchPageAway", () => {
  afterEach(() => vi.unstubAllGlobals())

  it("says away when the page turns hidden, and back when it is visible again", () => {
    const { doc, mesh } = pages()
    doc.visibilityState = "hidden"
    doc.dispatchEvent(new Event("visibilitychange"))
    expect(mesh.setSelfAway).toHaveBeenLastCalledWith(true)
    doc.visibilityState = "visible"
    doc.dispatchEvent(new Event("visibilitychange"))
    expect(mesh.setSelfAway).toHaveBeenLastCalledWith(false, expect.any(Number))
  })

  it("says away on pagehide, before iOS suspends the page", () => {
    const { win, mesh } = pages()
    win.dispatchEvent(new Event("pagehide"))
    expect(mesh.setSelfAway).toHaveBeenLastCalledWith(true)
  })

  it("a page shown again while visible says back", () => {
    const { win, mesh } = pages()
    const clock = vi.spyOn(performance, "now")
    win.dispatchEvent(new Event("pageshow"))
    expect(clock).not.toHaveBeenCalled()
    win.dispatchEvent(new Event("pagehide"))
    win.dispatchEvent(new Event("pageshow"))
    expect(mesh.setSelfAway).toHaveBeenLastCalledWith(false, expect.any(Number))
  })

  it("passes the mesh how long the page was hidden, each time it comes back", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] })
    const { doc } = pages()
    const mesh = { setSelfAway: vi.fn() }
    const stop = watchPageAway(() => mesh)
    const flip = (state: string) => {
      doc.visibilityState = state
      doc.dispatchEvent(new Event("visibilitychange"))
    }
    flip("hidden")
    vi.advanceTimersByTime(KICK_AFTER_HIDDEN_MS - 1000)
    flip("visible")
    expect(mesh.setSelfAway).toHaveBeenLastCalledWith(false, KICK_AFTER_HIDDEN_MS - 1000)
    flip("hidden")
    vi.advanceTimersByTime(KICK_AFTER_HIDDEN_MS + 1000)
    flip("visible")
    expect(mesh.setSelfAway).toHaveBeenLastCalledWith(false, KICK_AFTER_HIDDEN_MS + 1000)
    stop()
    vi.useRealTimers()
  })

  it("does nothing once stopped, or with no mesh yet", () => {
    const { win, mesh, stop } = pages()
    stop()
    win.dispatchEvent(new Event("pagehide"))
    expect(mesh.setSelfAway).not.toHaveBeenCalled()
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] })
    const none = watchPageAway(() => null)
    expect(() => win.dispatchEvent(new Event("pagehide"))).not.toThrow()
    vi.advanceTimersByTime(KICK_AFTER_HIDDEN_MS + 1)
    expect(() => win.dispatchEvent(new Event("pageshow"))).not.toThrow()
    none()
    vi.useRealTimers()
  })
})
