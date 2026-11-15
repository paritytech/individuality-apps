// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { PRIZE_UNIT, prizeAmount, prizeLabel, splitPrizeUnit } from "./prize-unit"

describe("the prize as the player reads it", () => {
  it("shows dollars, whole when whole and to the cent when not", () => {
    expect(prizeAmount(10)).toBe("$10")
    expect(prizeAmount(10.5)).toBe("$10.50")
    expect(prizeLabel(200)).toBe(`$200 ${PRIZE_UNIT}`)
  })

  it("sets apart the unit where it stands alone", () => {
    expect(splitPrizeUnit("Claim $10 CASH", "CASH")).toEqual([
      { text: "Claim $10 ", unit: false },
      { text: "CASH", unit: true },
    ])
    expect(splitPrizeUnit("this $10 CASH prize would be yours.", "CASH")).toEqual([
      { text: "this $10 ", unit: false },
      { text: "CASH", unit: true },
      { text: " prize would be yours.", unit: false },
    ])
  })

  it("leaves a word that only contains the unit whole", () => {
    expect(splitPrizeUnit("CASHBACK and PETTYCASH", "CASH")).toEqual([{ text: "CASHBACK and PETTYCASH", unit: false }])
    expect(splitPrizeUnit("no prize here", "CASH")).toEqual([{ text: "no prize here", unit: false }])
  })
})
