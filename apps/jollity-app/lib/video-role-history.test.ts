// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import {
  bindPendingVideoRoles,
  markVideoRoleSeen,
  mergeVideoRoleHistory,
  videoRoleEligible,
  videoRoleSeen,
  type VideoRoleHistory,
} from "./video-role-history"

describe("video role history", () => {
  it("merges the earliest numeric boundary and lets numeric beat pending", () => {
    expect(
      mergeVideoRoleHistory(
        { a: { fromTurn: 7 }, b: { fromTurn: null } },
        { a: { fromTurn: 3 }, b: { fromTurn: 9 }, c: { fromTurn: null } },
      ),
    ).toEqual({ a: { fromTurn: 3 }, b: { fromTurn: 9 }, c: { fromTurn: null } })
  })

  it("marks a first frame once and never moves its boundary", () => {
    const first = markVideoRoleSeen({}, "a", null)
    expect(first).toEqual({ history: { a: { fromTurn: null } }, changed: true })
    expect(markVideoRoleSeen(first.history, "a", 12)).toEqual({ history: first.history, changed: false })
  })

  it("binds every pending observation at the next trustworthy open turn", () => {
    const before: VideoRoleHistory = { a: { fromTurn: null }, b: { fromTurn: 2 } }
    expect(bindPendingVideoRoles(before, 5)).toEqual({
      history: { a: { fromTurn: 5 }, b: { fromTurn: 2 } },
      changed: true,
    })
    expect(bindPendingVideoRoles({ b: { fromTurn: 2 } }, 8).changed).toBe(false)
  })

  it("distinguishes globally seen from turn eligibility", () => {
    const history: VideoRoleHistory = { pending: { fromTurn: null }, late: { fromTurn: 4 } }
    expect(videoRoleSeen(history, "pending")).toBe(true)
    expect(videoRoleEligible(history, "pending", 20)).toBe(false)
    expect(videoRoleEligible(history, "late", 3)).toBe(false)
    expect(videoRoleEligible(history, "late", 4)).toBe(true)
    expect(videoRoleEligible(history, "late", 8)).toBe(true)
  })

  it("loads older records as empty", () => {
    expect(mergeVideoRoleHistory({}, undefined)).toEqual({})
  })
})
