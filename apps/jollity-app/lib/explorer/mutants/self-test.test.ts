// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * T7: the mutant self-test (design 8.1 and 8.2). Each gating mutant must be
 * found with all five checks; a stale `find` asks for a refresh; a hunk the
 * violating schedule never runs fails the hunk-hit check; a reported-only
 * mutant is reported either way.
 */
// quiescence first: it traps the real timers before anything else loads
import "../mesh/quiescence"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { exitCode } from "../core/cli"
import { runMutant, selfTest, selfTestPassed, PRECONDITIONS, type MutantResult } from "./self-test"
import { loadSpec, type MutantSpec } from "./spec"

const consoleLog = console.log
const consoleWarn = console.warn
const out = `${process.cwd()}/test-results/explorer/self-test-unit`

const allChecks = (result: MutantResult) => {
  expect(result.notes, result.id).toEqual([])
  expect(result.checks, JSON.stringify(result)).toEqual({ precondition: true, hunkHit: true, fixedClean: true, mutatedRed: true, replay: true })
  expect(result.found).toBe(true)
  expect(result.witness).toBeDefined()
  // check 3 includes the warmup-seeded search with no mutant, which ran and stayed clean
  expect(result.fixedSearchLeaves).toBeGreaterThan(0)
}

describe("the mutant self-test", () => {
  beforeAll(() => {
    console.log = () => {}
    console.warn = () => {}
  })
  afterAll(() => {
    console.log = consoleLog
    console.warn = consoleWarn
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it("refuses a hunk whose find text is not exactly once in its target, asking for a refresh", async () => {
    const spec = loadSpec("M1374s")
    // the return line alone, without its rtcLog line or its closing brace (one site adds a field), is at two sites in mesh.ts
    const returnLine = spec.hunks[0]!.find.split("\n")[1]!.trim().replace(/ \}$/, "")
    const stale: MutantSpec = { ...spec, id: "Mstale", hunks: [{ find: returnLine, replace: 'return { outcome: "resolved" }' }] }
    const result = await runMutant(stale, { out })
    expect(result.refresh).toBe(true)
    expect(result.found).toBe(false)
    expect(result.notes).toEqual(["refresh mutant Mstale"])
  })

  it("rejects a spec whose precondition is not a named one", async () => {
    expect(Object.keys(PRECONDITIONS)).toContain("none")
    await expect(runMutant({ ...loadSpec("M1374s"), precondition: "no-such" }, { out })).rejects.toThrow(/unknown precondition no-such/)
  })

  it("finds M1385 with P1 or P1b with the flag on, passing all five checks", async () => {
    const [result] = await selfTest("mesh-pair", ["M1385-on"], { out })
    allChecks(result!)
    expect(["P1", "P1b"]).toContain(result!.property)
    expect(result!.gating).toBe(true)
  })

  it("finds M1374s with P2, passing all five checks", async () => {
    const [result] = await selfTest("mesh-pair", ["M1374s"], { out })
    allChecks(result!)
    expect(result!.property).toBe("P2")
    expect(result!.gating).toBe(true)
  })

  it("finds ML1 (the actor drops every connection replacement) with L1, the liveness check, passing all five checks", async () => {
    const [result] = await selfTest("mesh-pair", ["ML1"], { out })
    allChecks(result!)
    expect(result!.property).toBe("L1")
    expect(result!.gating).toBe(true)
  })

  it("is blind to ML1 without L1: no monitor of the safety properties trips on it", async () => {
    const result = await runMutant({ ...loadSpec("ML1"), id: "ML1safety", mustTrip: ["P1", "P1b", "P2"] }, { out })
    expect(result.checks.mutatedRed).toBe(false)
    expect(result.found).toBe(false)
  })

  it("finds the gating M1374s mutant with dedup enabled", async () => {
    const [result] = await selfTest("mesh-pair", ["M1374s"], { out, dedup: true })
    allChecks(result!)
    expect(result!.property).toBe("P2")
  })

  it("reports M1385b as found or not found without failing the run", async () => {
    const [result] = await selfTest("mesh-pair", ["M1385b"], { out })
    expect(result!.gating).toBe(false)
    expect(typeof result!.found).toBe("boolean")
    expect(result!.refresh).toBeUndefined()
    // its warmup is M1385's, which the unmutated room reaches
    expect(result!.checks.precondition).toBe(true)
  })

  it("calls a blind explorer blind: a gating mutant whose every replace is its find is not found, and the run exits 2", async () => {
    const base = loadSpec("M1385-on")
    const blind: MutantSpec = { ...base, id: "Mblind", hunks: base.hunks.map(({ find }) => ({ find, replace: find })) }
    const result = await runMutant(blind, { out })
    expect(result.gating).toBe(true)
    expect(result.checks.precondition).toBe(true)
    expect(result.checks.mutatedRed).toBe(false)
    expect(result.found).toBe(false)
    const passed = selfTestPassed([result])
    expect(passed).toBe(false)
    expect(exitCode({ violations: 0, mutantMissed: !passed, harnessError: false, inconclusive: false })).toBe(2)
    // a reported-only mutant that is not found does not fail the run
    expect(selfTestPassed([{ ...result, gating: false }])).toBe(true)
  })

  it("fails the hunk-hit check when the mutated statement never runs", async () => {
    const base = loadSpec("M1385-on")
    // one more hunk in setIcePolicy, which nothing in the room calls: the red is real, the hunk never runs
    const planted: MutantSpec = {
      ...base,
      id: "Mplanted",
      hunks: [
        ...base.hunks,
        {
          find: 'if ((this.rtcConfig.iceTransportPolicy ?? "all") === policy && this.relayProtocols.join() === relayProtocols.join()) return',
          replace: 'if ((this.rtcConfig.iceTransportPolicy ?? "all") === policy && this.relayProtocols.join() === relayProtocols.join()) return',
        },
      ],
    }
    const result = await runMutant(planted, { out })
    expect(result.checks.mutatedRed).toBe(true)
    expect(result.checks.hunkHit).toBe(false)
    expect(result.hits!.search[base.hunks.length]).toBe(0)
    expect(result.found).toBe(false)
  })
})
