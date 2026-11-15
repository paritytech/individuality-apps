// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/** Value formatting shared by the debug panel's sections. Every value is a
 *  string: the panel is a flat label/value list, never typed widgets. */

/** Shown wherever chain state genuinely has no value to report. */
export const MISSING = "—";

export interface DebugRow {
  label: string;
  value: string;
}

/** A per-entity grid for a section whose rows share a shape (one draw per
 *  row). The first cell of every row is that row's label; the panel renders
 *  it as the row header and the snapshot keys the row by it. */
export interface DebugTable {
  columns: readonly string[];
  rows: readonly (readonly string[])[];
}

export interface DebugSection {
  title: string;
  rows: DebugRow[];
  /** Rendered after `rows`; absent when the section has nothing tabular. */
  table?: DebugTable;
}

export function bool(value: boolean): string {
  return value ? "true" : "false";
}

/** Names an object whose own properties are all non-enumerable, which
 *  `JSON.stringify` renders as a content-free `{}`. Host `Err` frames and
 *  `DOMException` both land here, and a panel row reading `{}` is worse than
 *  no row: it looks like an answer. */
function describeOpaque(error: object): string {
  let json: string | null = null;
  try {
    json =
      JSON.stringify(error, (_key, entry) =>
        typeof entry === "bigint" ? entry.toString() : entry,
      ) ?? null;
  } catch {
    json = null;
  }
  if (json != null && json !== "{}" && json !== "[]") return json;
  const keys = Object.getOwnPropertyNames(error);
  const shape =
    keys.length > 0
      ? keys.join(",")
      : Object.prototype.toString.call(error);
  const constructorName = error.constructor?.name;
  return constructorName != null && constructorName !== "Object"
    ? `${constructorName} ${shape}`
    : shape;
}

/** Chain failures are frequently plain objects (PAPI dispatch errors, host
 *  `Err` frames), and `String(value)` renders those as `[object Object]`.
 *  `cause` is followed one level because the app wraps host refusals in a
 *  flat sentence — the refusal itself is the part worth reading. */
export function errorText(error: unknown, followCause = true): string {
  if (error instanceof Error) {
    const head =
      error.message === ""
        ? error.name
        : error.name === "Error"
          ? error.message
          : `${error.name}: ${error.message}`;
    if (!followCause || error.cause == null) return head;
    return `${head} ← ${errorText(error.cause, false)}`;
  }
  if (typeof error !== "object" || error == null) return String(error);
  if ("message" in error && typeof error.message === "string" && error.message !== "") {
    return error.message;
  }
  return describeOpaque(error);
}

/** A query's observable state, error text included — a debug panel that hides
 *  a failure behind "no data" is worse than no panel. */
export function queryStatus(
  pending: boolean,
  error: unknown,
  data: unknown,
): string {
  if (error != null) return `error: ${errorText(error)}`;
  if (data == null) return pending ? "pending" : "no data";
  if (typeof data === "object" && "kind" in data && typeof data.kind === "string") {
    return `ok: ${data.kind}`;
  }
  return "ok";
}

/** Unix seconds as both the raw number (what the chain holds) and a readable
  *  UTC timestamp (what a human compares against a countdown). */
export function timestamp(seconds: number | null): string {
  if (seconds == null) return MISSING;
  const iso = new Date(seconds * 1000).toISOString().slice(0, 16).replace("T", " ");
  return `${seconds} · ${iso}Z`;
}

/** Unix seconds as a readable UTC minute only — for table cells, where the
 *  raw number `timestamp` carries would double the column width. */
export function utcShort(seconds: number | null): string {
  if (seconds == null) return MISSING;
  return `${new Date(seconds * 1000).toISOString().slice(0, 16).replace("T", " ")}Z`;
}

/** A span of seconds as the two largest of days, hours and minutes — the
 *  shape a person compares against "is the claim window open yet". */
export function duration(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  if (total < 60) return "<1m";
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

/** A 32-byte chain hash, abbreviated so an alias and two contexts fit on one
 *  panel row without wrapping — `0x` plus the first four and last four
 *  hex chars. Two rows of context are otherwise indistinguishable. */
export function hex32Short(hex: string): string {
  if (hex.length < 10) return hex;
  return `${hex.slice(0, 6)}…${hex.slice(-4)}`;
}
