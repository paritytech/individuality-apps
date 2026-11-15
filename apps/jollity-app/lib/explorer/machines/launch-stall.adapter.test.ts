// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { startLaunchStall } from "../../launch-stall"
import { launchStallMachineDefinition, launchStallTransitionTable } from "../../state-machines/launch-stall.definition"
import { exploreMachine } from "./explore-machine"
import { fromDefinition, plantStaleReal } from "./from-definition"
import { MACHINES } from "./registry"
import { launchStallAdapter } from "./launch-stall.adapter"

const EVENTS = ["cancel", "deadline-empty", "deadline-source", "grace", "probe-lost", "probe-other", "probe-timeout"]

describe("launch-stall adapter", () => {
  it("starts only from the normal start state", () => {
    const initial = launchStallAdapter.initial()
    expect(initial).toHaveLength(1)
    expect(initial[0].label).toBe("start")
    expect(initial[0].state.real).toEqual(startLaunchStall())
  })

  it("enables the 7 launch-stall event keys", () => {
    expect([...launchStallAdapter.enabledEvents(launchStallAdapter.initial()[0].state)].sort()).toEqual(EVENTS)
  })

  it("explores to depth 8 with no violation", () => {
    const report = exploreMachine(launchStallAdapter, { depth: 8, maxStates: 100_000 })
    expect(report.violations).toEqual([])
    expect(report.states).toBeGreaterThan(1)
    expect(report.frontierClosed || report.depthCompleted === 8).toBe(true)
  })

  it("catches a planted bug on deadline-source", () => {
    // the healthy path must move armed -> probing; a real side that stays put is a declared-vs-outcome mismatch
    expect(exploreMachine(plantStaleReal(launchStallAdapter, "deadline-source"), { depth: 2, maxStates: 1000 }).violations.length).toBeGreaterThan(0)
  })

  it("declares a trace monitor covering the one whole-trace invariant", () => {
    // launch-stall.definition.ts: "the machine reports at most one stall" reads the whole trace
    expect(launchStallAdapter.traceMonitor?.covers).toEqual(["the machine reports at most one stall"])
    expect(launchStallAdapter.excluded ?? []).toEqual([])
  })

  it("is registered for npm run explore", () => {
    expect(MACHINES["launch-stall"]).toBe(launchStallAdapter)
  })

  it("catches a second stall through the trace monitor", () => {
    // duplicate and out-of-order timers are the real corpus's own case: the machine must never report twice
    const planted = {
      ...launchStallAdapter,
      step: (state: never, event: string) => {
        const result = launchStallAdapter.step(state, event as never)
        if (event !== "deadline-empty") return result
        // the same extra stall in BOTH sides, so the step itself still agrees: only the
        // whole-trace invariant ("at most one stall") can object
        // real commands are objects (observeReal turns them into words), model output is
        // already the words; appending the same stall to both keeps the step itself in
        // agreement so only the whole-trace invariant can object
        return {
          state: result.state,
          output: {
            real: [...result.output.real, { kind: "stall" as const, reason: "host-unanswered" as const }],
            model: [...result.output.model, "stall:host-unanswered"],
          },
        }
      },
    }
    const report = exploreMachine(planted as never, { depth: 4, maxStates: 10_000 })
    expect(report.violations.map((violation) => violation.message).join("\n")).toMatch(/multiple stalls|at most one stall/)
  })

  it("catches a flipped declared cell", () => {
    // the healthy deadline moves armed to probing; declaring it a no-op must be a declared-vs-outcome violation
    expect(launchStallTransitionTable.armed["deadline-source"]).toBe("transition")
    const flipped = fromDefinition({
      ...launchStallMachineDefinition,
      transitionTable: { ...launchStallTransitionTable, armed: { ...launchStallTransitionTable.armed, "deadline-source": "no-op" } },
    })
    const report = exploreMachine(flipped, { depth: 1, maxStates: 1_000 })
    expect(report.violations.map((violation) => violation.trace)).toEqual([["start", "deadline-source"]])
  })

  it("carries a cell index, so unreached declared cells are reported", () => {
    // fromDefinition registers the table's cells; a spread copy loses that registration,
    // which is how the worked example proves the index is real.
    expect(exploreMachine({ ...launchStallAdapter }, { depth: 1, maxStates: 100 }).unreachedCells).toBe("cell list unknown")
    expect(exploreMachine(launchStallAdapter, { depth: 1, maxStates: 100 }).unreachedCells).not.toBe("cell list unknown")
  })
})
