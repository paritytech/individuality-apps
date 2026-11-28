// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { beforeEach, describe, expect, it, vi } from "vitest"
import { makeFetchTransport } from "@sentry/browser"
import { createAttachmentEnvelopeItem, createEnvelope } from "@sentry/core"
import type { LogRecord } from "./log-envelope"

const sentry = vi.hoisted(() => ({
  attachments: [] as Array<{ filename: string; data: string }>,
  events: [] as unknown[],
  users: [] as Array<{ id: string }>,
  processors: [] as Array<(event: Record<string, unknown>) => Record<string, unknown>>,
}))
const delivery = vi.hoisted(() => vi.fn<() => Promise<boolean>>())
const logSender = vi.hoisted(() => ({
  calls: [] as Array<{ key: string; records: readonly LogRecord[] }>,
  rejected: new Set<string>(),
}))
const storageFallbackDelivery = vi.hoisted(() => ({
  logEvent: vi.fn(),
  recordCount: vi.fn(),
}))

vi.mock("@sentry/react", () => ({
  withScope: (run: (scope: { addAttachment(value: { filename: string; data: string }): void; addEventProcessor(value: (event: Record<string, unknown>) => Record<string, unknown>): void; setTags(): void; setUser(value: { id: string }): void; clearBreadcrumbs(): void }) => void) => {
    sentry.processors = []
    run({
      addAttachment: (value) => sentry.attachments.push(value),
      addEventProcessor: (value) => sentry.processors.push(value),
      setTags: () => {},
      setUser: (value) => sentry.users.push(value),
      clearBreadcrumbs: () => {},
    })
    sentry.processors = []
  },
  captureEvent: (event: unknown) => {
    let value: Record<string, unknown> = { ...(event as Record<string, unknown>), breadcrumbs: [{ message: "isolation inherited" }] }
    for (const processor of sentry.processors) value = processor(value)
    sentry.events.push(value)
  },
}))
vi.mock("./init", () => ({
  expectDelivery: () => delivery(),
  takeAttachmentDropped: () => false,
  sendLogEnvelope: async (key: string, records: readonly LogRecord[]) => {
    logSender.calls.push({ key, records })
    return delivery()
  },
  takeLogRejected: (key: string) => logSender.rejected.delete(key),
}))

import { devLog } from "../debug/log-store"
import { readSessionLink, resetSessionLinkForTests } from "../debug/session-link"
import { SESSION_ID } from "../debug/session-id"
import { APP_VERSION } from "../debug/flag"
import {
  GAME_LOG_CHUNK_MAX_BYTES,
  GAME_LOG_CHUNK_KEY_PREFIX,
  GAME_LOG_ACTIVE_KEY,
  GAME_LOG_OUTBOX_MAX_BYTES,
  GAME_LOG_OUTBOX_KEY,
  ROLLING_CHECKPOINT_LINES,
  beginGameLogOutbox,
  checkpointGameLog,
  drainGameLogOutbox,
  enqueueFullGameLog,
  gameLogTailDurable,
  gameLogTailState,
  gameLogManifest,
  installGameLogOutbox,
  resetGameLogOutboxForTests,
  setGameLogOutboxAccount,
  setFullGameLogDeliveredHandler,
  setGameLogOutboxStorageFallbackDelivery,
  settleGameLogOutbox,
  splitGameLogLines,
  splitFullGameLog,
  type GameLogChunkLine,
} from "./game-log-outbox"

const line = (message: string, ts = 1): GameLogChunkLine => ({
  ts,
  sessionId: "session",
  lineId: `session:${ts}:fixture`,
  level: "info",
  tag: "test",
  message,
})

class MemoryStorage {
  readonly values = new Map<string, string>()
  get length(): number { return this.values.size }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null }
  getItem(key: string): string | null { return this.values.get(key) ?? null }
  setItem(key: string, value: string): void { this.values.set(key, value) }
  removeItem(key: string): void { this.values.delete(key) }
  clear(): void { this.values.clear() }
}

let storage: MemoryStorage

/** The eviction records the index still holds on the device. */
function storedEvictedIds(): string[] {
  const index = JSON.parse(localStorage.getItem(GAME_LOG_OUTBOX_KEY)!) as {
    evicted: Array<{ id: string }>
  }
  return index.evicted.map((item) => item.id)
}

function durableChunks(): GameLogChunkLine[][] {
  const index = JSON.parse(localStorage.getItem(GAME_LOG_OUTBOX_KEY)!) as { chunkIds: string[] }
  return index.chunkIds.map((id) => (JSON.parse(localStorage.getItem(`${GAME_LOG_CHUNK_KEY_PREFIX}${encodeURIComponent(id)}`)!) as { lines: GameLogChunkLine[] }).lines)
}

function liveTailKeys(): string[] {
  return [...storage.values.keys()].filter((key) => key.startsWith(GAME_LOG_ACTIVE_KEY))
}

function bodyEntries(records: readonly LogRecord[]): Array<Record<string, unknown>> {
  return records.flatMap((record) => record.body.split("\n").flatMap((row) => {
    if (row.includes(" game-log.meta: ") || row.includes(" game-log.evicted: ")) return []
    const match = /^(\S+) (\S+) ([^:]+): ([^\t]*)(?:\t(.*))?$/.exec(row)
    if (!match) throw new Error(`unparseable log row: ${row}`)
    return [{
      ts: Date.parse(match[1]!),
      sessionId: record.attributes["session.id"]?.value,
      ...(record.attributes["app.version"]?.value === undefined ? {} : { version: record.attributes["app.version"]!.value }),
      level: match[2],
      tag: match[3],
      message: match[4],
      ...(match[5] === undefined ? {} : { data: (() => {
        try { return JSON.parse(match[5]!) as unknown } catch { return match[5] }
      })() }),
    }]
  }))
}

describe("the durable game-log outbox", () => {
  beforeEach(async () => {
    // Let the preceding test's fire-and-forget drain finish before replacing
    // module memory; a real page kill also destroys those promises.
    await new Promise((resolve) => setTimeout(resolve, 0))
    storage = new MemoryStorage()
    vi.stubGlobal("localStorage", storage)
    vi.stubGlobal("window", new EventTarget())
    vi.stubGlobal("document", Object.assign(new EventTarget(), { visibilityState: "visible" }))
    resetGameLogOutboxForTests()
    resetSessionLinkForTests()
    sentry.attachments.length = 0
    sentry.events.length = 0
    sentry.users.length = 0
    sentry.processors = []
    logSender.calls.length = 0
    logSender.rejected.clear()
    delivery.mockReset()
    storageFallbackDelivery.logEvent.mockReset()
    storageFallbackDelivery.recordCount.mockReset()
    setGameLogOutboxStorageFallbackDelivery(storageFallbackDelivery)
    delivery.mockResolvedValue(false)
    vi.stubEnv("NEXT_PUBLIC_TELEMETRY_LOGS", "1")
  })

  it("reports the active tail durable only after the debounce, without sending from the dying page", async () => {
    vi.useFakeTimers()
    try {
      const stop = installGameLogOutbox()
      beginGameLogOutbox(739)
      devLog("role", "final turn sealed")

      expect(gameLogTailDurable()).toBe(false)
      expect(logSender.calls).toEqual([])

      await vi.advanceTimersByTimeAsync(249)
      expect(gameLogTailDurable()).toBe(false)
      expect(logSender.calls).toEqual([])

      await vi.advanceTimersByTimeAsync(1)
      expect(gameLogTailDurable()).toBe(true)
      expect(gameLogManifest(739).chunks).toEqual([])
      expect(logSender.calls).toEqual([])
      stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it("reports an empty active tail durable after its records have already been delivered", async () => {
    const stop = installGameLogOutbox()
    beginGameLogOutbox(741)
    expect(gameLogTailDurable()).toBe(true)
    stop()
  })

  it("reports the page-clock age and count of an unsaved active tail", () => {
    const stop = installGameLogOutbox()
    beginGameLogOutbox(742)
    devLog("role", "required before kill")
    const state = gameLogTailState(Date.now() + 350)
    expect(state).toMatchObject({ durable: false, pendingLines: 1 })
    expect(state.newestLineAgeMs).toBeGreaterThanOrEqual(350)
    stop()
  })

  it("reports an empty tail as durable, with nothing pending and no age", () => {
    const stop = installGameLogOutbox()
    beginGameLogOutbox(743)
    expect(gameLogTailState()).toEqual({ durable: true, pendingLines: 0, newestLineAgeMs: null })
    stop()
  })

  it("retains startup linkage at game capture start with its original identity, not other pre-game logs", async () => {
    const stop = installGameLogOutbox()
    const payload = {
      schemaVersion: 1, sessionId: SESSION_ID, sequence: 1,
      buildCommit: "jollity-build-commit:cached",
      timing: { wallMs: 1_792_413_000_123, monotonicMs: 12.5 },
      observation: { previousLogSessionId: "prior-page", lineageId: "same-tab", timeOriginMs: 1_792_413_000_110 },
    }
    devLog("replay", "session.link", payload)
    const original = readSessionLink()!
    devLog("private-pregame", "unrelated startup line")
    payload.observation.lineageId = "later mutation"

    beginGameLogOutbox(953)
    // The retained link is durable even before another game line arrives.
    const tail = JSON.parse(localStorage.getItem(liveTailKeys()[0]!)!) as { lines: GameLogChunkLine[] }
    expect(tail.lines).toEqual([{ ...original }])
    beginGameLogOutbox(953)
    const chunks = checkpointGameLog("handover")
    expect(chunks.flatMap((chunk) => chunk.lines)).toEqual([{ ...original }])
    expect(JSON.parse(chunks[0]!.lines[0]!.data!)).toMatchObject({
      sequence: 1,
      timing: { wallMs: 1_792_413_000_123 },
      observation: { previousLogSessionId: "prior-page", lineageId: "same-tab" },
    })
    await drainGameLogOutbox()
    expect(logSender.calls.flatMap((call) => call.records).every((record) => !record.body.includes("unrelated startup line"))).toBe(true)
    stop()
  })

  it("rolls a 120-line synchronous burst into three deterministic records with every line once", async () => {
    const stop = installGameLogOutbox()
    beginGameLogOutbox(740)
    for (let index = 0; index < 120; index += 1) devLog("packed", `line-${index}`)
    checkpointGameLog("report", 1_000)
    await drainGameLogOutbox()

    const first = new Map(logSender.calls.map((call) => [call.key, call.records]))
    expect(first.size).toBe(1)
    expect([...first.values()].flat()).toHaveLength(3)
    expect([...first.values()].flat().map((record) => record.attributes["game_log.records"])).toEqual([
      { type: "string", value: "3" },
      { type: "string", value: "3" },
      { type: "string", value: "3" },
    ])
    expect([...first.values()].flat().map((record) => record.attributes["game_log.captured_ms"])).toEqual([
      { type: "integer", value: 1_000 },
      { type: "integer", value: 1_000 },
      { type: "integer", value: 1_000 },
    ])
    expect([...first.values()].flat().every((record) =>
      record.attributes["app.version"]?.type === "string"
      && record.attributes["app.version"]?.value === APP_VERSION,
    )).toBe(true)
    const body = [...first.values()].flat().map((record) => record.body).join("\n")
    for (let index = 0; index < 120; index += 1) {
      expect(body.match(new RegExp(`packed: line-${index}(?:\\n|$)`, "g"))).toHaveLength(1)
    }

    logSender.calls.length = 0
    await drainGameLogOutbox()
    expect(new Map(logSender.calls.map((call) => [call.key, call.records]))).toEqual(first)
    stop()
  })

  it("splits full-copy records by session, starts part zero with meta, and keeps app versions", async () => {
    const entries = [
      { ts: 10, sessionId: "session-a", version: "1.2.3", level: "info", tag: "full", message: "one", data: { round: 1 } },
      { ts: 11, sessionId: "session-b", version: "1.2.4", level: "warn", tag: "full", message: "two", data: "raw-json" },
    ]
    await enqueueFullGameLog({
      gameIndex: 741,
      stage: "payoff",
      trace: { traceId: "a".repeat(32), spanId: "b".repeat(16) },
      filename: "game-741.json",
      json: JSON.stringify({ meta: { gameIndex: 741 }, worker: { state: "ready" }, entries }),
      capturedAt: 20,
    })

    const records = logSender.calls[0]!.records
    expect(records).toHaveLength(3)
    expect(records[0]!.body).toContain("game-log.meta: header")
    expect(records[0]!.attributes["game_log.record"]).toEqual({ type: "string", value: "0" })
    expect(records[1]!.attributes["session.id"]).toEqual({ type: "string", value: "session-a" })
    expect(records[1]!.attributes["app.version"]).toEqual({ type: "string", value: "1.2.3" })
    expect(records[2]!.attributes["session.id"]).toEqual({ type: "string", value: "session-b" })
    expect(records[2]!.attributes["app.version"]).toEqual({ type: "string", value: "1.2.4" })
    expect(records[1]!.body).toContain("\t{\"round\":1}")
    expect(records[2]!.body).toContain("\traw-json")
    expect(records.every((record) => record.trace_id === "a".repeat(32))).toBe(true)
    expect(records.every((record) => record.attributes["game_log.captured_ms"]?.type === "integer"
      && record.attributes["game_log.captured_ms"]?.value === 20)).toBe(true)
  })

  it("uses the durable item's session for a part-zero meta record after reopen", async () => {
    await enqueueFullGameLog({
      gameIndex: 745,
      stage: "payoff",
      trace: null,
      filename: "game-745.json",
      json: JSON.stringify({ meta: { gameIndex: 745 }, entries: [line("persisted")] }),
      capturedAt: 21,
    })
    const index = JSON.parse(localStorage.getItem(GAME_LOG_OUTBOX_KEY)!) as { chunkIds: string[] }
    const key = `${GAME_LOG_CHUNK_KEY_PREFIX}${encodeURIComponent(index.chunkIds[0]!)}`
    const part = JSON.parse(localStorage.getItem(key)!) as { sessionId: string }
    part.sessionId = "persisted-session"
    localStorage.setItem(key, JSON.stringify(part))
    resetGameLogOutboxForTests()
    logSender.calls.length = 0

    await drainGameLogOutbox(true)
    expect(logSender.calls[0]!.records[0]!.attributes["session.id"]).toEqual({ type: "string", value: "persisted-session" })
    expect(logSender.calls[0]!.records.every((record) =>
      record.attributes["game_log.captured_ms"]?.type === "integer"
      && record.attributes["game_log.captured_ms"]?.value === 21,
    )).toBe(true)
  })

  it("normalizes string data so a chunk and its full-copy line dedupe", async () => {
    const stop = installGameLogOutbox()
    beginGameLogOutbox(746)
    devLog("same", "line", "plain-string")
    const [chunk] = checkpointGameLog("report")
    const source = chunk!.lines[0]!
    await enqueueFullGameLog({
      gameIndex: 746,
      stage: "payoff",
      trace: null,
      filename: "game-746.json",
      json: JSON.stringify({ entries: [{
        ts: source.ts,
        sessionId: source.sessionId,
        lineId: source.lineId,
        version: "test",
        level: source.level,
        tag: source.tag,
        message: source.message,
        data: "plain-string",
      }] }),
      capturedAt: source.ts,
    })

    const chunkBody = logSender.calls.find(({ key }) => key === chunk!.id)!.records[0]!.body
    const fullBody = logSender.calls.find(({ records }) => records.some((record) => record.attributes["game_log.copy"] !== undefined))!
      .records.find((record) => !record.body.includes("game-log.meta: header"))!.body
    expect(fullBody).toBe(chunkBody)
    const chunkRecord = logSender.calls.find(({ key }) => key === chunk!.id)!.records[0]!
    const fullRecord = logSender.calls.find(({ records }) => records.some((record) => record.attributes["game_log.copy"] !== undefined))!
      .records.find((record) => !record.body.includes("game-log.meta: header"))!
    expect(fullRecord.body).toContain(source.lineId)
    expect(chunkRecord.body).toContain(source.lineId)
    expect(fullRecord.attributes["game_log.line_ids"]).toBeUndefined()
    expect(chunkRecord.attributes["game_log.line_ids"]).toBeUndefined()
    stop()
  })

  it("stamps identical same-millisecond lines with distinct capture identities", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(123)
    try {
      const stop = installGameLogOutbox()
      beginGameLogOutbox(843)
      devLog("clock", "same")
      devLog("clock", "same")
      const [chunk] = checkpointGameLog("report")
      expect(chunk!.lines.map((entry) => entry.lineId)).toEqual([
        expect.stringMatching(/.+:\d+$/),
        expect.stringMatching(/.+:\d+$/),
      ])
      expect(new Set(chunk!.lines.map((entry) => entry.lineId)).size).toBe(2)
      stop()
    } finally {
      now.mockRestore()
    }
  })

  it("carries an eviction recorded between two attempts of the same item", async () => {
    const stop = installGameLogOutbox()
    beginGameLogOutbox(747)
    devLog("retry", "stable")
    checkpointGameLog("report")
    const index = JSON.parse(localStorage.getItem(GAME_LOG_OUTBOX_KEY)!) as { chunkIds: string[]; evicted: unknown[] }
    index.evicted = [{ id: "old-a", gameIndex: 700 }]
    localStorage.setItem(GAME_LOG_OUTBOX_KEY, JSON.stringify(index))
    const itemKey = `${GAME_LOG_CHUNK_KEY_PREFIX}${encodeURIComponent(index.chunkIds[0]!)}`
    const item = JSON.parse(localStorage.getItem(itemKey)!) as { capturedAt: number; evictedOnDevice?: unknown[] }
    item.evictedOnDevice = [...index.evicted]
    localStorage.setItem(itemKey, JSON.stringify(item))
    resetGameLogOutboxForTests()

    const now = vi.spyOn(Date, "now").mockReturnValue(item.capturedAt + 1_000)
    try {
      await drainGameLogOutbox(true)
      const first = logSender.calls.at(-1)!.records
      expect(first.at(-1)!.body).toContain('game-log.evicted: evictedOnDevice\t[{"id":"old-a","gameIndex":700}]')
      expect(first.at(-1)!.attributes["game_log.record"]).toEqual({ type: "string", value: String(first.length - 1) })
      expect(first.every((record) => record.attributes["game_log.captured_ms"]?.type === "integer"
        && record.attributes["game_log.captured_ms"]?.value === item.capturedAt)).toBe(true)

      // A retry keeps its first snapshot, so it stays the same payload under
      // the same id. The eviction recorded between the attempts was carried
      // by nobody, so it must still be recorded, not cleared.
      const changed = JSON.parse(localStorage.getItem(GAME_LOG_OUTBOX_KEY)!) as { evicted: unknown[] }
      changed.evicted = [{ id: "old-b", gameIndex: 701 }]
      localStorage.setItem(GAME_LOG_OUTBOX_KEY, JSON.stringify(changed))
      resetGameLogOutboxForTests()
      now.mockReturnValue(item.capturedAt + 60_000)
      await drainGameLogOutbox(true)
      const retry = logSender.calls.at(-1)!.records
      expect(retry.at(-1)!.body).toContain('"id":"old-a"')
      expect(retry.at(-1)!.body).not.toContain('"id":"old-b"')
      expect(storedEvictedIds()).toContain("old-b")

      // The next new item is what carries it.
      logSender.calls.length = 0
      beginGameLogOutbox(748)
      devLog("retry", "carrier")
      checkpointGameLog("report")
      await drainGameLogOutbox(true)
      const bodies = logSender.calls.flatMap(({ records }) => records.map((record) => record.body)).join("\n")
      expect(bodies).toContain('"id":"old-b"')
    } finally {
      now.mockRestore()
      stop()
    }
  })

  it("drops a final 413 log item and records a too-large eviction receipt", async () => {
    delivery.mockImplementation(async () => {
      logSender.rejected.add(logSender.calls.at(-1)!.key)
      return false
    })
    const stop = installGameLogOutbox()
    beginGameLogOutbox(742)
    devLog("large", "rejected")
    const [chunk] = checkpointGameLog("report")
    await drainGameLogOutbox()

    await vi.waitFor(() => expect(
      (JSON.parse(localStorage.getItem(GAME_LOG_OUTBOX_KEY)!) as { chunkIds: string[] }).chunkIds,
    ).not.toContain(chunk!.id))
    const index = JSON.parse(localStorage.getItem(GAME_LOG_OUTBOX_KEY)!) as {
      chunkIds: string[]
      evicted: Array<{ id: string; gameIndex: number; reason?: string }>
    }
    expect(index.evicted).toContainEqual({ id: chunk!.id, gameIndex: 742, reason: "too-large" })
    stop()
  })

  it("commits accepted and rejected attempts to their own durable item ids", async () => {
    let attempt = 0
    delivery.mockImplementation(async () => {
      if (attempt++ === 1) {
        logSender.rejected.add(logSender.calls.at(-1)!.key)
        return false
      }
      return true
    })
    const stop = installGameLogOutbox()
    beginGameLogOutbox(749)
    devLog("delivery-id", "accepted")
    const [accepted] = checkpointGameLog("round-1")
    devLog("delivery-id", "rejected")
    const [rejected] = checkpointGameLog("report")

    await drainGameLogOutbox(true)

    expect(gameLogManifest(749).chunks).toContainEqual(expect.objectContaining({ id: accepted!.id, status: "delivered" }))
    expect(gameLogManifest(749).chunks).not.toContainEqual(expect.objectContaining({ id: rejected!.id }))
    expect(storedEvictedIds()).toContain(rejected!.id)
    stop()
  })

  it("does not leave a full copy pending or report success after a final 413", async () => {
    delivery.mockImplementation(async () => {
      logSender.rejected.add(logSender.calls.at(-1)!.key)
      return false
    })
    await expect(enqueueFullGameLog({
      gameIndex: 744,
      stage: "payoff",
      trace: null,
      filename: "too-large.json",
      json: JSON.stringify({ meta: { gameIndex: 744 }, entries: [line("too large")] }),
      capturedAt: 30,
    })).resolves.toBe(false)
    const index = JSON.parse(localStorage.getItem(GAME_LOG_OUTBOX_KEY)!) as {
      chunkIds: string[]
      fullCopies: unknown[]
      evicted: Array<{ gameIndex: number; reason?: string }>
    }
    expect(index.chunkIds).toEqual([])
    expect(index.fullCopies).toEqual([])
    expect(index.evicted).toContainEqual(expect.objectContaining({ gameIndex: 744, reason: "too-large" }))
  })

  it("reports a pending full copy false when its retry receives a final 413", async () => {
    await expect(enqueueFullGameLog({
      gameIndex: 748,
      stage: "payoff",
      trace: null,
      filename: "retry-too-large.json",
      json: JSON.stringify({ meta: { gameIndex: 748 }, entries: [line("retry too large")] }),
      capturedAt: 31,
    })).resolves.toBe(false)
    delivery.mockImplementation(async () => {
      logSender.rejected.add(logSender.calls.at(-1)!.key)
      return false
    })
    await expect(enqueueFullGameLog({
      gameIndex: 748,
      stage: "payoff",
      trace: null,
      filename: "retry-too-large.json",
      json: JSON.stringify({ meta: { gameIndex: 748 }, entries: [line("retry too large")] }),
      capturedAt: 32,
    })).resolves.toBe(false)
    expect(JSON.parse(localStorage.getItem(GAME_LOG_OUTBOX_KEY)!).fullCopies).toEqual([])
  })

  it("uses the legacy attachment path when the Logs kill switch is off", async () => {
    vi.stubEnv("NEXT_PUBLIC_TELEMETRY_LOGS", "0")
    const stop = installGameLogOutbox()
    beginGameLogOutbox(743)
    devLog("legacy", "attachment")
    checkpointGameLog("report")
    await drainGameLogOutbox()
    expect(logSender.calls).toEqual([])
    expect(sentry.events).toContainEqual(expect.objectContaining({ message: "game-log-chunk" }))
    expect(sentry.attachments).toHaveLength(1)
    stop()
  })

  it("splits below the keepalive budget without losing or reordering a line", () => {
    const lines = Array.from({ length: 40 }, (_, index) => line(`${index}:${"x".repeat(2_000)}`, index))
    const parts = splitGameLogLines(lines)
    expect(parts.length).toBeGreaterThan(1)
    expect(parts.flat()).toEqual(lines)
    for (const part of parts) {
      expect(new TextEncoder().encode(JSON.stringify(part)).byteLength).toBeLessThanOrEqual(GAME_LOG_CHUNK_MAX_BYTES)
    }
  })

  it("splits a full export into independently useful bounded documents", () => {
    const entries = Array.from({ length: 5 }, (_, index) => ({
      ts: index,
      sessionId: "session",
      level: "info",
      tag: "test",
      message: `${index}:${"x".repeat(20_000)}`,
    }))
    const parts = splitFullGameLog(JSON.stringify({ meta: { gameIndex: 723 }, entries, worker: { state: "ready" } }), "copy")
    expect(parts.length).toBeGreaterThan(1)
    const parsed = parts.map((part) => part as {
      entries: unknown[]
      meta?: { gameIndex: number }
      worker?: { state: string }
      gameLogPart: { copyId: string; part: number; parts: number }
    })
    expect(parsed.flatMap((part) => part.entries)).toEqual(entries)
    expect(parsed.map((part) => part.gameLogPart)).toEqual(
      parsed.map((_part, index) => ({ schema: 1, copyId: "copy", part: index, parts: parsed.length })),
    )
    for (const part of parts) expect(new TextEncoder().encode(JSON.stringify(part)).byteLength).toBeLessThanOrEqual(GAME_LOG_CHUNK_MAX_BYTES)
    expect(parsed[0]).toMatchObject({ meta: { gameIndex: 723 }, worker: { state: "ready" } })
    for (const part of parsed.slice(1)) {
      expect(part.meta).toBeUndefined()
      expect(part.worker).toBeUndefined()
    }
  })

  it("keeps every split envelope inside the browser SDK navigation keepalive budget", async () => {
    const requests: Array<{ bytes: number; keepalive: boolean }> = []
    const transport = makeFetchTransport(
      { url: "https://example.invalid/api/1/envelope/", recordDroppedEvent: () => {} },
      async (_url, options) => {
        const body = options!.body as string | Uint8Array
        requests.push({ bytes: typeof body === "string" ? new TextEncoder().encode(body).byteLength : body.byteLength, keepalive: options!.keepalive === true })
        return { status: 200, headers: { get: () => null } } as unknown as Response
      },
    )
    const send = async (data: string) => {
      await transport.send(createEnvelope({}, [
        [{ type: "event" }, { event_id: "0".repeat(32), message: "game-log", breadcrumbs: [] }],
        createAttachmentEnvelopeItem({ filename: "game.json", data, contentType: "application/json" }),
      ]))
    }

    await send("x".repeat(1_100_000))
    expect(requests).toEqual([expect.objectContaining({ keepalive: false })])

    const documents = splitFullGameLog(JSON.stringify({
      meta: { gameIndex: 723 },
      entries: Array.from({ length: 30 }, (_, index) => line(`${index}:${"x".repeat(20_000)}`, index)),
    }), "copy")
    for (const document of documents) await send(JSON.stringify(document))
    expect(requests.slice(1).length).toBeGreaterThan(1)
    expect(requests.slice(1).every(({ bytes, keepalive }) => keepalive && bytes <= 60_000)).toBe(true)
  })

  it("persists every full-log part before capture and retries only missing parts after a killed page", async () => {
    const entries = Array.from({ length: 4 }, (_, index) => ({
      ts: index,
      sessionId: "session",
      version: "test",
      level: "info",
      tag: "test",
      message: `${index}:${"x".repeat(24_000)}`,
      data: index % 2 === 0 ? { index } : `raw-${index}`,
    }))
    const completed = vi.fn(async () => {})
    setFullGameLogDeliveredHandler(completed)
    const partCount = splitFullGameLog(JSON.stringify({ meta: { gameIndex: 723 }, entries }), "preview").length
    let attempts = 0
    delivery.mockImplementation(async () => {
      attempts += 1
      const index = JSON.parse(localStorage.getItem(GAME_LOG_OUTBOX_KEY)!) as { chunkIds: string[] }
      // The whole copy is durable before its first envelope enters Sentry.
      if (attempts === 1) expect(index.chunkIds).toHaveLength(partCount)
      return attempts === 1
    })

    await expect(enqueueFullGameLog({
      gameIndex: 723,
      stage: "payoff",
      trace: null,
      filename: "game-723.json",
      json: JSON.stringify({ meta: { gameIndex: 723 }, entries }),
      capturedAt: 100,
    })).resolves.toBe(false)
    expect(completed).not.toHaveBeenCalled()
    expect((JSON.parse(localStorage.getItem(GAME_LOG_OUTBOX_KEY)!) as { chunkIds: string[] }).chunkIds).toHaveLength(partCount - 1)

    // A killed page loses every promise and memory object, but not the three
    // unaccepted parts or their copy-level completion record.
    resetGameLogOutboxForTests()
    setFullGameLogDeliveredHandler(completed)
    delivery.mockResolvedValue(true)
    await drainGameLogOutbox(true)
    expect((JSON.parse(localStorage.getItem(GAME_LOG_OUTBOX_KEY)!) as { chunkIds: string[] }).chunkIds).toEqual([])
    expect(completed).toHaveBeenCalledTimes(1)
    expect(completed).toHaveBeenCalledWith(expect.objectContaining({ gameIndex: 723, stage: "payoff", partIds: expect.arrayContaining([expect.any(String)]) }))

    const fullCalls = logSender.calls.filter(({ records }) =>
      records.some((record) => record.attributes["game_log.copy"] !== undefined))
    expect(new Set(fullCalls.map(({ records }) => records[0]!.attributes["game_log.part"]?.value)).size).toBe(partCount)
    const deduped = new Map(fullCalls.map((call) => [call.key, call.records]))
    expect(bodyEntries([...deduped.values()].flat())).toEqual(entries)
  })

  it("keeps a full-log part pending when its transport receipt is false", async () => {
    delivery.mockResolvedValue(false)
    await expect(enqueueFullGameLog({
      gameIndex: 724,
      stage: "payoff",
      trace: null,
      filename: "game-724.json",
      json: JSON.stringify({ meta: { gameIndex: 724 }, entries: [line("not delivered")] }),
      capturedAt: 101,
    })).resolves.toBe(false)
    const index = JSON.parse(localStorage.getItem(GAME_LOG_OUTBOX_KEY)!) as { chunkIds: string[]; fullCopies: unknown[] }
    expect(index.chunkIds).toHaveLength(1)
    expect(index.fullCopies).toHaveLength(1)
    expect(logSender.calls).toEqual([expect.objectContaining({ key: expect.stringContaining("724:payoff:") })])
    expect(sentry.events).not.toContainEqual(expect.objectContaining({ message: "game-log" }))
  })

  it("does not wait for a hung host finalizer after receipts complete", async () => {
    setFullGameLogDeliveredHandler(() => new Promise(() => {}))
    delivery.mockResolvedValue(false)
    await enqueueFullGameLog({
      gameIndex: 725,
      stage: "payoff",
      trace: null,
      filename: "game-725.json",
      json: JSON.stringify({ meta: { gameIndex: 725 }, entries: [line("durable")] }),
      capturedAt: 102,
    })
    delivery.mockResolvedValue(true)
    const result = await Promise.race([
      drainGameLogOutbox(true).then(() => "drained"),
      new Promise((resolve) => setTimeout(() => resolve("hung"), 50)),
    ])
    expect(result).toBe("drained")
    expect((JSON.parse(localStorage.getItem(GAME_LOG_OUTBOX_KEY)!) as { fullCopies: unknown[] }).fullCopies).toEqual([])
    setFullGameLogDeliveredHandler(async () => {})
  })

  it("stores one current-game full copy below 2 MB and upgrades report to payoff", async () => {
    delivery.mockResolvedValue(false)
    const stop = installGameLogOutbox()
    beginGameLogOutbox(726)
    devLog("quota", `checkpoint:${"c".repeat(80_000)}`)
    checkpointGameLog("report")
    const entries = [{ ...line("x".repeat(950_000)), data: "current-game" }]
    const capturedAt = Date.now() + 1
    await enqueueFullGameLog({ gameIndex: 726, stage: "report", trace: null, filename: "report.json", json: JSON.stringify({ meta: {}, entries }), capturedAt })
    await enqueueFullGameLog({ gameIndex: 726, stage: "payoff", trace: null, filename: "payoff.json", json: JSON.stringify({ meta: {}, entries }), capturedAt: capturedAt + 1 })
    const index = JSON.parse(localStorage.getItem(GAME_LOG_OUTBOX_KEY)!) as { chunkIds: string[]; fullCopies: Array<{ stage: string }> }
    expect(index.fullCopies).toEqual([expect.objectContaining({ stage: "payoff" })])
    const durableBytes = [...storage.values.entries()].reduce((sum, [key, value]) => sum + (key.length + value.length) * 2, 0)
    expect(durableBytes).toBeLessThanOrEqual(GAME_LOG_OUTBOX_MAX_BYTES)
    expect(index.chunkIds.length).toBeGreaterThan(0)
    stop()
  })

  it("counts the per-page live tail inside the shared 2 MB evidence budget", async () => {
    delivery.mockResolvedValue(false)
    const stop = installGameLogOutbox()
    beginGameLogOutbox(727)
    devLog("quota", `durable:${"c".repeat(80_000)}`)
    checkpointGameLog("report")
    devLog("quota", `live:${"l".repeat(80_000)}`)
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(liveTailKeys()).toHaveLength(1)

    await enqueueFullGameLog({
      gameIndex: 727,
      stage: "payoff",
      trace: null,
      filename: "payoff.json",
      json: JSON.stringify({ meta: {}, entries: [{ ...line("x".repeat(950_000)), data: "current-game" }] }),
      capturedAt: Date.now() + 1,
    })

    const durableBytes = [...storage.values.entries()].reduce((sum, [key, value]) => sum + (key.length + value.length) * 2, 0)
    expect(durableBytes).toBeLessThanOrEqual(GAME_LOG_OUTBOX_MAX_BYTES)
    expect(liveTailKeys()).toHaveLength(1)
    stop()
  })

  it("retires an oversized full copy before current-game chunks and never reports it sent", async () => {
    delivery.mockResolvedValue(false)
    const stop = installGameLogOutbox()
    beginGameLogOutbox(728)
    const chunkIds: string[] = []
    for (let index = 0; index < 10; index += 1) {
      devLog("quota", `${index}:${"c".repeat(20_000)}`)
      chunkIds.push(checkpointGameLog("round-1")[0]!.id)
    }

    await expect(enqueueFullGameLog({
      gameIndex: 728,
      stage: "payoff",
      trace: null,
      filename: "oversized.json",
      json: JSON.stringify({ meta: { gameIndex: 728 }, entries: [line("x".repeat(1_100_000))] }),
      capturedAt: 106,
    })).resolves.toBe(false)

    const index = JSON.parse(localStorage.getItem(GAME_LOG_OUTBOX_KEY)!) as {
      chunkIds: string[]
      fullCopies: unknown[]
      evicted: Array<{ id: string; gameIndex: number }>
    }
    expect(index.chunkIds).toEqual(expect.arrayContaining(chunkIds))
    expect(index.fullCopies).toEqual([])
    expect(index.evicted.some(({ gameIndex }) => gameIndex === 728)).toBe(true)
    expect(gameLogManifest(728).chunks).toHaveLength(chunkIds.length)
    stop()
  })

  it("never evicts the active game's chunks for a late copy of an older game", async () => {
    delivery.mockResolvedValue(false)
    const stop = installGameLogOutbox()
    beginGameLogOutbox(730)
    const chunkIds: string[] = []
    for (let index = 0; index < 10; index += 1) {
      devLog("quota", `${index}:${"c".repeat(20_000)}`)
      chunkIds.push(checkpointGameLog("round-1")[0]!.id)
    }

    await enqueueFullGameLog({
      gameIndex: 729,
      stage: "late",
      trace: null,
      filename: "older.json",
      json: JSON.stringify({ meta: { gameIndex: 729 }, entries: Array.from({ length: 45 }, (_, index) => line(`${index}:${"x".repeat(20_000)}`, index)) }),
      capturedAt: 107,
    })

    const index = JSON.parse(localStorage.getItem(GAME_LOG_OUTBOX_KEY)!) as { chunkIds: string[] }
    expect(index.chunkIds).toEqual(expect.arrayContaining(chunkIds))
    expect(gameLogManifest(730).chunks.filter((chunk) => chunk.status === "pending")).toHaveLength(chunkIds.length)
    stop()
  })

  it("bounds a full-copy drain to three concurrent envelopes", async () => {
    let current = 0
    let maximum = 0
    delivery.mockImplementation(async () => {
      current += 1
      maximum = Math.max(maximum, current)
      await new Promise((resolve) => setTimeout(resolve, 2))
      current -= 1
      return false
    })
    const entries = Array.from({ length: 12 }, (_, index) => line(`${index}:${"x".repeat(20_000)}`, index))
    await enqueueFullGameLog({ gameIndex: 727, stage: "payoff", trace: null, filename: "bounded.json", json: JSON.stringify({ meta: {}, entries }), capturedAt: 105 })
    expect(maximum).toBeLessThanOrEqual(3)
    expect(maximum).toBeGreaterThan(1)
  })

  it("persists before delivery and survives a killed page", async () => {
    const stopBeforeKill = installGameLogOutbox()
    beginGameLogOutbox(723)
    devLog("vote", "line one")
    devLog("vote", "line two")
    const chunks = checkpointGameLog("round-1", 10)
    expect(chunks.flatMap((chunk) => chunk.lines.map((entry) => entry.message))).toEqual(["line one", "line two"])
    expect(durableChunks().flat().map((entry) => entry.message)).toContain("line one")

    // All module memory dies; localStorage is the only surviving state.
    // Abrupt process death: no stop/pagehide/settle callback runs.
    await new Promise((resolve) => setTimeout(resolve, 0))
    const sendsBeforeRestart = logSender.calls.filter(({ key }) => key === chunks[0]?.id).length
    resetGameLogOutboxForTests()
    expect(gameLogManifest(723).chunks).toHaveLength(1)
    delivery.mockResolvedValue(true)
    const stopAfterRestart = installGameLogOutbox()
    await vi.waitFor(() => expect(JSON.parse(localStorage.getItem(GAME_LOG_OUTBOX_KEY)!).chunkIds).toEqual([]))
    expect(gameLogManifest(723).chunks).toHaveLength(1)
    expect(logSender.calls.at(-1)?.key).toBe(chunks[0]?.id)
    expect(logSender.calls.filter(({ key }) => key === chunks[0]?.id).length).toBeGreaterThan(sendsBeforeRestart)
    stopAfterRestart()
    stopBeforeKill()
  })

  it("ships an opening role page live and recovers it after an abrupt kill", async () => {
    const stopBeforeKill = installGameLogOutbox()
    beginGameLogOutbox(843)
    const lineCount = ROLLING_CHECKPOINT_LINES + 7
    for (let index = 0; index < ROLLING_CHECKPOINT_LINES; index += 1) {
      devLog("role", `pre-kill-${index}`)
    }
    await vi.waitFor(() => expect(logSender.calls).toHaveLength(1), { timeout: 4_000 })
    for (let index = ROLLING_CHECKPOINT_LINES; index < lineCount; index += 1) {
      devLog("role", `pre-kill-${index}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(JSON.parse(localStorage.getItem(liveTailKeys()[0]!)!).lines).toHaveLength(7)

    // The process disappears: neither visibilitychange nor pagehide runs.
    stopBeforeKill()
    resetGameLogOutboxForTests()
    logSender.calls.length = 0
    delivery.mockResolvedValue(true)
    const stopAfterRestart = installGameLogOutbox()
    await vi.waitFor(() => expect(logSender.calls).toHaveLength(2))
    expect(logSender.calls.flatMap((call) => call.records).flatMap((record) => record.body.split("\n"))).toHaveLength(lineCount)
    await vi.waitFor(() => expect(JSON.parse(localStorage.getItem(GAME_LOG_OUTBOX_KEY)!).chunkIds).toEqual([]))
    expect(liveTailKeys()).toEqual([])
    stopAfterRestart()
  })

  it("keeps capture O(1) and seals a rolling chunk in a later task without rereading old chunks", async () => {
    const stop = installGameLogOutbox()
    beginGameLogOutbox(844)
    devLog("role", "old")
    const old = checkpointGameLog("handover")[0]!
    await new Promise((resolve) => setTimeout(resolve, 0))
    const writes = vi.spyOn(storage, "setItem")
    writes.mockClear()

    for (let index = 0; index < ROLLING_CHECKPOINT_LINES; index += 1) {
      devLog("role", `new-${index}`)
    }
    expect(writes).not.toHaveBeenCalled()
    await new Promise((resolve) => setTimeout(resolve, 300))

    expect(writes.mock.calls.map(([key]) => key)).not.toContain(
      `${GAME_LOG_CHUNK_KEY_PREFIX}${encodeURIComponent(old.id)}`,
    )
    expect(writes.mock.calls.filter(([key]) => key.startsWith(GAME_LOG_CHUNK_KEY_PREFIX))).toHaveLength(1)
    expect(gameLogManifest(844).chunks).toHaveLength(2)
    stop()
  })

  it("restores the current capture after recovering an older killed page", async () => {
    localStorage.setItem(`${GAME_LOG_ACTIVE_KEY}older-session`, JSON.stringify({
      gameIndex: 842, beginId: "older", seq: 1, sessionId: "older-session",
      account: "5Older", deviceId: "older-device",
      lines: [{ ts: 1, sessionId: "older-session", level: "info", tag: "role", message: "older-tail" }],
    }))
    beginGameLogOutbox(843)
    const stop = installGameLogOutbox()
    devLog("role", "current-page")
    await new Promise((resolve) => setTimeout(resolve, 300))
    checkpointGameLog("report")
    const lines = durableChunks().flat()
    expect(lines.map((line) => line.message)).toEqual(["older-tail", "current-page"])
    expect(lines.map((line) => line.sessionId)).toEqual(["older-session", expect.any(String)])
    stop()
  })

  it("recovers independent live tails for two killed pages", () => {
    for (const sessionId of ["page-a", "page-b"]) {
      localStorage.setItem(`${GAME_LOG_ACTIVE_KEY}${sessionId}`, JSON.stringify({
        gameIndex: 843, beginId: sessionId, seq: 1, sessionId,
        account: "5Alice", deviceId: `device-${sessionId}`,
        lines: [{ ts: 1, sessionId, lineId: `${sessionId}:1`, level: "info", tag: "role", message: sessionId }],
      }))
    }
    const stop = installGameLogOutbox()
    expect(durableChunks().flat().map((entry) => entry.message).sort()).toEqual(["page-a", "page-b"])
    expect(liveTailKeys()).toEqual([])
    stop()
  })

  it("keeps a killed page tail when sealing its recovery cannot write", () => {
    const key = `${GAME_LOG_ACTIVE_KEY}killed-page`
    localStorage.setItem(key, JSON.stringify({
      gameIndex: 843, beginId: "killed", seq: 1, sessionId: "killed-page",
      account: "5Alice", deviceId: "device-killed",
      lines: [{ ts: 1, sessionId: "killed-page", lineId: "killed-page:1", level: "info", tag: "role", message: "tail" }],
    }))
    const originalSet = storage.setItem.bind(storage)
    vi.spyOn(storage, "setItem").mockImplementation((writeKey, value) => {
      if (writeKey.startsWith(GAME_LOG_CHUNK_KEY_PREFIX)) throw new Error("quota")
      originalSet(writeKey, value)
    })
    const stop = installGameLogOutbox()
    expect(localStorage.getItem(key)).not.toBeNull()
    expect(storageFallbackDelivery.logEvent).toHaveBeenCalled()
    stop()
  })

  it("S6: rolling delivery stays lossless while every storage write fails", async () => {
    delivery.mockResolvedValue(true)
    const stop = installGameLogOutbox()
    beginGameLogOutbox(916)
    vi.spyOn(storage, "setItem").mockImplementation(() => { throw new Error("quota") })
    for (let batch = 0; batch < 5; batch += 1) {
      for (let index = 0; index < ROLLING_CHECKPOINT_LINES; index += 1) {
        devLog("role", `S6-${batch * ROLLING_CHECKPOINT_LINES + index}`)
      }
      await new Promise((resolve) => setTimeout(resolve, 300))
      devLog("role", `S6-K${batch}`)
      await new Promise((resolve) => setTimeout(resolve, 3_400))
    }
    settleGameLogOutbox(916)
    await drainGameLogOutbox(true)
    const keys = logSender.calls.map(({ key }) => key)
    const sent = logSender.calls.flatMap(({ records }) => records.flatMap((record) => record.body.split("\n")))
      .filter((row) => row.includes(" role: S6-"))
    expect(keys).toHaveLength(6)
    expect(new Set(keys)).toHaveLength(6)
    expect(sent).toHaveLength(255)
    expect(new Set(sent)).toHaveLength(255)
    stop()
  }, 60_000)

  it("S4: a failed rolling seal survives a later tail flush and reload", async () => {
    let stop = installGameLogOutbox()
    beginGameLogOutbox(851)
    const originalSet = storage.setItem.bind(storage)
    let failChunks = true
    vi.spyOn(storage, "setItem").mockImplementation((key, value) => {
      if (failChunks && key.startsWith(GAME_LOG_CHUNK_KEY_PREFIX)) throw new Error("quota")
      originalSet(key, value)
    })

    for (let index = 0; index < ROLLING_CHECKPOINT_LINES; index += 1) devLog("role", `kill-${index}`)
    await new Promise((resolve) => setTimeout(resolve, 300))
    failChunks = false
    devLog("role", "kill-next")
    await new Promise((resolve) => setTimeout(resolve, 300))

    stop()
    resetGameLogOutboxForTests()
    logSender.calls.length = 0
    delivery.mockResolvedValue(true)
    stop = installGameLogOutbox()
    await drainGameLogOutbox(true)
    const sent = logSender.calls.flatMap(({ records }) => records.flatMap((record) => record.body.split("\n")))
      .filter((row) => row.includes(" role: kill-"))
    expect(sent).toHaveLength(ROLLING_CHECKPOINT_LINES + 1)
    expect(new Set(sent).size).toBe(ROLLING_CHECKPOINT_LINES + 1)
    stop()
  })

  it("S3: a chunk-key failure with a writable tail cannot regenerate accepted evidence", async () => {
    let stop = installGameLogOutbox()
    beginGameLogOutbox(852)
    const originalSet = storage.setItem.bind(storage)
    let failChunks = false
    vi.spyOn(storage, "setItem").mockImplementation((key, value) => {
      if (failChunks && key.startsWith(GAME_LOG_CHUNK_KEY_PREFIX)) throw new Error("quota")
      originalSet(key, value)
    })
    for (let index = 0; index < 20; index += 1) devLog("role", `accepted-${index}`)
    await new Promise((resolve) => setTimeout(resolve, 300))
    failChunks = true
    delivery.mockResolvedValue(true)
    checkpointGameLog("payoff")
    failChunks = false
    await drainGameLogOutbox(true)
    settleGameLogOutbox(852)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(liveTailKeys()).toEqual([])

    stop()
    resetGameLogOutboxForTests()
    stop = installGameLogOutbox()
    await drainGameLogOutbox(true)
    const sent = logSender.calls.flatMap(({ records }) => records.flatMap((record) => record.body.split("\n")))
      .filter((row) => row.includes(" role: accepted-"))
    expect(sent).toHaveLength(20)
    expect(new Set(logSender.calls.map(({ key }) => key))).toHaveLength(logSender.calls.length)
    stop()
  })

  it("S1: a whole game remains deliverable when all storage writes fail", async () => {
    const stop = installGameLogOutbox()
    beginGameLogOutbox(855)
    vi.spyOn(storage, "setItem").mockImplementation(() => { throw new Error("quota") })
    delivery.mockResolvedValue(true)

    for (let index = 0; index < 300; index += 1) {
      devLog("role", `S1-${index}`)
      if (index % ROLLING_CHECKPOINT_LINES === ROLLING_CHECKPOINT_LINES - 1) {
        await new Promise((resolve) => setTimeout(resolve, 300))
      }
    }
    devLog("role", "S1-tail")
    settleGameLogOutbox(855)
    await drainGameLogOutbox(true)

    const sentKeys = logSender.calls.map(({ key }) => key)
    const sent = logSender.calls.flatMap(({ records }) => records.flatMap((record) => record.body.split("\n")))
      .filter((row) => row.includes(" role: S1-"))
    expect(sentKeys).toHaveLength(7)
    expect(new Set(sentKeys)).toHaveLength(7)
    expect(sent).toHaveLength(301)
    expect(new Set(sent)).toHaveLength(301)
    await drainGameLogOutbox(true)
    await drainGameLogOutbox(true)
    expect(logSender.calls.map(({ key }) => key)).toEqual(sentKeys)
    stop()
  })

  it("S7: partial acceptance followed by reload never reuses an accepted sequence", async () => {
    let stop = installGameLogOutbox()
    beginGameLogOutbox(856)
    for (let index = 0; index < 30; index += 1) devLog("role", `stale-${index}`)
    await new Promise((resolve) => setTimeout(resolve, 300))

    const writes = vi.spyOn(storage, "setItem").mockImplementation(() => { throw new Error("quota") })
    for (let index = 30; index < 100; index += 1) devLog("role", `stale-${index}`)
    const [accepted] = checkpointGameLog("rolling")
    for (let index = 100; index < 160; index += 1) devLog("role", `stale-${index}`)
    const [pending] = checkpointGameLog("rolling")
    let attempt = 0
    delivery.mockImplementation(async () => attempt++ === 0)
    await drainGameLogOutbox(true)
    expect(logSender.calls.map(({ key }) => key)).toEqual([accepted!.id, pending!.id])
    expect(gameLogManifest(856).chunks.map(({ id, status }) => ({ id, status }))).toEqual([
      { id: accepted!.id, status: "delivered" },
      { id: pending!.id, status: "pending" },
    ])
    expect(liveTailKeys()).toEqual([])

    writes.mockRestore()
    stop()
    resetGameLogOutboxForTests()
    stop = installGameLogOutbox()
    delivery.mockResolvedValue(true)
    await drainGameLogOutbox(true)
    expect(logSender.calls.map(({ key }) => key)).toEqual([accepted!.id, pending!.id])
    expect(new Set(logSender.calls.map(({ key }) => key))).toHaveLength(2)
    stop()
  })

  it("S10: a mixed tail cleanup failure cannot resend an accepted chunk", async () => {
    const stop = installGameLogOutbox()
    beginGameLogOutbox(858)
    const originalSet = storage.setItem.bind(storage)
    let failTail = false
    vi.spyOn(storage, "setItem").mockImplementation((key, value) => {
      if (key.startsWith(GAME_LOG_CHUNK_KEY_PREFIX)
        || (failTail && key.startsWith(GAME_LOG_ACTIVE_KEY))) throw new Error("quota")
      originalSet(key, value)
    })
    for (let index = 0; index < ROLLING_CHECKPOINT_LINES; index += 1) {
      devLog("role", `mixed-${index}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 300))
    devLog("role", "mixed-pending")
    await new Promise((resolve) => setTimeout(resolve, 300))
    failTail = true
    delivery.mockResolvedValue(true)
    vi.useFakeTimers()
    try {
      void drainGameLogOutbox()
      await vi.advanceTimersByTimeAsync(120_000)
      expect(logSender.calls).toHaveLength(1)
      expect(new Set(logSender.calls.map(({ key }) => key))).toHaveLength(1)
      checkpointGameLog("hidden")
      await vi.advanceTimersByTimeAsync(0)
      await drainGameLogOutbox(true)
      await vi.advanceTimersByTimeAsync(30_000)
      expect(logSender.calls).toHaveLength(2)
      expect(new Set(logSender.calls.map(({ key }) => key))).toHaveLength(2)
      expect(gameLogManifest(858).chunks.every(({ status }) => status === "delivered")).toBe(true)
    } finally {
      vi.useRealTimers()
      stop()
    }
  })

  it("S8: an inaccessible localStorage cannot resend accepted rolling chunks", async () => {
    delivery.mockResolvedValue(true)
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() { throw new DOMException("Storage disabled", "SecurityError") },
    })
    const stop = installGameLogOutbox()
    beginGameLogOutbox(918)
    for (let batch = 0; batch < 4; batch += 1) {
      for (let index = 0; index < ROLLING_CHECKPOINT_LINES; index += 1) {
        devLog("role", `S8-${batch * ROLLING_CHECKPOINT_LINES + index}`)
      }
      await new Promise((resolve) => setTimeout(resolve, 300))
      devLog("role", `S8-V${batch}`)
      await new Promise((resolve) => setTimeout(resolve, 3_400))
    }
    settleGameLogOutbox(918)
    await drainGameLogOutbox(true)
    const sent = logSender.calls.flatMap(({ records }) => records.flatMap((record) => record.body.split("\n")))
      .filter((row) => row.includes(" role: S8-"))
    expect(logSender.calls).toHaveLength(5)
    expect(new Set(logSender.calls.map(({ key }) => key))).toHaveLength(5)
    expect(sent).toHaveLength(204)
    expect(new Set(sent)).toHaveLength(204)
    await drainGameLogOutbox(true)
    await drainGameLogOutbox(true)
    expect(logSender.calls).toHaveLength(5)
    stop()
  }, 60_000)

  it("drain race: keeps each item in flight until a concurrent drain commits its result", async () => {
    const stop = installGameLogOutbox()
    beginGameLogOutbox(853)
    for (let index = 0; index < 7 * ROLLING_CHECKPOINT_LINES; index += 1) {
      devLog("role", `race-${index}`)
      if (index % ROLLING_CHECKPOINT_LINES === ROLLING_CHECKPOINT_LINES - 1) {
        await new Promise((resolve) => setTimeout(resolve, 300))
      }
    }
    delivery.mockResolvedValue(true)
    logSender.calls.length = 0

    await Promise.all([drainGameLogOutbox(), drainGameLogOutbox(true)])

    expect(logSender.calls.map(({ key }) => key)).toHaveLength(7)
    expect(new Set(logSender.calls.map(({ key }) => key))).toHaveLength(7)
    stop()
  })

  it("S5: a large active tail remains recoverable under ceiling pressure", async () => {
    const stop = installGameLogOutbox()
    beginGameLogOutbox(846)
    for (let index = 0; index < 40; index += 1) devLog("quota", `${index}:${"x".repeat(10_000)}`)
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(checkpointGameLog("report").length).toBeGreaterThan(0)
    expect(liveTailKeys()).toEqual([])

    devLog("quota", `active:${"y".repeat(700_000)}`)
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(liveTailKeys()).toHaveLength(1)
    const durable = JSON.parse(localStorage.getItem(GAME_LOG_OUTBOX_KEY)!) as { evicted: Array<{ id: string }> }
    expect(durable.evicted.length).toBeGreaterThan(0)
    const durableSize = [...storage.values.entries()].reduce((sum, [key, value]) => sum + (key.length + value.length) * 2, 0)
    expect(durableSize).toBeLessThanOrEqual(GAME_LOG_OUTBOX_MAX_BYTES)
    stop()
  })

  it("S5 reviewer scenario: recovers a 700-line tail under a near-full evidence ceiling", async () => {
    let stop = installGameLogOutbox()
    beginGameLogOutbox(915)
    for (let index = 0; index < 1_500; index += 1) {
      devLog("role", `S5-E${index}:${"e".repeat(500)}`)
      if (index % ROLLING_CHECKPOINT_LINES === ROLLING_CHECKPOINT_LINES - 1) {
        await new Promise((resolve) => setTimeout(resolve, 300))
      }
    }
    const write = storage.setItem.bind(storage)
    let failChunks = true
    vi.spyOn(storage, "setItem").mockImplementation((key, value) => {
      if (failChunks && key.startsWith(GAME_LOG_CHUNK_KEY_PREFIX)) throw new Error("quota")
      write(key, value)
    })
    for (let index = 0; index < 700; index += 1) {
      devLog("role", `S5-F${index}:${"f".repeat(1_000)}`)
      if (index % ROLLING_CHECKPOINT_LINES === ROLLING_CHECKPOINT_LINES - 1) {
        await new Promise((resolve) => setTimeout(resolve, 300))
      }
    }
    stop()
    resetGameLogOutboxForTests()
    stop = installGameLogOutbox()
    failChunks = false
    stop()
    resetGameLogOutboxForTests()
    stop = installGameLogOutbox()
    beginGameLogOutbox(915)
    devLog("role", "S5-Gafter")
    checkpointGameLog("hidden")
    logSender.calls.length = 0
    delivery.mockResolvedValue(true)
    await drainGameLogOutbox(true)

    const keys = logSender.calls.map(({ key }) => key)
    const rows = logSender.calls.flatMap(({ records }) => records.flatMap((record) => record.body.split("\n")))
      .filter((row) => row.includes(" role: S5-"))
    expect(keys.length).toBeGreaterThan(0)
    expect(new Set(keys)).toHaveLength(keys.length)
    expect(new Set(rows)).toHaveLength(rows.length)
    const durableSize = [...storage.values.entries()]
      .reduce((sum, [key, value]) => sum + (key.length + value.length) * 2, 0)
    expect(durableSize).toBeLessThanOrEqual(GAME_LOG_OUTBOX_MAX_BYTES)
    stop()
  }, 120_000)

  it("debounces rolling delivery and commits accepted chunks without rereading survivors", async () => {
    vi.useFakeTimers()
    try {
      const stop = installGameLogOutbox()
      beginGameLogOutbox(847)
      await vi.advanceTimersByTimeAsync(0)
      logSender.calls.length = 0
      for (let index = 0; index < ROLLING_CHECKPOINT_LINES; index += 1) devLog("role", `rolling-${index}`)
      await vi.advanceTimersByTimeAsync(300)
      expect(gameLogManifest(847).chunks).toHaveLength(1)
      expect(logSender.calls).toHaveLength(0)
      await vi.advanceTimersByTimeAsync(2_500)
      expect(logSender.calls).toHaveLength(0)
      delivery.mockResolvedValue(true)
      const reads = vi.spyOn(storage, "getItem")
      reads.mockClear()
      await vi.advanceTimersByTimeAsync(500)
      expect(logSender.calls).toHaveLength(1)
      const id = logSender.calls[0]!.key
      expect(reads.mock.calls.filter(([key]) => key === `${GAME_LOG_CHUNK_KEY_PREFIX}${encodeURIComponent(id)}`).length).toBeLessThanOrEqual(3)
      expect(JSON.parse(localStorage.getItem(GAME_LOG_OUTBOX_KEY)!).chunkIds).toEqual([])
      stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it("protects a recovered tail when installation precedes beginning the game", async () => {
    const stopSeed = installGameLogOutbox()
    beginGameLogOutbox(900)
    for (let index = 0; index < 80; index += 1) devLog("old", `${index}:${"o".repeat(10_000)}`)
    checkpointGameLog("report")
    stopSeed()
    resetGameLogOutboxForTests()
    localStorage.setItem(`${GAME_LOG_ACTIVE_KEY}killed-843`, JSON.stringify({
      gameIndex: 843, beginId: "killed", seq: 1, sessionId: "killed-843",
      account: "5Alice", deviceId: "device-killed",
      lines: Array.from({ length: 30 }, (_, index) => ({
        ts: index, sessionId: "killed-843", lineId: `killed-843:${index}`,
        level: "info", tag: "role", message: `${index}:${"r".repeat(10_000)}`,
      })),
    }))

    const stop = installGameLogOutbox()
    beginGameLogOutbox(843)
    expect(liveTailKeys()).toEqual([])
    expect(gameLogManifest(843).chunks.length).toBeGreaterThan(0)
    expect(durableChunks().flat().some((entry) => entry.sessionId === "killed-843")).toBe(true)
    stop()
  })

  it("keeps every seeded-fault chunk until a later confirmed retry", async () => {
    const stop = installGameLogOutbox()
    beginGameLogOutbox(9)
    let seed = 0x723
    const random = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 0x1_0000_0000)
    const expected: string[] = []
    const deliveredIds = new Set<string>()
    for (let index = 0; index < 32; index += 1) {
      const message = `seeded-${index}`
      expected.push(message)
      devLog("fuzz", message)
      delivery.mockImplementationOnce(async () => {
        const accepted = random() > 0.7
        await Promise.resolve()
        if (accepted) deliveredIds.add(logSender.calls.at(-1)!.key)
        return accepted
      })
      checkpointGameLog("round-1", index)
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    stop()

    // Network recovery / next open: retry until every persisted chunk lands.
    delivery.mockImplementation(async () => {
      await Promise.resolve()
      deliveredIds.add(logSender.calls.at(-1)!.key)
      return true
    })
    await drainGameLogOutbox()
    const delivered = gameLogManifest(9).chunks
    expect(delivered).toHaveLength(32)
    const payload = logSender.calls.flatMap(({ records }) => records.map((record) => record.body)).join("\n")
    for (const message of expected) expect(payload).toContain(message)
    expect(deliveredIds.size).toBe(32)
    expect(JSON.parse(localStorage.getItem(GAME_LOG_OUTBOX_KEY)!).chunkIds).toEqual([])
  })

  it("never deletes an undelivered chunk when the full log succeeds", async () => {
    const stop = installGameLogOutbox()
    beginGameLogOutbox(12)
    devLog("test", "only copy from an earlier session")
    checkpointGameLog("report")
    await new Promise((resolve) => setTimeout(resolve, 0))
    settleGameLogOutbox(12)
    expect(gameLogManifest(12).chunks).toEqual([expect.objectContaining({ status: "pending" })])

    delivery.mockResolvedValue(true)
    await drainGameLogOutbox()
    expect(gameLogManifest(12).chunks).toEqual([])
    stop()
  })

  it("checkpoints lines written after payoff before settling the game", async () => {
    const stop = installGameLogOutbox()
    beginGameLogOutbox(120)
    devLog("test", "after payoff")
    settleGameLogOutbox(120)
    expect(gameLogManifest(120).chunks).toEqual([
      expect.objectContaining({ checkpoint: "flush", status: "pending" }),
    ])
    expect(durableChunks()[0]![0]!.message).toBe("after payoff")
    stop()
  })

  it("hands every pending chunk to delivery concurrently on pagehide", async () => {
    const stop = installGameLogOutbox()
    beginGameLogOutbox(121)
    for (let index = 0; index < 3; index += 1) {
      devLog("test", `pending-${index}`)
      checkpointGameLog("round-1")
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    delivery.mockClear()
    delivery.mockImplementation(() => new Promise(() => {}))
    window.dispatchEvent(new Event("pagehide"))
    await vi.waitFor(() => expect(delivery).toHaveBeenCalledTimes(3))
    stop()
  })

  it("attributes a reopened drain from the chunk before global Sentry user setup", async () => {
    const stop = installGameLogOutbox()
    setGameLogOutboxAccount("5Alice")
    beginGameLogOutbox(13)
    devLog("test", "attributed before reopen")
    checkpointGameLog("hidden")
    await new Promise((resolve) => setTimeout(resolve, 0))

    stop()
    resetGameLogOutboxForTests()
    delivery.mockResolvedValue(true)
    await drainGameLogOutbox()
    expect(logSender.calls.at(-1)!.records[0]!.attributes["user.id"]).toEqual({ type: "string", value: "5Alice" })
  })

  it("persists an account backfill into an already durable chunk", async () => {
    const stop = installGameLogOutbox()
    beginGameLogOutbox(131)
    devLog("test", "captured before account")
    checkpointGameLog("hidden")
    await new Promise((resolve) => setTimeout(resolve, 0))
    setGameLogOutboxAccount("5Backfilled")

    stop()
    resetGameLogOutboxForTests()
    delivery.mockResolvedValue(true)
    await drainGameLogOutbox()
    expect(logSender.calls.at(-1)!.records[0]!.attributes["user.id"]).toEqual({ type: "string", value: "5Backfilled" })
  })

  it("uses a fresh chunk identity when the same game begins again", () => {
    const stop = installGameLogOutbox()
    beginGameLogOutbox(132)
    devLog("test", "first begin")
    const first = checkpointGameLog("report")[0]!
    settleGameLogOutbox(132)
    beginGameLogOutbox(132)
    devLog("test", "second begin")
    const second = checkpointGameLog("report")[0]!
    expect(second.id).not.toBe(first.id)
    stop()
  })

  it("survives throw, offline rejection, a hung drain, and a killed page", async () => {
    const stop = installGameLogOutbox()
    beginGameLogOutbox(14)

    delivery.mockRejectedValueOnce(new Error("transport threw"))
    devLog("fault", "throw")
    checkpointGameLog("round-1")
    await new Promise((resolve) => setTimeout(resolve, 0))

    delivery.mockResolvedValueOnce(false)
    devLog("fault", "offline-or-429")
    checkpointGameLog("report")
    await new Promise((resolve) => setTimeout(resolve, 0))

    delivery.mockImplementationOnce(() => new Promise(() => {}))
    devLog("fault", "hung-mid-drain")
    checkpointGameLog("payoff")
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(JSON.parse(localStorage.getItem(GAME_LOG_OUTBOX_KEY)!).chunkIds).toHaveLength(3)

    // Kill: module memory and promises disappear; localStorage survives.
    stop()
    resetGameLogOutboxForTests()
    const deliveredIds = new Set<string>()
    delivery.mockImplementation(async () => {
      await Promise.resolve()
      deliveredIds.add(logSender.calls.at(-1)!.key)
      return true
    })
    await drainGameLogOutbox()
    expect(deliveredIds.size).toBe(3)
    expect(JSON.parse(localStorage.getItem(GAME_LOG_OUTBOX_KEY)!).chunkIds).toEqual([])
  })

  it("S5b: reports storage fallback while retaining the live tail once", () => {
    const originalSet = storage.setItem.bind(storage)
    let failing = true
    const setItem = vi.spyOn(storage, "setItem").mockImplementation((key, value) => {
      if (failing) throw new Error("QuotaExceededError")
      originalSet(key, value)
    })
    const stop = installGameLogOutbox()
    beginGameLogOutbox(10)
    devLog("test", "held in memory")
    expect(checkpointGameLog("hidden")).toHaveLength(1)
    expect(gameLogManifest(10).chunks).toHaveLength(1)
    expect(sentry.events).toEqual([])
    expect(storageFallbackDelivery.logEvent).toHaveBeenCalledWith(
      "game-log-outbox-storage-fallback",
      "info",
      expect.objectContaining({
        "game_log.storage": "full",
        "game_log.pending_chunks": expect.any(Number),
        "game_log.pending_full_parts": 0,
        "game_log.memory_only_chunk_ids": expect.any(String),
        "game_log.shed_chunk_ids": "",
        "game_log.shed_game_indexes": "",
      }),
    )
    failing = false
    expect(gameLogManifest(10).chunks[0]?.status).toBe("pending")
    expect(storageFallbackDelivery.recordCount).toHaveBeenCalledWith(
      "game_log.storage_fallback",
      1,
      { "game_log.storage": "full" },
    )
    stop()
    setItem.mockRestore()
  })

  it("delivers a non-durable in-memory chunk when every storage write fails", async () => {
    delivery.mockResolvedValue(true)
    const stop = installGameLogOutbox()
    beginGameLogOutbox(849)
    vi.spyOn(storage, "setItem").mockImplementation(() => { throw new Error("quota") })

    for (let index = 0; index < ROLLING_CHECKPOINT_LINES; index += 1) {
      devLog("role", `volatile-${index}`)
    }
    const chunks = checkpointGameLog("flush")
    settleGameLogOutbox(849)
    await drainGameLogOutbox(true)

    expect(chunks).toHaveLength(1)
    const delivered = logSender.calls.flatMap(({ records }) => records.flatMap((record) => record.body.split("\n")))
      .filter((row) => row.includes(" role: volatile-"))
    expect(delivered).toHaveLength(ROLLING_CHECKPOINT_LINES)
    expect(new Set(delivered).size).toBe(ROLLING_CHECKPOINT_LINES)
    stop()
  })

  it("seals an oversized live tail in bounded chunks without reusing terminal ids", async () => {
    const stop = installGameLogOutbox()
    beginGameLogOutbox(850)
    for (let index = 0; index < ROLLING_CHECKPOINT_LINES - 1; index += 1) {
      devLog("quota", `${index}:${"x".repeat(14_000)}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(liveTailKeys()).toHaveLength(1)

    const chunks = checkpointGameLog("hidden")
    const ids = chunks.map((chunk) => chunk.id)
    expect(chunks.flatMap((chunk) => chunk.lines)).toHaveLength(ROLLING_CHECKPOINT_LINES - 1)
    expect(new Set(ids).size).toBe(ids.length)
    expect(liveTailKeys()).toEqual([])
    expect([...storage.values.entries()].reduce((sum, [key, value]) => sum + (key.length + value.length) * 2, 0))
      .toBeLessThanOrEqual(GAME_LOG_OUTBOX_MAX_BYTES)
    resetGameLogOutboxForTests()
    const reopened = gameLogManifest(850).chunks.filter((chunk) => chunk.status === "pending")
    expect(reopened.map((chunk) => chunk.id)).toEqual(ids)
    expect([...storage.values.keys()].filter((key) => key.startsWith(GAME_LOG_CHUNK_KEY_PREFIX))).toHaveLength(ids.length)
    stop()
  })

  it("does not let a stale terminal record delete an indexed live chunk", () => {
    const stop = installGameLogOutbox()
    beginGameLogOutbox(852)
    devLog("quota", "still-live")
    const chunk = checkpointGameLog("round-1")[0]!
    const index = JSON.parse(localStorage.getItem(GAME_LOG_OUTBOX_KEY)!) as {
      chunkIds: string[]
      evicted: Array<{ id: string; gameIndex: number }>
    }
    index.evicted.push({ id: chunk.id, gameIndex: chunk.gameIndex })
    localStorage.setItem(GAME_LOG_OUTBOX_KEY, JSON.stringify(index))

    resetGameLogOutboxForTests()
    expect(gameLogManifest(852).chunks).toEqual([expect.objectContaining({ id: chunk.id, status: "pending" })])
    expect(localStorage.getItem(`${GAME_LOG_CHUNK_KEY_PREFIX}${encodeURIComponent(chunk.id)}`)).not.toBeNull()
    stop()
  })

  it("persists an active tail from cached bytes without rescanning the outbox", async () => {
    const stop = installGameLogOutbox()
    beginGameLogOutbox(851)
    devLog("quota", "prime")
    checkpointGameLog("round-1")
    await new Promise((resolve) => setTimeout(resolve, 0))
    const keys = vi.spyOn(storage, "key")
    keys.mockClear()

    devLog("quota", "cached-tail")
    await new Promise((resolve) => setTimeout(resolve, 300))

    expect(keys).not.toHaveBeenCalled()
    expect(JSON.parse(localStorage.getItem(liveTailKeys()[0]!)!).lines[0].message).toBe("cached-tail")
    stop()
  })

  it("keeps cached durable bytes after a failed chunk write", async () => {
    const stop = installGameLogOutbox()
    beginGameLogOutbox(854)
    const originalSet = storage.setItem.bind(storage)
    vi.spyOn(storage, "setItem").mockImplementation((key, value) => {
      if (key.startsWith(GAME_LOG_CHUNK_KEY_PREFIX)) throw new Error("quota")
      originalSet(key, value)
    })
    for (let index = 0; index < ROLLING_CHECKPOINT_LINES; index += 1) devLog("quota", `dirty-${index}`)
    await new Promise((resolve) => setTimeout(resolve, 300))

    const keys = vi.spyOn(storage, "key")
    keys.mockClear()
    for (let index = 0; index < 3; index += 1) {
      devLog("quota", `tail-${index}`)
      await new Promise((resolve) => setTimeout(resolve, 300))
    }

    expect(keys).not.toHaveBeenCalled()
    const tail = JSON.parse(localStorage.getItem(liveTailKeys()[0]!)!) as { lines: GameLogChunkLine[] }
    expect(tail.lines).toHaveLength(ROLLING_CHECKPOINT_LINES + 3)
    stop()
  })

  it("stops new durable writes at the outbox ceiling without deleting existing chunks", async () => {
    const stop = installGameLogOutbox()
    beginGameLogOutbox(101)
    const originalSet = storage.setItem.bind(storage)
    let chunkBytes = 0
    vi.spyOn(storage, "setItem").mockImplementation((key, value) => {
      if (key.startsWith(GAME_LOG_CHUNK_KEY_PREFIX)) {
        const next = new TextEncoder().encode(value).byteLength
        if (chunkBytes + next > GAME_LOG_OUTBOX_MAX_BYTES / 32) throw new Error("QuotaExceededError")
        chunkBytes += next
      }
      originalSet(key, value)
    })
    for (let index = 0; index < 4; index += 1) {
      devLog("quota", `${index}:${"x".repeat(20_000)}`)
      checkpointGameLog("round-1")
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    const durable = JSON.parse(localStorage.getItem(GAME_LOG_OUTBOX_KEY)!) as {
      chunkIds: string[]
      evicted: Array<{ id: string; gameIndex: number }>
    }
    expect(durable.chunkIds.length).toBeGreaterThan(0)
    expect(gameLogManifest(101).chunks.length).toBeGreaterThanOrEqual(durable.chunkIds.length)
    // Memory-only chunks keep their source lines in the durable tail until
    // either chunk persistence or Sentry acceptance resolves them.
    expect(liveTailKeys()).toHaveLength(1)
    const terminalIds = new Set(durable.evicted.map((item) => item.id))
    devLog("quota", "new identity after eviction")
    const [next] = checkpointGameLog("round-1")
    expect(next).toBeDefined()
    expect(terminalIds.has(next!.id)).toBe(false)
    expect(sentry.events).toEqual([])
    expect(storageFallbackDelivery.logEvent).toHaveBeenCalledWith(
      "game-log-outbox-storage-fallback",
      "info",
      expect.objectContaining({
        "game_log.storage": "full",
        "game_log.memory_only_chunk_ids": expect.any(String),
        "game_log.shed_chunk_ids": "",
      }),
    )
    stop()
  })

  it("rolls back newly written chunk keys when the index write fails", async () => {
    const stop = installGameLogOutbox()
    beginGameLogOutbox(102)
    devLog("quota", "durable first")
    checkpointGameLog("round-1")
    await new Promise((resolve) => setTimeout(resolve, 0))
    const before = JSON.parse(localStorage.getItem(GAME_LOG_OUTBOX_KEY)!) as { chunkIds: string[] }

    const originalSet = storage.setItem.bind(storage)
    let failIndex = true
    vi.spyOn(storage, "setItem").mockImplementation((key, value) => {
      if (key === GAME_LOG_OUTBOX_KEY && failIndex) {
        failIndex = false
        throw new Error("index full")
      }
      originalSet(key, value)
    })
    devLog("quota", "memory only second")
    expect(checkpointGameLog("round-1")).toHaveLength(1)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(JSON.parse(localStorage.getItem(GAME_LOG_OUTBOX_KEY)!).chunkIds).toEqual(before.chunkIds)
    expect([...storage.values.keys()].filter((key) => key.startsWith(GAME_LOG_CHUNK_KEY_PREFIX))).toHaveLength(1)
    expect(gameLogManifest(102).chunks).toHaveLength(2)
    expect(gameLogManifest(102).chunks.map((chunk) => chunk.seq)).toEqual([1, 2])
    stop()
  })

  it("re-indexes a durable chunk orphaned by a page kill before the index write", async () => {
    const stop = installGameLogOutbox()
    beginGameLogOutbox(102)
    devLog("quota", "indexed")
    const indexed = checkpointGameLog("round-1")[0]!
    await new Promise((resolve) => setTimeout(resolve, 0))
    const orphan = { ...indexed, id: `${indexed.id}-orphan`, beginId: `${indexed.beginId}-orphan`, seq: indexed.seq + 1 }
    localStorage.setItem(`${GAME_LOG_CHUNK_KEY_PREFIX}${encodeURIComponent(orphan.id)}`, JSON.stringify(orphan))

    stop()
    resetGameLogOutboxForTests()
    expect(gameLogManifest(102).chunks).toHaveLength(2)
    expect(JSON.parse(localStorage.getItem(GAME_LOG_OUTBOX_KEY)!).chunkIds).toContain(orphan.id)
  })

  it("evicts oldest games first, enforces the hard ceiling for the current game, and reports the forced eviction on the next delivery", async () => {
    const stop = installGameLogOutbox()
    const ids = new Map<number, string[]>()
    for (const gameIndex of [101, 102, 103]) {
      beginGameLogOutbox(gameIndex)
      const gameIds: string[] = []
      const chunkCount = gameIndex === 103 ? 50 : 10
      for (let index = 0; index < chunkCount; index += 1) {
        devLog("quota", `${gameIndex}:${index}:${"x".repeat(44_000)}`)
        gameIds.push(checkpointGameLog("round-1")[0]!.id)
        await new Promise((resolve) => setTimeout(resolve, 0))
      }
      ids.set(gameIndex, gameIds)
      if (gameIndex !== 103) settleGameLogOutbox(gameIndex)
    }
    const durable = JSON.parse(localStorage.getItem(GAME_LOG_OUTBOX_KEY)!) as {
      chunkIds: string[]
      evicted: Array<{ id: string; gameIndex: number }>
    }
    expect(durable.chunkIds.length).toBeLessThan(ids.get(103)!.length)
    const durableBytes = [...storage.values.entries()].reduce((sum, [key, value]) => sum + (key.length + value.length) * 2, 0)
    expect(durableBytes).toBeLessThanOrEqual(GAME_LOG_OUTBOX_MAX_BYTES)
    expect(durable.chunkIds).not.toContain(ids.get(101)![0])
    expect(durable.chunkIds).not.toContain(ids.get(102)!.at(-1))
    expect([...new Set(durable.evicted.map((item) => item.gameIndex))]).toEqual([101, 102, 103])
    expect(gameLogManifest(103).chunks.length).toBeLessThan(50)
    expect(sentry.events).toEqual([])
    const shedGameIndexes = storageFallbackDelivery.logEvent.mock.calls
      .flatMap(([, , attrs]) => String(attrs["game_log.shed_game_indexes"] ?? "").split(","))
      .filter(Boolean)
      .map(Number)
    expect(shedGameIndexes.length).toBeGreaterThan(0)
    expect(new Set(shedGameIndexes)).toEqual(new Set([101, 102, 103]))
    logSender.calls.length = 0
    delivery.mockResolvedValue(true)
    await drainGameLogOutbox()
    expect(logSender.calls.flatMap(({ records }) => records.map((record) => record.body)).join("\n")).toContain("game-log.evicted: evictedOnDevice")
    expect(logSender.calls.flatMap(({ records }) => records.map((record) => record.body)).join("\n")).toContain("\"gameIndex\":101")
    // The current game's newest chunk was evicted by the checkpoint that
    // created it, so no earlier payload carried it. It must survive until a
    // payload does, rather than be cleared as if it had been reported.
    const retained = (JSON.parse(localStorage.getItem(GAME_LOG_OUTBOX_KEY)!) as {
      evicted: Array<{ id: string; gameIndex: number }>
    }).evicted
    expect(retained.map((item) => item.gameIndex)).toEqual([103])
    // The next new item carries it.
    logSender.calls.length = 0
    beginGameLogOutbox(104)
    devLog("quota", "carrier")
    checkpointGameLog("round-1")
    await drainGameLogOutbox()
    const carried = logSender.calls.flatMap(({ records }) => records.map((record) => record.body)).join("\n")
    expect(carried).toContain(`"id":"${retained[0]!.id}"`)
    stop()
  }, 10_000)

  it("keeps an eviction recorded while a delivery was in flight, then carries it", async () => {
    const stop = installGameLogOutbox()
    // One gate for every delivery, so a drain started by the fill below cannot
    // wait on a promise nobody releases. It opens after the evictions are in.
    let release!: () => void
    const gate = new Promise<boolean>((resolve) => { release = () => resolve(true) })
    delivery.mockImplementation(() => gate)

    beginGameLogOutbox(101)
    devLog("quota", "in flight")
    const frozenId = checkpointGameLog("round-1")[0]!.id
    settleGameLogOutbox(101)

    // The first delivery stays unresolved, so the item is frozen with the
    // eviction list as it stands now: no evictions yet.
    const inflight = drainGameLogOutbox()
    await vi.waitFor(() => expect(delivery).toHaveBeenCalled())
    expect(JSON.parse(localStorage.getItem(`${GAME_LOG_CHUNK_KEY_PREFIX}${encodeURIComponent(frozenId)}`)!).evictedOnDevice).toEqual([])

    // While it is in flight, older games are checkpointed until the byte
    // budget evicts real chunks. Those records are what must not be lost.
    const evictedGames = [102, 103]
    for (const gameIndex of evictedGames) {
      beginGameLogOutbox(gameIndex)
      for (let index = 0; index < 20; index += 1) {
        devLog("quota", `${gameIndex}:${index}:${"x".repeat(44_000)}`)
        checkpointGameLog("round-1")
        await new Promise((resolve) => setTimeout(resolve, 0))
      }
      settleGameLogOutbox(gameIndex)
    }
    const recorded = (JSON.parse(localStorage.getItem(GAME_LOG_OUTBOX_KEY)!) as {
      evicted: Array<{ id: string; gameIndex: number }>
    }).evicted
    // Positive control: the harness really did evict mid-flight.
    expect(recorded.length).toBeGreaterThan(0)
    expect(new Set(recorded.map((item) => item.gameIndex))).toContain(102)

    release()
    await inflight
    delivery.mockResolvedValue(true)

    // The in-flight payload was frozen without these records, so its commit
    // cannot have reported them. Each one must still be on the device, or
    // have been carried by another payload that did report it.
    const carriedSoFar = logSender.calls.flatMap(({ records }) => records.map((record) => record.body)).join("\n")
    const stillRecorded = new Set(storedEvictedIds())
    for (const item of recorded) {
      expect(stillRecorded.has(item.id) || carriedSoFar.includes(`"id":"${item.id}"`)).toBe(true)
    }

    // The next new item is what carries what is left, then it is cleared.
    logSender.calls.length = 0
    beginGameLogOutbox(104)
    devLog("quota", "carrier")
    checkpointGameLog("round-1")
    await drainGameLogOutbox()
    const bodies = logSender.calls.flatMap(({ records }) => records.map((record) => record.body)).join("\n")
    for (const item of recorded.filter((record) => stillRecorded.has(record.id))) {
      expect(bodies).toContain(`"id":"${item.id}"`)
    }
    expect(JSON.parse(localStorage.getItem(GAME_LOG_OUTBOX_KEY)!).evicted).toEqual([])
    stop()
  }, 10_000)

  it("retries persisted chunks on online and visible lifecycle edges", async () => {
    const stop = installGameLogOutbox()
    beginGameLogOutbox(11)
    devLog("test", "retry me")
    checkpointGameLog("handover")
    await vi.waitFor(() => expect(delivery).toHaveBeenCalled())
    await new Promise((resolve) => setTimeout(resolve, 0))
    delivery.mockClear()
    window.dispatchEvent(new Event("online"))
    await vi.waitFor(() => expect(delivery).toHaveBeenCalled())
    await new Promise((resolve) => setTimeout(resolve, 0))
    delivery.mockClear()
    document.dispatchEvent(new Event("visibilitychange"))
    await vi.waitFor(() => expect(delivery).toHaveBeenCalled())
    stop()
  })

  it("checkpoints the old game's tail before a new game replaces the collector", async () => {
    const stop = installGameLogOutbox()
    beginGameLogOutbox(20)
    devLog("test", "old game tail")
    beginGameLogOutbox(21)
    expect(gameLogManifest(20).chunks).toEqual([expect.objectContaining({ checkpoint: "handover", status: "pending" })])
    stop()
  })

  it("S2: a persisted tail followed by total write failure is accepted once across reload", async () => {
    delivery.mockResolvedValue(true)
    let stop = installGameLogOutbox()
    beginGameLogOutbox(912)
    for (let index = 0; index < 30; index += 1) devLog("role", `S2-${index}`)
    await new Promise((resolve) => setTimeout(resolve, 300))
    const write = storage.setItem.bind(storage)
    const failedWrites = vi.spyOn(storage, "setItem").mockImplementation(() => { throw new Error("quota") })
    for (let index = 30; index < 100; index += 1) devLog("role", `S2-${index}`)
    settleGameLogOutbox(912)
    await drainGameLogOutbox(true)
    failedWrites.mockImplementation(write)
    stop()
    resetGameLogOutboxForTests()
    stop = installGameLogOutbox()
    await drainGameLogOutbox(true)

    const keys = logSender.calls.map(({ key }) => key)
    const rows = logSender.calls.flatMap(({ records }) => records.flatMap((record) => record.body.split("\n")))
      .filter((row) => row.includes(" role: S2-"))
    expect(keys).toHaveLength(1)
    expect(new Set(keys)).toHaveLength(1)
    expect(rows).toHaveLength(100)
    expect(new Set(rows)).toHaveLength(100)
    stop()
  })

  it("S9: a stale pending tail cannot reuse an accepted chunk id after reload", async () => {
    let stop = installGameLogOutbox()
    beginGameLogOutbox(919)
    const write = storage.setItem.bind(storage)
    let mode: "chunks" | "all" | "none" = "chunks"
    vi.spyOn(storage, "setItem").mockImplementation((key, value) => {
      if (mode === "all" || (mode === "chunks" && key.startsWith(GAME_LOG_CHUNK_KEY_PREFIX))) throw new Error("quota")
      write(key, value)
    })
    for (let index = 0; index < ROLLING_CHECKPOINT_LINES; index += 1) devLog("role", `S9-V${index}`)
    await new Promise((resolve) => setTimeout(resolve, 300))
    mode = "all"
    for (let index = 0; index < ROLLING_CHECKPOINT_LINES; index += 1) devLog("role", `S9-A${index}`)
    await new Promise((resolve) => setTimeout(resolve, 300))
    let attempt = 0
    delivery.mockImplementation(async () => attempt++ === 1)
    await drainGameLogOutbox()
    const acceptedId = logSender.calls[1]!.key
    mode = "none"
    stop()
    resetGameLogOutboxForTests()
    stop = installGameLogOutbox()
    delivery.mockResolvedValue(true)
    await drainGameLogOutbox(true)

    const keys = logSender.calls.map(({ key }) => key)
    expect(keys.filter((key) => key === acceptedId)).toHaveLength(1)
    expect(new Set(keys)).toHaveLength(keys.length)
    stop()
  })

  it("re-seals several accepted memory-only chunks under a fresh begin id after reload", async () => {
    let stop = installGameLogOutbox()
    beginGameLogOutbox(940)
    const write = storage.setItem.bind(storage)
    let mode: "chunks" | "all" | "none" = "chunks"
    vi.spyOn(storage, "setItem").mockImplementation((key, value) => {
      if (mode === "all" || (mode === "chunks" && key.startsWith(GAME_LOG_CHUNK_KEY_PREFIX))) {
        throw new Error("quota")
      }
      write(key, value)
    })
    for (const prefix of ["V", "A", "B", "C"]) {
      for (let index = 0; index < ROLLING_CHECKPOINT_LINES; index += 1) {
        devLog("role", `${prefix}${index}`)
      }
      await new Promise((resolve) => setTimeout(resolve, 300))
      if (prefix === "V") mode = "all"
    }
    let attempt = 0
    delivery.mockImplementation(async () => attempt++ !== 0)
    await drainGameLogOutbox()

    mode = "none"
    stop()
    resetGameLogOutboxForTests()
    stop = installGameLogOutbox()
    delivery.mockResolvedValue(true)
    await drainGameLogOutbox(true)

    const payloadsById = new Map<string, Set<string>>()
    for (const call of logSender.calls) {
      const payload = call.records.map((record) => record.body).join("\n")
      const payloads = payloadsById.get(call.key) ?? new Set<string>()
      payloads.add(payload)
      payloadsById.set(call.key, payloads)
    }
    expect([...payloadsById.values()].every((payloads) => payloads.size === 1)).toBe(true)
    const delivered = logSender.calls.flatMap(({ records }) => records.flatMap((record) => record.body.split("\n")))
      .filter((row) => / role: [VABC]\d+$/.test(row))
    expect(new Set(delivered)).toHaveLength(4 * ROLLING_CHECKPOINT_LINES)
    stop()
  })

  it("S11: corrupted reachable storage cannot resend an accepted chunk", async () => {
    delivery.mockResolvedValue(true)
    const stop = installGameLogOutbox()
    beginGameLogOutbox(921)
    vi.spyOn(storage, "getItem").mockImplementation(() => { throw new Error("NS_ERROR_FILE_CORRUPTED") })
    vi.spyOn(storage, "setItem").mockImplementation(() => { throw new Error("NS_ERROR_FILE_CORRUPTED") })
    for (let index = 0; index < ROLLING_CHECKPOINT_LINES; index += 1) devLog("role", `S11-${index}`)
    vi.useFakeTimers()
    try {
      checkpointGameLog("rolling")
      void drainGameLogOutbox()
      await vi.advanceTimersByTimeAsync(120_000)
      expect(logSender.calls).toHaveLength(1)
      expect(new Set(logSender.calls.map(({ key }) => key))).toHaveLength(1)
      settleGameLogOutbox(921)
      const before = logSender.calls.length
      await vi.advanceTimersByTimeAsync(120_000)
      expect(logSender.calls).toHaveLength(before)
    } finally {
      vi.useRealTimers()
      stop()
    }
  })

  it("retries pending chunks on a bounded foreground timer", async () => {
    vi.useFakeTimers()
    try {
      const stop = installGameLogOutbox()
      beginGameLogOutbox(22)
      delivery.mockResolvedValueOnce(false)
      devLog("test", "timer retry")
      checkpointGameLog("round-1")
      await vi.advanceTimersByTimeAsync(0)
      expect(gameLogManifest(22).chunks).toEqual([expect.objectContaining({ status: "pending" })])

      delivery.mockResolvedValue(true)
      await vi.advanceTimersByTimeAsync(5_000)
      expect(gameLogManifest(22).chunks).toEqual([expect.objectContaining({ status: "delivered" })])
      stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it("resets retry delay after a successful send", async () => {
    vi.useFakeTimers()
    try {
      const stop = installGameLogOutbox()
      beginGameLogOutbox(923)
      delivery.mockResolvedValue(false)
      devLog("test", "outage")
      checkpointGameLog("round-1")
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(5_000)

      delivery.mockResolvedValue(true)
      await vi.advanceTimersByTimeAsync(10_000)
      expect(gameLogManifest(923).chunks).toEqual([expect.objectContaining({ status: "delivered" })])

      delivery.mockResolvedValue(false)
      devLog("test", "later failure")
      checkpointGameLog("round-1")
      await vi.advanceTimersByTimeAsync(0)
      const beforeRetry = delivery.mock.calls.length
      delivery.mockResolvedValue(true)
      await vi.advanceTimersByTimeAsync(4_999)
      expect(delivery).toHaveBeenCalledTimes(beforeRetry)
      await vi.advanceTimersByTimeAsync(1)
      expect(delivery).toHaveBeenCalledTimes(beforeRetry + 1)
      stop()
    } finally {
      vi.useRealTimers()
    }
  })
})
