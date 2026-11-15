// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { chainHealthMachineDefinition } from "../../state-machines/chain-health.definition"
import { chainHealthAdapter } from "./chain-health.adapter"
import { exploreMachine } from "./explore-machine"
import { fromDefinition, plantStaleReal } from "./from-definition"
import { MACHINES } from "./registry"

const EVENTS = [
  "declined",
  "healthy",
  "healthy-unordered",
  "lost-block",
  "lost-declined",
  "lost-dropped",
  "lost-follow",
  "lost-interrupted",
  "lost-network",
  "lost-pinned",
  "lost-unknown",
  "older-healthy",
  "returned",
  "stale-healthy",
  "stale-lost",
  "stale-timeout-near",
  "timeout-clock-back",
  "timeout-clock-forward",
  "timeout-edge",
  "timeout-far",
  "timeout-near",
  "turn-timeout-lost",
  "unknown-declined",
  "unknown-interrupted",
  "unknown-network",
  "unknown-other",
]

describe("chain-health adapter", () => {
  it("starts only from the normal start state", () => {
    const initial = chainHealthAdapter.initial()
    expect(initial).toHaveLength(1)
    expect(initial[0].label).toBe("start")
    expect(initial[0].state).toEqual({
      real: chainHealthMachineDefinition.initialReal(),
      model: chainHealthMachineDefinition.initialModel(),
    })
  })

  it("enables the 26 chain-health event keys", () => {
    expect([...chainHealthAdapter.enabledEvents(chainHealthAdapter.initial()[0].state)].sort()).toEqual(EVENTS)
  })

  it("explores to depth 8 with no violation", () => {
    const report = exploreMachine(chainHealthAdapter, { depth: 8, maxStates: 100_000 })
    expect(report.violations).toEqual([])
    expect(report.states).toBeGreaterThan(1)
    expect(report.frontierClosed || report.depthCompleted === 8).toBe(true)
  })

  it("catches a planted bug on healthy", () => {
    expect(exploreMachine(plantStaleReal(chainHealthAdapter, "healthy"), { depth: 2, maxStates: 1_000 }).violations.length).toBeGreaterThan(0)
  })

  it("needs no trace monitor: every invariant reads one step", () => {
    expect(chainHealthAdapter.traceMonitor).toBeUndefined()
    expect(chainHealthAdapter.excluded ?? []).toEqual([])
  })

  it("is registered for npm run explore", () => {
    expect(MACHINES["chain-health"]).toBe(chainHealthAdapter)
  })

  it("catches a planted real/model mismatch", () => {
    const planted = {
      ...chainHealthAdapter,
      step: (state: Parameters<typeof chainHealthAdapter.step>[0], event: string) => {
        const result = chainHealthAdapter.step(state, event as never)
        if (event !== "healthy") return result
        return { state: result.state, output: { real: { ...result.output.real, accepted: false }, model: result.output.model } }
      },
    }
    const report = exploreMachine(planted as never, { depth: 1, maxStates: 1_000 })
    expect(report.violations.length).toBeGreaterThan(0)
  })

  it("catches a flipped declared cell", () => {
    const row = "never-answered|armed:0" as const
    expect(chainHealthMachineDefinition.transitionTable[row].healthy).toBe("transition")
    const flipped = fromDefinition({
      ...chainHealthMachineDefinition,
      transitionTable: {
        ...chainHealthMachineDefinition.transitionTable,
        [row]: { ...chainHealthMachineDefinition.transitionTable[row], healthy: "no-op" },
      },
    })
    const report = exploreMachine(flipped, { depth: 1, maxStates: 1_000 })
    expect(report.violations.map((violation) => violation.trace)).toEqual([["start", "healthy"]])
  })
})
