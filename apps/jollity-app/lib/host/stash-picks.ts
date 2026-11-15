// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { network } from "@jollity/protocol"
import { parseChestPicks, STASH_PICKS_KEY, storedJSON, type ChestPicks } from "@jollity/collectables"
import { devLog } from "../debug/log-store"
import { withTimeout } from "../with-timeout"

export { STASH_PICKS_KEY }
const READ_TIMEOUT_MS = 8_000

export function stashProduct(): string {
  return `stash.${network().dotnsTLD}`
}

export interface ReadStashPicksOptions {
  /** One total budget for host acquisition and the read; overridden only by tests. */
  timeoutMs?: number
}

/**
 * Reads Scarcity's cross-product pick map. An absent key is an empty map;
 * unavailable, refused, malformed, and timed-out reads are null so callers can
 * distinguish fallback from a successful empty value.
 */
export async function readStashPicks(options: ReadStashPicksOptions = {}): Promise<ChestPicks | null> {
  const product = stashProduct()
  try {
    const read = (async (): Promise<ChestPicks | null> => {
      const sdk = await import("@parity/product-sdk-host")
      const api = await sdk.getTruApi()
      if (!api) return null
      const result = await api.localStorage.read({ product, key: STASH_PICKS_KEY })
      const response = result.match(
        (value) => value,
        (error) => {
          devLog(
            "chest",
            "Scarcity picks refused, using Jollity selection",
            { product, key: STASH_PICKS_KEY, detail: sdk.formatHostError(error) },
            "warn",
          )
          return null
        },
      )
      if (response === null) return null
      if (!response.value) return new Map()
      const json = storedJSON(response.value)
      if (typeof json !== "object" || json === null || Array.isArray(json)) throw new Error("stash.picks is not an object")
      return parseChestPicks(json)
    })()
    const picks = await withTimeout(read, options.timeoutMs ?? READ_TIMEOUT_MS)
    if (picks === null) {
      devLog("chest", "Scarcity picks unavailable, using Jollity selection", { product, key: STASH_PICKS_KEY }, "warn")
    }
    return picks
  } catch (error) {
    devLog(
      "chest",
      "Scarcity picks unreadable, using Jollity selection",
      { product, key: STASH_PICKS_KEY, detail: error instanceof Error ? error.message : String(error) },
      "warn",
    )
    return null
  }
}
