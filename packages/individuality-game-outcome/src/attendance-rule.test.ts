// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { attendanceInGame, attendanceStatus, type AttendanceRow, type GameSlot } from "./attendance-rule"

const row = (patch: Partial<AttendanceRow> = {}): AttendanceRow => ({
  registered: true,
  sent_report: true,
  yes_person: 0,
  no_not_person: 0,
  expected_max_vote_weight: 0,
  early_attendance_enactment: null,
  ...patch,
})

// The pallet's own cases (pallets/game/src/tests.rs), as the rows they leave
// behind. Its mock runtime weighs every vote 1.
describe("the pallet's early-enactment cases", () => {
  it("attended when the group saturates yes", () => {
    // early_enactment_attended_when_group_saturates_yes: a group of two, one
    // round, both report Person on the other
    const tallies = row({ yes_person: 1, expected_max_vote_weight: 1 })
    expect(attendanceStatus(tallies).status).toBe("attended")
    const enacted = { ...tallies, early_attendance_enactment: { attendance: true, disposition: "Keep" as const } }
    expect(attendanceStatus(enacted)).toEqual({ status: "attended", personWeightNeeded: 0, atClose: true })
  })

  it("not attended without their own report", () => {
    // early_enactment_not_attended_without_own_report: a group of three, both
    // co-players report NotPerson on ALICE, who never reports
    const alice = row({ sent_report: false, no_not_person: 2, expected_max_vote_weight: 2 })
    expect(attendanceStatus(alice)).toEqual({ status: "notAttended", personWeightNeeded: null, atClose: false })
  })

  it("pending with partial votes", () => {
    // early_enactment_pending_with_partial_votes: a group of four, only BOB
    // reports, and ALICE has 1 of 3 possible votes
    const alice = row({ sent_report: false, yes_person: 1, expected_max_vote_weight: 3 })
    expect(attendanceStatus(alice).status).toBe("pending")
  })
})

describe("the edges", () => {
  it("a player who is not registered never attends", () => {
    expect(attendanceStatus(row({ registered: false, yes_person: 6, expected_max_vote_weight: 6 }))).toEqual({
      status: "notAttended",
      personWeightNeeded: null,
      atClose: false,
    })
  })

  it("no votes at all: a player who reported attends, as the pallet's saturating sub has it", () => {
    expect(attendanceStatus(row())).toEqual({ status: "attended", personWeightNeeded: 0, atClose: true })
  })

  it("no votes at all and no report: pending, and failed at the close", () => {
    expect(attendanceStatus(row({ sent_report: false }))).toEqual({ status: "pending", personWeightNeeded: 0, atClose: false })
  })

  it("all the Person weight there is, but no report: still pending", () => {
    const unreported = row({ sent_report: false, yes_person: 4, expected_max_vote_weight: 4 })
    expect(attendanceStatus(unreported)).toEqual({ status: "pending", personWeightNeeded: 0, atClose: false })
  })

  it("the enactment answers over the tallies", () => {
    const failed = row({ yes_person: 1, expected_max_vote_weight: 3, early_attendance_enactment: { attendance: false } })
    expect(attendanceStatus(failed)).toEqual({ status: "notAttended", personWeightNeeded: null, atClose: false })
  })

  it("names the Person weight still needed while it is open", () => {
    // 1 of 6 in, and Person: 3 more pass the player (4 − 1 ≥ 0 + 2), 2 do not (3 − 1 < 0 + 3)
    expect(attendanceStatus(row({ yes_person: 1, expected_max_vote_weight: 6 }))).toMatchObject({
      status: "pending",
      personWeightNeeded: 3,
    })
  })

  it("the close decides a pending player on the votes filed, not on the votes missing", () => {
    // 2 Person, 1 NotPerson, 3 never came: open, but passed if it closed now
    expect(attendanceStatus(row({ yes_person: 2, no_not_person: 1, expected_max_vote_weight: 6 }))).toMatchObject({
      status: "pending",
      atClose: true,
    })
  })
})

// Every small row, checked against what the rule MEANS rather than against a
// second copy of it: "attended" holds however the remaining weight falls,
// "notAttended" fails however it falls, and the weight needed is the least
// that turns the worst case into a pass.
describe("every small row", () => {
  const passesAtEnd = (r: AttendanceRow, yes: number, no: number) =>
    r.registered && r.sent_report && Math.max(yes - 1, 0) >= no

  const rows: AttendanceRow[] = []
  for (const registered of [true, false])
    for (const sent_report of [true, false])
      for (let expected = 0; expected <= 8; expected++)
        for (let yes = 0; yes <= expected; yes++)
          for (let no = 0; yes + no <= expected; no++)
            rows.push(row({ registered, sent_report, yes_person: yes, no_not_person: no, expected_max_vote_weight: expected }))

  it.each(rows.map((r) => [JSON.stringify(r), r] as const))("%s", (_name, r) => {
    const { status, personWeightNeeded, atClose } = attendanceStatus(r)
    const remaining = r.expected_max_vote_weight - r.yes_person - r.no_not_person
    const outcomes = Array.from({ length: remaining + 1 }, (_, x) => passesAtEnd(r, r.yes_person + x, r.no_not_person + remaining - x))

    expect(atClose).toBe(passesAtEnd(r, r.yes_person, r.no_not_person))
    if (status === "attended") expect(outcomes.every(Boolean)).toBe(true)
    if (status === "notAttended") expect(outcomes.some(Boolean)).toBe(false)
    if (status === "pending" && r.registered && r.sent_report) expect(new Set(outcomes).size).toBe(2)

    if (!r.registered) {
      expect(personWeightNeeded).toBeNull()
      return
    }
    // with the report in, x more Person weight and the rest NotPerson
    const worstPasses = (x: number) =>
      Math.max(r.yes_person + x - 1, 0) >= r.no_not_person + remaining - x
    const least = Array.from({ length: remaining + 1 }, (_, x) => x).find(worstPasses)
    expect(personWeightNeeded).toBe(least ?? null)
  })
})

describe("attendanceInGame", () => {
  const REPORTING: GameSlot = { index: 7, state: { type: "Reporting" } }
  const PROCESS: GameSlot = { index: 7, state: { type: "PlayerProcess" } }
  const voted = row({ yes_person: 1, expected_max_vote_weight: 6 })

  it("answers while the chain holds the game's votes", () => {
    expect(attendanceInGame(REPORTING, voted, 7)).toEqual(attendanceStatus(voted))
    // a row PlayerProcess has not reached yet still holds its tallies
    expect(attendanceInGame(PROCESS, voted, 7)).toEqual(attendanceStatus(voted))
  })

  it("says nothing about another game, or before the votes", () => {
    expect(attendanceInGame(REPORTING, voted, 8)).toBeNull()
    expect(attendanceInGame(undefined, voted, 7)).toBeNull()
    expect(attendanceInGame({ index: 7, state: { type: "Shuffle" } }, voted, 7)).toBeNull()
  })

  it("says nothing for a player who is not registered, which is how PlayerProcess leaves a kept row", () => {
    const reset = row({ registered: false, sent_report: false })
    expect(attendanceInGame(PROCESS, reset, 7)).toBeNull()
    expect(attendanceInGame(REPORTING, undefined, 7)).toBeNull()
  })
})
