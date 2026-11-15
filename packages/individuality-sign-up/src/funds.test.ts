// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { formatAmount, shortfall } from "./funds"

describe("formatAmount", () => {
  it("prints whole tokens without a fraction", () => {
    expect(formatAmount(20_000_000_000n, 10, "PAS")).toBe("2 PAS")
    expect(formatAmount(0n, 10, "PAS")).toBe("0 PAS")
  })
  it("trims trailing zeros and caps the fraction", () => {
    expect(formatAmount(25_000_000_000n, 10, "PAS")).toBe("2.5 PAS")
    expect(formatAmount(20_123_456_789n, 10, "PAS")).toBe("2.0123 PAS")
    expect(formatAmount(1_000_000n, 10, "PAS")).toBe("0.0001 PAS")
  })
  it("rounds nothing below the cap away silently into a bare integer", () => {
    // 0.00001 PAS shows as 0 PAS with a 4-digit cap — the caller picks the cap
    expect(formatAmount(100_000n, 10, "PAS")).toBe("0 PAS")
    expect(formatAmount(100_000n, 10, "PAS", 6)).toBe("0.00001 PAS")
  })
})

describe("shortfall", () => {
  const funds = { deposit: 20_000_000_000n, required: 20_400_000_000n, decimals: 10, symbol: "PAS" }
  it("is what is missing, never negative", () => {
    expect(shortfall({ ...funds, free: 0n })).toBe(20_400_000_000n)
    expect(shortfall({ ...funds, free: 20_000_000_000n })).toBe(400_000_000n)
    expect(shortfall({ ...funds, free: 30_000_000_000n })).toBe(0n)
  })
})
