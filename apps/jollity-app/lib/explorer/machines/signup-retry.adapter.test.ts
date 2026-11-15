// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { signupRetryMachineDefinition as definition } from "../../state-machines/signup-retry.definition"
import { exploreMachine } from "./explore-machine"
import { fromDefinition, plantStaleReal } from "./from-definition"
import { MACHINES } from "./registry"
import { signupRetryAdapter } from "./signup-retry.adapter"

const EVENTS = [
  "attempt-closed",
  "attempt-landed",
  "attempt-refused",
  "attempt-registered",
  "retry-bind",
  "retry-name",
  "retry-network",
  "retry-other",
  "stale-attempt-landed",
  "stale-retry-network",
  "stale-wait-finished",
  "stale-window-open",
  "stop",
  "wait-finished",
  "window-closed",
  "window-open",
  "window-registered",
]

describe("signup-retry adapter", () => {
  it("starts only from the normal start state", () => {
    const initial = signupRetryAdapter.initial()
    expect(initial).toHaveLength(1)
    expect(initial[0].label).toBe("start")
    expect(initial[0].state).toEqual({ real: definition.initialReal(), model: definition.initialModel() })
  })

  it("enables the 17 signup-retry event keys", () => {
    expect([...signupRetryAdapter.enabledEvents(signupRetryAdapter.initial()[0].state)].sort()).toEqual(EVENTS)
  })

  it("explores to depth 8 with no violation", () => {
    const report = exploreMachine(signupRetryAdapter, { depth: 8, maxStates: 100_000 })
    expect(report.violations).toEqual([])
    expect(report.states).toBeGreaterThan(1)
    expect(report.frontierClosed || report.depthCompleted === 8).toBe(true)
  })

  it("catches a planted real/model mismatch", () => {
    const report = exploreMachine(plantStaleReal(signupRetryAdapter, "window-open"), { depth: 2, maxStates: 1_000 })
    expect(report.violations.length).toBeGreaterThan(0)
    expect(report.violations[0].trace).toEqual(["start", "window-open"])
  })

  it("catches a flipped declared cell", () => {
    expect(definition.transitionTable["checking-window"]["window-open"]).toBe("transition")
    const flipped = fromDefinition({
      ...definition,
      transitionTable: {
        ...definition.transitionTable,
        "checking-window": { ...definition.transitionTable["checking-window"], "window-open": "no-op" },
      },
    })
    const report = exploreMachine(flipped, { depth: 1, maxStates: 1_000 })
    expect(report.violations.map((violation) => violation.trace)).toEqual([["start", "window-open"]])
  })

  it("never uses the definition's arbitrary initial states and is registered for npm run explore", () => {
    const guarded = Object.defineProperty({ ...definition }, "initialArbitrary", {
      get() {
        throw new Error("initialArbitrary was read")
      },
    })
    const adapter = fromDefinition(guarded)
    expect(adapter.initial()).toEqual([{ label: "start", state: { real: definition.initialReal(), model: definition.initialModel() } }])
    expect(exploreMachine(adapter, { depth: 3, maxStates: 10_000 }).states).toBeGreaterThan(1)
    expect(MACHINES["signup-retry"]).toBe(signupRetryAdapter)
  })
})
