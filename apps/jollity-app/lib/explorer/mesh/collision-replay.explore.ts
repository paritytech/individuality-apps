// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// quiescence first: it traps real timers before room.ts loads
import "./quiescence"
import { readdir, readFile, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { describe, expect, it, onTestFinished } from "vitest"
import { silenceConsoleLog } from "../core/quiet-console"
import { replayCollisionPair, type CensusPaths } from "../core/search"
import { exploreRoom, type ScenarioName } from "./room"

interface CollisionArgs {
  out: string
  scenario: ScenarioName
  faults: number
  horizonMs: number
  suffixDepth: 2 | 3
  executionShard?: { index: number; of: number }
}

interface ShardReport {
  levels: Array<{ depth: number; _censusPaths?: CensusPaths[]; census?: { depthLeaves: number; distinctFingerprints: number } }>
}

const parsed = (): CollisionArgs | undefined => {
  const value = process.env.EXPLORER_COLLISION
  return value === undefined ? undefined : JSON.parse(value) as CollisionArgs
}

const pathKey = (path: readonly string[]) => path.join("\0")

/** The census paths of the actor-driven tree. Census keys are bare. A census
 *  saved while Mesh's old decision path existed can still hold the flag-off tree's ("off:" keys), which
 *  are dropped, or "on:"-prefixed keys, which lose the prefix. */
export function collisionPathsForFlag(entries: readonly CensusPaths[]): CensusPaths[] {
  return entries
    .filter(({ key }) => !key.startsWith("off:"))
    .map((entry) => ({ ...entry, key: entry.key.startsWith("on:") ? entry.key.slice(3) : entry.key }))
}

if (parsed() === undefined) {
  describe.skip("explorer census collision replay", () => {
    it("requires EXPLORER_COLLISION", () => undefined)
  })
} else {
  describe("explorer census collision replay", () => {
    it("compares every merged census fingerprint by key-independent suffix ground truth", async () => {
      const args = parsed()!
      // every replayed room logs its rtc events, and vitest's parent keeps each line until the run ends
      onTestFinished(silenceConsoleLog())
      const out = resolve(args.out)
      const shardDirs = (await readdir(out, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && /^shard-\d+$/.test(entry.name))
        .map((entry) => entry.name)
        .sort((left, right) => Number(left.slice(6)) - Number(right.slice(6)))
      if (shardDirs.length === 0) throw new Error(`collision replay needs sharded census reports under ${out}`)

      const reports = await Promise.all(shardDirs.map(async (dir) =>
        JSON.parse(await readFile(resolve(out, dir, "report.json"), "utf8")) as ShardReport,
      ))
      const depth = Math.max(...reports.flatMap((report) => report.levels.map((level) => level.depth)))
      const pathsByKey = new Map<string, string[][]>()
      let depthLeaves = 0
      const distinct = new Set<string>()
      for (const report of reports) {
        const level = report.levels.find((candidate) => candidate.depth === depth)
        if (!level?.census) throw new Error(`shard report has no census at d=${depth}`)
        depthLeaves += level.census.depthLeaves
        for (const entry of collisionPathsForFlag(level._censusPaths ?? [])) {
          distinct.add(entry.key)
          const paths = pathsByKey.get(entry.key) ?? []
          for (const path of entry.paths) {
            if (paths.length >= 2) break
            if (!paths.some((held) => pathKey(held) === pathKey(path))) paths.push([...path])
          }
          pathsByKey.set(entry.key, paths)
        }
      }
      const collisions = [...pathsByKey.entries()]
        .filter(([, paths]) => paths.length >= 2)
        .sort(([left], [right]) => left.localeCompare(right))
      const executionShard = args.executionShard
      if (executionShard !== undefined && (
        !Number.isInteger(executionShard.index) || !Number.isInteger(executionShard.of)
        || executionShard.of < 1 || executionShard.index < 0 || executionShard.index >= executionShard.of
      )) throw new Error(`invalid collision execution shard ${JSON.stringify(executionShard)}`)
      const assigned = executionShard === undefined
        ? collisions
        : collisions.filter((_, index) => index % executionShard.of === executionShard.index)
      const room = await exploreRoom({
        scenario: args.scenario,
        phaseOffsetMs: 1000,
        faults: args.faults,
        horizonMs: args.horizonMs,
        checkUnowned: true,
      })
      const mismatches: unknown[] = []
      try {
        for (const [key, paths] of assigned) {
          const mismatch = await replayCollisionPair(room, paths[0]!, paths[1]!, args.suffixDepth)
          if (mismatch) mismatches.push({ key, ...mismatch })
        }
      } finally {
        room.close()
      }

      const result = {
        scenario: args.scenario,
        depth,
        suffixDepth: args.suffixDepth,
        depthLeaves,
        distinctFingerprints: distinct.size,
        mergedFingerprintsTotal: collisions.length,
        mergedFingerprintsReplayed: assigned.length,
        mergeCount: depthLeaves - distinct.size,
        executionShard,
        mismatches,
      }
      const shardSuffix = executionShard === undefined ? "" : `-${executionShard.index}-of-${executionShard.of}`
      await writeFile(resolve(out, `collision-on${shardSuffix}.json`), `${JSON.stringify(result, null, 2)}\n`)
      expect(mismatches, mismatches.length === 0 ? undefined : JSON.stringify(mismatches[0], null, 2)).toEqual([])
    })
  })
}
