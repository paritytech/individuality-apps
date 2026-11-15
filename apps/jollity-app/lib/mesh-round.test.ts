// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { calculateSnapshot, CONNECTION_STAGE_DURATION } from "@jollity/game-chain/game"
import type { GameSnapshot, GameTimingInfo } from "@jollity/game-chain"
import { meshRoundAt, meshRoundOfSnapshot } from "./mesh-round"

const GAME_DATE = 1_800_000_000
const timing = (rounds: number, maxGroupSize = 6): GameTimingInfo => ({
  gameDate: GAME_DATE,
  reportEnds: GAME_DATE + 1000,
  rounds,
  maxGroupSize,
})
const s = (seconds: number) => seconds * 1000

describe("meshRoundAt: the live geometry (2 rounds x 6 seats)", () => {
  const t = timing(2)
  it("is closed until the connection stage", () => {
    expect(meshRoundAt(s(-100), t)).toBeNull()
    expect(meshRoundAt(-CONNECTION_STAGE_DURATION * 1000 - 1, t)).toBeNull()
  })
  it("opens round 0 across the connection stage", () => {
    expect(meshRoundAt(-CONNECTION_STAGE_DURATION * 1000, t)).toBe(0)
    expect(meshRoundAt(-1, t)).toBe(0)
  })
  it("holds round 0 through 0-72 s", () => {
    expect(meshRoundAt(0, t)).toBe(0)
    expect(meshRoundAt(s(62), t)).toBe(0) // the last 10 s stay on round 0
    expect(meshRoundAt(s(72) - 1, t)).toBe(0)
  })
  it("switches to round 1 at the start of the gap (72 s), not at 79 s", () => {
    expect(meshRoundAt(s(72), t)).toBe(1)
    expect(meshRoundAt(s(79) - 1, t)).toBe(1)
  })
  it("holds round 1 through 79-151 s and closes at 151 s", () => {
    expect(meshRoundAt(s(79), t)).toBe(1)
    expect(meshRoundAt(s(151) - 1, t)).toBe(1)
    expect(meshRoundAt(s(151), t)).toBeNull()
    expect(meshRoundAt(s(500), t)).toBeNull()
  })
})

describe("meshRoundAt: 3 rounds", () => {
  const t = timing(3) // rounds 0-72, 79-151, 158-230
  it("steps 0 -> 1 -> 2 at each gap start and closes at the end", () => {
    expect(meshRoundAt(s(71), t)).toBe(0)
    expect(meshRoundAt(s(72), t)).toBe(1)
    expect(meshRoundAt(s(150), t)).toBe(1)
    expect(meshRoundAt(s(151), t)).toBe(2)
    expect(meshRoundAt(s(158), t)).toBe(2)
    expect(meshRoundAt(s(230) - 1, t)).toBe(2)
    expect(meshRoundAt(s(230), t)).toBeNull()
  })
})

describe("meshRoundOfSnapshot", () => {
  it("is null without a snapshot (a cold page)", () => {
    expect(meshRoundOfSnapshot(undefined)).toBeNull()
  })
})

/** the derivation as game-session carried it inline before the extraction */
function oldMeshRound(snapshot: GameSnapshot | undefined): number | null {
  const inRound = snapshot?.kind === "round" ? snapshot : undefined
  return inRound
    ? inRound.round
    : (snapshot?.kind === "waiting-room" || snapshot?.kind === "between-rounds") && snapshot.preconnectRound !== null
      ? snapshot.preconnectRound
      : null
}

describe("old-vs-new oracle", () => {
  it("gives the same round at every 250 ms over every shape, edges included", () => {
    for (const [rounds, group] of [[1, 6], [2, 6], [3, 6], [2, 3], [4, 2]] as const) {
      const t = timing(rounds, group)
      for (let ms = -120_000; ms <= 400_000; ms += 250) {
        const snapshot = calculateSnapshot(t.gameDate + ms / 1000, t)
        expect(meshRoundAt(ms, t), `${rounds}x${group} at ${ms} ms`).toBe(oldMeshRound(snapshot))
      }
    }
  })
})
