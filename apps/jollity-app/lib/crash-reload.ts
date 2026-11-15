// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * THE APP RECOVERS FROM A RENDER CRASH BY ITSELF (issue 778). A render throw
 * is usually a one-off, so the first one in a page load reloads at once and
 * the player sees nothing of it. A crash that comes straight back reloads
 * too, on a backoff, under a screen that says so: the player has nothing to
 * tap, and a reload loop at the longest wait is the floor, never a dead end.
 * A start that stays up for `CRASH_RELOAD_GRACE_MS` is clean, and the next
 * crash starts the backoff over.
 *
 * sessionStorage, because it survives the reload and dies with the tab.
 */

const STORAGE_KEY = "jollity.crash-reload"
/** the wait before each reload, by how many came before it in this run of
 *  crashes, the last repeating */
export const CRASH_RELOAD_BACKOFF_MS = [0, 5000, 10_000, 20_000, 30_000] as const
/** how long a start has to stay up before it counts as clean */
export const CRASH_RELOAD_GRACE_MS = 10_000

function attempts(): number | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY)
    const count = raw === null ? 0 : Number(raw)
    return Number.isInteger(count) && count >= 0 ? count : 0
  } catch {
    return null // no storage: nothing to count on
  }
}

/** how long to wait before this crash's reload. Read without side effects,
 *  so the boundary can decide inside getDerivedStateFromError. */
export function crashReloadDelayMs(): number {
  const count = attempts()
  // without storage the crashes cannot be counted, so every one gets the
  // longest wait: a slow loop beats a screen nothing leaves
  if (count === null) return CRASH_RELOAD_BACKOFF_MS[CRASH_RELOAD_BACKOFF_MS.length - 1]!
  return CRASH_RELOAD_BACKOFF_MS[Math.min(count, CRASH_RELOAD_BACKOFF_MS.length - 1)]!
}

export function markCrashReload(): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, String((attempts() ?? 0) + 1))
  } catch {
    /* no storage: crashReloadDelayMs already waits the longest */
  }
}

export function clearCrashReload(): void {
  try {
    sessionStorage.removeItem(STORAGE_KEY)
  } catch {
    /* no storage */
  }
}
