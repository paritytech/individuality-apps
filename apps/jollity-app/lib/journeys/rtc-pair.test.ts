// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { formatPairId, pairAttrs } from "./rtc-pair"

describe("the pair id", () => {
  it("is g<game>:r<round>:<12 hex>, with no account in it", () => {
    const id = formatPairId(12, 2, "5Bob", "5Amy")
    expect(id).toMatch(/^g12:r2:[0-9a-f]{12}$/)
    expect(id).not.toContain("5Bob")
    expect(id).not.toContain("5Amy")
  })

  it("reads the same from both ends of one link", () => {
    expect(formatPairId(7, 1, "5Amy", "5Bob")).toBe(formatPairId(7, 1, "5Bob", "5Amy"))
  })

  it("names one link the same in every round of a game, and differently in another game or with another player", () => {
    const link = (id: string) => id.split(":")[2]
    expect(link(formatPairId(7, 1, "5Amy", "5Bob"))).toBe(link(formatPairId(7, 2, "5Amy", "5Bob")))
    expect(link(formatPairId(7, 1, "5Amy", "5Bob"))).not.toBe(link(formatPairId(8, 1, "5Amy", "5Bob")))
    expect(link(formatPairId(7, 1, "5Amy", "5Bob"))).not.toBe(link(formatPairId(7, 1, "5Amy", "5Cat")))
  })

  it("is stable across builds (a query joins ids from different versions)", () => {
    expect(formatPairId(3, 2, "5Amy", "5Bob")).toBe("g3:r2:7a4330e7cc01")
  })

  it("says g? when the game index is not known yet", () => {
    expect(formatPairId(null, 1, "5B", "5A")).toMatch(/^g\?:r1:[0-9a-f]{12}$/)
  })

  it("is an attribute for a peer once this device's own account is known, and nothing before", () => {
    expect(pairAttrs(3, null, "5Bob", 1)).toEqual({})
    expect(pairAttrs(3, "5Amy", "5Bob", 2)).toEqual({ "rtc.pair": formatPairId(3, 2, "5Bob", "5Amy") })
  })
})
