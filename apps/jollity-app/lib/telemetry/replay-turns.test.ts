// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it, vi } from "vitest"
import { calculateSnapshot } from "@jollity/game-chain/game"
import { createReplayTurnObserver, type ReplayTurnCommit } from "./replay-turns"

const timing = { gameDate: 1000, reportEnds: 1200, rounds: 2, maxGroupSize: 4 }
function commit(seconds: number, over: Partial<ReplayTurnCommit> = {}): ReplayTurnCommit {
  const snapshot = calculateSnapshot(1000 + seconds, timing)
  return {
    gameIndex: 7,
    timing,
    roomKey: "g7:alice_bob",
    meshRound: snapshot.kind === "round" ? snapshot.round : 0,
    hostId: snapshot.kind === "round" ? `seat:${snapshot.hostPosition}` : null,
    clockReady: true,
    sourceClockReady: true,
    snapshot,
    sourceNowSeconds: 1000 + seconds,
    commitMonotonicMs: seconds * 1000,
    ...over,
  }
}

describe("committed replay turn observations", () => {
  it("records initial position and planned boundaries without inventing prior attendance", () => {
    const emit = vi.fn()
    const observer = createReplayTurnObserver(emit)
    observer.observe(commit(69)) // round 1, host 1 gameplay; round starts at +55
    expect(emit).toHaveBeenCalledTimes(1)
    expect(emit.mock.calls[0]).toEqual(["game.snapshot", expect.objectContaining({
      observation: "initial",
      previous: null,
      skippedTurnCount: 0,
      current: expect.objectContaining({ round: 1, globalTurn: 5, hostPosition: 1, stage: "gameplay" }),
      planned: expect.objectContaining({
        roundStartSeconds: 1055, roundEndSeconds: 1103,
        turnStartSeconds: 1067, turnEndSeconds: 1079,
        stageStartSeconds: 1069, stageEndSeconds: 1077,
      }),
      configuration: expect.objectContaining({ turnIndexBase: 0, turnIndexStride: 4, hostFullCycleSeconds: 12 }),
    })])
  })

  it("suppresses stable countdown ticks but records stage/host/readiness/room changes", () => {
    const emit = vi.fn()
    const observer = createReplayTurnObserver(emit)
    observer.observe(commit(2))
    for (let sec = 2.5; sec <= 9.5; sec += 0.5) observer.observe(commit(sec))
    expect(emit).toHaveBeenCalledTimes(1)
    observer.observe(commit(10))
    observer.observe(commit(12))
    observer.observe(commit(12, { clockReady: false, sourceClockReady: false }))
    observer.observe(commit(12, { clockReady: true, sourceClockReady: true, roomKey: "g7:new" }))
    expect(emit).toHaveBeenCalledTimes(5)
    expect(emit.mock.calls[4][1]).toMatchObject({ observation: "resume", resumed: true,
      previous: { clockReady: false }, current: { roomKey: "g7:new", clockReady: true } })
  })

  it("reports freeze jumps as old/new only, with genuinely unobserved turn ranges", () => {
    const emit = vi.fn()
    const observer = createReplayTurnObserver(emit)
    observer.observe(commit(3))
    observer.observe(commit(39))
    expect(emit).toHaveBeenCalledTimes(2)
    expect(emit.mock.calls[1][1]).toMatchObject({
      observation: "catch-up", gapObserved: true, intermediateStagesObserved: false,
      previous: { globalTurn: 0 }, current: { globalTurn: 3 },
      skippedTurnCount: 2, unobservedCompletedTurnRanges: [{ from: 1, toExclusive: 3 }],
    })
    // No generated observations at the missed turn starts or synthetic endings.
    expect(emit.mock.calls.map(([, row]) => row.current.globalTurn)).toEqual([0, 3])
  })

  it("records backward revisits and excludes earlier visited turns from later catch-up", () => {
    const emit = vi.fn()
    const observer = createReplayTurnObserver(emit)
    observer.observe(commit(25, { commitMonotonicMs: 1 }))
    observer.observe(commit(1, { commitMonotonicMs: 2 }))
    observer.observe(commit(39, { commitMonotonicMs: 3 }))
    expect(emit.mock.calls[1][1]).toMatchObject({ observation: "backward", skippedTurnCount: 0 })
    expect(emit.mock.calls[2][1]).toMatchObject({
      observation: "catch-up", skippedTurnCount: 1,
      unobservedCompletedTurnRanges: [{ from: 1, toExclusive: 2 }],
    })
  })

  it("distinguishes skipped stages from an ordinary adjacent turn boundary", () => {
    const emit = vi.fn()
    const observer = createReplayTurnObserver(emit)
    observer.observe(commit(10, { commitMonotonicMs: 1 }))
    observer.observe(commit(12, { commitMonotonicMs: 2 }))
    expect(emit.mock.calls[1][1].observation).toBe("transition")
    observer.observe(commit(22, { commitMonotonicMs: 3 }))
    expect(emit.mock.calls[2][1]).toMatchObject({ observation: "catch-up", skippedTurnCount: 0, stageSequenceSkipped: true })
  })

  it("detects gap-to-reporting jumps without inventing visits to the last round", () => {
    const emit = vi.fn()
    const observer = createReplayTurnObserver(emit)
    observer.observe(commit(50))
    observer.observe(commit(104))
    expect(emit.mock.calls[1][1]).toMatchObject({
      previous: { kind: "between-rounds" }, current: { kind: "reporting", globalTurn: null },
      skippedTurnCount: 4, unobservedCompletedTurnRanges: [{ from: 4, toExclusive: 8 }], planned: null,
    })
  })

  it("marks explicit resume on the next committed observation even in the same stage", () => {
    const emit = vi.fn()
    const observer = createReplayTurnObserver(emit)
    observer.observe(commit(3))
    observer.resume()
    observer.observe(commit(3.5))
    observer.observe(commit(4))
    expect(emit).toHaveBeenCalledTimes(2)
    expect(emit.mock.calls[1][1]).toMatchObject({ observation: "resume", resumed: true })
  })

  it("resets attendance on game identity change and stops idempotently without turn-ending claims", () => {
    const emit = vi.fn()
    const observer = createReplayTurnObserver(emit)
    observer.observe(commit(3))
    observer.observe(commit(39, { gameIndex: 8, roomKey: "g8:alice_bob" }))
    expect(emit.mock.calls[1][1]).toMatchObject({ observation: "initial", previous: null, skippedTurnCount: 0 })
    observer.stop()
    observer.stop()
    observer.resume()
    observer.observe(commit(40))
    expect(emit).toHaveBeenCalledTimes(3)
    expect(emit.mock.calls[2]).toEqual(["game.snapshot.stop", expect.objectContaining({
      gameIndex: 8, reason: "observer-cleanup", turnEndingObserved: false,
    })])
  })

  it("captures cold unresolved readiness without treating it as a visited turn", () => {
    const emit = vi.fn()
    const observer = createReplayTurnObserver(emit)
    observer.observe(commit(1, { snapshot: null, clockReady: false, sourceClockReady: false, roomKey: "" }))
    observer.observe(commit(30))
    expect(emit.mock.calls[1][1]).toMatchObject({ observation: "resume", skippedTurnCount: 0,
      previous: { kind: "unresolved" }, current: { globalTurn: 2 } })
  })

  it("retains immutable old evidence and isolates a failed emitter", () => {
    const emit = vi.fn().mockImplementationOnce(() => { throw new Error("storage unavailable") })
    const observer = createReplayTurnObserver(emit)
    const first = commit(3)
    expect(() => observer.observe(first)).not.toThrow()
    first.timing = { ...first.timing, maxGroupSize: 6 }
    if (first.snapshot?.kind === "round") first.snapshot.round = 10
    observer.observe(commit(12))
    expect(emit.mock.calls[1][1].previous).toMatchObject({ round: 0, globalTurn: 0 })
  })
})
