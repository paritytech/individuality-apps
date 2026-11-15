// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as Sentry from "@sentry/react"

import { resetTelemetryForTests, startTelemetryWith, type TransportFactory } from "./init"
import { flushMetrics, recordCount, recordDistribution, recordGauge } from "./metrics"
import { setScopeTags } from "./scope-tags"
import { recordingTransport, testConfig } from "./test-transport"

beforeEach(async () => {
  await resetTelemetryForTests()
  Sentry.getIsolationScope().setTag("device.os", undefined)
})

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

describe("the metrics doorway", () => {
  it("sends a distribution, a gauge and a count with string attributes and the scope's tags", async () => {
    const sink = recordingTransport()
    startTelemetryWith(testConfig({ makeTransport: sink.factory }))
    await provenGate(sink)
    Sentry.setTags({ "game.index": "7", "device.os": "Android" })
    recordDistribution("rtc.rtt_ms", 180, "millisecond", { "rtc.path": "relay", round: "1" })
    recordGauge("rtc.peers", 3, "none", {})
    recordCount("rtc.quality_limited", 1, { reason: "cpu" })
    flushMetrics()
    await Sentry.flush(1000)
    const items = metricItems(sink)
    expect(items.map((item) => [item.name, item.type, item.value])).toEqual([
      ["rtc.rtt_ms", "distribution", 180],
      ["rtc.peers", "gauge", 3],
      ["rtc.quality_limited", "counter", 1],
    ])
    const [rtt] = items
    expect(rtt.unit).toBe("millisecond")
    expect(rtt.attributes["rtc.path"]).toEqual({ type: "string", value: "relay" })
    expect(rtt.attributes.round).toEqual({ type: "string", value: "1" })
    expect(rtt.attributes["host.kind"]).toEqual({ type: "string", value: "android" })
    expect(rtt.attributes["game.index"]).toEqual({ type: "string", value: "7" })
    expect(rtt.attributes["device.os"]).toEqual({ type: "string", value: "Android" })
    expect(rtt.attributes["session.id"]).toEqual({ type: "string", value: "session-1" })
    // a tag nobody set is not an attribute
    expect(rtt.attributes["net.type"]).toBeUndefined()
  })

  it("puts a whole burst in ONE envelope once flushed", async () => {
    const sink = recordingTransport()
    startTelemetryWith(testConfig({ makeTransport: sink.factory }))
    await provenGate(sink)
    for (const value of [80, 120, 150, 400, 95]) recordDistribution("rtc.rtt_ms", value, "millisecond", {})
    flushMetrics()
    await Sentry.flush(1000)
    expect(sink.items("trace_metric")).toHaveLength(1)
    expect(metricItems(sink).map((item) => item.value)).toEqual([80, 120, 150, 400, 95])
  })

  it("sends metric-only envelopes on the same open lane as events", async () => {
    const sink = recordingTransport()
    startTelemetryWith(testConfig({ makeTransport: sink.factory }))
    recordDistribution("rtc.rtt_ms", 70, "millisecond", {})
    flushMetrics()
    recordDistribution("rtc.rtt_ms", 75, "millisecond", {})
    flushMetrics()
    Sentry.captureMessage("an event")
    await Sentry.flush(1000)
    expect(metricItems(sink).map((item) => item.value)).toEqual([70, 75])
    expect(sink.items("event").map((item) => item.payload.message)).toEqual(["an event"])
  })

  describe("a round summary on a bad link (#320)", () => {
    afterEach(() => {
      vi.useRealTimers()
      vi.unstubAllGlobals()
    })

    it("sends the summary after a slow delivery mid-game", async () => {
      const sink = recordingTransport()
      const factory: TransportFactory = (options) => {
        const inner = sink.factory(options)
        return {
          send: async (envelope) => {
            await new Promise((resolve) => setTimeout(resolve, 5_000))
            return inner.send(envelope)
          },
          flush: inner.flush,
        }
      }
      vi.useFakeTimers()
      startTelemetryWith(testConfig({ makeTransport: factory }))
      Sentry.captureMessage("join journey")
      recordDistribution("rtc.decode_ms", 12, "millisecond", { stat: "p50" })
      recordCount("rtc.quality_limited", 1, { reason: "bandwidth" })
      flushMetrics()
      await vi.advanceTimersByTimeAsync(5_000)
      await vi.runAllTimersAsync()
      expect(metricItems(sink).map((item) => item.name)).toEqual(["rtc.decode_ms", "rtc.quality_limited"])
    })

    it("survives a blackout: a summary emitted while offline goes when the link is back", async () => {
      const page = new EventTarget()
      const nav = { onLine: true }
      vi.stubGlobal("window", page)
      vi.stubGlobal("navigator", nav)
      const sink = recordingTransport()
      const factory: TransportFactory = (options) => {
        const inner = sink.factory(options)
        return {
          send: async (envelope) => {
            if (!nav.onLine) throw new TypeError("Failed to fetch")
            return inner.send(envelope)
          },
          flush: inner.flush,
        }
      }
      startTelemetryWith(testConfig({ makeTransport: factory }))
      await provenGate(sink)
      nav.onLine = false
      Sentry.captureMessage("rtc.reconnect") // answered offline: the drain pauses
      await Sentry.flush(200)
      recordDistribution("rtc.heal_ms", 9000, "millisecond", {})
      flushMetrics()
      await Sentry.flush(200)
      expect(metricItems(sink)).toEqual([])
      nav.onLine = true
      page.dispatchEvent(new Event("online"))
      await Sentry.flush(1000)
      expect(sink.items("event").map((item) => item.payload.message)).toEqual(["rtc.reconnect"])
      expect(metricItems(sink).map((item) => [item.name, item.value])).toEqual([["rtc.heal_ms", 9000]])
    })
  })

  it("is a no-op, and never throws, with telemetry off", () => {
    expect(() => recordDistribution("rtc.rtt_ms", 80, "millisecond", {})).not.toThrow()
    expect(() => recordGauge("rtc.peers", 1, "none", {})).not.toThrow()
    expect(() => recordCount("rtc.quality_limited", 1, {})).not.toThrow()
    expect(() => flushMetrics()).not.toThrow()
  })

  it("drops a value that is not a finite number", async () => {
    const sink = recordingTransport()
    startTelemetryWith(testConfig({ makeTransport: sink.factory }))
    await provenGate(sink)
    recordDistribution("rtc.rtt_ms", Number.NaN, "millisecond", {})
    recordDistribution("rtc.rtt_ms", Number.POSITIVE_INFINITY, "millisecond", {})
    recordDistribution("rtc.rtt_ms", 90, "millisecond", {})
    flushMetrics()
    await Sentry.flush(1000)
    expect(metricItems(sink).map((item) => item.value)).toEqual([90])
  })

  it("carries the device, OS version, host app version and effective network tags", async () => {
    const sink = recordingTransport()
    startTelemetryWith(testConfig({ makeTransport: sink.factory }))
    await provenGate(sink)
    setScopeTags({ "device.gpu": "Adreno 740", "device.os_version": "14", "host.app_version": "1.4.2", "net.effective": "4g" })
    recordGauge("ui.slow_frame_pct", 5, "percent", {})
    flushMetrics()
    await Sentry.flush(1000)
    const [point] = metricItems(sink)
    expect(point.attributes["device.gpu"]).toEqual({ type: "string", value: "Adreno 740" })
    expect(point.attributes["device.os_version"]).toEqual({ type: "string", value: "14" })
    expect(point.attributes["host.app_version"]).toEqual({ type: "string", value: "1.4.2" })
    expect(point.attributes["net.effective"]).toEqual({ type: "string", value: "4g" })
  })
})
