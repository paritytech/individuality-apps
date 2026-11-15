// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * One warn line per failing thing, not one per attempt.
 *
 * A poll against a dead chain, or a storage that refuses every write, would
 * fill the log ring with the same sentence. A key logs again when the reason
 * changes or the window passes. Keys are fixed strings in the callers, so the
 * map is bounded by their number.
 *
 * The key is marked BEFORE devLog runs: the debug log persists through host
 * storage, so a failure logged from there would otherwise log itself again
 * while it is being logged.
 */
import { describeError } from "../host/error-detail"
import { devLog } from "./log-store"

const last = new Map<string, { detail: string; at: number }>()

export function warnThrottled(key: string, tag: string, message: string, error: unknown, windowMs = 60_000): void {
  const detail = describeError(error)
  const now = Date.now()
  const previous = last.get(key)
  if (previous && previous.detail === detail && now - previous.at < windowMs) return
  last.set(key, { detail, at: now })
  devLog(tag, message, { detail }, "warn")
}

/** for tests: forget what was logged */
export function resetWarnThrottled(): void {
  last.clear()
}
