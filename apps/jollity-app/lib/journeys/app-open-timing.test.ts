// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/** The app-open steps measured by the REAL journey: a step's span lasts from
 *  the call that starts it to the call that ends it. */
import { beforeEach, describe, expect, it, vi } from "vitest"
import * as Sentry from "@sentry/react"

import { resetTelemetryForTests, startTelemetryWith } from "../telemetry/init"
import { recordingTransport, testConfig } from "../telemetry/test-transport"
import { appOpenStep, endAppOpen, resetAppOpenForTests } from "./app-open"

let sink: ReturnType<typeof recordingTransport>
beforeEach(async () => {
  vi.useRealTimers()
  resetAppOpenForTests()
  await resetTelemetryForTests()
  sink = recordingTransport()
  startTelemetryWith(testConfig({ makeTransport: sink.factory }))
})

describe("app-open step timing", () => {
  it("spans the delay injected between a step's start and its end", async () => {
    const step = appOpenStep("host.connect")
    await new Promise((resolve) => setTimeout(resolve, 120))
    step.end()
    endAppOpen("ready")
    await Sentry.flush(1000)
    const [tx] = sink.items("transaction").map((item) => item.payload)
    const span = tx.spans.find((candidate: { op: string }) => candidate.op === "app-open.host.connect")
    const ms = (span.timestamp - span.start_timestamp) * 1000
    expect(ms).toBeGreaterThanOrEqual(100)
    expect(ms).toBeLessThan(1000)
  })
})
