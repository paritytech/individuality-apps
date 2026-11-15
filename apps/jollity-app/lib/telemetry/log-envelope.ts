// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * GAME LOGS AS SENTRY LOG ITEMS — the pure half (the sending is init.ts and
 * game-log-outbox.ts).
 *
 * The outbox's lines leave as PACKED log records: one record per up to
 * RECORD_MAX_LINES lines (or RECORD_MAX_BODY_BYTES of body) OF ONE SESSION,
 * the lines joined with "\n" in the body, the item's identity in typed
 * attributes. A record per line would bill about four times more.
 *
 * THE BODY LINE is a contract for anyone parsing these records:
 *
 *     <ISO-8601 ts, ms> <level> [<capture-id>] <tag>: <message>[\t<data-json>]
 *
 * A TAB separates the message from the data. Inside the message and the data,
 * backslash, newline, carriage return and tab are escaped as \\, \n, \r and
 * \t, so splitting the body on "\n" and each line on its first "\t" is exact.
 * Each line passes scrubMnemonic on the FULL text first (a phrase must be
 * redacted BEFORE the 64 KB cap can cut it to eleven words and defeat the
 * pattern), then the cap, then scrubMnemonic AGAIN on the capped text (the cut
 * can join two fragments into a fresh phrase), then maskSafe (Sentry's
 * server-side scrubbing blanks a WHOLE value containing
 * auth/secret/credential/password, which would empty all the lines of a
 * packed record; lib/journeys/mask-text.ts). The cut backs off a lone trailing
 * backslash so it never splits an escape.
 *
 * TWO SPECIAL LINES are part of the same contract; each is an ordinary
 * formatted line, so a reader needs no special case — it recognises them by
 * tag and takes them out of `entries`:
 * - META_TAG ("game-log.meta"), level info, message "header", data =
 *   JSON.stringify(header), where header is the full part's document minus
 *   `entries` and `gameLogPart` ({meta, worker, ...extras} from
 *   lib/debug/telemetry.ts buildLogsExport). It is ALONE in record 0 of part 0
 *   of a full copy. It is EXEMPT from LINE_MAX_CHARS (truncation would break
 *   the JSON); instead, when its formatted length would exceed
 *   META_LINE_MAX_CHARS, specialLine replaces header.worker with null and sets
 *   header.workerOmitted = true BEFORE formatting.
 * - EVICTED_TAG ("game-log.evicted"), level info, message "evictedOnDevice",
 *   data = JSON.stringify(the store's evicted receipts). It is alone in the
 *   LAST record of the item, and present only when the list is non-empty.
 *
 * The SDK's createLogEnvelope is not exported, so the envelope is built here,
 * mirroring @sentry/core 11.x logs/envelope.js with ingest_settings set to
 * "never" (no IP or user agent inference for game logs).
 *
 * Relay facts this file is built on (measured against Sentry's ingest):
 * - trace_id is mandatory; a record without one is dropped behind a 200.
 * - a record whose timestamp is about 70 h old or more is dropped behind a
 *   200 (and billed), so recordTimestamp sends anything older than
 *   STALE_RECORD_MS with the send time and the reader keeps the original in
 *   game_log.first_ts_ms. It is evaluated at SEND time, on every attempt.
 * - identifiers (game.index, seq, part, record, item, copy, begin) are
 *   STRINGS (AGENTS.md); an integer attribute does not filter by bare name.
 *   Quantities (first_ts_ms, last_ts_ms, the telemetry.health fields) are
 *   numbers.
 *
 * No import of @sentry/* and no side effect at import. TextEncoder is used
 * here, so this file must never be imported by apps/jollity-worker/ (QuickJS).
 */
import { safeStringify, scrubMnemonic } from "../debug/scrub"
import { maskSafe } from "../journeys/mask-text"

/** Off only for "0": a release can fall back to error+attachment without a revert. */
export function telemetryLogsEnabled(): boolean {
  return process.env.NEXT_PUBLIC_TELEMETRY_LOGS !== "0"
}

export const RECORD_MAX_LINES = 50
export const RECORD_MAX_BODY_BYTES = 16 * 1024
/** One line, message and data together. Far below Relay's 2-4 MB record limit. */
export const LINE_MAX_CHARS = 64 * 1024
/** The meta line is exempt from LINE_MAX_CHARS, but a header this big drops its worker. */
export const META_LINE_MAX_CHARS = 60_000
/** The serialized envelope, under the Sentry fetch transport's keepalive
 *  threshold (60,000 B; the browser's own keepalive limit is 64 KiB). */
export const LOG_ENVELOPE_MAX_BYTES = 48 * 1024
/** Relay drops records about 70 h old; anything older than this is re-stamped. */
export const STALE_RECORD_MS = 60 * 60 * 60_000

export const META_TAG = "game-log.meta"
export const EVICTED_TAG = "game-log.evicted"

export type LogLevel = "info" | "warn" | "error"
export type LogAttributeInput = string | number | boolean | undefined | null
export type LogAttribute =
  | { value: string; type: "string" }
  | { value: number; type: "integer" | "double" }
  | { value: boolean; type: "boolean" }

export interface LogRecord {
  /** seconds */
  timestamp: number
  level: LogLevel
  body: string
  trace_id: string
  severity_number: number
  attributes: Record<string, LogAttribute>
}

/** One line of the body, before formatting. */
export interface LogLine {
  ts: number
  /** a record holds lines of ONE session; packLines splits on a change (D4) */
  sessionId: string
  /** Capture identity, rendered into the body so every copy carries it. */
  lineId?: string
  level: string
  tag: string
  message: string
  /** already JSON text */
  data?: string
  /** the meta line alone: skip LINE_MAX_CHARS, the JSON must survive whole */
  uncapped?: boolean
}

const SEVERITY: Record<LogLevel, number> = { info: 9, warn: 13, error: 17 }
const LEVEL_RANK: Record<LogLevel, number> = { info: 0, warn: 1, error: 2 }

const asLevel = (level: string): LogLevel => (level === "warn" || level === "error" ? level : "info")

/** Text that leaves for Sentry: mnemonic scrub first, then the masked words. */
const safeText = (text: string): string => maskSafe(scrubMnemonic(text))

/** Lone surrogates make the payload invalid UTF-8; the SDK strips them too. */
const wellFormed = (text: string): string =>
  text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "�")

const escapeField = (text: string): string =>
  text.replace(/[\\\n\r\t]/g, (char) => (char === "\\" ? "\\\\" : char === "\n" ? "\\n" : char === "\r" ? "\\r" : "\\t"))

/** A non-finite time would write "NaN", breaking the line contract; use the epoch. */
function isoTime(ts: number): string {
  const date = new Date(ts)
  return Number.isFinite(date.getTime()) ? date.toISOString() : "1970-01-01T00:00:00.000Z"
}

/** The formatted text of a special line, cached so its big JSON is scrubbed
 *  once. It is PRIVATE on purpose: a public field would let a caller (or a
 *  persisted line that ever carried the key) skip the scrub and the mask. */
const formattedText = new WeakMap<LogLine, string>()

/** One body line, per the contract in the header. Scrub, cap, scrub again. */
export function formatLine(line: LogLine): string {
  const cached = formattedText.get(line)
  if (cached !== undefined) return cached
  const identity = line.lineId ? `[${escapeField(line.lineId)}] ` : ""
  const head = `${isoTime(line.ts)} ${asLevel(line.level)} ${identity}${escapeField(line.tag)}: `
  // scrub the FULL text first: the cap must not cut a phrase to eleven words
  let text = scrubMnemonic(head + escapeField(line.message) + (line.data === undefined ? "" : `\t${escapeField(line.data)}`))
  if (!line.uncapped && text.length > LINE_MAX_CHARS) {
    const cut = text.length - LINE_MAX_CHARS
    // never leave a lone trailing backslash: the cut must not split an escape
    let end = LINE_MAX_CHARS
    let backslashes = 0
    while (end - 1 - backslashes >= 0 && text[end - 1 - backslashes] === "\\") backslashes += 1
    if (backslashes % 2 === 1) end -= 1
    text = `${text.slice(0, end)} …[truncated ${cut} chars]`
  }
  // scrub again: the cut can join two fragments into a fresh 12-word run
  return wellFormed(safeText(text))
}

const encoder = new TextEncoder()
const utf8 = (text: string): number => encoder.encode(text).byteLength

/** Greedy and order-keeping: every line exactly once, a big line alone, a
 *  session change always starts a new record. */
export function packLines<T extends LogLine>(lines: readonly T[]): Array<{ lines: T[]; body: string }> {
  const groups: Array<{ lines: T[]; body: string }> = []
  let current: T[] = []
  let texts: string[] = []
  let size = 0
  const close = () => {
    if (current.length > 0) groups.push({ lines: current, body: texts.join("\n") })
    current = []
    texts = []
    size = 0
  }
  for (const line of lines) {
    const text = formatLine(line)
    const bytes = utf8(text)
    const sessionChanged = current.length > 0 && current.at(-1)!.sessionId !== line.sessionId
    if (sessionChanged || (current.length > 0 && (current.length >= RECORD_MAX_LINES || size + 1 + bytes > RECORD_MAX_BODY_BYTES))) close()
    size += (current.length > 0 ? 1 : 0) + bytes
    current.push(line)
    texts.push(text)
  }
  close()
  return groups
}

/** Typed attributes; strings scrubbed and masked; undefined/null left out. */
export function logAttributes(input: Record<string, LogAttributeInput>): Record<string, LogAttribute> {
  const out: Record<string, LogAttribute> = {}
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || value === null) continue
    if (typeof value === "string") out[key] = { value: wellFormed(safeText(value)), type: "string" }
    else if (typeof value === "boolean") out[key] = { value, type: "boolean" }
    else if (Number.isFinite(value)) out[key] = { value, type: Number.isInteger(value) ? "integer" : "double" }
  }
  return out
}

/** The item's identity for a record: identifiers as STRINGS (D4, AGENTS.md). */
export function recordIdentity(item: string, index: number, count: number): Record<string, string> {
  return { "game_log.item": item, "game_log.record": String(index), "game_log.records": String(count) }
}

/** A stable 32-hex id (FNV-1a over four seeds): event ids and fallback trace ids. */
export function stableHexId(value: string): string {
  const hashes = [2166136261, 2166136261 ^ 0x9e3779b9, 2166136261 ^ 0x85ebca6b, 2166136261 ^ 0xc2b2ae35]
  for (const [wordIndex, seed] of hashes.entries()) {
    let hash = seed
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index) + wordIndex * 131
      hash = Math.imul(hash, 16777619)
    }
    hashes[wordIndex] = hash >>> 0
  }
  return hashes.map((hash) => hash.toString(16).padStart(8, "0")).join("")
}

/** The line's own time while Relay keeps it; the send time once it would not. */
function recordTimestamp(tsMs: number, nowMs: number): { seconds: number; restamped: boolean } {
  if (!Number.isFinite(tsMs) || nowMs - tsMs > STALE_RECORD_MS) return { seconds: nowMs / 1000, restamped: true }
  return { seconds: tsMs / 1000, restamped: false }
}

/** The two lines that are not entries: the full copy's header and the store's
 *  evictions. Each is an ordinary formatted line; a reader takes it out by tag.
 *  The meta line is exempt from the line cap, but a header over
 *  META_LINE_MAX_CHARS drops its worker (and says so) before formatting. */
export function specialLine(kind: "meta" | "evicted", data: unknown, ts: number, sessionId: string): LogLine {
  const cache = (line: LogLine): LogLine => {
    formattedText.set(line, formatLine(line))
    return line
  }
  if (kind === "evicted") {
    return cache({ ts, sessionId, level: "info", tag: EVICTED_TAG, message: "evictedOnDevice", data: safeStringify(data) })
  }
  const header = (data ?? {}) as Record<string, unknown>
  const line: LogLine = { ts, sessionId, level: "info", tag: META_TAG, message: "header", data: safeStringify(header), uncapped: true }
  if (formatLine(line).length > META_LINE_MAX_CHARS) {
    // the worker field is the only one big enough to matter: drop it and say so
    return cache({ ...line, data: safeStringify({ ...header, worker: null, workerOmitted: true }) })
  }
  return cache(line)
}

export interface RecordInput {
  lines: readonly LogLine[]
  /** the packed body (packLines); a line's own text is reused, never re-formatted */
  body: string
  traceId: string
  attributes: Record<string, LogAttributeInput>
  now: number
}

/** One packed record. Time from its first line, level the worst of its lines. */
export function buildRecord(input: RecordInput): LogRecord {
  const first = input.lines[0]?.ts ?? input.now
  const last = input.lines.at(-1)?.ts ?? first
  const level = input.lines.reduce<LogLevel>((worst, line) => {
    const next = asLevel(line.level)
    return LEVEL_RANK[next] > LEVEL_RANK[worst] ? next : worst
  }, "info")
  const { seconds, restamped } = recordTimestamp(first, input.now)
  return {
    timestamp: seconds,
    level,
    body: input.body,
    trace_id: input.traceId,
    severity_number: SEVERITY[level],
    attributes: logAttributes({
      ...input.attributes,
      "game_log.first_ts_ms": first,
      "game_log.last_ts_ms": last,
      ...(restamped ? { "game_log.restamped": true } : {}),
    }),
  }
}

/** A record with the shared attributes added (the sender's release, environment, tag). */
export function withAttributes(record: LogRecord, extra: Record<string, LogAttributeInput>): LogRecord {
  return { ...record, attributes: { ...logAttributes(extra), ...record.attributes } }
}

export type LogEnvelope = [
  { sdk?: { name: string; version: string } },
  [[{ type: "log"; item_count: number; content_type: "application/vnd.sentry.items.log+json" }, { version: 2; ingest_settings: { infer_ip: "never"; infer_user_agent: "never" }; items: LogRecord[] }]],
]

/** The envelope tuple, as core/logs/envelope.js builds it. */
export function logEnvelope(records: readonly LogRecord[], sdk?: { name: string; version: string }): LogEnvelope {
  return [
    sdk ? { sdk: { name: sdk.name, version: sdk.version } } : {},
    [[
      { type: "log", item_count: records.length, content_type: "application/vnd.sentry.items.log+json" },
      { version: 2, ingest_settings: { infer_ip: "never", infer_user_agent: "never" }, items: [...records] },
    ]],
  ]
}

/** What the fetch transport sends for this envelope: header, item header, payload, one per line. */
export function serializedEnvelopeBytes(envelope: LogEnvelope): number {
  const [header, [[itemHeader, payload]]] = envelope
  return utf8(`${JSON.stringify(header)}\n${JSON.stringify(itemHeader)}\n${JSON.stringify(payload)}`)
}

/** Records into envelopes whose SERIALIZED size stays within the budget. A
 *  record bigger than the budget goes alone (it cannot loop: a 413 is final). */
export function packEnvelopes(records: readonly LogRecord[], sdk?: { name: string; version: string }, maxBytes = LOG_ENVELOPE_MAX_BYTES): LogEnvelope[] {
  const envelopes: LogEnvelope[] = []
  const base = serializedEnvelopeBytes(logEnvelope([], sdk))
  // item_count grows with the group, adding a digit now and then; a small
  // reserve keeps a full envelope under the budget without a second measure
  const countReserve = 4
  let group: LogRecord[] = []
  let size = base + countReserve
  for (const record of records) {
    const bytes = utf8(JSON.stringify(record))
    if (group.length > 0 && size + 1 + bytes > maxBytes) {
      envelopes.push(logEnvelope(group, sdk))
      group = []
      size = base + countReserve
    }
    size += (group.length > 0 ? 1 : 0) + bytes
    group.push(record)
  }
  if (group.length > 0) envelopes.push(logEnvelope(group, sdk))
  return envelopes
}

/** True when an envelope carries a log container item. */
export function isLogEnvelope(envelope: unknown): boolean {
  const items = Array.isArray(envelope) ? (envelope[1] as unknown) : undefined
  return Array.isArray(items) && items.length > 0 &&
    items.every((item) => Array.isArray(item) && (item[0] as { type?: unknown } | undefined)?.type === "log")
}
