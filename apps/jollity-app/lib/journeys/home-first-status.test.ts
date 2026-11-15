// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../telemetry", async () => (await import("../telemetry/testing")).fakeTelemetryModule())

import { journeysNamed, recorded, resetRecorded } from "../telemetry/testing"
import {
  beginHomeFirstStatus,
  endHomeFirstStatus,
  homeGameRead,
  homeReadFailed,
  homeReadTimedOut,
  homeSourceResolved,
  homeWatchFired,
  resetHomeFirstStatusForTests,
} from "./home-first-status"

/** a page that can hide: the journey listens on window and document */
function fakePage() {
  const listeners = new Map<string, Set<(e: never) => void>>()
  const target = {
    addEventListener: (type: string, fn: (e: never) => void) => (listeners.get(type) ?? listeners.set(type, new Set()).get(type)!).add(fn),
    removeEventListener: (type: string, fn: (e: never) => void) => listeners.get(type)?.delete(fn),
  }
  vi.stubGlobal("window", target)
  vi.stubGlobal("document", { ...target, visibilityState: "visible" })
  return { fire: (type: string, event: object = {}) => listeners.get(type)?.forEach((fn) => (fn as (e: object) => void)(event)), count: (type: string) => listeners.get(type)?.size ?? 0 }
}

beforeEach(() => {
  resetRecorded()
  resetHomeFirstStatusForTests()
})
afterEach(() => vi.unstubAllGlobals())

describe("journey.home-first-status (#530)", () => {
  it("is sent as stuck, naming the pending inputs, when the page goes away still loading", () => {
    const page = fakePage()
    beginHomeFirstStatus()
    homeSourceResolved()
    homeReadTimedOut()
    homeReadFailed()
    page.fire("pagehide")

    const [journey] = journeysNamed("home-first-status")
    expect(journey.outcome).toBe("stuck")
    expect(journey.sad).toEqual(["stuck"])
    expect(journey.endAttrs).toMatchObject({
      pending: "game,schedule,watch",
      "reads.timeouts": "1",
      "reads.failures": "1",
    })
    expect(recorded.metricFlushes).toBe(1)
  })

  it("does not end as stuck when the page enters the back/forward cache", () => {
    const page = fakePage()
    beginHomeFirstStatus()
    page.fire("pagehide", { persisted: true })
    expect(journeysNamed("home-first-status")[0].ended).toBe(false)
    page.fire("pagehide", { persisted: false })
    expect(journeysNamed("home-first-status")[0].outcome).toBe("stuck")
  })

  it("names the source when it never resolved", () => {
    const page = fakePage()
    beginHomeFirstStatus()
    page.fire("pagehide")
    expect(journeysNamed("home-first-status")[0].endAttrs?.pending).toBe("source,game,schedule,watch")
  })

  it("ends shown on the first status and is quiet at pagehide after that", () => {
    const page = fakePage()
    beginHomeFirstStatus()
    homeSourceResolved()
    homeWatchFired()
    homeGameRead(true)
    endHomeFirstStatus("shown")
    page.fire("pagehide")
    const [journey] = journeysNamed("home-first-status")
    expect(journey.outcome).toBe("shown")
    expect(journey.sad).toEqual([])
    expect(journey.endAttrs?.pending).toBe("none")
  })

  it("ends restart-card with its reason, and a later shown does not rewrite it", () => {
    fakePage()
    beginHomeFirstStatus()
    endHomeFirstStatus("restart-card", { reason: "host-unanswered" })
    endHomeFirstStatus("shown")
    const [journey] = journeysNamed("home-first-status")
    expect(journey.outcome).toBe("restart-card")
    expect(journey.endAttrs).toMatchObject({ reason: "host-unanswered" })
  })

  it("leaves nothing behind when the page unmounts (a route change is not a stuck launch)", () => {
    const page = fakePage()
    const stop = beginHomeFirstStatus()
    stop()
    page.fire("pagehide")
    expect(page.count("pagehide")).toBe(0)
    expect(journeysNamed("home-first-status")[0].ended).toBe(false)
  })
})
