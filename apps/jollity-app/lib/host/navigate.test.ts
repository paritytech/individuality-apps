// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, describe, expect, it, vi } from "vitest"

const host = vi.hoisted(() => ({ inside: true, error: null as Error | null, opened: [] as string[] }))

vi.mock("@parity/product-sdk-host", () => ({
  isInsideContainerSync: () => host.inside,
  navigateTo: async (url: string) => {
    host.opened.push(url)
    if (host.error) throw host.error
  },
}))
vi.mock("../debug/log-store", () => ({ devLog: vi.fn() }))

import { openLink } from "./navigate"

afterEach(() => {
  host.inside = true
  host.error = null
  host.opened = []
  vi.unstubAllGlobals()
})

describe("openLink", () => {
  it("uses the host without a browser fallback when navigation resolves", async () => {
    const location = { href: "" }
    vi.stubGlobal("window", { location })
    await openLink("polkadotapp://pocket/open?product=peopl.paseo&card=humanity")
    expect(host.opened).toEqual(["polkadotapp://pocket/open?product=peopl.paseo&card=humanity"])
    expect(location.href).toBe("")
  })

  it("swallows a host refusal and falls back to the browser location", async () => {
    const location = { href: "" }
    vi.stubGlobal("window", { location })
    host.error = new Error("navigateTo refused")
    await expect(openLink("https://peopl.paseo")).resolves.toBeUndefined()
    expect(host.opened).toEqual(["https://peopl.paseo"])
    expect(location.href).toBe("https://peopl.paseo")
  })
})
