// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { emptyEvidenceProjection } from "../../evidence-projection"
import { evidenceProjectionMachineDefinition } from "../../state-machines/evidence-projection.definition"
import { evidenceProjectionAdapter } from "./evidence-projection.adapter"
import { exploreMachine } from "./explore-machine"
import { fromDefinition, plantStaleReal } from "./from-definition"
import { MACHINES } from "./registry"

const EVENTS = ["enter-confirm", "gate-not-ready", "gate-ready", "leave-confirm-backward-clock", "override-no-video", "override-seen", "restore", "restore-flipped"]

describe("evidence-projection adapter", () => {
  it("starts only from the normal start state", () => {
    const initial = evidenceProjectionAdapter.initial()
    expect(initial).toHaveLength(1)
    expect(initial[0].label).toBe("start")
    expect(initial[0].state.real).toEqual({ ...emptyEvidenceProjection(), evidenceEpoch: 0, intakeClosed: false, confirmGateOpen: false })
    expect(initial[0].state.model.phase).toBe("open")
  })
  it("enables the 8 evidence-projection event keys", () => {
    expect([...evidenceProjectionAdapter.enabledEvents(evidenceProjectionAdapter.initial()[0].state)].sort()).toEqual(EVENTS)
  })
  it("explores to depth 8 with no violation", () => {
    const report = exploreMachine(evidenceProjectionAdapter, { depth: 8, maxStates: 100_000 })
    expect(report.violations).toEqual([])
    expect(report.states).toBeGreaterThan(1)
    expect(report.frontierClosed || report.depthCompleted === 8).toBe(true)
  })
  it("catches a planted bug on enter-confirm", () => {
    expect(exploreMachine(plantStaleReal(evidenceProjectionAdapter, "enter-confirm"), { depth: 2, maxStates: 1000 }).violations.length).toBeGreaterThan(0)
  })
  it("needs no trace monitor: every invariant reads one step", () => {
    expect(evidenceProjectionAdapter.traceMonitor).toBeUndefined()
    expect(evidenceProjectionAdapter.excluded ?? []).toEqual([])
  })
  it("is registered for npm run explore", () => {
    expect(MACHINES["evidence-projection"]).toBe(evidenceProjectionAdapter)
  })
  it("catches a planted real/model mismatch", () => {
    // the real projection also takes a person override on a not-ready gate; the model does not
    const planted = {
      ...evidenceProjectionAdapter,
      step: (state: Parameters<typeof evidenceProjectionAdapter.step>[0], event: string) => {
        const result = evidenceProjectionAdapter.step(state, event as never)
        if (event !== "gate-not-ready") return result
        return { state: { ...result.state, real: { ...result.state.real, finalOverrides: { peer: "person" as const } } }, output: result.output }
      },
    }
    const report = exploreMachine(planted as never, { depth: 3, maxStates: 10_000 })
    expect(report.violations.length).toBeGreaterThan(0)
  })
  it("catches a flipped declared cell", () => {
    const row = "open|override:none|flipped:0" as const
    expect(evidenceProjectionMachineDefinition.transitionTable[row]["enter-confirm"]).toBe("transition")
    const flipped = fromDefinition({
      ...evidenceProjectionMachineDefinition,
      transitionTable: {
        ...evidenceProjectionMachineDefinition.transitionTable,
        [row]: { ...evidenceProjectionMachineDefinition.transitionTable[row], "enter-confirm": "no-op" },
      },
    })
    const report = exploreMachine(flipped, { depth: 1, maxStates: 1_000 })
    expect(report.violations.map((violation) => violation.trace)).toEqual([["start", "enter-confirm"]])
  })
  it("reports an unknown cell list for an adapter without a cell index", () => {
    const bare = { ...evidenceProjectionAdapter }
    expect(exploreMachine(bare, { depth: 1, maxStates: 100 }).unreachedCells).toBe("cell list unknown")
    expect(exploreMachine(evidenceProjectionAdapter, { depth: 1, maxStates: 100 }).unreachedCells).not.toBe("cell list unknown")
  })
})
