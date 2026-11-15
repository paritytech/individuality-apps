// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { drawTicketCanPay, gamesToMembership, type ScoreStanding } from "./draw-ticket"

const candidate = (score: number, streak: ScoreStanding["streak"]): ScoreStanding => ({
  score,
  streak,
  recognition: { type: "NotRecognized" },
  reached_personhood: false,
})

describe("gamesToMembership", () => {
  it("counts the wins a run adds, from no row at all", () => {
    // a new player at threshold 3: the first game adds 1, the second 2
    expect(gamesToMembership(undefined, 3)).toBe(2)
    expect(gamesToMembership(candidate(1, { type: "Attended", count: 1 }), 3)).toBe(1)
    // an absence starts the run again
    expect(gamesToMembership(candidate(1, { type: "Absent", count: 2 }), 3)).toBe(2)
    expect(gamesToMembership(candidate(3, { type: "Absent", count: 1 }), 3)).toBe(0)
  })
})

describe("drawTicketCanPay (#167)", () => {
  it("leaves out a candidate this game cannot make a member", () => {
    expect(drawTicketCanPay(undefined, 3)).toBe(false)
    expect(drawTicketCanPay(candidate(0, { type: "Absent", count: 1 }), 3)).toBe(false)
  })

  it("gives a ticket to a candidate this game can make a member", () => {
    expect(drawTicketCanPay(candidate(1, { type: "Attended", count: 1 }), 3)).toBe(true)
  })

  it("gives a ticket to anyone recognized or past personhood, whatever the score", () => {
    expect(drawTicketCanPay({ ...candidate(0, { type: "Absent", count: 4 }), reached_personhood: true }, 3)).toBe(true)
    for (const type of ["Recognized", "ExternallyRecognized"] as const)
      expect(drawTicketCanPay({ ...candidate(0, { type: "Absent", count: 4 }), recognition: { type } }, 3), type).toBe(true)
  })

  it("judges a suspended player by the score, as the claim does", () => {
    const suspended = (row: ScoreStanding): ScoreStanding => ({ ...row, recognition: { type: "Suspended" } })
    expect(drawTicketCanPay(suspended(candidate(0, { type: "Absent", count: 4 })), 3)).toBe(false)
    expect(drawTicketCanPay(suspended(candidate(1, { type: "Attended", count: 1 })), 3)).toBe(true)
    expect(drawTicketCanPay({ ...suspended(candidate(0, { type: "Absent", count: 4 })), reached_personhood: true }, 3)).toBe(true)
  })
})
