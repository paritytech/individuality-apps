// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { startReportAttempt } from "../../report-retry"
import { reportRetryMachineDefinition } from "../../state-machines/report-retry.definition"
import { exploreMachine } from "./explore-machine"
import { fromDefinition, plantStaleReal } from "./from-definition"
import { MACHINES } from "./registry"
import { reportRetryAdapter } from "./report-retry.adapter"

const EVENTS = ["deadline", "poll-closed", "poll-open", "poll-sent", "poll-unread", "start-closed", "start-live", "status-closed", "status-open",
  "status-open-late", "status-sent", "status-unread", "submit-failed", "submit-ok", "submit-window-closed"]

describe("report-retry adapter", () => {
  it("starts only from the normal start state", () => {
    const initial = reportRetryAdapter.initial()
    expect(initial).toHaveLength(1)
    expect(initial[0].label).toBe("start")
    expect(initial[0].state.real).toEqual(startReportAttempt())
  })
  it("enables the 15 report-retry event keys", () => {
    expect([...reportRetryAdapter.enabledEvents(reportRetryAdapter.initial()[0].state)].sort()).toEqual(EVENTS)
  })
  it("explores to depth 8 with no violation", () => {
    const report = exploreMachine(reportRetryAdapter, { depth: 8, maxStates: 100_000 })
    expect(report.violations).toEqual([])
    expect(report.states).toBeGreaterThan(1)
    expect(report.frontierClosed || report.depthCompleted === 8).toBe(true)
  })
  it("catches a planted bug on start-live", () => {
    expect(exploreMachine(plantStaleReal(reportRetryAdapter, "start-live"), { depth: 2, maxStates: 1000 }).violations.length).toBeGreaterThan(0)
  })
  it("declares a trace monitor that covers both trace invariants", () => {
    expect(reportRetryAdapter.traceMonitor?.covers).toHaveLength(2)
    expect(reportRetryAdapter.excluded ?? []).toEqual([])
  })
  it("is registered for npm run explore", () => {
    expect(MACHINES["report-retry"]).toBe(reportRetryAdapter)
  })

  it("catches a second submit through the trace monitor", () => {
    // poll-unread also submits, in lockstep in real and model, so only the whole-trace invariant can object
    const planted = {
      ...reportRetryAdapter,
      step: (state: (typeof reportRetryAdapter extends { initial(): readonly { state: infer S }[] } ? S : never), event: string) => {
        const result = reportRetryAdapter.step(state, event as never)
        if (event !== "poll-unread" || state.real.phase !== "watching") return result
        return {
          state: result.state,
          output: { real: [...result.output.real, { kind: "submit" as const }], model: [...result.output.model, "submit"] },
        }
      },
    }
    const report = exploreMachine(planted as never, { depth: 4, maxStates: 10_000 })
    expect(report.violations.map((violation) => violation.message).join("\n")).toMatch(/more than one submit|submit on poll-unread/)
  })

  it("catches a flipped declared cell", () => {
    // the first live start moves idle to reading; declaring that cell a no-op must be a declared-vs-outcome violation
    const row = "new|submit-settled:0|none" as const
    expect(reportRetryMachineDefinition.transitionTable[row]["start-live"]).toBe("transition")
    const flipped = fromDefinition({
      ...reportRetryMachineDefinition,
      transitionTable: { ...reportRetryMachineDefinition.transitionTable, [row]: { ...reportRetryMachineDefinition.transitionTable[row], "start-live": "no-op" } },
    })
    const report = exploreMachine(flipped, { depth: 1, maxStates: 1_000 })
    expect(report.violations.map((violation) => violation.trace)).toEqual([["start", "start-live"]])
  })

  it("reports an unknown cell list for an adapter without a cell index", () => {
    const bare = { ...reportRetryAdapter }
    expect(exploreMachine(bare, { depth: 1, maxStates: 100 }).unreachedCells).toBe("cell list unknown")
    expect(exploreMachine(reportRetryAdapter, { depth: 1, maxStates: 100 }).unreachedCells).not.toBe("cell list unknown")
  })
})
