// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

"use client"

/**
 * The app end of the keys the app and the chat worker share in host storage.
 *
 * The worker and the app never call each other. `jollity.showTutorial` goes
 * from the worker to the app: How to play on a card opens /nux as a deep link,
 * and the flag covers the hosts that drop the path of a navigation and open
 * the product root instead, where this hook routes to /nux.
 * `jollity.seen:<gameIndex>` goes the other way: the collectables screen and the draw screens
 * report that the player has been through them, and the card of that game
 * then shows the won ticket. The game screen adds that the report landed, so
 * a player who played and was not confirmed is not told they missed the game.
 * The worker reads the game and the player from the chain itself.
 *
 * A third key, `jollity.registration` (`GAME_REGISTRATION_KEY` in
 * @individuality/shared-records), carries the sign-up either surface has on its way or has
 * just ended. Both write it; the status watch of lib/game-source.ts reads it
 * through lib/host/game-registration.ts, since that is where the home learns
 * what to show in place of Register.
 */
import { useEffect } from "react"
import { useRouter } from "next/navigation"
import { hostStorage } from "./host/storage"
import { devUrlParam } from "./debug/dev-url"

const TUTORIAL_KEY = "jollity.showTutorial"
const SEEN_KEY = "jollity.seen"

const seenWrites = new Map<string, Promise<void>>()

/**
 * Records that the player has been through one part of a game.
 *
 * It merges, so each screen reports its own part. Writes to one game queue up,
 * since two that overlap would each drop the part of the other.
 */
export async function markSeen(gameIndex: number, part: "chest" | "draw" | "report"): Promise<void> {
  const key = `${SEEN_KEY}:${gameIndex}`
  const write = async () => {
    try {
      const storage = await hostStorage()
      if (!storage) return
      const stored = ((await storage.readJSON(key)) as { chest?: boolean; draw?: boolean; report?: boolean } | null) ?? {}
      await storage.writeJSON(key, {
        chest: stored.chest === true,
        draw: stored.draw === true,
        ...(stored.report === true ? { report: true } : {}),
        [part]: true,
      })
    } catch {
      /* A lost write only costs the card its newer line. */
    }
  }
  const queued = (seenWrites.get(key) ?? Promise.resolve()).then(write)
  seenWrites.set(key, queued)
  await queued
}

/**
 * Whether the chat card asked for the tutorial.
 *
 * Reads and clears the flag, so the carousel shows once per request.
 */
export async function consumeTutorialRequest(): Promise<boolean> {
  // A plain browser has no host storage: in a development build, ?tutorial=1
  // stands in for the chat card's request (lib/debug/dev-url.ts).
  if (devUrlParam("tutorial") === "1") return true
  const kv = await hostStorage()
  if (!kv) return false
  try {
    const requested = (await kv.readJSON(TUTORIAL_KEY)) === true
    if (requested) await kv.writeJSON(TUTORIAL_KEY, false)
    return requested
  } catch {
    return false
  }
}

/**
 * Routes to /nux when the worker sent the player here for the tutorial.
 *
 * Mount it on the entry surface of the app.
 */
export function useWorkerHandoff(): void {
  const router = useRouter()
  useEffect(() => {
    let cancelled = false
    void consumeTutorialRequest().then((requested) => {
      if (requested && !cancelled) router.push("/nux")
    })
    return () => {
      cancelled = true
    }
  }, [router])
}
