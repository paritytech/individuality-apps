// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import type { AttendanceRow, GameSlot } from "./attendance-rule"
import { deriveAttendance } from "./attendance"

const REPORTING: GameSlot = { index: 9, state: { type: "Reporting" } }
const ROW: AttendanceRow = {
  registered: true,
  sent_report: false,
  yes_person: 0,
  no_not_person: 4,
  expected_max_vote_weight: 4,
  early_attendance_enactment: null,
}

describe("deriveAttendance", () => {
  it("says a player the votes have already failed failed, in the screen's words", () => {
    expect(deriveAttendance(9, REPORTING, ROW)).toEqual({
      gameIndex: 9,
      verdict: "failed",
      final: false,
      reported: false,
      personWeightNeeded: null,
    })
  })

  it("is final once the chain enacted it", () => {
    const enacted = { ...ROW, early_attendance_enactment: { attendance: false, disposition: "ArchiveKickable" as const } }
    expect(deriveAttendance(9, REPORTING, enacted)).toMatchObject({ verdict: "failed", final: true })
  })

  it("holds no verdict for a row with no registration, no row, or another game", () => {
    expect(deriveAttendance(9, REPORTING, { ...ROW, registered: false })).toBeNull()
    expect(deriveAttendance(9, REPORTING, undefined)).toBeNull()
    expect(deriveAttendance(10, REPORTING, ROW)).toBeNull()
  })
})
