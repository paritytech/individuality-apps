// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { playEndsSeconds, registrationOpensSeconds, ROUND_GAP_SECONDS, TURN_SECONDS } from "./game-timing"

describe("playEndsSeconds", () => {
  it("adds every turn of every round and the gaps between the rounds to the play time", () => {
    expect(playEndsSeconds({ gamePlayTime: 1_000, rounds: 3, maxGroupSize: 5 })).toBe(1_000 + 3 * 5 * TURN_SECONDS + 2 * ROUND_GAP_SECONDS)
  })
  it("has no gap for a single round, and ends at once for a game with none", () => {
    expect(playEndsSeconds({ gamePlayTime: 1_000, rounds: 1, maxGroupSize: 4 })).toBe(1_000 + 4 * TURN_SECONDS)
    expect(playEndsSeconds({ gamePlayTime: 1_000, rounds: 0, maxGroupSize: 4 })).toBe(1_000)
  })
})

describe("registrationOpensSeconds", () => {
  const schedule = [
    { registrationStarts: 5_000, reportingEnds: 6_000 },
    { registrationStarts: 9_000, reportingEnds: 10_000 },
  ]

  it("opens each game when the game before it ends", () => {
    expect(registrationOpensSeconds(schedule, 2_000)).toEqual([2_000, 6_000])
  })

  it("opens the first game now when none is running", () => {
    expect(registrationOpensSeconds(schedule, 0)).toEqual([0, 6_000])
  })

  it("keeps the schedule projection when the previous end is unknown", () => {
    expect(registrationOpensSeconds(schedule, null)).toEqual([5_000, 6_000])
  })
})
