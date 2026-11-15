// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { beforeEach, describe, expect, it, vi } from "vitest"
import * as Sentry from "@sentry/react"

// the store is module state, so each test gets a fresh copy
let lp: typeof import("./low-power")
beforeEach(async () => {
  vi.resetModules()
  lp = await import("./low-power")
})

describe("low power mode", () => {
  it("is off by default", () => {
    expect(lp.getLowPower()).toBe(false)
  })

  it("turns on and off with setLowPower", () => {
    lp.setLowPower(true)
    expect(lp.getLowPower()).toBe(true)
    lp.setLowPower(false)
    expect(lp.getLowPower()).toBe(false)
  })

  it("tells the listeners about a change, and only about a change", () => {
    const seen = vi.fn()
    const stop = lp.subscribeLowPower(seen)
    lp.setLowPower(false)
    expect(seen).not.toHaveBeenCalled()
    lp.setLowPower(true)
    lp.setLowPower(true)
    expect(seen).toHaveBeenCalledTimes(1)
    stop()
    lp.setLowPower(false)
    expect(seen).toHaveBeenCalledTimes(1)
  })

  it("records why the mode came on, one value, and none when it goes off", () => {
    expect(lp.getLowPowerReason()).toBe("none")
    lp.setLowPower(true, "debug-menu")
    expect(lp.getLowPowerReason()).toBe("debug-menu")
    lp.setLowPower(false)
    expect(lp.getLowPowerReason()).toBe("none")
    lp.setLowPower(true)
    expect(lp.getLowPowerReason()).toBe("manual")
    lp.setLowPower(true, "probe-weak") // already on: the first reason stands
    expect(lp.getLowPowerReason()).toBe("manual")
  })

  it("reads url for ?lowpower=1", async () => {
    vi.resetModules()
    vi.stubGlobal("window", { location: { search: "?lowpower=1" } })
    try {
      lp = await import("./low-power")
      expect(lp.getLowPower()).toBe(true)
      expect(lp.getLowPowerReason()).toBe("url")
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it("puts the reason on the telemetry tags", async () => {
    const init = await import("./telemetry/init")
    const { recordingTransport, testConfig } = await import("./telemetry/test-transport")
    const telemetry = await import("./telemetry")
    await init.resetTelemetryForTests()
    const sink = recordingTransport()
    init.startTelemetryWith(testConfig({ makeTransport: sink.factory }))
    lp.setLowPower(true, "debug-menu")
    telemetry.recordDistribution("ui.frame_ms", 16, "millisecond", {})
    telemetry.flushMetrics()
    await Sentry.flush(1000)
    const points = sink.items("trace_metric").flatMap((item) => item.payload.items as Array<{ attributes: Record<string, unknown> }>)
    expect(points[0].attributes["lowpower.reason"]).toEqual({ type: "string", value: "debug-menu" })
    await init.resetTelemetryForTests()
  })

  it("puts the mode on the telemetry tags", async () => {
    const init = await import("./telemetry/init")
    const { recordingTransport, testConfig } = await import("./telemetry/test-transport")
    const telemetry = await import("./telemetry")
    await init.resetTelemetryForTests()
    const sink = recordingTransport()
    init.startTelemetryWith(testConfig({ makeTransport: sink.factory }))
    lp.setLowPower(true)
    telemetry.recordDistribution("ui.frame_ms", 16, "millisecond", {})
    telemetry.flushMetrics()
    await Sentry.flush(1000)
    const points = sink.items("trace_metric").flatMap((item) => item.payload.items as Array<{ attributes: Record<string, unknown> }>)
    expect(points[0].attributes.lowpower).toEqual({ type: "string", value: "on" })
    expect(points[0].attributes.probe).toEqual({ type: "string", value: "none" })
    await init.resetTelemetryForTests()
  })
})
