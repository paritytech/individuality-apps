// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import {
  createSendAdaptationState,
  SendAdaptationController,
  sendAdaptationStep,
  type SendAdaptationEvent,
  type SendAdaptationMachineState,
} from "./send-adaptation"
import { type SendWindowSummary, type VideoRungApplyResult } from "./send-adaptation-classifier"

const summary = (atMs: number, fields: Partial<SendWindowSummary> = {}): SendWindowSummary => ({
  atMs,
  durationMs: 3_000,
  hidden: false,
  effects: { windowMs: 3_000 },
  activeSenders: 5,
  validSenders: 5,
  targetBitrateCoverage: 0,
  targetNearCapShare: 0,
  bandwidthLowTargetShare: 0,
  bandwidthShare: 0,
  cpuShare: 0,
  noneShare: 0,
  stalledShare: 0,
  encoderImplementations: [],
  route: "direct",
  pressure: "unknown",
  severe: false,
  ...fields,
})

const applied = (requested: number, status: "applied" | "partial" | "pending" | "refused" = "applied"): VideoRungApplyResult => ({
  requested,
  uniform: status === "applied",
  senders: [
    {
      id: "sender-a",
      status,
      appliedFields: status === "applied" || status === "partial" ? ["maxBitrate"] : [],
      refusedFields: status === "refused" ? ["maxBitrate"] : [],
    },
  ],
})

describe("SendAdaptationController ceiling", () => {
  it("starts at the ceiling rung and never recovers above it", () => {
    const c = new SendAdaptationController({ ceiling: 4 })
    expect(c.state().rung).toBe(4)
    for (let i = 1; i <= 40; i++) expect(c.observe(summary(i * 3_000, { pressure: "healthy" }))).toBeNull()
    expect(c.state().rung).toBe(4)
  })
  it("a mid ceiling still recovers up to it but no higher", () => {
    const c = new SendAdaptationController({ ceiling: 2 })
    for (let i = 1; i <= 40; i++) expect(c.observe(summary(i * 3_000, { pressure: "healthy" }))).toBeNull()
    expect(c.state().rung).toBe(2)
  })
})

describe("SendAdaptationController", () => {
  it("starts every game at the rung named full", () => {
    const c = new SendAdaptationController({
      rungs: [
        { index: 99, name: "hero", maxBitrate: 500_000, maxFramerate: 30, targetShortSide: 540 },
        { index: 7, name: "full", maxBitrate: 300_000, maxFramerate: 24, targetShortSide: 360 },
        { index: 42, name: "floor", maxBitrate: 45_000, maxFramerate: 8, targetShortSide: 120 },
      ],
    })
    expect(c.state().rung).toBe(7)
  })

  it("fits the first valid window directly to known capacity", () => {
    const c = new SendAdaptationController()
    expect(c.observe(summary(3_000, { availableKbps: 60 }))).toMatchObject({ from: 0, to: 4, cause: "bandwidth" })
  })

  it("fits the conservative per-PC estimate once regardless of sender count", () => {
    const c = new SendAdaptationController()
    expect(c.observe(summary(3_000, { activeSenders: 5, validSenders: 5, availableKbps: 1_400 }))).toBeNull()
    expect(c.state().rung).toBe(0)
  })

  it("direct-jumps after two ordinary known-capacity pressure windows", () => {
    const c = new SendAdaptationController()
    expect(c.observe(summary(3_000, { pressure: "healthy", availableKbps: 3_000 }))).toBeNull()
    expect(c.observe(summary(6_000, { pressure: "bandwidth", availableKbps: 60 }))).toBeNull()
    expect(c.observe(summary(9_000, { pressure: "bandwidth", availableKbps: 60 }))).toMatchObject({ from: 0, to: 4 })
  })

  it("direct-jumps after one severe known-capacity pressure window", () => {
    const c = new SendAdaptationController()
    expect(c.observe(summary(3_000, { pressure: "bandwidth", severe: true, availableKbps: 60 }))).toMatchObject({ to: 4 })
  })

  it("descends one ordered rung per pressured window when capacity is unknown", () => {
    const c = new SendAdaptationController()
    const first = c.observe(summary(3_000, { pressure: "bandwidth" }))!
    expect(first).toMatchObject({ from: 0, to: 1 })
    c.accepted(applied(1), 3_000)
    expect(c.observe(summary(6_000, { pressure: "bandwidth" }))).toMatchObject({ from: 1, to: 2 })
  })

  it("never descends below the video floor", () => {
    const c = new SendAdaptationController()
    const first = c.observe(summary(3_000, { availableKbps: 1 }))!
    c.accepted(applied(first.to), 3_000)
    expect(c.state().rung).toBe(4)
    expect(c.observe(summary(6_000, { pressure: "bandwidth", severe: true }))).toBeNull()
  })

  it("freezes on hidden and baseline-only windows", () => {
    const c = new SendAdaptationController()
    expect(c.observe(summary(3_000, { hidden: true, pressure: "bandwidth", severe: true }))).toBeNull()
    expect(c.observe(summary(6_000, { baselineOnly: true, pressure: "bandwidth", severe: true }))).toBeNull()
    expect(c.state()).toMatchObject({ rung: 0, pressureWindows: 0 })
  })

  it("waits for four healthy windows and the hold, then probes one ordered rung up", () => {
    const c = new SendAdaptationController()
    const down = c.observe(summary(3_000, { availableKbps: 60 }))!
    c.accepted(applied(down.to), 3_000)
    for (const at of [6_000, 9_000, 12_000]) expect(c.observe(summary(at, { pressure: "healthy" }))).toBeNull()
    expect(c.observe(summary(15_000, { pressure: "healthy" }))).toMatchObject({ from: 4, to: 3, direction: "up", probe: "start" })
  })

  it("does not start clocks for all-pending application", () => {
    const c = new SendAdaptationController()
    const down = c.observe(summary(3_000, { availableKbps: 60 }))!
    c.accepted(applied(down.to, "pending"), 3_000)
    expect(c.state()).toMatchObject({ rung: 4, mode: "awaiting-apply" })
    expect(c.observe(summary(30_000, { pressure: "healthy" }))).toBeNull()
  })

  it("restores the last good rung when a pending down move is rejected before a failed probe", () => {
    const c = new SendAdaptationController()
    c.observe(summary(3_000, { pressure: "bandwidth", availableKbps: 200 }))
    c.accepted(applied(2), 3_000)
    const down = c.observe(summary(6_000, { pressure: "bandwidth", availableKbps: 60, severe: true }))!
    expect(down).toMatchObject({ from: 2, to: 4 })
    c.accepted(applied(4, "pending"), 6_000)
    c.rejected(applied(4, "refused"), 6_000)

    for (const at of [9_000, 12_000, 15_000]) expect(c.observe(summary(at, { pressure: "healthy" }))).toBeNull()
    const probe = c.observe(summary(18_000, { pressure: "healthy" }))!
    expect(probe).toMatchObject({ from: 2, to: 1, probe: "start" })
    c.accepted(applied(1), 18_000)

    expect(c.observe(summary(21_000, { pressure: "bandwidth", availableKbps: 60 }))).toMatchObject({
      from: 1,
      to: 2,
      probe: "failed",
    })
  })

  it("keeps a pending down move as the last good rung across regroup and a failed probe", () => {
    const c = new SendAdaptationController()
    const down = c.observe(summary(3_000, { pressure: "bandwidth", availableKbps: 60 }))!
    c.accepted(applied(down.to, "pending"), 3_000)
    c.regroup()
    for (const at of [6_000, 9_000, 12_000]) expect(c.observe(summary(at, { pressure: "healthy" }))).toBeNull()
    const probe = c.observe(summary(15_000, { pressure: "healthy" }))!
    c.accepted(applied(probe.to), 15_000)

    expect(c.observe(summary(18_000, { pressure: "bandwidth", availableKbps: 60 }))).toMatchObject({
      from: 3,
      to: 4,
      direction: "down",
      cause: "bandwidth",
      probe: "failed",
    })
  })

  it("keeps steady quiet unchanged when regroup follows a settled parked probe", () => {
    let state: SendAdaptationMachineState = createSendAdaptationState()
    const step = (event: SendAdaptationEvent): void => {
      state = sendAdaptationStep(state, event).state
    }

    step({ kind: "observe", summary: summary(3_000, { pressure: "bandwidth", availableKbps: 60 }) })
    step({ kind: "accepted", result: applied(4), atMs: 3_000 })
    for (const at of [6_000, 9_000, 12_000, 15_000]) step({ kind: "observe", summary: summary(at, { pressure: "healthy" }) })
    step({ kind: "observe", summary: summary(18_000) })
    step({ kind: "accepted", result: applied(3), atMs: 18_000 })
    step({ kind: "observe", summary: summary(21_000, { pressure: "healthy" }) })
    step({ kind: "observe", summary: summary(24_000, { pressure: "healthy" }) })
    const settled = state

    expect(sendAdaptationStep(settled, { kind: "regroup" })).toEqual({ state: settled, commands: [] })
  })

  it("leaves awaiting-apply after four ignored windows, treating the parked request as applied", () => {
    const c = new SendAdaptationController()
    const down = c.observe(summary(3_000, { availableKbps: 200 }))!
    expect(down).toMatchObject({ from: 0, to: 2, direction: "down" })
    c.accepted(applied(down.to, "pending"), 3_000)
    for (const at of [6_000, 9_000, 12_000]) {
      expect(c.observe(summary(at, { pressure: "healthy" }))).toBeNull()
      expect(c.state()).toMatchObject({ rung: down.to, mode: "awaiting-apply" })
    }
    expect(c.observe(summary(15_000, { pressure: "healthy" }))).toBeNull()
    expect(c.state()).toMatchObject({ rung: down.to, mode: "down-hold" })
    expect(c.observe(summary(18_000, { pressure: "bandwidth" }))).toMatchObject({ from: down.to, direction: "down" })
  })

  it("never stays parked: the ladder leaves awaiting-apply within twenty windows (H-D1)", () => {
    const c = new SendAdaptationController()
    let t = 3_000
    const down = c.observe(summary(t, { pressure: "bandwidth", availableKbps: 200 }))!
    expect(down).toMatchObject({ from: 0, to: 2, direction: "down" })
    c.accepted(applied(down.to, "pending"), t)
    const parkedRung = c.state().rung
    for (let i = 0; i < 20; i++) {
      t += 3_000
      const tr = c.observe(summary(t, { pressure: i % 2 ? "healthy" : "bandwidth" }))
      if (tr) c.accepted(applied(tr.to), t)
    }
    const s = c.state()
    expect(s.mode !== "awaiting-apply" || s.rung !== parkedRung, `mode ${s.mode}, rung ${s.rung}`).toBe(true)
  })

  it("accepts partial application when bitrate held and rejects all-refused", () => {
    const partial = new SendAdaptationController()
    const transition = partial.observe(summary(3_000, { availableKbps: 60 }))!
    partial.accepted(applied(transition.to, "partial"), 3_000)
    expect(partial.state()).toMatchObject({ rung: 4, mode: "down-hold" })

    const refused = new SendAdaptationController()
    const rejected = refused.observe(summary(3_000, { availableKbps: 60 }))!
    refused.rejected(applied(rejected.to, "refused"), 3_000)
    expect(refused.state()).toMatchObject({ rung: 0, mode: "steady" })
  })

  it("settles one controller request once and ignores stable-sender re-applies", () => {
    const c = new SendAdaptationController()
    const down = c.observe(summary(3_000, { availableKbps: 60 }))!
    c.accepted(applied(down.to), 3_000)
    expect(c.acceptsResult(applied(down.to))).toBe(false)
    c.rejected(applied(down.to, "refused"), 4_000)
    expect(c.state()).toMatchObject({ rung: 4, mode: "down-hold", recoveryHoldMs: 12_000 })
  })

  it("falls back a failed probe and increases recovery backoff", () => {
    const c = new SendAdaptationController()
    const down = c.observe(summary(3_000, { availableKbps: 60 }))!
    c.accepted(applied(down.to), 3_000)
    for (const at of [6_000, 9_000, 12_000, 15_000]) c.observe(summary(at, { pressure: "healthy" }))
    const probe = c.state().transition!
    c.accepted(applied(probe.to), 15_000)
    expect(c.observe(summary(18_000, { pressure: "bandwidth" }))).toMatchObject({ to: 4, probe: "failed" })
    c.accepted(applied(4), 18_000)
    expect(c.state().recoveryHoldMs).toBe(24_000)
  })

  it("clears in-flight probe credit on regroup without counting failure", () => {
    const c = new SendAdaptationController()
    const down = c.observe(summary(3_000, { availableKbps: 60 }))!
    c.accepted(applied(down.to), 3_000)
    for (const at of [6_000, 9_000, 12_000, 15_000]) c.observe(summary(at, { pressure: "healthy" }))
    c.accepted(applied(c.state().transition!.to), 15_000)
    c.regroup()
    expect(c.state()).toMatchObject({ rung: 4, mode: "steady", recoveryHoldMs: 12_000 })
  })

  it("does not re-arm the once-per-game capacity jump after regroup", () => {
    const c = new SendAdaptationController()
    expect(c.observe(summary(3_000, { pressure: "healthy", availableKbps: 3_000 }))).toBeNull()
    c.regroup()
    expect(c.observe(summary(6_000, { pressure: "bandwidth", availableKbps: 60 }))).toBeNull()
    expect(c.observe(summary(9_000, { pressure: "bandwidth", availableKbps: 60 }))).toMatchObject({ to: 4 })
  })
})
