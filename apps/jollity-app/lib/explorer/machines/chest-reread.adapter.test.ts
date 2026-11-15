// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { createChestRereadState } from "../../chest-reread"
import { chestRereadMachineDefinition } from "../../state-machines/chest-reread.definition"
import { chestRereadAdapter } from "./chest-reread.adapter"
import { exploreMachine } from "./explore-machine"
import { fromDefinition, plantStaleReal } from "./from-definition"
import { MACHINES } from "./registry"

const EVENTS = ["failure-hidden", "failure-visible", "shown-hidden", "shown-visible", "start", "stop", "success-hidden", "success-visible",
  "timer-hidden", "timer-visible"]

describe("chest-reread adapter", () => {
  it("starts only from the normal start state", () => {
    const initial = chestRereadAdapter.initial()
    expect(initial).toHaveLength(1)
    expect(initial[0].label).toBe("start")
    expect(initial[0].state.real).toEqual(createChestRereadState())
  })
  it("enables the 10 chest-reread event keys", () => {
    expect([...chestRereadAdapter.enabledEvents(chestRereadAdapter.initial()[0].state)].sort()).toEqual(EVENTS)
  })
  it("explores to depth 8 with no violation", () => {
    const report = exploreMachine(chestRereadAdapter, { depth: 8, maxStates: 100_000 })
    expect(report.violations).toEqual([])
    expect(report.states).toBeGreaterThan(1)
    expect(report.frontierClosed || report.depthCompleted === 8).toBe(true)
  })
  it("catches a planted bug on start", () => {
    expect(exploreMachine(plantStaleReal(chestRereadAdapter, "start"), { depth: 2, maxStates: 1000 }).violations.length).toBeGreaterThan(0)
  })
  it("needs no trace monitor: every invariant reads one step", () => {
    expect(chestRereadAdapter.traceMonitor).toBeUndefined()
    expect(chestRereadAdapter.excluded ?? []).toEqual([])
  })
  it("is registered for npm run explore", () => {
    expect(MACHINES["chest-reread"]).toBe(chestRereadAdapter)
  })
  it("catches a planted real/model mismatch", () => {
    // the real reducer also asks for a read on a hidden trigger; the model does not
    const planted = {
      ...chestRereadAdapter,
      step: (state: Parameters<typeof chestRereadAdapter.step>[0], event: string) => {
        const result = chestRereadAdapter.step(state, event as never)
        if (event !== "timer-hidden" || state.real.phase !== "waiting") return result
        return { state: result.state, output: { real: [...result.output.real, { kind: "reread" as const }], model: result.output.model } }
      },
    }
    const report = exploreMachine(planted as never, { depth: 3, maxStates: 10_000 })
    expect(report.violations.length).toBeGreaterThan(0)
  })
  it("catches a flipped declared cell", () => {
    const row = "idle" as const
    expect(chestRereadMachineDefinition.transitionTable[row].start).toBe("transition")
    const flipped = fromDefinition({
      ...chestRereadMachineDefinition,
      transitionTable: { ...chestRereadMachineDefinition.transitionTable, [row]: { ...chestRereadMachineDefinition.transitionTable[row], start: "no-op" } },
    })
    const report = exploreMachine(flipped, { depth: 1, maxStates: 1_000 })
    expect(report.violations.map((violation) => violation.trace)).toEqual([["start", "start"]])
  })
  it("reports an unknown cell list for an adapter without a cell index", () => {
    const bare = { ...chestRereadAdapter }
    expect(exploreMachine(bare, { depth: 1, maxStates: 100 }).unreachedCells).toBe("cell list unknown")
    expect(exploreMachine(chestRereadAdapter, { depth: 1, maxStates: 100 }).unreachedCells).not.toBe("cell list unknown")
  })
})
