// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/** Vitest-backed worker batch for mesh-pair tiles (the mesh room owns Vitest's fake clock). */
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { describe, it } from "vitest"
import { silenceConsoleLog } from "../core/quiet-console"
import { TileWorker } from "./tiled"

interface Batch {
  out: string
  worker: number
  depth: number
  tiles: number[]
  extend: boolean
  maxStates: number
}

const batch = process.env.TILED_MESH_BATCH
  ? JSON.parse(process.env.TILED_MESH_BATCH) as Batch
  : undefined

/**
 * Tests: with TILED_TEST_KILL_DIR set, the batch commits after a random few states, then SIGKILLs itself
 * within a random 20 ms of that commit (mid-state or mid-write: the slot file says "timer"), or right after
 * the tile's last commit when the tile is done sooner ("after"), while one of TILED_TEST_KILLS slots is free.
 */
const killDir = process.env.TILED_TEST_KILL_DIR
const killAfter = killDir ? 1 + Math.floor(Math.random() * 3) : undefined
// the Mesh room fakes the clock: the kill timer is the real one, taken before it does
const realSetTimeout = globalThis.setTimeout
const realClearTimeout = globalThis.clearTimeout
const killNow = (how: "timer" | "after") => {
  for (let slot = 0; slot < Number(process.env.TILED_TEST_KILLS ?? 1); slot++) {
    try {
      writeFileSync(join(killDir!, `kill-${slot}`), `${how} w${batch?.worker} ${batch?.tiles.join(",")}\n`, { flag: "wx" })
    } catch {
      continue
    }
    process.kill(process.pid, "SIGKILL")
  }
}

if (!batch) {
  describe.skip("tiled mesh worker", () => it("needs TILED_MESH_BATCH", () => undefined))
} else {
  describe("tiled mesh worker", () => {
    it(`processes worker ${batch.worker}'s tile batch`, async () => {
      // Not vi.spyOn: a spy keeps every call's arguments (Mesh logs each rtc event), which grew
      // a worker by tens of MB per 1,000 states.
      const restoreLog = silenceConsoleLog()
      const worker = new TileWorker(batch.out, batch.worker)
      let remaining = batch.maxStates
      try {
        for (const tile of batch.tiles) {
          if (remaining <= 0) break
          let result = await worker.processTile(batch.depth, tile, { extend: batch.extend, maxStates: killAfter === undefined ? remaining : Math.min(remaining, killAfter) })
          remaining -= result.states
          if (killAfter !== undefined && !result.complete && remaining > 0) {
            const kill = realSetTimeout(() => killNow("timer"), Math.floor(Math.random() * 20))
            result = await worker.processTile(batch.depth, tile, { extend: batch.extend, maxStates: remaining })
            realClearTimeout(kill)
            killNow("after")
            remaining -= result.states
          }
          if (!result.complete) break
        }
      } finally {
        worker.close()
        restoreLog()
      }
    })
  })
}
