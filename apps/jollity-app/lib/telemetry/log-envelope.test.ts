// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, describe, expect, it, vi } from "vitest"
import { makeFetchTransport } from "@sentry/browser"
import {
  EVICTED_TAG,
  LINE_MAX_CHARS,
  LOG_ENVELOPE_MAX_BYTES,
  META_LINE_MAX_CHARS,
  META_TAG,
  RECORD_MAX_BODY_BYTES,
  RECORD_MAX_LINES,
  STALE_RECORD_MS,
  buildRecord,
  formatLine,
  isLogEnvelope,
  logAttributes,
  logEnvelope,
  packEnvelopes,
  packLines,
  recordIdentity,
  serializedEnvelopeBytes,
  specialLine,
  stableHexId,
  telemetryLogsEnabled,
  withAttributes,
  type LogLine,
} from "./log-envelope"

const TS = Date.UTC(2026, 9, 14, 20, 0, 0, 123)
const SID = "session-a"
const line = (message: string, over: Partial<LogLine> = {}): LogLine => ({ ts: TS, sessionId: SID, level: "info", tag: "game", message, ...over })

/** What task 2's readers do: unescape after splitting on "\n" and the first "\t". */
function unescape(text: string): string {
  return text.replace(/\\(\\|n|r|t)/g, (_m, c: string) => (c === "\\" ? "\\" : c === "n" ? "\n" : c === "r" ? "\r" : "\t"))
}

function parseBody(body: string): Array<{ ts: string; level: string; tag: string; message: string; data?: string }> {
  return body.split("\n").map((row) => {
    const [ts = "", level = "", ...rest] = row.split(" ")
    const remainder = rest.join(" ")
    const colon = remainder.indexOf(": ")
    const tag = remainder.slice(0, colon)
    const [message = "", data] = remainder.slice(colon + 2).split("\t")
    return { ts, level, tag: unescape(tag), message: unescape(message), ...(data === undefined ? {} : { data: unescape(data) }) }
  })
}

afterEach(() => vi.unstubAllEnvs())

/** A record from lines, as the outbox builds one: pack, then build. */
function record(lines: LogLine[], over: { traceId?: string; attributes?: Record<string, string | number | boolean | undefined>; now?: number } = {}) {
  const [group] = packLines(lines)
  return buildRecord({ lines: group.lines, body: group.body, traceId: over.traceId ?? "a".repeat(32), attributes: over.attributes ?? {}, now: over.now ?? TS })
}

describe("the log flag", () => {
  it("is on unless the build says 0", () => {
    expect(telemetryLogsEnabled()).toBe(true)
    vi.stubEnv("NEXT_PUBLIC_TELEMETRY_LOGS", "1")
    expect(telemetryLogsEnabled()).toBe(true)
    vi.stubEnv("NEXT_PUBLIC_TELEMETRY_LOGS", "0")
    expect(telemetryLogsEnabled()).toBe(false)
  })
})

describe("a body line", () => {
  it("reads <iso> <level> <tag>: <message>, the data after a tab", () => {
    expect(formatLine(line("turn 7 vote", { level: "warn", data: '{"seat":3}' }))).toBe('2026-10-14T20:00:00.123Z warn game: turn 7 vote\t{"seat":3}')
    expect(formatLine(line("no data"))).toBe("2026-10-14T20:00:00.123Z info game: no data")
  })

  it("escapes newlines, tabs and backslashes, so a reader splits it exactly", () => {
    const message = "two\nlines\twith a tab\r and a \\ slash"
    const data = '{"text":"a\\nb"}'
    const text = formatLine(line(message, { data }))
    expect(text).not.toMatch(/\n/)
    expect(text.split("\t")).toHaveLength(2)
    expect(parseBody(text)).toEqual([{ ts: "2026-10-14T20:00:00.123Z", level: "info", tag: "game", message, data }])
  })

  it("formats a line whose data contains a tab and a newline so splitting on \\n and the first \\t restores it", () => {
    const data = '{"note":"first\tsecond\nthird"}'
    const text = formatLine(line("a message", { data }))
    expect(text).not.toMatch(/\n/)
    const [row] = parseBody(text)
    expect(row.message).toBe("a message")
    expect(row.data).toBe(data)
    expect(unescape(row.data!)).toBe(data)
  })

  it("redacts a mnemonic and keeps masked words readable", () => {
    const phrase = "abandon ability able about above absent absorb abstract absurd abuse access accident"
    const text = formatLine(line(`seed ${phrase} Unauthorized`, { data: '{"password":"x"}' }))
    expect(text).not.toContain(phrase)
    expect(text).toContain("[redacted: mnemonic-like string]")
    expect(text).toContain("Unau*horized")
    expect(text).not.toMatch(/auth|password/i)
  })

  it("redacts a mnemonic straddling the cap boundary", () => {
    const words = "abandon ability able about above absent absorb abstract absurd abuse access accident".split(" ")
    // digits have no word boundary, so the padding is not itself a word: only the
    // phrase's own words can form a run
    const text = formatLine(line(`${"9".repeat(LINE_MAX_CHARS - 30)} ${words.join(" ")}`))
    expect(text).toMatch(/…\[truncated \d+ chars\]$/)
    // NONE of the phrase's words survives, however the cap fell
    for (const word of words) expect(text).not.toContain(word)
  })

  it("redacts a mnemonic that the cap would cut to eleven words", () => {
    // the phrase's last word starts exactly at the cap: without a pre-cap scrub,
    // eleven words of it would reach Sentry (scrubMnemonic needs twelve)
    const words = "abandon ability able about above absent absorb abstract absurd abuse access accident".split(" ")
    const head = formatLine(line("")).length
    const first11 = words.slice(0, 11).join(" ")
    const prefix = "9".repeat(LINE_MAX_CHARS - head - first11.length - 2)
    const text = formatLine(line(`${prefix} ${first11} ${words[11]!}`))
    for (const word of words) expect(text).not.toContain(word)
    expect(text).toContain("[redacted: mnemonic-like string]")
  })

  it("caps one line with a marker", () => {
    const text = formatLine(line("x".repeat(LINE_MAX_CHARS + 500)))
    expect(text.length).toBeLessThan(LINE_MAX_CHARS + 100)
    expect(text).toMatch(/…\[truncated \d+ chars\]$/)
  })

  it("redacts a hand-built line that carries a stray text property", () => {
    const phrase = "abandon ability able about above absent absorb abstract absurd abuse access accident"
    // a caller (or a persisted line) must not be able to smuggle raw text past the scrub
    const sneaky = { ...line("hello"), text: `seed ${phrase} Unauthorized` } as unknown as LogLine
    const text = formatLine(sneaky)
    expect(text).not.toContain(phrase)
    expect(text).not.toContain("Unauthorized")
    expect(text).toContain("hello")
  })

  it("writes the epoch, never NaN, for a non-finite time", () => {
    expect(formatLine(line("no time", { ts: Number.NaN }))).toContain("1970-01-01T00:00:00.000Z")
    expect(formatLine(line("no time", { ts: Number.POSITIVE_INFINITY }))).not.toContain("NaN")
    expect(parseBody(formatLine(line("no time", { ts: Number.NaN })))[0].ts).toBe("1970-01-01T00:00:00.000Z")
  })

  it("never cuts an escape in half: the capped line still parses", () => {
    // a backslash-heavy tail so the cut lands inside an escape run
    for (const tail of ["\\", "\\\\", "\\\\\\", "\\\\\\\""]) {
      const text = formatLine(line(`${"9".repeat(LINE_MAX_CHARS - 5)}${tail}${"x".repeat(40)}`))
      expect(text).toMatch(/…\[truncated \d+ chars\]$/)
      expect(parseBody(text)).toHaveLength(1)
      expect(parseBody(text)[0].message).not.toContain("\\[truncated")
    }
  })
})

describe("packing lines into records", () => {
  it("keeps every line once, in order, at most 50 lines or 16 KB a record", () => {
    const lines = Array.from({ length: 180 }, (_, index) => line(`line ${index} ${"y".repeat(index % 7 === 0 ? 1_500 : 20)}`))
    const groups = packLines(lines)
    expect(groups.flatMap((group) => group.lines)).toEqual(lines)
    for (const group of groups) {
      expect(group.lines.length).toBeLessThanOrEqual(RECORD_MAX_LINES)
      expect(new TextEncoder().encode(group.body).byteLength).toBeLessThanOrEqual(RECORD_MAX_BODY_BYTES)
      expect(parseBody(group.body).map((row) => row.message)).toEqual(group.lines.map((entry) => entry.message))
    }
  })

  it("puts a line bigger than the body budget in a record of its own", () => {
    const groups = packLines([line("a"), line("b".repeat(RECORD_MAX_BODY_BYTES + 10)), line("c")])
    expect(groups.map((group) => group.lines.map((entry) => entry.message[0]))).toEqual([["a"], ["b"], ["c"]])
  })

  it("starts a new record when the session changes", () => {
    const groups = packLines([
      line("a1", { sessionId: "a" }),
      line("a2", { sessionId: "a" }),
      line("a3", { sessionId: "a" }),
      line("b1", { sessionId: "b" }),
      line("b2", { sessionId: "b" }),
    ])
    expect(groups).toHaveLength(2)
    expect(groups[0].lines.map((entry) => entry.message)).toEqual(["a1", "a2", "a3"])
    expect(groups[1].lines.map((entry) => entry.message)).toEqual(["b1", "b2"])
    expect(groups.every((group) => new Set(group.lines.map((entry) => entry.sessionId)).size === 1)).toBe(true)
  })

  it("packs the same lines into the same records twice", () => {
    const lines = Array.from({ length: 120 }, (_, index) => line(`line ${index} ${"q".repeat(index % 5 === 0 ? 900 : 30)}`))
    const first = packLines(lines).map((group) => group.body)
    const second = packLines(lines).map((group) => group.body)
    expect(second).toEqual(first)
  })

  it("keeps a 16 KB body with a 4-byte UTF-8 char at the edge under 16,384 bytes", () => {
    const wide = "\u{1F600}" // 4 bytes in UTF-8, 2 UTF-16 code units
    const lines = [line("a".repeat(RECORD_MAX_BODY_BYTES - 120)), line(wide.repeat(40))]
    const groups = packLines(lines)
    expect(groups.flatMap((group) => group.lines)).toEqual(lines)
    for (const group of groups) {
      expect(new TextEncoder().encode(group.body).byteLength).toBeLessThanOrEqual(RECORD_MAX_BODY_BYTES)
    }
    // byte length, not UTF-16 length, decided the split: the wide line stands alone
    expect(groups).toHaveLength(2)
  })
})

describe("a record", () => {
  it("is typed, traced, timed by its first line and levelled by its worst", () => {
    const built = record([line("a"), line("b", { ts: TS + 5, level: "error" })], {
      traceId: "f".repeat(32),
      attributes: { "game.index": "251", account: "5Alice", "game_log.copy": undefined },
      now: TS + 1_000,
    })
    expect(built).toMatchObject({ timestamp: TS / 1000, level: "error", severity_number: 17, trace_id: "f".repeat(32) })
    expect(built.attributes).toEqual({
      "game.index": { value: "251", type: "string" },
      account: { value: "5Alice", type: "string" },
      "game_log.first_ts_ms": { value: TS, type: "integer" },
      "game_log.last_ts_ms": { value: TS + 5, type: "integer" },
    })
  })

  it("is restamped with the send time once its lines are older than 60 h", () => {
    const now = TS + STALE_RECORD_MS + 1
    const built = record([line("old")], { now })
    expect(built.timestamp).toBe(now / 1000)
    expect(built.attributes["game_log.restamped"]).toEqual({ value: true, type: "boolean" })
    expect(built.attributes["game_log.first_ts_ms"]).toEqual({ value: TS, type: "integer" })
  })

  it("masks string attributes and types numbers and booleans", () => {
    expect(logAttributes({ a: "no credentials", b: 1.5, c: false, d: Number.NaN })).toEqual({
      a: { value: "no cr*dentials", type: "string" },
      b: { value: 1.5, type: "double" },
      c: { value: false, type: "boolean" },
    })
  })

  it("leaves an identifier attribute as a string", () => {
    expect(logAttributes({ "game.index": "251" })).toEqual({ "game.index": { value: "251", type: "string" } })
  })

  it("keeps its own attributes over the shared ones", () => {
    const built = record([line("a")], { attributes: { "session.id": "own" } })
    const shared = withAttributes(built, { "session.id": "shared", "sentry.release": "jollity@1" })
    expect(shared.attributes["session.id"]).toEqual({ value: "own", type: "string" })
    expect(shared.attributes["sentry.release"]).toEqual({ value: "jollity@1", type: "string" })
  })

  it("has a stable 32-hex fallback trace id", () => {
    expect(stableHexId("251:session:begin")).toMatch(/^[0-9a-f]{32}$/)
    expect(stableHexId("251:session:begin")).toBe(stableHexId("251:session:begin"))
    expect(stableHexId("251:session:begin")).not.toBe(stableHexId("252:session:begin"))
  })

  it("carries its identity as strings", () => {
    expect(recordIdentity("251:s:1:2:0", 3, 7)).toEqual({
      "game_log.item": "251:s:1:2:0",
      "game_log.record": "3",
      "game_log.records": "7",
    })
  })
})

describe("the special lines", () => {
  it("formats the meta line as an ordinary body line a reader takes out by tag", () => {
    const header = { meta: { app: "jollity", version: "1.2.3" }, worker: { queued: 0 }, extras: "kept" }
    const text = formatLine(specialLine("meta", header, TS, SID))
    const [row] = parseBody(text)
    expect(row.tag).toBe(META_TAG)
    expect(row.level).toBe("info")
    expect(row.message).toBe("header")
    expect(JSON.parse(row.data!)).toEqual(header)
  })

  it("a meta line of 100 KB is not truncated, and one with a 70 KB worker field drops worker and sets workerOmitted", () => {
    const big = specialLine("meta", { meta: { app: "jollity" }, worker: null, extras: "x".repeat(100_000) }, TS, SID)
    const bigText = formatLine(big)
    expect(bigText.length).toBeGreaterThan(100_000)
    expect(bigText).not.toMatch(/truncated/)
    expect(JSON.parse(parseBody(bigText)[0].data!).extras).toHaveLength(100_000)

    const withWorker = specialLine("meta", { meta: { app: "jollity" }, worker: "w".repeat(70_000) }, TS, SID)
    const text = formatLine(withWorker)
    expect(text.length).toBeLessThan(META_LINE_MAX_CHARS)
    const data = JSON.parse(parseBody(text)[0].data!) as { worker: unknown; workerOmitted?: boolean }
    expect(data.worker).toBeNull()
    expect(data.workerOmitted).toBe(true)
  })

  it("an evicted line round-trips its JSON", () => {
    const receipts = [{ id: "251:s:1:2:0", gameIndex: 251, reason: "too-large" }]
    const text = formatLine(specialLine("evicted", receipts, TS, SID))
    const [row] = parseBody(text)
    expect(row.tag).toBe(EVICTED_TAG)
    expect(row.level).toBe("info")
    expect(row.message).toBe("evictedOnDevice")
    expect(JSON.parse(row.data!)).toEqual(receipts)
  })

  it("survives a bigint in the header, as JSON.stringify would not", () => {
    const header = { meta: { gameIndex: 251n } }
    expect(() => specialLine("meta", header, TS, SID)).not.toThrow()
    const data = parseBody(formatLine(specialLine("meta", header, TS, SID)))[0].data!
    expect(data).toContain("251n")
  })
})

describe("the envelope", () => {
  const records = (count: number, size: number) => Array.from({ length: count }, (_, index) =>
    record([line(`${index}:${"z".repeat(size)}`)], { traceId: "b".repeat(32), attributes: { "game_log.record": String(index) } }))

  it("mirrors the SDK's log container item", () => {
    const envelope = logEnvelope(records(2, 10), { name: "sentry.javascript.react", version: "11.1.0" })
    expect(envelope[0]).toEqual({ sdk: { name: "sentry.javascript.react", version: "11.1.0" } })
    const [[header, payload]] = envelope[1]
    expect(header).toEqual({ type: "log", item_count: 2, content_type: "application/vnd.sentry.items.log+json" })
    expect(payload).toMatchObject({ version: 2, ingest_settings: { infer_ip: "never", infer_user_agent: "never" } })
    expect(payload.items).toHaveLength(2)
    expect(isLogEnvelope(envelope)).toBe(true)
    expect(isLogEnvelope([{}, [[{ type: "event" }, {}]]])).toBe(false)
  })

  it("packs records into envelopes within the serialized budget, each record once", () => {
    const all = records(40, 3_000)
    const envelopes = packEnvelopes(all)
    expect(envelopes.length).toBeGreaterThan(1)
    expect(envelopes.flatMap((envelope) => envelope[1][0][1].items)).toEqual(all)
    for (const envelope of envelopes) {
      expect(serializedEnvelopeBytes(envelope)).toBeLessThanOrEqual(LOG_ENVELOPE_MAX_BYTES)
      expect(envelope[1][0][0].item_count).toBe(envelope[1][0][1].items.length)
    }
  })

  it("leaves the browser with keepalive, as the fetch transport measures it", async () => {
    const requests: Array<{ bytes: number; keepalive: boolean }> = []
    const transport = makeFetchTransport(
      { url: "https://example.invalid/api/1/envelope/", recordDroppedEvent: () => {} },
      async (_url, options) => {
        const body = options!.body as string | Uint8Array
        requests.push({ bytes: typeof body === "string" ? new TextEncoder().encode(body).byteLength : body.byteLength, keepalive: options!.keepalive === true })
        return { status: 200, headers: { get: () => null } } as unknown as Response
      },
    )
    for (const envelope of packEnvelopes(records(40, 3_000))) {
      // the SDK's Envelope type does not know the log container's payload
      await transport.send(envelope as never)
      expect(requests.at(-1)!.bytes).toBe(serializedEnvelopeBytes(envelope))
    }
    expect(requests.length).toBeGreaterThan(1)
    expect(requests.every(({ bytes, keepalive }) => keepalive && bytes <= LOG_ENVELOPE_MAX_BYTES)).toBe(true)
  })

  it("sends a record bigger than the budget alone", () => {
    const envelopes = packEnvelopes([...records(1, 10), ...records(1, LOG_ENVELOPE_MAX_BYTES), ...records(1, 10)])
    expect(envelopes.map((envelope) => envelope[1][0][1].items.length)).toEqual([1, 1, 1])
  })
})