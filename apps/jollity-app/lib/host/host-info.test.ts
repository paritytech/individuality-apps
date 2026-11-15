// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, describe, expect, it, vi } from "vitest"

const sdk = vi.hoisted(() => ({ api: null as unknown }))
vi.mock("@parity/product-sdk-host", () => ({ getTruApi: async () => sdk.api }))

import { readHostInfo, readHostInfoResult } from "./host-info"

afterEach(() => vi.useRealTimers())

const ok = (value: unknown) => ({ system: { info: async () => ({ isOk: () => true, value }) } })

describe("readHostInfo", () => {
  it("returns the host's platform, name and version", async () => {
    sdk.api = ok({ platform: "Android", name: "Polkadot Mobile", version: "1.4.2" })
    expect(await readHostInfo()).toEqual({ platform: "Android", name: "Polkadot Mobile", version: "1.4.2" })
  })
  it("preserves a current host that sends no version", async () => {
    sdk.api = ok({ platform: "Android", name: "Polkadot Mobile" })
    expect(await readHostInfo()).toEqual({ platform: "Android", name: "Polkadot Mobile", version: "" })
  })
  it("is null with no host, an error result, or a throw", async () => {
    sdk.api = null
    expect(await readHostInfo()).toBeNull()
    sdk.api = { system: { info: async () => ({ isOk: () => false }) } }
    expect(await readHostInfo()).toBeNull()
    sdk.api = {
      system: {
        info: async () => {
          throw new Error("x")
        },
      },
    }
    expect(await readHostInfo()).toBeNull()
  })
  it("distinguishes an unavailable host from a failed version read", async () => {
    sdk.api = null
    expect(await readHostInfoResult()).toEqual({ info: null, failed: false })
    sdk.api = { system: { info: async () => ({ isOk: () => false, error: new Error("no info") }) } }
    expect(await readHostInfoResult()).toEqual({ info: null, failed: true })
  })
  it("reports a host older than truapi 0.27 by a fixed version", async () => {
    sdk.api = {
      system: {
        info: async () => {
          throw new RangeError("Offset is outside the bounds of the DataView")
        },
      },
    }
    expect(await readHostInfoResult()).toEqual({ info: { platform: "", name: "", version: "older than truapi 0.27" }, failed: false })
  })
  it("gives up after a second", async () => {
    vi.useFakeTimers()
    sdk.api = { system: { info: () => new Promise(() => {}) } }
    const pending = readHostInfo()
    await vi.advanceTimersByTimeAsync(1100)
    expect(await pending).toBeNull()
  })
})
