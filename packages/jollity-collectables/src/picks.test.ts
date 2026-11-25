// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { collectablesValue, collectionFor, defaultCollectionFor, indexFor, parseCollectablesPicks } from "./picks"

const HASH = "0123456789abcdef".repeat(4)

describe("Scarcity-shaped pick wire contract", () => {
  it("normalizes valid hashes and rejects loose collection ids", () => {
    const parsed = parseCollectablesPicks({
      [` 0X${HASH.toUpperCase()} `]: { collectionId: 0 },
      [`0x${"a".repeat(64)}`]: { collectionId: 19 },
      [`0x${"b".repeat(64)}`]: { collectionId: -1 },
      [`0x${"c".repeat(64)}`]: { collectionId: 1.5 },
      [`0x${"d".repeat(64)}`]: { collectionId: "18" },
      "0x1234": { collectionId: 17 },
    })
    expect([...parsed]).toEqual([
      [HASH, 0],
      ["a".repeat(64), 19],
    ])
  })

  it("lets the last duplicate normalized hash win", () => {
    expect([...parseCollectablesPicks({ [HASH]: { collectionId: 17 }, [`0x${HASH}`]: { collectionId: 18 } })]).toEqual([
      [HASH, 18],
    ])
  })

  it("serializes canonical prefixed keys for Scarcity", () => {
    expect(collectablesValue(new Map([[HASH, 18]]))).toEqual({ [`0x${HASH}`]: { collectionId: 18 } })
  })
})

describe("Scarcity-shaped default selection", () => {
  it("folds only the first eight hash bytes with unsigned 32-bit arithmetic", () => {
    const sameFirstEight = `${HASH.slice(0, 16)}${"f".repeat(48)}`
    expect(indexFor(HASH, 3)).toBe(indexFor(sameFirstEight, 3))
    expect(indexFor("ff".repeat(32), 3)).toBeGreaterThanOrEqual(0)
    expect(indexFor("ff".repeat(32), 3)).toBeLessThan(3)
    expect(indexFor("ff".repeat(32), 3)).toBe(2)
  })

  it("uses the supplied ordered offered snapshot", () => {
    expect(defaultCollectionFor(HASH, [17, 18, 19])).toBe([17, 18, 19][indexFor(HASH, 3)])
    expect(defaultCollectionFor(HASH, [])).toBeUndefined()
  })

  it("uses swap, Jollity, favourite, then the deterministic default", () => {
    const offered = [17, 18, 19]
    expect(collectionFor(HASH, offered, { swap: 19, jollity: 18, favourite: 17 })).toBe(19)
    expect(collectionFor(HASH, offered, { swap: 99, jollity: 18, favourite: 17 })).toBe(18)
    expect(collectionFor(HASH, offered, { swap: 99, jollity: 98, favourite: 17 })).toBe(17)
    expect(collectionFor(HASH, offered, { swap: 99, jollity: 98, favourite: 97 })).toBe(
      defaultCollectionFor(HASH, offered),
    )
  })
})
