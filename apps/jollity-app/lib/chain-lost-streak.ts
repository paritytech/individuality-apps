// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * HOW MANY APP OPENS IN A ROW have found the host's chain lost.
 *
 * The restart card's advice is "close the Polkadot app and open it again".
 * A host bug (the host's chain subscription drops at boot, tracked upstream as
 * host bug #76) can survive that: a player restarted four times in 90
 * seconds and every boot found the chain lost again. The card reads this count
 * to change its advice from the second such open on.
 *
 * One count per app open (this module's lifetime), however many probes in it
 * lose, kept in host storage with the time of the loss so it survives the
 * full close the card asks for. A loss more than STREAK_STALE_MS before is
 * not "in a row". A healthy probe resets it to 0, and a loss after that
 * counts again. Unknown and declined probes leave it alone: they say nothing
 * about the chain.
 *
 * The doorway (lib/game-source) counts it once per probe and hands it on with
 * the result. The probe must never hang on it: the stored count is read at
 * most once per open, bounded by STREAK_READ_BOUND_MS, and written without
 * waiting.
 */
import { readStoredJSON, writeStoredJSON } from "./host/storage"
import { withTimeout } from "./with-timeout"
import type { ChainHealthResult } from "./chain-health"

const STREAK_KEY = "jollity.chain-lost-streak"
/** a previous open's loss older than this is not "in a row" */
export const STREAK_STALE_MS = 30 * 60_000
/** how long a probe may wait on host storage for the previous opens' count */
export const STREAK_READ_BOUND_MS = 1000

/** this open has been counted (until a healthy probe) */
let countedThisOpen = false
/** the count as of this open, once known */
let current: number | undefined
/** the previous opens' count, read once */
let previous: Promise<number> | undefined

function parse(value: unknown, nowMs: number): number {
  if (typeof value !== "object" || value === null) return 0
  const { count, at } = value as { count?: unknown; at?: unknown }
  if (typeof count !== "number" || !Number.isInteger(count) || count < 0) return 0
  if (typeof at !== "number" || nowMs - at > STREAK_STALE_MS) return 0
  return count
}

function write(count: number, nowMs: number): void {
  writeStoredJSON(STREAK_KEY, { count, at: nowMs }).catch(() => {
    /* the count is advice only; the card still shows */
  })
}

/** Apply one probe to the count and return it; undefined while it is not
 *  known (a probe that says nothing about the chain, before any loss). */
export async function noteChainLostStreak(
  result: ChainHealthResult,
  nowMs: number = Date.now(),
): Promise<number | undefined> {
  if (result.outcome === "healthy") {
    countedThisOpen = false
    if (current !== 0) write(0, nowMs)
    current = 0
    return 0
  }
  if (result.outcome !== "host-chain-lost" || countedThisOpen) return current
  countedThisOpen = true
  previous ??= readStoredJSON(STREAK_KEY).then((value) => parse(value, nowMs), () => 0)
  const before = current ?? (await withTimeout(previous, STREAK_READ_BOUND_MS)) ?? 0
  current = before + 1
  write(current, nowMs)
  return current
}
