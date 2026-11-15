// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * THE DEVICE CLOCK WITHOUT ITS STEPS (#331). `Date.now()` is the phone's wall
 * clock, and the OS can step it mid-game: a network time sync, a timezone
 * change, a hand on the settings. A step of +30 s at one turn and -75 s at a
 * later one, followed by the game clock, makes the session replay round 0
 * against a group that has moved on, and the player ends on /connection-help
 * with no report filed.
 *
 * This is the wall clock with every step taken out. Each read compares how far
 * the wall clock moved against how far `performance.now()` (monotonic, never
 * stepped) moved since the last read; a disagreement beyond STEP_SLACK_MS is a
 * step, and it is added to the correction instead of to the time. So the
 * clock keeps the wall's reading from the page's start, moves on the
 * monotonic clock, and a step changes nothing.
 *
 * THE ONE AMBIGUITY. `performance.now()` stops while a phone's page is frozen
 * or asleep (lib/telemetry/clock.ts), and a freeze looks exactly
 * like a forward step: the wall moved, the monotonic clock did not. A page
 * that was HIDDEN since the last read is taken as a freeze, so a FORWARD move
 * of the wall is kept across it. A backward one never is: a freeze cannot
 * move the wall back. A visible page that froze (iOS can stop a WebView
 * without an event) is corrected as a step and reads behind. The game clock
 * (lib/game-source.ts) sees the step and asks its peers again, and the peer
 * check closes that gap.
 *
 * It never re-syncs to anything, so it can sit behind the true time (a phone
 * whose clock was slow at load and is fixed while visible, or visible
 * freezes adding up). Use it for durations and for stamps compared with each
 * other on this device; a stamp ANOTHER clock judges reads the game clock
 * (lib/chain-clock.ts `chainNowMs`): a statement's expiry through
 * lib/store-clock.ts, a TURN proof through the chain gap
 * (lib/chain-clock.ts `readChainGapMs`).
 */

/** a wall move this far off the monotonic move is a step, not timer jitter */
export const STEP_SLACK_MS = 1500

export interface DeviceClockDeps {
  /** the wall clock, ms (default `Date.now`) */
  wallMs?: () => number
  /** a monotonic clock, ms (default `performance.now`) */
  monoMs?: () => number
  /** was the page hidden at any time since the last call? Reading it clears it. */
  hiddenSinceLastRead?: () => boolean
}

export interface DeviceClock {
  /** the wall time with every step taken out, ms */
  nowMs(): number
  /** the wall clock's steps so far, ms (wall minus this clock) */
  stepMs(): number
}

export function createDeviceClock(deps: DeviceClockDeps = {}): DeviceClock {
  const wallMs = deps.wallMs ?? (() => Date.now())
  const monoMs = deps.monoMs ?? defaultMono
  const hiddenSince = deps.hiddenSinceLastRead ?? (() => false)
  let lastWall = wallMs()
  let lastMono = monoMs()
  let correction = 0
  const read = () => {
    const wall = wallMs()
    const mono = monoMs()
    const step = wall - lastWall - (mono - lastMono)
    // a hidden page may have been frozen, and a freeze moves the wall FORWARD
    // only: a forward move across one is kept, a backward one never is
    const hidden = hiddenSince()
    if (step < -STEP_SLACK_MS || (step > STEP_SLACK_MS && !hidden)) correction += step
    lastWall = wall
    lastMono = mono
    return wall - correction
  }
  return {
    nowMs: read,
    stepMs: () => {
      read()
      return correction
    },
  }
}

function defaultMono(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now()
}

/** the page's hidden latch: set by every hide, cleared by a read while visible */
function pageHiddenLatch(): () => boolean {
  if (typeof document === "undefined" || typeof document.addEventListener !== "function") return () => false
  let seen = document.visibilityState === "hidden"
  const onHide = () => {
    if (document.visibilityState === "hidden") seen = true
  }
  document.addEventListener("visibilitychange", onHide)
  if (typeof window !== "undefined") window.addEventListener?.("pagehide", () => (seen = true))
  return () => {
    const was = seen || document.visibilityState === "hidden"
    seen = document.visibilityState === "hidden"
    return was
  }
}

let shared: DeviceClock | null = null

/** the page's device clock, created on first use */
export function sharedDeviceClock(): DeviceClock {
  shared ??= createDeviceClock({ hiddenSinceLastRead: pageHiddenLatch() })
  return shared
}

/** the wall time with every step taken out, ms */
export function deviceNowMs(): number {
  return sharedDeviceClock().nowMs()
}

/** tests: drop the shared clock so the next read starts on the fake timers */
export function resetDeviceClockForTests(): void {
  shared = null
}
