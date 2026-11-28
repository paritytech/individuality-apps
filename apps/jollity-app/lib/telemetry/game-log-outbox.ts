// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Durable, host-independent game-log checkpoints (#723).
 *
 * A devLog line enters memory synchronously. At a game boundary the pending
 * lines are split below the keepalive budget and written to localStorage
 * before any network work starts. Delivery confirmation moves only metadata
 * to the receipt list; a failed, offline, rate-limited or killed send leaves
 * the complete chunk for the next checkpoint/open/online/visible edge.
 *
 * This module deliberately never imports lib/host: a host call that never
 * answers must not stand between a captured line and its durable outbox.
 */
import * as Sentry from "@sentry/react"
import { APP_VERSION } from "../debug/flag"
import { addDevLogSink, type SinkEntry } from "../debug/log-store"
import { newId, SESSION_ID } from "../debug/session-id"
import { readSessionLink, retainSessionLink } from "../debug/session-link"
import { expectDelivery, sendLogEnvelope, takeAttachmentDropped, takeLogRejected } from "./init"
import {
  buildRecord,
  packLines,
  recordIdentity,
  specialLine,
  stableHexId as stableEventId,
  telemetryLogsEnabled,
  type LogLine,
  type LogRecord,
} from "./log-envelope"
import { withTimeout } from "../with-timeout"

export const GAME_LOG_OUTBOX_KEY = "jollity.telemetry.game-log-outbox.v1"
export const GAME_LOG_CHUNK_KEY_PREFIX = `${GAME_LOG_OUTBOX_KEY}.chunk.`
/** Prefix only: each page owns a distinct live-tail key. */
export const GAME_LOG_ACTIVE_KEY = `${GAME_LOG_OUTBOX_KEY}.active.`
const LEGACY_GAME_LOG_ACTIVE_KEY = `${GAME_LOG_OUTBOX_KEY}.active`
export const GAME_LOG_DEVICE_KEY = "jollity.telemetry.game-log-device.v1"
export const GAME_LOG_CHUNK_MAX_BYTES = 48 * 1024
export const GAME_LOG_OUTBOX_MAX_BYTES = 2 * 1024 * 1024
const DELIVERY_FOLLOW_MS = 6 * 60 * 60_000
const DELIVERY_ATTEMPT_MS = 60_000
const RETRY_MIN_MS = 5_000
const RETRY_MAX_MS = 5 * 60_000
const SETTLED_KEEP = 20
const HOST_BOOKKEEPING_MS = 3_000

export type GameLogCheckpoint = "handover" | "rolling" | "round-1" | "report" | "payoff" | "late" | "flush" | "draw" | "chest" | "hidden" | "pagehide"

export interface GameLogChunkLine {
  ts: number
  sessionId: string
  lineId: string
  level: "info" | "warn" | "error"
  tag: string
  message: string
  data?: string
}

export interface GameLogChunk {
  schema: 1
  id: string
  beginId: string
  gameIndex: number
  sessionId: string
  account: string | null
  deviceId: string
  /** Build which captured the lines; optional only for schema-1 legacy items. */
  version?: string
  seq: number
  part: number
  checkpoint: GameLogCheckpoint
  capturedAt: number
  from: number
  to: number
  lines: GameLogChunkLine[]
  evictedOnDevice?: GameLogEviction[]
}

interface StorageFallbackDelivery {
  logEvent(
    name: string,
    level: "info" | "warn",
    attributes: Record<string, string | number | boolean | undefined>,
  ): void
  recordCount(name: string, value: number, attrs: Record<string, string>): void
}

let storageFallbackDelivery: StorageFallbackDelivery | null = null

/** Install Log + Metric delivery without adding an outbox-to-init import cycle. */
export function setGameLogOutboxStorageFallbackDelivery(next: StorageFallbackDelivery): void {
  storageFallbackDelivery = next
}

export interface GameLogFullPart {
  schema: 1
  kind: "full"
  id: string
  copyId: string
  gameIndex: number
  sessionId: string
  account: string | null
  deviceId: string
  stage: "report" | "payoff" | "late" | "flush"
  capturedAt: number
  part: number
  parts: number
  filename: string
  trace: { traceId: string; spanId: string } | null
  document: FullLogDocument
  evictedOnDevice?: GameLogEviction[]
}

export interface GameLogFullCopy {
  id: string
  gameIndex: number
  stage: GameLogFullPart["stage"]
  createdAt: number
  partIds: string[]
}

/** idEpoch: bumped, durably, each time Sentry PROVABLY accepted the item's
 *  event without its attachment (a 2xx naming an attachment limit). The
 *  event id derives from id + epoch, so ambiguous failures (no answer, 5xx,
 *  timeout) retry under the same id and stay idempotent, while a partial
 *  acceptance is resent as a new event Sentry cannot discard as a duplicate. */
type GameLogOutboxItem = (GameLogChunk | GameLogFullPart) & {
  idEpoch?: number
}

export interface GameLogChunkReceipt {
  kind?: "chunk"
  id: string
  beginId: string
  gameIndex: number
  sessionId: string
  account: string | null
  deviceId: string
  seq: number
  part: number
  checkpoint: GameLogCheckpoint
  capturedAt: number
  from: number
  to: number
}

export interface GameLogFullPartReceipt {
  kind: "full"
  id: string
  copyId: string
  gameIndex: number
  stage: GameLogFullPart["stage"]
  capturedAt: number
  part: number
  parts: number
}

type GameLogReceipt = GameLogChunkReceipt | GameLogFullPartReceipt

export interface GameLogEviction {
  id: string
  gameIndex: number
  reason?: "too-large"
}

interface StoredOutbox {
  chunks: GameLogOutboxItem[]
  delivered: GameLogReceipt[]
  fullCopies: GameLogFullCopy[]
  /** A successful full-log upload retires receipts, never pending chunks. */
  settledGames: number[]
  /** Durable until included with a confirmed later chunk delivery. */
  evicted: GameLogEviction[]
}

interface StoredOutboxIndex {
  chunkIds: string[]
  delivered: GameLogReceipt[]
  /** Migrated into delivered on read. */
  fullDelivered?: string[]
  fullCopies?: GameLogFullCopy[]
  settledGames: number[]
  evicted?: GameLogEviction[]
}

const emptyStore = (): StoredOutbox => ({ chunks: [], delivered: [], fullCopies: [], settledGames: [], evicted: [] })
let memoryStore = emptyStore()
let storageDirty = false
let durableBytes: number | null = null
interface ActiveGameLog {
  gameIndex: number
  beginId: string
  seq: number
  sessionId: string
  account: string | null
  deviceId: string
  lines: GameLogChunkLine[]
}
interface VolatileSeal {
  chunks: GameLogChunk[]
  lines: GameLogChunkLine[]
}
let active: ActiveGameLog | null = null
/** A volatile chunk owns these lines in memory, while its origin tail keeps a
 * durable recovery copy. The registry survives settlement until either the
 * chunk is durable or Sentry acceptance is committed. */
const volatileSeals = new Map<ActiveGameLog, VolatileSeal[]>()
/** Delivery truth for this page lifetime. Storage reconciliation may lag or
 * fail completely, but an acknowledged chunk id must never reach transport
 * twice while this page remains alive. */
const acceptedChunkIds = new Set<string>()
/** The next sequence is monotonic for each capture origin. A stale durable
 * tail may raise this floor during recovery, but can never lower it. */
const sequenceFloors = new Map<string, number>()
let activeStorageKeys = new WeakMap<ActiveGameLog, string>()
let activeFlushTimer: ReturnType<typeof setTimeout> | null = null
const ACTIVE_FLUSH_MS = 250
const ROLLING_SEND_MS = 3_000
/** Bound the only interval that has not reached durable Logs yet. A game page
 * can be killed without visibilitychange/pagehide, so waiting for round one
 * loses its whole opening page from the outbox, even though the full export
 * from the host-storage ring (lib/debug/log-chunks.ts) can recover it later.
 * One packed-record worth of lines is a small, deterministic persistence
 * boundary and keeps live delivery bounded. */
export const ROLLING_CHECKPOINT_LINES = 50
let account: string | null = null
const draining = new Set<string>()
const drainWaiters = new Map<string, { promise: Promise<void>; resolve: () => void }>()
let installed = false
let retryTimer: ReturnType<typeof setTimeout> | null = null
let rollingSendTimer: ReturnType<typeof setTimeout> | null = null
let retryMs = RETRY_MIN_MS
let lastMemoryOnly = ""
let fullLogDelivered: ((copy: GameLogFullCopy) => void | Promise<void>) | null = null
const completionNotifications = new Map<string, Promise<void>>()
/** A synchronous enqueue caller must not report a full copy delivered after
 * one of its parts received a final 413. A reload has no waiting caller. */
const rejectedFullCopies = new Set<string>()
const recoveryProtectedGames = new Set<number>()

const freshBeginId = (): string => `${Date.now().toString(36)}-${newId()}`

const isFullPart = (item: GameLogOutboxItem): item is GameLogFullPart => "kind" in item && item.kind === "full"
const itemOrder = (item: GameLogOutboxItem): number => item.capturedAt

function local(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage
  } catch {
    return null
  }
}

type LegacyStoredOutbox = Pick<StoredOutbox, "chunks" | "delivered"> & Partial<StoredOutbox> & { fullDelivered?: string[] }

function validStore(value: unknown): value is LegacyStoredOutbox {
  const item = value as Partial<StoredOutbox> | null
  return Array.isArray(item?.chunks) && Array.isArray(item?.delivered)
}

function validIndex(value: unknown): value is StoredOutboxIndex {
  const item = value as Partial<StoredOutboxIndex> | null
  return Array.isArray(item?.chunkIds) && Array.isArray(item?.delivered) && Array.isArray(item?.settledGames)
}

function migrateFullReceipts(
  delivered: GameLogReceipt[],
  legacyIds: readonly string[],
  copies: readonly GameLogFullCopy[],
  parts: readonly GameLogOutboxItem[],
): GameLogReceipt[] {
  if (legacyIds.length === 0) return delivered
  const byId = new Map(parts.filter(isFullPart).map((part) => [part.id, part]))
  const byPartId = new Map(copies.flatMap((copy) => copy.partIds.map((id, part) => [id, { copy, part }] as const)))
  return [...delivered, ...legacyIds.flatMap((id): GameLogFullPartReceipt[] => {
    const current = byId.get(id)
    const known = byPartId.get(id)
    if (!known) return []
    return [{
      kind: "full",
      id,
      copyId: known.copy.id,
      gameIndex: known.copy.gameIndex,
      stage: known.copy.stage,
      capturedAt: current?.capturedAt ?? known.copy.createdAt,
      part: current?.part ?? known.part,
      parts: current?.parts ?? known.copy.partIds.length,
    }]
  })]
}

const chunkKey = (id: string): string => `${GAME_LOG_CHUNK_KEY_PREFIX}${encodeURIComponent(id)}`

function readStore(): StoredOutbox {
  // Once a durable write fails, the in-memory copy is newer than the stale
  // localStorage value. Do not reload that stale value and silently erase the
  // evidence we just retained for this page lifetime.
  if (storageDirty) return memoryStore
  const storage = local()
  if (!storage) return memoryStore
  try {
    const raw = storage.getItem(GAME_LOG_OUTBOX_KEY)
    if (!raw) return memoryStore
    const parsed: unknown = JSON.parse(raw)
    if (validIndex(parsed)) {
      const indexed = new Set(parsed.chunkIds)
      const chunks = parsed.chunkIds.flatMap((id) => {
        try {
          const value = storage.getItem(chunkKey(id))
          return value ? [JSON.parse(value) as GameLogOutboxItem] : []
        } catch {
          return []
        }
      })
      const orphans: GameLogOutboxItem[] = []
      const terminalIds = new Set([
        ...parsed.delivered.map((item) => item.id),
        ...(parsed.evicted ?? []).map((item) => item.id),
      ])
      const terminalKeys: string[] = []
      if (typeof storage.key === "function" && typeof storage.length === "number") {
        for (let index = 0; index < storage.length; index += 1) {
          const key = storage.key(index)
          if (!key?.startsWith(GAME_LOG_CHUNK_KEY_PREFIX)) continue
          try {
            const value = storage.getItem(key)
            const chunk = value ? JSON.parse(value) as GameLogOutboxItem : null
            if (chunk?.schema === 1 && typeof chunk.id === "string" && terminalIds.has(chunk.id) && !indexed.has(chunk.id)) {
              terminalKeys.push(key)
            } else if (chunk?.schema === 1 && typeof chunk.id === "string" && (isFullPart(chunk) || Array.isArray(chunk.lines)) && !indexed.has(chunk.id)) {
              indexed.add(chunk.id)
              orphans.push(chunk)
            }
          } catch {
            /* leave unreadable evidence untouched */
          }
        }
      }
      for (const key of terminalKeys) storage.removeItem(key)
      const allChunks = [...chunks, ...orphans]
      const fullCopies = parsed.fullCopies ?? []
      memoryStore = {
        chunks: allChunks,
        delivered: migrateFullReceipts(parsed.delivered, parsed.fullDelivered ?? [], fullCopies, allChunks),
        fullCopies,
        settledGames: parsed.settledGames,
        evicted: parsed.evicted ?? [],
      }
      // A page can die after a chunk key is durable but before its index is.
      // Re-index discovered keys before returning so the next reload sees them.
      if (orphans.length > 0) writeStore(memoryStore)
    } else if (validStore(parsed)) {
      // Version-one migration: the next write fans this monolithic value out
      // into per-chunk keys without deleting any pending evidence.
      memoryStore = {
        chunks: parsed.chunks,
        delivered: migrateFullReceipts(parsed.delivered, Array.isArray(parsed.fullDelivered) ? parsed.fullDelivered : [], Array.isArray(parsed.fullCopies) ? parsed.fullCopies : [], parsed.chunks),
        fullCopies: Array.isArray(parsed.fullCopies) ? parsed.fullCopies : [],
        settledGames: Array.isArray(parsed.settledGames) ? parsed.settledGames : [],
        evicted: [],
      }
    }
  } catch {
    /* the in-memory copy remains usable */
  }
  return memoryStore
}

function reportStorageFallback(
  reason: "unavailable" | "full",
  memoryOnly = memoryStore.chunks.map((chunk) => chunk.id),
  shed: GameLogOutboxItem[] = [],
): void {
  const signature = `${reason}:${memoryOnly.join("\u0000")}:${shed.map((chunk) => chunk.id).join("\u0000")}`
  if (signature === lastMemoryOnly) return
  lastMemoryOnly = signature
  try {
    const currentDelivery = storageFallbackDelivery
    if (!currentDelivery) return
    currentDelivery.logEvent("game-log-outbox-storage-fallback", "info", {
      "game_log.storage": reason,
      "game_log.pending_chunks": memoryStore.chunks.length,
      "game_log.pending_full_parts": memoryStore.chunks.filter(isFullPart).length,
      "game_log.memory_only_chunk_ids": memoryOnly.join(","),
      "game_log.shed_chunk_ids": shed.map((chunk) => chunk.id).join(","),
      "game_log.shed_game_indexes": [...new Set(shed.map((chunk) => chunk.gameIndex))].join(","),
    })
    currentDelivery.recordCount("game_log.storage_fallback", 1, { "game_log.storage": reason })
  } catch {
    /* evidence reporting must not break capture */
  }
}

function activeStorageByteSize(storage: Storage): number {
  let total = 0
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index)
    if (key !== LEGACY_GAME_LOG_ACTIVE_KEY && !key?.startsWith(GAME_LOG_ACTIVE_KEY)) continue
    const value = storage.getItem(key)
    if (value !== null) total += (key.length + value.length) * 2
  }
  return total
}

function writeStore(next: StoredOutbox, reservedActiveBytes?: number): boolean {
  memoryStore = next
  const storage = local()
  if (!storage) {
    reportStorageFallback("unavailable")
    return false
  }
  const changed = new Map<string, string | null>()
  const rollback = () => {
    for (const [key, value] of changed) {
      try {
        if (value === null) storage.removeItem(key)
        else storage.setItem(key, value)
      } catch {
        /* retain the old index; a later write can repair the orphan */
      }
    }
  }
  try {
    // Live tails are evidence too. Reserve their durable bytes before fitting
    // the index/chunks so a full reconciliation cannot silently exceed the
    // single shared 2 MiB ceiling.
    const storeBudget = Math.max(0, GAME_LOG_OUTBOX_MAX_BYTES - (reservedActiveBytes ?? activeStorageByteSize(storage)))
    const rawIndex = storage.getItem(GAME_LOG_OUTBOX_KEY)
    let previousIds: string[] = []
    if (rawIndex) {
      const parsed: unknown = JSON.parse(rawIndex)
      if (validIndex(parsed)) previousIds = parsed.chunkIds
    }
    let delivered = [...next.delivered]
    let index: StoredOutboxIndex = {
      chunkIds: [],
      delivered,
      fullCopies: next.fullCopies,
      settledGames: next.settledGames,
      evicted: next.evicted,
    }
    const indexBytes = (value: StoredOutboxIndex) => (GAME_LOG_OUTBOX_KEY.length + JSON.stringify(value).length) * 2
    while (indexBytes(index) > storeBudget && delivered.length > 0) {
      delivered = delivered.slice(1)
      index = { ...index, delivered }
    }
    if (indexBytes(index) > storeBudget) throw new Error("active game-log tails consume the outbox budget")

    const encoded = new Map(next.chunks.map((chunk) => [chunk.id, JSON.stringify(chunk)]))
    const cost = (chunk: GameLogOutboxItem) => (chunkKey(chunk.id).length + encoded.get(chunk.id)!.length) * 2
    const selected = [...next.chunks]
    // The game being played is the current game. Only once none is (after
    // its payoff settled it) does the newest full copy's game stand in: a
    // late copy of an older game must never make the live game's chunks
    // evictable.
    const protectedGames = new Set(recoveryProtectedGames)
    if (active) protectedGames.add(active.gameIndex)
    if (protectedGames.size === 0) {
      const newestFullGame = next.fullCopies.slice().sort((a, b) => b.createdAt - a.createdAt)[0]?.gameIndex
      if (newestFullGame !== undefined) protectedGames.add(newestFullGame)
    }
    const evictionPriority = (item: GameLogOutboxItem) => isFullPart(item) ? 0 : 1
    const evictionOrder = selected
      .filter((chunk) => !protectedGames.has(chunk.gameIndex))
      .sort((a, b) => evictionPriority(a) - evictionPriority(b) || a.gameIndex - b.gameIndex || itemOrder(a) - itemOrder(b) || a.part - b.part)
    const evictedFor = () => {
      const records = new Map(next.evicted.map((item) => [item.id, item]))
      for (const chunk of next.chunks) {
        if (!selected.some((item) => item.id === chunk.id)) records.set(chunk.id, { id: chunk.id, gameIndex: chunk.gameIndex })
      }
      return [...records.values()]
    }
    const totalBytes = () => {
      const candidate = { ...index, chunkIds: selected.map((chunk) => chunk.id), evicted: evictedFor() }
      return indexBytes(candidate) + selected.reduce((sum, chunk) => sum + cost(chunk), 0)
    }
    while (totalBytes() > storeBudget && evictionOrder.length > 0) {
      const evicted = evictionOrder.shift()!
      const at = selected.findIndex((chunk) => chunk.id === evicted.id)
      if (at >= 0) selected.splice(at, 1)
    }
    const finalOrder = selected
      .slice()
      .sort((a, b) => evictionPriority(a) - evictionPriority(b) || itemOrder(a) - itemOrder(b) || a.part - b.part)
    while (totalBytes() > storeBudget && finalOrder.length > 0) {
      const evicted = finalOrder.shift()!
      const at = selected.findIndex((chunk) => chunk.id === evicted.id)
      if (at >= 0) selected.splice(at, 1)
    }
    const selectedIds = new Set([
      ...selected.map((item) => item.id),
      ...delivered.filter((item) => item.kind === "full").map((item) => item.id),
    ])
    const lostCopyIds = new Set(next.fullCopies
      .filter((copy) => copy.partIds.some((id) => !selectedIds.has(id)))
      .map((copy) => copy.id))
    if (lostCopyIds.size > 0) {
      for (let at = selected.length - 1; at >= 0; at -= 1) {
        const item = selected[at]!
        if (isFullPart(item) && lostCopyIds.has(item.copyId)) selected.splice(at, 1)
      }
    }
    const terminalIds = new Set(next.fullCopies
      .filter((copy) => lostCopyIds.has(copy.id))
      .flatMap((copy) => copy.partIds))
    const records = new Map(evictedFor().map((item) => [item.id, item]))
    for (const copy of next.fullCopies.filter((item) => lostCopyIds.has(item.id))) {
      for (const id of copy.partIds) records.set(id, { id, gameIndex: copy.gameIndex })
    }
    index = {
      ...index,
      chunkIds: selected.map((chunk) => chunk.id),
      delivered: delivered.filter((receipt) => !(receipt.kind === "full" && terminalIds.has(receipt.id))),
      fullCopies: next.fullCopies.filter((copy) => !lostCopyIds.has(copy.id)),
      evicted: [...records.values()],
    }
    if (totalBytes() > storeBudget) throw new Error("game-log index cannot fit beside active tails")
    memoryStore = {
      ...next,
      chunks: selected,
      delivered: index.delivered,
      fullCopies: index.fullCopies ?? [],
      evicted: index.evicted ?? [],
    }

    for (const chunk of selected) {
      const key = chunkKey(chunk.id)
      const value = encoded.get(chunk.id)!
      const previous = storage.getItem(key)
      if (previous === value) continue
      changed.set(key, previous)
      storage.setItem(key, value)
    }
    changed.set(GAME_LOG_OUTBOX_KEY, rawIndex)
    storage.setItem(GAME_LOG_OUTBOX_KEY, JSON.stringify(index))

    const persistedIds = index.chunkIds
    const shedIds = new Set(next.chunks.filter((chunk) => !persistedIds.includes(chunk.id)).map((chunk) => chunk.id))
    const shed = next.chunks
      .filter((chunk) => shedIds.has(chunk.id))
      .sort((a, b) => a.gameIndex - b.gameIndex || itemOrder(a) - itemOrder(b) || a.part - b.part)
    for (const id of previousIds) {
      if (!persistedIds.includes(id)) storage.removeItem(chunkKey(id))
    }
    const memoryOnly: string[] = []
    storageDirty = false
    durableBytes = storageByteSize(storage)
    if (shed.length > 0) reportStorageFallback("full", memoryOnly, shed)
    else lastMemoryOnly = ""
    // Eviction is a successful bounded write. Callers that need a particular
    // new item durable verify that item's id separately.
    return true
  } catch {
    rollback()
    storageDirty = true
    // Rollback restores the durable store. Measure once at the failure edge;
    // later 250 ms tail flushes can update this cache without rescanning the
    // entire outbox while memory and the chunk index diverge.
    try { durableBytes = storageByteSize(storage) } catch { durableBytes = GAME_LOG_OUTBOX_MAX_BYTES }
    const persisted = new Set<string>()
    try {
      const parsed: unknown = JSON.parse(storage.getItem(GAME_LOG_OUTBOX_KEY) ?? "null")
      if (validIndex(parsed)) for (const id of parsed.chunkIds) persisted.add(id)
    } catch {
      /* report every in-memory id below */
    }
    reportStorageFallback("full", next.chunks.filter((chunk) => !persisted.has(chunk.id)).map((chunk) => chunk.id))
    return false
  }
}

function storageByteSize(storage: Storage): number {
  let total = 0
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index)
    if (!key?.startsWith(GAME_LOG_OUTBOX_KEY)) continue
    const value = storage.getItem(key)
    if (value !== null) total += (key.length + value.length) * 2
  }
  return total
}

/** Fast rolling path: encode only the new chunk keys and replace the small
 * index. A full reconciliation is reserved for migration or ceiling pressure. */
function appendChunks(chunks: readonly GameLogChunk[]): boolean {
  const storage = local()
  const before = memoryStore
  const next = { ...before, chunks: [...before.chunks, ...chunks] }
  memoryStore = next
  if (!storage) {
    reportStorageFallback("unavailable")
    return false
  }
  if (storageDirty) {
    const wrote = writeStore(next)
    if (!wrote) memoryStore = next
    return wrote
  }
  try {
    const raw = storage.getItem(GAME_LOG_OUTBOX_KEY)
    const parsed: unknown = JSON.parse(raw ?? "null")
    if (!validIndex(parsed)) {
      const wrote = writeStore(next)
      if (!wrote) memoryStore = next
      return wrote
    }
    const encoded = chunks.map((chunk) => [chunkKey(chunk.id), JSON.stringify(chunk)] as const)
    const existing = new Set(parsed.chunkIds)
    const index: StoredOutboxIndex = {
      ...parsed,
      chunkIds: [...parsed.chunkIds, ...chunks.map((chunk) => chunk.id).filter((id) => !existing.has(id))],
      delivered: next.delivered,
      fullCopies: next.fullCopies,
      settledGames: next.settledGames,
      evicted: next.evicted,
    }
    const nextRaw = JSON.stringify(index)
    const currentBytes = durableBytes ?? storageByteSize(storage)
    const addedBytes = encoded.reduce((sum, [key, value]) => sum + (key.length + value.length) * 2, 0)
      + (GAME_LOG_OUTBOX_KEY.length + nextRaw.length) * 2
      - (raw === null ? 0 : (GAME_LOG_OUTBOX_KEY.length + raw.length) * 2)
    if (currentBytes + addedBytes > GAME_LOG_OUTBOX_MAX_BYTES) return writeStore(next)
    const written: string[] = []
    try {
      for (const [key, value] of encoded) {
        storage.setItem(key, value)
        written.push(key)
      }
      storage.setItem(GAME_LOG_OUTBOX_KEY, nextRaw)
    } catch (error) {
      for (const key of written) storage.removeItem(key)
      throw error
    }
    durableBytes = currentBytes + addedBytes
    storageDirty = false
    return true
  } catch {
    // localStorage is unavailable, but the page is still alive. Keep the
    // complete chunk in memory so delivery can proceed and settlement cannot
    // erase the only surviving copy.
    memoryStore = next
    storageDirty = true
    try { durableBytes = storageByteSize(storage) } catch { durableBytes = GAME_LOG_OUTBOX_MAX_BYTES }
    reportStorageFallback("full", chunks.map((chunk) => chunk.id))
    return false
  }
}

function deviceId(): string {
  const storage = local()
  try {
    const known = storage?.getItem(GAME_LOG_DEVICE_KEY)
    if (known) return known
    const created = `device-${newId()}`
    storage?.setItem(GAME_LOG_DEVICE_KEY, created)
    return created
  } catch {
    return `session-${SESSION_ID}`
  }
}

/** The account is copied into every chunk because a reopen drains before the
 * global Sentry user can be restored. The device/session identity remains as
 * a fallback for pre-account waiting-room evidence. */
export function setGameLogOutboxAccount(next: string | null): void {
  account = next
  if (active && next) {
    active.account = next
    persistActive()
  }
  if (!next) return
  const stored = readStore()
  if (!stored.chunks.some((chunk) => !chunk.account)) return
  writeStore({
    ...stored,
    chunks: stored.chunks.map((chunk) => (chunk.account ? chunk : { ...chunk, account: next })),
  })
}

const bytes = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).byteLength

function packByJsonBytes<T>(items: readonly T[], wrap: (items: readonly T[]) => unknown): T[][] {
  const groups: T[][] = []
  let group: T[] = []
  let groupBytes = bytes(wrap(group))
  for (const item of items) {
    const nextBytes = groupBytes + bytes(item) + (group.length > 0 ? 1 : 0)
    if (group.length > 0 && nextBytes > GAME_LOG_CHUNK_MAX_BYTES) {
      groups.push(group)
      group = [item]
      groupBytes = bytes(wrap(group))
    } else {
      group.push(item)
      groupBytes = nextBytes
    }
  }
  if (group.length > 0 || groups.length === 0) groups.push(group)
  return groups
}

/** Greedy, stable splitting. Each line appears exactly once and every normal
 * chunk fits the conservative keepalive budget. A single oversize scrubbed
 * line stands alone rather than being silently truncated or dropped. */
export function splitGameLogLines(lines: readonly GameLogChunkLine[]): GameLogChunkLine[][] {
  return lines.length === 0 ? [] : packByJsonBytes(lines, (items) => items)
}

export interface FullLogDocument {
  entries: unknown[]
  [key: string]: unknown
}

function asFullLogDocument(json: string): FullLogDocument {
  const parsed = JSON.parse(json) as Partial<FullLogDocument> | null
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.entries)) throw new Error("game-log export has no entries")
  return parsed as FullLogDocument
}

/** Each returned value is independently useful JSON. Repeating the bounded
 * export metadata lets a report reconstruct whichever parts have arrived,
 * while the stable part descriptor makes a missing attachment explicit. */
export function splitFullGameLog(json: string, copyId: string): FullLogDocument[] {
  const { entries, ...header } = asFullLogDocument(json)
  const descriptor = { schema: 1, copyId, part: 9_999, parts: 9_999 }
  const groups = packByJsonBytes(entries, (items) => ({ ...header, entries: items, gameLogPart: descriptor }))
  return groups.map((partEntries, part): FullLogDocument => ({
    ...(part === 0 ? header : {}),
    entries: partEntries,
    gameLogPart: { schema: 1, copyId, part, parts: groups.length },
  }))
}

export interface FullGameLogRequest {
  gameIndex: number
  stage: GameLogFullPart["stage"]
  trace: GameLogFullPart["trace"]
  filename: string
  json: string
  capturedAt?: number
}

const fullStageRank: Record<GameLogFullPart["stage"], number> = { report: 0, flush: 1, late: 2, payoff: 3 }

export function hasPendingFullGameLog(gameIndex: number): boolean {
  return readStore().fullCopies.some((copy) => copy.gameIndex === gameIndex)
}

export async function enqueueFullGameLog(request: FullGameLogRequest): Promise<boolean> {
  const before = readStore()
  const pending = before.fullCopies.find((copy) => copy.gameIndex === request.gameIndex)
  if (pending && fullStageRank[pending.stage] >= fullStageRank[request.stage]) {
    await drainGameLogOutbox(true)
    const rejected = rejectedFullCopies.delete(pending.id)
    return !rejected && !readStore().fullCopies.some((copy) => copy.id === pending.id)
  }
  const capturedAt = request.capturedAt ?? Date.now()
  const copyId = `${request.gameIndex}:${request.stage}:${SESSION_ID}:${capturedAt.toString(36)}:${newId()}`
  const documents = splitFullGameLog(request.json, copyId)
  const parts = documents.map((document, part): GameLogFullPart => ({
    schema: 1,
    kind: "full",
    id: `${copyId}:${part}`,
    copyId,
    gameIndex: request.gameIndex,
    sessionId: SESSION_ID,
    account,
    deviceId: deviceId(),
    stage: request.stage,
    capturedAt,
    part,
    parts: documents.length,
    filename: request.filename,
    trace: request.trace,
    document,
    evictedOnDevice: [...before.evicted],
  }))
  const copy: GameLogFullCopy = {
    id: copyId,
    gameIndex: request.gameIndex,
    stage: request.stage,
    createdAt: capturedAt,
    partIds: parts.map((part) => part.id),
  }
  const stored = readStore()
  const replacedIds = new Set(stored.fullCopies
    .filter((candidate) => candidate.gameIndex === request.gameIndex)
    .flatMap((candidate) => candidate.partIds))
  // Persistence precedes every capture. A killed page can therefore resume
  // every unaccepted part and independently retire the parts Sentry accepted.
  writeStore({
    ...stored,
    chunks: [...stored.chunks.filter((item) => !replacedIds.has(item.id)), ...parts],
    delivered: stored.delivered.filter((receipt) => !(receipt.kind === "full" && replacedIds.has(receipt.id))),
    fullCopies: [...stored.fullCopies.filter((candidate) => candidate.gameIndex !== request.gameIndex), copy],
  })
  const durable = readStore()
  if (!durable.fullCopies.some((candidate) => candidate.id === copyId)
    || !copy.partIds.every((id) => durable.chunks.some((item) => item.id === id))) {
    return false
  }
  await drainItems(parts, 3)
  finalizeFullCopies()
  const notification = completionNotifications.get(copyId)
  if (notification) await withTimeout(notification, HOST_BOOKKEEPING_MS).catch(() => undefined)
  const rejected = rejectedFullCopies.delete(copyId)
  return !rejected && !readStore().chunks.some((item) => isFullPart(item) && item.copyId === copyId)
}

export function setFullGameLogDeliveredHandler(handler: (copy: GameLogFullCopy) => void | Promise<void>): void {
  fullLogDelivered = handler
  readStore()
  finalizeFullCopies()
}

const originKey = (game: Pick<ActiveGameLog, "gameIndex" | "sessionId" | "beginId">): string =>
  `${game.gameIndex}:${game.sessionId}:${game.beginId}`

function raiseSequenceFloor(
  game: Pick<ActiveGameLog, "gameIndex" | "sessionId" | "beginId">,
  next: number,
): number {
  const key = originKey(game)
  const floor = Math.max(sequenceFloors.get(key) ?? 1, next)
  sequenceFloors.set(key, floor)
  return floor
}

function nextSeq(game: Pick<ActiveGameLog, "gameIndex" | "sessionId" | "beginId">): number {
  const stored = readStore()
  const seqs = [...stored.chunks, ...stored.delivered]
    .filter((item): item is GameLogChunk | GameLogChunkReceipt => item.gameIndex === game.gameIndex
      && !("kind" in item) && item.sessionId === game.sessionId && item.beginId === game.beginId)
    .map((item) => item.seq)
  return raiseSequenceFloor(game, (seqs.length ? Math.max(...seqs) : 0) + 1)
}

const activeKey = (game: ActiveGameLog): string => `${GAME_LOG_ACTIVE_KEY}${encodeURIComponent(game.sessionId)}.${encodeURIComponent(game.beginId)}`

function tailKey(game: ActiveGameLog): string {
  return activeStorageKeys.get(game) ?? activeKey(game)
}

function tailLines(game: ActiveGameLog, omitChunkIds: ReadonlySet<string> = new Set()): GameLogChunkLine[] {
  return [
    ...(volatileSeals.get(game) ?? [])
      .filter((seal) => !seal.chunks.every((chunk) => omitChunkIds.has(chunk.id)))
      .flatMap((seal) => seal.lines),
    ...game.lines,
  ]
}

function persistActive(game = active, omitChunkIds: ReadonlySet<string> = new Set()): boolean {
  const storage = local()
  if (!storage || !game) {
    if (!storage) reportStorageFallback("unavailable")
    return false
  }
  try {
    const key = tailKey(game)
    const previous = storage.getItem(key)
    const lines = tailLines(game, omitChunkIds)
    const value = lines.length ? JSON.stringify({ ...game, lines }) : null
    if (value === null) {
      removeActive(storage, key)
      return true
    }
    const currentBytes = durableBytes ?? storageByteSize(storage)
    const previousBytes = previous === null ? 0 : (key.length + previous.length) * 2
    const nextBytes = value === null ? 0 : (key.length + value.length) * 2
    if (currentBytes - previousBytes + nextBytes > GAME_LOG_OUTBOX_MAX_BYTES) {
      // Ceiling pressure is exceptional. Only this slow path needs the exact
      // active-tail reservation; the 250 ms steady-state flush stays O(1).
      const reservedActiveBytes = activeStorageByteSize(storage) - previousBytes + nextBytes
      if (!writeStore(memoryStore, reservedActiveBytes)) {
        reportStorageFallback("full", [key])
        return false
      }
    }
    const fittedBytes = durableBytes ?? currentBytes
    if (fittedBytes - previousBytes + nextBytes > GAME_LOG_OUTBOX_MAX_BYTES) {
      reportStorageFallback("full", [key])
      return false
    }
    storage.setItem(key, value)
    durableBytes = fittedBytes - previousBytes + nextBytes
    return true
  } catch {
    reportStorageFallback("full", [tailKey(game)])
    return false
  }
}

/** Whether the active game's buffered tail is saved in localStorage exactly as
 * it stands. Read-only: it does not persist, seal, schedule or send. */
export function gameLogTailDurable(): boolean {
  const storage = local()
  const game = active
  if (!storage || !game) return false
  try {
    // There is no active tail to lose after a checkpoint or a completed
    // delivery. Old chunks are neither required nor sufficient evidence for
    // the current tail; an empty tail is durable by definition.
    if (game.lines.length === 0) return true
    const saved = JSON.parse(storage.getItem(tailKey(game)) ?? "null") as Partial<ActiveGameLog> | null
    return !!saved
      && saved.gameIndex === game.gameIndex
      && saved.sessionId === game.sessionId
      && saved.beginId === game.beginId
      && saved.seq === game.seq
      && Array.isArray(saved.lines)
      && JSON.stringify(saved.lines) === JSON.stringify(game.lines)
  } catch {
    return false
  }
}

export interface GameLogTailState {
  durable: boolean
  pendingLines: number
  /** Measured on the page's own clock, so a reader never compares it with
   * another machine's. */
  newestLineAgeMs: number | null
}

/** The active tail's durability, size and age. Read-only, like
 * gameLogTailDurable. */
export function gameLogTailState(now = Date.now()): GameLogTailState {
  const newest = active?.lines.at(-1)
  return {
    durable: gameLogTailDurable(),
    pendingLines: active?.lines.length ?? 0,
    newestLineAgeMs: newest ? Math.max(0, now - newest.ts) : null,
  }
}

function removeActive(storage: Storage, key: string): void {
  const previous = storage.getItem(key)
  storage.removeItem(key)
  if (previous !== null && durableBytes !== null) durableBytes -= (key.length + previous.length) * 2
}

function durableChunkIds(storage: Storage): Set<string> {
  try {
    const parsed: unknown = JSON.parse(storage.getItem(GAME_LOG_OUTBOX_KEY) ?? "null")
    return validIndex(parsed) ? new Set(parsed.chunkIds) : new Set()
  } catch {
    return new Set()
  }
}

interface SealResult { chunks: GameLogChunk[]; durable: boolean; retained: boolean; terminal: boolean }

function sealLines(game: ActiveGameLog, lines: readonly GameLogChunkLine[], checkpoint: GameLogCheckpoint, capturedAt = Date.now()): SealResult {
  if (lines.length === 0) return { chunks: [], durable: true, retained: true, terminal: false }
  const seq = Math.max(game.seq, nextSeq(game))
  // Claim the identity before storage work. Even a total persistence failure
  // cannot make a later seal reuse an id that transport may have observed.
  game.seq = raiseSequenceFloor(game, seq + 1)
  const stored = memoryStore
  const chunks = splitGameLogLines(lines).map((partLines, part): GameLogChunk => ({
    schema: 1,
    id: `${game.gameIndex}:${game.sessionId}:${game.beginId}:${seq}:${part}`,
    beginId: game.beginId,
    gameIndex: game.gameIndex,
    sessionId: game.sessionId,
    account: game.account,
    deviceId: game.deviceId,
    version: APP_VERSION,
    seq,
    part,
    checkpoint,
    capturedAt,
    from: partLines[0]!.ts,
    to: partLines.at(-1)!.ts,
    lines: [...partLines],
    evictedOnDevice: [...stored.evicted],
  }))
  // memoryStore equals `stored` after readStore; this path avoids rescanning
  // or re-encoding its prior chunks.
  const wrote = appendChunks(chunks)
  const storage = local()
  const durable = wrote && storage
    ? chunks.every((chunk) => durableChunkIds(storage).has(chunk.id))
    : false
  const attempted = new Set(chunks.map((chunk) => chunk.id))
  const retained = chunks.every((chunk) => memoryStore.chunks.some((item) => item.id === chunk.id))
  const terminal = memoryStore.evicted.some((item) => attempted.has(item.id))
  return { chunks, durable, retained, terminal }
}

function retireResolvedVolatile(game: ActiveGameLog, resolved: ReadonlySet<string>): Set<string> {
  const seals = volatileSeals.get(game) ?? []
  const retiring = seals.filter((seal) => seal.chunks.every((chunk) => resolved.has(chunk.id)))
  if (retiring.length === 0) return new Set()
  const ids = new Set(retiring.flatMap((seal) => seal.chunks.map((chunk) => chunk.id)))
  const acceptedLineIds = new Set(retiring.flatMap((seal) => seal.lines.map((line) => line.lineId)))
  // Tail trimming is best-effort housekeeping. Transport acceptance is
  // authoritative even when every storage operation throws.
  const storage = local()
  if (storage) {
    const key = tailKey(game)
    let storedLines: GameLogChunkLine[] | null = null
    try {
      const raw = storage.getItem(key)
      if (raw !== null) {
        const parsed = JSON.parse(raw) as Partial<ActiveGameLog> | null
        storedLines = Array.isArray(parsed?.lines) ? parsed.lines : null
      }
    } catch {
      /* leave unreadable recovery evidence untouched */
    }
    const tailContainsAccepted = storedLines?.some((line) => acceptedLineIds.has(line.lineId)) ?? false
    const tailTrimmed = !tailContainsAccepted || persistActive(game, ids)
    if (!tailTrimmed && storedLines?.length
      && storedLines.every((line) => acceptedLineIds.has(line.lineId))) {
      // Quota errors commonly reject rewrites while deletion still works.
      // If the durable tail contains only accepted evidence, deleting the
      // stale recovery copy advances identity without discarding a pending
      // line or allowing reload to regenerate the accepted sequence.
      try {
        removeActive(storage, key)
      } catch {
        /* a later storage reconciliation may remove this stale recovery copy */
      }
    }
  }
  const remaining = seals.filter((seal) => !seal.chunks.every((chunk) => ids.has(chunk.id)))
  if (remaining.length > 0) volatileSeals.set(game, remaining)
  else volatileSeals.delete(game)
  return ids
}

function retireAcceptedVolatile(accepted: ReadonlySet<string>): Set<string> {
  const volatileIds = new Set([...volatileSeals.values()].flatMap((seals) => seals.flatMap((seal) => seal.chunks.map((chunk) => chunk.id))))
  const safe = new Set([...accepted].filter((id) => !volatileIds.has(id)))
  for (const game of volatileSeals.keys()) {
    for (const id of retireResolvedVolatile(game, accepted)) safe.add(id)
  }
  return safe
}

function recoverActive(): void {
  const storage = local()
  if (!storage) return
  readStore()
  const keys: string[] = storage.getItem(LEGACY_GAME_LOG_ACTIVE_KEY) ? [LEGACY_GAME_LOG_ACTIVE_KEY] : []
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index)
    if (key?.startsWith(GAME_LOG_ACTIVE_KEY)) keys.push(key)
  }
  const candidates = keys.flatMap((key) => {
    try {
      const parsed = JSON.parse(storage.getItem(key) ?? "null") as Partial<ActiveGameLog> | null
      if (!parsed || typeof parsed.gameIndex !== "number" || typeof parsed.beginId !== "string"
        || typeof parsed.seq !== "number" || typeof parsed.sessionId !== "string"
        || typeof parsed.deviceId !== "string" || !Array.isArray(parsed.lines) || parsed.lines.length === 0) return []
      return [{ key, parsed }]
    } catch {
      return []
    }
  })
  for (const { parsed } of candidates) recoveryProtectedGames.add(parsed.gameIndex!)
  try {
    for (const { key, parsed } of candidates) {
      const recovered = {
        ...parsed,
        account: typeof parsed.account === "string" ? parsed.account : null,
        lines: [...parsed.lines as GameLogChunkLine[]],
      } as ActiveGameLog
      activeStorageKeys.set(recovered, key)
      // A kill may land after chunk/index persistence but before the tail
      // trim. Pending chunks already own those line identities, so recovery
      // must not generate another chunk for them.
      const durableLineIds = new Set(memoryStore.chunks
        .filter((item): item is GameLogChunk => !isFullPart(item)
          && item.beginId === recovered.beginId && item.sessionId === recovered.sessionId)
        .flatMap((chunk) => chunk.lines.map((line) => line.lineId)))
      recovered.lines = recovered.lines.filter((line) => !durableLineIds.has(line.lineId))
      // Memory-only acceptance cannot survive a page kill. Never infer a safe
      // next sequence from a stale tail: any amount of failed cleanup may hide
      // already accepted seals beyond it. Re-seal the remaining recovery copy
      // under a fresh begin identity so one transport id can never represent
      // different content across reloads.
      recovered.beginId = freshBeginId()
      recovered.seq = raiseSequenceFloor(recovered, 1)
      let allDurable = true
      for (const partLines of splitGameLogLines([...recovered.lines])) {
        const result = sealLines(recovered, partLines, "rolling")
        if (!result.retained) break
        recovered.lines.splice(0, partLines.length)
        allDurable &&= result.durable
        if (!result.durable) volatileSeals.set(recovered, [
          ...(volatileSeals.get(recovered) ?? []),
          { chunks: result.chunks, lines: [...partLines] },
        ])
      }
      persistActive(recovered)
      if (tailLines(recovered).length === 0 && allDurable) removeActive(storage, key)
    }
  } finally {
    recoveryProtectedGames.clear()
  }
}

export function beginGameLogOutbox(gameIndex: number): void {
  if (active?.gameIndex === gameIndex) return
  if (active?.lines.length) checkpointGameLog("handover")
  const link = readSessionLink()
  const next: ActiveGameLog = {
    gameIndex,
    beginId: freshBeginId(),
    seq: 1,
    sessionId: SESSION_ID,
    account,
    deviceId: deviceId(),
    // Copy the original startup line, never a new observation with a later
    // timestamp/sequence. Shared lineId lets import deduplicate other copies.
    lines: link ? [{ ...link }] : [],
  }
  next.seq = nextSeq(next)
  active = next
  activeStorageKeys.set(active, activeKey(active))
  if (link) persistActive()
  void drainGameLogOutbox()
}

function lineFrom(entry: SinkEntry): GameLogChunkLine {
  const data = entry.dataText()
  return {
    ts: entry.time,
    sessionId: SESSION_ID,
    lineId: `${SESSION_ID}:${entry.id}`,
    level: entry.level,
    tag: entry.tag,
    message: entry.message,
    ...(data === undefined ? {} : { data }),
  }
}

function captureLine(entry: SinkEntry): void {
  retainSessionLink(entry)
  if (!active) return
  active.lines.push(lineFrom(entry))
  // devLog runs on game-tick paths. Capture is O(1); serialisation and storage
  // run in a later task, never the tick's microtask checkpoint.
  if (activeFlushTimer) return
  activeFlushTimer = setTimeout(() => {
    activeFlushTimer = null
    persistActive()
    if (active && active.lines.length >= ROLLING_CHECKPOINT_LINES) checkpointGameLog("rolling")
  }, ACTIVE_FLUSH_MS)
}

/** Synchronous capture and persistence; network delivery starts afterwards. */
export function checkpointGameLog(checkpoint: GameLogCheckpoint, capturedAt = Date.now(), expectedGameIndex?: number): GameLogChunk[] {
  const game = active
  if (!game || (expectedGameIndex !== undefined && game.gameIndex !== expectedGameIndex) || game.lines.length === 0) {
    return []
  }
  if (activeFlushTimer) {
    clearTimeout(activeFlushTimer)
    activeFlushTimer = null
  }
  const chunks: GameLogChunk[] = []
  for (const partLines of splitGameLogLines([...game.lines])) {
    const result = sealLines(game, partLines, checkpoint, capturedAt)
    if (!result.retained) {
      // Even a terminal reservation advances the identity. Persist that
      // sequence before returning so recovery cannot reuse the id.
      if (result.terminal) game.lines.splice(0, partLines.length)
      persistActive(game)
      break
    }
    chunks.push(...result.chunks)
    game.lines.splice(0, partLines.length)
    if (result.durable) {
      const storage = local()
      if (storage) retireResolvedVolatile(game, durableChunkIds(storage))
      // Shrink a large durable tail as each bounded part lands. Near the hard
      // ceiling, retaining the entire pre-seal tail beside every new chunk
      // would evict otherwise-valid evidence before the final trim.
      persistActive(game)
    } else {
      volatileSeals.set(game, [
        ...(volatileSeals.get(game) ?? []),
        { chunks: result.chunks, lines: [...partLines] },
      ])
    }
  }
  // The final write covers volatile prefixes too, with the advanced seq,
  // until persistence or acceptance retires their owning chunks.
  persistActive(game)
  if (chunks.length > 0) {
    if (checkpoint === "rolling") scheduleRollingSend()
    else {
      if (rollingSendTimer) clearTimeout(rollingSendTimer)
      rollingSendTimer = null
      void drainGameLogOutbox()
    }
  }
  return chunks
}

function captureAttachment(
  item: GameLogOutboxItem,
  filename: string,
  data: string,
  message: "game-log" | "game-log-chunk",
  tags: Record<string, string>,
  trace: GameLogFullPart["trace"] = null,
): Promise<boolean> {
  const eventId = stableEventId(item.idEpoch ? `${item.id}#${item.idEpoch}` : item.id)
  // A false or missing transport receipt deliberately leaves the item for a
  // later outbox drain. The receipt does not infer attachment-category state.
  const arrival = expectDelivery(eventId, DELIVERY_FOLLOW_MS)
  const evictedOnDevice = [...(item.evictedOnDevice ?? [])]
  Sentry.withScope((scope) => {
    scope.clearBreadcrumbs()
    // Isolation-scope breadcrumbs are merged after withScope() starts. A
    // scope-local processor strips them at the final boundary without
    // widening the shared telemetry transport lane.
    scope.addEventProcessor((event) => ({ ...event, breadcrumbs: [] }))
    scope.setUser({ id: item.account ?? item.deviceId })
    scope.addAttachment({ filename, data, contentType: "application/json" })
    scope.setTags(tags)
    Sentry.captureEvent(
      {
        message,
        level: "info",
        fingerprint: [message],
        breadcrumbs: [],
        ...(evictedOnDevice.length > 0 ? { extra: {
          evicted_chunk_ids: evictedOnDevice.map((item) => item.id),
          evicted_game_indexes: [...new Set(evictedOnDevice.map((item) => item.gameIndex))],
        } } : {}),
        ...(trace ? { contexts: { trace: { trace_id: trace.traceId, span_id: trace.spanId } } } : {}),
      },
      { event_id: eventId },
    )
  })
  // Followed past the attempt's own deadline: the answer can come after the
  // outbox gave up on this attempt (it waits behind the Retry-After barrier).
  void arrival.then((delivered) => {
    if (!delivered && takeAttachmentDropped(eventId)) advanceIdEpoch(item.id, item.idEpoch ?? 0)
  }, () => {
    /* the attempt's own caller handles a failed delivery */
  })
  return arrival
}

function advanceIdEpoch(id: string, from: number): void {
  const stored = readStore()
  // only from the epoch that was sent: a concurrent bump must not skip one
  if (!stored.chunks.some((item) => item.id === id && (item.idEpoch ?? 0) === from)) return
  writeStore({ ...stored, chunks: stored.chunks.map((item) => item.id === id ? { ...item, idEpoch: from + 1 } : item) })
}

function withoutEpoch<T extends GameLogOutboxItem>(item: T): Omit<T, "idEpoch" | "evictedOnDevice"> {
  const { idEpoch: _idEpoch, evictedOnDevice: _evictedOnDevice, ...rest } = item
  void _idEpoch
  void _evictedOnDevice
  return rest
}

interface FullLogEntry {
  ts: number
  sessionId: string
  lineId?: string
  version?: string
  level: string
  tag: string
  message: string
  data?: unknown
}

type VersionedLogLine = LogLine & { version?: string }

function fullLogEntry(value: unknown): FullLogEntry | null {
  if (!value || typeof value !== "object") return null
  const entry = value as Partial<FullLogEntry>
  if (typeof entry.ts !== "number" || typeof entry.sessionId !== "string"
    || typeof entry.level !== "string" || typeof entry.tag !== "string" || typeof entry.message !== "string") return null
  if (entry.lineId !== undefined && typeof entry.lineId !== "string") return null
  if (entry.version !== undefined && typeof entry.version !== "string") return null
  return entry as FullLogEntry
}

function normalizedChunkData(data: string): string {
  try {
    const parsed = JSON.parse(data) as unknown
    return typeof parsed === "string" ? parsed : JSON.stringify(parsed)
  } catch {
    return data
  }
}

/** Deterministically map one durable schema-1 item to its Sentry Log records.
 * The durable shape stays unchanged, so items written by an older release use
 * this path after the new release opens them. */
function logRecordsFor(item: GameLogOutboxItem, now: number): LogRecord[] {
  const evicted = item.evictedOnDevice ?? []
  const fullEntries = isFullPart(item)
    ? item.document.entries.map(fullLogEntry).filter((entry): entry is FullLogEntry => entry !== null)
    : []
  const lines: VersionedLogLine[] = isFullPart(item)
    ? fullEntries.map((entry) => ({
        ts: entry.ts,
        sessionId: entry.sessionId,
        ...(entry.lineId ? { lineId: entry.lineId } : {}),
        version: entry.version,
        level: entry.level,
        tag: entry.tag,
        message: entry.message,
        ...(entry.data === undefined
          ? {}
          : { data: typeof entry.data === "string" ? entry.data : JSON.stringify(entry.data) }),
      }))
    : item.lines.map((line) => line.data === undefined ? line : { ...line, data: normalizedChunkData(line.data) })
  const groups: Array<{ lines: VersionedLogLine[]; body: string }> = []
  if (isFullPart(item) && item.part === 0) {
    const { entries: _entries, gameLogPart: _gameLogPart, ...header } = item.document
    void _entries
    void _gameLogPart
    groups.push(...packLines([specialLine("meta", header, item.capturedAt, item.sessionId)]))
  }
  groups.push(...packLines(lines))
  if (evicted.length > 0) groups.push(...packLines([specialLine("evicted", evicted, item.capturedAt, item.sessionId)]))

  const count = groups.length
  const traceId = isFullPart(item)
    ? item.trace?.traceId || stableEventId(`${item.gameIndex}:${item.sessionId}:${item.copyId}`)
    : stableEventId(`${item.gameIndex}:${item.sessionId}:${item.beginId}`)
  const fallbackVersion = fullEntries[0]?.version
  return groups.map((group, index) => buildRecord({
    lines: group.lines,
    body: group.body,
    traceId,
    now,
    attributes: {
      "session.id": group.lines[0]?.sessionId ?? item.sessionId,
      "game.index": String(item.gameIndex),
      "game_log.stage": isFullPart(item) ? "full" : "chunk",
      "game_log.captured_ms": item.capturedAt,
      "user.id": item.account ?? item.deviceId,
      ...recordIdentity(item.id, index, count),
      ...(isFullPart(item)
        ? {
            "game_log.copy": item.copyId,
            "game_log.part": String(item.part),
            "game_log.parts": String(item.parts),
            "game_log.full_stage": item.stage,
            "app.version": group.lines[0]?.version ?? fallbackVersion,
          }
        : {
            "game_log.checkpoint": item.checkpoint,
            "game_log.seq": String(item.seq),
            "game_log.part": String(item.part),
            "game_log.begin": item.beginId,
            "app.version": item.version ?? APP_VERSION,
          }),
    },
  }))
}

function deliverChunk(chunk: GameLogChunk & { idEpoch?: number }): Promise<boolean> {
  if (telemetryLogsEnabled()) return sendLogEnvelope(chunk.id, logRecordsFor(chunk, Date.now()))
  const evictedOnDevice = [...(chunk.evictedOnDevice ?? [])]
  return captureAttachment(
    chunk,
    `game-log-chunk-g${chunk.gameIndex}-${chunk.sessionId.slice(0, 8)}-${chunk.seq}-${chunk.part}.json`,
    JSON.stringify(evictedOnDevice.length > 0 ? { ...withoutEpoch(chunk), evictedOnDevice } : withoutEpoch(chunk)),
    "game-log-chunk",
    {
      "game.index": String(chunk.gameIndex),
      "game_log.stage": "chunk",
      "game_log.checkpoint": chunk.checkpoint,
      "game_log.seq": String(chunk.seq),
    },
  )
}

async function deliverFullPart(part: GameLogFullPart): Promise<boolean> {
  if (telemetryLogsEnabled()) return sendLogEnvelope(part.id, logRecordsFor(part, Date.now()))
  const evictedOnDevice = [...(part.evictedOnDevice ?? [])]
  const suffix = part.parts === 1 ? "" : `.part-${String(part.part + 1).padStart(3, "0")}-of-${String(part.parts).padStart(3, "0")}`
  const filename = suffix === ""
    ? part.filename
    : part.filename.endsWith(".json")
      ? `${part.filename.slice(0, -5)}${suffix}.json`
      : `${part.filename}${suffix}.json`
  const document = JSON.stringify(evictedOnDevice.length > 0 ? { ...part.document, evictedOnDevice } : part.document)
  return captureAttachment(
    part,
    filename,
    document,
    "game-log",
    {
      "game.index": String(part.gameIndex),
      "game_log.late": part.stage === "late" ? "true" : "false",
      "game_log.stage": part.stage,
      "game_log.copy": part.copyId,
      "game_log.part": String(part.part),
      "game_log.parts": String(part.parts),
    },
    part.trace,
  )
}

const deliver = (item: GameLogOutboxItem): Promise<boolean> => isFullPart(item) ? deliverFullPart(item) : deliverChunk(item)

function scheduleRollingSend(): void {
  if (rollingSendTimer) return
  rollingSendTimer = setTimeout(() => {
    rollingSendTimer = null
    void drainGameLogOutbox()
  }, ROLLING_SEND_MS)
}

function scheduleRetry(): void {
  const stored = readStore()
  if (retryTimer || (stored.chunks.length === 0 && stored.fullCopies.length === 0)) return
  retryTimer = setTimeout(() => {
    retryTimer = null
    void drainGameLogOutbox()
  }, retryMs)
  retryMs = Math.min(retryMs * 2, RETRY_MAX_MS)
}

type AttemptResult = { id: string; status: "accepted" | "too-large" }

function freezeEvictedReceipts(item: GameLogOutboxItem): GameLogOutboxItem | null {
  const stored = memoryStore
  const current = stored.chunks.find((candidate) => candidate.id === item.id)
  if (!current) return null
  // A retried item keeps its first snapshot. A retry must send the same
  // payload under the same id, or Sentry can end up holding two
  // contradicting copies of one item. Records taken after the snapshot stay
  // in stored.evicted and ride the next new item instead.
  if (current.evictedOnDevice !== undefined) return current
  const frozen = { ...current, evictedOnDevice: [...stored.evicted] }
  const next = { ...stored, chunks: stored.chunks.map((candidate) => candidate.id === item.id ? frozen : candidate) }
  memoryStore = next
  const storage = local()
  if (!storage) {
    reportStorageFallback("unavailable", [item.id])
    return frozen
  }
  if (storageDirty) {
    const wrote = writeStore(next)
    return wrote ? memoryStore.chunks.find((candidate) => candidate.id === item.id) ?? null : frozen
  }
  try {
    const key = chunkKey(item.id)
    const previous = storage.getItem(key)
    const value = JSON.stringify(frozen)
    const currentBytes = durableBytes ?? storageByteSize(storage)
    const nextBytes = currentBytes - (previous === null ? 0 : (key.length + previous.length) * 2) + (key.length + value.length) * 2
    if (nextBytes > GAME_LOG_OUTBOX_MAX_BYTES) {
      if (!writeStore(next)) return null
    } else {
      storage.setItem(key, value)
      durableBytes = nextBytes
    }
    return memoryStore.chunks.find((candidate) => candidate.id === item.id) ?? null
  } catch {
    storageDirty = true
    try { durableBytes = storageByteSize(storage) } catch { durableBytes = GAME_LOG_OUTBOX_MAX_BYTES }
    reportStorageFallback("full", [item.id])
    return frozen
  }
}

async function attemptItem(item: GameLogOutboxItem): Promise<AttemptResult | null> {
  const frozen = freezeEvictedReceipts(item)
  if (!frozen) return null
  item = frozen
  let accepted = false
  try {
    accepted = (await withTimeout(deliver(item), DELIVERY_ATTEMPT_MS)) ?? false
  } catch {
    // A thrown SDK/transport path is the same as an offline or rejected
    // attempt: the durable chunk remains and the retry owner continues.
  }
  if (!accepted) {
    if (telemetryLogsEnabled() && takeLogRejected(item.id)) {
      if (isFullPart(item)) rejectedFullCopies.add(item.copyId)
      return { id: item.id, status: "too-large" }
    }
    return null
  }
  return { id: item.id, status: "accepted" }
}

function receiptFor(item: GameLogOutboxItem): GameLogReceipt {
  if (isFullPart(item)) return {
    kind: "full",
    id: item.id,
    copyId: item.copyId,
    gameIndex: item.gameIndex,
    stage: item.stage,
    capturedAt: item.capturedAt,
    part: item.part,
    parts: item.parts,
  }
  const { lines: _lines, schema: _schema, idEpoch: _idEpoch, ...receipt } = item
  void _lines
  void _schema
  void _idEpoch
  return receipt
}

async function drainItems(items: readonly GameLogOutboxItem[], concurrency: number): Promise<void> {
  const queue = [...items]
  const accepted = new Set<string>()
  const rejected = new Set<string>()
  const owned = new Set<string>()
  const skipped: Promise<void>[] = []
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length > 0) {
      const item = queue.shift()
      if (!item) return
      if (draining.has(item.id)) {
        const waiter = drainWaiters.get(item.id)
        if (waiter) skipped.push(waiter.promise)
        continue
      }
      draining.add(item.id)
      owned.add(item.id)
      let resolve = () => {}
      const promise = new Promise<void>((done) => { resolve = done })
      drainWaiters.set(item.id, { promise, resolve })
      const result = await attemptItem(item)
      if (result?.status === "accepted") {
        accepted.add(item.id)
        if (!isFullPart(item)) acceptedChunkIds.add(item.id)
      }
      else if (result?.status === "too-large") rejected.add(item.id)
    }
  })
  try {
    await Promise.all(workers)
    if (accepted.size > 0) retryMs = RETRY_MIN_MS
    retireAcceptedVolatile(accepted)
    const committedAccepted = accepted
    if (committedAccepted.size > 0 || rejected.size > 0) {
      const stored = memoryStore
      const rejectedItems = stored.chunks.filter((item) => rejected.has(item.id))
      const rejectedCopyIds = new Set(rejectedItems.filter(isFullPart).map((item) => item.copyId))
      const acceptedItems = stored.chunks.filter((item) => committedAccepted.has(item.id))
      const receipts = acceptedItems
        .filter((item) => isFullPart(item)
          ? !rejectedCopyIds.has(item.copyId) && stored.fullCopies.some((copy) => copy.partIds.includes(item.id))
          : !stored.settledGames.includes(item.gameIndex))
        .map(receiptFor)
      // An accepted payload carries the eviction list as it stood when that
      // item was frozen, so only those records are reported. Anything
      // recorded while the delivery was in flight was never sent and must
      // stay, or the loss goes unreported.
      const carried = new Set(acceptedItems.flatMap((item) => item.evictedOnDevice ?? []).map((item) => item.id))
      const evicted = new Map(stored.evicted.filter((item) => !carried.has(item.id)).map((item) => [item.id, item]))
      for (const item of rejectedItems) evicted.set(item.id, { id: item.id, gameIndex: item.gameIndex, reason: "too-large" })
      commitDrainResults({
        ...stored,
        chunks: stored.chunks.filter((item) => !committedAccepted.has(item.id) && !rejected.has(item.id)),
        delivered: [...stored.delivered.filter((receipt) => !committedAccepted.has(receipt.id)), ...receipts],
        fullCopies: stored.fullCopies.filter((copy) => !rejectedCopyIds.has(copy.id)),
        evicted: [...evicted.values()],
      })
    }
  } finally {
    for (const id of owned) {
      draining.delete(id)
      drainWaiters.get(id)?.resolve()
      drainWaiters.delete(id)
    }
  }
  await Promise.all(skipped)
}

/** Delivery touches only terminal chunk keys plus the compact index. The
 * remaining evidence stays byte-for-byte in place instead of being rescanned
 * and rewritten after every accepted rolling send. */
function commitDrainResults(next: StoredOutbox): void {
  const previous = memoryStore
  memoryStore = next
  const storage = local()
  if (!storage || storageDirty) {
    writeStore(next)
    return
  }
  try {
    const raw = storage.getItem(GAME_LOG_OUTBOX_KEY)
    const parsed: unknown = JSON.parse(raw ?? "null")
    if (!validIndex(parsed)) {
      writeStore(next)
      return
    }
    const nextIds = new Set(next.chunks.map((item) => item.id))
    const removed = previous.chunks.filter((item) => !nextIds.has(item.id))
    const index: StoredOutboxIndex = {
      chunkIds: next.chunks.map((item) => item.id),
      delivered: next.delivered,
      fullCopies: next.fullCopies,
      settledGames: next.settledGames,
      evicted: next.evicted,
    }
    const nextRaw = JSON.stringify(index)
    const currentBytes = durableBytes ?? storageByteSize(storage)
    let removedBytes = 0
    for (const item of removed) {
      const key = chunkKey(item.id)
      const value = storage.getItem(key)
      if (value !== null) removedBytes += (key.length + value.length) * 2
    }
    storage.setItem(GAME_LOG_OUTBOX_KEY, nextRaw)
    for (const item of removed) storage.removeItem(chunkKey(item.id))
    durableBytes = currentBytes
      - (raw === null ? 0 : (GAME_LOG_OUTBOX_KEY.length + raw.length) * 2)
      + (GAME_LOG_OUTBOX_KEY.length + nextRaw.length) * 2
      - removedBytes
    storageDirty = false
  } catch {
    storageDirty = true
    try { durableBytes = storageByteSize(storage) } catch { durableBytes = GAME_LOG_OUTBOX_MAX_BYTES }
    reportStorageFallback("full", next.chunks.map((item) => item.id))
  }
}

function finalizeFullCopies(): void {
  for (const copy of [...memoryStore.fullCopies]) {
    const stored = memoryStore
    if (stored.chunks.some((item) => isFullPart(item) && item.copyId === copy.id)) continue
    const receipts = new Set(stored.delivered.filter((item) => item.kind === "full").map((item) => item.id))
    if (!copy.partIds.every((id) => receipts.has(id))) continue
    // Receipts are the source of truth. Retire locally before any host-backed
    // bookkeeping; a hung host bridge can never stall this drain or resend.
    const latest = memoryStore
    writeStore({
      ...latest,
      fullCopies: latest.fullCopies.filter((item) => item.id !== copy.id),
      delivered: latest.delivered.filter((item) => !(item.kind === "full" && copy.partIds.includes(item.id))),
    })
    if (copy.stage !== "report") settleGameLogOutbox(copy.gameIndex)
    if (fullLogDelivered) {
      const notification = Promise.resolve(fullLogDelivered(copy)).catch(() => {})
      completionNotifications.set(copy.id, notification)
      void notification.finally(() => completionNotifications.delete(copy.id))
      setTimeout(() => {
        if (completionNotifications.get(copy.id) === notification) completionNotifications.delete(copy.id)
      }, HOST_BOOKKEEPING_MS)
    }
  }
}

export async function drainGameLogOutbox(fanOut = false): Promise<void> {
  const chunks = readStore().chunks.filter((item) => isFullPart(item) || !acceptedChunkIds.has(item.id))
  await drainItems(chunks, fanOut ? 3 : 1)
  finalizeFullCopies()
  scheduleRetry()
}

export function gameLogManifest(gameIndex: number): { schema: 1; chunks: Array<GameLogChunkReceipt & { status: "delivered" | "pending" }> } {
  const stored = readStore()
  const pending = stored.chunks
    .filter((item): item is GameLogChunk => !isFullPart(item))
    .map(({ lines: _lines, schema: _schema, ...receipt }) => {
    void _lines
    void _schema
    return receipt
    })
  return {
    schema: 1,
    chunks: [
      ...stored.delivered
        .filter((item): item is GameLogChunkReceipt => item.kind !== "full")
        .map((item) => ({ ...item, status: "delivered" as const })),
      ...pending.map((item) => ({ ...item, status: "pending" as const })),
    ]
      .filter((item) => item.gameIndex === gameIndex)
      .sort((a, b) => a.seq - b.seq || a.part - b.part),
  }
}

export function settleGameLogOutbox(gameIndex: number): void {
  checkpointGameLog("flush", Date.now(), gameIndex)
  const stored = readStore()
  writeStore({
    // A full export can omit earlier-session lines when the host ring was
    // unavailable. Only confirmed chunk deliveries are safe to retire.
    chunks: stored.chunks,
    delivered: stored.delivered.filter((item) => item.kind === "full" || item.gameIndex !== gameIndex),
    fullCopies: stored.fullCopies,
    settledGames: [...stored.settledGames.filter((item) => item !== gameIndex), gameIndex].slice(-SETTLED_KEEP),
    evicted: stored.evicted,
  })
  if (active?.gameIndex === gameIndex) active = null
  scheduleRetry()
}

export function installGameLogOutbox(): () => void {
  if (installed) return () => {}
  installed = true
  recoverActive()
  const removeSink = addDevLogSink(captureLine)
  const onOnline = () => {
    retryMs = RETRY_MIN_MS
    if (retryTimer) clearTimeout(retryTimer)
    retryTimer = null
    void drainGameLogOutbox()
  }
  const onVisibility = () => {
    if (document.visibilityState === "hidden") {
      checkpointGameLog("hidden")
      void drainGameLogOutbox(true)
    }
    else void drainGameLogOutbox()
  }
  const onPagehide = () => {
    checkpointGameLog("pagehide")
    void drainGameLogOutbox(true)
  }
  window.addEventListener("online", onOnline)
  document.addEventListener("visibilitychange", onVisibility)
  window.addEventListener("pagehide", onPagehide)
  void drainGameLogOutbox()
  return () => {
    removeSink()
    window.removeEventListener("online", onOnline)
    document.removeEventListener("visibilitychange", onVisibility)
    window.removeEventListener("pagehide", onPagehide)
    installed = false
  }
}

export function resetGameLogOutboxForTests(): void {
  active = null
  if (activeFlushTimer) clearTimeout(activeFlushTimer)
  activeFlushTimer = null
  draining.clear()
  for (const waiter of drainWaiters.values()) waiter.resolve()
  drainWaiters.clear()
  volatileSeals.clear()
  acceptedChunkIds.clear()
  sequenceFloors.clear()
  activeStorageKeys = new WeakMap()
  memoryStore = emptyStore()
  storageDirty = false
  durableBytes = null
  installed = false
  account = null
  if (retryTimer) clearTimeout(retryTimer)
  retryTimer = null
  if (rollingSendTimer) clearTimeout(rollingSendTimer)
  rollingSendTimer = null
  retryMs = RETRY_MIN_MS
  lastMemoryOnly = ""
  completionNotifications.clear()
  rejectedFullCopies.clear()
  recoveryProtectedGames.clear()
}
