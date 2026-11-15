// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { runStateMachineSuite } from "./framework"
import { readRetryMachineDefinition, readRetryRegressionCorpus, readRetryTransitionTable, readRetryWitnesses } from "./read-retry.definition"

describe("read-retry state-machine model", () => {
  it("matches the independent model and covers every declared pair", async () => {
    const { coverage } = await runStateMachineSuite(readRetryMachineDefinition)
    expect(coverage.missing).toEqual([])
    expect(coverage.hit).toBe(coverage.declared)
    expect(coverage.generatedSequenceLengths).toMatchObject({ count: 300, min: 0 })
  })
  it("keeps the complete matrix, witnesses and stale-event corpus", () => {
    const declared = Object.values(readRetryTransitionTable).reduce((sum, row) => sum + Object.keys(row).length, 0)
    expect(readRetryWitnesses).toHaveLength(declared)
    expect(new Set(readRetryWitnesses.map(({ name }) => name)).size).toBe(declared)
    expect(readRetryRegressionCorpus.some(({ name }) => name.includes("stale duplicate"))).toBe(true)
  })
})
