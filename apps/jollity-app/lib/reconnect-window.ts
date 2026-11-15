// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { RECONNECTING_BEFORE_RESTART_MS } from "./chain-health"

export interface ReconnectWindow {
  recover(): void
  cancel(): void
}

/** One silent-host episode. The caller owns UI state and telemetry callbacks;
 * this framework-free timer owns only the monotonic elapsed-time contract. */
export function armReconnectWindow(options: {
  nowMs?: () => number
  /** when the episode began, on the nowMs clock; default now. A loss right
   * after a return from the background counts its minute from the return. */
  startedAtMs?: number
  onEscalate: (elapsedMs: number) => void
  onRecover: (elapsedMs: number) => void
}): ReconnectWindow {
  const { nowMs = () => performance.now(), onEscalate, onRecover } = options
  const startedAt = options.startedAtMs ?? nowMs()
  let finished = false
  const elapsed = () => Math.max(0, nowMs() - startedAt)
  const timer = setTimeout(() => {
    if (finished) return
    finished = true
    onEscalate(elapsed())
  }, options.startedAtMs === undefined ? RECONNECTING_BEFORE_RESTART_MS : Math.max(0, RECONNECTING_BEFORE_RESTART_MS - elapsed()))

  return {
    recover() {
      if (finished) return
      finished = true
      clearTimeout(timer)
      onRecover(elapsed())
    },
    cancel() {
      if (finished) return
      finished = true
      clearTimeout(timer)
    },
  }
}
