// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The in-browser debug log — a tiny in-memory ring buffer.
 *
 * Any module can `devLog("tag", "message", data?, level?)`; the debug sheet
 * renders the buffer via `useSyncExternalStore(subscribeDevLog,
 * getDevLogEntries)`. Every entry, its message and data mnemonic-scrubbed, is
 * also handed to the write-through sinks that registered:
 *  - lib/debug/telemetry.ts: the session's buffer and the game window's ring
 *    in host storage, which the player can export from the debug sheet;
 *  - with a Sentry DSN, lib/telemetry/breadcrumbs.ts: a breadcrumb on the
 *    events Sentry is sent;
 *  - with a Sentry DSN, lib/telemetry/game-log-outbox.ts: the game window's
 *    lines, sent as game-log parts;
 *  - with a Sentry DSN, lib/telemetry/game-log.ts: the handover markers, kept
 *    on the device for the next open's late upload.
 * So a line leaves the device on a manual export, or, with a DSN, as a
 * breadcrumb or in a game log (docs/telemetry.md).
 *
 * Framework-agnostic on purpose: no React, no chain types.
 *
 * When DEBUG_LOGS is off (build-time), devLog is a no-op and nothing
 * accumulates.
 */
import { DEBUG_LOGS } from "./flag"
import { safeStringify, scrubMnemonic } from "./scrub"

export type LogLevel = "info" | "warn" | "error"

export interface LogEntry {
  id: number
  /** ms epoch */
  time: number
  level: LogLevel
  tag: string
  message: string
  data?: unknown
}

const MAX_ENTRIES = 250

let entries: readonly LogEntry[] = []
let nextId = 1
const listeners = new Set<() => void>()

/** What a sink receives: the line with its message already mnemonic-scrubbed
 *  and its data as scrubbed JSON text, computed once for all sinks. */
export interface SinkEntry {
  /** Per-page monotonic counter shared by every sink for this capture. */
  id: number
  time: number
  level: LogLevel
  tag: string
  /** scrubbed */
  message: string
  /** the raw payload, for a sink that wants the value itself */
  data?: unknown
  /** `data` as scrubbed JSON, untruncated; undefined without data. Computed
   *  on first call and cached. */
  dataText(): string | undefined
}

/** Scrub the message now and the data on demand, once. */
export function toSinkEntry(entry: Omit<LogEntry, "id"> & { id?: number }): SinkEntry {
  let text: string | undefined
  let done = false
  return {
    id: entry.id ?? 0,
    time: entry.time,
    level: entry.level,
    tag: entry.tag,
    message: scrubMnemonic(entry.message),
    ...(entry.data !== undefined ? { data: entry.data } : {}),
    dataText() {
      if (!done) {
        done = true
        if (entry.data !== undefined) text = scrubMnemonic(safeStringify(entry.data, 0))
      }
      return text
    },
  }
}

/** A write-through sink (the list is in the header). */
export type DevLogSink = (entry: SinkEntry) => void
const sinks = new Set<DevLogSink>()

/** Register a sink; returns its remover. */
export function addDevLogSink(next: DevLogSink): () => void {
  sinks.add(next)
  return () => {
    sinks.delete(next)
  }
}

export function devLog(
  tag: string,
  message: string,
  data?: unknown,
  level: LogLevel = "info",
): void {
  if (!DEBUG_LOGS) return
  const entry: LogEntry = { id: nextId++, time: Date.now(), level, tag, message }
  if (data !== undefined) entry.data = data
  entries =
    entries.length >= MAX_ENTRIES
      ? [...entries.slice(entries.length - MAX_ENTRIES + 1), entry]
      : [...entries, entry]
  for (const listener of listeners) listener()
  if (sinks.size === 0) return
  const forSinks = toSinkEntry(entry)
  for (const next of sinks) {
    try {
      next(forSinks)
    } catch {
      /* a sink must never break logging, or the other sinks */
    }
  }
}

export function subscribeDevLog(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function getDevLogEntries(): readonly LogEntry[] {
  return entries
}

export function clearDevLog(): void {
  entries = []
  for (const listener of listeners) listener()
}
