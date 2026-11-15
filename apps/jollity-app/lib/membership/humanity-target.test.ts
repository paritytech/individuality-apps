// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, describe, expect, it, vi } from "vitest"

const host = vi.hoisted(() => ({ opened: [] as string[], fail: false, order: [] as string[] }))
vi.mock("../host/navigate", () => ({
  openLink: async (url: string) => {
    host.order.push("navigate")
    host.opened.push(url)
    if (host.fail) throw new Error("navigateTo refused")
  },
}))
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
  traced.calls = []
  vi.unstubAllGlobals()
})

describe("the hand-off at the end of the game", () => {
  it("names the Humanity card the hosts pin, on the network the build is served from", () => {
    expect(humanityCardLink("dim2.paseo")).toBe("polkadotapp://pocket/open?product=peopl.paseo&card=humanity")
    expect(humanityCardLink("dim2.test")).toBe("polkadotapp://pocket/open?product=peopl.test&card=humanity")
  })

  const ANDROID = "Mozilla/5.0 (Linux; Android 16; Pixel 7 Build/BP2A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/141.0.0.0 Mobile Safari/537.36"
  const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148"
  const MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15"

  it("sends Android and iOS to the card, and a host with no Pocket to the Humanity product", () => {
    const card = "polkadotapp://pocket/open?product=peopl.paseo&card=humanity"
    expect(humanityHandOff(ANDROID, 5, "dim2.paseo")).toBe(card)
    expect(humanityHandOff(IPHONE, 5, "dim2.paseo")).toBe(card)
    expect(humanityHandOff(MAC, 5, "dim2.paseo")).toBe(card) // an iPad asking for the desktop site
    expect(humanityHandOff(MAC, 0, "dim2.paseo")).toBe("https://peopl.paseo") // a Mac
    expect(humanityHandOff("", 0, "dim2.paseo")).toBe("https://peopl.paseo")
  })

  it("asks the Android host to open that card in Pocket", async () => {
    vi.stubGlobal("navigator", { userAgent: ANDROID, maxTouchPoints: 5 })
    await openHumanity()
    expect(host.opened).toEqual([expect.stringMatching(/^polkadotapp:\/\/pocket\/open\?product=peopl\.[a-z]+&card=humanity$/)])
  })

  it("asks the iOS host to open that card in Pocket", async () => {
    vi.stubGlobal("navigator", { userAgent: IPHONE, maxTouchPoints: 5 })
    await openHumanity()
    expect(host.opened).toEqual([expect.stringMatching(/^polkadotapp:\/\/pocket\/open\?product=peopl\.[a-z]+&card=humanity$/)])
  })

  it("asks a host with no Pocket to open the Humanity product", async () => {
    vi.stubGlobal("navigator", { userAgent: MAC, maxTouchPoints: 0 })
    await openHumanity()
    expect(host.opened).toEqual([expect.stringMatching(/^https:\/\/peopl\.[a-z]+$/)])
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
