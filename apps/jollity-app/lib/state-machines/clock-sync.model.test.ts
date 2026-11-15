// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { runStateMachineSuite } from "./framework"
import { clockSyncMachineDefinition, clockSyncRegressions, clockSyncTransitionTable, clockSyncWitnesses } from "./clock-sync.definition"

describe("clock-sync state-machine model", () => {
  it("matches the independent model and covers every possible state/event cell", async () => {
    const { coverage } = await runStateMachineSuite(clockSyncMachineDefinition)
    expect(coverage.missing).toEqual([])
    expect(coverage.impossibleObserved).toEqual([])
    expect(coverage.hit).toBe(coverage.declared)
    expect(coverage.generatedSequenceLengths).toMatchObject({ count: 300, min: 1 })
  })

  it("keeps deterministic witnesses exhaustive", () => {
    const declared = Object.values(clockSyncTransitionTable).flatMap(Object.values).filter((outcome) => outcome !== "impossible").length
    expect(clockSyncWitnesses).toHaveLength(declared)
  })

  it("keeps the named #1060 regressions", () => {
    expect(clockSyncRegressions.map((entry) => entry.name)).toEqual([
      "smooth correction never reverses shown time (#1060)",
      "tiles-enter boundary jumps a still-behind waiting clock",
      "non-increasing device samples are inert",
      // the fresh::stale-tick declaration fix (ChiefOfStaff ruling, 29 Oct): a first sample
      // while fresh establishes the baseline and sends nothing
      "a first sample while fresh establishes the baseline and sends nothing",
    ])
  })
})
