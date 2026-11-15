// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * With a Sentry whose every call throws (init aside, so a client "exists"),
 * each public function still returns normally.
 */
import { describe, expect, it, vi } from "vitest"

vi.mock("@sentry/react", () => {
  const boom = () => {
    throw new Error("sentry is broken")
  }
  return {
    init: () => undefined,
    makeFetchTransport: boom,
    breadcrumbsIntegration: boom,
    browserTracingIntegration: boom,
    setTags: boom,
    setTag: boom,
    setContext: boom,
    setUser: boom,
    addBreadcrumb: boom,
    withScope: boom,
    captureEvent: boom,
    captureException: boom,
    startNewTrace: boom,
    continueTrace: boom,
    withActiveSpan: boom,
    startInactiveSpan: boom,
    spanToTraceHeader: boom,
    flush: boom,
    close: boom,
    getClient: boom,
    getCurrentScope: boom,
    getIsolationScope: boom,
    getGlobalScope: boom,
  }
})

import { previousSessionEnd, reportFailure, sendGameLog, setGameIndex, setPlayer, startJourney, startTelemetry, turnReceiptSpan, waitingNetworkCheckSpan } from "./index"
import { sendLogEnvelope, startTelemetryWith } from "./init"
import { testConfig } from "./test-transport"

describe("telemetry never throws", () => {
  it("returns normally from every function", async () => {
    expect(startTelemetryWith(testConfig())).toBe(true)
    expect(() => startTelemetry()).not.toThrow()
    expect(() => setPlayer("5Player", "name")).not.toThrow()
    expect(() => setGameIndex(4)).not.toThrow()
    expect(() => reportFailure("peer-failed", { reason: "failed" })).not.toThrow()
    expect(() => turnReceiptSpan({ received: "true", source: "warmup", stage: "issue" })).not.toThrow()
    expect(() => waitingNetworkCheckSpan({
      result: "blocked",
      reason: "dwell",
      trigger: "network-change",
      leadTimeS: 280,
      gatherMs: 8_000,
      attempts: 1,
      counts: { host: 1, srflx: 0, relay: 0, other: 0 },
      relayUnreachable: true,
    })).not.toThrow()
    expect(() =>
      previousSessionEnd({
        classification: "unknown",
        pagehideSeen: false,
        freezeSeen: false,
        visibilityChanges: 0,
        lastVisibility: "unknown",
        inGame: false,
        openJourneys: [],
        openJourneySteps: [],
      }),
    ).not.toThrow()
    const journey = startJourney("join")
    expect(() => {
      const step = journey.step("camera.acquire")
      step.set({ a: "b" })
      step.end()
      journey.set({ a: "b" })
      journey.markSad("why")
      journey.end("full")
    }).not.toThrow()
    await expect(sendGameLog({ gameIndex: 1, since: 0, stage: "payoff", trace: null })).resolves.toBe(false)
    await expect(sendLogEnvelope("broken", [{
      timestamp: Date.now() / 1000,
      level: "info",
      body: "safe",
      trace_id: "a".repeat(32),
      severity_number: 9,
      attributes: {},
    }])).resolves.toBe(false)
  })
})
