// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { runStateMachineSuite } from "./framework"
import {
  collectablesRereadMachineDefinition,
  collectablesRereadRegressions,
  collectablesRereadTransitionTable,
  collectablesRereadWitnesses,
} from "./collectables-reread.definition"

describe("collectables reread state-machine model", () => {
  it("matches its independent model, invariants and complete transition table", async () => {
    const { coverage } = await runStateMachineSuite(collectablesRereadMachineDefinition)
    expect(coverage.missing).toEqual([])
    expect(coverage.impossibleObserved).toEqual([])
    expect(coverage.hit).toBe(coverage.declared)
    expect(coverage.generatedSequenceLengths).toMatchObject({ count: 300, min: 0 })
  })

  it("has one deterministic witness for every state × event cell", () => {
    const cells = Object.values(collectablesRereadTransitionTable).reduce((sum, row) => sum + Object.keys(row).length, 0)
    expect(collectablesRereadWitnesses).toHaveLength(cells)
    expect(new Set(collectablesRereadWitnesses.map(({ name }) => name)).size).toBe(cells)
  })

  it("keeps stale, duplicate and out-of-order regressions in every run", () => {
    expect(collectablesRereadRegressions).toHaveLength(6)
    expect(collectablesRereadRegressions.some(({ name }) => name.includes("late failure"))).toBe(true)
  })
})
