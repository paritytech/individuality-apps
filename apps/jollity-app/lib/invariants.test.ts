// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { beforeEach, describe, expect, it, vi } from "vitest"

const sent = vi.hoisted(() => ({
  counts: [] as Array<{ name: string; value: number; attrs: Record<string, string> }>,
  gauges: [] as Array<{ name: string; value: number; unit: string; attrs: Record<string, string> }>,
  logs: [] as Array<{ name: string; level: string; attrs: Record<string, unknown>; detail?: string }>,
}))
vi.mock("./telemetry/metrics", () => ({
  recordCount: (name: string, value: number, attrs: Record<string, string>) => sent.counts.push({ name, value, attrs }),
  recordGauge: (name: string, value: number, unit: string, attrs: Record<string, string>) =>
    sent.gauges.push({ name, value, unit, attrs }),
}))
vi.mock("./telemetry/log-event", () => ({
  logEvent: (name: string, level: string, attrs: Record<string, unknown>, detail?: string) =>
    sent.logs.push({ name, level, attrs, detail }),
}))
const lines = vi.hoisted(() => ({ all: [] as Array<{ tag: string; message: string; data?: unknown }> }))
vi.mock("./debug/log-store", () => ({
  devLog: (tag: string, message: string, data?: unknown) => lines.all.push({ tag, message, data }),
}))

import {
  advanceAwakeClock,
  beginInvariantSession,
  funnelOrderBreach,
  logStoppedBeforePayoff,
  noteInvariant,
  payoffForAnotherGame,
  RECOVERY_HOLD_LIMIT_MS,
  RECOVERY_TICK_MS,
  recoveryHoldExpired,
  reportedInvariants,
  resetInvariantsForTests,
} from "./invariants"
import type { FunnelStage } from "./webrtc/funnel"

const stamps = (entries: Partial<Record<FunnelStage, number>>) => new Map(Object.entries(entries) as Array<[FunnelStage, number]>)

beforeEach(() => {
  resetInvariantsForTests()
  sent.counts.length = 0
  sent.gauges.length = 0
  sent.logs.length = 0
  lines.all.length = 0
})

describe("dedupe", () => {
  it("sends one log and one count per kind per session, not one per occurrence", () => {
    expect(noteInvariant({ kind: "funnel-out-of-order", detail: { stage: "offer" } })).toBe(true)
    expect(noteInvariant({ kind: "funnel-out-of-order", detail: { stage: "answer" } })).toBe(false)
    expect(noteInvariant({ kind: "funnel-out-of-order" })).toBe(false)
    expect(sent.logs).toHaveLength(1)
    // the METRIC carries the kind alone: a detail field would make one series
    // per occurrence and no dashboard could count the kind
    expect(sent.counts).toEqual([{ name: "invariant", value: 1, attrs: { "invariant.kind": "funnel-out-of-order" } }])
    // the log still carries the detail, for the report
    expect(sent.logs[0].attrs).toMatchObject({ "invariant.kind": "funnel-out-of-order", stage: "offer" })
    expect(lines.all).toHaveLength(1)
    expect(reportedInvariants()).toEqual(["funnel-out-of-order"])
  })

  it("starts a fresh set at a new game, so game N+1's line is not swallowed by game N's", () => {
    noteInvariant({ kind: "funnel-out-of-order" })
    expect(noteInvariant({ kind: "funnel-out-of-order" })).toBe(false)
    beginInvariantSession()
    expect(reportedInvariants()).toEqual([])
    expect(noteInvariant({ kind: "funnel-out-of-order" })).toBe(true)
  })

  it("keeps each kind independent", () => {
    noteInvariant({ kind: "funnel-out-of-order" })
    noteInvariant({ kind: "payoff-without-join" })
    expect(sent.logs.map((log) => log.name)).toEqual(["invariant.funnel-out-of-order", "invariant.payoff-without-join"])
    expect(reportedInvariants()).toEqual(["funnel-out-of-order", "payoff-without-join"])
  })

  it("sends a gauge for a measured kind, and none for an unmeasured one", () => {
    noteInvariant({ kind: "recovery-hold-never-ends", valueMs: 61_234, detail: { peers: "2" } })
    noteInvariant({ kind: "payoff-without-join" })
    // the gauge carries the kind alone, like the count: the detail would
    // split the aggregate into one series per occurrence
    expect(sent.gauges).toEqual([
      { name: "invariant.value_ms", value: 61_234, unit: "millisecond", attrs: { "invariant.kind": "recovery-hold-never-ends" } },
    ])
    // the numeric attribute stays a number, for filtering; aggregation is the gauge's
    expect(sent.logs[0].attrs["invariant.value_ms"]).toBe(61_234)
    expect(sent.logs[1].attrs["invariant.value_ms"]).toBeUndefined()
  })

})

describe("payoffForAnotherGame", () => {
  it("is a breach only when a known played game differs", () => {
    expect(payoffForAnotherGame(5, 4)).toBe(true)
    expect(payoffForAnotherGame(5, 5)).toBe(false)
    expect(payoffForAnotherGame(null, 4)).toBe(false) // a relaunch says nothing
  })
})

describe("logStoppedBeforePayoff", () => {
  it("is a breach when the newest line predates the payoff", () => {
    expect(logStoppedBeforePayoff(1_000, 2_000)).toBe(true)
    expect(logStoppedBeforePayoff(2_000, 1_000)).toBe(false)
    expect(logStoppedBeforePayoff(1_000, 1_000)).toBe(false)
    expect(logStoppedBeforePayoff(null, 1_000)).toBe(false)
  })
})

describe("funnelOrderBreach", () => {
  it("is a breach when a connection predates the offer that caused it", () => {
    expect(funnelOrderBreach(stamps({ offer: 900 }), { stage: "connected", ms: 100 })).toEqual({ cause: "offer", effect: "connected", causeMs: 900, effectMs: 100 })
  })

  it("is a breach when a first frame predates the connection it needs", () => {
    expect(funnelOrderBreach(stamps({ offer: 100, connected: 900 }), { stage: "first_frame", ms: 500 })).toEqual({
      cause: "connected",
      effect: "first_frame",
      causeMs: 900,
      effectMs: 500,
    })
  })

  it("is quiet when the causal pairs are in order, or one end is unknown", () => {
    expect(funnelOrderBreach(stamps({ offer: 100 }), { stage: "connected", ms: 900 })).toBeNull()
    expect(funnelOrderBreach(stamps({ connected: 900 }), { stage: "first_frame", ms: 2_000 })).toBeNull()
    expect(funnelOrderBreach(new Map(), { stage: "connected", ms: 900 })).toBeNull()
  })

  it("does not assert the funnel's ARRAY order between offer, answer and ice_checking", () => {
    // the answerer's real order: the remote candidates are in the offer, so
    // ICE starts checking before the local answer has finished gathering.
    // This is what every answerer does; it is not a breach.
    expect(funnelOrderBreach(stamps({ offer: 100 }), { stage: "ice_checking", ms: 200 })).toBeNull()
    expect(funnelOrderBreach(stamps({ offer: 100, ice_checking: 200 }), { stage: "answer", ms: 300 })).toBeNull()
    // and an answer before the offer is not causal either: a re-offer can
    // follow it, and the mesh's own glare handling reorders the two
    expect(funnelOrderBreach(stamps({ answer: 300 }), { stage: "offer", ms: 100 })).toBeNull()
  })
})

describe("advanceAwakeClock", () => {
  const TICK = RECOVERY_TICK_MS

  it("counts the gap between two awake ticks", () => {
    const first = advanceAwakeClock(undefined, 1_000, true)
    const next = advanceAwakeClock(first, 1_000 + TICK, true)
    expect(next.awakeMs).toBe(TICK)
  })

  it("counts nothing while the page is hidden or offline", () => {
    let clock = advanceAwakeClock(undefined, 1_000, true)
    clock = advanceAwakeClock(clock, 1_000 + TICK, false)
    clock = advanceAwakeClock(clock, 1_000 + TICK * 2, false)
    expect(clock.awakeMs).toBe(0)
  })

  it("does not count a frozen page's gap, even when it is visible again", () => {
    const clock = advanceAwakeClock(advanceAwakeClock(undefined, 1_000, true), 61_000, true)
    expect(clock.awakeMs).toBe(0)
    // the next normal tick counts again, from where the page really was
    expect(advanceAwakeClock(clock, 61_000 + TICK, true).awakeMs).toBe(TICK)
  })

  it("a phone back from a minute in the background starts its count afresh", () => {
    // backgrounded at 1 s, back at 61 s: the raw episode age is 60 s but the
    // hold has only been failing for one tick
    let clock = advanceAwakeClock(undefined, 1_000, true)
    clock = advanceAwakeClock(clock, 61_000, true) // the first tick back, visible and online
    expect(recoveryHoldExpired(clock.awakeMs)).toBe(false)
  })
})

describe("recoveryHoldExpired", () => {
  it("expires at two recovery graces", () => {
    expect(RECOVERY_HOLD_LIMIT_MS).toBe(60_000)
    expect(recoveryHoldExpired(59_999)).toBe(false)
    expect(recoveryHoldExpired(60_000)).toBe(true)
    expect(recoveryHoldExpired(Number.NaN)).toBe(false)
  })
})
