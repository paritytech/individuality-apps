// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The game-scoped evidence boundary and the tile/report projection.
 *
 * Pure: the session runner supplies clock, roster and presentation facts. A
 * decoded frame is evidence only when the runner also says it was presented
 * in a shared OPEN turn. Confirm closes that intake forever, then freezes the
 * history once the stored books and clock are ready (or the last-call release
 * opens the gate).
 */
import type { LiveSeat, PlayerId } from "./game-source"
import { predictVerdict, sharedTurnWith, type TurnVotes } from "./game-roster"
import type { TurnBooks } from "./turn-books"
import { videoRoleSeen, type VideoRoleHistory } from "./video-role-history"

export type EvidenceVote = "person" | "notperson"
export type EvidenceTileRole = "host" | "you" | "empty" | "unseen" | "coplayer"

export interface EvidenceProjectionState {
  /** Non-decreasing token for every callback that can present evidence. */
  evidenceEpoch: number
  /** Confirm is a one-way evidence boundary for this mounted game. */
  intakeClosed: boolean
  /** One-way latch: books + clock settled, or last-call release fired. */
  confirmGateOpen: boolean
  /** The exact evidence used by recap, confirm tiles and the report. */
  frozenVideoRoleHistory: VideoRoleHistory | null
  /** Confirm choices restored from storage and changed on this page. */
  finalOverrides: Partial<Record<PlayerId, EvidenceVote>>
  /** Historical #871 provenance; changing back does not erase it. */
  unseenFlipped: ReadonlySet<PlayerId>
}

export function emptyEvidenceProjection(): EvidenceProjectionState {
  return {
    evidenceEpoch: 0,
    intakeClosed: false,
    confirmGateOpen: false,
    frozenVideoRoleHistory: null,
    finalOverrides: {},
    unseenFlipped: new Set(),
  }
}

export type EvidenceProjectionEvent =
  | { kind: "enter-confirm" }
  | { kind: "leave-confirm-backward-clock" }
  | { kind: "open-confirm-gate"; ready: boolean; videoRoleHistory: VideoRoleHistory }
  | {
      kind: "restore-choices"
      overrides: Partial<Record<PlayerId, EvidenceVote>> | undefined
      unseenFlipped: readonly PlayerId[] | undefined
    }
  | { kind: "override"; id: PlayerId; verdict: EvidenceVote; changed: boolean; noVideo: boolean }

/** One reducer owns every value of the evidence boundary
 *  (`EvidenceProjectionState`). */
export function evidenceProjection(
  state: EvidenceProjectionState,
  event: EvidenceProjectionEvent,
): EvidenceProjectionState {
  switch (event.kind) {
    case "enter-confirm":
      if (state.intakeClosed) return state
      return { ...state, evidenceEpoch: state.evidenceEpoch + 1, intakeClosed: true }
    case "leave-confirm-backward-clock":
      // Defensive: should the rendered stage ever move backward (the shown
      // game time never does), evidence intake follows the first confirm
      // boundary, not that later stage.
      return state
    case "open-confirm-gate":
      if (!state.intakeClosed || !event.ready || state.confirmGateOpen) return state
      return {
        ...state,
        confirmGateOpen: true,
        frozenVideoRoleHistory: { ...event.videoRoleHistory },
      }
    case "restore-choices": {
      const flipped = new Set([...(event.unseenFlipped ?? []), ...state.unseenFlipped])
      return {
        ...state,
        finalOverrides: { ...(event.overrides ?? {}), ...state.finalOverrides },
        unseenFlipped: flipped,
      }
    }
    case "override": {
      const flipped = new Set(state.unseenFlipped)
      if (event.noVideo && event.changed) flipped.add(event.id)
      return {
        ...state,
        finalOverrides: { ...state.finalOverrides, [event.id]: event.verdict },
        unseenFlipped: flipped,
      }
    }
  }
}

/** Explicit evidence-admission policy. Decoding without presentation is out. */
export function presentedFrameAdmitted(input: {
  presented: boolean
  sharedOpenTurn: boolean
  inRoster: boolean
  self: boolean
  ghost: boolean
  intakeClosed: boolean
}): boolean {
  return (
    input.presented &&
    input.sharedOpenTurn &&
    input.inRoster &&
    !input.self &&
    !input.ghost &&
    !input.intakeClosed
  )
}

interface ConfirmProjectionPolicy {
  youId: PlayerId | null
  hostId: PlayerId | null
  ghost: (id: PlayerId) => boolean
  roster: ReadonlySet<PlayerId>
  confirming: boolean
  clockReady: boolean
  reportLocked: boolean
  /** Absent in a round gap and on confirm. */
  openTurn?: { key: number; stage: string }
  /** Absent without a live game, where never-shared is not inferred. */
  live?: {
    seats: LiveSeat[][]
    mySeat: number[]
    stride: number
    startedAtFirstTurn: boolean
  }
  unseenVerdict: EvidenceVote
}

export interface ConfirmProjectionInput {
  books: Pick<TurnBooks, "turnVotes" | "sealed" | "firstOpenedTurn" | "videoRoleHistory">
  evidence: EvidenceProjectionState
  policy: ConfirmProjectionPolicy
}

export interface PlayerProjection {
  role: EvidenceTileRole
  seen: boolean
  neverShared: boolean
  noVideo: boolean
}

export function evidenceHistory(input: ConfirmProjectionInput): VideoRoleHistory {
  return input.evidence.frozenVideoRoleHistory ?? input.books.videoRoleHistory
}

function firstAnsweredTurn(input: ConfirmProjectionInput): number | undefined {
  if (input.policy.live?.startedAtFirstTurn) return 0
  const turns = [
    ...input.books.sealed,
    ...(input.books.firstOpenedTurn === undefined ? [] : [input.books.firstOpenedTurn]),
  ]
  return turns.length > 0 ? Math.min(...turns) : undefined
}

function neverSharedWith(input: ConfirmProjectionInput, id: PlayerId): boolean {
  const first = firstAnsweredTurn(input)
  const live = input.policy.live
  if (!live || first === undefined) return false
  return !sharedTurnWith(live.seats, live.mySeat, id, first, live.stride)
}

export function playerProjection(input: ConfirmProjectionInput, id: PlayerId): PlayerProjection {
  const { policy } = input
  const seen = videoRoleSeen(evidenceHistory(input), id)
  const neverShared = neverSharedWith(input, id)
  const role: EvidenceTileRole = policy.ghost(id)
    ? "empty"
    : id === policy.youId
      ? "you"
      : policy.openTurn && id === policy.hostId
        ? "host"
        : seen
          ? "coplayer"
          : "unseen"
  return {
    role,
    seen,
    neverShared,
    noVideo:
      policy.confirming &&
      id !== policy.youId &&
      !policy.ghost(id) &&
      policy.roster.has(id) &&
      !seen &&
      !neverShared,
  }
}

export function roleFor(input: ConfirmProjectionInput, id: PlayerId): EvidenceTileRole {
  return playerProjection(input, id).role
}

export function votable(input: ConfirmProjectionInput, id: PlayerId): boolean {
  const { policy } = input
  if (!policy.clockReady || policy.ghost(id) || id === policy.youId) return false
  const player = playerProjection(input, id)
  if (policy.openTurn) return player.seen && id !== policy.hostId
  return policy.confirming && (player.seen || player.noVideo) && !policy.reportLocked
}

export function voteShown(input: ConfirmProjectionInput, id: PlayerId): EvidenceVote | undefined {
  const { books, evidence, policy } = input
  const player = playerProjection(input, id)
  if (policy.confirming) {
    if (!player.seen)
      return player.neverShared
        ? policy.unseenVerdict
        : (evidence.finalOverrides[id] ?? "notperson")
    return evidence.finalOverrides[id] ?? predictVerdict(books.turnVotes as TurnVotes, id, policy.unseenVerdict)
  }
  const cast = policy.openTurn ? books.turnVotes[policy.openTurn.key]?.[id] : undefined
  if (cast) return cast
  if (policy.openTurn?.stage === "ending" && votable(input, id)) return "notperson"
  return undefined
}
