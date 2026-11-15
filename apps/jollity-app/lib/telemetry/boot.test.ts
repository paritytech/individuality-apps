// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, beforeEach, expect, it, vi } from "vitest"

const calls = vi.hoisted(() => ({
  closeExpiredDeliveryHealth: vi.fn(async () => {}),
  uploadLateGameLog: vi.fn(async () => false),
  uploadLateTelemetryHealth: vi.fn(async () => false),
}))

vi.mock("../debug/flag", () => ({ DEBUG_LOGS: true }))
vi.mock("../debug/log-store", () => ({ devLog: () => {} }))
vi.mock("../host/container", () => ({ insideContainer: async () => false }))
vi.mock("./environment", () => ({ detectHostKind: () => "browser" }))
vi.mock("./game-log", () => ({
  closeExpiredDeliveryHealth: calls.closeExpiredDeliveryHealth,
  installHandoverSink: () => () => {},
  LATE_UPLOAD_DELAY_MS: 15_000,
  uploadLateGameLog: calls.uploadLateGameLog,
}))
vi.mock("./health-event", () => ({ uploadLateTelemetryHealth: calls.uploadLateTelemetryHealth }))
vi.mock("./game-log-outbox", () => ({ installGameLogOutbox: () => () => {} }))
vi.mock("./init", () => ({
  configFromEnvironment: () => ({ dsn: "https://key@o1.ingest.de.sentry.io/42" }),
  setHostKind: () => {},
  startTelemetryWith: () => true,
  telemetryStarted: () => true,
}))

beforeEach(() => {
  vi.resetModules()
  vi.useFakeTimers()
  calls.closeExpiredDeliveryHealth.mockReset().mockResolvedValue(undefined)
  calls.uploadLateGameLog.mockReset().mockResolvedValue(false)
  calls.uploadLateTelemetryHealth.mockReset().mockResolvedValue(false)
})

afterEach(() => vi.useRealTimers())

it("starts the late game log even when closing expired health never settles", async () => {
  calls.closeExpiredDeliveryHealth.mockImplementation(() => new Promise<void>(() => {}))
  const { startTelemetry } = await import("./boot")
  startTelemetry()
  await vi.advanceTimersByTimeAsync(15_000)

  expect(calls.closeExpiredDeliveryHealth).toHaveBeenCalledOnce()
  expect(calls.uploadLateTelemetryHealth).not.toHaveBeenCalled()
  expect(calls.uploadLateGameLog).toHaveBeenCalledOnce()
})

it("uploads late health after expired records have been closed", async () => {
  const { startTelemetry } = await import("./boot")
  startTelemetry()
  await vi.advanceTimersByTimeAsync(15_000)

  expect(calls.closeExpiredDeliveryHealth).toHaveBeenCalledOnce()
  expect(calls.uploadLateTelemetryHealth).toHaveBeenCalledOnce()
})
