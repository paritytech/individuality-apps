// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { beforeEach, describe, expect, it, vi } from "vitest"
import { LONG_BACKGROUND_DRIFT_MS, reportDrift, resetClockForTests, startClockTracking } from "./clock"
import { sendFailure } from "./failures"

vi.mock("./failures", () => ({ sendFailure: vi.fn() }))

interface LifecycleHarness {
  setDrift(value: number): void
  hidden(): void
  shown(): void
  pagehide(persisted: boolean): void
}

function lifecycle(options: { initialDrift?: number; initiallyHidden?: boolean } = {}): LifecycleHarness {
  let drift = options.initialDrift ?? 0
  let onHidden = () => {}
  let onShown = () => {}
  let onPagehide: (event?: PageTransitionEvent) => void = () => {}
  startClockTracking({
    hidden: () => options.initiallyHidden ?? false,
    readDrift: () => drift,
    watchHidden: (hide, show, pagehide) => {
      onHidden = hide
      onShown = show ?? (() => {})
      onPagehide = pagehide ?? (() => {})
      return () => {}
    },
  })
  return {
    setDrift(value) {
      drift = value
    },
    hidden: () => onHidden(),
    shown: () => onShown(),
    pagehide: (persisted) => onPagehide({ persisted } as PageTransitionEvent),
  }
}

beforeEach(() => {
  vi.unstubAllGlobals()
  resetClockForTests()
  vi.mocked(sendFailure).mockReset()
})

describe("clock drift failure", () => {
  it("reports unexplained drift past the limit", () => {
    lifecycle().setDrift(-6_000)
    reportDrift(-6_000, "signup")
    expect(sendFailure).toHaveBeenCalledWith("clock-drift", {
      reason: "span-clock",
      context: { drift_ms: "-6000", journey: "signup" },
    })
  })

  it("credits drift already present when tracking starts hidden", () => {
    lifecycle({ initialDrift: -12_000, initiallyHidden: true })
    reportDrift(-12_000, "signup")
    expect(sendFailure).not.toHaveBeenCalled()
  })

  it("credits drift from a pre-hydration hidden interval after the page is visible again", () => {
    vi.stubGlobal("performance", {
      getEntriesByType: (type: string) =>
        type === "visibility-state"
          ? [
              { name: "visible", startTime: 0 },
              { name: "hidden", startTime: 100 },
              { name: "visible", startTime: 12_100 },
            ]
          : [],
    })
    lifecycle({ initialDrift: -12_000 })
    reportDrift(-12_000, "signup")
    expect(sendFailure).not.toHaveBeenCalled()
  })

  it("keeps long background drift out of the failure list", () => {
    reportDrift(-(LONG_BACKGROUND_DRIFT_MS + 1), "signup")
    expect(sendFailure).not.toHaveBeenCalled()
  })

  it("tracks hidden drift before the first journey and consumes it", () => {
    const page = lifecycle()
    page.hidden()
    page.setDrift(-10_000)
    page.shown()
    reportDrift(-8_000, "signup")
    expect(sendFailure).not.toHaveBeenCalled()

    page.setDrift(-12_000)
    reportDrift(-12_000, "play")
    expect(sendFailure).toHaveBeenCalledWith("clock-drift", expect.anything())
  })

  it("suppresses drift from a persisted pagehide", () => {
    const page = lifecycle()
    page.pagehide(true)
    page.setDrift(-8_000)
    page.shown()
    reportDrift(-8_000, "signup")
    expect(sendFailure).not.toHaveBeenCalled()
  })

  it("does not credit an ordinary pagehide", () => {
    const page = lifecycle()
    page.pagehide(false)
    page.setDrift(-8_000)
    page.shown()
    reportDrift(-8_000, "signup")
    expect(sendFailure).toHaveBeenCalledOnce()
  })

  it("does not let throttled hidden time hide a later visible freeze", () => {
    const page = lifecycle()
    page.hidden()
    page.shown()
    page.setDrift(-20_000)
    reportDrift(-20_000, "play")
    expect(sendFailure).toHaveBeenCalledOnce()
  })

  it("does not explain positive drift with time away", () => {
    const page = lifecycle()
    page.hidden()
    page.setDrift(-15_000)
    page.shown()
    reportDrift(14_900, "signup")
    expect(sendFailure).toHaveBeenCalledOnce()
  })
})
