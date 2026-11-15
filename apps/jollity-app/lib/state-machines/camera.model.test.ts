// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { runStateMachineSuite } from "./framework"
import { cameraMachineDefinition, cameraRegressionCorpus, cameraTransitionTable, cameraWitnesses } from "./camera.definition"

describe("camera recovery state-machine model", () => {
  it("matches the independent model and covers every declared pair", async () => {
    const { coverage } = await runStateMachineSuite(cameraMachineDefinition)
    expect(coverage.missing).toEqual([])
    expect(coverage.hit).toBe(coverage.declared)
    expect(coverage.generatedSequenceLengths).toMatchObject({ count: 300, min: 0 })
  })
  it("keeps the 16-phase matrix, witnesses and host camera muting corpus", () => {
    const declared = Object.values(cameraTransitionTable).reduce((sum, row) => sum + Object.keys(row).length, 0)
    expect(cameraWitnesses).toHaveLength(declared)
    expect(new Set(cameraWitnesses.map(({ name }) => name)).size).toBe(declared)
    expect(cameraRegressionCorpus.some(({ name }) => name.includes("stale"))).toBe(true)
    expect(Object.keys(cameraTransitionTable)).toHaveLength(16)
    expect(cameraRegressionCorpus.filter(({ name }) => name.includes("host camera muting"))).toHaveLength(2)
  })
})
