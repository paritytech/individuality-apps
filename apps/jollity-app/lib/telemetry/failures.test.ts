// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { beforeEach, describe, expect, it, vi } from "vitest"
import * as Sentry from "@sentry/react"

import { FAILURE_KINDS, isActionable, isExpected, markExpected, renderCrashDetails, signupFailureReason } from "./failures"
import { reportFailure, startJourney } from "./index"
import { resetTelemetryForTests, startTelemetryWith } from "./init"
import { flushMetrics } from "./metrics"
import { recordingTransport, testConfig } from "./test-transport"

const ACTIONABLE_CASES = [
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
  // claim-failed is deliberately not classified by section 3.2: default Error.
  ["claim-failed", "cancelled", true],
  ["prize-topup-failed", "refused", true],
  // a declined root signature and an unowned name are expected, a link that broke is ours
  ["name-link-failed", "not-signed", false],
  ["name-link-failed", "unowned", false],
  ["name-link-failed", "unfunded", true],
  ["name-link-failed", "note", true],
  // a refused read or a key nobody kept is the own-key bug; a hung read and no identifier are not
  ["own-key-missing", "read-refused", true],
  ["own-key-missing", "no-match", true],
  ["own-key-missing", "no-answer", false],
  ["own-key-missing", "no-identifier", false],
] as const

describe("which failures are actionable", () => {
  it.each(ACTIONABLE_CASES)("%s %s → %s", (kind, reason, actionable) => {
    expect(isActionable(kind, { reason })).toBe(actionable)
  })

  it("classifies every current kind and keeps an unclassified future kind visible", () => {
    expect(new Set(ACTIONABLE_CASES.map(([kind]) => kind))).toEqual(new Set(FAILURE_KINDS))
    expect(isActionable("future-failure" as never, { reason: "unknown" })).toBe(true)
  })
})

describe("the failure delivery table", () => {
  beforeEach(async () => {
    await resetTelemetryForTests()
  })

  it.each(ACTIONABLE_CASES)("%s %s uses %s", async (kind, reason, actionable) => {
    const sink = recordingTransport()
    startTelemetryWith(testConfig({ makeTransport: sink.factory }))

    reportFailure(kind, { reason })
    flushMetrics()
    await Sentry.flush(1000)

    const events = sink.items("event")
    const logs = sink.items("log")
    const failureMetrics = sink.items("trace_metric")
      .flatMap((item) => item.payload.items)
      .filter((item) => item.name === "failure")
    expect(events).toHaveLength(actionable ? 1 : 0)
    expect(logs).toHaveLength(actionable ? 0 : 1)
    expect(failureMetrics).toHaveLength(actionable ? 0 : 1)
    if (actionable) expect(events[0].payload.fingerprint).toEqual([kind, reason])
  })

  it("falls back to the Error path when non-actionable delivery is not installed", async () => {
    const sink = recordingTransport()
    startTelemetryWith(testConfig({ makeTransport: sink.factory }))
    vi.resetModules()
    const freshFailures = await import("./failures")

    freshFailures.sendFailure("peer-failed", { reason: "failed" })
    await Sentry.flush(1000)

    expect(sink.items("log")).toEqual([])
    expect(sink.items("trace_metric")).toEqual([])
    expect(sink.items("event")).toHaveLength(1)
    expect(sink.items("event")[0].payload).toMatchObject({
      level: "error",
      message: "peer-failed: failed",
      fingerprint: ["peer-failed", "failed"],
      tags: {
        "failure.kind": "peer-failed",
        "failure.reason": "failed",
        "journey.expected": "false",
      },
    })
  })
})

describe("which failures are expected", () => {
  it.each([
    ["permission-refused", "camera.denied", true],
    ["permission-refused", "camera.blocked", true],
    ["permission-refused", "network.timeout", true],
    ["permission-refused", "camera.no-camera", true],
    ["permission-refused", "camera.busy", true],
    ["host-call-failed", "statements.allocation", false],
    ["camera-unavailable", "denied", true],
    ["camera-unavailable", "busy", false],
    ["camera-unavailable", "timeout", false],
    ["signup-failed", "signing-refused", true],
    ["signup-failed", "not-eligible", true],
    ["signup-failed", "tx.broadcast", false],
    ["person-bind-failed", "proof", false],
    ["report-failed", "refused", false],
    ["claim-failed", "cancelled", true],
    ["claim-failed", "refused", false],
    ["claim-failed", "failed", false],
    ["name-link-failed", "not-signed", true],
    ["name-link-failed", "unowned", true],
    ["name-link-failed", "unfunded", false],
    ["name-link-failed", "note", false],
  ] as const)("%s %s → %s", (kind, reason, expected) => {
    expect(isExpected(kind, { reason })).toBe(expected)
  })
})

describe("a sign-up's failure reason", () => {
  it("calls a cancelled signing signing-refused", () => {
    expect(signupFailureReason("Transaction signing was rejected.", "tx.broadcast")).toBe("signing-refused")
    expect(signupFailureReason("HostRejectedError: Host rejected the request", "tx.broadcast")).toBe("signing-refused")
  })
  it("keeps the stage for a host error during signing", () => {
    expect(signupFailureReason("HostDisconnectedError: host went away", "tx.broadcast")).toBe("tx.broadcast")
    expect(signupFailureReason("Invalid.Payment", "tx.broadcast")).toBe("tx.broadcast")
  })
})

describe("journey.expected", () => {
  it("stays false once an unexpected failure was reported", () => {
    const set = vi.fn()
    const journey = { set }
    markExpected(journey, false)
    markExpected(journey, true)
    expect(set).toHaveBeenLastCalledWith({ "journey.expected": "false" })
  })
  it("is true when every failure was expected", () => {
    const set = vi.fn()
    markExpected({ set }, true)
    expect(set).toHaveBeenLastCalledWith({ "journey.expected": "true" })
  })
})

describe("the failure event", () => {
  beforeEach(async () => {
    await resetTelemetryForTests()
  })

  it("is an error with a fixed fingerprint and the kind and reason as tags", async () => {
    const sink = recordingTransport()
    startTelemetryWith(testConfig({ makeTransport: sink.factory }))
    reportFailure("host-call-failed", { reason: "failed", context: { path: "relay", peer: "5Peer" } })
    await Sentry.flush(1000)
    const [event] = sink.items("event")
    expect(event.payload).toMatchObject({
      level: "error",
      message: "host-call-failed: failed",
      fingerprint: ["host-call-failed", "failed"],
      tags: { "failure.kind": "host-call-failed", "failure.reason": "failed", "journey.expected": "false" },
      contexts: { failure: { path: "relay", peer: "5Peer" } },
    })
  })

  it("sends a non-actionable failure as one metric and one masked log, never an Error", async () => {
    const sink = recordingTransport()
    startTelemetryWith(testConfig({ makeTransport: sink.factory }))
    reportFailure("camera-unavailable", {
      reason: "denied",
      context: {
        detail: "Unauthorized credentials",
        "failure.kind": "render-crash",
        "failure.reason": "render",
        "journey.expected": "false",
      },
      error: "password denied",
    })
    flushMetrics()
    await Sentry.flush(1000)
    expect(sink.items("event")).toEqual([])
    const [metricEnvelope] = sink.items("trace_metric")
    expect(metricEnvelope.payload.items).toContainEqual(expect.objectContaining({
      name: "failure",
      type: "counter",
      value: 1,
      attributes: expect.objectContaining({
        "failure.kind": { type: "string", value: "camera-unavailable" },
        "failure.reason": { type: "string", value: "denied" },
        "journey.expected": { type: "string", value: "true" },
      }),
    }))
    const [record] = sink.items("log")[0].payload.items
    expect(record).toMatchObject({
      level: "info",
      body: "camera-unavailable: denied\tpa*sword denied",
      attributes: {
        "failure.kind": { type: "string", value: "camera-unavailable" },
        "failure.reason": { type: "string", value: "denied" },
        "journey.expected": { type: "string", value: "true" },
        detail: { type: "string", value: "Unau*horized cr*dentials" },
      },
    })
  })

  it("hands a non-actionable failure metric to transport without waiting for the SDK timer", async () => {
    const sink = recordingTransport()
    startTelemetryWith(testConfig({ makeTransport: sink.factory }))

    reportFailure("attestations-late", { reason: "60s", context: { seconds: "60" } })

    await vi.waitFor(() => {
      expect(sink.items("log")).toHaveLength(1)
      expect(sink.items("trace_metric")
        .flatMap((item) => item.payload.items)
        .filter((item) => item.name === "failure"))
        .toHaveLength(1)
    })
  })

  it("carries a thrown error as the exception", async () => {
    const sink = recordingTransport()
    startTelemetryWith(testConfig({ makeTransport: sink.factory }))
    reportFailure("render-crash", { reason: "render", error: new Error("tile exploded") })
    await Sentry.flush(1000)
    const [event] = sink.items("event")
    expect(event.payload.exception.values[0].value).toBe("tile exploded")
    expect(event.payload.fingerprint).toEqual(["render-crash", "render"])
  })

  it("keeps the nested reason of a host error that is not an Error", async () => {
    const sink = recordingTransport()
    startTelemetryWith(testConfig({ makeTransport: sink.factory }))
    reportFailure("host-call-failed", { reason: "sign", error: { tag: "Domain", value: { tag: "V1", value: { tag: "NotAllowlisted" } } } })
    await Sentry.flush(1000)
    expect(sink.items("event")[0].payload.extra.error).toBe("Domain.V1.NotAllowlisted")
  })

  it("sends two identical failures as two events", async () => {
    const sink = recordingTransport()
    startTelemetryWith(testConfig({ makeTransport: sink.factory }))
    reportFailure("report-failed", { reason: "failed" })
    reportFailure("report-failed", { reason: "failed" })
    await Sentry.flush(1000)
    expect(sink.items("event")).toHaveLength(2)
  })

  it("lands in the trace of the journey it was reported against", async () => {
    const sink = recordingTransport()
    startTelemetryWith(testConfig({ makeTransport: sink.factory }))
    const journey = startJourney("game")
    reportFailure("host-call-failed", { reason: "failed" }, journey)
    reportFailure("render-crash", { reason: "render", error: new Error("boom") }, journey)
    await Sentry.flush(1000)
    const events = sink.items("event")
    expect(events).toHaveLength(2)
    for (const event of events) {
      expect(event.payload.contexts.trace.trace_id).toBe(journey.trace?.traceId)
      expect(event.payload.contexts.trace.span_id).toBe(journey.trace?.spanId)
    }
  })

  it("keeps a non-actionable failure log in its journey trace", async () => {
    const sink = recordingTransport()
    startTelemetryWith(testConfig({ makeTransport: sink.factory }))
    const journey = startJourney("game")
    reportFailure("peer-failed", { reason: "failed" }, journey)
    await Sentry.flush(1000)
    const [record] = sink.items("log")[0].payload.items
    expect(record.trace_id).toBe(journey.trace?.traceId)
  })

  it("sends a host error that says Unauthorized or credentials without a masked word", async () => {
    const sink = recordingTransport()
    startTelemetryWith(testConfig({ makeTransport: sink.factory }))
    reportFailure("person-bind-failed", { reason: "proof", context: { error: "Unauthorized", detail: "no credentials" } })
    await Sentry.flush(1000)
    const { failure } = sink.items("event")[0].payload.contexts
    expect(failure.error).toBe("Unau*horized")
    expect(failure.detail).toBe("no cr*dentials")
  })

  it("marks the journey it was reported against", () => {
    const set = vi.fn()
    startTelemetryWith(testConfig({ makeTransport: recordingTransport().factory }))
    reportFailure("signup-failed", { reason: "signing-refused" }, { set } as never)
    expect(set).toHaveBeenCalledWith({ "journey.expected": "true" })
  })
})

describe("a render crash", () => {
  it("carries the error and the trimmed component stack", () => {
    const error = new Error("tile exploded")
    expect(renderCrashDetails(error, "\n    at Tile\n    at Grid\n")).toEqual({
      reason: "render",
      error,
      context: { component_stack: "at Tile\n    at Grid" },
    })
  })

  it("caps a long stack and survives a missing one", () => {
    expect(renderCrashDetails("boom", "x".repeat(10_000)).context?.component_stack).toHaveLength(4_000)
    expect(renderCrashDetails("boom", null)).toEqual({ reason: "render", error: "boom", context: { component_stack: "" } })
  })
})
