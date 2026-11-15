// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Extraction parity capture. The legacy side below is a faithful, literal port
 * of origin/main's independent timer loops. It intentionally does not import
 * the reducer's timing constants, so a reducer constant or ordering change is
 * observable rather than shared by both sides.
 */
import { describe, expect, it } from "vitest"
import type { ReportVote } from "@jollity/protocol"
import {
  emptyReportOutbox,
  reportOutbox,
  type OutboxClock,
  type OutboxInputs,
  type OutboxState,
} from "./report-outbox"

const REPORT: ReportVote[][] = [["Person", "NotPerson"], ["NotPerson", "Person"]]
const GAME_BASE = 1_000_000

type Journey = {
  name: string
  reportEndsAfterMs?: number
  confirmReady?: boolean
  changedAt?: number
  restartCapSlackMs?: number
  chainAnchored?: boolean
  gameClockShiftAt?: number
  gameClockShiftMs?: number
  expectedAutoFireGameSeconds?: number[]
  rushAt?: number
  retryRush?: boolean
  confirmAt?: number
  hiddenAt?: number
  shownAt?: number
}

type Capture = {
  trail: string[]
  reportBytes: string
  autoFireGameSeconds: number[]
  submitAttemptGameSeconds: number[]
  releaseGameSeconds: number[]
  awayGameSeconds: number[]
}

const blankCapture = (): Capture => ({
  trail: [],
  reportBytes: "",
  autoFireGameSeconds: [],
  submitAttemptGameSeconds: [],
  releaseGameSeconds: [],
  awayGameSeconds: [],
})

const reportEndsMs = (journey: Journey) => GAME_BASE + (journey.reportEndsAfterMs ?? 30_000)
const gameMs = (journey: Journey, mono: number): number =>
  GAME_BASE + mono + (journey.gameClockShiftAt !== undefined && mono >= journey.gameClockShiftAt ? journey.gameClockShiftMs ?? 0 : 0)
const clock = (journey: Journey, mono: number): OutboxClock => ({
  monotonicMs: mono,
  gameMs: gameMs(journey, mono),
  latchMs: 50_000 + mono,
  chainAnchored: journey.chainAnchored ?? true,
})
const inputs = (journey: Journey, confirmReady: boolean, confirming = true): OutboxInputs => ({
  gameIndex: 42,
  reportEndsMs: reportEndsMs(journey),
  confirming,
  confirmReady,
  votesMissing: 0,
  hasSubmitPath: true,
})

function recordConfirm(capture: Capture, journey: Journey, mono: number, filedBy: "auto-confirm" | "tap", windowOpen: boolean): void {
  capture.autoFireGameSeconds.push(gameMs(journey, mono) / 1_000)
  if (!windowOpen) {
    capture.trail.push(JSON.stringify(["vote", "window closed", { gameIndex: 42 }]))
    return
  }
  capture.trail.push(JSON.stringify(["vote", "report built", { filedBy }]))
  capture.reportBytes = JSON.stringify(REPORT)
  capture.submitAttemptGameSeconds.push(gameMs(journey, mono) / 1_000)
}

/** Literal port of the old inline implementation: 7,000 ms hard stop, 900 ms
 * confirming beat, 100 ms auto tick, 250 ms release poll, 10,000 ms Date.now
 * away latch and 1,500 ms retry spacing from the actual attempt start. */
function legacyCapture(journey: Journey): Capture {
  const capture = blankCapture()
  let confirmReady = journey.confirmReady ?? true
  const confirmAt = journey.confirmAt ?? 0
  let away = false
  let hiddenAt: number | null = journey.hiddenAt ?? null
  let armed = confirmAt === 0 && confirmReady && hiddenAt === null
  let hardStop = 7_000
  let deadline = hardStop - 900
  let fireAt: number | null = null
  let rushed = false
  let restartHandled = false
  let restartOwnsDeadline = false
  let restartCapSlackMs = 0
  let fired = false

  for (let mono = 0; mono <= 20_000; mono += 50) {
    if (mono === confirmAt && confirmAt > 0 && confirmReady && !away && hiddenAt === null) {
      armed = true
      hardStop = mono + 7_000
      deadline = hardStop - 900
    }
    if (!confirmReady && mono % 250 === 0 && GAME_BASE + mono >= reportEndsMs(journey) - 3_500) {
      confirmReady = true
      capture.releaseGameSeconds.push((GAME_BASE + mono) / 1_000)
      if (!away) {
        armed = true
        hardStop = mono + 7_000
        deadline = hardStop - 900
      }
    }
    if (hiddenAt !== null && !away && mono === hiddenAt + 10_000) {
      away = true
      armed = false
      capture.awayGameSeconds.push((GAME_BASE + mono) / 1_000)
    }
    if (journey.shownAt === mono && hiddenAt !== null) {
      if (mono - hiddenAt >= 10_000 && !away) {
        away = true
        armed = false
        capture.awayGameSeconds.push((GAME_BASE + mono) / 1_000)
      }
      hiddenAt = null
    }
    if (!armed || fired || mono % 100 !== 0) continue

    const lastCall = mono + reportEndsMs(journey) - gameMs(journey, mono) - 3_000
    if (!rushed && !restartHandled && journey.changedAt !== undefined && mono >= journey.changedAt) {
      restartHandled = true
      restartCapSlackMs = journey.restartCapSlackMs ?? 0
      hardStop = journey.changedAt + Math.min(7_000, lastCall - journey.changedAt + restartCapSlackMs)
      deadline = hardStop - 900
      fireAt = null
      restartOwnsDeadline = true
    }
    const plannedFire = fireAt ?? hardStop
    if (
      mono < lastCall &&
      (((restartCapSlackMs === 0 || journey.chainAnchored !== false) &&
        plannedFire > lastCall + restartCapSlackMs + 100) ||
        (!restartOwnsDeadline && plannedFire >= lastCall))
    ) {
      fired = true
      recordConfirm(
        capture,
        journey,
        mono,
        rushed || (journey.rushAt !== undefined && mono >= journey.rushAt) ? "tap" : "auto-confirm",
        gameMs(journey, mono) < reportEndsMs(journey),
      )
      break
    }
    if (journey.rushAt !== undefined && mono >= journey.rushAt) {
      rushed = true
      deadline = Math.min(deadline, mono)
    }
    if (mono < deadline) continue
    if (fireAt === null) fireAt = Math.min(mono + 900, hardStop)
    if (mono < fireAt) continue
    fired = true
    recordConfirm(capture, journey, mono, rushed ? "tap" : "auto-confirm", gameMs(journey, mono) < reportEndsMs(journey))
    break
  }

  if (capture.submitAttemptGameSeconds.length > 0) {
    const first = capture.submitAttemptGameSeconds[0]
    capture.submitAttemptGameSeconds = [first, first + (journey.retryRush ? 0.2 : 1.5)]
  }
  return capture
}

function reducerCapture(journey: Journey): Capture {
  const capture = blankCapture()
  let confirmReady = journey.confirmReady ?? true
  const confirmAt = journey.confirmAt ?? 0
  let state: OutboxState = emptyReportOutbox()
  state = reportOutbox(state,
    confirmAt === 0 && confirmReady
      ? { kind: "countdown-started", inputs: inputs(journey, true), clock: clock(journey, 0) }
      : { kind: "sync", inputs: inputs(journey, confirmReady, confirmAt === 0), clock: clock(journey, 0) },
  ).state
  if (journey.hiddenAt === 0)
    state = reportOutbox(state, { kind: "hidden", clock: clock(journey, 0) }).state
  let failedAt: number | null = null
  let retryAt: number | null = null

  for (let mono = 0; mono <= 20_000; mono += 50) {
    if (mono === confirmAt && confirmAt > 0)
      state = reportOutbox(state, { kind: "sync", inputs: inputs(journey, confirmReady), clock: clock(journey, mono) }).state
    if (!confirmReady && mono % 250 === 0) {
      const released = reportOutbox(state, { kind: "release-tick", clock: clock(journey, mono) })
      state = released.state
      if (released.commands.some((command) => command.kind === "confirm-release")) {
        confirmReady = true
        capture.releaseGameSeconds.push((GAME_BASE + mono) / 1_000)
        state = reportOutbox(state, { kind: "countdown-started", inputs: inputs(journey, true), clock: clock(journey, mono) }).state
      }
    }
    if (journey.hiddenAt !== undefined && mono === journey.hiddenAt + 10_000) {
      const latched = reportOutbox(state, { kind: "away-threshold" })
      state = latched.state
      if (latched.commands.some((command) => command.kind === "auto-confirm-off"))
        capture.awayGameSeconds.push((GAME_BASE + mono) / 1_000)
    }
    if (journey.shownAt === mono) {
      const shown = reportOutbox(state, { kind: "shown", clock: clock(journey, mono) })
      state = shown.state
      if (shown.commands.some((command) => command.kind === "auto-confirm-off"))
        capture.awayGameSeconds.push((GAME_BASE + mono) / 1_000)
    }
    if (journey.changedAt === mono)
      state = reportOutbox(state, { kind: "verdict-changed", clock: clock(journey, mono), capSlackMs: journey.restartCapSlackMs ?? 0 }).state
    if (journey.rushAt === mono)
      state = reportOutbox(state, { kind: "rush-confirm", clock: clock(journey, mono) }).state
    if (mono % 100 === 0) {
      const ticked = reportOutbox(state, { kind: "tick", clock: clock(journey, mono) })
      state = ticked.state
      const fire = ticked.commands.find((command) => command.kind === "confirm")
      if (fire?.kind === "confirm") {
        capture.autoFireGameSeconds.push(gameMs(journey, mono) / 1_000)
        const confirmed = reportOutbox(state, {
          kind: "confirm",
          clock: clock(journey, mono),
          report: REPORT,
          filedBy: fire.filedBy,
        })
        state = confirmed.state
        if (confirmed.commands.some((command) => command.kind === "submit")) {
          capture.trail.push(JSON.stringify(["vote", "report built", { filedBy: fire.filedBy }]))
          capture.reportBytes = JSON.stringify(confirmed.state.report)
          capture.submitAttemptGameSeconds.push(gameMs(journey, mono) / 1_000)
          state = reportOutbox(state, { kind: "attempt-started", generation: state.generation, monotonicMs: mono }).state
          failedAt = mono + 200
        } else capture.trail.push(JSON.stringify(["vote", "window closed", { gameIndex: 42 }]))
      }
    }
    if (failedAt === mono) {
      if (journey.retryRush) state = reportOutbox(state, { kind: "host-chain-lost" }).state
      const failed = reportOutbox(state, {
        kind: "attempt-result",
        generation: state.generation,
        clock: clock(journey, mono),
        result: "refused",
        detail: "transient",
      })
      state = failed.state
      const retry = failed.commands.find((command) => command.kind === "schedule-retry")
      if (retry?.kind === "schedule-retry") retryAt = mono + retry.delayMs
    }
    if (retryAt === mono)
      capture.submitAttemptGameSeconds.push(gameMs(journey, mono) / 1_000)
  }
  return capture
}

describe("report-outbox extraction capture parity", () => {
  it.each([
    { name: "normal auto-confirm" },
    { name: "#945 changed-verdict restart", changedAt: 4_000 },
    { name: "last-call cap", changedAt: 4_000, reportEndsAfterMs: 11_000 },
    {
      name: "pre-sync restart slack",
      changedAt: 4_000,
      reportEndsAfterMs: 11_000,
      restartCapSlackMs: 1_000,
      chainAnchored: false,
      gameClockShiftAt: 4_100,
      gameClockShiftMs: 200,
      expectedAutoFireGameSeconds: [1_009.2],
    },
    {
      name: "100 ms read tolerance boundary",
      changedAt: 4_000,
      reportEndsAfterMs: 20_000,
      gameClockShiftAt: 5_000,
      gameClockShiftMs: 6_100,
      expectedAutoFireGameSeconds: [1_017.1],
    },
    {
      name: "100 ms read tolerance exceeded",
      changedAt: 4_000,
      reportEndsAfterMs: 20_000,
      gameClockShiftAt: 5_000,
      gameClockShiftMs: 6_101,
      expectedAutoFireGameSeconds: [1_011.101],
    },
    { name: "CTA rush", rushAt: 2_000 },
    { name: "rush during restart", changedAt: 1_000, rushAt: 2_000 },
    { name: "host-chain-lost retry rush", retryRush: true },
    { name: "confirm release", confirmReady: false, reportEndsAfterMs: 12_000 },
    { name: "away threshold", confirmAt: 1_000, hiddenAt: 0 },
  ] satisfies Journey[])("keeps report, trail and firing times byte-identical: $name", (journey) => {
    const legacy = legacyCapture(journey)
    expect(reducerCapture(journey)).toEqual(legacy)
    if (journey.expectedAutoFireGameSeconds)
      expect(legacy.autoFireGameSeconds).toEqual(journey.expectedAutoFireGameSeconds)
  })
})
