// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { applyRemap, planRemap } from "./remap-plan"

describe("planRemap", () => {
  it("maps personas by base and regulars in order", () => {
    const { map, unusedRegular } = planRemap(["jollitypv.1", "jollylaenus.78", "jollitykcxy.61"], ["jollitypv.9", "jollitypv.8", "jollitypv.7"], { jollylaenus: "jollylaenus.48" })
    expect(map).toEqual({ "jollitypv.1": "jollitypv.9", "jollylaenus.78": "jollylaenus.48", "jollitykcxy.61": "jollitypv.8" })
    expect(unusedRegular).toEqual(["jollitypv.7"])
  })
  it("refuses a pool that is too small", () => {
    expect(() => planRemap(["a.1", "b.2"], ["jollitypv.9"], {})).toThrow(/too small/)
  })
})

describe("applyRemap", () => {
  it("rewrites in one pass even when a new name is another old name", () => {
    const map = { "jollitypv.47": "jollitypv.66", "jollitypv.66": "jollitypv.12" }
    expect(applyRemap('"jollitypv.47" "jollitypv.66"', map)).toBe('"jollitypv.66" "jollitypv.12"')
  })
  it("leaves longer names and other networks alone", () => {
    const map = { "jollystorm.67": "jollystorm.90" }
    expect(applyRemap("jollystorm.670 xjollystorm.67 jollystorm.61 jollystorm.67", map)).toBe("jollystorm.670 xjollystorm.67 jollystorm.61 jollystorm.90")
  })
})
