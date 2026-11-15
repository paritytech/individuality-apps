// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/** Passive, versioned observations carried by the existing durable game log.
 * These are phone readings, not calibrated occurrence timestamps. In particular
 * the game's clock estimate must never be used as independent proof of its lag.
 */
import { readChainClock } from "../chain-clock"
import { BUILD_COMMIT, DEBUG_LOGS } from "../debug/flag"
import { devLog } from "../debug/log-store"
import { SESSION_ID } from "../debug/session-id"

let sequence = 0
const finite = (value: number | null | undefined): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null

// Logs travel as JSON text. Long floating-point tails can match Sentry's
// sensitive-number scrubber, replacing digits with stars and breaking JSON.
// Bound observation precision, not the source values used by gameplay. Three
// fractional digits retain microsecond precision for millisecond measurements.
const numericFractionDigits = 3
function recordedPrecision(value: unknown): unknown {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null
    return Number.isInteger(value) ? value : Number(value.toFixed(numericFractionDigits))
  }
  if (Array.isArray(value)) return value.map(recordedPrecision)
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, recordedPrecision(entry)]))
  }
  return value
}

/** No timers, storage, network, promises or gameplay decisions on this path. */
export function captureReplayObservation(kind: string, payload: Record<string, unknown>): void {
  try {
    if (!DEBUG_LOGS) return
    const wallMs = Date.now()
    const monotonicMs = typeof performance === "undefined" ? null : finite(performance.now())
    // Clock getters advance the step-free clock's hidden latch and the game
    // clock's correction. Only copy already-published state here. Event-specific source
    // readings belong in the payload and reuse the caller's existing samples.
    const clock = readChainClock()
    devLog("replay", kind, recordedPrecision({
      schemaVersion: 1,
      numericFractionDigits,
      sessionId: SESSION_ID,
      sequence: ++sequence,
      // APP_VERSION already accompanies every retained log line/chunk.
      buildCommit: BUILD_COMMIT,
      timing: {
        wallMs,
        monotonicMs,
        offsetMs: clock ? finite(clock.offset * 1000) : null,
        offsetDomain: "published-wall-relative",
        lastBlock: clock?.block ?? null,
        alignment: "unmeasured",
      },
      observation: payload,
    }))
  } catch {
    // Telemetry must never prevent a render, clock update, or media sample.
  }
}
