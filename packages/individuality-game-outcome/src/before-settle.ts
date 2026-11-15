// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * READ BEFORE THE SETTLE: much of what a game gave is on chain before the game
 * settles. A co-player's `Person` vote awards its collectable credit with their
 * report, and only an attendee's remaining credits wait for the settle
 * (pallet-nft-credits). In one measured game that was 4 of 8 credits five
 * seconds after the last turn, and the rest at the settle seven and a half
 * minutes later.
 *
 * So a read is made as things stand, and again whenever the chain says
 * something may have arrived (a storage watch; without one, every
 * BEFORE_SETTLE_REREAD_MS), until it finds something or the game settles
 * (`readBeforeSettle`); the caller then reads the settled game as before. A
 * page that shows the claims as they land keeps reading until the settle
 * (`readUntilSettle`).
 */

/** a People block: about the time a co-player's report takes to land */
export const BEFORE_SETTLE_REREAD_MS = 6_000

/** with a watch, a read this often anyway: a host subscription can go quiet without failing */
export const UNTIL_SETTLE_BACKSTOP_MS = 30_000

interface ReadLoopOptions<T> {
  /** One read as the chain stands; null when it gave up. A read that throws is reported and made again. */
  read(attempt: number): Promise<T | null>
  /** the settle (./settle.ts `whenSettles`): resolved or rejected, the reads stop */
  settles: Promise<void>
  /**
   * The chain's word that something may have arrived (a storage watch):
   * `changed` on each move, `failed` when the watch dies. Returns its stop.
   * A read follows each change, one at a time (a change during a read is one
   * more read after it), and UNTIL_SETTLE_BACKSTOP_MS without one. Without a
   * watch, or once it fails, the reads run every BEFORE_SETTLE_REREAD_MS.
   */
  watch?(changed: () => void, failed: (error: unknown) => void): () => void
  signal?: AbortSignal
  /** the reason the reads throw once `signal` aborts (default: `signal.reason`) */
  abortReason?(signal: AbortSignal): unknown
  onReadError?(error: unknown, attempt: number): void
  onWatchError?(error: unknown): void
}

export interface BeforeSettleOptions<T> extends ReadLoopOptions<T> {
  /** whether the read found something to show */
  arrived(value: T): boolean
}

/** The first read that found something, with its attempt; null once the game settles first. */
export function readBeforeSettle<T>(options: BeforeSettleOptions<T>): Promise<{ value: T; attempt: number } | null> {
  return readLoop(options, (value) => !options.arrived(value))
}

export interface UntilSettleOptions<T> extends ReadLoopOptions<T> {
  /** each read's answer, as it comes */
  onRead(value: T, attempt: number): void
}

/**
 * Every read until the settle, not just the first that found something: what
 * a page shows while the game is still in reporting, as co-players' reports
 * land, each answer handed to `onRead`. Resolves once the game settles or its
 * wait gives up.
 */
export async function readUntilSettle<T>(options: UntilSettleOptions<T>): Promise<void> {
  await readLoop(options, (value, attempt) => {
    options.onRead(value, attempt)
    return true
  })
}

/** Reads until `more` says no to an answer (that answer), or the game settles (null). */
async function readLoop<T>(
  options: ReadLoopOptions<T>,
  more: (value: T, attempt: number) => boolean,
): Promise<{ value: T; attempt: number } | null> {
  const { read, settles, signal } = options
  const abortReason = options.abortReason ?? ((s: AbortSignal) => s.reason)
  let settled = false
  // what ends the current wait early: a change, a failed watch, the settle
  let wake: (() => void) | null = null
  let changed = false
  const ends = () => {
    settled = true
    wake?.()
  }
  settles.then(ends, ends)
  let watching = false
  let stop = () => {}
  const watchFailed = (error: unknown) => {
    watching = false
    options.onWatchError?.(error)
    wake?.()
  }
  if (options.watch) {
    watching = true
    try {
      stop = options.watch(() => {
        changed = true
        wake?.()
      }, watchFailed)
    } catch (error) {
      watchFailed(error)
    }
  }
  try {
    for (let attempt = 1; ; attempt++) {
      changed = false
      try {
        const value = await read(attempt)
        if (signal?.aborted) throw abortReason(signal)
        if (value !== null && !more(value, attempt)) return { value, attempt }
      } catch (error) {
        if (signal?.aborted) throw abortReason(signal)
        options.onReadError?.(error, attempt)
      }
      if (settled) return null
      if (!changed) await nextWake(watching ? UNTIL_SETTLE_BACKSTOP_MS : BEFORE_SETTLE_REREAD_MS, (w) => (wake = w), signal)
      wake = null
      if (signal?.aborted) throw abortReason(signal)
      if (settled) return null
    }
  } finally {
    stop()
  }
}

/** Resolves after `ms`, at once when `signal` aborts, or when the wake it hands out is called. */
function nextWake(ms: number, hold: (wake: () => void) => void, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    // one listener per wait, gone with it: a long settle waits many times
    const done = () => {
      clearTimeout(timer)
      signal?.removeEventListener("abort", done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal?.addEventListener("abort", done, { once: true })
    hold(done)
  })
}
