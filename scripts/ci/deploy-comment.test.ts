// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { MARKER, NO_PREVIEW, PASEO_HINT, renderDeployComment, rowsOf } from "./deploy-comment.mjs"

const PREVIEW = { env: "preview", domain: "my-game-pr7-sandbox00.testnet", label: "my-game-pr7-sandbox00", shell: "testnet.li", cid: "bafyA" }
const PASEO = { env: "paseo-next-v2", domain: "my-game-pr7-sandbox00.paseo", label: "my-game-pr7-sandbox00", shell: "paseo.li", cid: "bafyB" }
const SKIPPED = { env: "preview", skipped: true }
const base = { label: "my-game-pr7-sandbox00", runUrl: "https://x/runs/1" }

describe("renderDeployComment", () => {
  it("a gated Previewnet still posts the skip lines, and no table", () => {
    const body = renderDeployComment({ ...base, planned: ["preview"], results: [SKIPPED] })!
    expect(body).toContain(NO_PREVIEW)
    expect(body).toContain(PASEO_HINT)
    expect(body).not.toContain("| Network |")
    expect(body.endsWith(MARKER)).toBe(true)
  })
  it("a previewnet deploy shows its row and how to get paseo", () => {
    const body = renderDeployComment({ ...base, planned: ["preview"], results: [PREVIEW] })!
    expect(body).toContain("| Previewnet | `my-game-pr7-sandbox00.testnet` | https://my-game-pr7-sandbox00.testnet.li |")
    expect(body).toContain(PASEO_HINT)
    expect(body).not.toContain(NO_PREVIEW)
  })
  it("late deploy-paseo keeps the previewnet row", () => {
    const previous = renderDeployComment({ ...base, planned: ["preview"], results: [PREVIEW] })!
    const body = renderDeployComment({ ...base, planned: ["paseo-next-v2"], results: [PASEO], previous })!
    expect(body).toContain("| Previewnet |")
    expect(body).toContain("| Paseo | `my-game-pr7-sandbox00.paseo` | https://my-game-pr7-sandbox00.paseo.li |")
    expect(body).not.toContain("did not publish")
    expect(body).not.toContain(NO_PREVIEW)
    expect(body).not.toContain(PASEO_HINT)
  })
  it("late deploy-paseo on a PR whose previewnet skipped keeps the skip line", () => {
    const previous = renderDeployComment({ ...base, planned: ["preview"], results: [SKIPPED] })!
    const body = renderDeployComment({ ...base, planned: ["paseo-next-v2"], results: [PASEO], previous })!
    expect(body).toContain("| Paseo |")
    expect(body).toContain(NO_PREVIEW)
  })
  it("a planned leg that published nothing says so", () => {
    const body = renderDeployComment({ ...base, planned: ["preview", "paseo-next-v2"], results: [PREVIEW, { ...PASEO, cid: "" }] })!
    expect(body).toContain("Paseo did not publish. See the run logs.")
  })
  it("legs ran and none published: leave the comment alone", () => {
    expect(renderDeployComment({ ...base, planned: ["preview"], results: [] })).toBeNull()
  })
  it("a gated Previewnet beside a Paseo deploy shows the Paseo row and the skip line", () => {
    const body = renderDeployComment({ ...base, planned: ["preview", "paseo-next-v2"], results: [SKIPPED, PASEO] })!
    expect(body).toContain("| Paseo |")
    expect(body).toContain(NO_PREVIEW)
    expect(body).not.toContain("did not publish")
  })
  it("a planned leg replaces its old row, never duplicates it", () => {
    const previous = renderDeployComment({ ...base, planned: ["preview"], results: [{ ...PREVIEW, domain: "old.testnet" }] })!
    const body = renderDeployComment({ ...base, planned: ["preview"], results: [PREVIEW], previous })!
    expect(body).not.toContain("old.testnet")
    expect(body.match(/\| Previewnet \|/g)).toHaveLength(1)
  })
})

describe("rowsOf", () => {
  it("reads back the rows this module wrote, keyed by env", () => {
    const body = renderDeployComment({ ...base, planned: ["preview", "paseo-next-v2"], results: [PREVIEW, PASEO] })!
    expect([...rowsOf(body).keys()].sort()).toEqual(["paseo-next-v2", "preview"])
    expect(rowsOf("").size).toBe(0)
  })
})
