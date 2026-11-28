// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it, vi } from "vitest"
import { acceptBuildRefresh, buildRefreshHandled, buildRefreshNote, buildRefreshTrigger, isPrPreviewApp, previewRefreshDue, requestBuildRefresh, type BuildRefreshResult } from "./build-refresh"

const here = dirname(fileURLToPath(import.meta.url))

const result = (status: "updated" | "unchanged", from = "bafyold", to = status === "updated" ? "bafynew" : from): BuildRefreshResult => ({
  status,
  from: { app: "dim2.testnet", product: "dim2.testnet", cid: from, version: "a".repeat(64), files: 10 },
  to: { app: "dim2.testnet", product: "dim2.testnet", cid: to, version: "b".repeat(64), files: 11 },
  seconds: 2.345,
})

describe("waiting-room build refresh", () => {
  it("recognizes only PR preview app names", () => {
    expect(isPrPreviewApp("dim2-pr961-sandbox00.testnet")).toBe(true)
    for (const app of ["dim2.testnet", "dim2.paseo", "local", "dim2-prx-sandbox00.testnet"]) expect(isPrPreviewApp(app)).toBe(false)
  })

  it("re-resolves previews on a bounded cadence and stops before handover", () => {
    expect(previewRefreshDue(100_000, 0, 300_000)).toBe(true)
    expect(previewRefreshDue(110_000, 100_000, 300_000)).toBe(false)
    expect(previewRefreshDue(131_000, 100_000, 300_000)).toBe(true)
    expect(previewRefreshDue(270_000, 100_000, 300_000)).toBe(true)
    expect(previewRefreshDue(270_001, 100_000, 300_000)).toBe(false)
  })

  it("never suppresses an app update message with preview timing rules", () => {
    for (const app of ["dim2.testnet", "dim2-pr961-sandbox00.testnet"]) {
      const trigger = buildRefreshTrigger({ updateVisible: true, app, nowMs: 400_000, lastAttemptMs: 399_999, handoverMs: 300_000 })
      expect(trigger).toBe("update-message")
      expect(buildRefreshHandled(trigger!, false)).toBe(true)
    }
  })

  it("uses bounded refreshes only for PR previews without an update message", () => {
    const due = buildRefreshTrigger({ updateVisible: false, app: "dim2-pr961-sandbox00.testnet", nowMs: 100_000, lastAttemptMs: 0, handoverMs: 300_000 })
    expect(due).toBe("pr-preview")
    expect(buildRefreshHandled(due!, false)).toBe(false)
    expect(buildRefreshHandled(due!, true)).toBe(true)
    expect(buildRefreshTrigger({ updateVisible: false, app: "dim2-pr961-sandbox00.testnet", nowMs: 280_000, lastAttemptMs: 0, handoverMs: 300_000 })).toBeNull()
    expect(buildRefreshTrigger({ updateVisible: false, app: "dim2.testnet", nowMs: 100_000, lastAttemptMs: 0, handoverMs: 300_000 })).toBeNull()
  })
  it("keeps the Playwright-facing refresh contract free of deployed-app's ESM-only graph", () => {
    const refreshSource = readFileSync(resolve(here, "build-refresh.ts"), "utf8")
    const journeySource = readFileSync(resolve(here, "journey.pw.ts"), "utf8")
    expect(refreshSource).not.toMatch(/from ["']\.\/deployed-app["']/)
    expect(journeySource).not.toMatch(/^import (?!type ).* from ["']\.\/deployed-app["']/m)
  })

  it("accepts one successful transition from each observed CID and writes the required evidence", () => {
    const seen = new Set<string>()
    const first = result("updated")
    expect(acceptBuildRefresh(first, seen)).toBe(first)
    expect(buildRefreshNote(4, first)).toBe("player 4 reloaded for a newer build in 2.3 s: bafyold (aaaaaaaaaaaa) -> bafynew (bbbbbbbbbbbb)")
    expect(() => acceptBuildRefresh(first, seen)).toThrow(/already reloaded from bafyold/)
    const second = result("updated", "bafynew", "bafythird")
    expect(acceptBuildRefresh(second, seen)).toBe(second)
  })

  it("does not consume the transition bound while the name still resolves the old CID", () => {
    const seen = new Set<string>()
    expect(acceptBuildRefresh(result("unchanged"), seen)).toBeNull()
    expect(seen.size).toBe(0)
  })

  it("posts to the slot-local controller, bounds the request and surfaces a bad deploy", async () => {
    const good = result("updated")
    const fetchFn = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.method).toBe("POST")
      expect(init?.signal).toBeInstanceOf(AbortSignal)
      return new Response(JSON.stringify(good), { status: 200, headers: { "content-type": "application/json" } })
    }) as unknown as typeof fetch
    await expect(requestBuildRefresh(3210, fetchFn, 50)).resolves.toEqual(good)
    expect(fetchFn).toHaveBeenCalledWith("http://127.0.0.1:3210/__e2e/refresh-build", expect.objectContaining({ method: "POST" }))

    const bad = (async () => new Response(JSON.stringify({ error: "wrong product" }), { status: 502 })) as unknown as typeof fetch
    await expect(requestBuildRefresh(3210, bad, 50)).rejects.toThrow(/refreshing the served build: wrong product/)
  })
})
