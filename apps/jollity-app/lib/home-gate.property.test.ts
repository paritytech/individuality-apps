// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import fc from "fast-check"
import { describe, expect, it } from "vitest"
import type { GameStatus } from "./game-source"
import { buildCheckWanted, entryBuildClear, entryRecheck, homeGate } from "./home-gate"
import { handoverAt } from "./joined"
import type { BuildAnswer, BuildCheck } from "./release/stale-build"

const waiting = (gameAt: number): GameStatus => ({ kind: "waiting", gameAt })
const live = (gameAt: number, registered: boolean, playEndsAt: number): GameStatus => ({
  kind: "live",
  gameAt,
  endsAt: playEndsAt + 100,
  playEndsAt,
  registered,
  gameIndex: 1,
  rounds: 2,
  maxGroupSize: 6,
})
const entry = fc.record({ joined: fc.boolean(), held: fc.boolean() })
const status = fc.oneof(
  fc.integer().map(waiting),
  fc.tuple(fc.integer(), fc.boolean(), fc.integer()).map(([gameAt, registered, playEndsAt]) => live(gameAt, registered, playEndsAt)),
  fc.constant<GameStatus>({ kind: "processing" }),
  fc.constant<GameStatus>({ kind: "none" }),
)
const answer: fc.Arbitrary<BuildAnswer> = fc.record(
  {
    state: fc.constantFrom("current" as const, "stale" as const, "unknown" as const),
    last: fc.constantFrom<BuildCheck>("current", "stale", "unknown", "denied"),
    askedFor: fc.integer(),
  },
  { requiredKeys: ["state"] },
)

describe("home gate properties", () => {
  it("never lets another gate outrank the missing host", () => {
    fc.assert(fc.property(
      fc.constantFrom("current" as const, "stale" as const, "unknown" as const),
      status,
      fc.integer(),
      entry,
      (build, s, now, e) => {
        expect(homeGate(true, build, s, now, e)).toBe("host-only")
      },
    ))
  })

  it("never asks a non-stale build to update", () => {
    fc.assert(fc.property(
      fc.constantFrom("current" as const, "unknown" as const),
      status,
      fc.integer(),
      entry,
      (build, s, now, e) => {
        expect(homeGate(false, build, s, now, e)).toBeNull()
      },
    ))
  })

  it("closes both stale-build checks at the exact handover for a device already in the game", () => {
    fc.assert(fc.property(
      fc.integer({ min: -1_000_000_000, max: 1_000_000_000 }),
      (gameAt) => {
        for (const offset of [-1, 0, 1]) {
          const now = handoverAt(gameAt) + offset
          const beforeHandover = offset < 0
          const rejoin = { joined: true, held: false }

          expect(homeGate(false, "stale", waiting(gameAt), now, rejoin)).toBe(beforeHandover ? "update" : null)
          expect(buildCheckWanted(waiting(gameAt), now, rejoin)).toBe(beforeHandover)
        }
      },
    ))
  })

  it("never lets a stale build through a first entry: the gate shows and the handover waits", () => {
    fc.assert(fc.property(status, fc.integer(), answer, (s, now, build) => {
      if (entryRecheck(s, now, false) === undefined) return
      const stale = { ...build, state: "stale" as const }
      expect(entryBuildClear(s, now, false, stale)).toBe(false)
      expect(homeGate(false, "stale", s, now, { joined: false, held: false })).toBe("update")
      // and the check runs while the entry waits on it
      expect(buildCheckWanted(s, now, { joined: false, held: false })).toBe(true)
    }))
  })

  it("never holds back a device already in the game", () => {
    fc.assert(fc.property(status, fc.integer(), answer, (s, now, build) => {
      expect(entryRecheck(s, now, true)).toBeUndefined()
      expect(entryBuildClear(s, now, true, build)).toBe(true)
    }))
  })

  it("a first entry goes in on its own answer, never on one asked for another game", () => {
    fc.assert(fc.property(status, fc.integer(), fc.integer(), (s, now, other) => {
      const game = entryRecheck(s, now, false)
      if (game === undefined || other === game) return
      expect(entryBuildClear(s, now, false, { state: "current", last: "current", askedFor: game })).toBe(true)
      expect(entryBuildClear(s, now, false, { state: "current", last: "current", askedFor: other })).toBe(false)
      expect(entryBuildClear(s, now, false, { state: "current", last: "current" })).toBe(false)
    }))
  })
})
