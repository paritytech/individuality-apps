// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { runStateMachineSuite } from "./framework"
import { launchStallMachineDefinition, launchStallRegressionCorpus, launchStallTransitionTable, launchStallWitnesses } from "./launch-stall.definition"

describe("launch-stall state-machine model", () => {
  it("matches the independent model and covers every declared pair", async () => {
    const { coverage } = await runStateMachineSuite(launchStallMachineDefinition)
    expect(coverage.missing).toEqual([])
    expect(coverage.hit).toBe(coverage.declared)
    expect(coverage.generatedSequenceLengths).toMatchObject({ count: 300, min: 0 })
  })
  it("keeps the complete matrix, witnesses and out-of-order corpus", () => {
    const declared = Object.values(launchStallTransitionTable).reduce((sum, row) => sum + Object.keys(row).length, 0)
    expect(launchStallWitnesses).toHaveLength(declared)
    expect(new Set(launchStallWitnesses.map(({ name }) => name)).size).toBe(declared)
    expect(launchStallRegressionCorpus.some(({ name }) => name.includes("out-of-order"))).toBe(true)
  })
})
