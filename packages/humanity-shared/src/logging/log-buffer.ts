// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * In-memory ring buffer of recent log records, for the debug panel to show.
 *
 * A second LogTape sink rather than a patched `console`: the sink sees the
 * structured record (level, category, interpolated values) that `console` has
 * already flattened to a string, and it cannot miss records emitted before the
 * panel mounted.
 *
 * It observes exactly what the console sink observes. LogTape filters on the
 * logger's `lowestLevel` *before* dispatching to any sink, so a sink can never
 * widen its own threshold — `VITE_LOG_LEVEL` governs the panel and the console
 * together, which is also the behaviour the logger's own docs promise.
 *
 * Dev-only in practice: `logger.ts` only installs the sink when `DEBUG_PANEL`
 * is on, and that is a build-time literal.
 */
import type { LogLevel, LogRecord, Sink } from "@logtape/logtape";

/** Oldest records are evicted past this. Small on purpose: this is a tail for
 *  "what just happened", not a session transcript, and it is retained for the
 *  life of the tab. Exported so a snapshot can say whether it hit the bound and
 *  is therefore showing a tail rather than the whole session. */
export const CAPACITY = 200;

export interface LogEntry {
  readonly id: number;
  /** Epoch ms, as LogTape reports it. */
  readonly time: number;
  readonly level: LogLevel;
  /** Dot-joined, with the app's root category dropped. */
  readonly category: string;
  readonly message: string;
}

let entries: readonly LogEntry[] = [];
let nextId = 1;
const listeners = new Set<() => void>();

/**
 * Referentially stable between pushes: `useSyncExternalStore` re-renders
 * forever if `getSnapshot` hands back a fresh array on every call.
 */
export function logSnapshot(): readonly LogEntry[] {
  return entries;
}

export function subscribeLogs(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function clearLogs(): void {
  // Guarded so clearing an empty buffer keeps the snapshot identity and cannot
  // spin a render.
  if (entries.length === 0) return;
  entries = [];
  for (const listener of listeners) listener();
}

/** Values land in the message via `{placeholder}`, so anything unprintable here
 *  would otherwise read as `[object Object]`. BigInt needs naming explicitly:
 *  it is common in this app (asset base units) and `JSON.stringify` throws on
 *  it rather than skipping it. */
function renderValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "bigint") return `${value}n`;
  if (value == null || typeof value !== "object") return String(value);
  if (value instanceof Error) {
    return value.name === "Error" ? value.message : `${value.name}: ${value.message}`;
  }
  try {
    return (
      JSON.stringify(value, (_key, entry) =>
        typeof entry === "bigint" ? `${entry}n` : entry,
      ) ?? String(value)
    );
  } catch {
    return Object.prototype.toString.call(value);
  }
}

/**
 * LogTape exports no interpolation helper, so this reimplements the convention
 * its own formatter uses: `message` is an odd-length array whose even indices
 * are literal text and whose odd indices are the interpolated values.
 */
export function renderLogMessage(parts: readonly unknown[]): string {
  if (parts.length === 1) return String(parts[0]);
  let text = "";
  for (let index = 0; index < parts.length; index += 1) {
    text += index % 2 === 0 ? String(parts[index]) : renderValue(parts[index]);
  }
  return text;
}

/** `["humanity", "prize", "claim"]` reads as `prize·claim` in a 340px panel:
 *  the root is on every line and earns none of the width. */
export function formatLogCategory(
  category: readonly string[],
  root: string,
): string {
  const parts = category[0] === root ? category.slice(1) : category;
  return parts.join("·");
}

/** Matches the console sink's `level: "ABBR"` rendering. */
export const LEVEL_ABBR: Record<LogLevel, string> = {
  trace: "TRC",
  debug: "DBG",
  info: "INF",
  warning: "WRN",
  error: "ERR",
  fatal: "FTL",
};

/** Wall-clock `HH:MM:SS`; the console sink's millisecond field is dropped
 *  because ordering already conveys it and the width is needed for the
 *  message. */
export function formatLogTime(time: number): string {
  const at = new Date(time);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`;
}

/**
 * The sink itself. `root` is the app's own top-level category, dropped from
 * every entry's display category.
 */
export function createLogBufferSink(root: string): Sink {
  return (record: LogRecord) => {
    const entry: LogEntry = {
      id: nextId,
      time: record.timestamp,
      level: record.level,
      category: formatLogCategory(record.category, root),
      message: renderLogMessage(record.message),
    };
    nextId += 1;
    // A fresh array per record is the price of an immutable snapshot, which is
    // what lets `useSyncExternalStore` detect the change at all. Bounded by
    // CAPACITY, and only ever built in a build that has the panel.
    entries =
      entries.length < CAPACITY
        ? [...entries, entry]
        : [...entries.slice(entries.length - CAPACITY + 1), entry];
    for (const listener of listeners) listener();
  };
}
