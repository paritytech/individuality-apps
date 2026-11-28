// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it, vi } from "vitest"
import type { LoadedApp } from "./build-refresh"
import { appRefreshLoader, isVersionDocument, mayRefreshApp, pinnedReleaseDocument, pinnedUpdateGateWarning, pinSourceForLoad, selectAppPin } from "./app-pin"

const CID = `bafy${"a".repeat(40)}`
const loaded: LoadedApp = {
  app: "dim2.testnet",
  product: "dim2.testnet",
  cid: CID,
  version: "1".repeat(64),
  commit: "2".repeat(40),
  files: 10,
}

describe("selectAppPin", () => {
  it("uses app_cid verbatim without resolving dotNS", async () => {
    const resolve = vi.fn(async () => "resolved")
    await expect(selectAppPin("dim2.testnet", CID, resolve)).resolves.toEqual({ cid: CID, source: "input" })
    expect(resolve).not.toHaveBeenCalled()
  })

  it("keeps the existing dotNS resolution when app_cid is empty", async () => {
    const resolve = vi.fn(async () => CID)
    await expect(selectAppPin("dim2.testnet", "", resolve)).resolves.toEqual({ cid: CID, source: "resolved" })
    expect(resolve).toHaveBeenCalledWith("dim2.testnet")
  })

  it("rejects malformed, padded, or local explicit pins", async () => {
    await expect(selectAppPin("dim2.testnet", "not-a-cid", vi.fn())).rejects.toThrow(/not a CID/)
    await expect(selectAppPin("dim2.testnet", ` ${CID}`, vi.fn())).rejects.toThrow(/exact CID/)
    await expect(selectAppPin("local", CID, vi.fn())).rejects.toThrow(/app=local/)
  })
})

describe("the input-pinned release document", () => {
  it("makes the pinned build current under its own product", () => {
    expect(pinnedReleaseDocument(loaded, "input")).toEqual({
      product: "dim2.testnet",
      version: "1".repeat(64),
      body: {
        "dim2.testnet": { version: "1".repeat(64), time: 0 },
        updated: "1970-01-01T00:00:00.000Z",
      },
    })
  })

  it("does nothing for today's resolved pin or an empty input", () => {
    expect(pinnedReleaseDocument(loaded, "resolved")).toBeNull()
    expect(pinnedReleaseDocument(loaded, undefined)).toBeNull()
  })

  it("prevents a refresh from moving an input-pinned runner to another CID", () => {
    expect(mayRefreshApp({ ...loaded, pinSource: "input" })).toBe(false)
    expect(mayRefreshApp({ ...loaded, pinSource: "resolved" })).toBe(true)
    expect(mayRefreshApp(loaded)).toBe(true)
    const refresh = vi.fn(async () => loaded)
    expect(appRefreshLoader({ ...loaded, pinSource: "input" }, refresh)).toBeUndefined()
    expect(appRefreshLoader(loaded, refresh)).toBe(refresh)
  })

  it("attributes only the initial E2E_APP_CID load to the input pin", () => {
    expect(pinSourceForLoad("input", CID, undefined)).toBe("input")
    expect(pinSourceForLoad("input", CID, "new-cid")).toBeUndefined()
    expect(pinSourceForLoad("resolved", CID, undefined)).toBeUndefined()
  })

  it("diagnoses a missed release interception instead of silently timing out", () => {
    expect(pinnedUpdateGateWarning({ ...loaded, pinSource: "input" }, true)).toMatch(/interception did not take effect/)
    expect(pinnedUpdateGateWarning({ ...loaded, pinSource: "input" }, false)).toBeNull()
    expect(pinnedUpdateGateWarning(loaded, true)).toBeNull()
  })

  it("fails closed when the bundle cannot identify its own release", () => {
    expect(() => pinnedReleaseDocument({ ...loaded, version: null }, "input")).toThrow(/needs CID, product and version/)
  })

  it("matches the real version document with its cache-busting query only", () => {
    expect(isVersionDocument("https://gist.githubusercontent.com/o/id/raw/dim2-version.json?t=123")).toBe(true)
    expect(isVersionDocument("https://example.test/other.json")).toBe(false)
    expect(isVersionDocument("not a url")).toBe(false)
  })
})
