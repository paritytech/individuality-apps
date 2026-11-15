// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Small helpers the telemetry modules share (and lib/journeys may adopt).
 * Pure, framework-free, never throw.
 */

/**
 * Nearest-rank percentile, q in 0–1; undefined for no values. A plain array
 * is copied and sorted; a TYPED array is taken as already sorted, so a hot
 * caller sorts its buffer once in place and asks for several ranks.
 */
export function percentile(values: readonly number[] | Float32Array | Float64Array, q: number): number | undefined {
  if (values.length === 0) return undefined
  const sorted = Array.isArray(values) ? [...values].sort((a, b) => a - b) : values
  return sorted[Math.min(sorted.length, Math.max(1, Math.ceil(q * sorted.length))) - 1]
}

export { pageHidden } from "../page-lifecycle"

/** Run `work` when the page is idle (requestIdleCallback), else after
 *  `fallbackMs`. Returns the cancel. */
export function whenIdle(work: () => void, fallbackMs: number): () => void {
  try {
    if (typeof requestIdleCallback === "function") {
      const id = requestIdleCallback(() => work())
      return () => {
        try {
          cancelIdleCallback(id)
        } catch {
          /* already ran */
        }
      }
    }
    const timer = setTimeout(work, fallbackMs)
    return () => clearTimeout(timer)
  } catch {
    return () => {}
  }
}
