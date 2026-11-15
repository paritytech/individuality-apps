// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * WHERE A JOURNEY SITS IN TIME. The browser SDK stamps spans with
 * `performance.timeOrigin + performance.now()` unless told otherwise, and
 * `performance.now()` stops while a phone's page is frozen or asleep, so a
 * span can read minutes early (#221). journeys.ts therefore stamps
 * every journey and step from `Date.now()` itself. (Browser-tracing's own
 * spans, pageload and http, still use the SDK's clock; they are out of scope.)
 *
 * What stays here is the diagnostic, at a journey's start and end: how far the
 * span clock has drifted from the wall clock (`clock.span_drift_ms`), the
 * game clock (`chain.time.*`) and best block (`chain.block.*`, both off what
 * the doorway publishes in lib/chain-clock.ts) and the wall clock
 * (`wall.time.*`), which together say where the journey falls in the game
 * and on the chain. Values are TEXT (custom span
 * attributes are stored string-typed). A drift beyond DRIFT_LIMIT_MS is sent
 * once per session as the `clock-drift` failure, except when the difference is
 * explained by a hidden/frozen page or is over an hour (a long background
 * sleep). The measurement stays on the journey either way.
 */
import { readChainClock } from "../chain-clock"
import { pageHidden, watchPageHidden } from "../page-lifecycle"
import { sendFailure } from "./failures"

const DRIFT_LIMIT_MS = 5_000
export const LONG_BACKGROUND_DRIFT_MS = 60 * 60 * 1_000
const AWAY_MATCH_SLOP_MS = 250
let driftReported = false
let awayDriftCreditMs = 0
let explainedNegativeDriftMs = 0
let awayStartedAtDrift: number | null = null
let trackingInstalled = false
let stopTracking = () => {}

export function resetClockForTests(): void {
  stopTracking()
  stopTracking = () => {}
  driftReported = false
  awayDriftCreditMs = 0
  explainedNegativeDriftMs = 0
  awayStartedAtDrift = null
  trackingInstalled = false
}

export interface ClockTrackingOptions {
  hidden?: () => boolean
  hiddenBeforeTracking?: () => boolean
  watchHidden?: typeof watchPageHidden
  readDrift?: () => number | null
}

function wasHiddenBeforeTracking(): boolean {
  try {
    return typeof performance !== "undefined" && performance.getEntriesByType("visibility-state").some((entry) => entry.name === "hidden")
  } catch {
    return false
  }
}

function collectAwayDrift(readDrift: () => number | null): void {
  if (awayStartedAtDrift === null) return
  const current = readDrift()
  if (current === null) return
  awayDriftCreditMs += Math.max(0, awayStartedAtDrift - current)
  awayStartedAtDrift = current
}

/**
 * Start tracking before any journey. Hidden time earns credit only for the
 * amount the span clock actually fell behind, never for elapsed wall time.
 */
export function startClockTracking(options: ClockTrackingOptions = {}): () => void {
  if (trackingInstalled) return () => {}
  trackingInstalled = true
  const hidden = options.hidden ?? pageHidden
  const hiddenBeforeTracking = options.hiddenBeforeTracking ?? wasHiddenBeforeTracking
  const watch = options.watchHidden ?? watchPageHidden
  const readDrift = options.readDrift ?? spanDriftMs
  const initial = readDrift()
  const startedAway = hidden() || hiddenBeforeTracking()
  explainedNegativeDriftMs = initial === null ? 0 : startedAway ? Math.max(0, -initial) : Math.min(DRIFT_LIMIT_MS, Math.max(0, -initial))
  const startAway = () => {
    awayStartedAtDrift ??= readDrift()
  }
  const finishAway = () => {
    collectAwayDrift(readDrift)
    awayStartedAtDrift = null
  }
  if (startedAway) startAway()
  stopTracking = watch(startAway, finishAway, (event) => {
    if (event?.persisted) startAway()
  })
  return () => {
    stopTracking()
    stopTracking = () => {}
    awayStartedAtDrift = null
    trackingInstalled = false
  }
}

/** Whether a drift is expected from a page whose monotonic clock stopped. */
function expectedSpanDrift(drift: number, readDrift: () => number | null = spanDriftMs): boolean {
  const magnitude = Math.abs(drift)
  if (magnitude > LONG_BACKGROUND_DRIFT_MS) return true
  if (drift >= 0) return false
  collectAwayDrift(readDrift)
  const unexplained = Math.max(0, magnitude - explainedNegativeDriftMs)
  if (unexplained > awayDriftCreditMs + AWAY_MATCH_SLOP_MS) return false
  awayDriftCreditMs = Math.max(0, awayDriftCreditMs - unexplained)
  explainedNegativeDriftMs = Math.max(explainedNegativeDriftMs, magnitude)
  return true
}

/** span clock minus wall clock, in ms; null when `performance` is missing */
function spanDriftMs(): number | null {
  try {
    if (typeof performance === "undefined" || typeof performance.now !== "function") return null
    const origin = performance.timeOrigin
    if (typeof origin !== "number" || !Number.isFinite(origin)) return null
    return Math.round(origin + performance.now() - Date.now())
  } catch {
    return null
  }
}

/** The game clock in seconds at `atMs`, from the clock the doorway publishes (lib/chain-clock.ts); null before it has one. */
export function chainSeconds(atMs: number = Date.now()): number | null {
  const clock = readChainClock()
  return clock ? Math.floor(atMs / 1000) + clock.offset : null
}

/**
 * Where a journey sits in time at its `phase`, as text: the chain block and
 * clock, the wall clock, and the span clock's drift. A journey can then be
 * placed on the chain whatever the phone's span clock says. The start keeps
 * the names it was first sent under (`clock.span_drift_ms`); the end's drift
 * is `clock.span_drift_ms.end`. `atMs` is the journey's own (possibly
 * back-dated) start or end; the block and the drift are always read now.
 * Reports a drift past the limit, once.
 */
export function clockAttrs(phase: "start" | "end", journey: string, atMs: number = Date.now()): Record<string, string> {
  const drift = spanDriftMs()
  const clock = readChainClock()
  const chain = clock ? Math.floor(atMs / 1000) + clock.offset : null
  const block = clock?.block ?? null
  reportDrift(drift, journey)
  return {
    ...(drift !== null ? { [phase === "start" ? "clock.span_drift_ms" : "clock.span_drift_ms.end"]: String(drift) } : {}),
    ...(chain !== null ? { [`chain.time.${phase}`]: String(chain) } : {}),
    ...(block !== null ? { [`chain.block.${phase}`]: String(block) } : {}),
    [`wall.time.${phase}`]: String(atMs),
  }
}

/** Send the once-per-session drift failure when `drift` is past the limit. */
export function reportDrift(drift: number | null, journey: string): void {
  if (drift === null) return
  if (Math.abs(drift) <= DRIFT_LIMIT_MS || driftReported) return
  if (expectedSpanDrift(drift)) return
  driftReported = true
  try {
    sendFailure("clock-drift", { reason: "span-clock", context: { drift_ms: String(drift), journey } })
  } catch {
    /* never throws */
  }
}
