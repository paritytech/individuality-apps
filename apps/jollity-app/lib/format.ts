// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Presentation formatters, whose countdowns tick on the source clock.
 *
 * The dates and the countdown of the chat live in @jollity/worker, because
 * the worker posts them too, and are re-exported so app code keeps one import.
 */
import { formatClock, formatGameTime } from "@jollity/worker/card"
export { formatClock, formatCountdown } from "@jollity/worker/card"

/** The time of a game, with the day when it is not today on the device. */
export function formatGameAt(unixSeconds: number, nowSeconds: number, locale?: string): string {
  const today = new Date(unixSeconds * 1000).toDateString() === new Date(nowSeconds * 1000).toDateString()
  return today ? formatClock(unixSeconds, locale) : formatGameTime(unixSeconds, locale)
}

/** local wall time to the second, the debug sheet's shape */
export function formatStamp(ms: number): string {
  return new Date(ms).toLocaleTimeString("en-GB", { hour12: false })
}
