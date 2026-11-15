// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * journey.home-first-status — from the home mounting to its first screen that
 * is not the bare "Jollity" title (#530).
 *
 * journey.app-open ends before the home's first chain read, so a launch that
 * never got an answer left no trace but a reload burst. This one names the
 * outcome: `shown` (a real status), `restart-card` (the restart card took the
 * bare title's place) or `stuck` (the page went away still loading; sent on
 * pagehide, then flushed, so a reload or a kill is recorded). The attributes
 * name what was still pending (source, game, schedule, watch) and count the
 * reads that timed out or failed. Every attribute is text.
 *
 * Framework-free. The game source feeds the progress notes; lib/use-home-first-status
 * starts and ends it. Notes outside a started journey only keep the progress.
 */
import { flushMetrics, startJourney, type Journey } from "../telemetry"

export type HomeFirstStatusOutcome = "shown" | "restart-card" | "stuck"
type Read = "unread" | "present" | "empty"

interface Progress {
  source: boolean
  game: Read
  schedule: boolean
  watch: boolean
  timeouts: number
  failures: number
}

const fresh = (): Progress => ({ source: false, game: "unread", schedule: false, watch: false, timeouts: 0, failures: 0 })

let progress = fresh()
let journey: Journey<"home-first-status"> | null = null
let startedAt = 0

/** What the first status was still waiting for. The schedule only counts on an empty slot. */
function pending(): string {
  const list: string[] = []
  if (!progress.source) list.push("source")
  if (progress.game === "unread") list.push("game")
  if (progress.game !== "present" && !progress.schedule) list.push("schedule")
  if (!progress.watch) list.push("watch")
  return list.length ? list.join(",") : "none"
}

export function homeSourceResolved(): void {
  progress.source = true
}
export function homeGameRead(present: boolean): void {
  progress.game = present ? "present" : "empty"
}
export function homeScheduleRead(): void {
  progress.schedule = true
}
export function homeWatchFired(): void {
  progress.watch = true
}
export function homeReadTimedOut(): void {
  progress.timeouts += 1
}
export function homeReadFailed(): void {
  progress.failures += 1
}

export function endHomeFirstStatus(outcome: HomeFirstStatusOutcome, attrs: Record<string, string> = {}): void {
  const open = journey
  if (!open || open.ended) return
  if (outcome !== "shown") open.markSad(outcome)
  open.end(outcome, {
    pending: pending(),
    "reads.timeouts": String(progress.timeouts),
    "reads.failures": String(progress.failures),
    "duration.ms": String(Math.max(0, Date.now() - startedAt)),
    ...attrs,
  })
  if (outcome === "stuck") flushMetrics()
}

/** Open the journey for this mount. The returned stop abandons it unended (a
 *  route change is not a stuck launch) and drops the pagehide listener. */
export function beginHomeFirstStatus(): () => void {
  progress = fresh()
  startedAt = Date.now()
  const mine = startJourney("home-first-status")
  journey = mine
  // a page kept in the back/forward cache (persisted) comes back; only a real unload is stuck
  const onPagehide = (event: { persisted?: boolean }) => {
    if (!event.persisted) endHomeFirstStatus("stuck")
  }
  const target = typeof window === "undefined" ? undefined : window
  target?.addEventListener("pagehide", onPagehide)
  return () => {
    target?.removeEventListener("pagehide", onPagehide)
    if (journey === mine) journey = null
  }
}

export function resetHomeFirstStatusForTests(): void {
  progress = fresh()
  journey = null
}
