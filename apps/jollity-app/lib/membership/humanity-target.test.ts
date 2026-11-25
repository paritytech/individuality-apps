// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, describe, expect, it, vi } from "vitest"

const host = vi.hoisted(() => ({
  opened: [] as string[],
  fail: false,
  order: [] as string[],
  info: null as { platform: string; name: string; version: string } | null,
}))
vi.mock("../host/navigate", () => ({
  openLink: async (url: string) => {
    host.order.push("navigate")
    host.opened.push(url)
    if (host.fail) throw new Error("navigateTo refused")
  },
}))
vi.mock("../host/host-info", () => ({ readHostInfo: async () => host.info }))
const traced = vi.hoisted(() => ({ calls: [] as unknown[] }))
vi.mock("../journeys/game-trace", () => ({ humanityRequested: (facts: unknown) => {
  host.order.push("trace")
  traced.calls.push(facts)
} }))
vi.mock("../start-over", () => ({
  leavingForProduct: () => host.order.push("leave"),
  stayedInProduct: () => host.order.push("stay"),
}))

import { humanityCardLink, humanityHandOff, openHumanity } from "./humanity-target"

afterEach(() => {
  host.opened = []
  host.fail = false
  host.order = []
  host.info = null
  traced.calls = []
  vi.unstubAllGlobals()
})

describe("the hand-off at the end of the game", () => {
  const CARD = "polkadotapp://pocket/open?product=peopl.paseo&card=humanity"
  const PRODUCT = "https://peopl.paseo"
  const POLKADOT_APP = { platform: "ios", name: "Polkadot Mobile", version: "1.4.2" }
  const DOTLI = { platform: "ios", name: "Polkadot Web", version: "0.9.0" }

  it("names the Humanity card the hosts pin, on the network the build is for", () => {
    expect(humanityCardLink()).toBe(CARD)
  })

  const ANDROID = "Mozilla/5.0 (Linux; Android 16; Pixel 7 Build/BP2A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/141.0.0.0 Mobile Safari/537.36"
  const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148"
  const MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15"

  it("sends Android and iOS to the card, and a host with no Pocket to the Humanity product", () => {
    expect(humanityHandOff(ANDROID, 5)).toBe(CARD)
    expect(humanityHandOff(IPHONE, 5, POLKADOT_APP.name)).toBe(CARD)
    expect(humanityHandOff(MAC, 5)).toBe(CARD) // an iPad asking for the desktop site
    expect(humanityHandOff(MAC, 0)).toBe(PRODUCT) // a Mac
    expect(humanityHandOff("", 0)).toBe(PRODUCT)
  })

  it("sends a phone on the web host to the Humanity product, which it opens by link", () => {
    expect(humanityHandOff(IPHONE, 5, DOTLI.name)).toBe(PRODUCT)
    expect(humanityHandOff(ANDROID, 5, DOTLI.name)).toBe(PRODUCT)
  })

  it("asks the Android host to open that card in Pocket", async () => {
    vi.stubGlobal("navigator", { userAgent: ANDROID, maxTouchPoints: 5 })
    host.info = { ...POLKADOT_APP, platform: "android" }
    await openHumanity()
    expect(host.opened).toEqual([CARD])
  })

  it("asks the iOS host to open that card in Pocket", async () => {
    vi.stubGlobal("navigator", { userAgent: IPHONE, maxTouchPoints: 5 })
    host.info = POLKADOT_APP
    await openHumanity()
    expect(host.opened).toEqual([CARD])
  })

  it("asks a host with no Pocket to open the Humanity product", async () => {
    vi.stubGlobal("navigator", { userAgent: MAC, maxTouchPoints: 0 })
    await openHumanity()
    expect(host.opened).toEqual([PRODUCT])
  })

  it("opens the Humanity product of the build's network on dot.li, from a desktop or a phone", async () => {
    // dot.li serves the game under its own domain, whose last label is no DotNS TLD
    vi.stubGlobal("location", { hostname: "dim2.app.paseo.li" })
    host.info = DOTLI
    vi.stubGlobal("navigator", { userAgent: MAC, maxTouchPoints: 0 })
    await openHumanity()
    vi.stubGlobal("navigator", { userAgent: IPHONE, maxTouchPoints: 5 })
    await openHumanity()
    expect(host.opened).toEqual([PRODUCT, PRODUCT])
  })

  it("records the card on a phone and the product elsewhere before asking the host to navigate", async () => {
    vi.stubGlobal("navigator", { userAgent: IPHONE, maxTouchPoints: 5 })
    await openHumanity()
    vi.stubGlobal("navigator", { userAgent: MAC, maxTouchPoints: 0 })
    await openHumanity()
    expect(traced.calls).toEqual([
      { target: "card" },
      { target: "product" },
    ])
    // the hand-off is marked before the host can tear the page down (#465)
    expect(host.order).toEqual(["trace", "leave", "navigate", "trace", "leave", "navigate"])
  })

  it("records the request even when navigation rejects, and still rejects as before", async () => {
    vi.stubGlobal("navigator", { userAgent: ANDROID, maxTouchPoints: 5 })
    host.fail = true
    await expect(openHumanity()).rejects.toThrow("navigateTo refused")
    expect(traced.calls).toEqual([{ target: "card" }])
    // still here: coming back to the page is not a return from Humanity
    expect(host.order).toEqual(["trace", "leave", "navigate", "stay"])
  })
})
