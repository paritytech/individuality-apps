// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { startChestScreen } from "../../chest/chest-screen"
import { chestScreenEventKeys, chestScreenMachineDefinition } from "../../state-machines/chest-screen.definition"
import { chestScreenAdapter } from "./chest-screen.adapter"
import { exploreMachine } from "./explore-machine"
import { plantStaleReal } from "./from-definition"
import { MACHINES } from "./registry"

describe("chest-screen adapter", () => {
  it("starts only from the normal start state", () => {
    const initial = chestScreenAdapter.initial()
    expect(initial).toHaveLength(1)
    expect(initial[0].label).toBe("start")
    expect(initial[0].state).toEqual({ real: startChestScreen(), model: chestScreenMachineDefinition.initialModel() })
  })

  it("enables the 32 chest-screen event keys", () => {
    expect(chestScreenEventKeys).toHaveLength(32)
    expect([...chestScreenAdapter.enabledEvents(chestScreenAdapter.initial()[0].state)].sort()).toEqual([...chestScreenEventKeys].sort())
  })

  it("explores to depth 6 with no violation", () => {
    const report = exploreMachine(chestScreenAdapter, { depth: 6, maxStates: 200_000 })
    expect(report.violations).toEqual([])
    expect(report.states).toBeGreaterThan(1)
    expect(report.frontierClosed || report.depthCompleted === 6).toBe(true)
  })

  it("catches a planted bug", () => {
    const report = exploreMachine(plantStaleReal(chestScreenAdapter, "opened"), { depth: 2, maxStates: 1_000 })
    expect(report.violations.length).toBeGreaterThan(0)
    expect(report.violations[0].trace).toEqual(["start", "opened"])
  })

  it("is registered, with no invariant left out", () => {
    expect(MACHINES["chest-screen"]).toBe(chestScreenAdapter)
    expect(chestScreenAdapter.excluded ?? []).toEqual([])
  })
})
