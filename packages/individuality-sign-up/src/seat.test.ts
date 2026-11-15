// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { namedSeat, SeatUnfundedError } from "./seat"

describe("namedSeat — the name link on top of the SDK's seat", () => {
  it("holds every route while the name link is on its way", () => {
    expect(namedSeat({ path: "deposit", ready: true }, false)).toEqual({ path: "deposit", ready: false })
    expect(namedSeat({ path: "returning", ready: true }, false)).toEqual({ path: "returning", ready: false })
  })

  it("leaves the seat as the SDK decided it once linked, or with no name gate", () => {
    expect(namedSeat({ path: "free", ready: true }, true)).toEqual({ path: "free", ready: true })
    expect(namedSeat({ path: "free", ready: false }, undefined)).toEqual({ path: "free", ready: false })
  })
})

describe("SeatUnfundedError", () => {
  it("says how much the account holds of what the deposit route needs", () => {
    const error = new SeatUnfundedError(2020n, 10n)
    expect(error.message).toBe("account holds 10 of the 2020 the deposit route needs")
    expect([error.required, error.free]).toEqual([2020n, 10n])
  })
})
