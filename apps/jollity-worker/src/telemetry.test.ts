// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { beforeEach, describe, expect, it, vi } from "vitest"
import { isActionable as appIsActionable, type FailureKind } from "../../jollity-app/lib/telemetry/failures"
import {
  beginChatActivity,
  chatDsnFor,
  chatCount,
  chatEvent,
  chatFailure,
  chatJourney,
  chatMeasure,
  configureTelemetry,
  describeError,
  describeErrorChain,
  environmentFor,
  isActionable,
  isMalformedFrameError,
  isExpected,
  installGlobalErrorTelemetry,
  maskSafe,
  parseDsn,
  pendingSends,
  nameHostCallError,
  rejectionDetails,
  resetTelemetry,
  setChatGame,
  setChatHost,
  setChatUser,
  setChatUsername,
  type TelemetryConfig,
} from "./telemetry"

const DSN = "https://abc@o1.ingest.de.sentry.io/42"

function bodies(fetchMock: { mock: { calls: unknown[][] } }) {
  return fetchMock.mock.calls.map(([, init]) => (init as { body: string }).body.split("\n").map((l) => JSON.parse(l)))
}
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
const okFetch = () => vi.fn<NonNullable<TelemetryConfig["fetchImpl"]>>(async () => ({ status: 200 }))

beforeEach(() => resetTelemetry())

describe("parseDsn", () => {
  it("builds the envelope url", () => {
    expect(parseDsn(DSN)).toEqual({
      url: "https://o1.ingest.de.sentry.io/api/42/envelope/?sentry_key=abc&sentry_version=7",
      key: "abc",
      projectId: "42",
    })
  })
  it("is null for rubbish and empty", () => {
    expect(parseDsn("")).toBeNull()
    expect(parseDsn("nope")).toBeNull()
  })
})

describe("sending", () => {
  it("does nothing without a DSN", async () => {
    const fetchImpl = okFetch()
    configureTelemetry({ dsn: "", fetchImpl })
    chatEvent("x")
    chatCount("chat.start", {})
    chatJourney("game-signup").end("sent")
    await flush()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it("posts one event envelope with surface, environment, user, game and release", async () => {
    const fetchImpl = okFetch()
    configureTelemetry({ dsn: DSN, product: "dim2.paseo", release: "jollity-chat@abc1234", fetchImpl })
    setChatUser("5Gabc")
    setChatGame(7)
    setChatHost({ name: "Polkadot Mobile", version: "1.4.2" })
    chatEvent("hello", { level: "warning", tags: { a: "b" }, contexts: { c: { d: 1 } }, fingerprint: ["f"] })
    await flush()
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(fetchImpl.mock.calls[0]![0]).toBe("https://o1.ingest.de.sentry.io/api/42/envelope/?sentry_key=abc&sentry_version=7")
    const [header, item, event] = bodies(fetchImpl)[0]!
    expect(header.event_id).toMatch(/^[0-9a-f]{32}$/)
    expect(item).toEqual({ type: "event" })
    expect(event).toMatchObject({
      message: "hello",
      level: "warning",
      environment: "dim2.paseo",
      release: "jollity-chat@abc1234",
      fingerprint: ["f"],
      user: { id: "5Gabc" },
      tags: { surface: "chat", "game.index": "7", "host.app": "Polkadot Mobile", "host.app_version": "1.4.2", a: "b" },
      contexts: { c: { d: 1 } },
    })
  })

  it("carries the username with the user id once the worker knows it", async () => {
    const fetchImpl = okFetch()
    configureTelemetry({ dsn: DSN, fetchImpl })
    setChatUser("5Gabc")
    setChatUsername("carol.01")
    chatEvent("hello")
    await flush()
    expect(bodies(fetchImpl)[0]![2]).toMatchObject({ user: { id: "5Gabc", username: "carol.01" } })
  })

  it("never throws, even when fetch throws or rejects", async () => {
    configureTelemetry({
      dsn: DSN,
      fetchImpl: vi.fn(() => {
        throw new Error("boom")
      }),
    })
    expect(() => chatEvent("x")).not.toThrow()
    configureTelemetry({ dsn: DSN, fetchImpl: vi.fn(async () => Promise.reject(new Error("no"))) })
    expect(() => chatEvent("y")).not.toThrow()
    await flush()
  })

  it("keeps at most 3 sends in flight and drops the oldest past 50 queued", async () => {
    const release: (() => void)[] = []
    const fetchImpl = vi.fn(() => new Promise<{ status: number }>((resolve) => release.push(() => resolve({ status: 200 }))))
    configureTelemetry({ dsn: DSN, fetchImpl, maxPerFingerprint: 1000 })
    for (let i = 0; i < 80; i++) chatEvent(`m${i}`, { fingerprint: [`f${i}`] })
    expect(fetchImpl).toHaveBeenCalledTimes(3)
    expect(pendingSends()).toEqual({ inFlight: 3, queued: 50 })
    for (let i = 0; i < 100 && release.length; i++) {
      release.shift()!()
      await flush()
    }
    const sent = bodies(fetchImpl).map((b) => b[2].message)
    expect(sent.slice(0, 3)).toEqual(["m0", "m1", "m2"])
    // the 27 oldest of the queued ones were dropped
    expect(sent).toContain("m79")
    expect(sent).not.toContain("m3")
  })

  it("times out a hung send after 10 s and frees the slot", async () => {
    vi.useFakeTimers()
    try {
      const fetchImpl = vi.fn(() => new Promise<never>(() => {}))
      configureTelemetry({ dsn: DSN, fetchImpl })
      chatEvent("x")
      expect(pendingSends().inFlight).toBe(1)
      await vi.advanceTimersByTimeAsync(10_001)
      expect(pendingSends().inFlight).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it("rate-limits repeats of one fingerprint per run", async () => {
    const fetchImpl = okFetch()
    configureTelemetry({ dsn: DSN, fetchImpl, maxPerFingerprint: 2, maxPerCounter: 2 })
    for (let i = 0; i < 5; i++) chatCount("chat.nav", { target: "app" })
    chatCount("chat.other", {})
    await flush()
    expect(fetchImpl).toHaveBeenCalledTimes(3)
  })
})

describe("helpers", () => {
  it("chatCount sends a trace metric with the reader's identity and grouping attributes", async () => {
    const fetchImpl = okFetch()
    configureTelemetry({ dsn: DSN, product: "dim2.paseo", release: "jollity-chat@abc1234", fetchImpl })
    setChatUser("5Gabc")
    setChatUsername("carol.01")
    setChatGame(7)
    chatCount("chat.card.shown", { slot: "register", outcome: "sent", complete: "true" })
    await flush()
    const [header, item, payload] = bodies(fetchImpl)[0]!
    expect(header).toEqual({ sent_at: expect.any(String) })
    expect(item).toEqual({
      type: "trace_metric",
      item_count: 1,
      content_type: "application/vnd.sentry.items.trace-metric+json",
    })
    expect(payload).toEqual({
      version: 2,
      items: [{
        timestamp: expect.any(Number),
        trace_id: expect.stringMatching(/^[0-9a-f]{32}$/),
        name: "chat.card.shown",
        type: "counter",
        unit: "none",
        value: 1,
        attributes: expect.objectContaining({
          "sentry.environment": { value: "dim2.paseo", type: "string" },
          "sentry.release": { value: "jollity-chat@abc1234", type: "string" },
          "sentry.sdk.name": { value: "jollity.chat-worker", type: "string" },
          "sentry.sdk.version": { value: "1", type: "string" },
          "user.id": { value: "5Gabc", type: "string" },
          "user.name": { value: "carol.01", type: "string" },
          surface: { value: "chat", type: "string" },
          product: { value: "dim2.paseo", type: "string" },
          "game.index": { value: "7", type: "string" },
          slot: { value: "register", type: "string" },
          outcome: { value: "sent", type: "string" },
          complete: { value: "true", type: "string" },
        }),
      }],
    })
  })

  it("chatCount with detail sends a masked log after its metric", async () => {
    const fetchImpl = okFetch()
    configureTelemetry({ dsn: DSN, fetchImpl })
    chatCount("chat.storage.read_failed", { outcome: "failed" }, { detail: { error: "Unauthorized secret" } })
    await flush()
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    const sent = bodies(fetchImpl)
    expect(sent[0]![1].type).toBe("trace_metric")
    expect(sent[1]![1]).toEqual({ type: "log", item_count: 1, content_type: "application/vnd.sentry.items.log+json" })
    expect(sent[1]![2].items[0]).toMatchObject({
      body: "chat.storage.read_failed\t{\"error\":\"Unau*horized se*ret\"}",
      level: "info",
      severity_number: 9,
      trace_id: expect.stringMatching(/^[0-9a-f]{32}$/),
      attributes: { outcome: { value: "failed", type: "string" } },
    })
  })

  it("keeps capped Log detail valid JSON", async () => {
    const fetchImpl = okFetch()
    configureTelemetry({ dsn: DSN, fetchImpl })
    chatCount("chat.poll.failed", { reason: "threw" }, { detail: { error: `Error: ${"x".repeat(500)}` } })
    await flush()
    const body = bodies(fetchImpl)[1]![2].items[0].body as string
    const parsed = JSON.parse(body.slice(body.indexOf("\t") + 1))
    expect(parsed.error).toMatch(/^Error: x+$/)
    expect(parsed.error).toHaveLength(300)
  })

  it("keeps the 500-per-counter cap", async () => {
    const fetchImpl = okFetch()
    configureTelemetry({ dsn: DSN, fetchImpl })
    for (let i = 0; i < 501; i++) {
      chatCount("chat.start")
      if (i % 25 === 24) await flush()
    }
    await flush()
    expect(fetchImpl).toHaveBeenCalledTimes(500)
  })

  it("chatMeasure keeps the observation numeric on a transaction", async () => {
    const fetchImpl = okFetch()
    configureTelemetry({ dsn: DSN, fetchImpl })
    chatMeasure("chat.poll.duration_ms", 123.5, { stage: "read" })
    await flush()
    const [, item, event] = bodies(fetchImpl)[0]!
    expect(item).toEqual({ type: "transaction" })
    expect(event).toMatchObject({
      type: "transaction",
      transaction: "chat.poll.duration_ms",
      start_timestamp: expect.any(Number),
      tags: { "chat.measure": "chat.poll.duration_ms", stage: "read" },
      contexts: { trace: { trace_id: expect.stringMatching(/^[0-9a-f]{32}$/), span_id: expect.stringMatching(/^[0-9a-f]{16}$/) } },
      measurements: { "chat.poll.duration_ms": { value: 123.5, unit: "millisecond" } },
    })
  })

  it("keeps actionable chat failures as events", async () => {
    const fetchImpl = okFetch()
    configureTelemetry({ dsn: DSN, fetchImpl })
    chatFailure("chat-uncaught", "error", { error: "Unauthorized" }, { "failure.kind": "spoofed" })
    await flush()
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [, item, event] = bodies(fetchImpl)[0]!
    expect(item).toEqual({ type: "event" })
    expect(event).toMatchObject({
      message: "chat-uncaught: error",
      level: "error",
      fingerprint: ["chat-uncaught", "error"],
      tags: { "failure.kind": "chat-uncaught", "failure.reason": "error", "journey.expected": "false", surface: "chat" },
      contexts: { failure: { error: "Unau*horized" } },
    })
  })

  it("moves a non-actionable chat failure to one metric and one log", async () => {
    const fetchImpl = okFetch()
    configureTelemetry({ dsn: DSN, fetchImpl })
    chatFailure("draw-skipped", "missing", { skipped: "card", error: "Unauthorized" })
    await flush()
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    const sent = bodies(fetchImpl)
    expect(sent.filter((body) => body[1].type === "event")).toEqual([])
    expect(sent[0]![2].items[0]).toMatchObject({
      name: "failure",
      value: 1,
      attributes: {
        "failure.kind": { value: "draw-skipped", type: "string" },
        "failure.reason": { value: "missing", type: "string" },
        "journey.expected": { value: "true", type: "string" },
      },
    })
    expect(sent[1]![2].items[0]).toMatchObject({
      body: "draw-skipped: missing\t{\"skipped\":\"card\",\"error\":\"Unau*horized\"}",
      level: "info",
      trace_id: expect.stringMatching(/^[0-9a-f]{32}$/),
      attributes: {
        skipped: { value: "card", type: "string" },
        error: { value: "Unau*horized", type: "string" },
        "failure.kind": { value: "draw-skipped", type: "string" },
        "failure.reason": { value: "missing", type: "string" },
        "journey.expected": { value: "true", type: "string" },
      },
    })
  })

  it("chatJourney sends a transaction on end, once", async () => {
    const fetchImpl = okFetch()
    configureTelemetry({ dsn: DSN, product: "dim2.paseo", fetchImpl })
    const journey = chatJourney("game-signup", { "signup.attempt": "1" })
    journey.set({ "signup.route": "free" })
    journey.markSad("handoff")
    journey.end("failed", { "signup.stage": "x" })
    journey.end("sent")
    await flush()
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [, item, tx] = bodies(fetchImpl)[0]!
    expect(item).toEqual({ type: "transaction" })
    expect(tx).toMatchObject({
      type: "transaction",
      transaction: "journey.game-signup",
      environment: "dim2.paseo",
      tags: {
        surface: "chat",
        "journey.outcome": "failed",
        "journey.sad": "true",
        "journey.sad_reason": "handoff",
        "journey.expected": "false",
        "signup.attempt": "1",
        "signup.route": "free",
        "signup.stage": "x",
        "journey.duration_ms": expect.stringMatching(/^\d+$/),
      },
      contexts: { trace: { op: "journey.game-signup", trace_id: expect.stringMatching(/^[0-9a-f]{32}$/), span_id: expect.stringMatching(/^[0-9a-f]{16}$/) } },
    })
    expect(tx.timestamp).toBeGreaterThanOrEqual(tx.start_timestamp)
  })
})

describe("masking", () => {
  it("masks the words the org rule blanks", () => {
    expect(maskSafe("Unauthorized secret")).toBe("Unau*horized se*ret")
  })
  it("describeError keeps name and message, caps length, no stack", () => {
    const text = describeError(new Error("x".repeat(1000)))
    expect(text.startsWith("Error: x")).toBe(true)
    expect(text.length).toBeLessThanOrEqual(300)
    expect(describeError("plain")).toBe("plain")
    expect(describeError(undefined)).toBe("undefined")
  })
  it("describeErrorChain keeps five masked levels and caps their total length", () => {
    let error: Error = new Error("sixth")
    for (const message of ["fifth", "fourth", "third", "second", "top"]) error = new Error(message, { cause: error })
    const text = describeErrorChain(error)
    expect(text).toBe("Error: top <- Error: second <- Error: third <- Error: fourth <- Error: fifth")
    expect(text).not.toContain("sixth")
    expect(describeErrorChain(new Error("x".repeat(1_000))).length).toBeLessThanOrEqual(300)
  })
  it("recognizes MalformedFrame through a host error's nested payload", () => {
    const error = new Error("chat.postMessage failed", {
      cause: { tag: "Domain", value: { tag: "V1", value: { tag: "MalformedFrame", value: { reason: "wrong codec" } } } },
    })
    expect(isMalformedFrameError(error)).toBe(true)
    expect(isMalformedFrameError(new Error("permission denied"))).toBe(false)
  })
})

describe("environment, counters, cancelling and numbers", () => {
  it("files an event under the served name, not the baked product", async () => {
    const fetchImpl = okFetch()
    configureTelemetry({ dsn: DSN, product: "dim2.paseo", served: "worker.dim2next.paseo", fetchImpl })
    chatEvent("x")
    await flush()
    expect(bodies(fetchImpl)[0]![2].environment).toBe("dim2next.paseo")
    expect(bodies(fetchImpl)[0]![2].tags.product).toBe("dim2.paseo")
  })
  it("reads the served name by the app's rules and falls back to the baked one", () => {
    expect(environmentFor("worker.dim2-pr523-sandbox00.paseo", "dim2.paseo")).toBe("dim2-pr523-sandbox00.paseo")
    expect(environmentFor("dim2.app.paseo.li", "x")).toBe("dim2.paseo")
    expect(environmentFor("localhost", "dim2.paseo")).toBe("local")
    expect(environmentFor(undefined, "local")).toBe("local")
  })
  it("files a loopback worker as local, whatever the baked product says", () => {
    for (const host of ["localhost", "127.0.0.1", "[::1]", "::1", "0.0.0.0"]) {
      expect(environmentFor(host, "dim2.paseo")).toBe("local")
    }
    // A real worker origin keeps its served name (the checklist's trap).
    expect(environmentFor("worker.dim2next.paseo", "dim2.paseo")).toBe("dim2next.paseo")
  })
  it("keeps counting past the failure cap, and a once count goes once", async () => {
    const fetchImpl = okFetch()
    configureTelemetry({ dsn: DSN, fetchImpl, maxPerFingerprint: 1 })
    for (let i = 0; i < 20; i++) chatCount("chat.nav", { target: "app" })
    for (let i = 0; i < 3; i++) chatCount("chat.storage.read_failed", {}, { once: true })
    chatFailure("x", "y")
    chatFailure("x", "y")
    await flush()
    await flush()
    expect(fetchImpl).toHaveBeenCalledTimes(20 + 1 + 1)
  })
  it("aborts a send that timed out", async () => {
    vi.useFakeTimers()
    try {
      let signal: { aborted: boolean } | undefined
      const fetchImpl = vi.fn((_url: string, init: { signal?: unknown }) => {
        signal = init.signal as { aborted: boolean }
        return new Promise<never>(() => {})
      })
      configureTelemetry({ dsn: DSN, fetchImpl: fetchImpl as never })
      chatEvent("x")
      await vi.advanceTimersByTimeAsync(10_001)
      expect(signal?.aborted).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
  it("sends the numeric journey data as numbers and the tags as text", async () => {
    const fetchImpl = okFetch()
    configureTelemetry({ dsn: DSN, fetchImpl })
    chatJourney("game-signup", { "signup.attempt": "2" }).end("sent", { "signup.draws_entered": "3" })
    await flush()
    const tx = bodies(fetchImpl)[0]![2]
    expect(tx.contexts.trace.data).toMatchObject({ "signup.attempt": 2, "signup.draws_entered": 3, "journey.duration_ms": expect.any(Number), "journey.outcome": "sent" })
    expect(tx.tags["signup.attempt"]).toBe("2")
  })
  it("has one rule for expected failures", () => {
    expect(isExpected("signup-failed", "not-eligible")).toBe(true)
    expect(isExpected("signup-failed", "signing-refused")).toBe(true)
    expect(isExpected("signup-failed", "route")).toBe(false)
    expect(isExpected("name-link-failed", "unowned")).toBe(true)
  })
  it.each([
    ["render-crash", "render", true],
    ["report-failed", "refused", true],
    ["person-bind-failed", "proof", true],
    ["host-call-failed", "statements.allocation", true],
    ["draw-unplayable", "rule", true],
    ["art-failed", "preimage", true],
    ["signup-failed", "tx.broadcast", true],
    ["signup-failed", "signing-refused", false],
    ["permission-refused", "camera.failed", true],
    ["permission-refused", "camera.denied", false],
    ["camera-unavailable", "busy", true],
    ["camera-unavailable", "denied", false],
    ["camera-unavailable", "timeout", false],
    ["turn-unavailable", "bad-request", true],
    ["turn-unavailable", "proof-failed", true],
    ["turn-unavailable", "no-route", false],
    ["turn-unavailable", "proof-rejected", false],
    ["turn-unavailable", "config", false],
    ["turn-unavailable", "timeout", false],
    ["turn-unavailable", "future-network-cause", false],
    ["draw-skipped", "missing", false],
    ["mesh-isolated", "timeout", false],
    ["peer-failed", "failed", false],
    ["attestations-late", "late", false],
    ["clock-drift", "span-clock", false],
    ["unclean-exit", "pagehide", false],
    ["claim-failed", "cancelled", true],
    ["prize-topup-failed", "refused", true],
    ["chat-uncaught", "error", true],
    ["chat-render-failed", "intro-payload", true],
    ["chat-turn-pass-failed", "grant-missing", true],
    ["chat-turn-pass-failed", "timeout", false],
    ["future-failure", "unknown", true],
  ] as const)("keeps worker actionability in parity for %s %s", (kind, reason, actionable) => {
    expect(isActionable(kind, reason)).toBe(actionable)
    if (!kind.startsWith("chat-") && kind !== "future-failure") {
      expect(isActionable(kind, reason)).toBe(appIsActionable(kind as FailureKind, { reason }))
    }
  })
})

describe("global errors", () => {
  it("reports uncaught errors and rejected promises once per target", async () => {
    const fetchImpl = okFetch()
    configureTelemetry({ dsn: DSN, fetchImpl })
    const listeners = new Map<string, (event: unknown) => void>()
    const target = { addEventListener: vi.fn((name: string, listener: (event: unknown) => void) => listeners.set(name, listener)) }
    installGlobalErrorTelemetry(target)
    installGlobalErrorTelemetry(target)
    listeners.get("error")?.({ error: new Error("boom") })
    listeners.get("unhandledrejection")?.({ reason: new Error("nope") })
    await flush()
    expect(target.addEventListener).toHaveBeenCalledTimes(2)
    const sent = bodies(fetchImpl).map((body) => body[2])
    expect(sent.map((event) => event.message)).toEqual(["chat-uncaught: error", "chat-uncaught: rejection"])
    expect(sent[0].contexts.failure.error).toBe("Error: boom")
    expect(sent[0].contexts.failure.stack).toContain("Error: boom")
    expect(sent[1].tags).toMatchObject({ "error.class": "Error", "worker.activity": "idle" })
  })

  it("tags host request details, the owned call and current worker activity", async () => {
    const fetchImpl = okFetch()
    configureTelemetry({ dsn: DSN, fetchImpl })
    const listeners = new Map<string, (event: unknown) => void>()
    installGlobalErrorTelemetry({ addEventListener: (name: string, listener: (event: unknown) => void) => listeners.set(name, listener) })
    const finish = beginChatActivity("notification-booking")
    const error = nameHostCallError(new TypeError("host:42 failed on wire method 3"), "notifications.push")
    listeners.get("unhandledrejection")?.({ reason: error })
    finish()
    await flush()
    const event = bodies(fetchImpl)[0]![2]
    expect(event.tags).toMatchObject({
      "error.class": "TypeError",
      "host.request_id": "42",
      "host.wire_method": "3",
      "host.call": "notifications.push",
      "worker.activity": "notification-booking",
    })
    expect(event.contexts.failure).toMatchObject({
      error: "TypeError: host:42 failed on wire method 3",
      host_call: "notifications.push",
    })
    expect(event.contexts.failure.stack).toContain("TypeError: host:42 failed on wire method 3")
    expect(event.message).toBe("chat-uncaught: rejection")
  })

  it("keeps nested activities correct when they finish out of order", () => {
    const finishPoll = beginChatActivity("poll")
    const finishCard = beginChatActivity("card-draw")
    expect(rejectionDetails(new Error("x")).tags["worker.activity"]).toBe("card-draw")
    finishPoll()
    expect(rejectionDetails(new Error("x")).tags["worker.activity"]).toBe("card-draw")
    finishCard()
    expect(rejectionDetails(new Error("x")).tags["worker.activity"]).toBe("idle")
  })
})

describe("the test project (plan D8)", () => {
  const TEST = "https://test@o1.ingest.de.sentry.io/43"
  it("a local build or a localhost page writes to the test project", () => {
    expect(chatDsnFor({ served: undefined, product: "local", prod: DSN, test: TEST })).toBe(TEST)
    expect(chatDsnFor({ served: undefined, product: "", prod: DSN, test: TEST })).toBe(TEST)
    expect(chatDsnFor({ served: "localhost", product: "dim2.testnet", prod: DSN, test: TEST })).toBe(TEST)
    expect(chatDsnFor({ served: "127.0.0.1", product: "dim2.testnet", prod: DSN, test: TEST })).toBe(TEST)
  })
  it("a worker served by a real host keeps production", () => {
    expect(chatDsnFor({ served: "worker.dim2.paseo", product: "dim2.paseo", prod: DSN, test: TEST })).toBe(DSN)
    expect(chatDsnFor({ served: "worker.dim2.testnet", product: "dim2.testnet", prod: DSN, test: TEST })).toBe(DSN)
    expect(chatDsnFor({ served: undefined, product: "dim2.paseo", prod: DSN, test: TEST })).toBe(DSN)
    expect(chatDsnFor({ served: "", product: "dim2.paseo", prod: DSN, test: TEST })).toBe(DSN)
  })
  it("a hosted worker origin keeps production even when the build says local", () => {
    expect(chatDsnFor({ served: "worker.dim2.paseo", product: "local", prod: DSN, test: TEST })).toBe(DSN)
    expect(chatDsnFor({ served: "worker.dim2-pr523-sandbox00.paseo", product: "", prod: DSN, test: TEST })).toBe(DSN)
    // the served host is authoritative when known: any non-loopback host keeps production
    expect(chatDsnFor({ served: "worker.example.org", product: "", prod: DSN, test: TEST })).toBe(DSN)
    expect(chatDsnFor({ served: "10.0.0.5", product: "local", prod: DSN, test: TEST })).toBe(DSN)
    expect(chatDsnFor({ served: "localhost", product: "", prod: DSN, test: TEST })).toBe(TEST)
  })
  it("without a test DSN nothing changes", () => {
    expect(chatDsnFor({ served: "localhost", product: "local", prod: DSN, test: "" })).toBe(DSN)
    expect(chatDsnFor({ served: "localhost", product: "local", prod: DSN, test: "rubbish" })).toBe(DSN)
  })
  it("sends a local worker's events to the test project's envelope url", async () => {
    const fetchImpl = okFetch()
    configureTelemetry({ dsn: DSN, testDsn: TEST, product: "local", served: "localhost", fetchImpl })
    chatEvent("x")
    await flush()
    expect(fetchImpl.mock.calls[0]![0]).toContain("/api/43/envelope/")
    configureTelemetry({ dsn: DSN, testDsn: TEST, product: "dim2.paseo", served: "worker.dim2.paseo", fetchImpl })
    chatEvent("y")
    await flush()
    expect(fetchImpl.mock.calls[1]![0]).toContain("/api/42/envelope/")
  })
})

describe("the TURN pass failure classification works", () => {
  it.each([
    ["grant-missing", true],
    ["proof-refused", true],
    ["no-ring-key", true],
    ["key-list-failed", true],
    ["proof-threw", true],
    ["bad-request", true],
    ["proof-rejected", true],
    ["no-route", true],
    ["write-failed", true],
    ["threw", true],
    ["timeout", false],
    ["redemption-limit", false],
    ["no-ring-roots", false],
    ["server-error", false],
    ["timestamp-window", false],
    ["no-host", false],
    ["no-chain-info", false],
    ["no-accounts", false],
  ] as const)("files %s as actionable %s", (reason, actionable) => {
    // Given
    const kind = "chat-turn-pass-failed"

    // When
    const filed = isActionable(kind, reason)

    // Then
    expect(filed).toBe(actionable)
    expect(maskSafe(`${kind}: ${reason}`)).toBe(`${kind}: ${reason}`)
  })
})
