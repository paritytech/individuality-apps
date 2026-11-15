// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import {
  MEMBERSHIP_COPY,
  applyMembershipObservation,
  applyMembershipSent,
  emptyMembershipRecord,
  membershipLineOf,
  planMembershipLines,
  sanitizeMembershipRecord,
  standingOf,
  type MembershipObservation,
  type MembershipRecord,
} from "./chat"

/** One tick: observe, plan, mark sent. Returns the record and the kinds posted. */
function tick(record: MembershipRecord, observed: MembershipObservation) {
  let next = applyMembershipObservation(record, observed)
  const owed = planMembershipLines(next)
  for (const { kind } of owed) next = applyMembershipSent(next, kind)
  return { record: next, posted: owed.map(({ kind }) => kind), lines: owed.map(({ line }) => line) }
}

const member = (claimable = false): MembershipObservation => ({ standing: "member", claimable })
const other: MembershipObservation = { standing: "other", claimable: false }
const suspended: MembershipObservation = { standing: "suspended", claimable: false }

describe("standingOf", () => {
  it("reads membership-ready and caution as member", () => {
    expect(["Member", "Caution", "MembershipReady"].map(standingOf)).toEqual(["member", "member", "member"])
    expect(standingOf("Suspended")).toBe("suspended")
    expect(["Candidate", "Lite", "NotEnrolled"].map(standingOf)).toEqual(["other", "other", "other"])
  })
})

describe("membership news", () => {
  it("congratulates a new member once, with the claim button while the name is numbered", () => {
    const first = tick(emptyMembershipRecord(), other)
    expect(first.posted).toEqual([])
    const promoted = tick(first.record, member(true))
    expect(promoted.posted).toEqual(["membership"])
    expect(promoted.lines[0]).toEqual(MEMBERSHIP_COPY.member(true))
    expect(promoted.lines[0]?.claim).toBe(true)
    // the button settled the claim, and nothing repeats
    expect(tick(promoted.record, member(true)).posted).toEqual([])
  })

  it("says nothing stale to a standing member on first boot, but still owes the username claim", () => {
    expect(tick(emptyMembershipRecord(), member(false)).posted).toEqual([])
    const claimable = tick(emptyMembershipRecord(), member(true))
    expect(claimable.posted).toEqual(["claim"])
    expect(tick(claimable.record, member(true)).posted).toEqual([])
  })

  it("pauses once per suspension, and announces the return instead of a second congratulation", () => {
    const { record } = tick(emptyMembershipRecord(), member())
    const paused = tick(record, suspended)
    expect(paused.posted).toEqual(["suspended"])
    expect(tick(paused.record, suspended).posted).toEqual([])
    const back = tick(paused.record, member())
    expect(back.posted).toEqual(["restored"])
    expect(tick(back.record, member()).posted).toEqual([])
    // a second episode is told again
    const pausedAgain = tick(back.record, suspended)
    expect(pausedAgain.posted).toEqual(["suspended"])
    expect(tick(pausedAgain.record, member()).posted).toEqual(["restored"])
    expect(record.announced).toContain("membership")
  })

  it("tells someone first met while paused that they are paused", () => {
    expect(tick(emptyMembershipRecord(), suspended).posted).toEqual(["suspended"])
  })
})

describe("storage", () => {
  it("starts over from anything it cannot read", () => {
    expect(sanitizeMembershipRecord(null)).toEqual(emptyMembershipRecord())
    expect(sanitizeMembershipRecord({ version: 2 })).toEqual(emptyMembershipRecord())
    expect(sanitizeMembershipRecord({ version: 1, standing: "weird" })).toEqual(emptyMembershipRecord())
  })

  it("round-trips a record and drops unknown kinds", () => {
    const { record } = tick(tick(emptyMembershipRecord(), member()).record, suspended)
    const stored = JSON.parse(JSON.stringify({ ...record, announced: [...record.announced, "nope"] }))
    expect(sanitizeMembershipRecord(stored)).toEqual(record)
  })

  it("reads back a posted payload and refuses anything else", () => {
    expect(membershipLineOf(JSON.parse(JSON.stringify(MEMBERSHIP_COPY.paused)))).toEqual(MEMBERSHIP_COPY.paused)
    expect(membershipLineOf({ text: "x", status: "unknown" })).toBeNull()
    expect(membershipLineOf("x")).toBeNull()
  })
})
