// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { startReadRetry } from "../../read-retry"
import { readRetryMachineDefinition } from "../../state-machines/read-retry.definition"
import { exploreMachine } from "./explore-machine"
import { fromDefinition, plantStaleReal } from "./from-definition"
import { MACHINES } from "./registry"
import { readRetryAdapter } from "./read-retry.adapter"

const EVENTS = ["abort", "answer", "fail", "start", "wait"]

describe("read-retry adapter", () => {
  it("starts only from the normal start state", () => {
    const initial = readRetryAdapter.initial()
    expect(initial).toHaveLength(1)
    expect(initial[0].label).toBe("start")
    expect(initial[0].state.real).toEqual(startReadRetry([10]))
  })
  it("enables the 5 read-retry event keys", () => {
    expect([...readRetryAdapter.enabledEvents(readRetryAdapter.initial()[0].state)].sort()).toEqual(EVENTS)
  })
  it("explores to depth 8 with no violation", () => {
    const report = exploreMachine(readRetryAdapter, { depth: 8, maxStates: 100_000 })
    expect(report.violations).toEqual([])
    expect(report.states).toBeGreaterThan(1)
    expect(report.frontierClosed || report.depthCompleted === 8).toBe(true)
  })
  it("catches a planted bug on start", () => {
    expect(exploreMachine(plantStaleReal(readRetryAdapter, "start"), { depth: 2, maxStates: 1000 }).violations.length).toBeGreaterThan(0)
  })
  it("declares a trace monitor for the duplicate-attempt invariant", () => {
    expect(readRetryAdapter.traceMonitor?.covers).toHaveLength(1)
    expect(readRetryAdapter.excluded ?? []).toEqual([])
  })
  it("is registered for npm run explore", () => {
    expect(MACHINES["read-retry"]).toBe(readRetryAdapter)
  })

  it("catches a repeated attempt through the trace monitor", () => {
    // the second wait re-emits read:2 in lockstep in real and model, so only the whole-trace invariant can object
    const planted = {
      ...readRetryAdapter,
      step: (state: ReturnType<typeof readRetryAdapter.initial>[number]["state"], event: string) => {
        const result = readRetryAdapter.step(state, event as never)
        if (event !== "answer" || state.real.phase !== "reading" || state.real.attempt !== 2) return result
        return { state: result.state, output: { real: [{ kind: "read" as const, attempt: 2 }], model: ["read:2"] } }
      },
    }
    const report = exploreMachine(planted as never, { depth: 6, maxStates: 10_000 })
    expect(report.violations.map((violation) => violation.message).join("\n")).toMatch(/duplicate attempt|read on answer/)
  })

  it("catches a flipped declared cell", () => {
    const row = "idle" as const
    expect(readRetryMachineDefinition.transitionTable[row].start).toBe("transition")
    const flipped = fromDefinition({
      ...readRetryMachineDefinition,
      transitionTable: { ...readRetryMachineDefinition.transitionTable, [row]: { ...readRetryMachineDefinition.transitionTable[row], start: "no-op" } },
    })
    const report = exploreMachine(flipped, { depth: 1, maxStates: 1_000 })
    expect(report.violations.map((violation) => violation.trace)).toEqual([["start", "start"]])
  })

  it("reports an unknown cell list for an adapter without a cell index", () => {
    const bare = { ...readRetryAdapter }
    expect(exploreMachine(bare, { depth: 1, maxStates: 100 }).unreachedCells).toBe("cell list unknown")
    expect(exploreMachine(readRetryAdapter, { depth: 1, maxStates: 100 }).unreachedCells).not.toBe("cell list unknown")
  })
})
