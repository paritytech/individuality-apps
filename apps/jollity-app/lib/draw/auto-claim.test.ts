// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { beforeEach, describe, expect, it, vi } from "vitest"
import type { PrizeDrawView } from "./prize-draw"
import { ClaimError } from "./prize-claim"

// every way a claim ends is a line in the debug sheet: the only trace it leaves
const devLog = vi.fn()
vi.mock("../debug/log-store", () => ({ devLog }))

const { resetAutoClaimsForTest, startAutoClaim } = await import("./auto-claim")
type AutoClaimSource = import("./auto-claim").AutoClaimSource

const WON: PrizeDrawView = {
  gameIndex: 9,
  airdropIndex: 0,
  phase: "drawn",
  prizeUsd: 10,
  prizeSymbol: "pUSD",
  userTicket: "t",
  winningTickets: ["t"],
  totalEntries: 3,
  listedEntries: 3,
  won: true,
  wheel: null,
  claimed: false,
  claimable: false,
  claimBlockedReason: "not a scored participant yet",
}

/** a source whose attendance lands when `apply` is called, and whose draw
 *  read answers `after` from then on */
function source(after: Partial<PrizeDrawView>, claim: AutoClaimSource["claimPrize"] = vi.fn(async () => {})) {
  let apply!: () => void
  let refuse!: (error: unknown) => void
  const applied = new Promise<void>((resolve, reject) => {
    apply = resolve
    refuse = reject
  })
  const prizeDrawView = vi.fn(async () => [{ ...WON, ...after }])
  const src: AutoClaimSource = {
    attendanceApplied: vi.fn(() => applied),
    prizeDrawView,
    claimPrize: claim,
  }
  return { src, apply, refuse, prizeDrawView, claim }
}

/** the claim's last line in the debug sheet: its message and its data */
const logged = () => devLog.mock.calls.at(-1)?.slice(1, 3)
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
const where = { game: 9, draw: 0 }

describe("the automatic claim", () => {
  beforeEach(() => {
    resetAutoClaimsForTest()
    devLog.mockClear()
  })

  it("waits for the chain to apply the attendance, then claims what the chain would pay", async () => {
    const { src, apply, prizeDrawView, claim } = source({ claimable: true, claimBlockedReason: null })
    startAutoClaim(src, WON)
    await settle()
    expect(prizeDrawView).not.toHaveBeenCalled()

    apply()
    await settle()
    expect(claim).toHaveBeenCalledWith(9, 0)
    expect(logged()).toEqual(["claimed", where])
  })

  it("claims once, however often it is started", async () => {
    const { src, apply, claim } = source({ claimable: true, claimBlockedReason: null })
    startAutoClaim(src, WON)
    startAutoClaim(src, WON)
    apply()
    await settle()
    startAutoClaim(src, WON)
    await settle()
    expect(claim).toHaveBeenCalledTimes(1)
  })

  it("starts nothing for a draw the player did not win, or one already claimed", () => {
    const { src, claim } = source({})
    startAutoClaim(src, { ...WON, won: false })
    startAutoClaim(src, { ...WON, claimed: true })
    expect(src.attendanceApplied).not.toHaveBeenCalled()
    expect(claim).not.toHaveBeenCalled()
  })

  it("never sends a claim the chain would refuse, and logs why", async () => {
    const reason = "not recognized and below the personhood threshold"
    const { src, apply, claim } = source({ claimBlockedReason: reason })
    startAutoClaim(src, WON)
    apply()
    await settle()
    expect(claim).not.toHaveBeenCalled()
    expect(logged()).toEqual(["the chain would not pay the claim", { ...where, reason }])
  })

  it("leaves a claim that did not land to the chat, with what it failed on", async () => {
    const { src, apply } = source({ claimable: true, claimBlockedReason: null }, vi.fn(async () => {
      throw new ClaimError("refused", "ClaimingWindowClosed")
    }))
    startAutoClaim(src, WON)
    apply()
    await settle()
    expect(logged()).toEqual([
      "the automatic claim did not land: the chat has it",
      expect.objectContaining({ ...where, failure: "refused", refusal: "ClaimingWindowClosed" }),
    ])
  })

  it("gives up on a game that never settles", async () => {
    const { src, refuse, claim } = source({ claimable: true, claimBlockedReason: null })
    startAutoClaim(src, WON)
    refuse(new Error("not settled"))
    await settle()
    expect(claim).not.toHaveBeenCalled()
    expect(logged()?.[0]).toBe("the automatic claim gave up waiting for the game")
  })

  it("is left to the chat where there is no signer", () => {
    startAutoClaim({ prizeDrawView: vi.fn(async () => []) }, WON)
    expect(logged()).toEqual(["no signer here: the automatic claim is left to the chat", where])
  })

  it("sends nothing once the claim window has closed", () => {
    const { src } = source({})
    startAutoClaim(src, { ...WON, phase: "over" })
    expect(src.attendanceApplied).not.toHaveBeenCalled()
    expect(logged()).toEqual(["the claim window has closed", where])
  })
})
