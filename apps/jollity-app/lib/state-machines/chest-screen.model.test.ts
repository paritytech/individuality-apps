// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { runStateMachineSuite } from "./framework"
import {
  chestScreenEventKeys,
  chestScreenInvariants,
  chestScreenMachineDefinition,
  chestScreenRegressions,
  chestScreenStateKeys,
  chestScreenTransitionTable,
  chestScreenWitnesses,
} from "./chest-screen.definition"

describe("chest-screen state-machine model", () => {
  it("matches the independent model, checks every invariant and gates transition coverage", async () => {
    const { coverage } = await runStateMachineSuite(chestScreenMachineDefinition)
    expect(coverage.missing).toEqual([])
    expect(coverage.impossibleObserved).toEqual([])
    expect(coverage.hit).toBe(coverage.declared)
    expect(coverage.hits["waiting|seeded|landed|rereads|-::reread-due::transition"]).toBeGreaterThan(0)
    expect(coverage.hits["collecting|shut|-|settling::vessel-opened::transition"]).toBeGreaterThan(0)
    expect(coverage.generatedSequenceLengths).toMatchObject({ count: 300, min: 0 })
    expect(coverage.generatedSequenceLengths?.p95).toBeGreaterThanOrEqual(45)
  })

  it("keeps the transition matrix and deterministic witnesses exhaustive, with no impossible cell", () => {
    expect(Object.keys(chestScreenTransitionTable)).toEqual([...chestScreenStateKeys])
    const cells = Object.values(chestScreenTransitionTable).flatMap((row) => Object.values(row))
    expect(cells).toHaveLength(chestScreenStateKeys.length * chestScreenEventKeys.length)
    expect(cells).not.toContain("impossible")
    expect(chestScreenWitnesses).toHaveLength(cells.length)
    expect(new Set(chestScreenWitnesses.map((witness) => witness.name)).size).toBe(cells.length)
  })

  it("ties every invariant to the rule it protects", () => {
    expect(chestScreenInvariants).toHaveLength(10)
    for (const invariant of chestScreenInvariants) expect(invariant.specClause).toMatch(/^C\d/)
  })

  it("keeps a named regression for every captured scenario", () => {
    const names = chestScreenRegressions.map((entry) => entry.name)
    expect(new Set(names).size).toBe(names.length)
    expect(names).toContain("a chest before the settle collects what lands, opens after the wait, and takes the settle's claims")
    expect(names).toContain("a vessel that never opens still offers a way on past the backstop wait")
    expect(names).toContain("nothing read by the collect wait says it is taking longer; a claim after it is collected, opens the vessel, and Continue stays")
    expect(names).toContain("Continue is offered the moment the vessel opens")
  })
})
