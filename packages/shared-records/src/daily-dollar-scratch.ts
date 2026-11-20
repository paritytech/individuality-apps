// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import type { JSONStorage } from "./game-registration-store"

export const DAILY_DOLLAR_SCRATCH_KEY = "humanity.dd.scratched"

export const DAILY_DOLLAR_SCRATCH_LIFETIME_SECONDS = 7 * 24 * 60 * 60

export type ScratchedAtSecondsByEventId = Record<string, number>

const EVENT_ID = /^0x[0-9a-f]+$/i

export function sanitizeDailyDollarScratches(value: unknown): ScratchedAtSecondsByEventId {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return {}
  const scratches: ScratchedAtSecondsByEventId = {}
  for (const [eventId, at] of Object.entries(value)) {
    if (EVENT_ID.test(eventId) && typeof at === "number" && Number.isFinite(at)) scratches[eventId.toLowerCase()] = at
  }
  return scratches
}

export interface DailyDollarScratchStore {
  scratchedAt(eventId: string): Promise<number | null>
  markScratched(eventId: string, atSeconds: number): Promise<void>
}

export function dailyDollarScratchStore(open: () => Promise<JSONStorage | null>): DailyDollarScratchStore {
  let writing: Promise<void> = Promise.resolve()
  return {
    async scratchedAt(eventId) {
      const storage = await open()
      if (storage == null) return null
      const scratches = sanitizeDailyDollarScratches(await storage.readJSON(DAILY_DOLLAR_SCRATCH_KEY))
      return scratches[eventId.toLowerCase()] ?? null
    },
    markScratched(eventId, atSeconds) {
      const next = writing.then(async () => {
        if (!EVENT_ID.test(eventId)) return
        const storage = await open()
        if (storage?.writeJSON == null) return
        const current = sanitizeDailyDollarScratches(await storage.readJSON(DAILY_DOLLAR_SCRATCH_KEY))
        const id = eventId.toLowerCase()
        if (current[id] != null) return
        const kept: ScratchedAtSecondsByEventId = { [id]: atSeconds }
        for (const [key, at] of Object.entries(current)) {
          if (atSeconds - at < DAILY_DOLLAR_SCRATCH_LIFETIME_SECONDS) kept[key] = at
        }
        await storage.writeJSON(DAILY_DOLLAR_SCRATCH_KEY, kept)
      })
      writing = next.catch(() => undefined)
      return next
    },
  }
}
