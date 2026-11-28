// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { appClockSecondAt, appClockWallMsFor, appGameMoment, observationMidpointMs, turnEntryAgreements } from "./game-clock"

const game = { gameDate: 1_792_912_800, reportEnds: 1_792_913_000, rounds: 2, maxGroupSize: 6 }

describe("live harness app clock", () => {
  it("uses calculateSnapshot timing when an independent block watch is one block behind", () => {
    const wall = 1_792_912_812_450
    const clock = { nowMs: 1_792_912_812_450, nowSeconds: 1_792_912_812, offset: -7.25, block: 539_116, readAtMs: wall }
    const moment = appGameMoment(clock, game)
    expect(moment).toMatchObject({ turn: 2, stage: "intro", turnsInGame: 12 })
    // Game 1366's independent watcher still observed pallet time 1792912800.
    // It is diagnostic only; it cannot pull the canonical app moment back.
    expect(1_792_912_800).toBeLessThan(game.gameDate + 12)
  })

  it("keeps round gaps and reporting in the package state machine", () => {
    expect(appGameMoment({ nowMs: (game.gameDate + 72) * 1000, nowSeconds: game.gameDate + 72, offset: 0, block: 1, readAtMs: 0 }, game).stage).toBe("between-rounds")
    expect(appGameMoment({ nowMs: (game.gameDate + 151) * 1000, nowSeconds: game.gameDate + 151, offset: 0, block: 1, readAtMs: 0 }, game).stage).toBe("confirm")
  })

  it("projects a sampled app clock only for wall-time deadlines", () => {
    const clock = { nowMs: 100_250, nowSeconds: 100, offset: -7, block: 2, readAtMs: 5_000 }
    expect(appClockSecondAt(clock, 7_250)).toBe(102.5)
    expect(appClockWallMsFor(clock, 103)).toBe(7_750)
  })

  it("timestamps a page read at the unbiased observation midpoint", () => {
    expect(observationMidpointMs(10_000, 10_063)).toBe(10_031.5)
  })

  it("checks agreement only where multiple pages observed the same turn", () => {
    const entries = new Map([
      [1, new Map([[1, 10_000]])],
      [2, new Map([[1, 20_000], [2, 21_200], [3, 21_900]])],
      [3, new Map([[1, 30_000], [2, 33_100]])],
    ])
    expect(turnEntryAgreements(entries, 3_000)).toEqual([
      { turn: 2, participants: 3, spreadMs: 1_900, ok: true },
      { turn: 3, participants: 2, spreadMs: 3_100, ok: false },
    ])
  })
})
