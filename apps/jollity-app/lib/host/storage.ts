// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import type { HostLocalStorage } from "@parity/product-sdk-host"
import { devLog } from "../debug/log-store"
import { warnThrottled } from "../debug/warn-throttled"
import { insideContainer } from "./container"
import { retrySafeHostRead, type HostConnectionSource } from "./safe-call"

/** The debug log's own persistence reads and writes through here, so a
 *  failing store must not log once per attempt and feed its own queue:
 *  warnThrottled marks the key before it logs. */
const noteHostStorageFailure = (operation: "read" | "write", error: unknown) =>
  warnThrottled(`storage ${operation}`, "storage", `storage ${operation} failed`, error)

type StorageOp = "open" | "read" | "write"
const SLOW_MS = 3_000
const VERY_SLOW_MS = 10_000

interface OpStats {
  count: number
  failed: number
  slow3: number
  slow10: number
  maxMs: number
}

const newStats = (): Record<StorageOp, OpStats> => ({
  open: { count: 0, failed: 0, slow3: 0, slow10: 0, maxMs: 0 },
  read: { count: 0, failed: 0, slow3: 0, slow10: 0, maxMs: 0 },
  write: { count: 0, failed: 0, slow3: 0, slow10: 0, maxMs: 0 },
})
let stats = newStats()
let warnedTrouble = false
let reportedSlow = false

/** One Sentry event per session for the first call still pending at 10 s: a
 *  hang at open may mean app-open never ends to carry the numbers. The
 *  telemetry module is loaded on demand (it reads storage itself). */
function reportSlowOnce(op: StorageOp, key: string): void {
  if (reportedSlow) return
  reportedSlow = true
  void import("../telemetry")
    .then((telemetry) => telemetry.storageSlowRecord({ op, key, ms: VERY_SLOW_MS }))
    .catch(() => undefined)
}

/** The first slow or failed open/read of the session, once. Marked before the
 *  log runs: the debug log persists through host storage (a write). */
function warnOnce(op: StorageOp, key: string, ms: number, what: string): void {
  if (op === "write" || warnedTrouble) return
  warnedTrouble = true
  devLog("storage", `host storage ${op} ${what}`, { op, key, ms }, "warn")
}

/**
 * Measures one host storage call (#776): duration, outcome, and whether it was
 * still pending at 3 s and 10 s. It only observes: the same promise settles at
 * the same time with the same value or error, and the timers merely count.
 */
async function timed<T>(op: StorageOp, key: string, run: () => Promise<T>): Promise<T> {
  const started = Date.now()
  const entry = stats[op]
  entry.count += 1
  let settled = false
  const mark = (threshold: number, field: "slow3" | "slow10") => () => {
    if (settled) return
    entry[field] += 1
    entry.maxMs = Math.max(entry.maxMs, threshold)
    if (field === "slow3") warnOnce(op, key, threshold, "still pending")
    else reportSlowOnce(op, key)
  }
  const slow = setTimeout(mark(SLOW_MS, "slow3"), SLOW_MS)
  const verySlow = setTimeout(mark(VERY_SLOW_MS, "slow10"), VERY_SLOW_MS)
  try {
    return await run()
  } catch (error) {
    entry.failed += 1
    warnOnce(op, key, Date.now() - started, "failed")
    throw error
  } finally {
    settled = true
    clearTimeout(slow)
    clearTimeout(verySlow)
    entry.maxMs = Math.max(entry.maxMs, Date.now() - started)
  }
}

const OP_OF: Record<string, StorageOp> = {
  readString: "read",
  readJSON: "read",
  readBytes: "read",
  writeString: "write",
  writeJSON: "write",
  writeBytes: "write",
  clear: "write",
}

/** Every read and write on the handle is timed, so a caller that holds the raw
 *  handle (chat signup, the tutorial request, chest picks) is measured too. */
function measured(store: HostLocalStorage, source: HostConnectionSource): HostLocalStorage {
  return new Proxy(store, {
    get(target, name, receiver) {
      const value = Reflect.get(target, name, receiver)
      const op = typeof name === "string" ? OP_OF[name] : undefined
      if (!op || typeof value !== "function") return value
      const run = (key: string, ...rest: unknown[]) =>
        timed(op, String(key), () => (value as (...args: unknown[]) => Promise<unknown>).call(target, key, ...rest))
      return op === "read"
        ? (key: string, ...rest: unknown[]) => retrySafeHostRead(source, () => run(key, ...rest), { operation: "storage.read" })
        : run
    },
  })
}

/** This session's host storage numbers, as raw numbers for a telemetry event.
 *  slow_* count calls still pending at 3 s / 10 s (open, read and write). */
export function storageTelemetry(): Record<string, number> {
  const all = Object.values(stats)
  const sum = (field: "failed" | "slow3" | "slow10") => all.reduce((total, op) => total + op[field], 0)
  return {
    "storage.reads": stats.read.count,
    "storage.failed": sum("failed"),
    "storage.slow_3s": sum("slow3"),
    "storage.slow_10s": sum("slow10"),
    "storage.max_ms": Math.max(...all.map((op) => op.maxMs)),
    "storage.open_max_ms": stats.open.maxMs,
    "storage.read_max_ms": stats.read.maxMs,
    "storage.write_max_ms": stats.write.maxMs,
  }
}

/** for tests */
export function resetStorageStats(): void {
  stats = newStats()
  warnedTrouble = false
  reportedSlow = false
}

/**
 * Opens the host storage of this product.
 *
 * The host keeps the values, so they survive a webview cache clear, and a
 * product the manifest grants `storage` can read them. It is null when the host
 * transport is unavailable.
 */
export async function hostStorage(): Promise<HostLocalStorage | null> {
  return timed("open", "-", async () => {
    const sdk = await import("@parity/product-sdk-host")
    const store = await retrySafeHostRead(sdk, () => sdk.getHostLocalStorage(), { operation: "storage.open" })
    return store ? measured(store, sdk) : null
  })
}

/**
 * A string value under a key: host storage in a container (it survives webview
 * cache clears and the worker can read it), plain localStorage anywhere else.
 * Null when neither holds the key. Never throws.
 */
export async function readStoredString(key: string): Promise<string | null> {
  try {
    if (await insideContainer()) {
      const store = await hostStorage()
      if (store) return (await store.readString(key)) ?? null
    }
  } catch (error) {
    noteHostStorageFailure("read", error)
  }
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

/** readStoredString, but a read that FAILED is told apart from a key that is
 *  absent: a read-modify-write caller must not write over a list it could not
 *  read. A host without storage falls back to localStorage, as the write does. */
export async function tryReadStoredString(key: string): Promise<{ ok: true; value: string | null } | { ok: false }> {
  try {
    if (await insideContainer()) {
      const store = await hostStorage()
      if (store) return { ok: true, value: (await store.readString(key)) ?? null }
    }
    return { ok: true, value: localStorage.getItem(key) }
  } catch (error) {
    noteHostStorageFailure("read", error)
    return { ok: false }
  }
}

/** The write twin of readStoredString. A failed write is silent: the caller's
 *  flag simply reads as absent next open. */
export async function writeStoredString(key: string, value: string): Promise<void> {
  try {
    if (await insideContainer()) {
      const store = await hostStorage()
      if (store) {
        await store.writeString(key, value)
        return
      }
    }
  } catch (error) {
    noteHostStorageFailure("write", error)
  }
  try {
    localStorage.setItem(key, value)
  } catch {
    /* storage unavailable */
  }
}

/** A JSON value under a key, through readStoredString. Null when the key is
 *  absent or holds something that is not JSON. */
export async function readStoredJSON(key: string): Promise<unknown> {
  const raw = await readStoredString(key)
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

/** The write twin of readStoredJSON. */
export function writeStoredJSON(key: string, value: unknown): Promise<void> {
  return writeStoredString(key, JSON.stringify(value))
}
