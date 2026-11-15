// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { beforeEach, describe, expect, it, vi } from "vitest"
import * as Sentry from "@sentry/react"

vi.mock("../debug/telemetry", () => ({
  buildLogsExport: vi.fn(async (range?: { since?: number; until?: number }, extra: Record<string, unknown> = {}) => ({
    json: JSON.stringify({ meta: { since: range?.since ?? null, until: range?.until ?? null }, entries: [], ...extra }),
    count: 0,
    filename: "jollity-logs-2026-09-30-g5-anon-vtest.json",
  })),
  stopPersistingLog: vi.fn(),
  releasePersistedLogBefore: vi.fn(async () => {}),
}))

const store = new Map<string, string>()
const localStore = {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => void store.set(key, value),
  removeItem: (key: string) => void store.delete(key),
}
vi.stubGlobal("localStorage", localStore)

import { devLog } from "../debug/log-store"
import { buildLogsExport, releasePersistedLogBefore, stopPersistingLog } from "../debug/telemetry"
import {
  closeExpiredDeliveryHealth,
  markGameLogSent,
  LATE_AFTER_MS,
  installHandoverSink,
  readHandovers,
  readLastHandover,
  readSentGames,
  uploadGameLog,
  uploadLateGameLog,
} from "./game-log"
import { sendGameLog, setPlayer } from "./index"
import { resetTelemetryForTests, startTelemetryWith } from "./init"
import { recordingTransport, testConfig } from "./test-transport"
import { flushDeliveryHealthWritesForTests, pendingDeliveryHealth, setDeliveryHealthGame } from "./delivery-health"
import { uploadLateTelemetryHealth } from "./health-event"
import {
  beginGameLogOutbox,
  gameLogManifest,
  installGameLogOutbox,
  resetGameLogOutboxForTests,
} from "./game-log-outbox"

const TRACE = { traceId: "a".repeat(32), spanId: "b".repeat(16) }
let sink: ReturnType<typeof recordingTransport>

beforeEach(async () => {
  // Pin the long-standing event+attachment fallback contract here. The Logs
  // delivery contract is exercised directly in game-log-outbox.test.
  vi.stubEnv("NEXT_PUBLIC_TELEMETRY_LOGS", "0")
  vi.stubGlobal("localStorage", localStore)
  store.clear()
  await resetTelemetryForTests()
  resetGameLogOutboxForTests()
  sink = recordingTransport()
  startTelemetryWith(testConfig({ makeTransport: sink.factory }))
})

describe("the end-of-game log", () => {
  it("is one info event with the log attached, in the game's trace, then marked sent", async () => {
    await expect(sendGameLog({ gameIndex: 5, since: 1_700_000_000_000, stage: "payoff", trace: TRACE })).resolves.toBe(true)
    const [event] = sink.items("event")
    expect(event.payload).toMatchObject({
      message: "game-log",
      level: "info",
      fingerprint: ["game-log"],
      tags: { "game.index": "5", "game_log.late": "false", "session.id": "session-1" },
      contexts: { trace: { trace_id: TRACE.traceId, span_id: TRACE.spanId } },
    })
    const [attachment] = sink.items("attachment")
    expect(attachment.header).toMatchObject({ filename: "jollity-logs-2026-09-30-g5-anon-vtest.json", content_type: "application/json" })
    const attached = JSON.parse(attachment.payload.text)
    expect(attached.meta.since).toBe(1_700_000_000_000)
    expect(attached.telemetryHealth).toBeUndefined()
    expect(await readSentGames()).toEqual([5])
  })

  it("reports a full copy retired for the outbox ceiling as not sent, even when every transport answers 2xx", async () => {
    vi.mocked(buildLogsExport).mockResolvedValueOnce({
      json: JSON.stringify({ meta: {}, entries: Array.from({ length: 60 }, (_, index) => ({ ts: index, message: `${index}:${"x".repeat(20_000)}` })) }),
      count: 60,
      filename: "oversized.json",
    })
    await expect(uploadGameLog({ gameIndex: 9, since: 0, stage: "payoff", trace: TRACE })).resolves.toBe(false)
    expect(sink.items("event").filter((event) => event.payload.message === "game-log")).toHaveLength(0)
    expect(await readSentGames()).toEqual([])
  })

  it("carries no inherited breadcrumbs on a full game-log part", async () => {
    Sentry.addBreadcrumb({ category: "devlog", message: "large inherited breadcrumb" })
    await expect(uploadGameLog({ gameIndex: 10, since: 0, stage: "payoff", trace: TRACE })).resolves.toBe(true)
    const [event] = sink.items("event").filter((item) => item.payload.message === "game-log")
    expect(event.payload.breadcrumbs ?? []).toEqual([])
  })

  it("still sends and releases its claim when delivery-health storage stays unreadable", async () => {
    const read = localStorage.getItem
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => {
        if (key === "jollity.telemetry.delivery-health.v1") throw new Error("host storage not ready")
        return read(key)
      },
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    })
    await expect(uploadGameLog({ gameIndex: 6, since: 0, stage: "payoff", trace: null }, 10_000)).resolves.toBe(true)
    await expect(uploadGameLog({ gameIndex: 6, since: 0, stage: "payoff", trace: null }, 10_000)).resolves.toBe(true)
    expect(sink.items("event")).toHaveLength(2)
    expect(sink.items("attachment").map((item) => JSON.parse(item.payload.text).telemetryHealth)).toEqual([undefined, undefined])
  }, 10_000)

  it("releases the in-flight slot when full-log preparation never answers", async () => {
    vi.mocked(buildLogsExport).mockImplementationOnce(() => new Promise(() => {}))
    await expect(uploadGameLog({ gameIndex: 7, since: 0, stage: "payoff", trace: null }, 5)).resolves.toBe(false)

    vi.mocked(buildLogsExport).mockResolvedValueOnce({
      json: JSON.stringify({ meta: {}, entries: [] }),
      count: 0,
      filename: "recovered.json",
    })
    await expect(uploadGameLog({ gameIndex: 7, since: 0, stage: "payoff", trace: null }, 10_000)).resolves.toBe(true)
  })

  it("captures the current lines before full-log preparation can hang", async () => {
    vi.stubGlobal("window", new EventTarget())
    vi.stubGlobal("document", Object.assign(new EventTarget(), { visibilityState: "visible" }))
    const stop = installGameLogOutbox()
    beginGameLogOutbox(8)
    devLog("test", "captured before host reads")
    vi.mocked(buildLogsExport).mockImplementationOnce(() => new Promise(() => {}))

    const upload = uploadGameLog({ gameIndex: 8, since: 0, stage: "payoff", trace: null }, 5)
    expect(gameLogManifest(8).chunks).toEqual([expect.objectContaining({ checkpoint: "payoff", status: "pending" })])
    await expect(upload).resolves.toBe(false)
    stop()
  })

  it("carries the username once the name is known, before the log goes", async () => {
    setPlayer("5Alice", null)
    setPlayer("5Alice", "alice.dot")
    await expect(sendGameLog({ gameIndex: 5, since: 0, stage: "payoff", trace: TRACE })).resolves.toBe(true)
    const [event] = sink.items("event")
    expect(event.payload.user).toMatchObject({ id: "5Alice", username: "alice.dot" })
  })

  it("marks a game log sent without waiting for the optional grant", async () => {
    await expect(sendGameLog({ gameIndex: 6, since: 0, stage: "payoff", trace: null })).resolves.toBe(true)
    expect(await readSentGames()).toEqual([6])
  })

  it("marks the game sent when a later retry delivers", async () => {
    await resetTelemetryForTests()
    let attempts = 0
    startTelemetryWith(testConfig({
      makeTransport: () => ({
        send: async () => ({ statusCode: ++attempts === 1 ? 503 : 200 }),
        flush: async () => true,
      }),
    }))
    await expect(sendGameLog({ gameIndex: 9, since: 0, stage: "payoff", trace: null })).resolves.toBe(true)
    expect(attempts).toBe(2)
    expect(await readSentGames()).toEqual([9])
  })

  it("marks the game sent when delivery lands after the caller's 60 second deadline", async () => {
    await resetTelemetryForTests()
    startTelemetryWith(
      testConfig({
        makeTransport: () => ({
          send: () => new Promise((resolve) => setTimeout(() => resolve({ statusCode: 200 }), 30)),
          flush: async () => true,
        }),
      }),
    )
    await expect(uploadGameLog({ gameIndex: 19, since: 0, stage: "payoff", trace: null }, 5)).resolves.toBe(false)
    expect(await readSentGames()).toEqual([])
    await vi.waitFor(async () => expect(await readSentGames()).toEqual([19]))
  })

  it("stays unmarked when the send exhausts its retries", async () => {
    await resetTelemetryForTests()
    vi.useFakeTimers()
    let attempts = 0
    startTelemetryWith(
      testConfig({
        makeTransport: () => ({
          send: async () => {
            attempts += 1
            return { statusCode: 429, headers: { "retry-after": "0", "x-sentry-rate-limits": null } }
          },
          flush: async () => true,
        }),
      }),
    )
    const sent = sendGameLog({ gameIndex: 20, since: 0, stage: "payoff", trace: null })
    await vi.waitFor(() => expect(attempts).toBe(1))
    for (let retry = 0; retry < 5; retry += 1) await vi.advanceTimersByTimeAsync(60_000)
    await expect(sent).resolves.toBe(false)
    expect(attempts).toBe(6)
    expect(await readSentGames()).toEqual([])
    vi.useRealTimers()
  })

  it("waits for older retries and embeds the same finalized game and session counters", async () => {
    await resetTelemetryForTests()
    sink = recordingTransport()
    let attempts = 0
    const factory = (options: Parameters<typeof sink.factory>[0]) => {
      const inner = sink.factory(options)
      return {
        ...inner,
        send: async (envelope: Parameters<typeof inner.send>[0]) => {
          attempts += 1
          if (attempts === 1) return { statusCode: 503 }
          return inner.send(envelope)
        },
      }
    }
    startTelemetryWith(testConfig({ makeTransport: factory }))
    setDeliveryHealthGame(10)
    Sentry.captureMessage("older event")
    await expect(sendGameLog({ gameIndex: 10, since: 0, stage: "payoff", trace: null })).resolves.toBe(true)
    const attached = JSON.parse(sink.items("attachment")[0].payload.text)
    expect(attached.telemetryHealth).toMatchObject({ failed_5xx: 1, retries: 1, session: { failed_5xx: 1, retries: 1 } })
  })
})

describe("a webview without crypto.randomUUID", () => {
  it("still sends the log", async () => {
    const original = globalThis.crypto
    vi.stubGlobal("crypto", {})
    try {
      await expect(sendGameLog({ gameIndex: 8, since: 0, stage: "payoff", trace: null })).resolves.toBe(true)
      expect(sink.items("event")).toHaveLength(1)
    } finally {
      vi.stubGlobal("crypto", original)
    }
  })
})

describe("the late log", () => {
  const now = 1_700_010_000_000

  async function markHandover(game: number, at: number, endsAt?: number): Promise<void> {
    const stop = installHandoverSink()
    devLog("telemetry", `game ${game} handover`, { game, at, ...(endsAt === undefined ? {} : { endsAt }) })
    stop()
    await vi.waitFor(async () => expect((await readHandovers()).some((h) => h.gameIndex === game)).toBe(true))
  }

  it("remembers the newest handover marker under its own key", async () => {
    const stop = installHandoverSink()
    devLog("telemetry", "game 3 handover", { game: 3, at: 1 })
    devLog("telemetry", "game 4 handover", { game: 4, at: 4 })
    devLog("rtc", "game 9 handover")
    stop()
    await vi.waitFor(async () => expect(await readLastHandover()).toEqual({ gameIndex: 4, at: 4 }))
  })

  it("sends the last unsent game's log, tagged late, once", async () => {
    await markHandover(4, now - LATE_AFTER_MS - 1000)
    await expect(uploadLateGameLog(now)).resolves.toBe(true)
    expect(sink.items("event")[0].payload.tags).toMatchObject({ "game.index": "4", "game_log.late": "true" })
    await expect(uploadLateGameLog(now)).resolves.toBe(false)
    expect(sink.items("event")).toHaveLength(1)
  })

  it("drains a killed game on the first reopen after its chain end, before the legacy age fallback", async () => {
    setDeliveryHealthGame(14)
    await markHandover(14, now - 2 * 60_000, now - 1_000)
    await closeExpiredDeliveryHealth(now)

    await expect(uploadLateTelemetryHealth()).resolves.toBe(true)
    await expect(uploadLateGameLog(now)).resolves.toBe(true)
    expect(sink.items("event").map((event) => event.payload.message)).toEqual(["game-log"])
    expect(sink.items("log").flatMap((item) => item.payload.items).map((record) => record.body)).toEqual(["telemetry.health"])
  })

  it("does not recreate empty health for a sent handover on the next reopen", async () => {
    setDeliveryHealthGame(15)
    await markHandover(15, now - 2 * 60_000, now - 1_000)
    await closeExpiredDeliveryHealth(now)
    await expect(uploadLateTelemetryHealth()).resolves.toBe(true)
    await expect(uploadLateGameLog(now)).resolves.toBe(true)

    await resetTelemetryForTests()
    sink = recordingTransport()
    startTelemetryWith(testConfig({ makeTransport: sink.factory }))
    await closeExpiredDeliveryHealth(now + 60_000)

    await expect(uploadLateTelemetryHealth()).resolves.toBe(false)
    expect(sink.items("event")).toHaveLength(0)
  })

  it("does not recreate health when health was sent but its game log was not", async () => {
    setDeliveryHealthGame(16)
    await markHandover(16, now - 2 * 60_000, now - 1_000)
    await closeExpiredDeliveryHealth(now)
    await expect(uploadLateTelemetryHealth()).resolves.toBe(true)

    await resetTelemetryForTests()
    sink = recordingTransport()
    startTelemetryWith(testConfig({ makeTransport: sink.factory }))
    await closeExpiredDeliveryHealth(now + 60_000)

    await expect(uploadLateTelemetryHealth()).resolves.toBe(false)
    await expect(uploadLateGameLog(now + 60_000)).resolves.toBe(true)
    await expect(uploadLateTelemetryHealth()).resolves.toBe(false)
    expect(sink.items("event").map((event) => event.payload.message)).toEqual(["game-log"])
  })

  it("does not recreate pruned sent health when its retained game log later uploads", async () => {
    setDeliveryHealthGame(18)
    await markHandover(18, now - 2 * 60_000, now - 1_000)
    await closeExpiredDeliveryHealth(now)
    await expect(uploadLateTelemetryHealth()).resolves.toBe(true)
    for (let game = 19; game <= 24; game += 1) setDeliveryHealthGame(game)
    await flushDeliveryHealthWritesForTests()

    await resetTelemetryForTests()
    sink = recordingTransport()
    startTelemetryWith(testConfig({ makeTransport: sink.factory }))
    await expect(uploadLateGameLog(now + 60_000)).resolves.toBe(true)

    expect((await pendingDeliveryHealth()).some(({ gameIndex }) => gameIndex === 18)).toBe(false)
    expect(JSON.parse(sink.items("attachment")[0].payload.text).telemetryHealth).toBeUndefined()
    expect(sink.items("event").map((event) => event.payload.message)).toEqual(["game-log"])
  })

  it("still closes health when the game log was already sent", async () => {
    setDeliveryHealthGame(17)
    await markHandover(17, now - 2 * 60_000, now - 1_000)
    await expect(uploadLateGameLog(now)).resolves.toBe(true)
    await closeExpiredDeliveryHealth(now)

    await expect(uploadLateTelemetryHealth()).resolves.toBe(true)
    expect(sink.items("event").map((event) => event.payload.message)).toEqual(["game-log"])
    expect(sink.items("log").flatMap((item) => item.payload.items).map((record) => record.body)).toEqual(["telemetry.health"])
  })

  it("skips a game whose log is still in flight this session", async () => {
    await resetTelemetryForTests()
    let finish: ((answer: { statusCode: number }) => void) | undefined
    startTelemetryWith(testConfig({
      makeTransport: () => ({
        send: () => new Promise((resolve) => (finish = resolve)),
        flush: async () => true,
      }),
    }))
    await markHandover(4, now - LATE_AFTER_MS - 1000)
    const first = uploadLateGameLog(now)
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"))
    await expect(uploadLateGameLog(now)).resolves.toBe(false)
    finish?.({ statusCode: 200 })
    await expect(first).resolves.toBe(true)
  })

  it("keeps only one durable full copy while a report is pending, then allows payoff", async () => {
    await resetTelemetryForTests()
    const finishers: Array<(answer: { statusCode: number }) => void> = []
    startTelemetryWith(testConfig({
      makeTransport: () => ({
        send: () => new Promise((resolve) => finishers.push(resolve)),
        flush: async () => true,
      }),
    }))
    const report = uploadGameLog({ gameIndex: 4, since: 100, stage: "report", trace: TRACE })
    await vi.waitFor(() => expect(finishers).toHaveLength(1))
    await expect(uploadGameLog({ gameIndex: 4, since: 100, stage: "payoff", trace: TRACE })).resolves.toBe(false)
    finishers[0]({ statusCode: 200 })
    await expect(report).resolves.toBe(true)
    const payoff = uploadGameLog({ gameIndex: 4, since: 100, stage: "payoff", trace: TRACE })
    await vi.waitFor(() => expect(finishers).toHaveLength(2))
    finishers[1]({ statusCode: 200 })
    await expect(payoff).resolves.toBe(true)
    expect(await readSentGames()).toEqual([4])
  })

  it("tags each send with its stage and sends both copies of a clean game", async () => {
    await uploadGameLog({ gameIndex: 6, since: 100, stage: "report", trace: TRACE })
    await uploadGameLog({ gameIndex: 6, since: 100, stage: "payoff", trace: TRACE })
    expect(sink.items("event").map((event) => event.payload.tags["game_log.stage"])).toEqual(["report", "payoff"])
    expect(await readSentGames()).toEqual([6])
  })

  it("still skips a late upload while a report send is in flight", async () => {
    await resetTelemetryForTests()
    let finish: ((answer: { statusCode: number }) => void) | undefined
    startTelemetryWith(testConfig({
      makeTransport: () => ({
        send: () => new Promise((resolve) => (finish = resolve)),
        flush: async () => true,
      }),
    }))
    await markHandover(4, now - LATE_AFTER_MS - 1000)
    const report = uploadGameLog({ gameIndex: 4, since: 100, stage: "report", trace: TRACE })
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"))
    await expect(uploadGameLog({ gameIndex: 4, since: 100, stage: "late", trace: null })).resolves.toBe(false)
    finish?.({ statusCode: 200 })
    await expect(report).resolves.toBe(true)
  })

  it("leaves a game that may still be running alone", async () => {
    await markHandover(4, now - 60_000)
    await expect(uploadLateGameLog(now)).resolves.toBe(false)
    expect(sink.envelopes).toHaveLength(0)
  })
  it("keeps the first handover of a game when a restart logs it again", async () => {
    const stop = installHandoverSink()
    devLog("telemetry", "game 160 handover", { game: 160, at: 100 })
    devLog("telemetry", "game 160 handover", { game: 160, at: 700 })
    stop()
    await vi.waitFor(async () => expect(await readHandovers()).toEqual([{ gameIndex: 160, at: 100 }]))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(await readHandovers()).toEqual([{ gameIndex: 160, at: 100 }])
  })

  it("exports from the earliest handover even when the caller passes the rejoin", async () => {
    await markHandover(160, 100)
    await uploadGameLog({ gameIndex: 160, since: 700, stage: "payoff", trace: null })
    expect(JSON.parse(sink.items("attachment")[0].payload.text).meta.since).toBe(100)
  })

  it("does not move a caller's earlier since forward, or borrow another game's handover", async () => {
    await markHandover(160, 100)
    await uploadGameLog({ gameIndex: 161, since: 700, stage: "payoff", trace: null })
    expect(JSON.parse(sink.items("attachment")[0].payload.text).meta.since).toBe(700)
  })

  it("does not overwrite the remembered handovers when reading them failed (issue 222)", async () => {
    await markHandover(166, 100)
    const read = localStorage.getItem
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("host storage not ready")
      },
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    })
    const stop = installHandoverSink()
    devLog("telemetry", "game 166 handover", { game: 166, at: 900 })
    await new Promise((resolve) => setTimeout(resolve, 20))
    stop()
    vi.stubGlobal("localStorage", { getItem: read, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) })
    expect(await readHandovers()).toEqual([{ gameIndex: 166, at: 100 }])
  })

  it("remembers several pending games and sends each once, oldest first, bounded at the next handover", async () => {
    const old = now - LATE_AFTER_MS - 5000
    await markHandover(160, old)
    await markHandover(161, old + 1000)
    await expect(uploadLateGameLog(now)).resolves.toBe(true)
    const events = sink.items("event")
    expect(events.map((e) => e.payload.tags["game.index"])).toEqual(["160", "161"])
    const [first, second] = sink.items("attachment").map((a) => JSON.parse(a.payload.text).meta)
    expect(first).toMatchObject({ since: old, until: old + 1000 })
    expect(second).toMatchObject({ since: old + 1000, until: null })
    expect(await readSentGames()).toEqual([160, 161])
    await expect(uploadLateGameLog(now)).resolves.toBe(false)
    expect(sink.items("event")).toHaveLength(2)
  })

  it("skips the sent game and the one still young", async () => {
    const old = now - LATE_AFTER_MS - 5000
    await markHandover(160, old)
    await markHandover(161, now - 60_000)
    await sendGameLog({ gameIndex: 160, since: old, stage: "payoff", trace: null })
    await expect(uploadLateGameLog(now)).resolves.toBe(false)
    expect(sink.items("event")).toHaveLength(1)
  })

  it("keeps only the last five games", async () => {
    for (let game = 1; game <= 7; game++) await markHandover(game, game * 10)
    expect((await readHandovers()).map((h) => h.gameIndex)).toEqual([3, 4, 5, 6, 7])
  })

  it("still honours the old single-object value", async () => {
    store.set("jollity.telemetry.last-handover", JSON.stringify({ gameIndex: 4, at: now - LATE_AFTER_MS - 1000 }))
    expect(await readLastHandover()).toEqual({ gameIndex: 4, at: now - LATE_AFTER_MS - 1000 })
    await expect(uploadLateGameLog(now)).resolves.toBe(true)
    expect(sink.items("event")[0].payload.tags).toMatchObject({ "game.index": "4" })
  })
})

describe("the persisted log after a delivery", () => {
  it("serializes concurrent sent markers so neither game is lost", async () => {
    await Promise.all([markGameLogSent(3), markGameLogSent(4)])
    expect(await readSentGames()).toEqual([3, 4])
  })

  it("stops queueing once every remembered game has gone out, and not before, but keeps the lines", async () => {
    store.set("jollity.telemetry.last-handover", JSON.stringify([{ gameIndex: 4, at: 1000 }, { gameIndex: 5, at: 2000 }]))
    vi.mocked(stopPersistingLog).mockClear()
    vi.mocked(releasePersistedLogBefore).mockClear()
    await markGameLogSent(4)
    expect(stopPersistingLog).not.toHaveBeenCalled()
    await markGameLogSent(5)
    expect(stopPersistingLog).toHaveBeenCalledTimes(1)
    expect(stopPersistingLog).toHaveBeenCalledWith(expect.arrayContaining([4, 5]))
    expect(releasePersistedLogBefore).not.toHaveBeenCalled()
  })
})

describe("the persisted ring is kept until the next game", () => {
  async function handover(game: number, at: number): Promise<void> {
    const stop = installHandoverSink()
    devLog("telemetry", `game ${game} handover`, { game, at })
    stop()
    await vi.waitFor(async () => expect((await readHandovers()).some((h) => h.gameIndex === game)).toBe(true))
  }

  beforeEach(() => {
    vi.mocked(releasePersistedLogBefore).mockClear()
    vi.mocked(stopPersistingLog).mockClear()
  })

  it("is not released when the payoff send gets a 2xx", async () => {
    const at = Date.now() - 60_000
    await handover(20, at)
    vi.mocked(releasePersistedLogBefore).mockClear()
    await expect(uploadGameLog({ gameIndex: 20, since: at, stage: "payoff", trace: TRACE })).resolves.toBe(true)
    await vi.waitFor(async () => expect(await readSentGames()).toEqual([20]))
    expect(releasePersistedLogBefore).not.toHaveBeenCalled()
  })

  it("releases the previous game's lines at the next game's handover, and not at a rejoin", async () => {
    await handover(21, 1_000)
    await markGameLogSent(21)
    vi.mocked(releasePersistedLogBefore).mockClear()
    await handover(22, 5_000)
    await vi.waitFor(() => expect(releasePersistedLogBefore).toHaveBeenCalledWith(5_000))
    vi.mocked(releasePersistedLogBefore).mockClear()
    await handover(22, 6_000)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(releasePersistedLogBefore).not.toHaveBeenCalled()
  })

  it("keeps writing handover markers while a release never answers", async () => {
    vi.mocked(releasePersistedLogBefore).mockImplementationOnce(() => new Promise(() => {}))
    await handover(26, 1_000)
    await handover(27, 5_000)
    expect((await readHandovers()).map((h) => h.gameIndex)).toEqual([26, 27])
  })

  it("keeps an unsent earlier game's lines for its late upload", async () => {
    await handover(23, 1_000)
    await handover(24, 5_000)
    await vi.waitFor(() => expect(releasePersistedLogBefore).toHaveBeenLastCalledWith(1_000))
  })

  it("does not re-send a sent game on reopen", async () => {
    const now = Date.now()
    const at = now - LATE_AFTER_MS - 1_000
    await handover(25, at)
    await expect(uploadGameLog({ gameIndex: 25, since: at, stage: "payoff", trace: TRACE })).resolves.toBe(true)
    await vi.waitFor(async () => expect(await readSentGames()).toEqual([25]))
    const sent = sink.items("event").length
    await expect(uploadLateGameLog(now)).resolves.toBe(false)
    expect(sink.items("event")).toHaveLength(sent)
  })
})

describe("the report copy is a bonus that settles nothing", () => {
  async function markHandover(game: number, at: number): Promise<void> {
    const stop = installHandoverSink()
    devLog("telemetry", `game ${game} handover`, { game, at })
    stop()
    await vi.waitFor(async () => expect((await readHandovers()).some((h) => h.gameIndex === game)).toBe(true))
  }

  it("does not mark the game sent or stop persisting the log", async () => {
    await markHandover(12, Date.now() - 60_000)
    vi.mocked(stopPersistingLog).mockClear()
    await expect(uploadGameLog({ gameIndex: 12, since: 0, stage: "report", trace: TRACE })).resolves.toBe(true)
    expect(await readSentGames()).toEqual([])
    expect(stopPersistingLog).not.toHaveBeenCalled()
  })

  it("lets the late upload still send an ended game", async () => {
    const now = 1_700_010_000_000
    await markHandover(13, now - LATE_AFTER_MS - 1000)
    await uploadGameLog({ gameIndex: 13, since: 0, stage: "report", trace: TRACE })
    await expect(uploadLateGameLog(now)).resolves.toBe(true)
    expect(sink.items("event").map((event) => event.payload.tags["game_log.stage"])).toEqual(["report", "late"])
  })

  it("keeps telemetryHealth for the payoff copy", async () => {
    await resetTelemetryForTests()
    sink = recordingTransport()
    let attempts = 0
    const factory = (options: Parameters<typeof sink.factory>[0]) => {
      const inner = sink.factory(options)
      return {
        ...inner,
        send: async (envelope: Parameters<typeof inner.send>[0]) => {
          attempts += 1
          if (attempts === 1) return { statusCode: 503 }
          return inner.send(envelope)
        },
      }
    }
    startTelemetryWith(testConfig({ makeTransport: factory }))
    setDeliveryHealthGame(14)
    Sentry.captureMessage("older event")
    await uploadGameLog({ gameIndex: 14, since: 0, stage: "report", trace: null })
    await uploadGameLog({ gameIndex: 14, since: 0, stage: "payoff", trace: null })
    const attachments = sink.items("attachment").map((item) => JSON.parse(item.payload.text))
    expect(attachments.at(-1).telemetryHealth).toMatchObject({ failed_5xx: 1, retries: 1 })
  })

  it("makes report and payoff yield to an in-flight late upload of the same game", async () => {
    await resetTelemetryForTests()
    let finish: ((answer: { statusCode: number }) => void) | undefined
    startTelemetryWith(testConfig({
      makeTransport: () => ({
        send: () => new Promise((resolve) => (finish = resolve)),
        flush: async () => true,
      }),
    }))
    const flush = uploadGameLog({ gameIndex: 15, since: 0, stage: "late", trace: null })
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"))
    await expect(uploadGameLog({ gameIndex: 15, since: 0, stage: "report", trace: TRACE })).resolves.toBe(false)
    await expect(uploadGameLog({ gameIndex: 15, since: 0, stage: "payoff", trace: TRACE })).resolves.toBe(false)
    finish?.({ statusCode: 200 })
    await expect(flush).resolves.toBe(true)
  })
})
