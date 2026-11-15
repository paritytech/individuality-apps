// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { runStateMachineSuite } from "./framework"
import {
  chestRereadMachineDefinition,
  chestRereadRegressions,
  chestRereadTransitionTable,
  chestRereadWitnesses,
} from "./chest-reread.definition"

describe("chest reread state-machine model", () => {
  it("matches its independent model, invariants and complete transition table", async () => {
    const { coverage } = await runStateMachineSuite(chestRereadMachineDefinition)
    expect(coverage.missing).toEqual([])
    expect(coverage.impossibleObserved).toEqual([])
    expect(coverage.hit).toBe(coverage.declared)
    expect(coverage.generatedSequenceLengths).toMatchObject({ count: 300, min: 0 })
  })

  it("has one deterministic witness for every state × event cell", () => {
    const cells = Object.values(chestRereadTransitionTable).reduce((sum, row) => sum + Object.keys(row).length, 0)
    expect(chestRereadWitnesses).toHaveLength(cells)
    expect(new Set(chestRereadWitnesses.map(({ name }) => name)).size).toBe(cells)
  })

  it("keeps stale, duplicate and out-of-order regressions in every run", () => {
    expect(chestRereadRegressions).toHaveLength(6)
    expect(chestRereadRegressions.some(({ name }) => name.includes("late failure"))).toBe(true)
  })
})
