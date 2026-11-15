// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { DEFAULT_RARITIES, compareRarities, parseRarities, rarityName } from "./rarity"

describe("Scarcity-shaped rarity contracts", () => {
  it("parses trimmed numeric levels and lets later duplicates win", () => {
    expect([
      ...parseRarities(
        " 200 = Rare,100= Common=ignored,200=Very Rare,bad=Nope,300=,=Missing,-1=Ghost,1e2=Nope,0x64=Nope ",
      ),
    ]).toEqual([
      [200, "Very Rare"],
      [100, "Common"],
    ])
  })

  it("resolves numeric values through the effective table and keeps named legacy values", () => {
    const rarities = parseRarities("100=Common,200=Rare")
    expect(rarityName(100, rarities)).toBe("Common")
    expect(rarityName(" 200 ", rarities)).toBe("Rare")
    expect(rarityName(999, rarities)).toBeUndefined()
    expect(rarityName(" Mythic ", rarities)).toBe("Mythic")
    expect(rarityName("", rarities)).toBeUndefined()
  })

  it("compares known names by numeric level without inventing an order for unknown names", () => {
    const rarities = parseRarities("300=Rare,100=Common,200=Uncommon")
    expect(compareRarities("rare", "Common", rarities)).toBe(200)
    expect(compareRarities("COMMON", "uncommon", rarities)).toBe(-100)
    expect(compareRarities("Mythic", "Common", rarities)).toBe(0)
  })

  it("exports Scarcity's fallback table", () => {
    expect(DEFAULT_RARITIES).toBe("100=common,200=uncommon,300=rare,400=legendary")
  })
})
