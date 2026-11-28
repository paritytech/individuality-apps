// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { nextRotation } from "./rotation-sequence.mts"

describe("nextRotation", () => {
  it("starts at A and alternates from the newest retained same-network play marker", () => {
    expect(nextRotation([], 20, "previewnet")).toEqual({ half: "A", runNumber: 20 })
    expect(nextRotation([{ name: "e2e-rotation-play-previewnet-10-A", workflow_run: { id: 10 } }], 20, "previewnet")).toEqual({ half: "B", runNumber: 20 })
    expect(nextRotation([
      { name: "e2e-rotation-play-previewnet-10-A", workflow_run: { id: 10 } },
      { name: "e2e-rotation-play-previewnet-13-B", workflow_run: { id: 13 } },
    ], 20, "previewnet")).toEqual({ half: "A", runNumber: 20 })
  })

  it("keeps a rerun on its own recorded half and ignores other networks", () => {
    const markers = [
      { name: "e2e-rotation-play-previewnet-10-A", workflow_run: { id: 10 } },
      { name: "e2e-rotation-play-paseo-next-v2-19-B", workflow_run: { id: 19 } },
      { name: "e2e-rotation-play-previewnet-20-B", workflow_run: { id: 20 } },
    ]
    expect(nextRotation(markers, 20, "previewnet")).toEqual({ half: "B", runNumber: 20 })
  })

  it("does not drift when older markers expire", () => {
    const newest = { name: "e2e-rotation-play-previewnet-90-B", workflow_run: { id: 90 } }
    expect(nextRotation([newest], 100, "previewnet")).toEqual(nextRotation([
      { name: "e2e-rotation-play-previewnet-1-A", workflow_run: { id: 1 } }, newest,
    ], 100, "previewnet"))
  })

  it("the workflow defaults to rotate and records play decisions, not dispatches", () => {
    const workflow = readFileSync(resolve(__dirname, "../../.github/workflows/e2e-live.yml"), "utf8")
    expect(workflow).toMatch(/bots:[\s\S]*?default: "rotate"/)
    expect(workflow).toContain("actions/artifacts?per_page=100")
    expect(workflow).toContain("e2e-rotation-play-${{ inputs.network || 'previewnet' }}-${{ github.run_id }}-${{ steps.rotation.outputs.rotation_half }}")
    expect(workflow).toContain("steps.final.outputs.decision == 'play' && inputs.bots == 'rotate'")
  })
})
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
