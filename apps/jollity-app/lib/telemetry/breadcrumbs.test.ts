// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { beforeEach, describe, expect, it } from "vitest"
import * as Sentry from "@sentry/react"

import { devLog, toSinkEntry } from "../debug/log-store"
import { breadcrumbFor } from "./breadcrumbs"
import { resetTelemetryForTests, startTelemetryWith } from "./init"
import { recordingTransport, testConfig } from "./test-transport"

const PHRASE = "abandon ability able about above absent absorb abstract absurd abuse access accident"

let sink: ReturnType<typeof recordingTransport>
beforeEach(async () => {
  await resetTelemetryForTests()
  sink = recordingTransport()
  startTelemetryWith(testConfig({ makeTransport: sink.factory }))
})

describe("breadcrumbs", () => {
  it("maps a line's tag, level and data", () => {
    expect(breadcrumbFor(toSinkEntry({ time: 1_700_000_000_000, level: "warn", tag: "rtc", message: "ice failed", data: { peer: "5P", n: 3n } }))).toEqual({
      category: "rtc",
      level: "warning",
      message: "ice failed",
      timestamp: 1_700_000_000,
      data: { data: '{"peer":"5P","n":"3n"}' },
    })
  })

  it("never turns a log line into an event", async () => {
    devLog("camera", "camera open")
    devLog("rtc", "ice failed", undefined, "error")
    await Sentry.flush(1000)
    expect(sink.envelopes).toHaveLength(0)
  })

  it("rides the next event, in order", async () => {
    devLog("camera", "camera open")
    devLog("rtc", "ice failed", undefined, "error")
    Sentry.captureMessage("probe")
    await Sentry.flush(1000)
    const crumbs = sink.items("event")[0].payload.breadcrumbs
    expect(crumbs.map((crumb: { category: string; level: string }) => [crumb.category, crumb.level])).toEqual([
      ["camera", "info"],
      ["rtc", "error"],
    ])
  })

  it("redacts a mnemonic in a breadcrumb and in an event", async () => {
    devLog("signup", `phrase ${PHRASE}`, { seed: PHRASE })
    Sentry.captureMessage(`oops ${PHRASE}`)
    await Sentry.flush(1000)
    const payload = JSON.stringify(sink.items("event")[0].payload)
    expect(payload).not.toContain("abandon ability")
    expect(payload).toContain("[redacted: mnemonic-like string]")
  })

  it("stops once telemetry is reset", async () => {
    await resetTelemetryForTests()
    const quiet = recordingTransport()
    startTelemetryWith(testConfig({ makeTransport: quiet.factory }))
    Sentry.captureMessage("probe")
    await Sentry.flush(1000)
    expect(quiet.items("event")[0].payload.breadcrumbs ?? []).toHaveLength(0)
  })
})
