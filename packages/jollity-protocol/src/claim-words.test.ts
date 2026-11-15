// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { CLAIM_REFUSALS } from "@individuality/prize"
import { claimRefusalWords } from "./claim-words"

describe("claimRefusalWords", () => {
  it("names each refusal of the chain in its own words", () => {
    expect(claimRefusalWords("NotEligibleForAirdrop")).toBe("Only a member can claim this prize, before playing another game.")
    expect(claimRefusalWords("NoSuchWinner")).toBe("This ticket didn't win this draw.")
    expect(claimRefusalWords("ClaimingWindowClosed")).toBe("The claim window for this prize has closed.")
    expect(claimRefusalWords("AssetNotEnabled")).toBe("This prize isn't being paid out right now.")
    expect(claimRefusalWords("PlayedSince")).toBe("You've played another game since, so this prize can no longer be claimed.")
    expect(claimRefusalWords("Call")).toBe("This account didn't play this game, so it can't claim this prize.")
    expect(claimRefusalWords("Frozen")).toBe("The prize couldn't be paid into your account.")
    for (const error of CLAIM_REFUSALS) expect(claimRefusalWords(error)).not.toBe("This prize can't be claimed.")
  })

  it("falls back for an error it does not know", () => {
    expect(claimRefusalWords("BadOrigin")).toBe("This prize can't be claimed.")
  })
})
