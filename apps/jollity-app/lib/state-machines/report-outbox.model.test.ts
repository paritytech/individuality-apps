// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { checkStep, runStateMachineSuite } from "./framework"
import {
  reportOutboxMachineDefinition,
  reportOutboxRegressionCorpus,
  reportOutboxTransitionTable,
  reportOutboxWitnesses,
} from "./report-outbox.definition"

describe("report-outbox state-machine model", () => {
  it("matches the independent model, checks every invariant and gates transition coverage", async () => {
    const { coverage } = await runStateMachineSuite(reportOutboxMachineDefinition)
    expect(coverage.missing).toEqual([])
    expect(coverage.impossibleObserved).toEqual([])
    expect(coverage.hit).toBe(coverage.declared)
    expect(coverage.hits["idle|locked:0|submitted:0|closed:0|rushed:0|pending:0::confirm::transition"]).toBeGreaterThan(0)
    expect(coverage.hits["missed|locked:0|submitted:0|closed:0|rushed:0|pending:0::confirm::no-op"]).toBeGreaterThan(0)
    expect(coverage.hits["submitting|locked:1|submitted:0|closed:0|rushed:0|pending:0::stale-sent::no-op"]).toBeGreaterThan(0)
    expect(coverage.hits["submitting|locked:1|submitted:0|closed:0|rushed:0|pending:0::chain-closed::transition"]).toBeGreaterThan(0)
    expect(coverage.hits["retry-wait|locked:1|submitted:0|closed:0|rushed:0|pending:0::late-retry::transition"]).toBeGreaterThan(0)
    expect(coverage.generatedSequenceLengths).toMatchObject({ count: 300, min: 0 })
    expect(coverage.generatedSequenceLengths?.p95).toBeGreaterThanOrEqual(45)
    expect(coverage.generatedSequenceLengths?.max).toBeGreaterThanOrEqual(50)
  })

  it("keeps the transition matrix and deterministic witnesses exhaustive", () => {
    const declared = Object.values(reportOutboxTransitionTable).reduce((total, row) => total + Object.keys(row).length, 0)
    expect(reportOutboxWitnesses).toHaveLength(declared)
    expect(new Set(reportOutboxWitnesses.map((witness) => witness.name)).size).toBe(declared)
  })

  it("keeps the named O1/O3 regression corpus on every run", () => {
    expect(reportOutboxRegressionCorpus.map((entry) => entry.name)).toEqual([
      "first rush beat owns fireAt",
      "verdict change cannot restart a rushed beat",
      "double confirm freezes one report",
      "retry preserves the logical report",
      "late confirm cannot submit",
      "late retry cannot submit",
      "stale attempt result is ignored",
      "chain closure is terminal",
      "missed handover is terminal",
      "confirmed submission is terminal",
    ])
  })

  it("a repeated verdict change is a no-op once it owns the countdown", () => {
    // the explorer's depth-2 finding: verdict-changed, verdict-changed from the normal start; the first restarts the
    // countdown, the second sets the same deadline again, so the countdown's restart bit separates the two rows
    const definition = reportOutboxMachineDefinition
    let real = definition.initialReal()
    let model = definition.initialModel()
    const trace: Parameters<typeof checkStep>[0]["trace"] = []
    const steps = (["verdict-changed", "verdict-changed"] as const).map((event, step) => {
      const result = checkStep({ definition, real, model, event, step, label: "repeated verdict change", trace })
      ;({ real, model } = result)
      return `${result.stateKey}::${result.eventKey}::${result.outcome}`
    })
    expect(steps).toEqual([
      "idle|locked:0|submitted:0|closed:0|rushed:0|pending:0::verdict-changed::transition",
      "countdown|locked:0|submitted:0|closed:0|rushed:0|pending:0|restart:1::verdict-changed::no-op",
    ])
    expect(reportOutboxTransitionTable["countdown|locked:0|submitted:0|closed:0|rushed:0|pending:0|restart:0"]["verdict-changed"]).toBe("transition")
    expect(reportOutboxTransitionTable["countdown|locked:0|submitted:0|closed:0|rushed:0|pending:1|restart:1"]["verdict-changed"]).toBe("no-op")
  })
})
