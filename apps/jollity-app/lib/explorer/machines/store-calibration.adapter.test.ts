// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { createStoreCalibrationState } from "../../store-calibration"
import { storeCalibrationTransitionTable } from "../../state-machines/store-calibration.definition"
import { exploreMachine } from "./explore-machine"
import { fromDefinition, plantStaleReal } from "./from-definition"
import { MACHINES } from "./registry"
import { storeCalibrationAdapter } from "./store-calibration.adapter"

const EVENTS = ["request-early", "request-ready", "settle-accepted", "settle-failed"]

describe("store-calibration adapter", () => {
  it("starts only from the normal start state", () => {
    const initial = storeCalibrationAdapter.initial()
    expect(initial).toHaveLength(1)
    expect(initial[0].label).toBe("start")
    expect(initial[0].state.real).toEqual(createStoreCalibrationState())
  })

  it("enables the 4 store-calibration event keys", () => {
    expect([...storeCalibrationAdapter.enabledEvents(storeCalibrationAdapter.initial()[0].state)].sort()).toEqual(EVENTS)
  })

  it("explores to depth 8 with no violation", () => {
    const report = exploreMachine(storeCalibrationAdapter, { depth: 8, maxStates: 100_000 })
    expect(report.violations).toEqual([])
    expect(report.states).toBeGreaterThan(1)
    expect(report.frontierClosed || report.depthCompleted === 8).toBe(true)
  })

  it("catches a planted bug on request-ready", () => {
    // the ready request starts the attempt; a real side that stays put is a declared-vs-outcome mismatch
    expect(exploreMachine(plantStaleReal(storeCalibrationAdapter, "request-ready"), { depth: 2, maxStates: 1000 }).violations.length).toBeGreaterThan(0)
  })

  it("declares no trace monitor, because every invariant reads one step only", () => {
    // "at most one retained attempt starts" and "a failed attempt records its retry epoch"
    // both check {real, realObservation} of the step in hand, never the trace
    expect(storeCalibrationAdapter.traceMonitor).toBeUndefined()
    expect(storeCalibrationAdapter.excluded ?? []).toEqual([])
  })

  it("is registered for npm run explore", () => {
    expect(MACHINES["store-calibration"]).toBe(storeCalibrationAdapter)
  })

  it("catches a flipped declared cell", () => {
    // idle x request-early is the FIRST transition the search takes (alphabetical), and the
    // table declares it a transition; declaring it a no-op must be a declared-vs-outcome
    // violation on exactly that edge.
    expect(storeCalibrationTransitionTable.idle["request-early"]).toBe("transition")
    // flip the declared cell on the adapter's OWN definition, so only the table differs
    const flipped = fromDefinition({
      ...storeCalibrationAdapter.definition,
      transitionTable: { ...storeCalibrationTransitionTable, idle: { ...storeCalibrationTransitionTable.idle, "request-early": "no-op" } },
    } as never)
    const report = exploreMachine(flipped, { depth: 1, maxStates: 1_000 })
    expect(report.violations.map((violation) => violation.trace)).toEqual([["start", "request-early"]])
  })

  it("runs the definition's own invariants, not an empty list", () => {
    expect(storeCalibrationAdapter.definition.invariants.map((invariant) => invariant.name)).toEqual([
      "at most one retained attempt starts",
      "a failed attempt records its retry epoch",
    ])
  })

  it("catches a double start through the definition's invariant", () => {
    // plant a second start command on BOTH sides, so the step itself agrees and only
    // "at most one retained attempt starts" can object
    const planted = {
      ...storeCalibrationAdapter,
      step: (state: never, event: string) => {
        const result = storeCalibrationAdapter.step(state, event as never)
        if (event !== "request-ready") return result
        return {
          state: result.state,
          output: {
            real: [...result.output.real, ...result.output.real],
            model: [...result.output.model, ...result.output.model],
          },
        }
      },
    }
    const report = exploreMachine(planted as never, { depth: 3, maxStates: 10_000 })
    expect(report.violations.map((violation) => violation.message).join("\n")).toMatch(/multiple start commands|at most one retained attempt/)
  })

  it("carries a cell index, so unreached declared cells are reported", () => {
    expect(exploreMachine({ ...storeCalibrationAdapter }, { depth: 1, maxStates: 100 }).unreachedCells).toBe("cell list unknown")
    expect(exploreMachine(storeCalibrationAdapter, { depth: 1, maxStates: 100 }).unreachedCells).not.toBe("cell list unknown")
  })
})
