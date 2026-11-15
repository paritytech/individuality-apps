// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import type { PrizeDrawView } from "../draw/prize-draw"
import { chestFacts, drawFacts, drawUnplayable } from "./payoff-facts"

const draw = (over: Partial<PrizeDrawView>): PrizeDrawView =>
  ({
    gameIndex: 5,
    airdropIndex: 0,
    phase: "drawn",
    prizeUsd: 200,
    userTicket: "0x01",
    winningTickets: ["0x01"],
    totalEntries: 4,
    listedEntries: 4,
    won: true,
    wheel: { tickets: ["0x01"], target: "0x00", winners: 1 },
    prizeSymbol: "USDC",
    claimable: false,
    claimBlockedReason: null,
    ...over,
  }) as PrizeDrawView

describe("the draw's facts", () => {
  it("is invited when the wheel can place the ticket, with the chain's result", () => {
    expect(drawFacts({ kind: "ready", draw: draw({ won: false }) }, { ok: true, reason: null, code: null }, null)).toEqual({
      "draw.invited": "true",
      "draw.won": "false",
    })
  })
  it("is not entered without a ticket, carrying the sign-up's reason", () => {
    expect(drawFacts({ kind: "ready", draw: draw({ userTicket: "", won: false }) }, null, "no draw scheduled")).toEqual({
      "draw.invited": "false",
      "draw.reason": "not-entered",
      "draw.skipped": "no draw scheduled",
      "draw.won": "false",
    })
  })
  it("says the entries were cleared when the chain lists none", () => {
    expect(drawFacts({ kind: "ready", draw: draw({ wheel: null }) }, null, null)).toMatchObject({ "draw.invited": "false", "draw.reason": "entries-cleared" })
  })
  it("says the player is not in the listed draw", () => {
    expect(drawFacts({ kind: "ready", draw: draw({}) }, { ok: false, reason: "x", code: "not-in-draw" }, null)).toMatchObject({ "draw.reason": "not-in-draw" })
  })
  it("says there was no draw", () => {
    expect(drawFacts({ kind: "none" }, null, null)).toEqual({ "draw.invited": "false", "draw.reason": "no-draw" })
  })
})

describe("a draw the wheel cannot play", () => {
  it("is a failure only for the rule's disagreements with the chain", () => {
    expect(drawUnplayable({ ok: false, reason: "x", code: "winners-disagree" })).toBe("winners-disagree")
    expect(drawUnplayable({ ok: false, reason: "x", code: "result-disagree" })).toBe("result-disagree")
    expect(drawUnplayable({ ok: false, reason: "x", code: "not-in-draw" })).toBeNull()
    expect(drawUnplayable({ ok: true, reason: null, code: null })).toBeNull()
    expect(drawUnplayable(null)).toBeNull()
  })
})

describe("the chest's facts", () => {
  it("counts the collectables", () => {
    expect(chestFacts({ kind: "ready", gameIndex: 5, seed: "s", items: [{}, {}, {}] as never })).toEqual({
      "chest.outcome": "collectables",
      "chest.count": "3",
    })
  })
  it.each([
    [{ kind: "empty", gameIndex: 5, reason: "no-attestations" }, "no-attestations"],
    [{ kind: "empty", gameIndex: 5, reason: "absent" }, "absent"],
    [{ kind: "empty", gameIndex: 5, reason: "report-missed" }, "report-missed"],
    [{ kind: "on-the-way", gameIndex: 5 }, "on-the-way"],
    [{ kind: "restart", gameIndex: 5 }, "failed"],
  ] as const)("%o → none, %s", (state, reason) => {
    expect(chestFacts(state as never)).toEqual({ "chest.outcome": "none", "chest.reason": reason })
  })
  it("has nothing to say while loading or retrying", () => {
    expect(chestFacts({ kind: "loading" })).toBeNull()
    expect(chestFacts({ kind: "retrying", gameIndex: 5 })).toBeNull()
  })
})
