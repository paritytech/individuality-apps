// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as Sentry from "@sentry/react"

// real integrations, with their options recorded
vi.mock("@sentry/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@sentry/react")>()
  return {
    ...actual,
    breadcrumbsIntegration: vi.fn(actual.breadcrumbsIntegration),
    browserTracingIntegration: vi.fn(actual.browserTracingIntegration),
  }
})

import {
  configFromEnvironment,
  EVENT_LANE,
  expectDelivery,
  LOG_LANE,
  resetTelemetryForTests,
  sendLogEnvelope,
  sentryOptions,
  startTelemetryWith,
  takeLogRejected,
  telemetryStarted,
  waitForTelemetryIdle,
  type Envelope,
  type TransportFactory,
} from "./init"
import { isLogEnvelope, type LogRecord } from "./log-envelope"
import { flushMetrics, recordCount } from "./metrics"
import { recordingTransport, testConfig } from "./test-transport"
import { deliveryHealthObserver } from "./delivery-health"
import { clearDevLog, devLog, getDevLogEntries } from "../debug/log-store"
import {
  beginGameLogOutbox,
  checkpointGameLog,
  drainGameLogOutbox,
  gameLogManifest,
  installGameLogOutbox,
  resetGameLogOutboxForTests,
} from "./game-log-outbox"

const RATE_LIMIT_KEY = "jollity.telemetry.rate-limit-until.v1"

const logRecord = (body = "one log record"): LogRecord => ({
  timestamp: Date.now() / 1000,
  level: "info",
  body,
  trace_id: "a".repeat(32),
  severity_number: 9,
  attributes: {},
})

const settleMicrotasks = async () => {
  for (let i = 0; i < 12; i += 1) await Promise.resolve()
}

const envelopeLane = (envelope: Envelope): string => (isLogEnvelope(envelope) ? LOG_LANE : EVENT_LANE)

class MemoryStorage {
  readonly values = new Map<string, string>()
  get length(): number { return this.values.size }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null }
  getItem(key: string): string | null { return this.values.get(key) ?? null }
  setItem(key: string, value: string): void { this.values.set(key, value) }
  removeItem(key: string): void { this.values.delete(key) }
  clear(): void { this.values.clear() }
}

beforeEach(async () => {
  await resetTelemetryForTests()
})
afterEach(() => {
  // a failed fake-timer test must not leave its clock to the next one
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe("starting Sentry", () => {
  it("puts the release, environment, tags and page context on every event", async () => {
    const sink = recordingTransport()
    expect(startTelemetryWith(testConfig({ makeTransport: sink.factory, testTag: "e2e-bench" }))).toBe(true)
    Sentry.captureMessage("probe")
    await Sentry.flush(1000)
    const [event] = sink.items("event")
    expect(event.payload).toMatchObject({
      release: "jollity@test",
      environment: "dim2-pr126-sandbox00.paseo",
      tags: {
        product: "dim2.testnet",
        "host.kind": "android",
        "session.id": "session-1",
        "env.source": "host",
        "test.tag": "e2e-bench",
      },
      contexts: {
        page: {
          user_agent: "Mozilla/5.0 (Linux; Android 14; Pixel 8; wv)",
          origin: "https://dim2-pr126-sandbox00.paseo",
          viewport: "390x844",
          language: "en-GB",
        },
      },
    })
  })

  it("joins SPA events to a native host session without waiting for one", async () => {
    const sink = recordingTransport()
    vi.stubGlobal("__trinityHostTelemetry", {
      hostSessionId: "123e4567-e89b-42d3-a456-426614174000",
      appVersion: "1.17.0",
      appBuild: "57",
      appVariant: "nightly",
      platform: "ios",
      truapiHostVersion: "0.25.0",
      truapiCoreVersion: "0.18.0",
      codecVersion: "3",
      schemaVersion: "1",
    })
    startTelemetryWith(testConfig({ makeTransport: sink.factory }))
    Sentry.captureMessage("probe")
    await Sentry.flush(1000)

    expect(sink.items("event")[0].payload).toMatchObject({
      tags: {
        "host.session_id": "123e4567-e89b-42d3-a456-426614174000",
        "host.native_app_version": "1.17.0",
        "host.app_build": "57",
        "host.app_variant": "nightly",
        "truapi.host_version": "0.25.0",
        "truapi.core_version": "0.18.0",
        "truapi.codec_version": "3",
        "truapi.schema_version": "1",
      },
      contexts: {
        native_host: {
          hostSessionId: "123e4567-e89b-42d3-a456-426614174000",
          platform: "ios",
        },
      },
    })
  })

  it("leaves test.tag off a deploy build", async () => {
    const sink = recordingTransport()
    startTelemetryWith(testConfig({ makeTransport: sink.factory }))
    Sentry.captureMessage("probe")
    await Sentry.flush(1000)
    expect(sink.items("event")[0].payload.tags).not.toHaveProperty("test.tag")
  })

  it("files a localhost page as local, not as the baked product", async () => {
    const sink = recordingTransport()
    startTelemetryWith(testConfig({ makeTransport: sink.factory, hostname: "localhost", protocol: "http:" }))
    Sentry.captureMessage("probe")
    await Sentry.flush(1000)
    const [event] = sink.items("event")
    expect(event.payload.environment).toBe("local")
    expect(event.payload.tags["env.source"]).toBe("local")
  })

  it("sends immediately without waiting for the optional network grant", async () => {
    const sink = recordingTransport()
    startTelemetryWith(testConfig({ makeTransport: sink.factory }))
    Sentry.captureMessage("first")
    Sentry.captureMessage("second")
    await Sentry.flush(1000)
    expect(sink.items("event").map((item) => item.payload.message)).toEqual(["first", "second"])
  })

  it("starts nothing without a DSN", () => {
    const factory = vi.fn()
    expect(startTelemetryWith(testConfig({ dsn: "", makeTransport: factory }))).toBe(false)
    expect(factory).not.toHaveBeenCalled()
    expect(Sentry.getClient()).toBeUndefined()
    expect(telemetryStarted()).toBe(false)
  })

  it("starts nothing for a malformed DSN", () => {
    const factory = vi.fn()
    expect(startTelemetryWith(testConfig({ dsn: "sentry please", makeTransport: factory }))).toBe(false)
    expect(factory).not.toHaveBeenCalled()
    expect(Sentry.getClient()).toBeUndefined()
  })

  it("drops Dedupe and Console from the defaults, and adds page-load tracing", () => {
    const options = sentryOptions(testConfig({ bare: false }))
    expect(options.traceLifecycle).toBe("static")
    expect(options.sendClientReports).toBe(false)
    expect(options.tracesSampleRate).toBe(1)
    const integrations = options.integrations as (defaults: ReturnType<typeof Sentry.getDefaultIntegrations>) => { name: string }[]
    const names = integrations(Sentry.getDefaultIntegrations({})).map((integration) => integration.name)
    expect(names).not.toContain("Dedupe")
    expect(names).not.toContain("Console")
    expect(names.filter((name) => name === "Breadcrumbs")).toHaveLength(1)
    expect(names).toContain("BrowserTracing")
  })

  it("keeps the SDK's own dom, fetch, xhr and history breadcrumbs and its resource and long-task spans off", () => {
    const integrations = sentryOptions(testConfig({ bare: false })).integrations as (defaults: never[]) => unknown
    integrations([])
    expect(Sentry.breadcrumbsIntegration).toHaveBeenLastCalledWith({ dom: false, fetch: false, history: false, xhr: false })
    expect(Sentry.browserTracingIntegration).toHaveBeenLastCalledWith(
      expect.objectContaining({
        instrumentNavigation: false,
        enableLongTask: false,
        enableLongAnimationFrame: false,
        // INP spans are standalone envelopes, one per slow tap: each one a
        // host-gated request
        enableInp: false,
        ignoreResourceSpans: expect.arrayContaining(["resource.script", "resource.css", "resource.img"]),
      }),
    )
  })
})

describe("the default transport", () => {
  it("sends through window.fetch, so the host's network rule applies", async () => {
    const pageFetch = vi.fn(async (_url: RequestInfo | URL, _options?: RequestInit) => new Response("{}", { status: 200 }))
    vi.stubGlobal("window", { fetch: pageFetch })
    // a stand-in for the native fetch the SDK would otherwise lift from a hidden iframe
    const nativeFetch = vi.fn(async () => new Response("{}", { status: 200 }))
    vi.stubGlobal("fetch", nativeFetch)
    startTelemetryWith(testConfig())
    Sentry.captureMessage("probe")
    await Sentry.flush(1000)
    expect(pageFetch).toHaveBeenCalledTimes(1)
    expect(pageFetch.mock.calls[0]?.[1]).toMatchObject({ keepalive: true })
    expect(nativeFetch).not.toHaveBeenCalled()
  })

  it("flushes through the gated transport when pagehide follows a capture", async () => {
    const page = new EventTarget()
    vi.stubGlobal("window", page)
    const send = vi.fn(async () => ({ statusCode: 200 }))
    const flush = vi.fn(async () => true)
    startTelemetryWith(testConfig({ makeTransport: () => ({ send, flush }) }))
    Sentry.captureEvent({ message: "signup-broadcast", level: "info" })
    page.dispatchEvent(new Event("pagehide"))
    await vi.waitFor(() => expect(flush).toHaveBeenCalled())
    expect(send).toHaveBeenCalledTimes(1)
  })

  it("starts an envelope held offline when pagehide fires", async () => {
    const page = new EventTarget()
    const nav = { onLine: false }
    vi.stubGlobal("window", page)
    vi.stubGlobal("navigator", nav)
    const send = vi.fn(async () => {
      if (!nav.onLine) throw new TypeError("Failed to fetch")
      return { statusCode: 200 }
    })
    startTelemetryWith(testConfig({ makeTransport: () => ({ send, flush: async () => true }) }))
    Sentry.captureEvent({ message: "held for pagehide", level: "info" })
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1))
    for (let i = 0; i < 10; i += 1) await Promise.resolve()
    nav.onLine = true
    page.dispatchEvent(new Event("pagehide"))
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2))
  })
})

describe("the mnemonic guard", () => {
  it("redacts a phrase in any context, extra and tag of an event", async () => {
    const sink = recordingTransport()
    startTelemetryWith(testConfig({ makeTransport: sink.factory }))
    const phrase = "abandon ability able about above absent absorb abstract absurd abuse access accident"
    Sentry.captureEvent({
      message: "failed",
      contexts: { failure: { error: `bad key ${phrase}`, nested: { text: phrase } } },
      extra: { note: phrase },
      tags: { why: phrase },
    })
    await Sentry.flush(1000)
    const [event] = sink.items("event")
    expect(JSON.stringify(event.payload)).not.toContain("abandon ability")
    expect(event.payload.contexts.failure.error).toContain("[redacted")
    expect(event.payload.contexts.failure.nested.text).toContain("[redacted")
  })
})

describe("a delivery", () => {
  it("strips isolation-scope breadcrumbs from game-log chunk and full-part envelopes", async () => {
    const sink = recordingTransport()
    startTelemetryWith(testConfig({ makeTransport: sink.factory }))
    Sentry.addBreadcrumb({ category: "devlog", message: "large inherited breadcrumb" })
    Sentry.captureEvent({ message: "game-log-chunk", level: "info" })
    Sentry.captureEvent({ message: "ordinary", level: "info" })
    Sentry.captureEvent({ message: "game-log", level: "info" })
    await Sentry.flush(1000)
    const [chunk, ordinary, full] = sink.items("event").map((item) => item.payload)
    expect(chunk.breadcrumbs).toEqual([])
    expect(full.breadcrumbs).toEqual([])
    expect(ordinary.breadcrumbs).toEqual([expect.objectContaining({ message: "large inherited breadcrumb" })])
  })

  it("resolves true once the real transport has answered", async () => {
    const sink = recordingTransport()
    startTelemetryWith(testConfig({ makeTransport: sink.factory }))
    const id = "0123456789abcdef0123456789abcdef"
    let settled: boolean | undefined
    void expectDelivery(id, 5000).then((value) => (settled = value))
    Sentry.captureEvent({ message: "waiting" }, { event_id: id })
    await Sentry.flush(1000)
    await Promise.resolve()
    expect(settled).toBe(true)
  })

  it("retries when the real transport refuses it, then resolves true", async () => {
    vi.useFakeTimers()
    let attempts = 0
    const factory: TransportFactory = () => ({
      send: async () => ({ statusCode: ++attempts === 1 ? 500 : 200 }),
      flush: async () => true,
    })
    startTelemetryWith(testConfig({ makeTransport: factory }))
    const id = "fedcba9876543210fedcba9876543210"
    const delivery = expectDelivery(id, 5_000)
    Sentry.captureEvent({ message: "refused" }, { event_id: id })
    await vi.advanceTimersByTimeAsync(1_000)
    await expect(delivery).resolves.toBe(true)
    expect(attempts).toBe(2)
    vi.useRealTimers()
  })

  it("retries when the SDK drops an envelope, then resolves true", async () => {
    vi.useFakeTimers()
    // the SDK's transport resolves {} when it drops an envelope for rate limiting
    let attempts = 0
    const factory: TransportFactory = () => ({ send: async () => (++attempts === 1 ? {} : { statusCode: 200 }), flush: async () => true })
    startTelemetryWith(testConfig({ makeTransport: factory }))
    const id = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    const delivery = expectDelivery(id, 120_000)
    Sentry.captureEvent({ message: "dropped" }, { event_id: id })
    await vi.advanceTimersByTimeAsync(60_000)
    await expect(delivery).resolves.toBe(true)
    expect(attempts).toBe(2)
    vi.useRealTimers()
  })

  it("preserves the server's longest uncapped category backoff as the global barrier", async () => {
    vi.useFakeTimers()
    let attempts = 0
    const factory: TransportFactory = () => ({
      send: async () =>
        ++attempts === 1
          ? {
              statusCode: 429,
              headers: { "x-sentry-rate-limits": "999:transaction:org, 10:error:org", "retry-after": null },
            }
          : { statusCode: 200 },
      flush: async () => true,
    })
    startTelemetryWith(testConfig({ makeTransport: factory }))
    const id = "b".repeat(32)
    const delivery = expectDelivery(id, 1_100_000)
    Sentry.captureEvent({ message: "category" }, { event_id: id })
    await vi.advanceTimersByTimeAsync(998_999)
    expect(attempts).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    await expect(delivery).resolves.toBe(true)
    expect(attempts).toBe(2)
    vi.useRealTimers()
  })

  it("holds metric envelopes behind a category limit's global barrier", async () => {
    vi.useFakeTimers()
    let attempts = 0
    const factory: TransportFactory = () => ({
      send: async () =>
        ++attempts === 1
          ? {
              statusCode: 429,
              headers: { "x-sentry-rate-limits": "999:error:org, 10:metric_bucket:org", "retry-after": null },
            }
          : { statusCode: 200 },
      flush: async () => true,
    })
    startTelemetryWith(testConfig({ makeTransport: factory }))
    recordCount("test.category", 1, {})
    flushMetrics()
    await vi.advanceTimersByTimeAsync(998_999)
    expect(attempts).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    await waitForTelemetryIdle()
    expect(attempts).toBe(2)
    vi.useRealTimers()
  })

  it.each([
    ["missing", undefined],
    ["negative", "-5"],
    ["zero", "0"],
    ["malformed", "tomorrow-ish"],
  ])("falls back to sixty seconds for a %s Retry-After", async (_name, retryAfter) => {
    vi.useFakeTimers()
    let attempts = 0
    const factory: TransportFactory = () => ({
      send: async () => (++attempts === 1
        ? { statusCode: 429, headers: retryAfter === undefined ? undefined : { "retry-after": retryAfter, "x-sentry-rate-limits": null } }
        : { statusCode: 200 }),
      flush: async () => true,
    })
    startTelemetryWith(testConfig({ makeTransport: factory }))
    const id = "c".repeat(32)
    const delivery = expectDelivery(id, 120_000)
    Sentry.captureEvent({ message: "fallback" }, { event_id: id })
    await vi.advanceTimersByTimeAsync(59_999)
    expect(attempts).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    await expect(delivery).resolves.toBe(true)
    expect(attempts).toBe(2)
    vi.useRealTimers()
  })

  it("resends a chunk under a fresh event id after a 2xx dropped its attachment, across a reload", async () => {
    vi.stubEnv("NEXT_PUBLIC_TELEMETRY_LOGS", "0")
    vi.useFakeTimers()
    const storage = new MemoryStorage()
    vi.stubGlobal("localStorage", storage)
    vi.stubGlobal("window", new EventTarget())
    vi.stubGlobal("document", Object.assign(new EventTarget(), { visibilityState: "visible" }))
    resetGameLogOutboxForTests()
    const sent: Array<{ id: string; attachment: boolean }> = []
    const transport = (answer: () => Awaited<ReturnType<ReturnType<TransportFactory>["send"]>>): TransportFactory => () => ({
      send: async (envelope) => {
        const types = (envelope[1] as unknown as Array<readonly [{ type?: string }, unknown]>).map(([header]) => header.type)
        sent.push({ id: String(envelope[0].event_id), attachment: types.includes("attachment") })
        return answer()
      },
      flush: async () => true,
    })
    startTelemetryWith(testConfig({
      makeTransport: transport(() => ({ statusCode: 200, headers: { "x-sentry-rate-limits": "5:attachment:organization", "retry-after": null } })),
    }))
    let stop = installGameLogOutbox()
    beginGameLogOutbox(784)
    devLog("vote", "evidence line")
    checkpointGameLog("round-1", Date.now(), 784)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(sent.length).toBeGreaterThanOrEqual(1)
    const firstId = sent[0]!.id
    expect(gameLogManifest(784).chunks.filter((chunk) => chunk.status === "pending")).toHaveLength(1)

    // a reload: module memory dies, localStorage survives
    stop()
    resetGameLogOutboxForTests()
    vi.useRealTimers()
    await resetTelemetryForTests()
    vi.useFakeTimers()
    sent.length = 0
    startTelemetryWith(testConfig({ makeTransport: transport(() => ({ statusCode: 200 })) }))
    stop = installGameLogOutbox()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(sent.length).toBeGreaterThanOrEqual(1)
    // Relay already accepted firstId without its attachment, and may discard
    // a repeat of it as a duplicate: the resend must be a new event.
    expect(sent.map((item) => item.id)).not.toContain(firstId)
    expect(sent.every((item) => item.attachment)).toBe(true)
    expect(gameLogManifest(784).chunks.filter((chunk) => chunk.status === "pending")).toHaveLength(0)
    stop()
    resetGameLogOutboxForTests()
  })

  it("keeps a chunk's event id across ambiguous failures, so a retry stays idempotent", async () => {
    vi.useFakeTimers()
    vi.stubGlobal("localStorage", new MemoryStorage())
    vi.stubGlobal("window", new EventTarget())
    vi.stubGlobal("document", Object.assign(new EventTarget(), { visibilityState: "visible" }))
    resetGameLogOutboxForTests()
    const ids: string[] = []
    startTelemetryWith(testConfig({
      makeTransport: () => ({
        send: async (envelope) => {
          ids.push(String(envelope[0].event_id))
          return ids.length <= 8 ? { statusCode: 503 } : { statusCode: 200 }
        },
        flush: async () => true,
      }),
    }))
    const stop = installGameLogOutbox()
    beginGameLogOutbox(785)
    devLog("vote", "evidence line")
    checkpointGameLog("round-1", Date.now(), 785)
    for (let step = 0; step < 20 && gameLogManifest(785).chunks.some((chunk) => chunk.status === "pending"); step += 1) {
      await vi.advanceTimersByTimeAsync(60_000)
    }
    expect(ids.length).toBeGreaterThan(8)
    expect(new Set(ids).size).toBe(1)
    expect(gameLogManifest(785).chunks.filter((chunk) => chunk.status === "pending")).toHaveLength(0)
    stop()
    resetGameLogOutboxForTests()
  })

  it("keeps a game-log chunk in the outbox when a 2xx says Sentry rate-limited its attachment", async () => {
    vi.stubEnv("NEXT_PUBLIC_TELEMETRY_LOGS", "0")
    vi.useFakeTimers()
    vi.stubGlobal("localStorage", new MemoryStorage())
    vi.stubGlobal("window", new EventTarget())
    vi.stubGlobal("document", Object.assign(new EventTarget(), { visibilityState: "visible" }))
    resetGameLogOutboxForTests()
    // The SDK's real fetch transport, so its own category limiter runs: after
    // the first answer it strips attachment items from later envelopes.
    const bodies: string[] = []
    const fetchImpl = async (_url: unknown, init?: { body?: unknown }) => {
      const body = init?.body
      bodies.push(typeof body === "string" ? body : new TextDecoder().decode(body as Uint8Array))
      return new Response(null, {
        status: 200,
        headers: bodies.length === 1 ? { "x-sentry-rate-limits": "120:attachment:organization" } : {},
      })
    }
    startTelemetryWith(testConfig({ makeTransport: (options) => Sentry.makeFetchTransport(options, fetchImpl as typeof fetch) }))
    const stop = installGameLogOutbox()
    beginGameLogOutbox(783)
    devLog("vote", "evidence line")
    checkpointGameLog("round-1", Date.now(), 783)
    void drainGameLogOutbox()
    const pending = () => gameLogManifest(783).chunks.filter((chunk) => chunk.status === "pending")
    const carriesAttachment = (body: string) => body.includes('"type":"attachment"')

    await vi.advanceTimersByTimeAsync(1_000)
    expect(bodies).toHaveLength(1)
    expect(carriesAttachment(bodies[0]!)).toBe(true)
    // Sentry accepted the event and dropped its attachment: not delivered.
    expect(pending()).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(118_000)
    expect(pending()).toHaveLength(1)
    expect(bodies).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(80_000)
    expect(pending()).toHaveLength(0)
    expect(bodies.length).toBeGreaterThan(1)
    // no event-only envelope ever stood in for the chunk
    expect(bodies.every(carriesAttachment)).toBe(true)
    stop()
    resetGameLogOutboxForTests()
    vi.useRealTimers()
  })

  it.each([
    ["the attachment_item count category", "120:attachment_item:organization"],
    ["an all-categories limit", "120::organization"],
  ])("settles an attachment envelope undelivered on a 2xx naming %s", async (_name, header) => {
    const factory: TransportFactory = () => ({
      send: async () => ({ statusCode: 200, headers: { "x-sentry-rate-limits": header, "retry-after": null } }),
      flush: async () => true,
    })
    startTelemetryWith(testConfig({ makeTransport: factory }))
    const id = "ab".repeat(16)
    const delivery = expectDelivery(id, 5_000)
    Sentry.withScope((scope) => {
      scope.addAttachment({ filename: "chunk.json", data: "{}", contentType: "application/json" })
      Sentry.captureEvent({ message: "game-log-chunk" }, { event_id: id })
    })
    await expect(delivery).resolves.toBe(false)
  })

  it("resends a full log, not the same event id, when a 2xx says its attachment was dropped", async () => {
    vi.useFakeTimers()
    const sentIds: string[] = []
    const factory: TransportFactory = () => ({
      send: async (envelope) => {
        sentIds.push(String(envelope[0].event_id))
        return sentIds.length === 1
          ? { statusCode: 200, headers: { "x-sentry-rate-limits": "30::organization", "retry-after": null } }
          : { statusCode: 200 }
      },
      flush: async () => true,
    })
    startTelemetryWith(testConfig({ makeTransport: factory }))
    const id = "d".repeat(32)
    const delivery = expectDelivery(id, 180_000)
    Sentry.withScope((scope) => {
      scope.addAttachment({ filename: "log.json", data: "{}", contentType: "application/json" })
      Sentry.captureEvent({ message: "game-log" }, { event_id: id })
    })
    // Sentry may discard a resend of an accepted event id as a duplicate, so
    // the owner (outbox or late upload) must send a fresh event instead.
    await expect(delivery).resolves.toBe(false)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(sentIds).toEqual([id])
    vi.useRealTimers()
  })

  it("still reports an event-only envelope delivered on a 2xx naming the attachment category", async () => {
    const factory: TransportFactory = () => ({
      send: async () => ({ statusCode: 200, headers: { "x-sentry-rate-limits": "120:attachment:organization", "retry-after": null } }),
      flush: async () => true,
    })
    startTelemetryWith(testConfig({ makeTransport: factory }))
    const id = "f".repeat(32)
    const delivery = expectDelivery(id, 5_000)
    Sentry.captureEvent({ message: "plain" }, { event_id: id })
    await expect(delivery).resolves.toBe(true)
  })

  it("caps a persisted deadline at one hour, and re-checks one found on open", async () => {
    vi.useFakeTimers()
    const storage = new MemoryStorage()
    vi.stubGlobal("localStorage", storage)
    storage.setItem(RATE_LIMIT_KEY, String(Date.now() + 10 * 3_600_000))
    let sends = 0
    startTelemetryWith(testConfig({ makeTransport: () => ({ send: async () => (++sends, { statusCode: 200 }), flush: async () => true }) }))
    // the stored value was rewritten to the cap, so a later open re-reads a sane one
    expect(Number(storage.getItem(RATE_LIMIT_KEY))).toBeLessThanOrEqual(Date.now() + 3_600_000)
    const id = "a1".repeat(16)
    const delivery = expectDelivery(id, 4_000_000)
    Sentry.captureEvent({ message: "after reload" }, { event_id: id })
    await vi.advanceTimersByTimeAsync(3_599_000)
    expect(sends).toBe(0)
    await vi.advanceTimersByTimeAsync(1_000)
    await expect(delivery).resolves.toBe(true)
    expect(sends).toBe(1)
    vi.useRealTimers()
  })

  it("persists at most one hour of a longer Retry-After, but honors all of it in the session", async () => {
    vi.useFakeTimers()
    const storage = new MemoryStorage()
    vi.stubGlobal("localStorage", storage)
    let sends = 0
    const factory: TransportFactory = () => ({
      send: async () => (++sends === 1 ? { statusCode: 429, headers: { "retry-after": "7200", "x-sentry-rate-limits": null } } : { statusCode: 200 }),
      flush: async () => true,
    })
    startTelemetryWith(testConfig({ makeTransport: factory }))
    const id = "a2".repeat(16)
    const delivery = expectDelivery(id, 8_000_000)
    Sentry.captureEvent({ message: "long" }, { event_id: id })
    await vi.advanceTimersByTimeAsync(1)
    expect(sends).toBe(1)
    expect(Number(storage.getItem(RATE_LIMIT_KEY))).toBeLessThanOrEqual(Date.now() + 3_600_000)
    await vi.advanceTimersByTimeAsync(7_198_998)
    expect(sends).toBe(1)
    await vi.advanceTimersByTimeAsync(1_001)
    await expect(delivery).resolves.toBe(true)
    expect(sends).toBe(2)
    vi.useRealTimers()
  })

  it.each([
    ["5xx", 503],
    ["4xx", 403],
  ] as const)("keeps the %s class for a status carrying Retry-After, and still holds the barrier", async (reason, statusCode) => {
    vi.useFakeTimers()
    const failed = vi.spyOn(deliveryHealthObserver, "failed")
    let sends = 0
    const factory: TransportFactory = () => ({
      send: async () => (++sends === 1 ? { statusCode, headers: { "retry-after": "30", "x-sentry-rate-limits": null } } : { statusCode: 200 }),
      flush: async () => true,
    })
    startTelemetryWith(testConfig({ makeTransport: factory }))
    const id = "a3".repeat(16)
    const delivery = expectDelivery(id, 60_000)
    Sentry.captureEvent({ message: "status class" }, { event_id: id })
    await vi.advanceTimersByTimeAsync(29_999)
    expect(sends).toBe(1)
    expect(failed.mock.calls.map(([why]) => why)).toEqual([reason])
    await vi.advanceTimersByTimeAsync(1)
    await expect(delivery).resolves.toBe(true)
    expect(sends).toBe(2)
    failed.mockRestore()
    vi.useRealTimers()
  })

  it.each([
    ["a garbage entry", "soon:error:org"],
    ["an empty entry beside a short one", "5:error:org,"],
  ])("treats %s in x-sentry-rate-limits as sixty seconds, as Sentry does", async (_name, header) => {
    vi.useFakeTimers()
    let sends = 0
    const factory: TransportFactory = () => ({
      send: async () => (++sends === 1 ? { statusCode: 429, headers: { "x-sentry-rate-limits": header, "retry-after": "5" } } : { statusCode: 200 }),
      flush: async () => true,
    })
    startTelemetryWith(testConfig({ makeTransport: factory }))
    const id = "a4".repeat(16)
    const delivery = expectDelivery(id, 120_000)
    Sentry.captureEvent({ message: "garbage" }, { event_id: id })
    await vi.advanceTimersByTimeAsync(59_999)
    expect(sends).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    await expect(delivery).resolves.toBe(true)
    expect(sends).toBe(2)
    vi.useRealTimers()
  })

  it.each([
    ["a 429", { statusCode: 429 }, 60_000],
    ["a 5xx", { statusCode: 503 }, 1_000],
    ["the SDK's rate-limit drop", {}, 60_000],
  ])("keeps delivery open and retries after %s", async (_name, firstAnswer, delay) => {
    vi.useFakeTimers()
    let sends = 0
    const factory: TransportFactory = () => ({
      send: async () => (++sends <= 3 ? firstAnswer : { statusCode: 200 }),
      flush: async () => true,
    })
    startTelemetryWith(testConfig({ makeTransport: factory }))
    const ids = ["1", "2", "3"].map((d) => d.repeat(32))
    const deliveries = ids.map((id) => expectDelivery(id, 120_000))
    ids.forEach((id, i) => Sentry.captureEvent({ message: `sent ${i}` }, { event_id: id }))
    await vi.advanceTimersByTimeAsync(delay)
    await expect(Promise.all(deliveries)).resolves.toEqual([true, true, true])
    expect(sends).toBe(6)
    vi.useRealTimers()
  })

  it("retries a thrown online send and keeps the session open", async () => {
    let sends = 0
    const factory: TransportFactory = () => ({
      send: async () => {
        sends += 1
        if (sends === 1) throw new TypeError("Failed to fetch")
        return { statusCode: 200 }
      },
      flush: async () => true,
    })
    startTelemetryWith(testConfig({ makeTransport: factory }))
    const ids = ["1", "2", "3"].map((d) => d.repeat(32))
    const deliveries = ids.map((id) => expectDelivery(id, 5000))
    ids.forEach((id, i) => Sentry.captureEvent({ message: `held ${i}` }, { event_id: id }))
    await expect(Promise.all(deliveries)).resolves.toEqual([true, true, true])
    expect(sends).toBe(4)
    const late = "4".repeat(32)
    const lateDelivery = expectDelivery(late, 5000)
    Sentry.captureEvent({ message: "late" }, { event_id: late })
    await expect(lateDelivery).resolves.toBe(true)
    expect(sends).toBe(5)
    await expect(Sentry.flush(500)).resolves.toBeDefined()
  })

  it("holds what a send threw while offline, and drains it on the window's online", async () => {
    const page = new EventTarget()
    const nav = { onLine: false }
    vi.stubGlobal("window", page)
    vi.stubGlobal("navigator", nav)
    const sent: string[] = []
    const factory: TransportFactory = () => ({
      send: async (envelope) => {
        if (!nav.onLine) throw new TypeError("Failed to fetch")
        sent.push(String(envelope[0].event_id))
        return { statusCode: 200 }
      },
      flush: async () => true,
    })
    startTelemetryWith(testConfig({ makeTransport: factory }))
    const ids = ["1", "2"].map((d) => d.repeat(32))
    const deliveries = ids.map((id) => expectDelivery(id, 5000))
    ids.forEach((id, i) => Sentry.captureEvent({ message: `offline ${i}` }, { event_id: id }))
    await Sentry.flush(200)
    expect(sent).toEqual([])
    nav.onLine = true
    page.dispatchEvent(new Event("online"))
    await expect(Promise.all(deliveries)).resolves.toEqual([true, true])
    expect(sent).toEqual(ids)
  })

  it("deduplicates a repeated event id while its offline envelope is held", async () => {
    const page = new EventTarget()
    const nav = { onLine: false }
    vi.stubGlobal("window", page)
    vi.stubGlobal("navigator", nav)
    let sends = 0
    const factory: TransportFactory = () => ({
      send: async () => {
        sends += 1
        if (!nav.onLine) throw new TypeError("Failed to fetch")
        return { statusCode: 200 }
      },
      flush: async () => true,
    })
    startTelemetryWith(testConfig({ makeTransport: factory }))
    const id = "d".repeat(32)
    Sentry.captureEvent({ message: "game-log-chunk", level: "info" }, { event_id: id })
    const repeatedDelivery = expectDelivery(id, 5_000)
    Sentry.captureEvent({ message: "game-log-chunk", level: "info" }, { event_id: id })
    await vi.waitFor(() => expect(sends).toBe(1))
    await new Promise((resolve) => setTimeout(resolve, 0))
    nav.onLine = true
    page.dispatchEvent(new Event("online"))
    await vi.waitFor(() => expect(sends).toBe(2))
    await expect(repeatedDelivery).resolves.toBe(true)
  })

  it("retries a block after the first successful request without losing later envelopes", async () => {
    let sends = 0
    const factory: TransportFactory = () => ({
      send: async () => {
        sends += 1
        if (sends === 2) throw new TypeError("Failed to fetch")
        return { statusCode: 200 }
      },
      flush: async () => true,
    })
    startTelemetryWith(testConfig({ makeTransport: factory }))
    const ids = ["5", "6", "7", "8"].map((d) => d.repeat(32))
    const deliveries = ids.map((id) => expectDelivery(id, 5000))
    ids.forEach((id, i) => Sentry.captureEvent({ message: `held ${i}` }, { event_id: id }))
    await expect(Promise.all(deliveries)).resolves.toEqual([true, true, true, true])
    expect(sends).toBe(5)
  })

  it("resolves false at its deadline", async () => {
    startTelemetryWith(testConfig({ makeTransport: recordingTransport().factory }))
    await expect(expectDelivery("00000000000000000000000000000000", 10)).resolves.toBe(false)
  })
})

describe("the confirmed log sender", () => {
  it("exports the two lane names and resolves true on an unrestricted 2xx", async () => {
    const sink = recordingTransport()
    startTelemetryWith(testConfig({ makeTransport: sink.factory, testTag: "e2e-log" }))

    expect(EVENT_LANE).toBe("event")
    expect(LOG_LANE).toBe("log")
    await expect(sendLogEnvelope("ok", [logRecord()])).resolves.toBe(true)
    expect(sink.items("log")).toHaveLength(1)
    expect(sink.items("log")[0]?.payload.items[0].attributes).toMatchObject({
      "sentry.release": { type: "string", value: "jollity@test" },
      "sentry.environment": { type: "string", value: "dim2-pr126-sandbox00.paseo" },
      "test.tag": { type: "string", value: "e2e-log" },
    })
  })

  it.each(["log_item", "log_byte"])("treats a 2xx %s limit as loss and holds only the log lane", async (category) => {
    vi.useFakeTimers()
    const sent: string[] = []
    let sends = 0
    const factory: TransportFactory = () => ({
      send: async (envelope) => {
        sent.push(envelopeLane(envelope))
        sends += 1
        return sends === 1
          ? { statusCode: 200, headers: { "x-sentry-rate-limits": `60:${category}:organization`, "retry-after": null } }
          : { statusCode: 200 }
      },
      flush: async () => true,
    })
    startTelemetryWith(testConfig({ makeTransport: factory }))

    await expect(sendLogEnvelope("limited", [logRecord()])).resolves.toBe(false)
    const held = sendLogEnvelope("held", [logRecord("held")])
    const eventId = "b".repeat(32)
    const event = expectDelivery(eventId, 120_000)
    Sentry.captureEvent({ message: "event lane remains open" }, { event_id: eventId })
    await settleMicrotasks()
    expect(sent).toEqual([LOG_LANE, EVENT_LANE])
    await expect(event).resolves.toBe(true)
    await vi.advanceTimersByTimeAsync(59_999)
    expect(sent).toEqual([LOG_LANE, EVENT_LANE])
    await vi.advanceTimersByTimeAsync(1)
    await expect(held).resolves.toBe(true)
    expect(sent).toEqual([LOG_LANE, EVENT_LANE, LOG_LANE])
  })

  it("holds both lanes for a category-less 2xx limit", async () => {
    vi.useFakeTimers()
    const sent: string[] = []
    let sends = 0
    const factory: TransportFactory = () => ({
      send: async (envelope) => {
        sent.push(envelopeLane(envelope))
        sends += 1
        return sends === 1
          ? { statusCode: 200, headers: { "x-sentry-rate-limits": "60::organization", "retry-after": null } }
          : { statusCode: 200 }
      },
      flush: async () => true,
    })
    startTelemetryWith(testConfig({ makeTransport: factory }))

    await expect(sendLogEnvelope("all", [logRecord()])).resolves.toBe(false)
    const heldLog = sendLogEnvelope("all-next", [logRecord("held")])
    const eventId = "c".repeat(32)
    const heldEvent = expectDelivery(eventId, 120_000)
    Sentry.captureEvent({ message: "event held too" }, { event_id: eventId })
    await settleMicrotasks()
    expect(sent).toEqual([LOG_LANE])
    await vi.advanceTimersByTimeAsync(59_999)
    expect(sent).toEqual([LOG_LANE])
    await vi.advanceTimersByTimeAsync(1)
    await expect(Promise.all([heldLog, heldEvent])).resolves.toEqual([true, true])
    expect(sent.slice(1).sort()).toEqual([EVENT_LANE, LOG_LANE])
  })

  it("delivers a log under an error-only 2xx limit and holds only the event lane", async () => {
    vi.useFakeTimers()
    const sent: string[] = []
    let sends = 0
    const factory: TransportFactory = () => ({
      send: async (envelope) => {
        sent.push(envelopeLane(envelope))
        sends += 1
        return sends === 1
          ? { statusCode: 200, headers: { "x-sentry-rate-limits": "60:error:organization", "retry-after": null } }
          : { statusCode: 200 }
      },
      flush: async () => true,
    })
    startTelemetryWith(testConfig({ makeTransport: factory }))

    await expect(sendLogEnvelope("error-limit", [logRecord()])).resolves.toBe(true)
    await expect(sendLogEnvelope("error-limit-next", [logRecord("still open")])).resolves.toBe(true)
    const eventId = "d".repeat(32)
    const heldEvent = expectDelivery(eventId, 120_000)
    Sentry.captureEvent({ message: "held event" }, { event_id: eventId })
    await settleMicrotasks()
    expect(sent).toEqual([LOG_LANE, LOG_LANE])
    await vi.advanceTimersByTimeAsync(60_000)
    await expect(heldEvent).resolves.toBe(true)
    expect(sent).toEqual([LOG_LANE, LOG_LANE, EVENT_LANE])
  })

  it("keeps a long log limit from lengthening a short event limit", async () => {
    vi.useFakeTimers()
    const sent: string[] = []
    let sends = 0
    const factory: TransportFactory = () => ({
      send: async (envelope) => {
        sent.push(envelopeLane(envelope))
        sends += 1
        return sends === 1
          ? { statusCode: 200, headers: { "x-sentry-rate-limits": "3600:log_byte:organization,60:error:organization", "retry-after": null } }
          : { statusCode: 200 }
      },
      flush: async () => true,
    })
    startTelemetryWith(testConfig({ makeTransport: factory }))

    await expect(sendLogEnvelope("mixed-log-long", [logRecord()])).resolves.toBe(false)
    const heldLog = sendLogEnvelope("mixed-log-long-next", [logRecord("held log")])
    const eventId = "e".repeat(32)
    const heldEvent = expectDelivery(eventId, 4_000_000)
    Sentry.captureEvent({ message: "short event limit" }, { event_id: eventId })
    await settleMicrotasks()
    expect(sent).toEqual([LOG_LANE])

    await vi.advanceTimersByTimeAsync(60_000)
    await expect(heldEvent).resolves.toBe(true)
    expect(sent).toEqual([LOG_LANE, EVENT_LANE])
    await vi.advanceTimersByTimeAsync(3_539_999)
    expect(sent).toEqual([LOG_LANE, EVENT_LANE])
    await vi.advanceTimersByTimeAsync(1)
    await expect(heldLog).resolves.toBe(true)
    expect(sent).toEqual([LOG_LANE, EVENT_LANE, LOG_LANE])
  })

  it("keeps a long event limit from lengthening a short log limit", async () => {
    vi.useFakeTimers()
    const sent: string[] = []
    let sends = 0
    const factory: TransportFactory = () => ({
      send: async (envelope) => {
        sent.push(envelopeLane(envelope))
        sends += 1
        return sends === 1
          ? { statusCode: 200, headers: { "x-sentry-rate-limits": "3600:error;attachment:organization,60:log_item:organization", "retry-after": null } }
          : { statusCode: 200 }
      },
      flush: async () => true,
    })
    startTelemetryWith(testConfig({ makeTransport: factory }))

    await expect(sendLogEnvelope("mixed-event-long", [logRecord()])).resolves.toBe(false)
    const heldLog = sendLogEnvelope("mixed-event-long-next", [logRecord("short log limit")])
    const eventId = "f".repeat(32)
    const heldEvent = expectDelivery(eventId, 4_000_000)
    Sentry.captureEvent({ message: "long event limit" }, { event_id: eventId })
    await settleMicrotasks()
    expect(sent).toEqual([LOG_LANE])

    await vi.advanceTimersByTimeAsync(60_000)
    await expect(heldLog).resolves.toBe(true)
    expect(sent).toEqual([LOG_LANE, LOG_LANE])
    await vi.advanceTimersByTimeAsync(3_539_999)
    expect(sent).toEqual([LOG_LANE, LOG_LANE])
    await vi.advanceTimersByTimeAsync(1)
    await expect(heldEvent).resolves.toBe(true)
    expect(sent).toEqual([LOG_LANE, LOG_LANE, EVENT_LANE])
  })

  it("honors Retry-After on a 429 log and resolves false after bounded retries", async () => {
    vi.useFakeTimers()
    let sends = 0
    const factory: TransportFactory = () => ({
      send: async () => {
        sends += 1
        return { statusCode: 429, headers: { "retry-after": "30", "x-sentry-rate-limits": null } }
      },
      flush: async () => true,
    })
    startTelemetryWith(testConfig({ makeTransport: factory }))

    const delivery = sendLogEnvelope("429", [logRecord()])
    await settleMicrotasks()
    expect(sends).toBe(1)
    await vi.advanceTimersByTimeAsync(29_999)
    expect(sends).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(sends).toBe(2)
    for (let attempt = 0; attempt < 4; attempt += 1) await vi.advanceTimersByTimeAsync(30_000)
    await expect(delivery).resolves.toBe(false)
    expect(sends).toBe(6)
  })

  it("resolves false after bounded retries when the real transport throws", async () => {
    vi.useFakeTimers()
    let sends = 0
    const factory: TransportFactory = () => ({
      send: async () => {
        sends += 1
        throw new TypeError("Failed to fetch")
      },
      flush: async () => true,
    })
    startTelemetryWith(testConfig({ makeTransport: factory }))

    const delivery = sendLogEnvelope("throwing", [logRecord()])
    await vi.advanceTimersByTimeAsync(30_000)
    await expect(delivery).resolves.toBe(false)
    expect(sends).toBe(6)
  })

  it("marks a 413 rejection for one-time consumption", async () => {
    const sink = recordingTransport(413)
    startTelemetryWith(testConfig({ makeTransport: sink.factory }))

    await expect(sendLogEnvelope("too-large", [logRecord()])).resolves.toBe(false)
    expect(takeLogRejected("too-large")).toBe(true)
    expect(takeLogRejected("too-large")).toBe(false)
  })

  it("coalesces a pending key and permits that key again after settle", async () => {
    let answer: ((response: { statusCode: number }) => void) | undefined
    let sends = 0
    const factory: TransportFactory = () => ({
      send: () => {
        sends += 1
        return new Promise((resolve) => (answer = resolve))
      },
      flush: async () => true,
    })
    startTelemetryWith(testConfig({ makeTransport: factory }))

    const first = sendLogEnvelope("same", [logRecord()])
    const second = sendLogEnvelope("same", [logRecord("ignored duplicate")])
    expect(second).toBe(first)
    expect(sends).toBe(1)
    answer?.({ statusCode: 200 })
    await expect(Promise.all([first, second])).resolves.toEqual([true, true])
    await settleMicrotasks()

    const third = sendLogEnvelope("same", [logRecord("new attempt")])
    expect(sends).toBe(2)
    answer?.({ statusCode: 200 })
    await expect(third).resolves.toBe(true)
  })

  it("splits records over 48 KB and returns false when any envelope fails", async () => {
    let sends = 0
    const factory: TransportFactory = () => ({
      send: async () => ({ statusCode: ++sends === 1 ? 200 : 413 }),
      flush: async () => true,
    })
    startTelemetryWith(testConfig({ makeTransport: factory }))
    const records = [logRecord("a".repeat(30_000)), logRecord("b".repeat(30_000))]

    await expect(sendLogEnvelope("split", records)).resolves.toBe(false)
    expect(sends).toBe(2)
    expect(takeLogRejected("split")).toBe(true)
  })

  it("returns true when every envelope in a split item succeeds", async () => {
    const sink = recordingTransport()
    startTelemetryWith(testConfig({ makeTransport: sink.factory }))
    const records = [logRecord("a".repeat(30_000)), logRecord("b".repeat(30_000))]

    await expect(sendLogEnvelope("split-ok", records)).resolves.toBe(true)
    expect(sink.items("log")).toHaveLength(2)
  })
})

describe("the repeat cap", () => {
  it("sends at most 5 events of one fingerprint a session, and counts others apart", async () => {
    const sink = recordingTransport()
    startTelemetryWith(testConfig({ makeTransport: sink.factory }))
    for (let i = 0; i < 8; i += 1) Sentry.captureEvent({ message: `tick ${i}`, fingerprint: ["peer-failed", "failed"] })
    Sentry.captureEvent({ message: "other", fingerprint: ["report-failed", "failed"] })
    await Sentry.flush(1000)
    const messages = sink.items("event").map((item) => item.payload.message)
    expect(messages).toEqual(["tick 0", "tick 1", "tick 2", "tick 3", "tick 4", "other"])
  })

  it("keys an error the SDK caught by its type and message", async () => {
    const sink = recordingTransport()
    startTelemetryWith(testConfig({ makeTransport: sink.factory }))
    for (let i = 0; i < 7; i += 1) Sentry.captureException(new TypeError("x is undefined"))
    Sentry.captureException(new TypeError("y is undefined"))
    await Sentry.flush(1000)
    const values = sink.items("event").map((item) => item.payload.exception.values[0].value)
    expect(values.filter((value) => value === "x is undefined")).toHaveLength(5)
    expect(values).toContain("y is undefined")
  })

  it("leaves info events alone: a game log per game is not a repeat", async () => {
    const sink = recordingTransport()
    startTelemetryWith(testConfig({ makeTransport: sink.factory }))
    for (let i = 0; i < 7; i += 1) Sentry.captureEvent({ message: "log", level: "info", fingerprint: ["game-log"] })
    await Sentry.flush(1000)
    expect(sink.items("event")).toHaveLength(7)
  })

  it("starts again after a reset", async () => {
    let sink = recordingTransport()
    startTelemetryWith(testConfig({ makeTransport: sink.factory }))
    for (let i = 0; i < 5; i += 1) Sentry.captureEvent({ message: "tick", fingerprint: ["same"] })
    await Sentry.flush(1000)
    await resetTelemetryForTests()
    sink = recordingTransport()
    startTelemetryWith(testConfig({ makeTransport: sink.factory }))
    Sentry.captureEvent({ message: "tick", fingerprint: ["same"] })
    await Sentry.flush(1000)
    expect(sink.items("event")).toHaveLength(1)
  })
})

describe("the config from the build", () => {
  function browser() {
    vi.stubGlobal("window", { innerWidth: 390, innerHeight: 844, __HOST_API_PORT__: {} })
    vi.stubGlobal("location", { hostname: "dim2.paseo", protocol: "https:" })
    vi.stubGlobal("navigator", { userAgent: "iPhone", maxTouchPoints: 5, language: "en-GB" })
  }

  it("reads the DSN, release and page", () => {
    browser()
    vi.stubEnv("NEXT_PUBLIC_SENTRY_DSN", "https://key@o1.ingest.de.sentry.io/42")
    expect(configFromEnvironment()).toMatchObject({
      dsn: "https://key@o1.ingest.de.sentry.io/42",
      release: expect.stringMatching(/^jollity@/),
      hostname: "dim2.paseo",
      inContainer: true,
      viewport: "390x844",
    })
  })

  it("is null without a DSN", () => {
    browser()
    vi.stubEnv("NEXT_PUBLIC_SENTRY_DSN", "")
    expect(configFromEnvironment()).toBeNull()
  })

  it("keeps telemetry off without a DSN, whatever the test tag says", () => {
    browser()
    vi.stubEnv("NEXT_PUBLIC_SENTRY_DSN", "")
    vi.stubEnv("NEXT_PUBLIC_SENTRY_DSN_TEST", "")
    vi.stubEnv("NEXT_PUBLIC_SENTRY_TAG", "e2e-run")
    expect(configFromEnvironment()).toBeNull()
  })

  it("a localhost page writes to the test project when the build has one", () => {
    browser()
    vi.stubGlobal("location", { hostname: "localhost", protocol: "http:" })
    vi.stubEnv("NEXT_PUBLIC_SENTRY_DSN", "https://key@o1.ingest.de.sentry.io/42")
    vi.stubEnv("NEXT_PUBLIC_SENTRY_DSN_TEST", "https://test@o1.ingest.de.sentry.io/43")
    expect(configFromEnvironment()?.dsn).toBe("https://test@o1.ingest.de.sentry.io/43")
  })

  it("a hosted dim2.paseo or dim2.testnet page writes to production even with a stale tag baked in", () => {
    browser()
    vi.stubEnv("NEXT_PUBLIC_SENTRY_DSN", "https://key@o1.ingest.de.sentry.io/42")
    vi.stubEnv("NEXT_PUBLIC_SENTRY_DSN_TEST", "https://test@o1.ingest.de.sentry.io/43")
    expect(configFromEnvironment()?.dsn).toBe("https://key@o1.ingest.de.sentry.io/42")
    vi.stubEnv("NEXT_PUBLIC_SENTRY_TAG", "e2e-run")
    expect(configFromEnvironment()).toMatchObject({ dsn: "https://key@o1.ingest.de.sentry.io/42", testTag: "e2e-run" })
    vi.stubGlobal("location", { hostname: "dim2.testnet", protocol: "https:" })
    expect(configFromEnvironment()?.dsn).toBe("https://key@o1.ingest.de.sentry.io/42")
  })

  it("a scripted run's localhost page writes to the test project with its tag", () => {
    browser()
    vi.stubGlobal("location", { hostname: "localhost", protocol: "http:" })
    vi.stubEnv("NEXT_PUBLIC_SENTRY_DSN", "https://key@o1.ingest.de.sentry.io/42")
    vi.stubEnv("NEXT_PUBLIC_SENTRY_DSN_TEST", "https://test@o1.ingest.de.sentry.io/43")
    vi.stubEnv("NEXT_PUBLIC_SENTRY_TAG", "e2e-run")
    expect(configFromEnvironment()).toMatchObject({ dsn: "https://test@o1.ingest.de.sentry.io/43", testTag: "e2e-run" })
  })

  it("a test DSN alone switches a localhost page on and leaves dim2.paseo off", () => {
    browser()
    vi.stubEnv("NEXT_PUBLIC_SENTRY_DSN", "")
    vi.stubEnv("NEXT_PUBLIC_SENTRY_DSN_TEST", "https://test@o1.ingest.de.sentry.io/43")
    expect(configFromEnvironment()).toBeNull()
    vi.stubGlobal("location", { hostname: "localhost", protocol: "http:" })
    expect(configFromEnvironment()?.dsn).toBe("https://test@o1.ingest.de.sentry.io/43")
  })

})

describe("the device and the connection", () => {
  const conn = {
    type: "cellular",
    effectiveType: "4g",
    downlink: 9.5,
    rtt: 100,
    saveData: false,
    listeners: [] as Array<() => void>,
    addEventListener(_: string, fn: () => void) {
      this.listeners.push(fn)
    },
    removeEventListener(_: string, fn: () => void) {
      this.listeners.splice(this.listeners.indexOf(fn), 1)
    },
  }
  const ANDROID_WV =
    "Mozilla/5.0 (Linux; Android 16; SM-S918B Build/BP4A.251205.006; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/154.0.8037.57 Mobile Safari/537.36"

  beforeEach(() => {
    conn.effectiveType = "4g"
    conn.listeners.length = 0
    vi.stubGlobal("navigator", { userAgent: ANDROID_WV, maxTouchPoints: 5, hardwareConcurrency: 8, deviceMemory: 8, connection: conn })
    vi.stubGlobal("screen", { width: 412, height: 915 })
  })

  async function capture(config = testConfig({ userAgent: ANDROID_WV })) {
    const sink = recordingTransport()
    expect(startTelemetryWith({ ...config, makeTransport: sink.factory })).toBe(true)
    // the profile arrives asynchronously, after startTelemetryWith returned
    await vi.waitFor(() => expect(Sentry.getIsolationScope().getScopeData().tags["device.os"]).toBe("android"))
    Sentry.captureMessage("probe")
    await Sentry.flush(1000)
    return sink.items("event")[0]
  }

  it("puts the device tags and the device_profile context on a captured event", async () => {
    const event = await capture()
    expect(event.payload.tags).toMatchObject({
      "device.os": "android",
      "device.os_version": "16",
      "device.model": "SM-S918B",
      "device.cores": "8",
      "device.memory": "8",
      "device.engine_version": "154",
      "net.type": "cellular",
      "net.effective": "4g",
    })
    expect(event.payload.contexts.device_profile).toMatchObject({
      os: "android",
      osVersion: "16",
      engine: "chromium-webview",
      model: "SM-S918B",
      modelSource: "ua",
      screen: "412x915",
    })
  })

  // issue 231: Sentry's own user-agent parser cut "motorola edge 30 pro Build/…; wv"
  // into model "rola edge 30 pro Build/…; wv". A device context we send is kept.
  it("sends Sentry its device context, so its user-agent parser does not fill it", async () => {
    const motorola =
      "Mozilla/5.0 (Linux; Android 14; motorola edge 30 pro Build/U1SHS34.1-177-6-4; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/153.0.0.0 Mobile Safari/537.36"
    vi.stubGlobal("navigator", { userAgent: motorola, maxTouchPoints: 5, hardwareConcurrency: 8, connection: conn })
    const event = await capture(testConfig({ userAgent: motorola }))
    expect(event.payload.contexts.device).toEqual({ model: "motorola edge 30 pro", family: "motorola edge 30 pro" })
  })

  it("does not make startTelemetryWith wait for the profile", () => {
    const sink = recordingTransport()
    startTelemetryWith(testConfig({ makeTransport: sink.factory, userAgent: ANDROID_WV }))
    expect(Sentry.getIsolationScope().getScopeData().tags["device.os"]).toBeUndefined()
    expect(Sentry.getIsolationScope().getScopeData().tags["net.type"]).toBe("cellular")
  })

  it("follows the connection's change event", async () => {
    await capture()
    conn.effectiveType = "2g"
    conn.listeners[0]()
    expect(Sentry.getIsolationScope().getScopeData().tags["net.effective"]).toBe("2g")
  })

  it("stops following when reset", async () => {
    await capture()
    await resetTelemetryForTests()
    expect(conn.listeners).toHaveLength(0)
  })

  it("starts without navigator.connection", async () => {
    vi.stubGlobal("navigator", { userAgent: ANDROID_WV, maxTouchPoints: 5 })
    const event = await capture()
    expect(event.payload.tags["device.os"]).toBe("android")
    expect(event.payload.tags["net.type"]).toBeUndefined()
  })

  it("reads the GPU when the page is idle, never on the boot path, and tags it", async () => {
    const idle: Array<() => void> = []
    vi.stubGlobal("requestIdleCallback", (fn: () => void) => idle.push(fn))
    const gl = {
      getExtension: (name: string) =>
        name === "WEBGL_debug_renderer_info" ? { UNMASKED_RENDERER_WEBGL: 1 } : name === "WEBGL_lose_context" ? { loseContext() {} } : null,
      getParameter: () => "ANGLE (Qualcomm, Adreno (TM) 740, OpenGL ES 3.2)",
    }
    const createElement = vi.fn(() => ({ getContext: () => gl }))
    vi.stubGlobal("document", { createElement, addEventListener() {}, removeEventListener() {}, visibilityState: "visible" })
    await capture()
    expect(createElement).not.toHaveBeenCalled()
    expect(Sentry.getIsolationScope().getScopeData().tags["device.gpu"]).toBeUndefined()
    expect(idle).toHaveLength(1)
    idle[0]()
    expect(Sentry.getIsolationScope().getScopeData().tags["device.gpu"]).toBe("Adreno 740")
  })

  it("tags what mediaCapabilities says of each codec once the page is idle, and the full answers as context", async () => {
    const idle: Array<() => void> = []
    vi.stubGlobal("requestIdleCallback", (fn: () => void) => idle.push(fn))
    const info = async (config: { video: { contentType: string } }) => ({ supported: true, smooth: true, powerEfficient: config.video.contentType.includes("VP8") })
    vi.stubGlobal("navigator", { userAgent: ANDROID_WV, maxTouchPoints: 5, mediaCapabilities: { encodingInfo: info, decodingInfo: info } })
    await capture()
    expect(Sentry.getIsolationScope().getScopeData().tags["rtc.cap.vp8.decode"]).toBeUndefined()
    idle[0]()
    await vi.waitFor(() => expect(Sentry.getIsolationScope().getScopeData().tags["rtc.cap.vp8.decode"]).toBe("hw"))
    expect(Sentry.getIsolationScope().getScopeData().tags["rtc.cap.h264.encode"]).toBe("sw")
    expect(Sentry.getIsolationScope().getScopeData().contexts.media_caps).toMatchObject({ "vp8.decode": { supported: true, powerEfficient: true } })
  })

  it("drops a GPU read still pending at a reset", async () => {
    const idle: Array<() => void> = []
    vi.stubGlobal("requestIdleCallback", (fn: () => void) => idle.push(fn))
    vi.stubGlobal("cancelIdleCallback", () => {})
    await capture()
    await resetTelemetryForTests()
    const createElement = vi.fn()
    vi.stubGlobal("document", { createElement, addEventListener() {}, removeEventListener() {}, visibilityState: "visible" })
    idle[0]?.()
    expect(createElement).not.toHaveBeenCalled()
  })
})

describe("recording why Sentry rate-limited a send", () => {
  const run = async (first: { statusCode?: number; headers?: { [key: string]: string | null; "x-sentry-rate-limits": string | null; "retry-after": string | null } }, message: string) => {
    vi.useFakeTimers()
    const limited = vi.spyOn(deliveryHealthObserver, "rateLimited")
    let sends = 0
    const factory: TransportFactory = () => ({
      send: async () => (++sends === 1 ? first : { statusCode: 200 }),
      flush: async () => true,
    })
    startTelemetryWith(testConfig({ makeTransport: factory }))
    const id = message.padEnd(32, "0").slice(0, 32)
    const delivery = expectDelivery(id, 120_000)
    Sentry.captureEvent({ message }, { event_id: id })
    await vi.advanceTimersByTimeAsync(61_000)
    await delivery
    const calls = limited.mock.calls.map(([info]) => info)
    limited.mockRestore()
    return calls
  }

  it("records a real 429 with its categories, scope and reason", async () => {
    const [info, ...rest] = await run(
      { statusCode: 429, headers: { "x-sentry-rate-limits": "60:error;attachment:organization:usage_exceeded", "retry-after": null } },
      "real429",
    )
    expect(rest).toEqual([])
    expect(info).toEqual({
      kind: "server_429",
      header: "60:error;attachment:organization:usage_exceeded",
      entries: [{ categories: ["error", "attachment"], scope: "organization", reason: "usage_exceeded" }],
    })
  })

  it("records a 2xx that carries the header as limited_2xx", async () => {
    const [info] = await run(
      { statusCode: 200, headers: { "x-sentry-rate-limits": "30::key:spike_protection", "retry-after": null } },
      "limited2xx",
    )
    expect(info).toEqual({
      kind: "limited_2xx",
      header: "30::key:spike_protection",
      entries: [{ categories: [], scope: "key", reason: "spike_protection" }],
    })
  })

  it("records a no-status answer as a local drop", async () => {
    const [info] = await run({}, "localdrop")
    expect(info).toEqual({ kind: "local_drop", entries: [] })
  })

  it("survives a malformed header: empty scope and reason, header kept", async () => {
    const [info] = await run(
      { statusCode: 429, headers: { "x-sentry-rate-limits": "soon", "retry-after": null } },
      "malformed",
    )
    expect(info).toEqual({ kind: "server_429", header: "soon", entries: [{ categories: [], scope: "", reason: "" }] })
  })

  it("truncates a huge raw header", async () => {
    const [info] = await run(
      { statusCode: 429, headers: { "x-sentry-rate-limits": `60:error:org:${"x".repeat(500)}`, "retry-after": null } },
      "hugeheader",
    )
    expect(info?.header?.length).toBe(200)
  })

  it("logs each distinct scope/reason/categories once per session", async () => {
    vi.useFakeTimers()
    clearDevLog()
    let sends = 0
    const same = { "x-sentry-rate-limits": "5:error:organization:usage_exceeded", "retry-after": null }
    const other = { "x-sentry-rate-limits": "5:error:key:spike_protection", "retry-after": null }
    const factory: TransportFactory = () => ({
      send: async () => (++sends <= 2 ? { statusCode: 429, headers: same } : sends === 3 ? { statusCode: 429, headers: other } : { statusCode: 200 }),
      flush: async () => true,
    })
    startTelemetryWith(testConfig({ makeTransport: factory }))
    const id = "d5".repeat(16)
    const delivery = expectDelivery(id, 120_000)
    Sentry.captureEvent({ message: "logonce" }, { event_id: id })
    await vi.advanceTimersByTimeAsync(30_000)
    await delivery
    expect(sends).toBe(4)
    const lines = getDevLogEntries().filter((entry) => entry.message.startsWith("Sentry rate limit"))
    expect(lines.map((entry) => entry.message)).toEqual([
      "Sentry rate limit (server_429): organization:usage_exceeded:error",
      "Sentry rate limit (server_429): key:spike_protection:error",
    ])
    expect(lines[0]).toMatchObject({ tag: "telemetry", level: "warn" })
  })
})
