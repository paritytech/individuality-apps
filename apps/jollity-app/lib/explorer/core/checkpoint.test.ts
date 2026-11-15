// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import {
  assertCheckpointVersion,
  atomicWriteJson,
  type ExplorerVersion,
} from "./checkpoint"

describe("explorer checkpoint metadata", () => {
  const recorded: ExplorerVersion = { gitSha: "abc123", sourceHash: "sources-a" }
  const current: ExplorerVersion = { gitSha: "def456", sourceHash: "sources-b" }

  it("refuses a source mismatch explicitly unless resume is forced", () => {
    expect(() => assertCheckpointVersion(recorded, current, false)).toThrow(
      /checkpoint source version mismatch.*--force-resume/s,
    )
    expect(() => assertCheckpointVersion(recorded, current, true)).not.toThrow()
    expect(() => assertCheckpointVersion(recorded, recorded, false)).not.toThrow()
  })

  it("never replaces a completed checkpoint with a partial write", async () => {
    const out = await mkdtemp(join(tmpdir(), "explorer-checkpoint-"))
    const file = join(out, "checkpoint.json")
    await writeFile(file, `${JSON.stringify({ generation: 1 })}\n`)
    const failRename = vi.fn(async () => {
      throw new Error("simulated rename failure")
    })

    await expect(atomicWriteJson(file, { generation: 2 }, failRename)).rejects.toThrow(
      /simulated rename failure/,
    )
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ generation: 1 })

    await atomicWriteJson(file, { generation: 3 })
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ generation: 3 })
  })
})
