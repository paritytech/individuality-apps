// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * THE DRAW SCHEDULE, LEARNED EARLY.
 *
 * `Game.Game.airdrops_scheduled` is available before play, so the waiting
 * room starts this read while there is still time to recover from a host or
 * RPC interruption. Only a successful read is cached. Zero means the game
 * truly has no draw; a failed or mismatched read remains unknown and retries.
 */
import type { GameSource } from "../game-source"
import { devLog } from "../debug/log-store"
import { describeError } from "../host/error-detail"

export interface DrawSchedule {
  gameIndex: number
  gameAt: number
  scheduled: number
}

const RETRY_MS = 2_000
const schedules = new Map<number, number>()
const loads = new WeakMap<GameSource, Map<number, Promise<DrawSchedule>>>()

const wait = () => new Promise((resolve) => setTimeout(resolve, RETRY_MS))

/** Start (or share) the waiting-room read for one scheduled game. */
export function preloadDrawSchedule(source: GameSource, gameAt: number): Promise<DrawSchedule> {
  let byGame = loads.get(source)
  if (!byGame) {
    byGame = new Map()
    loads.set(source, byGame)
  }
  const existing = byGame.get(gameAt)
  if (existing) return existing

  const load = (async () => {
    let failures = 0
    for (;;) {
      try {
        const schedule = await source.drawSchedule(gameAt)
        if (schedule) {
          schedules.set(schedule.gameIndex, schedule.scheduled)
          devLog("draw", "draw schedule learned before play", {
            game: schedule.gameIndex,
            scheduled: schedule.scheduled,
            retries: failures,
          })
          return schedule
        }
        failures += 1
        devLog("draw", "draw schedule is not readable yet", { gameAt, retries: failures }, "warn")
      } catch (error) {
        failures += 1
        devLog(
          "draw",
          "draw schedule read failed — keeping it unknown",
          { gameAt, retries: failures, detail: describeError(error) },
          "warn",
        )
      }
      await wait()
    }
  })()
  byGame.set(gameAt, load)
  return load
}

/** Successful schedule answer for the completed game, if one arrived. */
export function peekDrawSchedule(gameIndex: number): number | undefined {
  return schedules.get(gameIndex)
}

/** Unknown and positive schedules keep the draw route; only confirmed zero skips. */
export function drawEntryPath(scheduled: number | undefined): "/prize-draw" | "/chest" {
  return scheduled === 0 ? "/chest" : "/prize-draw"
}
