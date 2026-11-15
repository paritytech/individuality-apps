// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The page leaving and coming back, in one place. A phone that hides the page
 * (a lock, an app switch) throttles the timers on Android and freezes them on
 * iOS, which fires no event at all. Framework-free, so the game session, the
 * journeys and the peers' away signal (#229) all read the same two facts.
 */

/** The page is hidden (backgrounded, locked). False without a document. */
export function pageHidden(): boolean {
  try {
    return typeof document !== "undefined" && document.visibilityState === "hidden"
  } catch {
    return false
  }
}

type ActivityListener = (hidden: boolean, suspended: boolean) => void
type PagehideListener = (event?: PageTransitionEvent) => void
const activityListeners = new Set<ActivityListener>()

/** Subscribe to the one foreground tracker's explicit and silent-away edges. */
export function watchPageActivity(listener: ActivityListener): () => void {
  activityListeners.add(listener)
  return () => activityListeners.delete(listener)
}

/** Called only by the central foreground tracker. */
export function reportPageActivity(hidden: boolean, suspended = false): void {
  for (const listener of activityListeners) {
    try {
      listener(hidden, suspended)
    } catch {
      /* one observer never breaks the foreground tracker */
    }
  }
}

/** Call `onHidden` when the page turns hidden and `onShown` when it is back.
 *  By default pagehide is another hidden edge; callers that end work on a
 *  real unload may give it a distinct handler. Returns the unsubscribe. */
export function watchPageHidden(onHidden: () => void, onShown?: () => void, onPagehide: PagehideListener = onHidden): () => void {
  if (typeof document === "undefined") return () => {}
  const onVisibility = () => (pageHidden() ? onHidden() : onShown?.())
  const target = typeof window === "undefined" ? undefined : window
  document.addEventListener("visibilitychange", onVisibility)
  target?.addEventListener("pagehide", onPagehide)
  if (onShown) target?.addEventListener("pageshow", onShown)
  return () => {
    document.removeEventListener("visibilitychange", onVisibility)
    target?.removeEventListener("pagehide", onPagehide)
    if (onShown) target?.removeEventListener("pageshow", onShown)
  }
}

/** How far past one tick the wall clock may be before the page counts as
 *  frozen: a busy main thread is late by tens of milliseconds, not seconds. */
export const FREEZE_SLACK_MS = 5000

/** How long a gap between two ticks must run for the page to count as frozen: one tick plus the slack. An
 *  end-to-end test driver can read the same number to tell a stall of that length from a real trip to the
 *  background. */
export const pageFreezeThresholdMs = (tickMs: number): number => tickMs + FREEZE_SLACK_MS

/** A tick that finds the wall clock further on than one tick plus the slack
 *  means the timers did not run in between: the page was frozen. */
export function pageFroze(lastTickAt: number, now: number, tickMs: number): boolean {
  return now - lastTickAt > pageFreezeThresholdMs(tickMs)
}
