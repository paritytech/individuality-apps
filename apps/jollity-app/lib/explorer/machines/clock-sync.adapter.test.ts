// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { createClockSync } from "../../clock-sync"
import { clockSyncTransitionTable } from "../../state-machines/clock-sync.definition"
import { exploreMachine } from "./explore-machine"
import { fromDefinition, plantStaleReal } from "./from-definition"
import { clockSyncAdapter } from "./clock-sync.adapter"
import { MACHINES } from "./registry"

const EVENTS = ["stale-tick", "target-back", "target-forward", "tick"]

describe("clock-sync adapter", () => {
  it("starts only from the normal start state", () => {
    const initial = clockSyncAdapter.initial()
    expect(initial).toHaveLength(1)
    expect(initial[0].label).toBe("start")
    expect(initial[0].state.real).toEqual(createClockSync())
  })

  it("enables the 4 clock-sync event keys", () => {
    expect([...clockSyncAdapter.enabledEvents(clockSyncAdapter.initial()[0].state)].sort()).toEqual(EVENTS)
  })

  it("explores to depth 8 with no violation", () => {
    const report = exploreMachine(clockSyncAdapter, { depth: 8, maxStates: 100_000 })
    expect(report.violations).toEqual([])
    expect(report.states).toBeGreaterThan(1)
    expect(report.frontierClosed || report.depthCompleted === 8).toBe(true)
  })

  it("catches a planted bug on target-forward", () => {
    expect(exploreMachine(plantStaleReal(clockSyncAdapter, "target-forward"), { depth: 2, maxStates: 1000 }).violations.length).toBeGreaterThan(0)
  })

  it("declares no trace monitor, because both invariants read one step only", () => {
    // "shown clock never runs backward" compares previousReal with real on the step in
    // hand; "clock state stays finite" reads this step's real state. Neither reads the trace.
    expect(clockSyncAdapter.traceMonitor).toBeUndefined()
    expect(clockSyncAdapter.excluded ?? []).toEqual([])
  })

  it("is registered for npm run explore", () => {
    expect(MACHINES["clock-sync"]).toBe(clockSyncAdapter)
  })

  it("catches a flipped declared cell", () => {
    // fresh x stale-tick is now a transition (the declaration fix this PR carries), so flip a
    // different real transition: fresh x target-forward declared a no-op
    expect(clockSyncTransitionTable.fresh["target-forward"]).toBe("transition")
    const flipped = fromDefinition({
      ...clockSyncAdapter.definition,
      transitionTable: { ...clockSyncTransitionTable, fresh: { ...clockSyncTransitionTable.fresh, "target-forward": "no-op" } },
    } as never)
    const report = exploreMachine(flipped, { depth: 1, maxStates: 1_000 })
    expect(report.violations.map((violation) => violation.trace)).toEqual([["start", "target-forward"]])
  })

  it("runs the definition's own invariants, not an empty list", () => {
    // The first version set `invariants: []`, which silently switched off "shown clock never
    // runs backward" and "clock state stays finite" for the whole search.
    expect(clockSyncAdapter.definition.invariants.map((invariant) => invariant.name)).toEqual([
      "shown clock never runs backward",
      "clock state stays finite",
    ])
  })

  it("catches a clock that runs backward through the definition's invariant", () => {
    // plant a step that moves shown time backwards on BOTH sides, so the step itself agrees
    // and only the invariant can object
    const planted = {
      ...clockSyncAdapter,
      step: (state: never, event: string) => {
        const result = clockSyncAdapter.step(state, event as never)
        if (event !== "tick") return result
        const s = state as unknown as { real: Record<string, unknown>; model: Record<string, unknown> }
        return {
          state: { real: { ...result.state.real, shownMs: Number(s.real.shownMs) - 500 }, model: { ...result.state.model, shownMs: Number(s.model.shownMs) - 500 } },
          output: result.output,
        }
      },
    }
    const report = exploreMachine(planted as never, { depth: 4, maxStates: 10_000 })
    expect(report.violations.map((violation) => violation.message).join("\n")).toMatch(/never runs backward|backward/)
  })

  it("carries a cell index, so unreached declared cells are reported", () => {
    expect(exploreMachine({ ...clockSyncAdapter }, { depth: 1, maxStates: 100 }).unreachedCells).toBe("cell list unknown")
    expect(exploreMachine(clockSyncAdapter, { depth: 1, maxStates: 100 }).unreachedCells).not.toBe("cell list unknown")
  })
})
