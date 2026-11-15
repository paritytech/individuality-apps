// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { runStateMachineSuite } from "./framework"
import {
  chainHealthMachineDefinition,
  chainHealthRegressionCorpus,
  chainHealthTransitionTable,
  chainHealthWitnesses,
} from "./chain-health.definition"

describe("chain-health state-machine model", () => {
  it("matches the independent model, checks every invariant and gates transition coverage", async () => {
    const { coverage } = await runStateMachineSuite(chainHealthMachineDefinition)
    expect(coverage.missing).toEqual([])
    expect(coverage.impossibleObserved).toEqual([])
    expect(coverage.hit).toBe(coverage.declared)
    expect(coverage.hits["never-answered|armed:1::timeout-near::transition"]).toBeGreaterThan(0)
    expect(coverage.hits["lost-loss|armed:0::stale-healthy::no-op"]).toBeGreaterThan(0)
    expect(coverage.hits["lost-silence|armed:0::healthy::transition"]).toBeGreaterThan(0)
    expect(coverage.hits["answering|armed:0::lost-unknown::transition"]).toBeGreaterThan(0)
    expect(coverage.hits["lost-loss|armed:1::unknown-declined::transition"]).toBeGreaterThan(0)
    expect(coverage.generatedSequenceLengths).toMatchObject({ count: 300, min: 0 })
  })

  it("keeps the transition matrix and deterministic witnesses exhaustive", () => {
    const declared = Object.values(chainHealthTransitionTable).reduce((total, row) => total + Object.keys(row).length, 0)
    expect(chainHealthWitnesses).toHaveLength(declared)
    expect(new Set(chainHealthWitnesses.map((witness) => witness.name)).size).toBe(declared)
  })

  it("keeps the named regression corpus on every run", () => {
    expect(chainHealthRegressionCorpus.length).toBeGreaterThanOrEqual(16)
    expect(new Set(chainHealthRegressionCorpus.map((entry) => entry.name)).size).toBe(chainHealthRegressionCorpus.length)
  })
})
