// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The start-over on the REAL foreground tracker: the page hides when the host
 * opens Pocket and shows again when the player comes back (lib/start-over.test
 * drives the listener directly).
 */
import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("./telemetry/metrics", async () => (await import("./telemetry/testing")).fakeTelemetryModule())
vi.mock("./self-reload", () => ({ requestSelfReload: vi.fn(() => true) }))
vi.mock("./post-game", () => ({ forgetPostGame: vi.fn() }))

import { forgetPostGame } from "./post-game"
import { requestSelfReload } from "./self-reload"
import { leavingForProduct, watchStartOver } from "./start-over"
import { watchForegroundReturns } from "./telemetry/foreground"

/** the tracker on a fake page: `hide` and `show` are the visibility edges */
function page() {
  let now = 1_000
  let hidden = false
  let onHidden = () => {}
  let onShown = () => {}
  const stop = watchForegroundReturns({
    wallNow: () => now,
    monoNow: () => now,
    pageHidden: () => hidden,
    context: () => ({ screen: "payoff", stage: "none", playStarted: false }),
    watchPageHidden: (hide, show) => {
      onHidden = hide
      onShown = show
      return () => {}
    },
    setInterval: () => 1,
    clearInterval: () => {},
    returnSource: () => null,
    emit: () => {},
  })
  return {
    hide() {
      hidden = true
      onHidden()
    },
    show(afterMs: number) {
      now += afterMs
      hidden = false
      onShown()
    },
    stop,
  }
}

afterEach(() => {
  vi.mocked(requestSelfReload).mockClear()
  vi.mocked(forgetPostGame).mockClear()
})

describe("starting over on the real foreground tracker (#465)", () => {
  it("starts over when the player comes back from Pocket", () => {
    const stopStartOver = watchStartOver()
    const tab = page()

    leavingForProduct()
    tab.hide()
    expect(requestSelfReload).not.toHaveBeenCalled()
    tab.show(90_000)

    expect(forgetPostGame).toHaveBeenCalledTimes(1)
    expect(requestSelfReload).toHaveBeenCalledWith(
      "left-product",
      { awayMs: 90_000, screen: "payoff", stage: "none" },
      expect.any(Function),
    )
    tab.stop()
    stopStartOver()
  })

  it("does nothing when the page hides and shows without a hand-off", () => {
    const stopStartOver = watchStartOver()
    const tab = page()

    tab.hide()
    tab.show(90_000)

    expect(requestSelfReload).not.toHaveBeenCalled()
    tab.stop()
    stopStartOver()
  })
})
