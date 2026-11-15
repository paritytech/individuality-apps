// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { devLog } from "./debug/log-store"
import { noteOwnReload } from "./telemetry/session-record"
import { recordCount, recordDistribution } from "./telemetry/metrics"

export const SELF_RELOAD_CAP = 3
const SELF_RELOAD_WINDOW_MS = 10 * 60_000
export const SELF_RELOAD_KEY = "jollity:host-reloads"

export type SelfReloadReason = "host-channel" | "long-suspension" | "left-product"

export interface SelfReloadDetails {
  awayMs?: number
  screen?: string
  stage?: string
}

/** One rolling budget for every reload initiated by Jollity. */
export function requestSelfReload(
  reason: SelfReloadReason,
  details: SelfReloadDetails = {},
  beforeReload?: () => void,
): boolean {
  const now = Date.now()
  const attrs = {
    "app.reload_reason": reason,
    "app.screen": details.screen ?? "unknown",
    "game.stage": details.stage ?? "unknown",
  }
  // Without storage the budget cannot be counted, and every page load would
  // get a fresh one: a channel that keeps dropping would reload forever. So a
  // storage that refuses a read or a write is a refusal to reload, not a
  // licence. (crash-reload can wait the longest instead because it has a wait;
  // this reload is immediate.)
  let raw: string | null
  try {
    raw = sessionStorage.getItem(SELF_RELOAD_KEY)
  } catch {
    devLog("reload", "self-reload needs sessionStorage to count its budget, staying put", { reason, ...details }, "error")
    recordCount("app.self_reload_suppressed", 1, attrs)
    return false
  }
  let history: number[] = []
  try {
    // our own key, so anything unparseable is treated as an empty history and
    // the write below repairs it
    const stored = JSON.parse(raw ?? "[]") as unknown
    if (Array.isArray(stored))
      history = stored.filter((at) => Number.isFinite(at) && now - at < SELF_RELOAD_WINDOW_MS)
  } catch {
    /* unparseable: start the window over */
  }
  if (history.length >= SELF_RELOAD_CAP) {
    devLog("reload", "self-reload cap reached, staying put", { reason, reloads: history.length, ...details }, "error")
    recordCount("app.self_reload_suppressed", 1, attrs)
    return false
  }
  try {
    sessionStorage.setItem(SELF_RELOAD_KEY, JSON.stringify([...history, now]))
  } catch {
    // the count would not survive the reload, so the next page would start
    // over with a full budget: the same unbounded loop, one write later
    devLog("reload", "self-reload could not record its budget, staying put", { reason, ...details }, "error")
    recordCount("app.self_reload_suppressed", 1, attrs)
    return false
  }
  devLog("reload", "reloading the app", { reason, reload: history.length + 1, ...details }, "error")
  recordCount("app.self_reload", 1, attrs)
  if (details.awayMs !== undefined)
    recordDistribution("app.self_reload_away_ms", details.awayMs, "millisecond", attrs)
  noteOwnReload()
  beforeReload?.()
  window.location.reload()
  return true
}
