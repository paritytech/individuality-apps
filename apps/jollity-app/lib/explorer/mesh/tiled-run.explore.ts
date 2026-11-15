// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/** Vitest coordinator for the checkpointable mesh-pair tiled search. */
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { isAbsolute, resolve } from "node:path"
import { describe, it } from "vitest"
import type { ExplorerVersion } from "../core/checkpoint"
import type { ExploreArgs } from "../core/cli"
import { writeReport } from "../core/report"
import type { SearchResult } from "../core/search"
import { selfTest, selfTestPassed } from "../mutants/self-test"
import { isMeshAnchor, MESH_ANCHORS } from "./anchors"
import { SCENARIOS } from "./scenarios"
import { runCheckpointableMesh } from "./tiled-checkpoint"
import type { TiledMeta } from "../room/tiled"

const args = process.env.EXPLORE_ARGS
  ? JSON.parse(process.env.EXPLORE_ARGS) as ExploreArgs
  : undefined
const version = process.env.EXPLORER_VERSION
  ? JSON.parse(process.env.EXPLORER_VERSION) as ExplorerVersion
  : undefined
const root = resolve(import.meta.dirname, "../../../../../")

if (!args || !version) {
  describe.skip("checkpointable mesh-pair run", () => it("needs EXPLORE_ARGS and EXPLORER_VERSION", () => undefined))
} else {
  describe("checkpointable mesh-pair run", () => {
    it("runs the tiled mesh-pair engine", async () => {
      const out = isAbsolute(args.out) ? args.out : resolve(root, args.out)
      const recorded = args.resume
        ? JSON.parse(await readFile(resolve(out, "meta.json"), "utf8")) as TiledMeta
        : undefined
      const recordedName = recorded?.anchor ?? recorded?.scenario
      const named = args.scenario ?? recordedName ?? "rejoin-two-offers"
      const scenario = isMeshAnchor(named) ? MESH_ANCHORS[named].scenario : named as keyof typeof SCENARIOS
      const defaults = SCENARIOS[scenario]
      if (!defaults) throw new Error(`unknown mesh-pair scenario: ${named}`)
      const depth = args.depth ?? recorded?.depth ?? defaults.defaults.depth
      const faults = args.faults ?? recorded?.faults ?? defaults.defaults.faults
      const horizonMs = args.horizonS === undefined
        ? recorded?.horizonMs ?? defaults.defaults.horizonMs
        : args.horizonS * 1_000
      const heartbeat = args.heartbeat === false ? false : recorded?.heartbeat !== false
      await mkdir(out, { recursive: true })
      const mutants = args.selfTest ? await selfTest("mesh-pair", undefined, { out: resolve(out, "self-test"), dedup: true }) : undefined
      const result = await runCheckpointableMesh({
        out,
        scenario: named,
        depth,
        faults,
        horizonMs,
        workers: args.workers,
        heartbeat,
        version,
        forceResume: args.forceResume,
      })
      const search: SearchResult = {
        levels: result.layers.map((layer) => ({
          depth: layer.depth,
          leaves: layer.added,
          meanEnabled: layer.added === 0 ? 0 : layer.edges / layer.added,
          cuts: { depth: layer.added, faults: layer.faultCuts, horizon: 0, quiet: 0, seen: layer.answered, harness: layer.findingCounts.harness ?? 0 },
          details: {},
          elapsedMs: layer.phaseMs,
          expanded: layer.states,
          seen: layer.answered,
        })),
        closedAtDepth: result.layers.at(-1)?.depth ?? 0,
        inconclusive: result.checkpointed,
        findings: result.findings
          .filter((finding) => finding.property !== "harness")
          .map((finding) => ({ ...finding, atStep: Math.max(0, finding.labels.length - 1), sampled: false })),
      }
      await writeReport(out, "mesh-pair", search, {
        bounds: {
          depth,
          faults,
          horizonMs,
          dedup: true,
        },
        scenario: { name: named, phaseOffsetMs: 1000 },
        source: { kind: "mesh-pair-tiled-bfs", workers: args.workers, version, checkpoint: result.checkpoint ?? null },
      })
      await writeFile(resolve(out, "self-test.json"), `${JSON.stringify(mutants === undefined
        ? { requested: false, passed: false }
        : { requested: true, passed: selfTestPassed(mutants), dedup: true, results: mutants })}\n`)
    })
  })
}
