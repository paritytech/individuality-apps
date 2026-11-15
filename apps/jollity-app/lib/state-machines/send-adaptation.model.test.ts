// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { runStateMachineSuite } from "./framework"
import {
  sendAdaptationMachineDefinition,
  sendAdaptationRegressions,
  sendAdaptationTransitionTable,
  sendAdaptationWitnesses,
} from "./send-adaptation.definition"

describe("send adaptation state-machine model", () => {
  it("matches its independent model, invariants and complete reachable transition table", async () => {
    const { coverage } = await runStateMachineSuite(sendAdaptationMachineDefinition)
    expect(coverage.missing).toEqual([])
    expect(coverage.impossibleObserved).toEqual([])
    expect(coverage.hit).toBe(coverage.declared)
    expect(coverage.generatedSequenceLengths).toMatchObject({ count: 300, min: 0 })
  })

  it("has one deterministic witness for every reachable state × event cell", () => {
    const cells = Object.values(sendAdaptationTransitionTable).reduce(
      (sum, row) => sum + Object.keys(row).length,
      0,
    )
    expect(sendAdaptationWitnesses).toHaveLength(cells)
    expect(new Set(sendAdaptationWitnesses.map(({ name }) => name)).size).toBe(cells)
  })

  it("keeps capacity, parking, probe and stale-order regressions in every run", () => {
    expect(sendAdaptationRegressions).toHaveLength(12)
    expect(sendAdaptationRegressions.some(({ name }) => name.includes("stale duplicate"))).toBe(true)
  })
})
