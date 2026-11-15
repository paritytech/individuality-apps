// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * THE STORE CLOCK: the time a statement's expiry is stamped from
 * (docs/time-and-clocks.md, Rule 2).
 *
 * The node judges a statement against its OWN system clock: sc-statement-store
 * `submit()` rejects `is_expired(self.timestamp())`, `timestamp()` being the
 * node's `SystemTime::now()` in seconds, and `is_expired` being
 * `now >= expiry >> 32`. The answer is `{"status":"invalid","reason":
 * "alreadyExpired"}` and carries no time; there is no upper bound on a future
 * expiry. So the node's clock cannot be measured, only bracketed: a rejection
 * says it was at or past the stamp's deadline, an acceptance that it was not.
 *
 * What this learns is therefore an ACCEPTANCE MARGIN, not the node's time:
 *
 *  - Every expiry is stamped from a BASE clock plus the margin, which starts
 *    at 0. The app's base is the game clock (the device clock before the first
 *    block). On a live network the game clock tracks the node's synced clock,
 *    so a stamp from it is accepted and the margin stays 0.
 *  - A time rejection is the safety net: the statement is re-stamped ONCE at
 *    the base plus a margin pushed ahead in steps (MIN_RETRY_MARGIN_MS, then
 *    double the margin in force or the last push that failed, capped at
 *    MAX_RETRY_MARGIN_MS).
 *  - ...unless the rejected stamp was STALE: more than half its TTL old by
 *    the time it was refused (a stalled or backgrounded page, a slow sign).
 *    The headroom is only the TTL minus the chain's lag and the sign and
 *    submit time, so such a rejection says nothing about the node's clock:
 *    the re-stamp reads a fresh base, adds no push, and teaches nothing.
 *    Otherwise every stall would ratchet the margin up for the session.
 *  - A re-stamp of a FRESH stamp that the store accepted sets the margin, the
 *    smallest one accepted for that rejection, and every later statement is
 *    stamped with it.
 *  - Both stamps rejected: the caller reports a signalling failure and stops.
 *    The margin is unchanged; the next time rejection pushes one step further.
 *
 * A too-wide margin costs nothing but a longer statement life, and the
 * packed expiry's floor (`nextSlotExpiry`) keeps every stamp rising anyway,
 * so the margin never needs to shrink within a session.
 *
 * Each base kind ("chain", "device") keeps its own margin, so one learned on
 * the device stand-in never rides chain time, and a margin restored after a
 * reload (`initial`) survives the device clock standing in until the first
 * block. The base clock is injected: this package knows no chain.
 *
 * CALIBRATION (`calibrateStoreClock`, below): the app submits one statement
 * on the player's own channel in the waiting room, once the pallet has
 * granted the allowance, so the margin is learned before the game and
 * in-game signalling never pays the rejection. When it cannot finish (no
 * allowance yet, offline), the transport's one-shot re-stamp is the fallback.
 */
import type { StatementStoreLike } from "./store"
import { toHex } from "./store"
import {
  errMessage,
  isTimeRejection,
  packExpiry,
  sha256,
  SIGN_TIMEOUT_MS,
  SUBMIT_TIMEOUT_MS,
  TTL_S,
  withTimeout,
} from "./statementCommon"

/** the first re-stamp's push over the base: twice the TTL, so a base a block
 *  or a slow sign behind still lands */
export const MIN_RETRY_MARGIN_MS = 60_000
/** no push grows past 10 minutes: a node further ahead is not a clock to
 *  chase, and a margin that size already keeps statements alive 20× the TTL */
export const MAX_RETRY_MARGIN_MS = 10 * 60_000

export interface StoreClockBase {
  /** the base time, ms */
  ms: number
  /** which clock it read ("chain", "device"): a margin is learned against one
   *  base and means nothing against another */
  kind: string
}

export interface StoreStamp {
  /** the time the expiry is stamped from, ms */
  ms: number
  /** the base it was stamped against, read at the same instant */
  base: number
  kind: string
  /** the margin in force when the statement's FIRST stamp was taken */
  from: number
  /** a re-stamp after a time rejection */
  retry: boolean
  /** a re-stamp of a FRESH rejected stamp: its acceptance teaches the margin */
  learn: boolean
}

export type StoreClockEvent =
  /** a re-stamp was accepted and the margin moved */
  | { kind: "learned"; marginMs: number; previousMs: number; base: string }
  /** both stamps of a statement were rejected for time (told once a session
   *  until the margin moves again); `pushMs` is the re-stamp's push */
  | { kind: "rejected"; reason: string; marginMs: number; pushMs: number; base: string }

export interface StoreClock {
  /** the first stamp of a statement: base + margin */
  stamp(): StoreStamp
  /** the one re-stamp after `first` was rejected for time; `ttlS` is the
   *  statement's TTL, which decides whether `first` was stale (default TTL_S) */
  retryStamp(first: StoreStamp, ttlS?: number): StoreStamp
  /** the store accepted a statement stamped at `stamp` */
  accepted(stamp: StoreStamp): void
  /** the store rejected the re-stamp too, for `reason` */
  rejected(stamp: StoreStamp, reason: string): void
  /** the margin in force for the current base, ms */
  marginMs(): number
  /** the margins learned, by base kind (to persist across a reload) */
  margins(): Record<string, number>
}

export interface StoreClockDeps {
  base: () => StoreClockBase
  /** margins by base kind to start from (a reload restoring its own) */
  initial?: Record<string, number>
  /** told when the margin is learned or both stamps are rejected; a listener
   *  that throws is ignored */
  onEvent?: (event: StoreClockEvent) => void
}

export function createStoreClock(deps: StoreClockDeps): StoreClock {
  /** per base kind: the margin, and the push of the last re-stamp rejected
   *  too (the next one goes further) */
  const kinds = new Map<string, { margin: number; failedPush: number }>()
  for (const [kind, margin] of Object.entries(deps.initial ?? {}))
    if (Number.isFinite(margin) && margin >= 0) kinds.set(kind, { margin: Math.min(margin, MAX_RETRY_MARGIN_MS), failedPush: 0 })
  const of = (kind: string) => {
    let state = kinds.get(kind)
    if (!state) kinds.set(kind, (state = { margin: 0, failedPush: 0 }))
    return state
  }
  let toldRejected = false
  const tell = (event: StoreClockEvent) => {
    try {
      deps.onEvent?.(event)
    } catch {
      /* a listener never breaks signalling */
    }
  }
  return {
    stamp() {
      const base = deps.base()
      const { margin } = of(base.kind)
      return { ms: base.ms + margin, base: base.ms, kind: base.kind, from: margin, retry: false, learn: false }
    },
    retryStamp(first, ttlS = TTL_S) {
      const base = deps.base()
      const state = of(base.kind)
      // refused because it sat too long, not because the node is ahead
      if (base.kind === first.kind && base.ms - first.base > (ttlS * 1000) / 2)
        return { ms: base.ms + state.margin, base: base.ms, kind: base.kind, from: first.from, retry: true, learn: false }
      const push = Math.min(MAX_RETRY_MARGIN_MS, Math.max(MIN_RETRY_MARGIN_MS, 2 * first.from, 2 * state.failedPush))
      return { ms: base.ms + push, base: base.ms, kind: base.kind, from: first.from, retry: true, learn: true }
    },
    accepted(stamp) {
      // a first stamp accepted confirms the margin in force; only a re-stamp
      // of a fresh stamp teaches anything, against the base it was taken on
      if (!stamp.learn) return
      const state = of(stamp.kind)
      const learned = stamp.ms - stamp.base
      // the margin has not moved since this statement's rejection: take the
      // accepted one. A sibling re-stamp moved it already: keep the smaller
      const next = state.margin <= stamp.from ? learned : Math.min(state.margin, learned)
      if (next === state.margin) return
      const previous = state.margin
      state.margin = next
      state.failedPush = 0
      toldRejected = false
      tell({ kind: "learned", marginMs: next, previousMs: previous, base: stamp.kind })
    },
    rejected(stamp, reason) {
      const push = stamp.ms - stamp.base
      if (stamp.learn) of(stamp.kind).failedPush = Math.max(of(stamp.kind).failedPush, push)
      if (toldRejected) return
      toldRejected = true
      tell({ kind: "rejected", reason, marginMs: of(stamp.kind).margin, pushMs: push, base: stamp.kind })
    },
    marginMs: () => of(deps.base().kind).margin,
    margins: () => Object.fromEntries([...kinds].map(([kind, state]) => [kind, state.margin])),
  }
}

// ── calibration: learn the margin before the game needs it ─────────────────

/** a calibration statement's TTL: shorter than a signalling one (TTL_S), so
 *  a stamp it passes passes with room to spare in the game, and it leaves the
 *  account's statements well before the game starts */
export const CALIBRATION_TTL_S = 15

export interface StoreCalibration {
  /** accepted: the first stamp passed, the margin in force is right;
   *  learned: a re-stamp passed and set the margin;
   *  rejected: both stamps were rejected for time;
   *  failed: the store refused it for something else (no allowance yet,
   *  offline, a timeout): the in-game one-shot re-stamp stays the fallback */
  outcome: "accepted" | "learned" | "rejected" | "failed"
  /** the margin in force afterwards, ms */
  marginMs: number
  /** from the first stamp to the store's last answer, ms */
  durationMs: number
  /** statements signed */
  attempts: number
  reason?: string
}

/**
 * The calibration statement's labels: the player's OWN channel and a topic
 * nobody subscribes to (the signalling transport subscribes to
 * `<ns>|<prefix>:<room>:inbox:<id>` and `<ns>|<prefix>:<room>:`, and no room
 * key is "calibrate"). One channel holds one statement, so a calibration
 * replaces the last one and costs the account one slot for CALIBRATION_TTL_S,
 * which a game statement (a higher expiry) may evict from a full account.
 */
export function calibrationLabels(namespace: string, id: string, labelPrefix = "rtc") {
  return { channel: `${namespace}|${labelPrefix}:calibrate:${id}`, topic: `${namespace}|${labelPrefix}:calibrate` }
}

export interface CalibrateOptions {
  store: StatementStoreLike
  clock: StoreClock
  labels: { channel: string; topic: string }
  ttlS?: number
  /** ms for the duration (default `Date.now`) */
  now?: () => number
  /** per sign and per submit (default 8 s / 12 s, the transport's) */
  signTimeoutMs?: number
  submitTimeoutMs?: number
}

/**
 * Submit ONE calibration statement, stamped exactly as a signalling one is
 * (the store clock) but with CALIBRATION_TTL_S, and teach the clock what the
 * store said: the same one re-stamp on `alreadyExpired` as the transport. Its
 * expiry is packed WITHOUT `nextSlotExpiry`'s floor, so the signalling slots'
 * ordering never sees it. Its data is not a signalling frame (not JSON), so a
 * decoder that met it would drop it.
 */
export async function calibrateStoreClock(options: CalibrateOptions): Promise<StoreCalibration> {
  const { store, clock } = options
  const now = options.now ?? (() => Date.now())
  const ttlS = options.ttlS ?? CALIBRATION_TTL_S
  const started = now()
  const channel = toHex(await sha256(options.labels.channel))
  const topics = [toHex(await sha256(options.labels.topic))]
  const data = toHex(new TextEncoder().encode("calibrate"))
  let stamp = clock.stamp()
  let attempts = 0
  const done = (outcome: StoreCalibration["outcome"], reason?: string): StoreCalibration => ({
    outcome,
    marginMs: clock.marginMs(),
    durationMs: now() - started,
    attempts,
    ...(reason === undefined ? {} : { reason }),
  })
  for (;;) {
    const wire = { expiry: packExpiry(stamp.ms, ttlS), channel, topics, data }
    attempts++
    try {
      const proof = await withTimeout(store.createProofAuthorized(wire), options.signTimeoutMs ?? SIGN_TIMEOUT_MS)
      await withTimeout(store.submit({ ...wire, proof }), options.submitTimeoutMs ?? SUBMIT_TIMEOUT_MS)
      clock.accepted(stamp)
      return done(stamp.retry ? "learned" : "accepted")
    } catch (e) {
      const reason = errMessage(e)
      if (!isTimeRejection(e)) return done("failed", reason)
      if (stamp.retry) {
        clock.rejected(stamp, reason)
        return done("rejected", reason)
      }
      stamp = clock.retryStamp(stamp, ttlS)
    }
  }
}
