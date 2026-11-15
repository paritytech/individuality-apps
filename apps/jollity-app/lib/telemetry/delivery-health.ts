// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Durable delivery-health counters. One record follows a game across reloads:
 * active while it can still be rejoined, closed once the game is known over,
 * and sent once its health event lands. The record disappears after both the
 * health event and game log land, with a bounded fallback for missing logs.
 */
import { warnThrottled } from "../debug/warn-throttled"
import { tryReadStoredString, writeStoredString } from "../host/storage"
import { withTimeout } from "../with-timeout"
import type { QueueItemKind, QueueObserver, RateLimitInfo, SendFailureReason } from "./queue"

const MAX_REASONS_LENGTH = 300
const MAX_LAST_LENGTH = 200
const STORE_KEY = "jollity.telemetry.delivery-health.v1"
const WRITE_DELAY_MS = 1_000
const OPTIONAL_READ_WAIT_MS = 1_000
const SENT_KEEP_GAMES = 5
const SENT_KEEP_MS = 7 * 24 * 60 * 60_000
/** A sign-up can create a record before the handover sink exists. If that page
 * is then killed, age is the only durable proof that the game is over. */
export const ORPHAN_AFTER_MS = 7 * 24 * 60 * 60_000

export interface DeliveryHealth {
  failed: Record<SendFailureReason, number>
  retries: number
  droppedEvents: number
  droppedMetrics: number
  offlineMs: number
  recoveredTimeouts: number
  longestWaitMs: number
  /** distinct queue lane names missing from the configured lane set */
  unknownLanes: number
  /** failed_429 lumps three things; these split it (raw numbers) */
  failed429Server: number
  failed429Local: number
  limited2xx: number
  /** the most recent raw x-sentry-rate-limits header */
  rateLimitLast: string
  /** distinct "scope:reason:categories" seen, "|"-joined */
  rateLimitReasons: string
}

export interface StoredHealth {
  game: DeliveryHealth
  session: DeliveryHealth
}

interface GameHealthRecord extends StoredHealth {
  state: "active" | "closed" | "sent"
  healthSent: boolean
  logSent: boolean
  updatedAt: number
}

const zero = (): DeliveryHealth => ({
  failed: { fetch: 0, "4xx": 0, "429": 0, "5xx": 0, timeout: 0 },
  retries: 0,
  droppedEvents: 0,
  droppedMetrics: 0,
  offlineMs: 0,
  recoveredTimeouts: 0,
  longestWaitMs: 0,
  unknownLanes: 0,
  failed429Server: 0,
  failed429Local: 0,
  limited2xx: 0,
  rateLimitLast: "",
  rateLimitReasons: "",
})

const copy = (value: DeliveryHealth): DeliveryHealth => ({ ...value, failed: { ...value.failed } })
const copyStored = (value: StoredHealth): StoredHealth => ({ game: copy(value.game), session: copy(value.session) })

const asHealth = (raw: unknown): DeliveryHealth | null => {
  const value = raw as Partial<DeliveryHealth> | null
  if (!value || typeof value !== "object") return null
  const next = zero()
  for (const reason of Object.keys(next.failed) as SendFailureReason[]) {
    const count = value.failed?.[reason]
    if (typeof count === "number" && Number.isFinite(count)) next.failed[reason] = count
  }
  for (const key of ["retries", "droppedEvents", "droppedMetrics", "offlineMs", "recoveredTimeouts", "longestWaitMs", "unknownLanes", "failed429Server", "failed429Local", "limited2xx"] as const) {
    const count = value[key]
    if (typeof count === "number" && Number.isFinite(count)) next[key] = count
  }
  if (typeof value.rateLimitLast === "string") next.rateLimitLast = value.rateLimitLast.slice(0, MAX_LAST_LENGTH)
  if (typeof value.rateLimitReasons === "string") next.rateLimitReasons = value.rateLimitReasons.slice(0, MAX_REASONS_LENGTH)
  return next
}

const asRecord = (raw: unknown): GameHealthRecord | null => {
  const value = raw as Partial<GameHealthRecord> | null
  if (!value || typeof value !== "object") return null
  const game = asHealth(value?.game)
  const page = asHealth(value?.session)
  if (!game || !page) return null
  const state = value?.state
  if (state !== "active" && state !== "closed" && state !== "sent") return null
  return {
    game,
    session: page,
    state,
    healthSent: value.healthSent === true,
    logSent: value.logSent === true,
    updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : 0,
  }
}

const addHealth = (target: DeliveryHealth, delta: DeliveryHealth): void => {
  for (const reason of Object.keys(target.failed) as SendFailureReason[]) target.failed[reason] += delta.failed[reason]
  target.retries += delta.retries
  target.droppedEvents += delta.droppedEvents
  target.droppedMetrics += delta.droppedMetrics
  target.offlineMs += delta.offlineMs
  target.recoveredTimeouts += delta.recoveredTimeouts
  target.longestWaitMs = Math.max(target.longestWaitMs, delta.longestWaitMs)
  target.unknownLanes += delta.unknownLanes
  target.failed429Server += delta.failed429Server
  target.failed429Local += delta.failed429Local
  target.limited2xx += delta.limited2xx
  if (delta.rateLimitLast) target.rateLimitLast = delta.rateLimitLast
  target.rateLimitReasons = mergeReasons(target.rateLimitReasons, delta.rateLimitReasons)
}

const mergeReasons = (current: string, extra: string): string => {
  const seen = new Set(current ? current.split("|") : [])
  for (const reason of extra ? extra.split("|") : []) {
    if (seen.has(reason) || [...seen, reason].join("|").length > MAX_REASONS_LENGTH) continue
    seen.add(reason)
  }
  return [...seen].join("|")
}

const noteRateLimit = (health: DeliveryHealth, info: RateLimitInfo): void => {
  if (info.kind === "server_429") health.failed429Server += 1
  else if (info.kind === "limited_2xx") health.limited2xx += 1
  else health.failed429Local += 1
  if (info.header) health.rateLimitLast = info.header.slice(0, MAX_LAST_LENGTH)
  const keys = info.entries.map((entry) => `${entry.scope}:${entry.reason}:${entry.categories.join(";")}`)
  health.rateLimitReasons = mergeReasons(health.rateLimitReasons, keys.join("|"))
}

let session = zero()
let gameIndex: number | null = null
let games = new Map<number, GameHealthRecord>()
let pending = new Set<number>()
let load: Promise<boolean> | null = null
let writeInFlight: Promise<void> | null = null
let writeDirty = false
let lastPersisted = ""
let writeTimer: ReturnType<typeof setTimeout> | undefined

const newRecord = (): GameHealthRecord => ({
  game: zero(),
  session: copy(session),
  state: "active",
  healthSent: false,
  logSent: false,
  updatedAt: Date.now(),
})

const closeOrphans = (now = Date.now()) => {
  for (const [index, record] of games) {
    if (record.state !== "active" || now - record.updatedAt < ORPHAN_AFTER_MS) continue
    record.state = "closed"
    if (!record.healthSent) pending.add(index)
  }
}

const ready = (): Promise<boolean> => {
  if (load) return load
  const attempt = (async () => {
    const read = await tryReadStoredString(STORE_KEY)
    if (!read.ok) return false
    if (!read.value) return true
    lastPersisted = read.value
    try {
      const raw = JSON.parse(read.value) as { games?: Record<string, unknown>; pending?: unknown[] }
      for (const [key, value] of Object.entries(raw.games ?? {})) {
        const index = Number(key)
        const stored = asRecord(value)
        if (!Number.isInteger(index) || !stored) continue
        const current = games.get(index)
        if (current) {
          addHealth(stored.game, current.game)
          stored.session = current.session
          stored.state = current.state
          stored.healthSent ||= current.healthSent
          stored.logSent ||= current.logSent
          stored.updatedAt = Math.max(stored.updatedAt, current.updatedAt)
        }
        games.set(index, stored)
      }
      for (const index of raw.pending ?? []) if (Number.isInteger(index) && games.has(index as number)) pending.add(index as number)
      closeOrphans()
    } catch (error) {
      warnThrottled("delivery-health-parse", "telemetry", "delivery health store could not be read", error)
    }
    return true
  })()
  load = attempt
  void attempt.then((loaded) => {
    // A failed host-storage read is not an empty store. Let the next persist
    // retry the read, and keep all writes blocked until one succeeds.
    if (!loaded && load === attempt) load = null
  })
  return attempt
}

const readReady = async (): Promise<void> => {
  while (!(await ready())) await new Promise((resolve) => setTimeout(resolve, WRITE_DELAY_MS))
}

/** Optional consumers may proceed without delivery health. Unlike readReady,
 * this does not leave a retry loop running after its deadline. */
const readReadyWithin = async (waitMs: number): Promise<boolean> => {
  const deadline = Date.now() + waitMs
  while (true) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) return false
    const loaded = await withTimeout(ready(), remaining)
    if (loaded === true) return true
    if (loaded === null) return false
    const delay = Math.min(WRITE_DELAY_MS, deadline - Date.now())
    if (delay <= 0) return false
    await new Promise((resolve) => setTimeout(resolve, delay))
  }
}

const prune = (now = Date.now()) => {
  const newest = Math.max(-Infinity, ...games.keys())
  for (const [index, record] of games) {
    const complete = record.healthSent && record.logSent
    const staleSent = record.healthSent && (index <= newest - SENT_KEEP_GAMES || now - record.updatedAt >= SENT_KEEP_MS)
    if (!complete && !staleSent) continue
    games.delete(index)
    pending.delete(index)
  }
}

const persistNow = () => {
  clearTimeout(writeTimer)
  writeTimer = undefined
  writeDirty = true
  if (writeInFlight) return writeInFlight
  let retryRead = false
  writeInFlight = (async () => {
    if (!(await ready())) {
      retryRead = true
      return
    }
    while (writeDirty) {
      writeDirty = false
      closeOrphans()
      prune()
      const serialized = JSON.stringify({ games: Object.fromEntries(games), pending: [...pending] })
      if (serialized === lastPersisted) continue
      await writeStoredString(STORE_KEY, serialized)
      lastPersisted = serialized
    }
  })()
    .catch(() => {})
    .finally(() => {
      writeInFlight = null
      if (!writeDirty) return
      if (retryRead) persistSoon()
      else void persistNow()
    })
  return writeInFlight
}

const persistSoon = () => {
  if (writeTimer !== undefined) return
  writeTimer = setTimeout(() => void persistNow(), WRITE_DELAY_MS)
}

const activeRecord = (): GameHealthRecord | null => {
  if (gameIndex === null) return null
  const record = games.get(gameIndex) ?? newRecord()
  games.set(gameIndex, record)
  return record
}

const mutate = (change: (health: DeliveryHealth) => boolean) => {
  change(session)
  const record = activeRecord()
  const gameChanged = record ? change(record.game) : false
  if (record && gameChanged) {
    record.session = copy(session)
    record.updatedAt = Date.now()
  }
  if (gameChanged) persistSoon()
}

const increment = (change: (health: DeliveryHealth) => void) => (health: DeliveryHealth) => {
  change(health)
  return true
}

export const deliveryHealthObserver: QueueObserver = {
  failed: (reason) => mutate(increment((health) => (health.failed[reason] += 1))),
  retried: () => mutate(increment((health) => (health.retries += 1))),
  dropped: (kind: QueueItemKind) =>
    mutate(
      increment((health) => {
        if (kind === "metric") health.droppedMetrics += 1
        else health.droppedEvents += 1
      }),
    ),
  offline: (ms) => mutate(increment((health) => (health.offlineMs += ms))),
  rateLimited: (info) => mutate(increment((health) => noteRateLimit(health, info))),
  recoveredTimeout: () => mutate(increment((health) => (health.recoveredTimeouts += 1))),
  unknownLane: () => mutate(increment((health) => (health.unknownLanes += 1))),
  deliveredAfter: (ms) =>
    mutate((health) => {
      if (ms <= health.longestWaitMs) return false
      health.longestWaitMs = ms
      return true
    }),
}

export function setDeliveryHealthGame(next: number | null): boolean {
  const previous = gameIndex
  if (next !== null && previous !== null && next < previous) return false
  if (next !== null && previous !== null && next > previous) closeDeliveryHealthGame(previous)
  const changed = gameIndex !== next
  gameIndex = next
  if (next !== null) {
    const record = games.get(next) ?? newRecord()
    record.state = "active"
    record.updatedAt = Date.now()
    games.set(next, record)
  }
  if (changed) void persistNow()
  else persistSoon()
  return true
}

/** The game is known over. Rejoins and route changes do not call this. */
export function closeDeliveryHealthGame(index: number): void {
  const existing = games.get(index)
  if (existing && existing.state !== "active") return
  const record = existing ?? newRecord()
  record.state = record.healthSent ? "sent" : "closed"
  record.updatedAt = Date.now()
  games.set(index, record)
  if (!record.healthSent) pending.add(index)
  void persistNow()
}

export async function deliveryHealthForGame(index: number): Promise<StoredHealth> {
  await readReady()
  const stored = games.get(index) ?? { game: zero(), session: zero() }
  return copyStored(stored)
}

/** A best-effort snapshot for an attachment that must not block its event. */
export async function optionalDeliveryHealthForGame(index: number, waitMs = OPTIONAL_READ_WAIT_MS): Promise<StoredHealth | null> {
  if (!(await readReadyWithin(Math.min(waitMs, OPTIONAL_READ_WAIT_MS)))) return null
  const stored = games.get(index)
  return stored ? copyStored(stored) : null
}

export async function pendingDeliveryHealth(): Promise<Array<{ gameIndex: number; game: DeliveryHealth; session: DeliveryHealth }>> {
  await readReady()
  await writeInFlight
  return [...pending].flatMap((index) => {
    const record = games.get(index)
    return record && !record.healthSent ? [{ gameIndex: index, ...copyStored(record) }] : []
  })
}

export async function closeDeliveryHealthGameIfOpen(index: number): Promise<void> {
  await readReady()
  const record = games.get(index)
  if (record?.state === "active") closeDeliveryHealthGame(index)
}

export async function markDeliveryHealthSent(index: number): Promise<void> {
  await readReady()
  const record = games.get(index)
  if (!record) return
  record.healthSent = true
  record.state = "sent"
  record.updatedAt = Date.now()
  pending.delete(index)
  if (gameIndex === index) gameIndex = null
  prune()
  await persistNow()
}

export async function markDeliveryHealthLogSent(index: number): Promise<void> {
  if (!(await readReadyWithin(OPTIONAL_READ_WAIT_MS))) return
  const record = games.get(index)
  if (!record) return
  record.logSent = true
  record.updatedAt = Date.now()
  prune()
  await persistNow()
}

/** Immediate persistence for pagehide and lifecycle boundaries. */
export function flushDeliveryHealthWrites(): void {
  void persistNow()
}

export async function flushDeliveryHealthWritesForTests(): Promise<void> {
  await persistNow()
  await writeInFlight
}

export function resetDeliveryHealthForTests(): void {
  clearTimeout(writeTimer)
  writeTimer = undefined
  session = zero()
  gameIndex = null
  games = new Map()
  pending = new Set()
  load = null
  writeInFlight = null
  writeDirty = false
  lastPersisted = ""
}
