// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import type { LiveSeat } from "./game-source"
import { emptyTurnBooks } from "./turn-books"
import {
  emptyEvidenceProjection,
  evidenceHistory,
  evidenceProjection,
  playerProjection,
  presentedFrameAdmitted,
  roleFor,
  votable,
  voteShown,
  type ConfirmProjectionInput,
} from "./evidence-projection"

const seat = (id: string | null, index: number): LiveSeat => ({
  index,
  player: id === null ? null : { type: "Account", value: id },
})

function input(overrides: Partial<ConfirmProjectionInput> = {}): ConfirmProjectionInput {
  const books = emptyTurnBooks()
  return {
    books,
    evidence: emptyEvidenceProjection(),
    policy: {
      youId: "you",
      hostId: "host",
      ghost: (id) => id.startsWith("ghost:"),
      roster: new Set(["you", "host", "seen", "shared-unseen", "never-shared"]),
      confirming: false,
      clockReady: true,
      reportLocked: false,
      openTurn: { key: 1, stage: "playing" },
      live: {
        seats: [
          [seat("you", 0), seat("never-shared", 1), seat(null, 2)],
          [seat("you", 0), seat("seen", 1), seat("shared-unseen", 2)],
        ],
        mySeat: [0, 0],
        stride: 3,
        startedAtFirstTurn: false,
      },
      unseenVerdict: "person",
    },
    ...overrides,
  }
}

describe("evidence boundary", () => {
  it("increments once, closes intake forever, and freezes only when the gate opens", () => {
    const empty = emptyEvidenceProjection()
    const entered = evidenceProjection(empty, { kind: "enter-confirm" })
    expect(entered).toMatchObject({ evidenceEpoch: 1, intakeClosed: true, confirmGateOpen: false })
    expect(evidenceProjection(entered, { kind: "enter-confirm" })).toBe(entered)

    const waiting = evidenceProjection(entered, {
      kind: "open-confirm-gate",
      ready: false,
      videoRoleHistory: { seen: { fromTurn: 1 } },
    })
    expect(waiting).toBe(entered)
    const opened = evidenceProjection(waiting, {
      kind: "open-confirm-gate",
      ready: true,
      videoRoleHistory: { seen: { fromTurn: 1 } },
    })
    expect(opened.confirmGateOpen).toBe(true)
    expect(evidenceHistory(input({ evidence: opened }))).toEqual({ seen: { fromTurn: 1 } })
    expect(
      evidenceProjection(opened, {
        kind: "open-confirm-gate",
        ready: true,
        videoRoleHistory: { late: { fromTurn: 2 } },
      }),
    ).toBe(opened)
  })

  it("merges restored choices under local choices and preserves flip provenance", () => {
    let state = evidenceProjection(emptyEvidenceProjection(), {
      kind: "override",
      id: "shared-unseen",
      verdict: "person",
      changed: true,
      noVideo: true,
    })
    state = evidenceProjection(state, {
      kind: "restore-choices",
      overrides: { "shared-unseen": "notperson", seen: "notperson" },
      unseenFlipped: ["restored"],
    })
    expect(state.finalOverrides).toEqual({ "shared-unseen": "person", seen: "notperson" })
    expect([...state.unseenFlipped].sort()).toEqual(["restored", "shared-unseen"])
    state = evidenceProjection(state, {
      kind: "override",
      id: "shared-unseen",
      verdict: "notperson",
      changed: true,
      noVideo: true,
    })
    expect(state.unseenFlipped.has("shared-unseen")).toBe(true)
  })

  it("admits only a presented frame in a shared open turn before confirm", () => {
    const valid = {
      presented: true,
      sharedOpenTurn: true,
      inRoster: true,
      self: false,
      ghost: false,
      intakeClosed: false,
    }
    expect(presentedFrameAdmitted(valid)).toBe(true)
    for (const key of Object.keys(valid) as (keyof typeof valid)[]) {
      if (key === "self" || key === "ghost" || key === "intakeClosed")
        expect(presentedFrameAdmitted({ ...valid, [key]: true })).toBe(false)
      else expect(presentedFrameAdmitted({ ...valid, [key]: false })).toBe(false)
    }
  })

})

describe("pure tile and report projection", () => {
  it("projects host/self/ghost and requires seen evidence for an open turn", () => {
    const base = input({
      books: { ...emptyTurnBooks(), videoRoleHistory: { seen: { fromTurn: 1 } } },
    })
    expect(roleFor(base, "you")).toBe("you")
    expect(roleFor(base, "host")).toBe("host")
    expect(roleFor(base, "ghost:1")).toBe("empty")
    expect(roleFor(base, "seen")).toBe("coplayer")
    expect(votable(base, "seen")).toBe(true)
    expect(votable(base, "shared-unseen")).toBe(false)
  })

  it("files Person for never-shared and NotPerson for shared-but-unseen", () => {
    const books = {
      ...emptyTurnBooks(),
      firstOpenedTurn: 3,
      sealed: new Set([3]),
      videoRoleHistory: {},
    }
    const evidence = evidenceProjection(evidenceProjection(emptyEvidenceProjection(), { kind: "enter-confirm" }), {
      kind: "open-confirm-gate",
      ready: true,
      videoRoleHistory: {},
    })
    const confirm = input({
      books,
      evidence,
      policy: { ...input().policy, confirming: true, openTurn: undefined },
    })
    expect(playerProjection(confirm, "shared-unseen")).toMatchObject({ neverShared: false, noVideo: true })
    expect(playerProjection(confirm, "never-shared")).toMatchObject({ neverShared: true, noVideo: false })
    expect(voteShown(confirm, "shared-unseen")).toBe("notperson")
    expect(voteShown(confirm, "never-shared")).toBe("person")
    expect(votable(confirm, "shared-unseen")).toBe(true)
    expect(votable(confirm, "never-shared")).toBe(false)
  })

  it("uses majority/overrides for seen players and locks confirm choices with the report", () => {
    const books = {
      ...emptyTurnBooks(),
      turnVotes: { 0: { seen: "person" as const }, 1: { seen: "person" as const } },
      videoRoleHistory: { seen: { fromTurn: 0 } },
    }
    let evidence = evidenceProjection(emptyEvidenceProjection(), { kind: "enter-confirm" })
    evidence = evidenceProjection(evidence, {
      kind: "open-confirm-gate",
      ready: true,
      videoRoleHistory: books.videoRoleHistory,
    })
    const confirm = input({
      books,
      evidence,
      policy: { ...input().policy, confirming: true, openTurn: undefined },
    })
    expect(voteShown(confirm, "seen")).toBe("person")
    const overridden = evidenceProjection(evidence, {
      kind: "override",
      id: "seen",
      verdict: "notperson",
      changed: true,
      noVideo: false,
    })
    expect(voteShown({ ...confirm, evidence: overridden }, "seen")).toBe("notperson")
    expect(votable({ ...confirm, policy: { ...confirm.policy, reportLocked: true } }, "seen")).toBe(false)
  })
})
