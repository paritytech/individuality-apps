// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Keeps the collection a player picked for each claim in the collectables screen.
 *
 * A pick outlives the screen it was made on. Reopening the collectables screen deals the
 * picked item again, and the stash can read the same key through the `storage`
 * grant in the manifest, to mint the item the player chose. The value under
 * `jollity.chest` is JSON that maps each credit hash to `{ collectionId }`.
 */
import { devLog } from "./debug/log-store"
import { describeError } from "./host/error-detail"
import { hostStorage } from "./host/storage"
import { collectablesValue, JOLLITY_PICKS_KEY, normalizeCreditHash, parseCollectablesPicks, type CollectablesPicks } from "@jollity/collectables"
import { withTimeout } from "./with-timeout"

const PICKS_KEY = JOLLITY_PICKS_KEY

/** Fifty full collectables screens, so the key every collectables open reads stays small. */
const PICKS_KEPT = 500
const READ_TIMEOUT_MS = 8_000

export type { CollectablesPicks } from "@jollity/collectables"
export { canChangePick, withPicks } from "@jollity/collectables"

/** Reads the key, and counts a value that is not JSON as no picks, since writing over it loses nothing. */
async function storedPicks(): Promise<CollectablesPicks> {
  const store = await hostStorage()
  try {
    return parseCollectablesPicks(await store?.readJSON(PICKS_KEY))
  } catch (error) {
    if (error instanceof SyntaxError) return new Map()
    throw error
  }
}

/** The picks the last read found, plus every pick saved since. */
let known: CollectablesPicks = new Map()
/** Whether a read has landed, since until one has, writing the picks would wipe the stored ones. */
let loaded = false
let saving = Promise.resolve()

/** Reads the saved picks once the saves in flight have landed, and keeps the last ones read when this read fails. */
export async function readCollectablesPicks(options: { timeoutMs?: number } = {}): Promise<CollectablesPicks> {
  try {
    const read = await withTimeout(
      (async () => {
        await saving
        return storedPicks()
      })(),
      options.timeoutMs ?? READ_TIMEOUT_MS,
    )
    if (read === null) {
      devLog("chest", "saved picks timed out, keeping the last ones read", undefined, "warn")
      return new Map(known)
    }
    known = read
    loaded = true
  } catch (error) {
    devLog("chest", "saved picks unreadable, keeping the last ones read", { detail: describeError(error) }, "warn")
  }
  return new Map(known)
}

/**
 * Saves one pick on top of the picks the last read found.
 *
 * Each save writes the whole key, so saves run one at a time and the last one
 * holds every pick. Until a read has landed nothing is written.
 */
export function saveCollectablesPick(hash: string, collectionId: number): Promise<void> {
  const normalized = normalizeCreditHash(hash)
  if (!normalized || !Number.isInteger(collectionId) || collectionId < 0) return Promise.resolve()
  const picks = new Map(known)
  // deleted first, so the newest pick is last and survives the trim
  picks.delete(normalized)
  picks.set(normalized, collectionId)
  known = new Map([...picks].slice(-PICKS_KEPT))
  saving = saving.then(async () => {
    if (!loaded) {
      devLog("chest", "pick not saved, the saved picks were never read", { hash }, "warn")
      return
    }
    try {
      const store = await hostStorage()
      await store?.writeJSON(PICKS_KEY, collectablesValue(known))
    } catch (error) {
      devLog("chest", "pick not saved", { hash, detail: describeError(error) }, "warn")
    }
  })
  return saving
}

