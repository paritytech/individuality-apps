// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import type { ReportVote } from "@jollity/protocol"
import {
  AUTO_CONFIRM_AWAY_THRESHOLD_MS,
  AUTO_CONFIRM_MS,
  emptyReportOutbox,
  reportOutbox,
  type OutboxClock,
  type OutboxEvent,
  type OutboxInputs,
  type OutboxState,
} from "./report-outbox"

const report: ReportVote[][] = [["Person", "NotPerson"]]
const inputs = (patch: Partial<OutboxInputs> = {}): OutboxInputs => ({
  gameIndex: 7,
  reportEndsMs: 30_000,
  confirming: true,
  confirmReady: true,
  votesMissing: 0,
  hasSubmitPath: true,
  ...patch,
})
const at = (ms: number, gameMs = ms, latchMs = ms): OutboxClock => ({ monotonicMs: ms, gameMs, latchMs, chainAnchored: true })
const step = (state: OutboxState, event: OutboxEvent) => reportOutbox(state, event)
const synced = (patch: Partial<OutboxInputs> = {}, clock = at(0)) =>
  step(emptyReportOutbox(), { kind: "sync", inputs: inputs(patch), clock }).state

describe("report outbox contract", () => {
  it("files at most one immutable report per game", () => {
    const first = step(synced(), { kind: "confirm", clock: at(1_000), report, filedBy: "tap" })
    expect(first.commands).toEqual([{ kind: "submit", report, generation: 1, attempt: 1 }])
    report[0][0] = "NotPerson"
    const second = step(first.state, { kind: "confirm", clock: at(1_001), report: [["NotPerson"]], filedBy: "tap" })
    expect(second.commands).toEqual([])
    expect(first.state.report).toEqual([["Person", "NotPerson"]])
  })

  it("sends nothing once report_ends has passed", () => {
    const result = step(synced({}, at(31_000)), {
      kind: "confirm",
      clock: at(31_000),
      report: [["Person"]],
      filedBy: "tap",
    })
    expect(result.commands).toEqual([])
  })

  it("files exactly the projection frozen at confirm", () => {
    const projection: ReportVote[][] = [["Person", "NotPerson"], ["NotPerson"]]
    const result = step(synced(), { kind: "confirm", clock: at(1_000), report: projection, filedBy: "auto-confirm" })
    expect(result.commands[0]).toMatchObject({ kind: "submit", report: projection })
    expect(result.state.report).toEqual(projection)
  })

  it("builds and sends nothing before the books settle", () => {
    const state = synced({ confirmReady: false })
    const result = step(state, { kind: "confirm", clock: at(1_000), report, filedBy: "tap" })
    expect(result.commands).toEqual([])
    expect(result.state.report).toBeNull()
  })

  it("O1: a double tap submits the frozen report only once", () => {
    const first = step(synced(), { kind: "confirm", clock: at(1_000), report, filedBy: "tap" })
    const second = step(first.state, { kind: "confirm", clock: at(1_001), report, filedBy: "tap" })
    expect(first.commands).toEqual([{ kind: "submit", report, generation: 1, attempt: 1 }])
    expect(second.commands).toEqual([])
    expect(second.state.generation).toBe(1)
    expect(second.state.attempts).toBe(1)
  })

  it("O3: missed and confirmed sequences never submit or finish again", () => {
    const handover = synced({}, at(31_000))
    const missed = step(handover, { kind: "handover-result", result: "missed" })
    const afterMiss = [
      { kind: "confirm", clock: at(1_000), report, filedBy: "tap" } as const,
      { kind: "sync", inputs: inputs(), clock: at(1_001) } as const,
      { kind: "handover-result", result: "sent" } as const,
    ].reduce((current, event) => {
      const next = step(current, event)
      expect(next.commands.filter((command) => command.kind === "submit" || command.kind === "finish-report")).toEqual([])
      return next.state
    }, missed.state)
    expect(afterMiss.phase).toBe("missed")

    const submitting = step(synced(), { kind: "confirm", clock: at(1_000), report, filedBy: "tap" })
    const confirmed = step(submitting.state, {
      kind: "attempt-result",
      generation: submitting.state.generation,
      clock: at(1_100),
      result: "sent",
    })
    const afterConfirmed = [
      { kind: "confirm", clock: at(1_200), report, filedBy: "tap" } as const,
      { kind: "handover-result", result: "sent" } as const,
      { kind: "sync", inputs: inputs(), clock: at(1_201) } as const,
    ].reduce((current, event) => {
      const next = step(current, event)
      expect(next.commands.filter((command) => command.kind === "submit" || command.kind === "finish-report")).toEqual([])
      return next.state
    }, confirmed.state)
    expect(afterConfirmed.phase).toBe("confirmed")
  })

  it("drops stale attempt results after a newer generation", () => {
    const submitting = step(synced(), { kind: "confirm", clock: at(1_000), report, filedBy: "tap" }).state
    const unmounted = step(submitting, { kind: "unmounted" }).state
    const stale = step(unmounted, { kind: "attempt-result", generation: 1, clock: at(2_000), result: "sent" })
    expect(stale.commands).toEqual([])
    expect(stale.state.submitted).toBe(false)
  })
})

describe("report outbox clocks", () => {
  it("fires auto-confirm at seven monotonic seconds and records game-clock timing", () => {
    let state = synced()
    const fires: number[] = []
    for (let ms = 0; ms <= AUTO_CONFIRM_MS; ms += 100) {
      const result = step(state, { kind: "tick", clock: at(ms, 10_000 + ms) })
      state = result.state
      if (result.commands.some((command) => command.kind === "confirm")) fires.push((10_000 + ms) / 1_000)
    }
    expect(fires).toEqual([17])
  })

  it("restarts from a changed verdict but caps the fire at the last call (#945)", () => {
    let state = synced({ reportEndsMs: 15_000 })
    state = step(state, { kind: "verdict-changed", clock: at(5_000), capSlackMs: 0 }).state
    const fires: number[] = []
    for (let ms = 5_000; ms <= 13_000; ms += 100) {
      const result = step(state, { kind: "tick", clock: at(ms) })
      state = result.state
      if (result.commands.some((command) => command.kind === "confirm")) fires.push(ms / 1_000)
    }
    expect(fires).toEqual([12])
  })

  it("does not restart after a CTA rush has entered the confirming beat", () => {
    let state = synced()
    state = step(state, { kind: "rush-confirm", clock: at(2_000) }).state
    const consumed = step(state, { kind: "tick", clock: at(2_000) })
    expect(consumed.commands).toContainEqual({ kind: "rush-consumed" })
    state = consumed.state
    state = step(state, { kind: "verdict-changed", clock: at(2_100), capSlackMs: 0 }).state
    const before = step(state, { kind: "tick", clock: at(2_800) })
    const fire = step(before.state, { kind: "tick", clock: at(2_900) })
    expect(before.commands).toEqual([])
    expect(fire.commands).toContainEqual({ kind: "confirm", filedBy: "tap" })
  })

  it("O1: repeated CTA taps keep the first rush deadline", () => {
    let state = synced()
    state = step(state, { kind: "rush-confirm", clock: at(2_000) }).state
    state = step(state, { kind: "tick", clock: at(2_000) }).state
    expect(state.fireAt).toBe(2_900)

    state = step(state, { kind: "rush-confirm", clock: at(2_400) }).state
    state = step(state, { kind: "tick", clock: at(2_400) }).state
    expect(state.fireAt).toBe(2_900)
    expect(step(state, { kind: "tick", clock: at(2_899) }).commands).toEqual([])
    expect(step(state, { kind: "tick", clock: at(2_900) }).commands).toContainEqual({ kind: "confirm", filedBy: "tap" })
  })

  it("still hands the adapter a confirm after a source-clock jump closes the window", () => {
    const state = synced({ reportEndsMs: 30_000 })
    const result = step(state, { kind: "tick", clock: at(7_000, 31_000) })
    expect(result.commands).toContainEqual({ kind: "confirm", filedBy: "auto-confirm" })
  })

  it("keeps away, confirm release and countdown ticks as separate effects", () => {
    let state = synced({ confirming: false, confirmReady: false })
    state = step(state, { kind: "hidden", clock: at(0, 0, 5_000) }).state
    const release = step(state, { kind: "release-tick", clock: at(50_000, 26_500, 15_000) })
    expect(release.commands).toEqual([])
    expect(release.state.away).toBe(false)
    const away = step(release.state, { kind: "away-threshold" })
    expect(away.commands).toEqual([{ kind: "auto-confirm-off" }])
    expect(away.state.away).toBe(true)
  })

  it("clears the reducer's hidden stamp when the owning effect resets", () => {
    let state = synced({ confirming: false })
    state = step(state, { kind: "hidden", clock: at(0, 0, 5_000) }).state
    state = step(state, { kind: "away-reset" }).state
    expect(state.hiddenAtLatchMs).toBeNull()
    expect(state.awayPending).toBe(false)
  })

  it("releases confirm without consuming an away command", () => {
    let state = synced({ confirmReady: false, reportEndsMs: 20_000 })
    state = step(state, { kind: "hidden", clock: at(0, 0, 5_000) }).state
    const release = step(state, { kind: "release-tick", clock: at(2_000, 16_500, 15_000) })
    expect(release.commands).toEqual([{ kind: "confirm-release" }])
    expect(release.state.away).toBe(false)
  })

  it("preserves Date.now semantics for the ten-second away latch", () => {
    let state = synced({ confirming: false })
    state = step(state, { kind: "hidden", clock: at(1_000, 1_000, 50_000) }).state
    const before = step(state, { kind: "shown", clock: at(50_000, 50_000, 50_000 + AUTO_CONFIRM_AWAY_THRESHOLD_MS - 1) })
    expect(before.state.away).toBe(false)
    const atThreshold = step(state, { kind: "shown", clock: at(50_001, 50_001, 50_000 + AUTO_CONFIRM_AWAY_THRESHOLD_MS) })
    expect(atThreshold.state.away).toBe(true)
    expect(atThreshold.commands).toContainEqual({ kind: "auto-confirm-off" })
  })

  it("releases confirm on the game clock and rushes only a later retry", () => {
    let state = synced({ confirmReady: false, reportEndsMs: 20_000 })
    const release = step(state, { kind: "release-tick", clock: at(2_000, 16_500) })
    expect(release.commands).toContainEqual({ kind: "confirm-release" })
    state = step(release.state, { kind: "sync", inputs: inputs({ confirmReady: true, reportEndsMs: 20_000 }), clock: at(2_000, 16_000) }).state
    state = step(state, { kind: "host-chain-lost" }).state
    state = step(state, { kind: "confirm", clock: at(2_100, 16_100), report, filedBy: "tap" }).state
    const failed = step(state, { kind: "attempt-result", generation: state.generation, clock: at(2_200, 16_200), result: "refused" })
    expect(failed.commands).toContainEqual({ kind: "schedule-retry", delayMs: 0, generation: state.generation })
  })

  it("hands over after the window and backs off polls", () => {
    const state = synced({}, at(31_000))
    expect(state.phase).toBe("handover")
    const pending = step(state, { kind: "handover-result", result: "pending" })
    expect(pending.commands).toEqual([{ kind: "poll-handover", delayMs: 2_500 }])
    const missed = step(pending.state, { kind: "handover-result", result: "missed" })
    expect(missed.commands).toEqual([{ kind: "navigate-collectables", missed: true }])
  })

  it("resets handover backoff when the owning effect restarts", () => {
    let state = synced({}, at(31_000))
    state = step(state, { kind: "handover-result", result: "pending" }).state
    expect(step(state, { kind: "handover-result", result: "pending" }).commands).toEqual([
      { kind: "poll-handover", delayMs: 5_000 },
    ])
    state = step(state, { kind: "handover-started" }).state
    expect(step(state, { kind: "handover-result", result: "pending" }).commands).toEqual([
      { kind: "poll-handover", delayMs: 2_500 },
    ])
  })

  it("restarts the countdown when its owning effect restarts", () => {
    let state = synced()
    state = step(state, { kind: "tick", clock: at(2_000) }).state
    state = step(state, { kind: "countdown-started", inputs: inputs(), clock: at(2_000) }).state
    const before = step(state, { kind: "tick", clock: at(8_900) })
    const fire = step(before.state, { kind: "tick", clock: at(9_000) })
    expect(before.commands).toEqual([])
    expect(fire.commands).toContainEqual({ kind: "confirm", filedBy: "auto-confirm" })
  })

  it("measures retry spacing from the actual submit attempt start", () => {
    let state = step(synced(), { kind: "confirm", clock: at(1_000), report, filedBy: "tap" }).state
    state = step(state, { kind: "attempt-started", generation: state.generation, monotonicMs: 1_007 }).state
    const failed = step(state, {
      kind: "attempt-result",
      generation: state.generation,
      clock: at(1_207),
      result: "refused",
    })
    expect(failed.commands).toContainEqual({ kind: "schedule-retry", delayMs: 1_300, generation: state.generation })
  })
})
