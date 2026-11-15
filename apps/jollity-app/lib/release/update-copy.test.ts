// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { updateInstruction, updatePlatform } from "./update-copy"

describe("update instruction", () => {
  it.each([
    ["iOS", "ios"],
    ["ios", "ios"],
    ["iPadOS", "ios"],
    ["Android", "android"],
    ["linux", "other"],
    ["", "other"],
    [undefined, "other"],
    [null, "other"],
  ] as const)("platform %s reads as %s", (raw, expected) => {
    expect(updatePlatform(raw)).toBe(expected)
  })

  it("says the right thing per platform, and never offers a reload", () => {
    expect(updateInstruction("ios")).toBe("Close Jollity with the × at the top and open it again.")
    expect(updateInstruction("android")).toBe("Close the Polkadot app completely and open it again.")
    expect(updateInstruction("other")).toBe("Restart the app to update.")
    for (const p of ["ios", "android", "other"] as const) expect(updateInstruction(p).toLowerCase()).not.toContain("reload")
  })
})
