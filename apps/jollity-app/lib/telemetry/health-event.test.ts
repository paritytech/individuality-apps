// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { beforeEach, describe, expect, it, vi } from "vitest"
import * as Sentry from "@sentry/react"

const stored = vi.hoisted(() => new Map<string, string>())
vi.mock("../host/storage", () => ({
  tryReadStoredString: async (key: string) => ({ ok: true as const, value: stored.get(key) ?? null }),
  writeStoredString: async (key: string, value: string) => void stored.set(key, value),
}))

import {
  closeDeliveryHealthGame,
  deliveryHealthObserver,
  flushDeliveryHealthWritesForTests,
  pendingDeliveryHealth,
  resetDeliveryHealthForTests,
  setDeliveryHealthGame,
} from "./delivery-health"
import { sendTelemetryHealth, uploadLateTelemetryHealth } from "./health-event"
import { resetTelemetryForTests, startTelemetryWith } from "./init"
import { setScopeTags } from "./scope-tags"
import { recordingTransport, testConfig } from "./test-transport"

let sink: ReturnType<typeof recordingTransport>

const NUMERIC_HEALTH_FIELDS = [
  "failed_fetch",
  "failed_4xx",
  "failed_429",
  "failed_5xx",
  "failed_timeout",
  "retries",
  "dropped_events",
  "dropped_metrics",
  "offline_ms",
  "recovered_timeouts",
  "longest_wait_ms",
  "unknown_lanes",
  "failed_429_server",
  "failed_429_local",
  "limited_2xx",
] as const

beforeEach(async () => {
  stored.clear()
  await resetTelemetryForTests()
  resetDeliveryHealthForTests()
  Sentry.getIsolationScope().setUser(null)
  setScopeTags({ "game.index": undefined, "net.type": undefined })
  sink = recordingTransport()
  startTelemetryWith(testConfig({ makeTransport: sink.factory }))
})

describe("telemetry.health", () => {
  it("sends and clears an all-zero summary only after a confirmed log", async () => {
    Sentry.getIsolationScope().setUser({ id: "player-7", username: "alice" })
    setScopeTags({ "game.index": "999", "net.type": "wifi" })
    setDeliveryHealthGame(41)
    closeDeliveryHealthGame(41)
    await flushDeliveryHealthWritesForTests()
    await expect(sendTelemetryHealth(41, false)).resolves.toBe(true)
    await Sentry.flush(1000)

    expect(sink.items("event")).toEqual([])
    const [record] = sink.items("log")[0].payload.items
    expect(record).toMatchObject({
      body: "telemetry.health",
      level: "info",
      severity_number: 9,
      attributes: {
        "game.index": { type: "string", value: "41" },
        "net.type": { type: "string", value: "wifi" },
        "user.id": { type: "string", value: "player-7" },
        "user.name": { type: "string", value: "alice" },
        "telemetry.health_late": { type: "boolean", value: false },
        "telemetry_health.failed_fetch": { type: "integer", value: 0 },
        "telemetry_health.recovered_timeouts": { type: "integer", value: 0 },
        "telemetry_health.unknown_lanes": { type: "integer", value: 0 },
        "telemetry_health.rate_limit_last": { type: "string", value: "" },
        "telemetry_health.rate_limit_reasons": { type: "string", value: "" },
        "telemetry_health.session.failed_fetch": { type: "integer", value: 0 },
        "telemetry_health.session.rate_limit_last": { type: "string", value: "" },
        "telemetry_health.session.rate_limit_reasons": { type: "string", value: "" },
      },
    })
    for (const prefix of ["telemetry_health", "telemetry_health.session"]) {
      for (const field of NUMERIC_HEALTH_FIELDS) {
        expect(record.attributes[`${prefix}.${field}`]).toEqual({ type: "integer", value: 0 })
      }
    }
    const queryShape = Object.fromEntries(
      Object.entries(record.attributes as Record<string, { value: unknown }>).map(([key, attribute]) => [key, attribute.value]),
    )
    expect(queryShape["user.id"]).toBe("player-7")
    expect("game_log.item" in queryShape).toBe(false)
    expect(record.trace_id).toMatch(/^[0-9a-f]{32}$/)
    expect(await pendingDeliveryHealth()).toEqual([])
    deliveryHealthObserver.deliveredAfter(20)
    await flushDeliveryHealthWritesForTests()
    expect(await pendingDeliveryHealth()).toEqual([])
  })

  it("carries the rate-limit split as numbers and the reason fields as strings", async () => {
    setDeliveryHealthGame(44)
    deliveryHealthObserver.rateLimited?.({ kind: "server_429", header: "60:error;attachment:organization:usage_exceeded", entries: [{ categories: ["error", "attachment"], scope: "organization", reason: "usage_exceeded" }] })
    deliveryHealthObserver.rateLimited?.({ kind: "limited_2xx", entries: [] })
    deliveryHealthObserver.rateLimited?.({ kind: "local_drop", entries: [] })
    deliveryHealthObserver.unknownLane?.("log")
    closeDeliveryHealthGame(44)
    await flushDeliveryHealthWritesForTests()
    await expect(sendTelemetryHealth(44, false)).resolves.toBe(true)
    await Sentry.flush(1000)

    const [record] = sink.items("log")[0].payload.items
    expect(record.attributes).toMatchObject({
      "telemetry_health.failed_429_server": { type: "integer", value: 1 },
      "telemetry_health.failed_429_local": { type: "integer", value: 1 },
      "telemetry_health.limited_2xx": { type: "integer", value: 1 },
      "telemetry_health.unknown_lanes": { type: "integer", value: 1 },
      "telemetry_health.rate_limit_last": { type: "string", value: "60:error;attachment:organization:usage_exceeded" },
      "telemetry_health.rate_limit_reasons": { type: "string", value: "organization:usage_exceeded:error;attachment" },
    })
  })

  it("does not upload an unfinished game merely because the app reopened", async () => {
    setDeliveryHealthGame(42)
    deliveryHealthObserver.failed("429")
    deliveryHealthObserver.retried()
    deliveryHealthObserver.dropped("metric")
    await flushDeliveryHealthWritesForTests()

    await resetTelemetryForTests()
    resetDeliveryHealthForTests()
    sink = recordingTransport()
    startTelemetryWith(testConfig({ makeTransport: sink.factory }))
    await expect(uploadLateTelemetryHealth()).resolves.toBe(false)
    expect(sink.items("log")).toEqual([])
    expect(await pendingDeliveryHealth()).toEqual([])
  })

  it("accumulates a same-game rejoin into one late summary after the game closes", async () => {
    setDeliveryHealthGame(43)
    deliveryHealthObserver.retried()
    await flushDeliveryHealthWritesForTests()

    await resetTelemetryForTests()
    resetDeliveryHealthForTests()
    sink = recordingTransport()
    startTelemetryWith(testConfig({ makeTransport: sink.factory }))
    setDeliveryHealthGame(43)
    deliveryHealthObserver.dropped("event")
    await flushDeliveryHealthWritesForTests()
    closeDeliveryHealthGame(43)
    await expect(uploadLateTelemetryHealth()).resolves.toBe(true)
    const [record] = sink.items("log")[0].payload.items
    expect(record.attributes).toMatchObject({
      "game.index": { type: "string", value: "43" },
      "telemetry.health_late": { type: "boolean", value: true },
      "telemetry_health.retries": { type: "integer", value: 1 },
      "telemetry_health.dropped_events": { type: "integer", value: 1 },
    })
    expect(await pendingDeliveryHealth()).toEqual([])
  })

  it("waits for older retries before snapshotting and clearing the game", async () => {
    await resetTelemetryForTests()
    let attempts = 0
    sink = recordingTransport()
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
    setDeliveryHealthGame(44)
    closeDeliveryHealthGame(44)
    Sentry.captureMessage("older event")
    await expect(sendTelemetryHealth(44, false)).resolves.toBe(true)
    const [health] = sink.items("log")[0].payload.items
    expect(health.attributes).toMatchObject({
      "telemetry_health.failed_5xx": { type: "integer", value: 1 },
      "telemetry_health.retries": { type: "integer", value: 1 },
    })
    expect(await pendingDeliveryHealth()).toEqual([])
  })

  it("deduplicates concurrent late and on-time sends for one game", async () => {
    setDeliveryHealthGame(46)
    deliveryHealthObserver.retried()
    await flushDeliveryHealthWritesForTests()
    await resetTelemetryForTests()
    resetDeliveryHealthForTests()
    sink = recordingTransport()
    startTelemetryWith(testConfig({ makeTransport: sink.factory }))
    closeDeliveryHealthGame(46)
    const [claimed] = await pendingDeliveryHealth()

    await expect(Promise.all([sendTelemetryHealth(46, true, claimed), sendTelemetryHealth(46, false)])).resolves.toEqual([true, false])
    expect(sink.items("log")).toHaveLength(1)
  })

  it("keeps a refused summary pending for the next late upload", async () => {
    setDeliveryHealthGame(47)
    deliveryHealthObserver.retried()
    closeDeliveryHealthGame(47)
    await flushDeliveryHealthWritesForTests()

    await resetTelemetryForTests()
    sink = recordingTransport(413)
    startTelemetryWith(testConfig({ makeTransport: sink.factory }))
    await expect(sendTelemetryHealth(47, false)).resolves.toBe(false)
    expect((await pendingDeliveryHealth()).map(({ gameIndex }) => gameIndex)).toEqual([47])

    await resetTelemetryForTests()
    sink = recordingTransport()
    startTelemetryWith(testConfig({ makeTransport: sink.factory }))
    await expect(uploadLateTelemetryHealth()).resolves.toBe(true)
    const [record] = sink.items("log")[0].payload.items
    expect(record.attributes["telemetry.health_late"]).toEqual({ type: "boolean", value: true })
    expect(await pendingDeliveryHealth()).toEqual([])
  })
})
