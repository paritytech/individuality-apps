// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { LAYER_COPY, layerCopy, noticeHeadline } from "./copy"
import type { Layer } from "@jollity/statement-core"

const LAYERS = Object.keys(LAYER_COPY) as Layer[]

// `Record<Layer, LayerCopy>` already makes a MISSING layer a compile error, so
// these test what the type cannot: that the words themselves keep the two
// rules this file exists to enforce.
describe("layer copy", () => {
  it("gives every rung a name and a headline", () => {
    for (const layer of LAYERS) {
      expect(LAYER_COPY[layer].name.length, layer).toBeGreaterThan(0)
      expect(noticeHeadline(layer).length, layer).toBeGreaterThan(0)
    }
  })

  // RULE 1 — never blame the internet for a publish failure. This is the exact
  // bug being fixed: /connection-help told a player whose statement store had
  // refused their writes to move closer to their router, which was wrong in
  // every word. A copy edit that reintroduced it would be invisible in review.
  it("never blames the network for a store or camera failure", () => {
    const networkWords = /\b(internet|router|wi-?fi|hotspot|network|signal|online)\b/i
    for (const layer of ["store-write", "store-read", "media", "camera"] as const) {
      const text = [LAYER_COPY[layer].headline, ...LAYER_COPY[layer].fixes].join(" ")
      expect(networkWords.test(text), `${layer} copy blames the network: ${text}`).toBe(false)
    }
  })

  it("keeps the network advice on the rungs it is actually true for", () => {
    // the four lines that used to be shown to everyone belong here, and only here
    expect(LAYER_COPY.ice.fixes.join(" ")).toMatch(/router/i)
    expect(LAYER_COPY.internet.fixes.join(" ")).toMatch(/Wi-Fi|mobile data/i)
  })

  it("tells a player with no direct or relay path to change networks", () => {
    expect(LAYER_COPY["turn-credentials"].headline).toMatch(/blocking the game/i)
    expect(LAYER_COPY["turn-credentials"].fixes.join(" ")).toMatch(/mobile data|hotspot/i)
    expect(LAYER_COPY["turn-credentials"].fixes.join(" ")).toMatch(/reconnect/i)
  })

  it("names Wi-Fi only when the browser exposes that network type", () => {
    const wifi = layerCopy("turn-credentials", "wifi")
    expect(wifi.headline).toBe(
      "Your Wi-Fi is blocking the game. Switch to mobile data.",
    )
    expect(wifi.fixes[0]).toBe("Switch to mobile data.")
    const cellular = layerCopy("turn-credentials", "cellular")
    expect(cellular.headline).toMatch(
      /If you're on Wi-Fi, switch to mobile data/,
    )
    expect(cellular.fixes[0]).toBe("If you're on Wi-Fi, switch to mobile data.")
    expect(layerCopy("turn-credentials", undefined).headline).toMatch(
      /If you're on Wi-Fi, switch to mobile data/,
    )
  })

  it("tells a player whose own key is missing that it isn't their internet, in plain words", () => {
    expect(noticeHeadline("own-key")).toBe("Video can't start for you in this game. It isn't your internet.")
    expect(LAYER_COPY["own-key"].name).toBe("Setting up your video")
    expect(LAYER_COPY["own-key"].fixes).toEqual(["Keep the game open. If this clears up, your video starts by itself."])
    const text = [LAYER_COPY["own-key"].name, LAYER_COPY["own-key"].headline, ...LAYER_COPY["own-key"].fixes].join(" ")
    // nothing technical, and no advice that cannot help: the app asks again by itself
    expect(text).not.toMatch(/\b(key|chain|record|storage|sign-?up|grant|network|wi-?fi|mobile data|rejoin|leave)\b/i)
  })

  it("never leaks an internal rung id into what a player reads", () => {
    // only the hyphenated ids: "internet" and "media" are ordinary English and
    // a player reading them is reading words, not jargon
    const jargon = LAYERS.filter((l) => l.includes("-"))
    for (const layer of LAYERS) {
      const text = [LAYER_COPY[layer].name, LAYER_COPY[layer].headline, ...LAYER_COPY[layer].fixes].join(" ")
      for (const id of jargon) expect(text, `${layer} leaks "${id}"`).not.toContain(id)
    }
  })
})
