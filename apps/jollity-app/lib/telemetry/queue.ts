// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * THE DELIVERY QUEUE: bounded, concurrent and retrying.
 *
 * No send result closes telemetry for the page session. Failed sends are
 * retried with backoff;
 * offline sends remain held until `resume()`; and metrics are displaced
 * before events when the queue reaches its cap.
 *
 * The queue starts sends synchronously, up to MAX_IN_FLIGHT, so the group of
 * envelopes produced by pagehide reaches the browser transport before the
 * page is torn down. The sender and observer are injected, keeping this file
 * independent of Sentry, storage and the browser.
 *
 * THE RATE-LIMIT BARRIER IS PER LANE. Every item belongs to one lane
 * (init.ts: "log" for log envelopes, "event" for the rest). An answer names
 * the lanes its limit covers; an answer that names none (a Retry-After, a
 * category-less limit, a bare 429) holds every lane. So a spike in errors
 * does not starve the game logs, and a log quota does not hold real failures.
 */
export const QUEUE_CAP = 200
/** The browser fetch transport's request buffer. */
export const MAX_IN_FLIGHT = 40
/** Initial send plus this many retries. */
const PER_ITEM_RETRY_LIMIT = 5
/** A transport that never answers is itself a failed upload. */
export const SEND_TIMEOUT_MS = 15_000
/** After the request timeout, keep the ambiguous claim briefly so a late
 * success can still win without a duplicate. A sender that never settles must
 * not keep queue capacity or pagehide flushes alive forever. */
export const SEND_UNCERTAIN_FOLLOW_MS = 60_000

const RETRY_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 15_000] as const

export type SendFailureReason = "fetch" | "4xx" | "429" | "5xx" | "timeout"
/** Why a send counted as rate-limited: a real HTTP 429, a 2xx that carried
 *  x-sentry-rate-limits, or the SDK's own local drop (no status). */
type RateLimitKind = "server_429" | "limited_2xx" | "local_drop"
interface RateLimitEntry {
  categories: string[]
  scope: string
  reason: string
}
export interface RateLimitInfo {
  kind: RateLimitKind
  /** the raw x-sentry-rate-limits header, when there was one */
  header?: string
  entries: RateLimitEntry[]
}
export type SendAnswer =
  | true
  | "offline"
  | {
      delivered: true
      retryAfterMs: number
      rateLimit?: RateLimitInfo
      lanes?: readonly string[]
      /** Per-lane delays from one response; each lane keeps its own duration. */
      laneDelays?: Readonly<Record<string, number>>
    }
  | {
      failed: SendFailureReason
      /** server-derived: holds the answer's lanes, whatever the failure class */
      retryAfterMs?: number
      /** the lanes retryAfterMs holds; absent means every lane */
      lanes?: readonly string[]
      /** Per-lane delays from one response; each lane keeps its own duration. */
      laneDelays?: Readonly<Record<string, number>>
      statusCode?: number
      locallyRateLimited?: boolean
      rateLimit?: RateLimitInfo
      /** a resend of this item cannot succeed (an accepted event id lost an
       *  item): settle it undelivered now and let its owner send it afresh */
      final?: boolean
    }
export type QueueItemKind = "event" | "metric"
type Sender<T> = (item: T) => Promise<SendAnswer>

export interface QueueObserver {
  failed(reason: SendFailureReason): void
  retried(): void
  dropped(kind: QueueItemKind): void
  offline(ms: number): void
  recoveredTimeout(): void
  deliveredAfter(ms: number): void
  /** a send was rate-limited, with what the server said about it */
  rateLimited?(info: RateLimitInfo): void
  /** `lanes.of` returned a name absent from `lanes.names`. */
  unknownLane?(lane: string): void
}

const NOOP_OBSERVER: QueueObserver = {
  failed: () => {},
  retried: () => {},
  dropped: () => {},
  offline: () => {},
  recoveredTimeout: () => {},
  deliveredAfter: () => {},
}

export interface DeliveryQueue<T> {
  push(item: T, metric?: boolean): Promise<boolean>
  /** Resumes delivery after the browser reports `online`. */
  resume(): void
  /** Page teardown: skip item backoff/offline holding and start queued work now.
   * A server Retry-After remains authoritative for the lanes it holds. */
  flushNow(): void
  whenIdle(): Promise<void>
  size(): number
  setSender(send: Sender<T>): void
  /** When `lane`'s barrier expires, so a caller can mirror it without keeping
   *  a second copy of the deadline (which load() rewrites). */
  deadlineOf(lane: string): number
}

/** One persisted deadline per lane. */
export interface RateLimitDeadlineStore {
  load(lane: string): number
  save(until: number, lane: string): void
}

export interface QueueLanes<T> {
  /** every lane, so "all lanes" is a known set */
  names: readonly string[]
  of(item: T): string
}

/** A queue with no lane of its own: one default lane, every item in it. */
function singleLane<T>(): QueueLanes<T> {
  return { names: ["default"], of: () => "default" }
}

const NOOP_RATE_LIMIT_STORE: RateLimitDeadlineStore = {
  load: () => 0,
  save: () => {},
}

export interface QueueOptions<T> {
  cap?: number
  now?: () => number
  observer?: QueueObserver
  rateLimitStore?: RateLimitDeadlineStore
  lanes?: QueueLanes<T>
}

/** setTimeout stores its delay as a signed 32-bit int: a longer one wraps to a
 *  tiny or negative value and spins. Cap the timer, never the deadline. */
const MAX_TIMER_MS = 2_147_483_647

export function createQueue<T>(options: QueueOptions<T> = {}): DeliveryQueue<T> {
  const cap = options.cap ?? QUEUE_CAP
  const now = options.now ?? Date.now
  const observer = options.observer ?? NOOP_OBSERVER
  const rateLimitStore = options.rateLimitStore ?? NOOP_RATE_LIMIT_STORE
  const lanes = options.lanes ?? singleLane<T>()
  if (lanes.names.length === 0) throw new Error("Delivery queue requires at least one lane")
  type Entry = {
    item: T
    lane: string
    kind: QueueItemKind
    queuedAt: number
    readyAt: number
    /** This item's own server Retry-After, independent of the named lane. */
    serverReadyAt: number
    retries: number
    settle(sent: boolean): void
  }

  let paused = false
  let sender: Sender<T> | null = null
  let inFlight = 0
  let uncertain = 0
  let retryTimer: ReturnType<typeof setTimeout> | undefined
  let offlineSince: number | undefined
  const laneDeadline = new Map(lanes.names.map((lane) => [lane, Math.max(0, rateLimitStore.load(lane))]))
  const unknownLanes = new Set<string>()
  const maxKnownDeadline = (): number => Math.max(0, ...laneDeadline.values())
  /** A lane name the queue does not know (a caller's typo, or an `of` that
   *  drifted) fails closed behind the maximum known deadline. Keep its real
   *  name so the mismatch is observable instead of silently routing it. */
  const laneOf = (item: T): string => {
    const lane = lanes.of(item)
    if (laneDeadline.has(lane)) return lane
    if (!unknownLanes.has(lane)) {
      unknownLanes.add(lane)
      try {
        observer.unknownLane?.(lane)
      } catch {
        // Observability must not break the queue's never-throw push path.
      }
    }
    return lane
  }
  const until = (lane: string): number => laneDeadline.get(lane) ?? maxKnownDeadline()
  /** when this entry may start: its own backoff and its lane's barrier */
  const startsAt = (entry: Entry): number => Math.max(entry.readyAt, until(entry.lane))
  const held: Entry[] = []
  const idleWaiters = new Set<() => void>()

  const noteIdle = () => {
    if (held.length > 0 || inFlight > 0 || uncertain > 0) return
    for (const resolve of idleWaiters) resolve()
    idleWaiters.clear()
  }

  const drop = (entry: Entry) => {
    observer.dropped(entry.kind)
    entry.settle(false)
  }

  const makeRoom = (entry: Entry): boolean => {
    if (held.length + inFlight + uncertain < cap) return true
    // Metrics remain the first displacement class. Within that class (or the
    // event class when no metric is held), retries may sit behind newer work,
    // so array position is not age. Compare queuedAt and include the incoming
    // entry; ties keep the newer push and displace the earlier held entry.
    const displacementKind = entry.kind === "metric" || held.some((candidate) => candidate.kind === "metric")
      ? "metric"
      : "event"
    let oldestHeld = -1
    for (let index = 0; index < held.length; index += 1) {
      const candidate = held[index]!
      if (candidate.kind !== displacementKind) continue
      if (oldestHeld < 0 || candidate.queuedAt < held[oldestHeld]!.queuedAt) oldestHeld = index
    }
    if (entry.kind === displacementKind &&
      (oldestHeld < 0 || entry.queuedAt < held[oldestHeld]!.queuedAt)) {
      drop(entry)
      return false
    }
    if (oldestHeld < 0) {
      drop(entry)
      return false
    }
    drop(held.splice(oldestHeld, 1)[0]!)
    return true
  }

  const enqueue = (entry: Entry, front = false) => {
    if (!makeRoom(entry)) return
    if (front) held.unshift(entry)
    else held.push(entry)
  }

  const extendRateLimit = (
    retryAfterMs: number,
    which: readonly string[] | undefined,
    laneDelays: Readonly<Record<string, number>> | undefined,
  ) => {
    const perLane = Object.entries(laneDelays ?? {})
    if (perLane.length > 0) {
      const safeDelay = (delayMs: number): number => Number.isFinite(delayMs) ? Math.max(0, delayMs) : 0
      // One unknown answer key is a configuration mismatch: fail closed by
      // applying its delay to every known lane, but never persist the typo.
      const unknownDelay = Math.max(0, ...perLane
        .filter(([lane]) => !laneDeadline.has(lane))
        .map(([, delayMs]) => safeDelay(delayMs)))
      for (const lane of lanes.names) {
        const delayMs = Math.max(unknownDelay, safeDelay(laneDelays?.[lane] ?? 0))
        const deadline = now() + delayMs
        if (delayMs <= 0 || deadline <= until(lane)) continue
        laneDeadline.set(lane, deadline)
        rateLimitStore.save(deadline, lane)
      }
      return
    }
    const deadline = now() + Math.max(0, retryAfterMs)
    // A limiter for a lane missing from names is a configuration mismatch.
    // Hold every known lane so unknown items (which use their maximum) cannot
    // escape the server's limit while still never persisting an unknown key.
    const selected = which === undefined || which.length === 0 || which.some((lane) => !laneDeadline.has(lane))
      ? lanes.names
      : which
    for (const lane of selected) {
      if (!laneDeadline.has(lane) || deadline <= until(lane)) continue
      laneDeadline.set(lane, deadline)
      rateLimitStore.save(deadline, lane)
    }
  }

  /** A rate-limited item waits its own lane's barrier AND at least the delay
   *  its own answer named. The answer may name another lane (or none), in
   *  which case this item's lane barrier is already in the past and the item
   *  would otherwise resend at once, burning its retry budget in microtasks. */
  const rateLimitedReadyAt = (entry: Entry, retryAfterMs: number): number =>
    Math.max(until(entry.lane), now() + Math.max(0, retryAfterMs))

  const schedule = () => {
    clearTimeout(retryTimer)
    retryTimer = undefined
    if (paused || sender === null || held.length === 0 || inFlight >= MAX_IN_FLIGHT) return
    const nextAt = Math.min(...held.map(startsAt))
    if (nextAt <= now()) return
    retryTimer = setTimeout(pump, Math.min(nextAt - now(), MAX_TIMER_MS))
  }

  const start = (entry: Entry) => {
    inFlight += 1
    let timedOut = false
    let abandoned = false
    let uncertainTimer: ReturnType<typeof setTimeout> | undefined
    let slotHeld = true
    const releaseSlot = () => {
      if (!slotHeld) return
      slotHeld = false
      inFlight -= 1
    }
    const timeout = setTimeout(() => {
      timedOut = true
      uncertain += 1
      releaseSlot()
      observer.failed("timeout")
      uncertainTimer = setTimeout(() => {
        abandoned = true
        uncertain -= 1
        drop(entry)
        pump()
        noteIdle()
      }, SEND_UNCERTAIN_FOLLOW_MS)
      pump()
      noteIdle()
    }, SEND_TIMEOUT_MS)
    let sending: Promise<SendAnswer>
    try {
      sending = Promise.resolve(sender!(entry.item)).catch((): SendAnswer => ({ failed: "fetch" }))
    } catch {
      sending = Promise.resolve({ failed: "fetch" })
    }
    void sending.then((answer) => {
      if (answer !== true && answer !== "offline" && answer.rateLimit) observer.rateLimited?.(answer.rateLimit)
      const hasRateLimit = answer !== true && answer !== "offline" &&
        ("delivered" in answer || answer.failed === "429" || answer.retryAfterMs !== undefined ||
          Object.keys(answer.laneDelays ?? {}).length > 0)
      // Compute the answer's delay before incrementing the retry counter. The
      // same value drives both the lane barrier and this item's minimum wait
      // (RETRY_BACKOFF_MS).
      const answerDelayMs = answer !== true && answer !== "offline"
        ? answer.retryAfterMs ?? RETRY_BACKOFF_MS[Math.min(entry.retries, RETRY_BACKOFF_MS.length - 1)]!
        : 0
      if (hasRateLimit) {
        // Requests already in flight cannot obey a header they have not seen.
        // Keep them claimed, but start no later sender invocation in each
        // answer lane before that lane's own Retry-After has expired.
        extendRateLimit(answerDelayMs, answer.lanes, answer.laneDelays)
        if (abandoned) pump()
      }
      if (abandoned) return
      clearTimeout(timeout)
      clearTimeout(uncertainTimer)
      releaseSlot()
      if (timedOut) uncertain -= 1
      if (answer === true || (answer !== "offline" && "delivered" in answer)) {
        if (timedOut) observer.recoveredTimeout()
        observer.deliveredAfter(Math.max(0, now() - entry.queuedAt))
        entry.settle(true)
      } else if (answer !== "offline" && answer.locallyRateLimited) {
        // The SDK did not issue a request (its own category limiter or local
        // transport buffer rejected it), so this is neither a failed network
        // attempt nor an ambiguous delivery. Keep the item without consuming
        // its retry budget, including when the queue timeout fired first.
        entry.serverReadyAt = rateLimitedReadyAt(entry, answerDelayMs)
        entry.readyAt = entry.serverReadyAt
        enqueue(entry)
      } else if (timedOut && (answer === "offline" || answer.statusCode === undefined)) {
        // Once the caller's timeout has fired, an answer without an HTTP
        // status is still ambiguous: retrying it can duplicate a send that
        // reached the server. Bound and drop the claim instead.
        drop(entry)
      } else if (answer === "offline") {
        if (!paused) {
          paused = true
          offlineSince = now()
        }
        enqueue(entry)
        held.sort((a, b) => a.queuedAt - b.queuedAt)
      } else if (answer.final) {
        if (!timedOut) observer.failed(answer.failed)
        entry.settle(false)
      } else {
        if (!timedOut) observer.failed(answer.failed)
        // A timed-out fetch may still complete: retrying it can duplicate an
        // event or metric while its outcome is unknown. A late definite
        // failure removes that ambiguity, so it is safe to retry normally.
        if (entry.retries < PER_ITEM_RETRY_LIMIT) {
          entry.retries += 1
          observer.retried()
          if (answer.failed === "429" || answer.retryAfterMs !== undefined) {
            entry.serverReadyAt = rateLimitedReadyAt(entry, answerDelayMs)
            entry.readyAt = entry.serverReadyAt
          } else {
            entry.readyAt = now() + RETRY_BACKOFF_MS[entry.retries - 1]!
          }
          enqueue(entry)
        } else drop(entry)
      }
      pump()
      noteIdle()
    })
  }

  function pump(): void {
    clearTimeout(retryTimer)
    retryTimer = undefined
    if (paused || sender === null) return
    while (inFlight < MAX_IN_FLIGHT) {
      const ready = held.findIndex((entry) => startsAt(entry) <= now())
      if (ready < 0) break
      start(held.splice(ready, 1)[0]!)
    }
    schedule()
  }

  return {
    push(item, metric = false) {
      return new Promise<boolean>((settle) => {
        const at = now()
        enqueue({ item, lane: laneOf(item), kind: metric ? "metric" : "event", queuedAt: at, readyAt: at, serverReadyAt: 0, retries: 0, settle })
        pump()
      })
    },
    resume() {
      if (offlineSince !== undefined) {
        observer.offline(Math.max(0, now() - offlineSince))
        offlineSince = undefined
      }
      paused = false
      pump()
    },
    flushNow() {
      if (offlineSince !== undefined) {
        observer.offline(Math.max(0, now() - offlineSince))
        offlineSince = undefined
      }
      paused = false
      const at = now()
      for (const entry of held) entry.readyAt = Math.max(at, entry.serverReadyAt)
      pump()
    },
    whenIdle() {
      if (held.length === 0 && inFlight === 0 && uncertain === 0) return Promise.resolve()
      return new Promise<void>((resolve) => idleWaiters.add(resolve))
    },
    size: () => held.length + inFlight + uncertain,
    setSender(send) {
      sender = send
      pump()
    },
    deadlineOf: (lane) => until(lane),
  }
}
