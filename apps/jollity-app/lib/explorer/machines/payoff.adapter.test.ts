// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { startPayoff } from "../../payoff-machine"
import { payoffMachineDefinition } from "../../state-machines/payoff.definition"
import { exploreMachine } from "./explore-machine"
import { fromDefinition, plantStaleReal } from "./from-definition"
import { payoffAdapter, payoffExplorerDefinition } from "./payoff.adapter"
import { MACHINES } from "./registry"

const EVENT_TYPES = [
  "app-gone",
  "chest-continue",
  "chest-error",
  "chest-opened",
  "chest-reread-due",
  "chest-result",
  "chest-skip",
  "draw-bypass",
  "draw-continue",
  "draw-error",
  "draw-idle",
  "draw-offered",
  "draw-none",
  "draw-result",
  "hidden",
  "next-game",
  "payoff-stalled",
  "return-after-long-absence",
  "visible",
] as const

const EVENTS = EVENT_TYPES.flatMap((type) => [`${type}|current`, `${type}|stale`]).sort()

describe("payoff adapter", () => {
  it("starts only from the normal start state", () => {
    const initial = payoffAdapter.initial()
    expect(initial).toHaveLength(1)
    expect(initial[0].label).toBe("start")
    expect(initial[0].state).toEqual({
      real: startPayoff(5, "/prize-draw"),
      model: payoffMachineDefinition.initialModel(),
    })
  })

  it("enables the 38 payoff event keys", () => {
    expect([...payoffAdapter.enabledEvents(payoffAdapter.initial()[0].state)].sort()).toEqual(EVENTS)
  })

  it("explores to depth 8 with no violation", () => {
    const report = exploreMachine(payoffAdapter, { depth: 8, maxStates: 100_000 })
    expect(report.violations).toEqual([])
    expect(report.states).toBeGreaterThan(1)
    expect(report.frontierClosed || report.depthCompleted === 8).toBe(true)
  })

  it("catches a planted real/model mismatch", () => {
    const report = exploreMachine(plantStaleReal(payoffAdapter, "draw-result|current"), { depth: 2, maxStates: 1_000 })
    expect(report.violations.length).toBeGreaterThan(0)
    expect(report.violations[0].trace).toEqual(["start", "draw-result|current"])
  })

  it("catches a repeated draw fact through the trace monitor", () => {
    const planted = {
      ...payoffAdapter,
      step: (
        state: (typeof payoffAdapter extends { initial(): readonly { state: infer S }[] } ? S : never),
        event: Parameters<typeof payoffAdapter.step>[1],
      ) => {
        const result = payoffAdapter.step(state, event)
        if (event !== "draw-result|current") return result
        return {
          state: result.state,
          output: {
            real: [...result.output.real, { kind: "telemetry" as const, fact: "drawShown" as const }],
            model: [...result.output.model, "telemetry:drawShown"],
          },
        }
      },
    }
    const report = exploreMachine(planted, { depth: 1, maxStates: 10_000 })
    expect(report.violations.map((violation) => violation.message).join("\n")).toMatch(/telemetry:drawShown emitted 2 times/)
  })

  it("declares a trace monitor for the history invariant", () => {
    expect(payoffAdapter.traceMonitor?.covers).toEqual(["facts and journey end are emitted at most once"])
    expect(payoffAdapter.excluded ?? []).toEqual([])
  })

  it("catches a flipped declared cell", () => {
    const row = "draw-waiting|draw:0|stalled:0" as const
    expect(payoffExplorerDefinition.transitionTable[row]["draw-result|current"]).toBe("transition")
    const flipped = fromDefinition({
      ...payoffExplorerDefinition,
      transitionTable: {
        ...payoffExplorerDefinition.transitionTable,
        [row]: { ...payoffExplorerDefinition.transitionTable[row], "draw-result|current": "no-op" },
      },
    })
    const report = exploreMachine(flipped, { depth: 1, maxStates: 1_000 })
    expect(report.violations.map((violation) => violation.trace)).toEqual([["start", "draw-result|current"]])
  })

  it("is registered for npm run explore", () => {
    expect(MACHINES.payoff).toBe(payoffAdapter)
  })
})
