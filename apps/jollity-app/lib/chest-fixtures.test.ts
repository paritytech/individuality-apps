// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { getApprovedCollections } from "@parity/product-sdk-nfts"
import { NETWORK_CONFIG } from "@jollity/protocol"
import { FIXTURE_COLLECTIONS, FIXTURE_SOURCE } from "./chest-fixtures"

describe("chain-derived chest fixtures", () => {
  it("is pinned to Paseo and exactly the collections the SDK approves, in id order", () => {
    expect(FIXTURE_SOURCE).toMatchObject({
      network: "paseo",
      genesisHash: NETWORK_CONFIG.paseo.genesis!.hubNextV2,
    })
    expect(FIXTURE_SOURCE.blockNumber).toBeGreaterThan(0)
    expect(FIXTURE_SOURCE.blockHash).toMatch(/^0x[0-9a-f]{64}$/)
    expect(FIXTURE_COLLECTIONS.map(({ id }) => id)).toEqual([...getApprovedCollections("paseo")].sort((a, b) => a - b))
  })

  it("keeps one decoded common and rare example from every collection", () => {
    for (const collection of FIXTURE_COLLECTIONS) {
      expect(collection.items.map(({ rarity }) => rarity)).toEqual(["common", "rare"])
      for (const item of collection.items) {
        expect(item.index).toBeGreaterThanOrEqual(0)
        expect(item.archetype).not.toBe("")
        expect(item.tier).not.toBe("")
        expect(item.manifest).toMatch(/^b[a-z2-7]+$/)
        expect(item.thumbnail).toMatch(/^b[a-z2-7]+$/)
      }
    }
  })
})
