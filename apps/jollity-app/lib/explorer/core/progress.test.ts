// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { formatMeshProgress, meshProgressRecord, parseProgressJsonl, partialMeshResult } from "./progress"
import { search, type SearchLevel, type SearchRoom } from "./search"
import type { Label } from "./labels"

const level = (depth: number, leaves: number, extra: Partial<SearchLevel> = {}): SearchLevel => ({
  depth,
  leaves,
  meanEnabled: 2,
  cuts: { depth: leaves, faults: 0, horizon: 0, quiet: 0, seen: 0, harness: 0 },
  details: {},
  elapsedMs: 1234.6,
  ...extra,
})

const run = { scenario: "steady", anchor: "steady", shard: { index: 1, of: 2 }, bounds: { depth: 5, faults: 2, horizonMs: 120_000 } }
const memory = { heapUsed: 300 * 2 ** 20, rss: 900 * 2 ** 20 }

class Toy implements SearchRoom {
  private labels: Label[] = []
  enabled(): Label[] { return ["a", "b"] }
  async step(label: Label) { this.labels.push(label); return {} as never }
  async reset() { this.labels = [] }
  violations() { return [] }
  faultsLeft() { return 0 }
  horizonReached() { return false }
}

describe("mesh-pair per-depth progress", () => {
  it("formats one line with the depth's numbers", () => {
    const record = meshProgressRecord(run, level(3, 40, { expanded: 12, seen: 7, dedupEntries: 15, dedupBytes: 24_576 }), 1, memory)
    expect(formatMeshProgress(record)).toBe("mesh-pair steady shard=1/2 depth=3 leaves=40 expanded=12 seen=7 dedup_entries=15 dedup_bytes=24576 findings=1 elapsed_ms=1235 heap_mb=300 rss_mb=900")
    expect(record).toMatchObject({ dedupEntries: 15, dedupBytes: 24_576 })
    expect(formatMeshProgress(meshProgressRecord({ ...run, anchor: undefined, shard: null }, level(1, 2), 0, memory))).toBe("mesh-pair steady shard=- depth=1 leaves=2 findings=0 elapsed_ms=1235 heap_mb=300 rss_mb=900")
  })

  it("search reports exactly one level per finished depth", async () => {
    const seen: number[] = []
    const result = await search(async () => new Toy(), { depth: 3, budgetMs: 60_000, onLevel: (l) => seen.push(l.depth) })
    expect(seen).toEqual([1, 2, 3])
    expect(result.levels.map((l) => l.depth)).toEqual(seen)
  })

  it("rebuilds the depths every shard closed from progress.jsonl, skipping a torn last line", () => {
    const rec = (index: number, depth: number, leaves: number) => meshProgressRecord({ ...run, shard: { index, of: 2 } }, level(depth, leaves), 0, memory)
    const text = [rec(0, 1, 4), rec(1, 1, 6), rec(0, 2, 10), rec(1, 2, 12), rec(0, 3, 30)].map((r) => JSON.stringify(r)).join("\n") + '\n{"machine":"mesh'
    const partial = partialMeshResult(parseProgressJsonl(text))!
    expect(partial.interruptedAtDepth).toBe(2)
    expect(partial.result.inconclusive).toBe(true)
    expect(partial.result.levels.map((l) => [l.depth, l.leaves])).toEqual([[1, 10], [2, 22]])
    expect(partialMeshResult([])).toBeUndefined()
    expect(partialMeshResult([rec(0, 1, 4)])).toBeUndefined()
  })
})
