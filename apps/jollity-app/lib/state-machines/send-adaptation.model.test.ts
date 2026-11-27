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

  it("keeps the named regression corpus in every run", () => {
    const names = sendAdaptationRegressions.map(({ name }) => name)
    expect(new Set(names).size).toBe(names.length)
    for (const expected of [
      "first capacity window fits directly",
      "ordinary later pressure needs two windows",
      "unknown capacity descends one ordered rung immediately",
      "four healthy windows start one-rung recovery probe",
      "two healthy probe windows commit recovery",
      "probe pressure restores last good and backs off",
      "pending request settles after four windows",
      "regroup clears probe credit without backoff",
      "pending down move survives regroup and failed recovery probe",
      "unanswered down request keeps awaiting across regroup and settles the late accept",
      "unconfirmed up probe rolls back to the last good rung on regroup",
      "rejected pending down move restores the prior last good rung",
      "settled parked probe leaves steady regroup inert",
      "stale duplicate and out-of-order results are inert",
    ]) expect(names).toContain(expected)
  })
})
