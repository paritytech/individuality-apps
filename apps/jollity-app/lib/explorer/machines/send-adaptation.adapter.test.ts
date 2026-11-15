// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { createSendAdaptationState } from "../../webrtc/send-adaptation"
import { sendAdaptationMachineDefinition } from "../../state-machines/send-adaptation.definition"
import { exploreMachine } from "./explore-machine"
import { plantStaleReal } from "./from-definition"
import { MACHINES } from "./registry"
import { sendAdaptationAdapter, sendAdaptationAsStringEvents } from "./send-adaptation.adapter"

const EVENTS = ["accept-held", "accept-pending", "accept-refused", "healthy", "hidden", "pressure-known", "pressure-severe", "pressure-unknown",
  "regroup", "reject", "senderless", "stale-accept", "stale-reject", "unknown"]

describe("send-adaptation adapter", () => {
  it("starts only from the normal start state", () => {
    const initial = sendAdaptationAdapter.initial()
    expect(initial).toHaveLength(1)
    expect(initial[0].label).toBe("start")
    expect(initial[0].state.real).toEqual(createSendAdaptationState())
  })
  it("enables the 14 send-adaptation event keys", () => {
    expect([...sendAdaptationAdapter.enabledEvents(sendAdaptationAdapter.initial()[0].state)].sort()).toEqual(EVENTS)
  })
  it("explores to depth 8 with no violation", () => {
    const report = exploreMachine(sendAdaptationAdapter, { depth: 8, maxStates: 100_000 })
    expect(report.violations).toEqual([])
    expect(report.states).toBeGreaterThan(1)
    expect(report.frontierClosed || report.depthCompleted === 8).toBe(true)
  })
  it("catches a planted real=model breach on pressure-known", () => {
    // the planted real keeps its stale stage while the model moves on: the definition's own real=model check must name it
    const violations = exploreMachine(plantStaleReal(sendAdaptationAdapter, "pressure-known"), { depth: 2, maxStates: 1000 }).violations
    expect(violations.length).toBeGreaterThan(0)
    expect(violations[0].message).toContain("observation mismatch")
  })
  it("needs no trace monitor: every invariant reads one step", () => {
    expect(sendAdaptationAdapter.traceMonitor).toBeUndefined()
    expect(sendAdaptationAdapter.excluded ?? []).toEqual([])
  })
  it("is registered for npm run explore", () => {
    expect(MACHINES["send-adaptation"]).toBe(sendAdaptationAdapter)
  })

  it("catches a flipped declared cell", () => {
    // the first window's unknown capacity spends the fresh flag, so declaring that cell a no-op must be a declared-vs-outcome violation
    const row = "steady-fresh" as const
    expect(sendAdaptationMachineDefinition.transitionTable[row].unknown).toBe("transition")
    const flipped = sendAdaptationAsStringEvents({
      ...sendAdaptationMachineDefinition,
      transitionTable: { ...sendAdaptationMachineDefinition.transitionTable, [row]: { ...sendAdaptationMachineDefinition.transitionTable[row], unknown: "no-op" } },
    })
    const report = exploreMachine(flipped, { depth: 1, maxStates: 1_000 })
    expect(report.violations.map((violation) => violation.trace)).toEqual([["start", "unknown"]])
  })

  it("catches a broken invariant through the wrapped event", () => {
    // a window the ladder must ignore that instead changes real state is caught by the one-step invariant, reading the wrapped event
    const planted = {
      ...sendAdaptationAdapter,
      step: (state: (typeof sendAdaptationAdapter extends { initial(): readonly { state: infer S }[] } ? S : never), event: string) => {
        const result = sendAdaptationAdapter.step(state, event as never)
        return event === "hidden" ? { state: { ...result.state, real: { ...result.state.real, firstWindow: !result.state.real.firstWindow } }, output: result.output } : result
      },
    }
    expect(exploreMachine(planted as never, { depth: 1, maxStates: 1_000 }).violations.length).toBeGreaterThan(0)
  })

  it("reports an unknown cell list for an adapter without a cell index", () => {
    const bare = { ...sendAdaptationAdapter }
    expect(exploreMachine(bare, { depth: 1, maxStates: 100 }).unreachedCells).toBe("cell list unknown")
    expect(exploreMachine(sendAdaptationAdapter, { depth: 1, maxStates: 100 }).unreachedCells).not.toBe("cell list unknown")
  })
})
