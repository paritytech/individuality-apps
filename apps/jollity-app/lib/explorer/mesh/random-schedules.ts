// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Test support: random schedules over a real room, for the differential tests
 * of the room's cached and streamed computations against their reference
 * versions. Seeded, so every run takes the same schedules.
 */
import { isFault, type Label } from "../core/labels"
import { MESH_ANCHORS, readMeshAnchor, isMeshAnchor } from "./anchors"
import { exploreRoom, type Room, type ScenarioName } from "./room"
import { SCENARIOS } from "./scenarios"

/** a seeded generator (mulberry32) */
export function rng(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** A room for a scenario or a mesh anchor (its base scenario plus its warmup), with the explorer's mesh-pair bounds. */
async function roomFor(name: string, faults = 2): Promise<{ room: Room; warmup: Label[] }> {
  const scenario = (isMeshAnchor(name) ? MESH_ANCHORS[name].scenario : name) as ScenarioName
  const warmup = isMeshAnchor(name) ? readMeshAnchor(name).warmup : []
  const room = await exploreRoom({
    scenario,
    phaseOffsetMs: 1000,
    faults: faults + warmup.filter(isFault).length,
    horizonMs: SCENARIOS[scenario].defaults.horizonMs,
  })
  return { room, warmup }
}

/** `schedules` random walks of up to `depth` steps after reset and warmup;
 *  `onNode` sees the room after the warmup and after every step. */
export async function randomSchedules(
  name: string,
  options: { schedules: number; depth: number; seed: number },
  onNode: (room: Room, labels: readonly Label[]) => void | Promise<void>,
): Promise<number> {
  const { room, warmup } = await roomFor(name)
  const random = rng(options.seed)
  let nodes = 0
  try {
    for (let schedule = 0; schedule < options.schedules; schedule++) {
      await room.reset()
      for (const label of warmup) await room.step(label)
      const labels: Label[] = []
      await onNode(room, labels)
      nodes++
      for (let step = 0; step < options.depth; step++) {
        if (room.horizonReached()) break
        const enabled = room.enabled().filter((label) => !isFault(label) || room.faultsLeft() > 0)
        if (enabled.length === 0) break
        const label = enabled[Math.floor(random() * enabled.length)]!
        await room.step(label)
        labels.push(label)
        await onNode(room, labels)
        nodes++
      }
    }
  } finally {
    room.close()
  }
  return nodes
}
