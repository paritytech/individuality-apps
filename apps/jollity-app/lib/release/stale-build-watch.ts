// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * KEEP ASKING UNTIL THE ANSWER IS DEFINITE — the schedule around
 * lib/release/stale-build.ts's one check. Framework-free; the hook only feeds
 * it the real fetch and the page lifecycle.
 *
 * An "unknown" (offline, refused grant, a slow version file) is never final: a player
 * playing on an old build is the problem, so the check is repeated in the
 * background, 5, 10, 20, 40 s and then every minute, until it says "stale" or
 * "current". Each attempt carries its own abort (stale-build's 4 s timeout).
 * Nothing runs while the page is hidden: a hidden attempt is aborted, the
 * timer is dropped, and the return from the background asks again at once.
 *
 * A DENIED check (the host refused the version file's grant) is not retried on
 * the clock: the refusal is not cached, so every retry would raise the host's
 * dialog again. It waits for the next return to the foreground, and asks once
 * per return, like the camera's refusal rule.
 *
 * One more reason to ask: a "current" answer can age. When the app comes back
 * after FOREGROUND_RECHECK_MS hidden, a release may have happened meanwhile,
 * so it asks again. That recheck is quiet (no "unknown" is reported over a
 * standing "current") but not give-up: it retries on the same backoff until
 * it is definite. "stale" is final.
 */
import type { BuildCheck, BuildState } from "./stale-build"

/** the wait after the 1st, 2nd, ... attempt that came back unknown; the last
 *  entry repeats */
export const BACKOFF_MS: readonly number[] = [5000, 10_000, 20_000, 40_000, 60_000]
export const FOREGROUND_RECHECK_MS = 5 * 60_000

export interface WatchBuildDeps {
  /** One attempt (stale-build's checkBuild); aborted when the page hides or
   *  the watch stops. */
  check: (signal: AbortSignal) => Promise<BuildCheck>
  /** Every answer that is worth reporting: each unknown (with why), and the
   *  definite one. `attempts` counts the attempts up to and including it; a
   *  foreground recheck starts again at 1. */
  onResult: (state: BuildState, attempts: number, reason?: "denied" | "failed") => void
  isHidden: () => boolean
  watchHidden: (onHidden: () => void, onShown: () => void) => () => void
  now?: () => number
}

/** Starts at once. Returns stop. */
export function watchBuild(deps: WatchBuildDeps): () => void {
  const now = deps.now ?? Date.now
  let stopped = false
  /** the last definite answer; "unknown" until there is one. A "current"
   *  with attempts > 0 is being rechecked, quietly, until definite. */
  let standing: BuildState = "unknown"
  let attempts = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let controller: AbortController | undefined
  let hiddenAt: number | undefined

  const clear = () => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    controller?.abort()
    controller = undefined
  }

  const attempt = () => {
    timer = undefined
    if (stopped || controller || deps.isHidden()) return
    attempts++
    const mine = new AbortController()
    controller = mine
    deps
      .check(mine.signal)
      .catch((): BuildCheck => "unknown")
      .then((result) => {
        if (stopped || mine.signal.aborted) return
        controller = undefined
        if (result === "stale" || result === "current") {
          standing = result
          deps.onResult(result, attempts)
          attempts = 0
          return
        }
        // a standing "current" is not unsaid by a recheck that cannot answer
        if (standing === "unknown") deps.onResult("unknown", attempts, result === "denied" ? "denied" : "failed")
        if (result !== "denied") timer = setTimeout(attempt, BACKOFF_MS[Math.min(attempts - 1, BACKOFF_MS.length - 1)])
      })
  }

  const unwatch = deps.watchHidden(
    () => {
      hiddenAt ??= now()
      clear()
    },
    () => {
      const away = hiddenAt === undefined ? 0 : now() - hiddenAt
      hiddenAt = undefined
      const seeking = standing === "unknown" || (standing === "current" && attempts > 0)
      const aged = standing === "current" && away > FOREGROUND_RECHECK_MS
      if (!stopped && (seeking || aged) && timer === undefined) attempt()
    },
  )

  attempt()
  return () => {
    stopped = true
    unwatch()
    clear()
  }
}
