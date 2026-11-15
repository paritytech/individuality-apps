// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * One line per finished depth of a mesh-pair search, so a long (sharded) run
 * can be read while it works, and the levels closed so far survive a SIGTERM.
 * Each line is printed by the shard's worker and appended, as one JSON record,
 * to <run out>/progress.jsonl, which the parent reads back when it is stopped.
 */
import { mergeReports } from "./cli"
import type { SearchLevel, SearchResult } from "./search"

export interface MeshProgressRecord {
  machine: "mesh-pair"
  /** the scenario, or the anchor when the run names one */
  scenario: string
  anchor?: string
  shard: { index: number; of: number } | null
  depth: number
  leaves: number
  expanded?: number
  seen?: number
  /** keys in this shard's dedup table, and the bytes it had allocated, at the depth's end */
  dedupEntries?: number
  dedupBytes?: number
  /** distinct findings this shard has recorded so far */
  findings: number
  elapsedMs: number
  heapMb: number
  rssMb: number
  bounds: { depth: number; faults: number; horizonMs: number }
  /** the level as the search closed it, so a stopped run can still report it */
  level: SearchLevel
}

const MB = 2 ** 20

export function meshProgressRecord(
  run: Pick<MeshProgressRecord, "scenario" | "anchor" | "shard" | "bounds">,
  level: SearchLevel,
  findings: number,
  memory: { heapUsed: number; rss: number } = process.memoryUsage(),
): MeshProgressRecord {
  // the census material is large and not needed to report a closed depth
  const { _censusKeys, _censusPaths, ...kept } = level
  void _censusKeys
  void _censusPaths
  return {
    machine: "mesh-pair",
    scenario: run.scenario,
    ...(run.anchor === undefined ? {} : { anchor: run.anchor }),
    shard: run.shard,
    depth: level.depth,
    leaves: level.leaves,
    ...(level.expanded === undefined ? {} : { expanded: level.expanded }),
    ...(level.seen === undefined ? {} : { seen: level.seen }),
    ...(level.dedupEntries === undefined ? {} : { dedupEntries: level.dedupEntries }),
    ...(level.dedupBytes === undefined ? {} : { dedupBytes: level.dedupBytes }),
    findings,
    elapsedMs: Math.round(level.elapsedMs),
    heapMb: Math.round(memory.heapUsed / MB),
    rssMb: Math.round(memory.rss / MB),
    bounds: run.bounds,
    level: kept,
  }
}

export function formatMeshProgress(record: MeshProgressRecord): string {
  const parts = [
    `mesh-pair ${record.anchor ?? record.scenario}`,
    `shard=${record.shard === null ? "-" : `${record.shard.index}/${record.shard.of}`}`,
    `depth=${record.depth}`,
    `leaves=${record.leaves}`,
    ...(record.expanded === undefined ? [] : [`expanded=${record.expanded}`]),
    ...(record.seen === undefined ? [] : [`seen=${record.seen}`]),
    ...(record.dedupEntries === undefined ? [] : [`dedup_entries=${record.dedupEntries}`]),
    ...(record.dedupBytes === undefined ? [] : [`dedup_bytes=${record.dedupBytes}`]),
    `findings=${record.findings}`,
    `elapsed_ms=${record.elapsedMs}`,
    `heap_mb=${record.heapMb}`,
    `rss_mb=${record.rssMb}`,
  ]
  return parts.join(" ")
}

export const parseProgressJsonl = (text: string): MeshProgressRecord[] =>
  text.split("\n").filter((line) => line.trim() !== "").flatMap((line) => {
    try {
      return [JSON.parse(line) as MeshProgressRecord]
    } catch {
      return [] // a line cut short by the kill
    }
  })

/** The depths every shard finished, merged as a finished run would be, but inconclusive. Undefined when no depth is closed by all. */
export function partialMeshResult(records: readonly MeshProgressRecord[]): { result: SearchResult; bounds: MeshProgressRecord["bounds"]; findingsSoFar: number; interruptedAtDepth: number } | undefined {
  if (records.length === 0) return undefined
  const shards = records[0]!.shard?.of ?? 1
  const byDepth = new Map<number, Map<number, MeshProgressRecord>>()
  for (const record of records) {
    const at = byDepth.get(record.depth) ?? new Map<number, MeshProgressRecord>()
    at.set(record.shard?.index ?? 0, record)
    byDepth.set(record.depth, at)
  }
  const closed = [...byDepth].filter(([, at]) => at.size === shards).map(([depth]) => depth).sort((a, b) => a - b)
  if (closed.length === 0) return undefined
  const last = closed.at(-1)!
  const parts: SearchResult[] = Array.from({ length: shards }, (_, index) => ({
    levels: closed.map((depth) => byDepth.get(depth)!.get(index)!.level),
    closedAtDepth: last,
    inconclusive: true,
    findings: [],
  }))
  const merged = mergeReports(parts)
  merged.closedAtDepth = last
  merged.inconclusive = true
  const findingsSoFar = Array.from({ length: shards }, (_, index) => {
    const own = records.filter((record) => (record.shard?.index ?? 0) === index)
    return own.length === 0 ? 0 : Math.max(...own.map((record) => record.findings))
  }).reduce((sum, count) => sum + count, 0)
  return { result: merged, bounds: records[0]!.bounds, findingsSoFar, interruptedAtDepth: last }
}
