// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { DIAL_BARS, dialDigits, litBars } from "./waiting-dial"

describe("litBars", () => {
  it("lights one bar per second of the window from twelve", () => {
    expect(litBars(60, 60)).toBe(0)
    expect(litBars(30, 60)).toBe(30)
    expect(litBars(10, 60)).toBe(50)
    expect(litBars(0, 60)).toBe(60)
  })

  it("stays in range before and after the window", () => {
    expect(litBars(61, 60)).toBe(0)
    expect(litBars(-2, 60)).toBe(60)
  })
})

describe("dialDigits", () => {
  it("shows two digits from 60 to 00", () => {
    expect(dialDigits(60, 60)).toBe("60")
    expect(dialDigits(59.4, 60)).toBe("60")
    expect(dialDigits(9.2, 60)).toBe("10")
    expect(dialDigits(9, 60)).toBe("09")
    expect(dialDigits(0.1, 60)).toBe("01")
    expect(dialDigits(0, 60)).toBe("00")
    expect(dialDigits(-2, 60)).toBe("00")
    expect(dialDigits(61, 60)).toBe("60")
  })
})

describe("DIAL_BARS", () => {
  it("has 60 bars, a major one every 5", () => {
    expect(DIAL_BARS).toHaveLength(60)
    expect(DIAL_BARS.filter((bar) => bar.width === 2.4)).toHaveLength(12)
  })
})
