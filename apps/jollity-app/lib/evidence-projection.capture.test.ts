// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import type { LiveSeat, PlayerId } from "./game-source"
import { buildReport, filedVerdicts, predictVerdict, sharedTurnWith } from "./game-roster"
import { emptyTurnBooks } from "./turn-books"
import { videoRoleSeen, type VideoRoleHistory } from "./video-role-history"
import {
  emptyEvidenceProjection,
  evidenceProjection,
  playerProjection,
  presentedFrameAdmitted,
  roleFor,
  votable,
  voteShown,
  type ConfirmProjectionInput,
  type EvidenceProjectionState,
  type EvidenceTileRole,
  type EvidenceVote,
} from "./evidence-projection"

/**
 * LEGACY ORACLE — copied verbatim in expression/order from source commit
 * 81c8fc39af0b7c32863823e31f5cb8ff95937c61:
 * lib/game-session.ts lines 1239-1250 (gate/freeze), 1656-1683
 * (role/entry/never-shared), and 1767-1798 (noVideo/votable/voteShown).
 * Existing pure old helpers predictVerdict/sharedTurnWith/buildReport are
 * imported from their production modules rather than rewritten here.
 */
type Legacy = {
  confirmGate: boolean
  frozen: VideoRoleHistory | null
  finalOverrides: Partial<Record<PlayerId, EvidenceVote>>
}

function legacyFreeze(
  state: Legacy,
  input: { confirming: boolean; confirmReleased: boolean; restoreDone: boolean; clockReady: boolean; history: VideoRoleHistory },
): Legacy {
  if (!input.confirming) state.confirmGate = false
  if (input.confirming && (input.confirmReleased || (input.restoreDone && input.clockReady))) state.confirmGate = true
  if (input.confirming && state.confirmGate && state.frozen === null) state.frozen = { ...input.history }
  return state
}

function legacyProjection(input: ConfirmProjectionInput) {
  const { books, evidence, policy } = input
  const evidenceVideoRoleHistory = evidence.frozenVideoRoleHistory ?? books.videoRoleHistory
  const seenVideo = (id: PlayerId): boolean => videoRoleSeen(evidenceVideoRoleHistory, id)
  const role = (id: PlayerId): EvidenceTileRole => {
    if (policy.ghost(id)) return "empty"
    if (id === policy.youId) return "you"
    if (policy.openTurn && id === policy.hostId) return "host"
    return videoRoleSeen(evidenceVideoRoleHistory, id) ? "coplayer" : "unseen"
  }
  const firstAnsweredTurn = (): number | undefined => {
    if (policy.live?.startedAtFirstTurn) return 0
    const turns = [...books.sealed, ...(books.firstOpenedTurn === undefined ? [] : [books.firstOpenedTurn])]
    return turns.length > 0 ? Math.min(...turns) : undefined
  }
  const neverShared = (id: PlayerId): boolean => {
    const first = firstAnsweredTurn()
    if (!policy.live || first === undefined) return false
    return !sharedTurnWith(policy.live.seats, policy.live.mySeat, id, first, policy.live.stride)
  }
  const noVideo = (id: PlayerId): boolean =>
    policy.confirming &&
    id !== policy.youId &&
    !policy.ghost(id) &&
    policy.roster.has(id) &&
    !seenVideo(id) &&
    !neverShared(id)
  const canVote = (id: PlayerId): boolean => {
    if (!policy.clockReady) return false
    if (policy.ghost(id)) return false
    if (id === policy.youId) return false
    if (policy.openTurn) return seenVideo(id) && id !== policy.hostId
    return policy.confirming && (seenVideo(id) || noVideo(id)) && !policy.reportLocked
  }
  const shown = (id: PlayerId): EvidenceVote | undefined => {
    if (policy.confirming) {
      if (!seenVideo(id))
        return neverShared(id) ? policy.unseenVerdict : (evidence.finalOverrides[id] ?? "notperson")
      return evidence.finalOverrides[id] ?? predictVerdict(books.turnVotes, id, policy.unseenVerdict)
    }
    const cast = policy.openTurn ? books.turnVotes[policy.openTurn.key]?.[id] : undefined
    if (cast) return cast
    if (policy.openTurn?.stage === "ending" && canVote(id)) return "notperson"
    return undefined
  }
  return { role, seenVideo, neverShared, votable: canVote, voteShown: shown }
}

const seat = (id: string | null, index: number): LiveSeat => ({
  index,
  player: id === null ? null : { type: "Account", value: id },
})
const ids = ["you", "host", "seen", "shared-unseen", "never-shared", "ghost:1"]
const rounds = [
  [seat("you", 0), seat("never-shared", 1), seat(null, 2)],
  [seat("you", 0), seat("seen", 1), seat("shared-unseen", 2)],
]

function projectionInput(
  evidence: EvidenceProjectionState,
  options: {
    history?: VideoRoleHistory
    confirming?: boolean
    reportLocked?: boolean
    openTurn?: { key: number; stage: string }
    firstOpenedTurn?: number
    turnVotes?: ConfirmProjectionInput["books"]["turnVotes"]
  } = {},
): ConfirmProjectionInput {
  return {
    books: {
      ...emptyTurnBooks(),
      firstOpenedTurn: options.firstOpenedTurn ?? 3,
      sealed: new Set([options.firstOpenedTurn ?? 3]),
      videoRoleHistory: options.history ?? {},
      turnVotes: options.turnVotes ?? { 1: { seen: "person" } },
    },
    evidence,
    policy: {
      youId: "you",
      hostId: "host",
      ghost: (id) => id.startsWith("ghost:"),
      roster: new Set(ids),
      confirming: options.confirming ?? true,
      clockReady: true,
      reportLocked: options.reportLocked ?? false,
      openTurn: options.openTurn,
      live: { seats: rounds, mySeat: [0, 0], stride: 3, startedAtFirstTurn: false },
      unseenVerdict: "person",
    },
  }
}

type DerivationMutation = "seen" | "neverShared"

function capture(input: ConfirmProjectionInput, mutation?: DerivationMutation) {
  const old = legacyProjection(input)
  const oldDerivation = ids.map((id) => ({ seen: old.seenVideo(id), neverShared: old.neverShared(id) }))
  const newDerivation = ids.map((id) => {
    const derived = playerProjection(input, id)
    if (!mutation || id !== "shared-unseen")
      return { seen: derived.seen, neverShared: derived.neverShared }
    return {
      seen: mutation === "seen" ? !derived.seen : derived.seen,
      neverShared: mutation === "neverShared" ? !derived.neverShared : derived.neverShared,
    }
  })
  expect(newDerivation).toEqual(oldDerivation)
  const newVote = (id: PlayerId) => voteShown(input, id)
  const oldReport = buildReport(rounds, [0, 0], old.voteShown)
  const newReport = buildReport(rounds, [0, 0], newVote)
  const result = {
    old: {
      roles: ids.map((id) => old.role(id)),
      votable: ids.map((id) => old.votable(id)),
      shown: ids.map((id) => old.voteShown(id) ?? null),
      report: oldReport,
      filed: filedVerdicts(rounds, [0, 0], oldReport),
    },
    current: {
      roles: ids.map((id) => roleFor(input, id)),
      votable: ids.map((id) => votable(input, id)),
      shown: ids.map((id) => newVote(id) ?? null),
      report: newReport,
      filed: filedVerdicts(rounds, [0, 0], newReport),
    },
  }
  expect(result.current).toEqual(result.old)
  return result.current
}

describe("legacy projection capture", () => {
  it("matches fixed live/confirm, delayed-books, release, override and presentation captures", () => {
    let evidence = emptyEvidenceProjection()
    const live = capture(
      projectionInput(evidence, {
        confirming: false,
        firstOpenedTurn: 0,
        openTurn: { key: 1, stage: "ending" },
        history: { seen: { fromTurn: 1 }, host: { fromTurn: 0 } },
      }),
    )

    evidence = evidenceProjection(evidence, { kind: "enter-confirm" })
    const waiting = capture(projectionInput(evidence, { history: { seen: { fromTurn: 1 } } }))

    const legacy: Legacy = { confirmGate: false, frozen: null, finalOverrides: {} }
    legacyFreeze(legacy, {
      confirming: true,
      confirmReleased: false,
      restoreDone: false,
      clockReady: true,
      history: { seen: { fromTurn: 1 } },
    })
    evidence = evidenceProjection(evidence, {
      kind: "open-confirm-gate",
      ready: false,
      videoRoleHistory: { seen: { fromTurn: 1 } },
    })
    expect(evidence.confirmGateOpen).toBe(legacy.confirmGate)

    legacyFreeze(legacy, {
      confirming: true,
      confirmReleased: false,
      restoreDone: true,
      clockReady: true,
      history: { seen: { fromTurn: 1 } },
    })
    evidence = evidenceProjection(evidence, {
      kind: "open-confirm-gate",
      ready: true,
      videoRoleHistory: { seen: { fromTurn: 1 } },
    })
    expect(evidence.frozenVideoRoleHistory).toEqual(legacy.frozen)
    const normal = capture(projectionInput(evidence, { history: { seen: { fromTurn: 1 } } }))

    // A late books/history write after release cannot change the frozen copy.
    legacyFreeze(legacy, {
      confirming: true,
      confirmReleased: true,
      restoreDone: true,
      clockReady: true,
      history: { seen: { fromTurn: 1 }, "shared-unseen": { fromTurn: 3 } },
    })
    evidence = evidenceProjection(evidence, {
      kind: "open-confirm-gate",
      ready: true,
      videoRoleHistory: { seen: { fromTurn: 1 }, "shared-unseen": { fromTurn: 3 } },
    })
    expect(evidence.frozenVideoRoleHistory).toEqual(legacy.frozen)
    const released = capture(
      projectionInput(evidence, { history: { seen: { fromTurn: 1 }, "shared-unseen": { fromTurn: 3 } } }),
    )

    evidence = evidenceProjection(evidence, {
      kind: "override",
      id: "shared-unseen",
      verdict: "person",
      changed: true,
      noVideo: true,
    })
    const overridden = capture(projectionInput(evidence, { history: { seen: { fromTurn: 1 } } }))
    evidence = evidenceProjection(evidence, {
      kind: "override",
      id: "shared-unseen",
      verdict: "notperson",
      changed: true,
      noVideo: true,
    })
    const reverted = capture(projectionInput(evidence, { history: { seen: { fromTurn: 1 } } }))

    // A decoded-but-unpresented frame remains absent (#1186 black-tile rule).
    expect(
      presentedFrameAdmitted({
        presented: false,
        sharedOpenTurn: true,
        inRoster: true,
        self: false,
        ghost: false,
        intakeClosed: false,
      }),
    ).toBe(false)

    expect({ live, waiting, normal, released, overridden, reverted }).toMatchInlineSnapshot(`
      {
        "live": {
          "filed": {
            "never-shared": "notperson",
            "seen": "person",
            "shared-unseen": "notperson",
          },
          "report": [
            [
              "NotPerson",
            ],
            [
              "Person",
              "NotPerson",
            ],
          ],
          "roles": [
            "you",
            "host",
            "coplayer",
            "unseen",
            "unseen",
            "empty",
          ],
          "shown": [
            null,
            null,
            "person",
            null,
            null,
            null,
          ],
          "votable": [
            false,
            false,
            true,
            false,
            false,
            false,
          ],
        },
        "normal": {
          "filed": {
            "never-shared": "person",
            "seen": "person",
            "shared-unseen": "notperson",
          },
          "report": [
            [
              "Person",
            ],
            [
              "Person",
              "NotPerson",
            ],
          ],
          "roles": [
            "you",
            "unseen",
            "coplayer",
            "unseen",
            "unseen",
            "empty",
          ],
          "shown": [
            "person",
            "person",
            "person",
            "notperson",
            "person",
            "person",
          ],
          "votable": [
            false,
            false,
            true,
            true,
            false,
            false,
          ],
        },
        "overridden": {
          "filed": {
            "never-shared": "person",
            "seen": "person",
            "shared-unseen": "person",
          },
          "report": [
            [
              "Person",
            ],
            [
              "Person",
              "Person",
            ],
          ],
          "roles": [
            "you",
            "unseen",
            "coplayer",
            "unseen",
            "unseen",
            "empty",
          ],
          "shown": [
            "person",
            "person",
            "person",
            "person",
            "person",
            "person",
          ],
          "votable": [
            false,
            false,
            true,
            true,
            false,
            false,
          ],
        },
        "released": {
          "filed": {
            "never-shared": "person",
            "seen": "person",
            "shared-unseen": "notperson",
          },
          "report": [
            [
              "Person",
            ],
            [
              "Person",
              "NotPerson",
            ],
          ],
          "roles": [
            "you",
            "unseen",
            "coplayer",
            "unseen",
            "unseen",
            "empty",
          ],
          "shown": [
            "person",
            "person",
            "person",
            "notperson",
            "person",
            "person",
          ],
          "votable": [
            false,
            false,
            true,
            true,
            false,
            false,
          ],
        },
        "reverted": {
          "filed": {
            "never-shared": "person",
            "seen": "person",
            "shared-unseen": "notperson",
          },
          "report": [
            [
              "Person",
            ],
            [
              "Person",
              "NotPerson",
            ],
          ],
          "roles": [
            "you",
            "unseen",
            "coplayer",
            "unseen",
            "unseen",
            "empty",
          ],
          "shown": [
            "person",
            "person",
            "person",
            "notperson",
            "person",
            "person",
          ],
          "votable": [
            false,
            false,
            true,
            true,
            false,
            false,
          ],
        },
        "waiting": {
          "filed": {
            "never-shared": "person",
            "seen": "person",
            "shared-unseen": "notperson",
          },
          "report": [
            [
              "Person",
            ],
            [
              "Person",
              "NotPerson",
            ],
          ],
          "roles": [
            "you",
            "unseen",
            "coplayer",
            "unseen",
            "unseen",
            "empty",
          ],
          "shown": [
            "person",
            "person",
            "person",
            "notperson",
            "person",
            "person",
          ],
          "votable": [
            false,
            false,
            true,
            true,
            false,
            false,
          ],
        },
      }
    `)
  })

  it("the parity assertion detects deliberate seen and never-shared derivation mutations", () => {
    const unchangedInput = projectionInput(emptyEvidenceProjection(), { history: {} })
    for (const mutation of ["seen", "neverShared"] as const) {
      let failure: unknown
      try {
        capture(unchangedInput, mutation)
      } catch (error) {
        failure = error
      }
      expect(failure).toMatchObject({ name: "AssertionError" })
    }
  })
})
