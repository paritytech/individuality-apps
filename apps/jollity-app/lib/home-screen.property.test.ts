// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import fc from "fast-check"
import { describe, expect, it } from "vitest"
import type { GameStatus } from "./game-source"
import { homeHandover, homeScreen, homeSituation, type HomeScreenInput } from "./home-screen"
import { handoverAt } from "./joined"

const live = (gameAt: number, playEndsAt: number, registered: boolean): GameStatus => ({
  kind: "live",
  gameAt,
  endsAt: playEndsAt + 100,
  playEndsAt,
  registered,
  gameIndex: 7,
  rounds: 2,
  maxGroupSize: 6,
})

const input = (status: GameStatus, gate: HomeScreenInput["view"]["gate"] = null): HomeScreenInput => ({
  view: { status, gate, platform: "ios" },
  reconnecting: false,
})

describe("home screen properties", () => {
  it("keeps host and update gates ahead of restart and status screens", () => {
    fc.assert(fc.property(
      fc.constantFrom("host-only" as const, "update" as const),
      fc.boolean(),
      fc.integer(),
      (gate, reconnecting, now) => {
        const restart = { reason: "chain-lost" as const, consecutiveLost: 3 }
        const screen = homeScreen({ ...input({ kind: "processing" }, gate), restart, reconnecting }, now)

        expect(screen).toEqual(gate === "host-only" ? { kind: "host-only" } : { kind: "update", platform: "ios" })
      },
    ))
  })

  it("offers a late join exactly while a registered player's turns remain", () => {
    fc.assert(fc.property(
      fc.integer({ min: -1_000_000_000, max: 1_000_000_000 }),
      fc.boolean(),
      (now, registered) => {
        for (const remaining of [-1, 0, 1]) {
          const status = live(now - 50, now + remaining, registered)
          const canJoin = registered && remaining > 0

          expect(homeSituation(status, now).goesIn).toBe(canJoin)
          expect(homeHandover(status, now, false) !== null).toBe(canJoin)
          // the source ends live at playEndsAt, so the screen has no case past it
          if (remaining > 0) expect(homeScreen(input(status), now)).toEqual(canJoin ? { kind: "loading" } : { kind: "missed" })
        }
      },
    ))
  })

  it("opens the waiting-room door only from the boundary with a live camera", () => {
    fc.assert(fc.property(
      fc.integer({ min: -1_000_000_000, max: 1_000_000_000 }),
      fc.boolean(),
      (gameAt, cameraLive) => {
        for (const offset of [-1, 0, 1]) {
          const status = { kind: "waiting" as const, gameAt }
          const now = handoverAt(gameAt) + offset
          const handover = homeHandover(status, now, cameraLive)

          expect(handover).toEqual(offset >= 0 && cameraLive ? { gameAt, door: true } : null)
        }
      },
    ))
  })

  it("never invents a game time on restart screens for statuses without one", () => {
    fc.assert(fc.property(
      fc.constantFrom<GameStatus>({ kind: "loading" }, { kind: "none" }, { kind: "processing" }),
      fc.boolean(),
      fc.nat(),
      (status, reconnecting, consecutiveLost) => {
        const screen = homeScreen({
          ...input(status),
          reconnecting,
          restart: { reason: "chain-lost", consecutiveLost },
        }, 0)

        expect(screen).toEqual({ kind: "restart", reason: "chain-lost", consecutiveLost, reconnecting })
      },
    ))
  })
})
