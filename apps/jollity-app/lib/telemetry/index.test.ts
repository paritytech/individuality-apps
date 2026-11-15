// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as Sentry from "@sentry/react"

const stored = vi.hoisted(() => new Map<string, string>())
vi.mock("../host/storage", () => ({
  tryReadStoredString: async (key: string) => ({ ok: true as const, value: stored.get(key) ?? null }),
  writeStoredString: async (key: string, value: string) => void stored.set(key, value),
}))

import { resetTelemetryForTests, startTelemetryWith } from "./init"
import { cameraNoFrames, cameraTrail, chainHealthRecord, flushMetrics, pageResourceSample, previousSessionEnd, recordDistribution, reminderAskRecord, reportWorkerHeartbeat, setGameIndex, setLowPowerTags, setPlayer, setSpsTapTag, signupBroadcast, storageSlowRecord, pageLifecycleRecord, hostRetryRecord } from "./index"
import { clearDevLog, getDevLogEntries } from "../debug/log-store"
import { retrySafeHostRead } from "../host/safe-call"
import { recordingTransport, testConfig } from "./test-transport"
import { deliveryHealthForGame, deliveryHealthObserver, flushDeliveryHealthWritesForTests } from "./delivery-health"
import { noteHostChannelLost, resetSessionRecordForTests, setSessionProbe, startSessionRecord } from "./session-record"

beforeEach(async () => {
  stored.clear()
  await resetTelemetryForTests()
  setPlayer(null, null)
  setLowPowerTags({ lowpower: false, reason: "none", probe: "none" })
  resetSessionRecordForTests()
})

afterEach(() => {
  resetSessionRecordForTests()
  vi.unstubAllGlobals()
})

function logRecords(sink: ReturnType<typeof recordingTransport>) {
  return sink.items("log").flatMap((item) => item.payload.items)
}

function attributeValues(record: { attributes: Record<string, { value: unknown }> }) {
  return Object.fromEntries(Object.entries(record.attributes).map(([key, value]) => [key, value.value]))
}

function metricItems(sink: ReturnType<typeof recordingTransport>) {
  return sink.items("trace_metric").flatMap((item) => item.payload.items)
}

describe("the player and the game", () => {
  it("reports one per-player worker heartbeat verdict and warns only when it is not current and fresh", async () => {
    const sink = recordingTransport()
    startTelemetryWith(testConfig({ makeTransport: sink.factory }))
    setPlayer("5Heartbeat")

    reportWorkerHeartbeat({ status: "fresh", ageMs: 2_000, release: "jollity@test" })
    reportWorkerHeartbeat({ status: "not-applicable" })
    reportWorkerHeartbeat({ status: "stale-release-mismatch", ageMs: 120_000, release: "jollity@old" })
    flushMetrics()
    await Sentry.flush(1000)

    expect(metricItems(sink).filter((item) => item.name === "chat.worker.heartbeat")).toHaveLength(3)
    expect(metricItems(sink).filter((item) => item.name === "chat.worker.heartbeat_age_ms").map((item) => item.value)).toEqual([2_000, 120_000])
    const warnings = logRecords(sink)
    expect(warnings).toHaveLength(1)
    const [warning] = warnings
    expect(warning).toMatchObject({ body: "chat-worker-heartbeat", level: "warn" })
    expect(attributeValues(warning)).toMatchObject({
      "user.id": "5Heartbeat",
      "worker.status": "stale-release-mismatch",
      "worker.release": "jollity@old",
      "worker.expected_release": "jollity@test",
      "worker.heartbeat_age_ms": 120_000,
    })
  })

  it("sends the account as the user id and the permissioned name as the username", async () => {
    const sink = recordingTransport()
    startTelemetryWith(testConfig({ makeTransport: sink.factory }))
    setPlayer("5HGjWAeFDfFCWPsjFQdVV2Msvz2XtMktvgocEZcCj68kUMaw")
    setPlayer(undefined, "carol")
    setGameIndex(7)
    Sentry.captureMessage("probe")
    await Sentry.flush(1000)
    const [event] = sink.items("event")
    expect(event.payload.user).toEqual({ id: "5HGjWAeFDfFCWPsjFQdVV2Msvz2XtMktvgocEZcCj68kUMaw", username: "carol" })
    expect(event.payload.tags["game.index"]).toBe("7")
  })

  it("remembers a player named before Sentry started", async () => {
    setPlayer("5Early")
    const sink = recordingTransport()
    startTelemetryWith(testConfig({ makeTransport: sink.factory }))
    setGameIndex(null)
    Sentry.captureMessage("probe")
    await Sentry.flush(1000)
    expect(sink.items("event")[0].payload.user).toEqual({ id: "5Early" })
  })

  it("sends a small standalone sign-up broadcast log with its stable identity and no Error", async () => {
    const sink = recordingTransport()
    startTelemetryWith(testConfig({ makeTransport: sink.factory }))
    setPlayer("5Marker")
    setGameIndex(7)
    signupBroadcast("5Marker", 2, "free", 7)
    await Sentry.flush(1000)
    expect(sink.items("event")).toEqual([])
    const [record] = logRecords(sink)
    expect(record).toMatchObject({
      body: "signup-broadcast",
      level: "info",
    })
    expect(attributeValues(record)).toMatchObject({
      account: "5Marker",
      "game.index": "7",
      "signup.attempt": "2",
      "signup.route": "free",
      release: "jollity@test",
    })
  })

  it("sends one previous-session log and counter with flattened typed diagnostics and no Error (#232)", async () => {
    const sink = recordingTransport()
    startTelemetryWith(testConfig({ makeTransport: sink.factory }))
    previousSessionEnd({
      classification: "killed-background",
      previousSessionId: "old-session",
      gapMs: 19_000,
      screen: "game.round",
      gameIndex: 248,
      turn: 3,
      liveVideo: 4,
      heapMb: 51,
      pagehideSeen: false,
      freezeSeen: true,
      visibilityChanges: 2,
      lastVisibility: "hidden",
      inGame: true,
      openJourneys: ["join", "game"],
      openJourneySteps: ["join:mesh.open", "game:game.round"],
      gameState: {
        gameIndex: 248,
        phase: "draw",
        visibility: "visible",
        chainTimeMs: 1_800_000_000_000,
        sampledAtMs: 1_800_000_000_100,
        counters: {
          installed: true, peerConnections: 3, glContexts: 2, glLive: 2, glLost: 0,
          videos: 4, videosWithStream: 3, videoMaxWidth: 1280, videoMaxHeight: 720,
          videoPixels: 2_764_800, videoResolutions: "1280x720", canvases: 2, domNodes: 777,
        },
      },
    })
    await Sentry.flush(1000)
    flushMetrics()
    await Sentry.flush(1000)
    expect(sink.items("event")).toEqual([])
    const [record] = logRecords(sink)
    expect(record).toMatchObject({
      body: "previous-session-end",
      level: "info",
    })
    expect(attributeValues(record)).toMatchObject({
      "previous.end": "killed-background",
      "previous.visibility": "hidden",
      "previous.in_game": true,
      "previous.pagehide": false,
      "previous.pagehide_persisted": "unknown",
      "previous.freeze": true,
      "previous.visibility_changed": true,
      "previous.game_state.unclean": true,
      "previous.game_state.ambiguous_end": "kill-or-force-quit",
      "previous.game_state.phase": "draw",
      "previous.game_state.peer_connections": 3,
      "previous.game_state.video_pixels": 2_764_800,
      "previous.game_state.dom_nodes": 777,
      "previous.screen": "game.round",
      "previous.game": "248",
      "previous.turn": "3",
      "failure.kind": "unclean-exit",
      "failure.reason": "in-game",
      "journey.expected": "false",
      "previous.session.session_id": "old-session",
      "previous.session.gap_ms": 19_000,
      "previous.session.game_index": "248",
      "previous.session.turn": "3",
      "previous.session.live_video": 4,
      "previous.session.heap_mb": 51,
      "previous.session.open_journeys": "join,game",
      "previous.session.open_journey_steps": "join:mesh.open,game:game.round",
      "previous.session.visibility_changes": 2,
      "failure.open_journeys": "join,game",
      "failure.open_journey_steps": "join:mesh.open,game:game.round",
    })
    expect(metricItems(sink)).toContainEqual(expect.objectContaining({
      name: "app.previous_end",
      type: "counter",
      value: 1,
      attributes: expect.objectContaining({
        "previous.end": { type: "string", value: "killed-background" },
        "previous.in_game": { type: "string", value: "true" },
      }),
    }))
    expect(metricItems(sink)).toContainEqual(expect.objectContaining({
      name: "failure",
      type: "counter",
      value: 1,
      attributes: expect.objectContaining({
        "failure.kind": { type: "string", value: "unclean-exit" },
        "failure.reason": { type: "string", value: "in-game" },
        "journey.expected": { type: "string", value: "false" },
      }),
    }))
  })

  it("sends one typed page resource sample through Logs and no Error", async () => {
    const sink = recordingTransport()
    startTelemetryWith(testConfig({ makeTransport: sink.factory }))
    pageResourceSample({
      gameIndex: 248,
      phase: "chest",
      visibility: "visible",
      chainTimeMs: 1_800_000_000_000,
      sampledAtMs: 1_800_000_000_100,
      counters: {
        installed: true, peerConnections: 3, glContexts: 2, glLive: 1, glLost: 1,
        videos: 4, videosWithStream: 3, videoMaxWidth: 1280, videoMaxHeight: 720,
        videoPixels: 2_764_800, videoResolutions: "1280x720", canvases: 2, domNodes: 777,
      },
    })
    await Sentry.flush(1000)
    expect(sink.items("event")).toEqual([])
    expect(logRecords(sink)).toHaveLength(1)
    expect(attributeValues(logRecords(sink)[0])).toMatchObject({
      "page.phase": "chest",
      "page.game_index": "248",
      "page.chain_time_ms": 1_800_000_000_000,
      "page.resource.peer_connections": 3,
      "page.resource.webgl_live": 1,
      "page.resource.video_pixels": 2_764_800,
      "page.resource.dom_nodes": 777,
    })
  })

  it("does not change failure metrics or attach game evidence for non-kill exits", async () => {
    const sink = recordingTransport()
    startTelemetryWith(testConfig({ makeTransport: sink.factory }))
    previousSessionEnd({
      classification: "own-reload",
      pagehideSeen: true,
      freezeSeen: false,
      visibilityChanges: 0,
      lastVisibility: "visible",
      inGame: true,
      openJourneys: [],
      openJourneySteps: [],
      gameState: {
        gameIndex: 248,
        phase: "game.round",
        visibility: "visible",
        sampledAtMs: 1_800_000_000_100,
        counters: {
          installed: true, peerConnections: 3, glContexts: 2, glLive: 2, glLost: 0,
          videos: 4, videosWithStream: 3, videoMaxWidth: 1280, videoMaxHeight: 720,
          videoPixels: 2_764_800, videoResolutions: "1280x720", canvases: 2,
        },
      },
    })
    await Sentry.flush(1000)
    flushMetrics()
    await Sentry.flush(1000)
    expect(attributeValues(logRecords(sink)[0])).not.toHaveProperty("previous.game_state.phase")
    expect(metricItems(sink).filter((item) => item.name === "failure")).toEqual([])
  })

  it("tags an in-game host reload as an unclean-exit Log plus Metric", async () => {
    const sink = recordingTransport()
    startTelemetryWith(testConfig({ makeTransport: sink.factory }))
    previousSessionEnd({
      classification: "host-reload",
      previousSessionId: "old-session",
      gapMs: 4_000,
      screen: "game.round",
      gameIndex: 259,
      turn: 1,
      pagehideSeen: true,
      freezeSeen: false,
      visibilityChanges: 0,
      lastVisibility: "visible",
      inGame: true,
      openJourneys: ["game"],
      openJourneySteps: ["game:game.round"],
    })
    await Sentry.flush(1000)
    flushMetrics()
    await Sentry.flush(1000)

    expect(sink.items("event")).toEqual([])
    expect(attributeValues(logRecords(sink)[0])).toMatchObject({
      "previous.end": "host-reload",
      "failure.kind": "unclean-exit",
      "failure.reason": "host-reload",
      "journey.expected": "false",
    })
    expect(metricItems(sink)).toContainEqual(expect.objectContaining({
      name: "failure",
      value: 1,
      attributes: expect.objectContaining({
        "failure.kind": { type: "string", value: "unclean-exit" },
        "failure.reason": { type: "string", value: "host-reload" },
      }),
    }))
  })

  it("does not tag a pre-round host reload as a failure", async () => {
    const sink = recordingTransport()
    startTelemetryWith(testConfig({ makeTransport: sink.factory }))
    previousSessionEnd({
      classification: "host-reload",
      previousSessionId: "old-session",
      gapMs: 150,
      screen: "game",
      gameIndex: 259,
      pagehideSeen: false,
      freezeSeen: false,
      visibilityChanges: 0,
      lastVisibility: "visible",
      inGame: true,
      openJourneys: ["join"],
      openJourneySteps: ["join:mesh.open"],
    })
    await Sentry.flush(1000)
    flushMetrics()
    await Sentry.flush(1000)

    expect(attributeValues(logRecords(sink)[0])).not.toHaveProperty("failure.kind")
    expect(metricItems(sink).filter((item) => item.name === "failure")).toEqual([])
  })

  it("carries /game route evidence through a same-lineage host reload into the failure Log", async () => {
    const local = new Map<string, string>()
    const session = new Map<string, string>()
    const storage = (map: Map<string, string>) => ({
      get length() { return map.size }, clear: () => map.clear(), getItem: (key: string) => map.get(key) ?? null,
      key: (index: number) => [...map.keys()][index] ?? null, removeItem: (key: string) => void map.delete(key),
      setItem: (key: string, value: string) => void map.set(key, value),
    }) as Storage
    vi.stubGlobal("localStorage", storage(local))
    vi.stubGlobal("sessionStorage", storage(session))
    const pageListeners = new Map<string, (event?: Event) => void>()
    vi.stubGlobal("window", {
      location: { pathname: "/game" },
      addEventListener: (name: string, listener: (event?: Event) => void) => pageListeners.set(name, listener),
      removeEventListener: vi.fn(),
    })
    vi.stubGlobal("document", { visibilityState: "visible", addEventListener: vi.fn(), removeEventListener: vi.fn() })
    setSessionProbe(() => ({ inGame: false, gameIndex: 259, turn: 1 }))

    const sink = recordingTransport()
    startTelemetryWith(testConfig({ makeTransport: sink.factory }))
    await startSessionRecord({ record: previousSessionEnd })
    noteHostChannelLost()
    pageListeners.get("pagehide")?.(Object.assign(new Event("pagehide"), { persisted: false }))
    resetSessionRecordForTests()
    const diagnostic = await startSessionRecord({ record: previousSessionEnd })
    await Sentry.flush(1000)
    flushMetrics()
    await Sentry.flush(1000)

    expect(diagnostic).toMatchObject({ classification: "host-reload", inGame: true, screen: "game", gameIndex: 259, turn: 1 })
    expect(attributeValues(logRecords(sink).at(-1)!)).toMatchObject({
      "previous.end": "host-reload",
      "previous.in_game": true,
      "failure.kind": "unclean-exit",
      "failure.reason": "host-reload",
    })
  })

  it("uses the sign-up game's index instead of a stale scoped game", async () => {
    const sink = recordingTransport()
    startTelemetryWith(testConfig({ makeTransport: sink.factory }))
    setGameIndex(7)
    signupBroadcast("5Marker", 1, "returning", 8)
    await Sentry.flush(1000)
    expect(attributeValues(logRecords(sink)[0])).toMatchObject({ "game.index": "8" })
  })

  it("ignores a stale lower game index for both event scope and delivery health", async () => {
    const sink = recordingTransport()
    startTelemetryWith(testConfig({ makeTransport: sink.factory }))
    setGameIndex(102)
    setGameIndex(101)
    deliveryHealthObserver.failed("fetch")
    await flushDeliveryHealthWritesForTests()
    Sentry.captureMessage("still current")
    await Sentry.flush(1000)

    expect(sink.items("event")[0].payload.tags?.["game.index"]).toBe("102")
    expect((await deliveryHealthForGame(102)).game.failed.fetch).toBe(1)
    expect((await deliveryHealthForGame(101)).game.failed.fetch).toBe(0)
  })

  it("queues bounded camera trail and no-frame logs with flattened typed context and no Errors", async () => {
    const sink = recordingTransport()
    startTelemetryWith(testConfig({ makeTransport: sink.factory }))
    setGameIndex(208)
    cameraTrail("self.window", { page_ms: 100, stream_id: "c1", fps: 24 })
    cameraTrail("outbound.video", { page_ms: 110, stream_id: "c1", frames_encoded: 240 })
    cameraTrail("self.attach", { page_ms: 123, stream_id: "c1", stale: true })
    cameraNoFrames({ camera_checkpoint: "join", age_ms: 9_000, reopen_recovered: true })
    await Sentry.flush(1000)
    expect(sink.items("event")).toEqual([])
    expect(logRecords(sink).map((record) => ({ body: record.body, attrs: attributeValues(record) }))).toEqual(expect.arrayContaining([
      { body: "camera-trail", attrs: expect.objectContaining({ "camera.event": "self.attach", "game.index": "208", "camera.page_ms": 123, "camera.stream_id": "c1", "camera.stale": true }) },
      { body: "camera.no_frames", attrs: expect.objectContaining({ "camera.checkpoint": "join", "camera.camera_checkpoint": "join", "camera.age_ms": 9_000, "camera.reopen_recovered": true }) },
    ]))
    expect(logRecords(sink)).toHaveLength(2)
  })

  it("masks host chain errors in the log attribute and sends its counter with no Error", async () => {
    const sink = recordingTransport()
    startTelemetryWith(testConfig({ makeTransport: sink.factory }))
    chainHealthRecord({
      where: "waiting",
      outcome: "unknown",
      latencyMs: 12,
      errorClass: "unknown",
      error: "Unauthorized: no credentials",
    })
    flushMetrics()
    await Sentry.flush(1000)
    expect(sink.items("event")).toEqual([])
    expect(attributeValues(logRecords(sink)[0])).toMatchObject({
      "chain.health.where": "waiting",
      "chain.health.outcome": "unknown",
      "chain.health.error_class": "unknown",
      "chain.health.latency_ms": 12,
      "chain.health.error": "Unau*horized: no cr*dentials",
    })
    expect(metricItems(sink)).toContainEqual(expect.objectContaining({
      name: "chain.health",
      value: 1,
      attributes: expect.objectContaining({
        "chain.health.where": { type: "string", value: "waiting" },
        "chain.health.outcome": { type: "string", value: "unknown" },
      }),
    }))
  })

  it("carries the consecutive-loss count and the registered flag on chain.health", async () => {
    const sink = recordingTransport()
    startTelemetryWith(testConfig({ makeTransport: sink.factory }))
    chainHealthRecord({
      where: "open",
      outcome: "host-chain-lost",
      latencyMs: 40,
      errorClass: "cannot-get-current-block",
      error: "cannot get the current block",
      consecutiveLost: 2,
      registered: true,
    })
    await Sentry.flush(1000)
    const attrs = attributeValues(logRecords(sink)[0])
    expect(attrs).toEqual(expect.objectContaining({
      "chain.health.consecutive_lost": 2,
      "chain.health.registered": true,
      "chain.health.latency_ms": 40,
    }))
  })

  it("sends a storage-slow log and counter with no Error", async () => {
    const sink = recordingTransport()
    startTelemetryWith(testConfig({ makeTransport: sink.factory }))
    storageSlowRecord({ op: "read", key: "jollity.game", ms: 10_000 })
    flushMetrics()
    await Sentry.flush(1000)
    expect(sink.items("event")).toEqual([])
    expect(logRecords(sink)).toHaveLength(1)
    expect(attributeValues(logRecords(sink)[0])).toMatchObject({
      "storage.op": "read",
      "storage.key": "jollity.game",
      "storage.ms": 10_000,
    })
    expect(metricItems(sink)).toContainEqual(expect.objectContaining({
      name: "storage.slow",
      value: 1,
      attributes: expect.objectContaining({ "storage.op": { type: "string", value: "read" } }),
    }))
  })

  it("sends a page-lifecycle log with the edge, the state and the monotonic time", async () => {
    // Given
    const sink = recordingTransport()
    startTelemetryWith(testConfig({ makeTransport: sink.factory }))

    // When
    pageLifecycleRecord({ event: "pagehide", state: "hidden", monoMs: 1234.6, persisted: true })
    await Sentry.flush(1000)

    // Then
    const [record] = logRecords(sink)
    expect(record).toMatchObject({ body: "page-lifecycle", level: "info" })
    expect(attributeValues(record)).toMatchObject({
      "lifecycle.event": "pagehide",
      "lifecycle.state": "hidden",
      "lifecycle.mono_ms": 1235,
      "lifecycle.persisted": true,
    })
  })

  it("puts each page lifecycle edge in the game log under the lifecycle tag", () => {
    // Given
    clearDevLog()

    // When
    pageLifecycleRecord({ event: "visibilitychange", state: "visible", monoMs: 10 })

    // Then
    expect(getDevLogEntries()).toContainEqual(expect.objectContaining({ tag: "lifecycle", message: "visibilitychange: visible" }))
  })

  it("sends a host.retry warning with the operation, attempt, reason, wait and error", async () => {
    // Given
    const sink = recordingTransport()
    startTelemetryWith(testConfig({ makeTransport: sink.factory }))
    clearDevLog()

    // When
    hostRetryRecord({ operation: "storage.read", attempt: 2, reason: "host-interrupted", waitedMs: 812.4, error: new Error("TrUAPI host connection interrupted") })
    await Sentry.flush(1000)

    // Then
    const [record] = logRecords(sink)
    expect(record.level).toBe("warn")
    expect(record.body).toMatch(/^host\.retry\t.*TrUAPI host connection interrupted/)
    expect(attributeValues(record)).toMatchObject({
      "host.retry.operation": "storage.read",
      "host.retry.attempt": 2,
      "host.retry.reason": "host-interrupted",
      "host.retry.waited_ms": 812,
    })
    expect(getDevLogEntries()).toContainEqual(expect.objectContaining({
      tag: "host",
      level: "warn",
      message: "retrying storage.read (attempt 2) after host-interrupted",
    }))
  })

  it("logs a safe host read rerun once telemetry is loaded", async () => {
    // Given
    const sink = recordingTransport()
    startTelemetryWith(testConfig({ makeTransport: sink.factory }))
    const run = vi.fn().mockRejectedValueOnce(new Error("TrUAPI host connection interrupted")).mockResolvedValueOnce("ready")
    const connected = { subscribeConnectionStatus: (callback: (status: "connected") => void) => (callback("connected"), () => {}) }

    // When
    await retrySafeHostRead(connected, run, { operation: "storage.read" })
    await Sentry.flush(1000)

    // Then
    expect(attributeValues(logRecords(sink)[0])).toMatchObject({ "host.retry.operation": "storage.read", "host.retry.reason": "host-interrupted" })
  })

  it("counts every answer to a reminder ask, and logs the reason of one other than held as the worker does", async () => {
    const sink = recordingTransport()
    startTelemetryWith(testConfig({ makeTransport: sink.factory }))
    reminderAskRecord("held")
    reminderAskRecord("failed", "HostFailure: notifications are off")
    flushMetrics()
    await Sentry.flush(1000)
    const counts = metricItems(sink).filter((item) => item.name === "reminder.ask")
    expect(counts.map((item) => item.attributes.outcome?.value)).toEqual(["held", "failed"])
    expect(counts.every((item) => item.attributes.surface?.value === "app")).toBe(true)
    const logs = logRecords(sink)
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatchObject({ body: 'reminder.ask\t{"error":"HostFailure: notifications are off"}', level: "info" })
    expect(attributeValues(logs[0])).toMatchObject({ outcome: "failed", surface: "app" })
  })

  it("cuts the reason of a reminder ask to the length the chat worker keeps", async () => {
    // Given
    const sink = recordingTransport()
    startTelemetryWith(testConfig({ makeTransport: sink.factory }))

    // When
    reminderAskRecord("failed", `HostFailure: ${"x".repeat(1000)}`)
    await Sentry.flush(1000)

    // Then
    const [log] = logRecords(sink)
    expect(log.body).toBe(`reminder.ask\t${JSON.stringify({ error: `HostFailure: ${"x".repeat(1000)}`.slice(0, 300) })}`)
  })

  it("keeps healthy chain probes metric-only", async () => {
    const sink = recordingTransport()
    startTelemetryWith(testConfig({ makeTransport: sink.factory }))
    chainHealthRecord({ where: "waiting", outcome: "healthy", latencyMs: 12 })
    await Sentry.flush(1000)
    expect(sink.items("event")).toHaveLength(0)
  })

  it("is a no-op without a client", () => {
    expect(() => setPlayer("5Nobody", "nobody")).not.toThrow()
    expect(() => setGameIndex(3)).not.toThrow()
  })
})

describe("the low power tags", () => {
  /** every metric item the transport was handed */
  function metricItems(sink: ReturnType<typeof recordingTransport>) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return sink.items("trace_metric").flatMap((item) => item.payload.items as any[])
  }

  /** Open delivery for the test transport. */
  async function provenGate(sink: ReturnType<typeof recordingTransport>) {
    await Sentry.flush(1000)
    sink.envelopes.length = 0
  }

  async function onePoint(sink: ReturnType<typeof recordingTransport>) {
    sink.envelopes.length = 0
    recordDistribution("ui.frame_ms", 16, "millisecond", { scene: "game" })
    flushMetrics()
    await Sentry.flush(1000)
    const [point] = metricItems(sink)
    return point
  }

  it("puts lowpower=off and probe=none on a point and an event by default", async () => {
    const sink = recordingTransport()
    startTelemetryWith(testConfig({ makeTransport: sink.factory }))
    await provenGate(sink)
    setGameIndex(3)
    const point = await onePoint(sink)
    expect(point.attributes.lowpower).toEqual({ type: "string", value: "off" })
    expect(point.attributes.probe).toEqual({ type: "string", value: "none" })
    expect(point.attributes.scene).toEqual({ type: "string", value: "game" })
    expect(point.attributes["game.index"]).toEqual({ type: "string", value: "3" })
    Sentry.captureMessage("tags")
    await Sentry.flush(1000)
    const [event] = sink.items("event")
    expect(event.payload.tags).toMatchObject({ lowpower: "off", "lowpower.reason": "none", probe: "none" })
  })

  it("puts the SPS tap's session decision on a point once a mesh has made it (#629)", async () => {
    const sink = recordingTransport()
    startTelemetryWith(testConfig({ makeTransport: sink.factory }))
    await provenGate(sink)
    setSpsTapTag("on")
    expect((await onePoint(sink)).attributes["rtc.sps_tap"]).toEqual({ type: "string", value: "on" })
    setSpsTapTag("unsupported")
    expect((await onePoint(sink)).attributes["rtc.sps_tap"]).toEqual({ type: "string", value: "unsupported" })
  })

  it("carries the reason on a point and an event, and none once the mode is off", async () => {
    const sink = recordingTransport()
    startTelemetryWith(testConfig({ makeTransport: sink.factory }))
    await provenGate(sink)
    setLowPowerTags({ lowpower: true, reason: "debug-menu" })
    const point = await onePoint(sink)
    expect(point.attributes["lowpower.reason"]).toEqual({ type: "string", value: "debug-menu" })
    Sentry.captureMessage("tags")
    await Sentry.flush(1000)
    expect(sink.items("event").at(-1)?.payload.tags).toMatchObject({ lowpower: "on", "lowpower.reason": "debug-menu" })
    setLowPowerTags({ lowpower: false, reason: "none" })
    expect((await onePoint(sink)).attributes["lowpower.reason"]).toEqual({ type: "string", value: "none" })
  })

  it("changes one tag and keeps the other", async () => {
    const sink = recordingTransport()
    startTelemetryWith(testConfig({ makeTransport: sink.factory }))
    await provenGate(sink)
    setLowPowerTags({ lowpower: true })
    let point = await onePoint(sink)
    expect(point.attributes.lowpower).toEqual({ type: "string", value: "on" })
    expect(point.attributes.probe).toEqual({ type: "string", value: "none" })
    setLowPowerTags({ probe: "done" })
    point = await onePoint(sink)
    expect(point.attributes.lowpower).toEqual({ type: "string", value: "on" })
    expect(point.attributes.probe).toEqual({ type: "string", value: "done" })
  })

  it("remembers the tags set before Sentry started", async () => {
    setLowPowerTags({ lowpower: true, probe: "done" })
    const sink = recordingTransport()
    startTelemetryWith(testConfig({ makeTransport: sink.factory }))
    await provenGate(sink)
    setGameIndex(null)
    const point = await onePoint(sink)
    expect(point.attributes.lowpower).toEqual({ type: "string", value: "on" })
    expect(point.attributes.probe).toEqual({ type: "string", value: "done" })
  })

  it("is a no-op without a client", () => {
    expect(() => setLowPowerTags({ lowpower: true, probe: "done" })).not.toThrow()
  })
})
