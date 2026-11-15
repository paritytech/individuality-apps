// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import type { PalletGame, PalletGameState, PalletReportStanding } from "@jollity/protocol"
import { reportMissed, reportStatusOf } from "./report-missed"

describe("a missed report", () => {
  it("is not missed while the chain is in Reporting, sent or not", () => {
    expect(reportMissed({ closed: false, report: "not-sent" })).toBe(false)
    expect(reportMissed({ closed: false, report: "sent" })).toBe(false)
  })
  it("is missed once the chain has left Reporting with no report", () => {
    expect(reportMissed({ closed: true, report: "not-sent" })).toBe(true)
  })
  it("is never missed on a failed read, on a record the chain no longer holds, or with the report in", () => {
    expect(reportMissed({ closed: false, report: "unknown" })).toBe(false)
    expect(reportMissed({ closed: true, report: "gone" })).toBe(false)
    expect(reportMissed({ closed: true, report: "sent" })).toBe(false)
  })
})

const game = (state: PalletGameState, index = 7): PalletGame => ({
  index,
  state,
  airdrops_scheduled: 1,
  registration_ends: 100,
  shuffle_deadline: 150,
  game_date: 200,
  report_ends: 900,
  rounds: 2,
  max_group_size: 4,
})
const REPORTING: PalletGameState = { type: "Reporting", value: { player_count: 4 } }
const PROCESS: PalletGameState = { type: "PlayerProcess" }
const standing = (over: Partial<PalletReportStanding>): PalletReportStanding => ({
  game: game(REPORTING),
  player: { registered: true, sent_report: false },
  lastAttendedGame: null,
  ...over,
})

// The pallet leaves Reporting for PlayerProcess at report_ends, or as soon as
// every attendance is decided, and step 1 then archives or resets each
// Players row, so the row's sent_report is gone. Found by a model check (#596).
describe("the report's status, read at one block", () => {
  it("in Reporting, the row says sent or not, and the window is open", () => {
    expect(reportStatusOf(standing({ player: { registered: true, sent_report: true } }), 7)).toMatchObject({
      gameIndex: 7,
      closed: false,
      report: "sent",
    })
    expect(reportStatusOf(standing({}), 7)).toMatchObject({ closed: false, report: "not-sent" })
  })

  it("past Reporting, a row step 1 has not processed yet still holds the final sent_report", () => {
    expect(reportStatusOf(standing({ game: game(PROCESS) }), 7)).toMatchObject({ closed: true, report: "not-sent" })
    expect(
      reportStatusOf(standing({ game: game(PROCESS), player: { registered: true, sent_report: true } }), 7),
    ).toMatchObject({ closed: true, report: "sent" })
  })

  it("past Reporting, a processed row falls back to attendance: attended means the report counted", () => {
    expect(
      reportStatusOf(standing({ game: game(PROCESS), player: undefined, lastAttendedGame: 7 }), 7),
    ).toMatchObject({ closed: true, report: "sent" })
    expect(
      reportStatusOf(
        standing({ game: game(PROCESS), player: { registered: false, sent_report: false }, lastAttendedGame: 7 }),
        7,
      ),
    ).toMatchObject({ closed: true, report: "sent" })
  })

  it("past Reporting, a processed row is read at the last block still in Reporting when one is held", () => {
    const processed = { game: game(PROCESS), player: undefined, lastAttendedGame: null }
    expect(reportStatusOf(standing({ ...processed, reportingRow: { registered: true, sent_report: false } }), 7)).toMatchObject({
      closed: true,
      report: "not-sent",
    })
    expect(reportStatusOf(standing({ ...processed, reportingRow: { registered: true, sent_report: true } }), 7)).toMatchObject({
      closed: true,
      report: "sent",
    })
  })

  it("past Reporting, a processed row with no attendance cannot say whether a report was sent", () => {
    expect(reportStatusOf(standing({ game: game(PROCESS), player: undefined, lastAttendedGame: 6 }), 7)).toMatchObject({
      closed: true,
      report: "gone",
    })
  })

  it("a game that was cleared or replaced closed the window; a new game's row is never read as ours", () => {
    expect(reportStatusOf(standing({ game: undefined, player: undefined }), 7)).toMatchObject({
      closed: true,
      report: "gone",
    })
    expect(
      reportStatusOf(standing({ game: game({ type: "Registration" }, 8), player: { registered: true, sent_report: false } }), 7),
    ).toMatchObject({ closed: true, report: "gone" })
    expect(reportStatusOf(standing({ game: game({ type: "Registration" }, 8), lastAttendedGame: 7 }), 7)).toMatchObject({
      closed: true,
      report: "sent",
    })
  })

  it("with no game index given, it reads the game at that block, and names its date", () => {
    expect(reportStatusOf(standing({ game: game(PROCESS), lastAttendedGame: 7, player: undefined }))).toEqual({
      gameIndex: 7,
      gameDate: 200,
      closed: true,
      report: "sent",
    })
    expect(reportStatusOf(standing({ game: undefined }))).toMatchObject({ gameIndex: undefined, closed: false, report: "unknown" })
  })
})
