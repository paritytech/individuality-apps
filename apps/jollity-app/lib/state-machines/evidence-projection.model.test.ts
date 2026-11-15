// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { runStateMachineSuite } from "./framework"
import {
  evidenceProjectionMachineDefinition,
  evidenceProjectionRegressionCorpus,
  evidenceProjectionTransitionTable,
  evidenceProjectionWitnesses,
} from "./evidence-projection.definition"

describe("evidence-projection state-machine model", () => {
  it("matches the independent model, checks every invariant and gates transition coverage", async () => {
    const { coverage } = await runStateMachineSuite(evidenceProjectionMachineDefinition)
    expect(coverage.missing).toEqual([])
    expect(coverage.impossibleObserved).toEqual([])
    expect(coverage.hit).toBe(coverage.declared)
    expect(coverage.hits["open|override:none|flipped:0::enter-confirm::transition"]).toBeGreaterThan(0)
    expect(coverage.hits["closed|override:none|flipped:0::enter-confirm::no-op"]).toBeGreaterThan(0)
    expect(coverage.generatedSequenceLengths).toMatchObject({ count: 300, min: 0 })
    expect(coverage.generatedSequenceLengths?.p95).toBeGreaterThanOrEqual(45)
    expect(coverage.generatedSequenceLengths?.max).toBeGreaterThanOrEqual(50)
  })

  it("keeps the transition matrix and deterministic witnesses exhaustive", () => {
    // every cell that can be RUN gets a witness; impossible cells are declared so that
    // running one fails, not so that it gets a witness (framework/coverage.ts:24)
    const declared = Object.values(evidenceProjectionTransitionTable).reduce(
      (total, row) => total + Object.values(row).filter((outcome) => outcome !== "impossible").length,
      0,
    )
    expect(evidenceProjectionWitnesses).toHaveLength(declared)
    expect(new Set(evidenceProjectionWitnesses.map((witness) => witness.name)).size).toBe(declared)
  })

  it("keeps the named projection regressions on every run", () => {
    expect(evidenceProjectionRegressionCorpus.map((entry) => entry.name)).toEqual([
      "confirm boundary and delayed gate",
      "confirm boundary is one-way after backward clock correction",
      "local override wins over restore",
      "unseen flip provenance is sticky",
    ])
  })
})
