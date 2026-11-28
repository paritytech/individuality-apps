// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { appClockWallMsFor, type AppClockReading } from "./game-clock"

export const APP_CLOCK_READY_TIMEOUT_MS = 20_000
export const APP_CLOCK_READY_POLL_MS = 250

/** Retry a chain-derived readiness value until an absolute wall-clock bound.
 * The roster can legitimately be absent while the on-chain shuffle finishes;
 * preserve the last read error if the bound expires. */
export async function waitForReadyValue<T>(
  read: () => T | Promise<T>,
  ready: (value: T) => boolean,
  options: {
    deadlineMs: number
    pollMs?: number
    nowMs?: () => number
    sleep?: (ms: number) => Promise<void>
  },
): Promise<T> {
  const nowMs = options.nowMs ?? Date.now
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const pollMs = options.pollMs ?? 1_000
  let lastError: unknown
  while (true) {
    try {
      const value = await read()
      if (ready(value)) return value
      lastError = new Error("read value was not ready")
    } catch (error) {
      lastError = error
    }
    const remainingMs = options.deadlineMs - nowMs()
    if (remainingMs <= 0) throw lastError
    await sleep(Math.min(pollMs, remainingMs))
  }
}

/** A fresh document publishes its GameSource clock after the first chain read.
 * Poll that readiness boundary instead of treating the first frame as final. */
export async function waitForAppClock(
  read: () => Promise<AppClockReading | null>,
  options: {
    timeoutMs?: number
    pollMs?: number
    nowMs?: () => number
    sleep?: (ms: number) => Promise<void>
  } = {},
): Promise<AppClockReading | null> {
  const timeoutMs = options.timeoutMs ?? APP_CLOCK_READY_TIMEOUT_MS
  const pollMs = options.pollMs ?? APP_CLOCK_READY_POLL_MS
  const nowMs = options.nowMs ?? Date.now
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const deadlineMs = nowMs() + timeoutMs
  while (true) {
    const clock = await read()
    if (clock) return clock
    const remainingMs = deadlineMs - nowMs()
    if (remainingMs <= 0) return null
    await sleep(Math.min(pollMs, remainingMs))
  }
}

/** #757 runs its final peerless check immediately before handover. Keep the
 * warning assertion bounded by that app-clock boundary, with 30 s as the
 * minimum only for an already-nearby handover. */
export function waitingNetworkWarningTimeoutMs(
  clock: AppClockReading,
  handoverSecond: number,
  nowMs: number,
): number {
  return Math.max(30_000, appClockWallMsFor(clock, handoverSecond) - nowMs)
}
