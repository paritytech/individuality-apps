// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { runStateMachineSuite } from "./framework"
import {
  storeCalibrationMachineDefinition,
  storeCalibrationRegressions,
  storeCalibrationTransitionTable,
  storeCalibrationWitnesses,
} from "./store-calibration.definition"

describe("store-calibration state-machine model", () => {
  it("matches the independent model and covers every state/event cell", async () => {
    const { coverage } = await runStateMachineSuite(storeCalibrationMachineDefinition)
    expect(coverage.missing).toEqual([])
    expect(coverage.impossibleObserved).toEqual([])
    expect(coverage.hit).toBe(coverage.declared)
    expect(coverage.generatedSequenceLengths).toMatchObject({ count: 300, min: 0 })
  })

  it("keeps deterministic witnesses exhaustive", () => {
    const declared = Object.values(storeCalibrationTransitionTable).flatMap(Object.values).length
    expect(storeCalibrationWitnesses).toHaveLength(declared)
  })

  it("keeps the named retention regressions", () => {
    expect(storeCalibrationRegressions.map((entry) => entry.name)).toEqual([
      "failed calibration is retained before 30 seconds and retries at the boundary",
      "only the running attempt may settle",
    ])
  })
})
