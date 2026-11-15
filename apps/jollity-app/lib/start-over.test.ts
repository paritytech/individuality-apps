// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const foreground = vi.hoisted(() => ({ listener: null as null | ((value: unknown) => void) }))
vi.mock("./telemetry/foreground", () => ({
  watchForegroundReturn: (listener: (value: unknown) => void) => {
    foreground.listener = listener
    return () => {
      foreground.listener = null
    }
  },
}))
vi.mock("./self-reload", () => ({ requestSelfReload: vi.fn(() => true) }))
vi.mock("./post-game", () => ({ forgetPostGame: vi.fn() }))

import { forgetPostGame } from "./post-game"
import { requestSelfReload } from "./self-reload"
import { leavingForProduct, stayedInProduct, watchStartOver } from "./start-over"
import type { ForegroundReturn } from "./telemetry/foreground"

const back = (awayMs: number | null = 42_000): ForegroundReturn => ({
  awayMs,
  left: { screen: "payoff", stage: "none", playStarted: false },
  returned: { screen: "payoff", stage: "none", playStarted: false },
  suspended: false,
  source: "other",
})
const returnToPage = (value = back()) => foreground.listener?.(value)

let stop: () => void
beforeEach(() => {
  stayedInProduct() // no mark carried from another test
  vi.mocked(requestSelfReload).mockClear()
  vi.mocked(forgetPostGame).mockClear()
  vi.stubGlobal("window", { history: { replaceState: vi.fn() } })
  stop = watchStartOver()
})
afterEach(() => {
  stop()
  vi.unstubAllGlobals()
})

describe("starting over after leaving for another product (#465)", () => {
  it("leaves an ordinary return alone", () => {
    returnToPage()
    expect(requestSelfReload).not.toHaveBeenCalled()
    expect(forgetPostGame).not.toHaveBeenCalled()
  })

  it("reloads at the home on the first return after the hand-off, the finished game forgotten", () => {
    leavingForProduct()
    returnToPage()

    expect(forgetPostGame).toHaveBeenCalledTimes(1)
    expect(requestSelfReload).toHaveBeenCalledWith(
      "left-product",
      { awayMs: 42_000, screen: "payoff", stage: "none" },
      expect.any(Function),
    )
    // the reload loads the home, not the results screen the player left from
    const beforeReload = vi.mocked(requestSelfReload).mock.calls[0]![2]!
    beforeReload()
    expect(window.history.replaceState).toHaveBeenCalledWith(null, "", "/")
  })

  it("starts over once: the next return is an ordinary one", () => {
    leavingForProduct()
    returnToPage()
    returnToPage()
    expect(requestSelfReload).toHaveBeenCalledTimes(1)
  })

  it("keeps the player where they are when the navigation was refused", () => {
    leavingForProduct()
    stayedInProduct()
    returnToPage()
    expect(requestSelfReload).not.toHaveBeenCalled()
  })

  it("passes no away time it does not know", () => {
    leavingForProduct()
    returnToPage(back(null))
    expect(vi.mocked(requestSelfReload).mock.calls[0]![1]).toEqual({ screen: "payoff", stage: "none" })
  })
})
