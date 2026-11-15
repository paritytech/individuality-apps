// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Mesh-pair plug-in for room/tiled.ts's disk-backed BFS.
 *
 * The room engine remains the sole owner of frontier files, 128-bit tile
 * ownership, per-depth journals, torn-write recovery, and worker scheduling.
 * This module supplies only the mesh-pair options and result shape.
 */
import { join } from "node:path"
import type { ExplorerVersion } from "../core/checkpoint"
import {
  runTiled,
  type TiledFinding,
  type TiledLayer,
} from "../room/tiled"
import type { ScenarioName } from "./room"

export interface MeshTiledOptions {
  out: string
  depth: number
  faults: number
  horizonMs: number
  scenario: ScenarioName | string
  tiles?: number
  workers: number
  heartbeat?: boolean
  version: ExplorerVersion
  forceResume?: boolean
  /** deterministic state-boundary checkpoint hook used by integration tests */
  stopAfterStates?: number
  /** deterministic tile-boundary checkpoint hook used to prove worker re-sharding */
  stopAfterTiles?: number
  /** deterministic worker-recycle boundary used by integration tests */
  workerStateLimit?: number
}

export interface MeshTiledResult {
  layers: TiledLayer[]
  findings: TiledFinding[]
  checkpointed: boolean
  checkpoint?: { reason: "requested" | "signal"; bytes: number; writeMs: number }
}

export async function runCheckpointableMesh(options: MeshTiledOptions): Promise<MeshTiledResult> {
  const result = await runTiled({
    out: options.out,
    run: "mesh-pair",
    scenario: options.scenario,
    depth: options.depth,
    faults: options.faults,
    horizonMs: options.horizonMs,
    tiles: options.tiles,
    pairShards: 1,
    inclusionEvery: 0,
    probeEvery: 0,
    workers: options.workers,
    workerEntry: join(import.meta.dirname, "../room/tiled-main.ts"),
    heartbeat: options.heartbeat,
    version: options.version,
    forceResume: options.forceResume,
    stopAfterStates: options.stopAfterStates,
    stopAfterTiles: options.stopAfterTiles,
    workerStateLimit: options.workerStateLimit,
  })
  return {
    layers: result.layers,
    findings: result.counts.findings,
    checkpointed: result.checkpointed ?? false,
    ...(result.checkpoint ? { checkpoint: result.checkpoint } : {}),
  }
}
