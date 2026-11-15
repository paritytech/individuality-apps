// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { checkWheel } from "./rule"

// game 149's draw: three tickets, the target past all of them, one winner
const T = ["0x37".padEnd(66, "0"), "0x5f".padEnd(66, "0"), "0x8c".padEnd(66, "0")]
const TARGET = "0xf2".padEnd(66, "0")
const WINNER = T[0]!

describe("checkWheel", () => {
  it("lets a player in the draw watch their own result", () => {
    expect(checkWheel({ tickets: T, target: TARGET, winners: 1, mine: WINNER, winningTickets: [WINNER], won: true }).ok).toBe(true)
  })

  it("lets a player with no ticket watch the draw, as a spectator", () => {
    expect(checkWheel({ tickets: T, target: TARGET, winners: 1, mine: "", winningTickets: [WINNER], won: false })).toEqual({ ok: true, reason: null, code: null })
  })

  it("still refuses a spectator wheel whose winners the chain does not agree with", () => {
    expect(checkWheel({ tickets: T, target: TARGET, winners: 1, mine: "", winningTickets: [T[1]!], won: false }).ok).toBe(false)
  })

  it("refuses a spectator the chain says won", () => {
    expect(checkWheel({ tickets: T, target: TARGET, winners: 1, mine: "", winningTickets: [WINNER], won: true }).ok).toBe(false)
  })

  it("names a ticket the entries do not hold", () => {
    expect(checkWheel({ tickets: T, target: TARGET, winners: 1, mine: "0x09".padEnd(66, "0"), winningTickets: [WINNER], won: false }).code).toBe("not-in-draw")
  })

  it("names winners the chain does not agree with", () => {
    expect(checkWheel({ tickets: T, target: TARGET, winners: 1, mine: WINNER, winningTickets: [T[1]!], won: false }).code).toBe("winners-disagree")
  })

  it("names a result the chain does not agree with", () => {
    expect(checkWheel({ tickets: T, target: TARGET, winners: 1, mine: WINNER, winningTickets: [WINNER], won: false }).code).toBe("result-disagree")
    expect(checkWheel({ tickets: T, target: TARGET, winners: 1, mine: "", winningTickets: [WINNER], won: true }).code).toBe("result-disagree")
  })
})
