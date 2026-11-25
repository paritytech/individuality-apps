// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * THE REPORT OUTBOX — pure timing and transaction decisions for the game
 * session's confirm/report handoff.
 *
 * The runner owns clocks, timers, storage, the chain and navigation. It feeds
 * their readings here and interprets commands in order. The reducer never
 * reads Date.now(), performance.now(), the source clock, React or the router.
 */
import type { ReportVote } from "@jollity/protocol"
import type { StoredVotes } from "./game-votes"

export const AUTO_CONFIRM_MS = 7_000
export const AUTO_CONFIRM_BEAT_MS = 900
export const AUTO_CONFIRM_AWAY_THRESHOLD_MS = 10_000
export const CONFIRM_REPORT_MARGIN_MS = 3_000
/** The game clock and `performance.now()` are sampled separately. A small
 *  allowance absorbs their read skew without turning a capped restart into
 *  an immediate file. */
const CONFIRM_CLOCK_READ_TOLERANCE_MS = 100
/** a confirm still waiting on the stored votes lets go this far BEFORE the
 *  margin, so the auto-confirm's last-call check (which needs the margin to
 *  be ahead of it) files at its first tick instead of one tick too late (#565) */
const CONFIRM_RELEASE_LEAD_MS = 500
const REPORT_RETRY_MS = 1_500
const HANDOVER_POLL_MS = 2_500

type OutboxReport = ReportVote[][]
type SubmitFailureReason = "refused" | "timeout"

export interface OutboxClock {
  /** performance.now(): countdowns and retry spacing */
  monotonicMs: number
  /** source.nowSeconds() * 1000: the report window */
  gameMs: number
  /** Date.now(): the hidden-page away latch, on the wall clock on purpose
   *  (lib/game-session.ts `awayLatchNowMs`) */
  latchMs: number
  /** the game clock is registered (`chainNowMs() !== null`). When it is not
   *  (test sources only), a capped restart keeps its whole-second slack */
  chainAnchored: boolean
}

export interface OutboxInputs {
  gameIndex: number | undefined
  reportEndsMs: number | undefined
  confirming: boolean
  /** books restore and clock reconciliation have settled, or released */
  confirmReady: boolean
  votesMissing: number
  hasSubmitPath: boolean
}

export interface OutboxState {
  phase: "idle" | "countdown" | "beat" | "submitting" | "retry-wait" | "handover" | "confirmed" | "missed" | "error"
  inputs: OutboxInputs
  report: OutboxReport | null
  generation: number
  attempts: number
  locked: boolean
  submitted: boolean
  chainClosed: boolean
  autoCancelled: boolean
  autoCount: number
  hardStopAt: number | null
  beatAt: number | null
  fireAt: number | null
  restartOwnsDeadline: boolean
  restartCapSlackMs: number
  rushed: boolean
  rushPending: boolean
  filedBy: "auto-confirm" | "tap"
  retryRush: boolean
  confirmReleased: boolean
  away: boolean
  awayPending: boolean
  hiddenAtLatchMs: number | null
  terminalFailure: { detail: string; reason: SubmitFailureReason } | null
  attemptStartedAt: number | null
  handoverPauseMs: number
  lastSaved: string
}

const emptyOutboxInputs: OutboxInputs = {
  gameIndex: undefined,
  reportEndsMs: undefined,
  confirming: false,
  confirmReady: false,
  votesMissing: 0,
  hasSubmitPath: false,
}

export function emptyReportOutbox(inputs: OutboxInputs = emptyOutboxInputs): OutboxState {
  return {
    phase: "idle",
    inputs,
    report: null,
    generation: 0,
    attempts: 0,
    locked: false,
    submitted: false,
    chainClosed: false,
    autoCancelled: false,
    autoCount: AUTO_CONFIRM_MS / 1_000,
    hardStopAt: null,
    beatAt: null,
    fireAt: null,
    restartOwnsDeadline: false,
    restartCapSlackMs: 0,
    rushed: false,
    rushPending: false,
    filedBy: "tap",
    retryRush: false,
    confirmReleased: false,
    away: false,
    awayPending: false,
    hiddenAtLatchMs: null,
    terminalFailure: null,
    attemptStartedAt: null,
    handoverPauseMs: HANDOVER_POLL_MS,
    lastSaved: "",
  }
}

export type OutboxEvent =
  | { kind: "sync"; inputs: OutboxInputs; clock: OutboxClock }
  | { kind: "countdown-started"; inputs: OutboxInputs; clock: OutboxClock }
  | { kind: "tick"; clock: OutboxClock }
  | { kind: "release-tick"; clock: OutboxClock }
  | { kind: "verdict-changed"; clock: OutboxClock; capSlackMs: number }
  | { kind: "rush-confirm"; clock: OutboxClock }
  | { kind: "confirm"; clock: OutboxClock; report: OutboxReport; filedBy: "auto-confirm" | "tap" }
  | { kind: "hidden"; clock: OutboxClock }
  | { kind: "away-threshold" }
  | { kind: "away-reset" }
  | { kind: "shown"; clock: OutboxClock }
  | { kind: "froze-away" }
  | { kind: "stored-away" }
  | { kind: "host-chain-lost" }
  | { kind: "save-votes"; entry: StoredVotes }
  | { kind: "attempt-result"; generation: number; clock: OutboxClock; result: "sent" | "closed" | "chain-closed" | "refused"; detail?: string }
  | { kind: "attempt-started"; generation: number; monotonicMs: number }
  | { kind: "retry-fired"; generation: number; clock: OutboxClock }
  | { kind: "handover-started" }
  | { kind: "handover-result"; result: "sent" | "missed" | "gone" | "pending" }
  | { kind: "unmounted" }

export type OutboxCommand =
  | { kind: "auto-confirm-off" }
  | { kind: "confirm-release" }
  | { kind: "rush-consumed" }
  | { kind: "confirm"; filedBy: "auto-confirm" | "tap" }
  | { kind: "submit"; report: OutboxReport; generation: number; attempt: number }
  | { kind: "schedule-retry"; delayMs: number; generation: number }
  | { kind: "terminal-failure"; detail: string; reason: SubmitFailureReason }
  | { kind: "poll-handover"; delayMs: number }
  | { kind: "finish-report" }
  | { kind: "navigate-collectables"; missed: boolean }
  | { kind: "clear-votes" }
  | { kind: "save-votes"; entry: StoredVotes }

export interface OutboxResult {
  state: OutboxState
  commands: OutboxCommand[]
}

function windowOpen(state: OutboxState, clock: OutboxClock): boolean {
  return state.inputs.reportEndsMs === undefined || clock.gameMs < state.inputs.reportEndsMs
}

function lastCallAt(state: OutboxState, clock: OutboxClock): number {
  return state.inputs.reportEndsMs === undefined
    ? Infinity
    : clock.monotonicMs + state.inputs.reportEndsMs - clock.gameMs - CONFIRM_REPORT_MARGIN_MS
}

function canAuto(state: OutboxState, clock: OutboxClock): boolean {
  const i = state.inputs
  return i.confirming && i.confirmReady && state.inputs.votesMissing === 0 &&
    windowOpen(state, clock) && !state.autoCancelled && !state.away && !state.awayPending &&
    !state.locked && !state.submitted
}

function markAway(state: OutboxState, commands: OutboxCommand[]): void {
  if (state.away) return
  state.away = true
  state.autoCancelled = true
  state.phase = state.phase === "countdown" || state.phase === "beat" ? "idle" : state.phase
  state.hardStopAt = null
  state.beatAt = null
  state.fireAt = null
  commands.push({ kind: "auto-confirm-off" })
}

function arm(state: OutboxState, clock: OutboxClock): void {
  state.phase = "countdown"
  state.hardStopAt = clock.monotonicMs + AUTO_CONFIRM_MS
  state.beatAt = state.hardStopAt - AUTO_CONFIRM_BEAT_MS
  state.fireAt = null
  state.restartOwnsDeadline = false
  state.restartCapSlackMs = 0
  state.rushed = false
  state.rushPending = false
  state.autoCount = AUTO_CONFIRM_MS / 1_000
  state.filedBy = "auto-confirm"
}

function confirm(state: OutboxState, event: Extract<OutboxEvent, { kind: "confirm" }>, commands: OutboxCommand[]): void {
  if (
    state.phase === "confirmed" ||
    state.phase === "missed" ||
    state.chainClosed ||
    state.locked ||
    state.submitted ||
    !state.inputs.confirmReady ||
    !windowOpen(state, event.clock)
  ) return
  if (!state.inputs.hasSubmitPath) {
    state.autoCancelled = true
    state.phase = "error"
    return
  }
  state.generation++
  state.locked = true
  state.report = event.report.map((round) => [...round])
  state.filedBy = event.filedBy
  state.attempts = 1
  state.attemptStartedAt = null
  state.phase = "submitting"
  commands.push({ kind: "submit", report: state.report, generation: state.generation, attempt: 1 })
}

function clockTick(state: OutboxState, clock: OutboxClock, commands: OutboxCommand[]): void {
  if (state.phase !== "countdown" && state.phase !== "beat") return

  const lastCall = lastCallAt(state, clock)
  const hardStop = state.hardStopAt ?? clock.monotonicMs
  const beatAt = state.beatAt ?? hardStop - AUTO_CONFIRM_BEAT_MS
  const plannedFire = state.fireAt ?? hardStop
  if (
    clock.monotonicMs < lastCall &&
    (((state.restartCapSlackMs === 0 || clock.chainAnchored) &&
      plannedFire > lastCall + state.restartCapSlackMs + CONFIRM_CLOCK_READ_TOLERANCE_MS) ||
      (!state.restartOwnsDeadline && plannedFire >= lastCall))
  ) {
    state.autoCount = 0
    commands.push({ kind: "confirm", filedBy: state.rushed || state.rushPending ? "tap" : state.filedBy })
    state.phase = "idle"
    return
  }
  if (state.rushPending) {
    state.rushPending = false
    state.rushed = true
    commands.push({ kind: "rush-consumed" })
    state.filedBy = "tap"
    state.phase = "beat"
    state.autoCount = 0
    state.beatAt = clock.monotonicMs
    state.fireAt ??= Math.min(clock.monotonicMs + AUTO_CONFIRM_BEAT_MS, hardStop)
  }
  const activeBeatAt = state.beatAt ?? beatAt
  if (clock.monotonicMs < activeBeatAt) {
    state.autoCount = Math.ceil((activeBeatAt - clock.monotonicMs) / 1_000)
    return
  }
  state.autoCount = 0
  state.phase = "beat"
  state.fireAt ??= Math.min(clock.monotonicMs + AUTO_CONFIRM_BEAT_MS, hardStop)
  if (clock.monotonicMs >= state.fireAt) {
    commands.push({ kind: "confirm", filedBy: state.filedBy })
    state.phase = "idle"
  }
}

/** One pure transition. The input state is never mutated. */
export function reportOutbox(before: OutboxState, event: OutboxEvent): OutboxResult {
  const state: OutboxState = { ...before, inputs: { ...before.inputs }, report: before.report?.map((r) => [...r]) ?? null }
  const commands: OutboxCommand[] = []
  if ((state.phase === "confirmed" || state.phase === "missed") && event.kind !== "unmounted")
    return { state, commands }
  if (state.chainClosed && event.kind !== "unmounted") return { state, commands }
  switch (event.kind) {
    case "sync": {
      const wasConfirming = state.inputs.confirming
      state.inputs = { ...event.inputs }
      if (!event.inputs.confirming && wasConfirming) {
        state.phase = "idle"
        state.hardStopAt = null
        state.beatAt = null
        state.fireAt = null
      } else if (canAuto(state, event.clock) && state.phase === "idle") arm(state, event.clock)
      if (event.inputs.confirming && !windowOpen(state, event.clock) && !state.submitted && !state.locked && state.phase !== "handover") {
        state.phase = "handover"
        commands.push({ kind: "poll-handover", delayMs: 0 })
      }
      break
    }
    case "countdown-started":
      state.inputs = { ...event.inputs }
      if (canAuto(state, event.clock)) arm(state, event.clock)
      break
    case "tick":
      clockTick(state, event.clock, commands)
      break
    case "release-tick": {
      const releaseAt = state.inputs.reportEndsMs === undefined
        ? Infinity
        : state.inputs.reportEndsMs - CONFIRM_REPORT_MARGIN_MS - CONFIRM_RELEASE_LEAD_MS
      if (state.inputs.confirming && !state.inputs.confirmReady && !state.confirmReleased && event.clock.gameMs >= releaseAt) {
        state.confirmReleased = true
        commands.push({ kind: "confirm-release" })
      }
      break
    }
    case "verdict-changed": {
      if (state.rushed || !canAuto(state, event.clock)) break
      const stop = Math.min(event.clock.monotonicMs + AUTO_CONFIRM_MS, lastCallAt(state, event.clock) + event.capSlackMs)
      state.phase = "countdown"
      state.hardStopAt = stop
      state.beatAt = stop - AUTO_CONFIRM_BEAT_MS
      state.fireAt = null
      state.restartOwnsDeadline = true
      state.restartCapSlackMs = event.capSlackMs
      state.autoCount = Math.ceil(Math.max(0, state.beatAt - event.clock.monotonicMs) / 1_000)
      state.filedBy = "auto-confirm"
      break
    }
    case "rush-confirm":
      if (canAuto(state, event.clock)) {
        state.rushPending = true
      }
      break
    case "confirm":
      confirm(state, event, commands)
      break
    case "hidden":
      if (!state.inputs.confirming && state.hiddenAtLatchMs === null) {
        state.hiddenAtLatchMs = event.clock.latchMs
        state.awayPending = true
      }
      break
    case "away-threshold":
      markAway(state, commands)
      break
    case "away-reset":
      state.hiddenAtLatchMs = null
      state.awayPending = false
      break
    case "shown":
      if (state.hiddenAtLatchMs !== null && event.clock.latchMs - state.hiddenAtLatchMs >= AUTO_CONFIRM_AWAY_THRESHOLD_MS)
        markAway(state, commands)
      state.hiddenAtLatchMs = null
      state.awayPending = false
      if (canAuto(state, event.clock) && state.phase === "idle") arm(state, event.clock)
      break
    case "froze-away":
    case "stored-away":
      markAway(state, commands)
      break
    case "host-chain-lost":
      state.retryRush = true
      break
    case "save-votes": {
      if (state.submitted) break
      const serialised = JSON.stringify(event.entry)
      if (serialised === state.lastSaved) break
      state.lastSaved = serialised
      commands.push({ kind: "save-votes", entry: event.entry })
      break
    }
    case "attempt-result": {
      if (state.chainClosed || event.generation !== state.generation || state.phase !== "submitting") break
      if (event.result === "sent") {
        state.submitted = true
        state.phase = "confirmed"
        commands.push({ kind: "finish-report" }, { kind: "clear-votes" })
        break
      }
      const detail = event.detail ?? (event.result === "refused" ? "report submission failed" : "the report window closed before the report landed")
      const reason: SubmitFailureReason = event.result === "closed" ? "timeout" : "refused"
      if (event.result === "chain-closed") state.chainClosed = true
      if (event.result !== "chain-closed" && windowOpen(state, event.clock)) {
        const delayMs = state.retryRush
          ? 0
          : Math.max(0, REPORT_RETRY_MS - (event.clock.monotonicMs - (state.attemptStartedAt ?? event.clock.monotonicMs)))
        state.retryRush = false
        state.phase = "retry-wait"
        commands.push({ kind: "schedule-retry", delayMs, generation: state.generation })
      } else {
        state.terminalFailure ??= { detail, reason }
        state.autoCancelled = true
        state.phase = "error"
        commands.push({ kind: "terminal-failure", detail, reason })
      }
      break
    }
    case "attempt-started":
      if (event.generation === state.generation && state.phase === "submitting")
        state.attemptStartedAt = event.monotonicMs
      break
    case "retry-fired":
      if (state.chainClosed || event.generation !== state.generation || state.phase !== "retry-wait" || !state.report) break
      if (!windowOpen(state, event.clock)) {
        state.phase = "error"
        const failure = state.terminalFailure ?? { detail: "the report window closed before the report landed", reason: "timeout" as const }
        state.terminalFailure = failure
        commands.push({ kind: "terminal-failure", ...failure })
      } else {
        state.attempts++
        state.attemptStartedAt = null
        state.phase = "submitting"
        commands.push({ kind: "submit", report: state.report, generation: state.generation, attempt: state.attempts })
      }
      break
    case "handover-started":
      state.handoverPauseMs = HANDOVER_POLL_MS
      break
    case "handover-result":
      if (state.phase !== "handover") break
      if (event.result === "sent") {
        state.submitted = true
        state.phase = "confirmed"
        commands.push({ kind: "finish-report" }, { kind: "clear-votes" })
      } else if (event.result === "missed" || event.result === "gone") {
        state.phase = "missed"
        commands.push({ kind: "navigate-collectables", missed: event.result === "missed" })
      } else {
        state.phase = "handover"
        commands.push({ kind: "poll-handover", delayMs: state.handoverPauseMs })
        state.handoverPauseMs = Math.min(state.handoverPauseMs * 2, 10_000)
      }
      break
    case "unmounted":
      state.generation++
      state.locked = true
      break
  }
  return { state, commands }
}
