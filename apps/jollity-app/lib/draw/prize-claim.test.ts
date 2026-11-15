// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import type { PrizeDrawView } from "@/lib/draw/prize-draw"
import { ClaimError, claimClosedReason, claimFailureOf } from "./prize-claim"

describe("claimFailureOf", () => {
  it("reads the failure off a ClaimError", () => {
    expect(claimFailureOf(new ClaimError("refused", "NotWinner"))).toBe("refused")
    expect(claimFailureOf(new ClaimError("cancelled", "user rejected"))).toBe("cancelled")
  })

  it("counts anything untyped as a call that never reached the chain", () => {
    expect(claimFailureOf(new Error("no signer here"))).toBe("failed")
    expect(claimFailureOf(undefined)).toBe("failed")
  })
})

describe("claimClosedReason", () => {
  const draw = (fields: Partial<PrizeDrawView>): PrizeDrawView =>
    ({ phase: "drawn", won: true, claimed: false, claimable: false, claimBlockedReason: null, ...fields }) as PrizeDrawView

  it("names the rule the draw read says the claim breaks", () => {
    expect(claimClosedReason(draw({ phase: "over" }))).toBe("ClaimingWindowClosed")
    expect(claimClosedReason(draw({ won: false }))).toBe("NoSuchWinner")
    expect(claimClosedReason(draw({ claimBlockedReason: "below the personhood threshold" }))).toBe("NotMember")
    expect(claimClosedReason(draw({ claimBlockedReason: "the most recent attended game is 12" }))).toBe("PlayedSince")
    expect(claimClosedReason(draw({ claimBlockedReason: "not a scored participant" }))).toBe("AttendanceNotRecorded")
    expect(claimClosedReason(draw({ claimBlockedReason: "something new" }))).toBe("NotEligibleForAirdrop")
  })
})

describe("a winner who did not attend the game", () => {
  const draw = (reason: string): PrizeDrawView =>
    ({ gameIndex: 12, phase: "drawn", won: true, claimed: false, claimable: false, claimBlockedReason: reason }) as PrizeDrawView

  it("is told the game didn't count, not that they played another since", () => {
    expect(claimClosedReason(draw("most recent attended game is #11"))).toBe("NotAttended")
    expect(claimClosedReason(draw("most recent attended game is #13"))).toBe("PlayedSince")
  })
})
