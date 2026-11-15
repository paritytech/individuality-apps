// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * THE PAGE COMING BACK FROM THE BACKGROUND, as one monotonic timestamp.
 *
 * While the Polkadot app sits in the background the host drops its chain
 * subscription, and it reconnects by itself within a minute or so of coming
 * back. The first probe after the return therefore often reads a concrete
 * chain loss that is really the host still reconnecting. The restart advice
 * reads this timestamp to tell the two apart: evidence gathered before the
 * return is discarded, and a loss seen soon after it waits like a network
 * switch does (lib/chain-health, RECONNECTING_BEFORE_RESTART_MS).
 *
 * The edges come from the central foreground tracker (lib/page-lifecycle),
 * which reports a silent iOS freeze as a hidden/shown pair too. Framework-free;
 * the card hook subscribes to reset its own state.
 */
import { watchPageActivity } from "./page-lifecycle"

let away = false
let lastReturnAtMs: number | null = null
const listeners = new Set<(returnedAtMs: number) => void>()

/** One foreground-tracker edge. Exported for tests. */
export function noteBackgroundEdge(hidden: boolean, nowMs: number = performance.now()): void {
  if (hidden) {
    away = true
    return
  }
  if (!away) return
  away = false
  lastReturnAtMs = nowMs
  for (const listener of listeners) {
    try {
      listener(nowMs)
    } catch {
      /* one observer never breaks the others */
    }
  }
}

watchPageActivity((hidden) => noteBackgroundEdge(hidden))

/** When the page last came back (performance.now() clock), or null if it has
 *  not been away since this page loaded. */
export function lastBackgroundReturnAtMs(): number | null {
  return lastReturnAtMs
}

/** Called at each return from the background. Returns the unsubscribe. */
export function watchBackgroundReturns(listener: (returnedAtMs: number) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
