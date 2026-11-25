// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { startCollectablesScreen } from "../../collectables/collectables-screen"
import { collectablesScreenEventKeys, collectablesScreenMachineDefinition } from "../../state-machines/collectables-screen.definition"
import { collectablesScreenAdapter } from "./collectables-screen.adapter"
import { exploreMachine } from "./explore-machine"
import { plantStaleReal } from "./from-definition"
import { MACHINES } from "./registry"

describe("collectables-screen adapter", () => {
  it("starts only from the normal start state", () => {
    const initial = collectablesScreenAdapter.initial()
    expect(initial).toHaveLength(1)
    expect(initial[0].label).toBe("start")
    expect(initial[0].state).toEqual({ real: startCollectablesScreen(), model: collectablesScreenMachineDefinition.initialModel() })
  })

  it("enables the 32 collectables-screen event keys", () => {
    expect(collectablesScreenEventKeys).toHaveLength(32)
    expect([...collectablesScreenAdapter.enabledEvents(collectablesScreenAdapter.initial()[0].state)].sort()).toEqual([...collectablesScreenEventKeys].sort())
  })

  it("explores to depth 6 with no violation", () => {
    const report = exploreMachine(collectablesScreenAdapter, { depth: 6, maxStates: 200_000 })
    expect(report.violations).toEqual([])
    expect(report.states).toBeGreaterThan(1)
    expect(report.frontierClosed || report.depthCompleted === 6).toBe(true)
  })

  it("catches a planted bug", () => {
    const report = exploreMachine(plantStaleReal(collectablesScreenAdapter, "opened"), { depth: 2, maxStates: 1_000 })
    expect(report.violations.length).toBeGreaterThan(0)
    expect(report.violations[0].trace).toEqual(["start", "opened"])
  })

  it("is registered, with no invariant left out", () => {
    expect(MACHINES["collectables-screen"]).toBe(collectablesScreenAdapter)
    expect(collectablesScreenAdapter.excluded ?? []).toEqual([])
  })
})
