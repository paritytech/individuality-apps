// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import {
  createSendAdaptationState,
  sendAdaptationStep,
  SendAdaptationController,
} from "./send-adaptation"
import type { SendWindowSummary, VideoRungApplyResult, VideoRungSenderResult } from "./send-adaptation-classifier"

const summary = (atMs: number, fields: Partial<SendWindowSummary> = {}): SendWindowSummary => ({
  atMs, durationMs: 3_000, hidden: false, effects: { windowMs: 3_000 }, activeSenders: 5, validSenders: 5,
  targetBitrateCoverage: 0, targetNearCapShare: 0, bandwidthLowTargetShare: 0, bandwidthShare: 0, cpuShare: 0,
  noneShare: 0, stalledShare: 0, encoderImplementations: [], route: "direct", pressure: "unknown", severe: false, ...fields,
})
const sender = (status: VideoRungSenderResult["status"], held = false): VideoRungSenderResult => ({
  id: `${status}-${held}`, status, appliedFields: held ? ["maxBitrate"] : [], refusedFields: held ? [] : ["maxBitrate"],
})
const result = (requested: number, senders: VideoRungSenderResult[]): VideoRungApplyResult => ({ requested, senders, uniform: false })
const held = (requested: number): VideoRungApplyResult => result(requested, [sender("applied", true)])

const descend = (controller: SendAdaptationController, atMs: number): number => {
  const move = controller.observe(summary(atMs, { pressure: "bandwidth", severe: true, availableKbps: 60 }))!
  controller.accepted(held(move.to), atMs)
  return move.to
}
const healthy = (controller: SendAdaptationController, times: readonly number[]) => times.map((atMs) => controller.observe(summary(atMs, { pressure: "healthy" })))

describe("send adaptation mutation guards", () => {
  it("pins the initial pure state and apply command discriminant", () => {
    const initial = createSendAdaptationState()
    expect(initial.value).toEqual({ rung: 0, mode: "steady", healthyWindows: 0, pressureWindows: 0, recoveryHoldMs: 12_000, lastGoodRung: 0 })
    const stepped = sendAdaptationStep(initial, { kind: "observe", summary: summary(3_000, { availableKbps: 60 }) })
    expect(stepped.commands).toEqual([{ kind: "apply-rung", transition: stepped.state.requested }])
  })

  it("rejects an empty acknowledgement but accepts any held bitrate in a mixed result", () => {
    const empty = new SendAdaptationController()
    const down = empty.observe(summary(3_000, { availableKbps: 60 }))!
    empty.accepted(result(down.to, []), 3_000)
    expect(empty.state()).toMatchObject({ rung: 0, mode: "steady" })

    const mixed = new SendAdaptationController()
    const mixedDown = mixed.observe(summary(3_000, { availableKbps: 60 }))!
    mixed.accepted(result(mixedDown.to, [sender("pending"), sender("applied", true), sender("missing")]), 3_000)
    expect(mixed.state()).toMatchObject({ rung: 4, mode: "down-hold" })

    const missing = new SendAdaptationController()
    const missingDown = missing.observe(summary(3_000, { availableKbps: 60 }))!
    missing.accepted(result(missingDown.to, [sender("missing"), sender("missing")]), 3_000)
    expect(missing.state()).toMatchObject({ rung: 4, mode: "awaiting-apply" })
  })

  it("requires the recovery hold even when four healthy credits arrived", () => {
    const controller = new SendAdaptationController({ nowMs: 100_000 })
    descend(controller, 103_000)
    expect(healthy(controller, [106_000, 109_000, 112_000, 114_000])).toEqual([null, null, null, null])
    expect(controller.state()).toMatchObject({ rung: 4, mode: "down-hold", healthyWindows: 4 })
  })

  it("recovers to a ceiling and emits no command above it", () => {
    let state = createSendAdaptationState({ ceiling: 2 })
    state = sendAdaptationStep(state, { kind: "observe", summary: summary(3_000, { availableKbps: 60 }) }).state
    state = sendAdaptationStep(state, { kind: "accepted", result: held(4), atMs: 3_000 }).state
    for (const atMs of [18_000, 21_000, 24_000, 27_000]) state = sendAdaptationStep(state, { kind: "observe", summary: summary(atMs, { pressure: "healthy" }) }).state
    state = sendAdaptationStep(state, { kind: "accepted", result: held(3), atMs: 27_000 }).state
    state = sendAdaptationStep(state, { kind: "observe", summary: summary(30_000, { pressure: "healthy" }) }).state
    state = sendAdaptationStep(state, { kind: "observe", summary: summary(33_000, { pressure: "healthy" }) }).state
    for (const atMs of [45_000, 48_000, 51_000, 54_000]) state = sendAdaptationStep(state, { kind: "observe", summary: summary(atMs, { pressure: "healthy" }) }).state
    state = sendAdaptationStep(state, { kind: "accepted", result: held(2), atMs: 54_000 }).state
    state = sendAdaptationStep(state, { kind: "observe", summary: summary(57_000, { pressure: "healthy" }) }).state
    state = sendAdaptationStep(state, { kind: "observe", summary: summary(60_000, { pressure: "healthy" }) }).state
    state = { ...state, value: { ...state.value, healthyWindows: 3 }, lastAppliedAt: 54_000 }
    const blocked = sendAdaptationStep(state, { kind: "observe", summary: summary(70_000, { pressure: "healthy" }) })
    expect(blocked.state.value.rung).toBe(2)
    expect(blocked.commands).toEqual([])
  })

  it("backs repeated failed probes from 12 to 24 to 48 to 60 seconds", () => {
    const controller = new SendAdaptationController()
    descend(controller, 3_000)
    healthy(controller, [6_000, 9_000, 12_000, 15_000])
    controller.accepted(held(3), 15_000)
    const failedOnce = controller.observe(summary(18_000, { pressure: "bandwidth" }))!
    controller.accepted(held(failedOnce.to), 18_000)
    healthy(controller, [24_000, 30_000, 36_000, 42_000])
    controller.accepted(held(3), 42_000)
    const failedTwice = controller.observe(summary(45_000, { pressure: "bandwidth" }))!
    controller.accepted(held(failedTwice.to), 45_000)
    expect(controller.state().recoveryHoldMs).toBe(48_000)
    healthy(controller, [60_000, 75_000, 90_000, 93_000])
    controller.accepted(held(3), 93_000)
    const failedThrice = controller.observe(summary(96_000, { pressure: "bandwidth" }))!
    controller.accepted(held(failedThrice.to), 96_000)
    expect(controller.state().recoveryHoldMs).toBe(60_000)
  })
})
