// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it, vi } from "vitest"
import { createDrawCeremony, type DrawCeremonyEvidence } from "./ceremony"

function harness() {
  let clock = 1_000
  const reports: DrawCeremonyEvidence[] = []
  const devLog = vi.fn()
  const ceremony = createDrawCeremony({ now: () => clock, devLog, report: (row) => reports.push(row) })
  return {
    ceremony,
    reports,
    devLog,
    advance(ms: number) {
      clock += ms
    },
  }
}

describe("draw wheel ceremony", () => {
  it("records the normal mounted, ended and tapped path once", () => {
    const run = harness()
    run.ceremony.loadStarted()
    run.advance(20)
    run.ceremony.mounted()
    run.advance(80)
    expect(run.ceremony.ended()).toBe(true)
    run.advance(50)
    expect(run.ceremony.tap()).toBe(true)
    expect(run.ceremony.tap()).toBe(false)
    expect(run.reports).toEqual([
      {
        totalMs: 150,
        loadMs: 20,
        endingMs: 80,
        continueVisibleMs: 50,
        hiddenMs: 0,
        ended: true,
        tapped: true,
        idleAdvanced: false,
        fallbackReason: "none",
      },
    ])
  })

  it.each(["load-failed", "mount-failed"] as const)("exposes Continue and reports %s", (reason) => {
    const run = harness()
    run.ceremony.loadStarted()
    run.advance(25)
    expect(run.ceremony.fallback(reason, "failure detail")).toBe(true)
    expect(run.ceremony.fallback(reason)).toBe(false)
    expect(run.reports).toHaveLength(0)
    run.ceremony.leave()
    expect(run.reports).toHaveLength(1)
    expect(run.reports[0]).toMatchObject({ ended: false, tapped: false, fallbackReason: reason })
  })

  it("reports a stage that never reaches ended and still permits one Continue tap", () => {
    const run = harness()
    run.ceremony.loadStarted()
    run.ceremony.mounted()
    run.advance(47_000)
    expect(run.ceremony.fallback("never-ended")).toBe(true)
    expect(run.ceremony.tap()).toBe(true)
    expect(run.reports).toHaveLength(1)
    expect(run.reports[0]).toMatchObject({ ended: false, tapped: true, fallbackReason: "never-ended" })
  })

  it("reports where a stage that never ended stood", () => {
    const run = harness()
    run.ceremony.mounted()
    run.advance(52_000)
    run.ceremony.fallback("never-ended", undefined, { ready: true, spun: false, story_s: 3.2, frames: 3100 })
    run.ceremony.tap()
    expect(run.reports[0]).toMatchObject({ fallbackReason: "never-ended", stall: { ready: true, spun: false, story_s: 3.2 } })
  })

  it("tracks a hidden and resumed interval in the final evidence", () => {
    const run = harness()
    run.ceremony.loadStarted()
    run.ceremony.mounted()
    run.advance(100)
    run.ceremony.hidden()
    run.advance(2_000)
    run.ceremony.resumed()
    run.advance(100)
    run.ceremony.ended()
    run.advance(20)
    run.ceremony.tap()
    expect(run.reports[0]).toMatchObject({ hiddenMs: 2_000, tapped: true })
  })

  it("counts Continue shown but not tapped when the page is left", () => {
    const run = harness()
    run.ceremony.loadStarted()
    run.ceremony.mounted()
    run.ceremony.ended()
    run.advance(500)
    run.ceremony.leave()
    expect(run.reports[0]).toMatchObject({ ended: true, tapped: false, continueVisibleMs: 500 })
  })

  it("records a player who leaves while the mounted wheel is still stuck before ended", () => {
    const run = harness()
    run.ceremony.loadStarted()
    run.ceremony.mounted()
    run.advance(500)
    run.ceremony.leave()
    run.ceremony.leave()
    expect(run.reports).toHaveLength(1)
    expect(run.reports[0]).toMatchObject({
      ended: false,
      tapped: false,
      idleAdvanced: false,
      continueVisibleMs: -1,
      fallbackReason: "none",
    })
  })

  it("is idempotent through a StrictMode-style mount, cleanup and effect replay", () => {
    const run = harness()
    let navigations = 0
    run.ceremony.loadStarted()
    run.ceremony.mounted()
    // React development StrictMode replays the mounting effect on the same
    // component instance and therefore the same ceremony controller.
    run.ceremony.loadStarted()
    run.ceremony.mounted()
    run.ceremony.ended()
    run.ceremony.ended()
    if (run.ceremony.tap()) navigations += 1
    if (run.ceremony.tap()) navigations += 1
    expect(navigations).toBe(1)
    expect(run.reports).toHaveLength(1)
  })

  it("an idle advance is reported as idle, not as an abandoned page, and only once", () => {
    const run = harness()
    run.ceremony.mounted()
    expect(run.ceremony.idleAdvance()).toBe(true)
    expect(run.ceremony.idleAdvance()).toBe(false)
    run.ceremony.leave()
    expect(run.reports).toHaveLength(1)
    expect(run.reports[0]).toMatchObject({ idleAdvanced: true, tapped: false })
  })
})
