// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { prizeClaimEligibility, type ClaimStanding } from "./claim-eligibility"

const standing = (overrides: Partial<ClaimStanding> = {}): ClaimStanding => ({
  recognized: false,
  reachedPersonhood: false,
  lastAttendedGame: 7,
  ...overrides,
})

describe("who a prize claim pays", () => {
  it("pays a recognized winner, and one who reached personhood, of the game they last attended", () => {
    expect(prizeClaimEligibility(standing({ recognized: true }), 7)).toMatchObject({ eligible: true, reason: null })
    expect(prizeClaimEligibility(standing({ reachedPersonhood: true }), 7)).toMatchObject({ eligible: true, reason: null })
  })

  it("pays no candidate the chain does not count as a person yet", () => {
    expect(prizeClaimEligibility(standing(), 7)).toMatchObject({
      eligible: false,
      personhood: false,
      reason: "not recognized and below the personhood threshold",
    })
  })

  it("pays no one who played another game since, or has no score row", () => {
    expect(prizeClaimEligibility(standing({ recognized: true, lastAttendedGame: 8 }), 7)).toMatchObject({
      eligible: false,
      reason: "most recent attended game is #8",
    })
    expect(prizeClaimEligibility(undefined, 7)).toMatchObject({ eligible: false, reason: "not a scored participant yet" })
  })
})
