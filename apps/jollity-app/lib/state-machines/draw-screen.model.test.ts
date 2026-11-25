// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { runStateMachineSuite } from "./framework"
import {
  drawScreenEventKeys,
  drawScreenInitialCases,
  drawScreenInvariants,
  drawScreenMachineDefinition,
  drawScreenRegressions,
  drawScreenStateKeys,
  drawScreenTransitionTable,
  drawScreenWitnesses,
} from "./draw-screen.definition"

describe("draw-screen state-machine model", () => {
  it("matches the independent model, checks every invariant and gates transition coverage", async () => {
    const { coverage } = await runStateMachineSuite(drawScreenMachineDefinition)
    expect(coverage.missing).toEqual([])
    expect(coverage.impossibleObserved).toEqual([])
    expect(coverage.hit).toBe(coverage.declared)
    expect(coverage.hits["words::idle-elapsed::transition"]).toBeGreaterThan(0)
    expect(coverage.hits["wheel|mounted|off|left:0::idle-elapsed::no-op"]).toBeGreaterThan(0)
    expect(coverage.hits["loading::load-failed::transition"]).toBeGreaterThan(0)
    expect(coverage.generatedSequenceLengths).toMatchObject({ count: 300, min: 0 })
    expect(coverage.generatedSequenceLengths?.p95).toBeGreaterThanOrEqual(45)
    expect(coverage.generatedSequenceLengths?.max).toBeGreaterThanOrEqual(50)
  })

  it("keeps the transition matrix and deterministic witnesses exhaustive, with no impossible cell", () => {
    expect(Object.keys(drawScreenTransitionTable)).toEqual([...drawScreenStateKeys])
    const cells = Object.values(drawScreenTransitionTable).flatMap((row) => Object.values(row))
    expect(cells).toHaveLength(drawScreenStateKeys.length * drawScreenEventKeys.length)
    expect(cells).not.toContain("impossible")
    expect(drawScreenWitnesses).toHaveLength(cells.length)
    expect(new Set(drawScreenWitnesses.map((witness) => witness.name)).size).toBe(cells.length)
  })

  it("ties the nine invariants to the rules they protect", () => {
    expect(drawScreenInvariants.map(({ name }) => name)).toEqual([
      "closed absorbs every later event",
      "a stale result is inert",
      "the wheel is left at most once",
      "a wheel draw-continue is sent only from offered or fallback",
      "draw-result or draw-none is sent at most once",
      "no claim before the result is seen, and none with the override",
      "a held mount only while the intro is up, released at most once",
      "the idle is offered once, and only with a way on",
      "unmount always detaches and destroys, and clears every timer",
    ])
    for (const invariant of drawScreenInvariants) expect(invariant.specClause).toMatch(/^D\d/)
  })

  it("keeps a named regression for every captured scenario and every defect kept as it is", () => {
    const names = drawScreenRegressions.map((entry) => entry.name)
    expect(new Set(names).size).toBe(names.length)
    for (const fixed of [
      "a failed read says so, and Continue goes on to the collectables screen",
      "a spectator is never moved on before their Continue",
      "the words move on after a minute too",
    ])
      expect(names).toContain(fixed)
    expect(drawScreenInitialCases.map((entry) => entry.name)).toEqual(["a player's own screen", "the ?player= override"])
  })
})
