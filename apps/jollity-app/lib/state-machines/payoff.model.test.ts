// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { runStateMachineSuite } from "./framework"
import {
  payoffInitialCases,
  payoffMachineDefinition,
  payoffRegressionCorpus,
  payoffTagModes,
  payoffTransitionTable,
  payoffWitnesses,
} from "./payoff.definition"

describe("payoff state-machine model", () => {
  it("matches the independent model, checks every invariant and gates transition coverage", async () => {
    const { coverage } = await runStateMachineSuite(payoffMachineDefinition)
    expect(coverage.missing).toEqual([])
    expect(coverage.impossibleObserved).toEqual([])
    expect(coverage.hit).toBe(coverage.declared)
    expect(coverage.hits["collectables-reading|draw:0|stalled:0::draw-result|current::transition"]).toBeGreaterThan(0)
    expect(coverage.hits["draw-waiting|draw:0|stalled:1::payoff-stalled|current::no-op"]).toBeGreaterThan(0)
    expect(coverage.generatedSequenceLengths).toMatchObject({ count: 300, min: 0 })
    expect(coverage.generatedSequenceLengths?.p95).toBeGreaterThanOrEqual(45)
    expect(coverage.generatedSequenceLengths?.max).toBeGreaterThanOrEqual(50)
  })

  it("keeps the transition matrix and deterministic witnesses exhaustive", () => {
    const declared = Object.values(payoffTransitionTable).reduce((total, row) => total + Object.keys(row).length, 0)
    expect(payoffWitnesses).toHaveLength(declared)
    expect(new Set(payoffWitnesses.map((witness) => witness.name)).size).toBe(declared)
  })

  it("keeps a typed named regression corpus on every run", () => {
    expect(payoffRegressionCorpus.map((entry) => entry.name)).toEqual([
      "normal draw-collectables-humanity journey",
      "idle draw advance",
      "stale and duplicate async answers are inert",
      "stalled payoff keeps stalled outcome and sends the log at the hand-off",
      "a slow collectables screen hands off without the collectables screen",
      "reload on collectables screen",
      "reload after payoff already ended",
      "saved collectables screen epoch rejects old read and accepts current read",
    ])
  })

  it("generates both older stale tags and reload entry points", () => {
    expect(payoffTagModes).toEqual([
      "current",
      "stale-game-older",
      "stale-game-newer",
      "stale-epoch-older",
      "stale-epoch-newer",
    ])
    expect(payoffInitialCases.map((entry) => entry.name)).toEqual(["prize draw", "collectables screen reload", "ended reload"])
    expect(payoffInitialCases[1].real.epoch).toBe(2)
    expect(payoffInitialCases[1].model.epoch).toBe(2)
    expect(payoffInitialCases[2].real.epoch).toBe(2)
    expect(payoffInitialCases[2].model.epoch).toBe(2)
  })
})
