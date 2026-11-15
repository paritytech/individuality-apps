// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { gameSlot, type GameResults, type SlotGame } from "./game-slot"

const DOCUMENTED_REGISTRATION_OPENS_S = 3_600
const DOCUMENTED_JOIN_WINDOW_S = 300

const scheduled = (startAt: number): SlotGame => ({ id: "property", status: "scheduled", startAt })

const results = (gamesToMembership: number | null): GameResults => ({
  endedAt: 200,
  passed: true,
  collectables: [],
  prize: null,
  membership: { member: false, justBecameMember: false, gamesToMembership },
  seen: { chest: false, draw: false },
})

describe("chat game-slot properties", () => {
  it("follows the source registration window at both exact boundaries", () => {
    fc.assert(fc.property(
      fc.integer({ min: -1_000_000_000, max: 1_000_000_000 }),
      fc.integer({ min: 2, max: 20_000 }),
      fc.integer({ min: 1, max: 10_000 }),
      (startAt, beforeClose, closeLead) => {
        const closesAt = startAt - closeLead
        const opensAt = closesAt - beforeClose
        for (const nowSeconds of [opensAt - 1, opensAt, closesAt - 1, closesAt]) {
          const slot = gameSlot({
            game: scheduled(startAt),
            registered: false,
            results: null,
            nowSeconds,
            window: { opensAt, closesAt },
          })
          const expected = nowSeconds < opensAt ? "next" : nowSeconds < closesAt ? "register" : "closed"

          expect(slot.kind).toBe(expected)
        }
      },
    ))
  })

  it("uses the documented fallback window when the source has none", () => {
    fc.assert(fc.property(
      fc.integer({ min: -1_000_000_000, max: 1_000_000_000 }),
      (startAt) => {
        for (const offset of [-1, 0, 1]) {
          const openingSlot = gameSlot({
            game: scheduled(startAt),
            registered: false,
            results: null,
            nowSeconds: startAt - DOCUMENTED_REGISTRATION_OPENS_S + offset,
          })
          const closingSlot = gameSlot({
            game: scheduled(startAt),
            registered: false,
            results: null,
            nowSeconds: startAt - DOCUMENTED_JOIN_WINDOW_S + offset,
          })

          expect(openingSlot.kind).toBe(offset < 0 ? "next" : "register")
          expect(closingSlot.kind).toBe(offset < 0 ? "register" : "closed")
        }
      },
    ))
  })

  it("keeps cancellation ahead of every non-idle game phase", () => {
    fc.assert(fc.property(
      fc.constantFrom<SlotGame["status"]>("scheduled", "active", "reporting", "finished"),
      fc.integer({ min: -1_000_000_000, max: 1_000_000_000 }),
      fc.boolean(),
      (status, startAt, registered) => {
        const game = { ...scheduled(startAt), status }

        expect(gameSlot({ game, registered, results: null, nowSeconds: startAt, cancelled: true }))
          .toEqual({ kind: "cancelled", startAt })
      },
    ))
  })

  it("derives every finished face only from registration and authoritative results", () => {
    fc.assert(fc.property(
      fc.integer({ min: -1_000_000_000, max: 1_000_000_000 }),
      fc.boolean(),
      fc.option(fc.integer({ min: 0, max: 100 }), { nil: null }),
      fc.option(fc.integer({ min: 0, max: 100 }), { nil: null }),
      (startAt, registered, resultCount, fallbackCount) => {
        const authoritative = resultCount === null ? null : results(resultCount)
        const game = { ...scheduled(startAt), status: "finished" as const }
        const slot = gameSlot({
          game,
          registered,
          results: authoritative,
          nowSeconds: startAt + 1_000,
          gamesToMembership: fallbackCount,
        })

        if (!registered) {
          expect(slot).toMatchObject({
            kind: "missed",
            reason: "never-registered",
            gamesToMembership: resultCount ?? fallbackCount,
          })
        } else if (authoritative) {
          expect(slot).toEqual({ kind: "results", results: { ...authoritative, endedAt: startAt } })
        } else {
          expect(slot).toMatchObject({ kind: "missed", reason: "no-show", gamesToMembership: fallbackCount })
        }
      },
    ))
  })
})
