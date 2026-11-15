// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { reportReadKind } from "../report-retry"
import { runStateMachineSuite } from "./framework"
import {
  reportRetryMachineDefinition,
  reportRetryRegressionCorpus,
  reportRetryTransitionTable,
  reportRetryWitnesses,
} from "./report-retry.definition"

describe("report-retry state-machine model", () => {
  it("matches the independent model, checks every invariant and gates transition coverage", async () => {
    const { coverage } = await runStateMachineSuite(reportRetryMachineDefinition)
    expect(coverage.missing).toEqual([])
    expect(coverage.impossibleObserved).toEqual([])
    expect(coverage.hit).toBe(coverage.declared)
    expect(coverage.hits["new|submit-settled:0|none::start-live::transition"]).toBeGreaterThan(0)
    expect(coverage.hits["reading|submit-settled:0|none::status-open::transition"]).toBeGreaterThan(0)
    expect(coverage.hits["watching|submit-settled:0|none::poll-open::transition"]).toBeGreaterThan(0)
    expect(coverage.hits["watching|submit-settled:0|none::deadline::transition"]).toBeGreaterThan(0)
    expect(coverage.hits["over|submit-settled:0|sent::deadline::no-op"]).toBeGreaterThan(0)
    expect(coverage.generatedSequenceLengths).toMatchObject({ count: 300 })
  })

  it("keeps the transition matrix and deterministic witnesses exhaustive", () => {
    const declared = Object.values(reportRetryTransitionTable).reduce((total, row) => total + Object.keys(row).length, 0)
    expect(declared).toBe(150)
    expect(reportRetryWitnesses).toHaveLength(declared)
    expect(new Set(reportRetryWitnesses.map((witness) => witness.name)).size).toBe(declared)
  })

  it("keeps the named regression corpus on every run", () => {
    expect(reportRetryRegressionCorpus).toHaveLength(11)
  })

  it("reads a status as sent over closed over open, and a failed read as unread", () => {
    expect(reportReadKind({ closed: true, report: "sent" })).toBe("sent")
    expect(reportReadKind({ closed: true, report: "not-sent" })).toBe("closed")
    expect(reportReadKind({ closed: false, report: "sent" })).toBe("sent")
    expect(reportReadKind({ closed: false, report: "not-sent" })).toBe("open")
    expect(reportReadKind(null)).toBe("unread")
  })
})
