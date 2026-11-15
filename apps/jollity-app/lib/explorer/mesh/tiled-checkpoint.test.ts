// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import type { ExplorerVersion } from "../core/checkpoint"
import { search, type SearchRoom } from "../core/search"
import { exploreRoom } from "./room"
import { monitorsFor } from "./monitors"
import {
  runCheckpointableMesh,
  type MeshTiledResult,
} from "./tiled-checkpoint"

const dirs: string[] = []
beforeAll(() => vi.spyOn(console, "log").mockImplementation(() => undefined))
const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), "mesh-tiled-checkpoint-"))
  dirs.push(dir)
  return dir
}
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

/**
 * Every committed journal line of a run, by stage and tile: the per-tile counts (memory peaks left out,
 * they are the process's), and how many complete and incomplete lines each tile has across all workers.
 */
const tileLedger = (out: string) => {
  const counts: Record<string, unknown> = {}
  const complete: Record<string, number> = {}
  const partial: Record<string, number> = {}
  for (const name of readdirSync(join(out, "journal")).sort()) {
    const stage = name.split(".")[0]!
    for (const text of readFileSync(join(out, "journal", name), "utf8").split("\n")) {
      if (!text) continue
      const line = JSON.parse(text) as { tile: number; complete?: boolean; counts: Record<string, unknown> }
      const key = `${stage}:${line.tile}`
      if (line.complete === false) {
        partial[key] = (partial[key] ?? 0) + 1
        continue
      }
      complete[key] = (complete[key] ?? 0) + 1
      counts[key] = { ...line.counts, peakRssMb: undefined, peakHeapMb: undefined }
    }
  }
  return { counts, complete, partial }
}

/** Run until a run is not killed: each kill is a worker SIGKILLed mid-tile, then a resume. */
const untilDone = async (run: () => Promise<MeshTiledResult>, attempts = 12): Promise<MeshTiledResult> => {
  for (let attempt = 1; ; attempt++) {
    try {
      return await run()
    } catch (error) {
      if (attempt >= attempts || !/tiled mesh worker \d+ exited/.test(String(error))) throw error
    }
  }
}

const version: ExplorerVersion = { gitSha: "test-sha", sourceHash: "test-sources" }
const changedVersion: ExplorerVersion = { gitSha: "other-sha", sourceHash: "other-sources" }
const base = {
  depth: 6,
  faults: 1,
  horizonMs: 120_000,
  scenario: "single-offer" as const,
  tiles: 8,
  workers: 0,
  version,
}
const shape = (result: MeshTiledResult) => ({
  layers: result.layers.map(({
    depth,
    states,
    added,
    edges,
    faultCuts,
    findingCounts,
    received,
    answered,
    gaps,
    probes,
    spreadToNext,
  }) => ({
    depth,
    states,
    added,
    edges,
    faultCuts,
    findingCounts,
    received,
    answered,
    gaps,
    probes,
    spreadToNext,
  })),
  findings: result.findings.map(({ property, detail, labels }) => ({ property, detail, labels })),
})

describe("checkpointable tiled mesh-pair search", () => {
  it("recycles a mesh worker at a state boundary and continues from its journal", async () => {
    const options = { ...base, depth: 0, tiles: 1 }
    const uninterrupted = await runCheckpointableMesh({ ...options, out: scratch() })
    const out = scratch()
    const recycled = await runCheckpointableMesh({ ...options, out, workers: 1, workerStateLimit: 1 })
    const journal = readdirSync(join(out, "journal"))
      .flatMap((name) => readFileSync(join(out, "journal", name), "utf8").trim().split("\n"))
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { complete?: boolean; nextState?: number })

    expect(journal.some((line) => line.complete === false && line.nextState === 1)).toBe(true)
    expect(shape(recycled)).toEqual(shape(uninterrupted))
  }, 600_000)

  it("equals an uninterrupted run after two mid-depth state-boundary checkpoints", async () => {
    const uninterrupted = await runCheckpointableMesh({ ...base, out: scratch(), workers: 1 })
    const whole = shape(uninterrupted)
    const out = scratch()

    const first = await runCheckpointableMesh({ ...base, out, stopAfterStates: 2 })
    expect(first.checkpointed).toBe(true)
    expect(first.checkpoint?.reason).toBe("requested")

    const second = await runCheckpointableMesh({ ...base, out, stopAfterStates: 5 })
    expect(second.checkpointed).toBe(true)

    const resumed = await runCheckpointableMesh({ ...base, out, workers: 1 })
    expect(shape(resumed)).toEqual(whole)
    expect(resumed.layers.some((layer) => layer.resumed)).toBe(true)

    const room = await exploreRoom({ scenario: base.scenario, phaseOffsetMs: 1000, faults: base.faults, horizonMs: base.horizonMs, monitors: monitorsFor(1), heartbeat: true })
    try {
      const searched: SearchRoom = {
        enabled: () => room.enabled(),
        step: (label) => room.step(label),
        reset: () => room.reset(),
        violations: () => room.violations(),
        faultsLeft: () => room.faultsLeft(),
        horizonReached: () => room.horizonReached(),
        fingerprint: () => room.fingerprint(),
      }
      const legacy = await search(async () => searched, { depth: base.depth, budgetMs: 120_000, dedup: {} })
      expect(legacy.levels.map((level) => level.expanded)).toEqual([
        1,
        ...uninterrupted.layers.slice(0, -1).map((layer) => layer.states),
      ])
      const findings = (values: { property: string; detail: string }[]) => values.map(({ property, detail }) => ({ property, detail })).sort((a, b) => `${a.property}:${a.detail}`.localeCompare(`${b.property}:${b.detail}`))
      expect(findings(uninterrupted.findings)).toEqual(findings(legacy.findings))
    } finally {
      room.close()
    }
  }, 900_000)

  it("repartitions state-hash tiles when the worker count changes", async () => {
    const options = { ...base, depth: 3 }
    const uninterrupted = await runCheckpointableMesh({ ...options, out: scratch(), workers: 1 })
    const out = scratch()
    const interrupted = await runCheckpointableMesh({ ...options, out, workers: 1, stopAfterTiles: 2 })
    expect(interrupted.checkpointed).toBe(true)

    const resumed = await runCheckpointableMesh({ ...options, out, workers: 2 })
    expect(shape(resumed)).toEqual(shape(uninterrupted))
    expect(resumed.layers.some((layer) => layer.resumed)).toBe(true)
  }, 600_000)

  describe("the Mesh worker pool's queue", () => {
    const options = { ...base, scenario: "outage" as const, depth: 4 }

    it("gives several workers the per-tile results of one process, each tile committed once", async () => {
      const reference = scratch()
      const single = await runCheckpointableMesh({ ...options, out: reference })
      const out = scratch()
      const pooled = await runCheckpointableMesh({ ...options, out, workers: 3 })
      expect(shape(pooled)).toEqual(shape(single))
      const ledger = tileLedger(out)
      expect(ledger.counts).toEqual(tileLedger(reference).counts)
      expect(Object.values(ledger.complete).every((lines) => lines === 1)).toBe(true)
      // the queue spread the tiles: more than one worker committed some
      expect(new Set(readdirSync(join(out, "journal")).map((name) => name.split(".")[1])).size).toBeGreaterThan(1)
    }, 900_000)

    it("resumes workers killed at random points mid-tile to the uninterrupted results", async () => {
      const reference = scratch()
      const whole = await runCheckpointableMesh({ ...options, out: reference })
      const out = scratch()
      const kills = scratch()
      process.env.TILED_TEST_KILL_DIR = kills
      process.env.TILED_TEST_KILLS = "4"
      try {
        const resumed = await untilDone(() => runCheckpointableMesh({ ...options, out, workers: 3, workerStateLimit: 4 }))
        // at least one kill landed inside a tile's work, not at a commit boundary
        expect(readdirSync(kills).some((name) => readFileSync(join(kills, name), "utf8").startsWith("timer"))).toBe(true)
        expect(shape(resumed)).toEqual(shape(whole))
        const ledger = tileLedger(out)
        expect(ledger.counts).toEqual(tileLedger(reference).counts)
        expect(Object.values(ledger.complete).every((lines) => lines === 1)).toBe(true)
        // tiles were committed part by part, so the kills could land inside a tile
        expect(Object.keys(ledger.partial).some((key) => ledger.complete[key] === 1)).toBe(true)
      } finally {
        delete process.env.TILED_TEST_KILL_DIR
        delete process.env.TILED_TEST_KILLS
      }
    }, 1_800_000)

    it("resumes on more workers and then fewer to the uninterrupted results", async () => {
      const reference = scratch()
      const whole = await runCheckpointableMesh({ ...options, out: reference })
      const out = scratch()
      const first = await runCheckpointableMesh({ ...options, out, workers: 2, stopAfterTiles: 5 })
      expect(first.checkpointed).toBe(true)
      // ramp up, with a worker killed mid-tile so a high-numbered worker leaves a tile half done
      const kills = scratch()
      process.env.TILED_TEST_KILL_DIR = kills
      process.env.TILED_TEST_KILLS = "1"
      try {
        await runCheckpointableMesh({ ...options, out, workers: 4, workerStateLimit: 4 }).catch((error: unknown) => {
          if (!/tiled mesh worker \d+ exited/.test(String(error))) throw error
        })
      } finally {
        delete process.env.TILED_TEST_KILL_DIR
        delete process.env.TILED_TEST_KILLS
      }
      // the ramp-up killed a worker: without this the run above could pass with the injection inert
      expect(readdirSync(kills).length).toBeGreaterThan(0)
      // ramp down
      const resumed = await runCheckpointableMesh({ ...options, out, workers: 1 })
      expect(shape(resumed)).toEqual(shape(whole))
      expect(resumed.layers.some((layer) => layer.resumed)).toBe(true)
      const ledger = tileLedger(out)
      expect(ledger.counts).toEqual(tileLedger(reference).counts)
      expect(Object.values(ledger.complete).every((lines) => lines === 1)).toBe(true)
    }, 1_800_000)
  })

  it("extends a completed run by one depth exactly like a fresh larger run", async () => {
    const out = scratch()
    await runCheckpointableMesh({ ...base, depth: 3, out })

    const extended = await runCheckpointableMesh({ ...base, depth: 4, out })
    const fresh = await runCheckpointableMesh({ ...base, depth: 4, out: scratch() })

    expect(shape(extended)).toEqual(shape(fresh))
  }, 600_000)

  it("extends a previously interrupted run by two depths exactly like a fresh larger run", async () => {
    const out = scratch()
    const interrupted = await runCheckpointableMesh({ ...base, depth: 3, out, stopAfterStates: 2 })
    expect(interrupted.checkpointed).toBe(true)
    await runCheckpointableMesh({ ...base, depth: 3, out })

    const extended = await runCheckpointableMesh({ ...base, depth: 5, out })
    const fresh = await runCheckpointableMesh({ ...base, depth: 5, out: scratch() })

    expect(shape(extended)).toEqual(shape(fresh))
  }, 600_000)

  it("resumes after stopping during an extension without losing committed inbox output", async () => {
    const out = scratch()
    await runCheckpointableMesh({ ...base, depth: 3, out })
    const stopped = await runCheckpointableMesh({ ...base, depth: 5, out, stopAfterStates: 1 })
    expect(stopped.checkpointed).toBe(true)

    const resumed = await runCheckpointableMesh({ ...base, depth: 5, out })
    const fresh = await runCheckpointableMesh({ ...base, depth: 5, out: scratch() })

    expect(shape(resumed)).toEqual(shape(fresh))
  }, 600_000)

  it("refuses a changed explorer version unless forced", async () => {
    const out = scratch()
    const options = { ...base, depth: 2, out }
    await runCheckpointableMesh({ ...options, stopAfterStates: 1 })
    await expect(runCheckpointableMesh({ ...options, version: changedVersion })).rejects.toThrow(
      /checkpoint source version mismatch.*--force-resume/s,
    )
    await expect(runCheckpointableMesh({ ...options, version: changedVersion, forceResume: true })).resolves.toBeDefined()
  }, 600_000)
})
