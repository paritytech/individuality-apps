// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as Sentry from "@sentry/react"

import { resetTelemetryForTests, startTelemetryWith } from "./init"
import { captureMeasurementTransaction, type NumericMeasurement } from "./measurements"
import { recordingTransport, testConfig } from "./test-transport"

beforeEach(async () => {
  await resetTelemetryForTests()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe("captureMeasurementTransaction", () => {
  it("sends numeric measurements through the initialized app transport", async () => {
    const sink = recordingTransport()
    expect(startTelemetryWith(testConfig({ makeTransport: sink.factory, testTag: "e2e-bot" }))).toBe(true)
    expect(
      captureMeasurementTransaction(
        "rtc.send_adaptation.change",
        { direction: "down", cause: "bandwidth", from_rung: "0", to_rung: "4" },
        {
          "rtc.send.before.actual_kbps": { value: 290, unit: "none" },
          "rtc.send.after.actual_kbps": { value: 180, unit: "none" },
          "rtc.send.before.effects_frame_p95_ms": { value: 61, unit: "millisecond" },
        },
        { startMs: 1_000, endMs: 4_000 },
      ),
    ).toBe("sent")
    await Sentry.flush(1_000)
    const [event] = sink.items("transaction")
    expect(event.payload.measurements["rtc.send.after.actual_kbps"]).toEqual({ value: 180, unit: "none" })
    expect(event.payload.tags).toMatchObject({ "host.kind": "android", "test.tag": "e2e-bot", direction: "down" })
    expect(event.payload).toMatchObject({ transaction: "rtc.send_adaptation.change", spans: [] })
  })

  it("omits undefined and non-finite values before enforcing the cap", async () => {
    const sink = recordingTransport()
    startTelemetryWith(testConfig({ makeTransport: sink.factory }))
    const values: Record<string, NumericMeasurement | undefined> = Object.fromEntries(
      Array.from({ length: 10 }, (_, index) => [`m${index}`, { value: index, unit: "none" }]),
    )
    values.missing = undefined
    values.nan = { value: Number.NaN, unit: "none" }
    expect(captureMeasurementTransaction("rtc.send_adaptation.round", {}, values, { startMs: 1, endMs: 2 })).toBe("sent")
    await Sentry.flush(1_000)
    expect(Object.keys(sink.items("transaction")[0].payload.measurements)).toHaveLength(10)
  })

  it("rejects eleven finite values before transport", async () => {
    const sink = recordingTransport()
    startTelemetryWith(testConfig({ makeTransport: sink.factory }))
    const values: Record<string, NumericMeasurement> = Object.fromEntries(
      Array.from({ length: 11 }, (_, index) => [`m${index}`, { value: index, unit: "none" as const }]),
    )
    expect(captureMeasurementTransaction("rtc.send_adaptation.round", {}, values, { startMs: 1, endMs: 2 })).toBe("too-many")
    await Sentry.flush(1_000)
    expect(sink.items("transaction")).toHaveLength(0)
  })

  it("never throws when capture fails", () => {
    const sink = recordingTransport()
    startTelemetryWith(testConfig({ makeTransport: sink.factory }))
    vi.stubGlobal("crypto", { getRandomValues: () => { throw new Error("entropy unavailable") } })
    expect(captureMeasurementTransaction("rtc.send_adaptation.round", {}, { value: { value: 1, unit: "none" } }, { startMs: 1, endMs: 2 })).toBe("skipped")
  })
})
