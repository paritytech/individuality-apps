// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { carry, takeCarried, CARRY_MAX_AGE_MS, TAKE_GRACE_MS, type CarriedBubble } from "./carry"

const bubble = (at: number): CarriedBubble => ({ x: 195, y: 361, r: 47, pieces: [], glint: false, at })

describe("the carried bubble", () => {
  it("is taken once", () => {
    carry(bubble(1000))
    expect(takeCarried(1100)?.x).toBe(195)
    expect(takeCarried(1100 + TAKE_GRACE_MS + 1)).toBeNull()
  })
  it("is the same for a second run of the same showing (StrictMode)", () => {
    const b = bubble(5000)
    carry(b)
    expect(takeCarried(5100)).toBe(b)
    expect(takeCarried(5100 + TAKE_GRACE_MS - 1)).toBe(b)
  })
  it("is not used when it is too old", () => {
    carry(bubble(10_000))
    expect(takeCarried(10_000 + CARRY_MAX_AGE_MS + 1)).toBeNull()
  })
  it("is nothing when nothing was carried", () => {
    expect(takeCarried(99_999)).toBeNull()
  })
})
