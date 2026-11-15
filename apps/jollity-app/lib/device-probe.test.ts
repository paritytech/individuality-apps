// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as Sentry from "@sentry/react"

// the result and the low power mode are module state, so each test gets a fresh copy
let probe: typeof import("./device-probe")
let lp: typeof import("./low-power")

// a fake requestAnimationFrame the test steps by hand
let callbacks = new Map<number, (ts: number) => void>()
let nextId = 1
let now = 0
let doc: EventTarget & { visibilityState: string }

function frames(deltas: number[]): void {
  for (const delta of deltas) {
    now += delta
    const due = [...callbacks.values()]
    callbacks = new Map()
    for (const callback of due) callback(now)
  }
}

function setVisibility(state: string): void {
  doc.visibilityState = state
  doc.dispatchEvent(new Event("visibilitychange"))
}

beforeEach(async () => {
  vi.resetModules()
  probe = await import("./device-probe")
  lp = await import("./low-power")
  callbacks = new Map()
  nextId = 1
  now = 1000
  doc = Object.assign(new EventTarget(), { visibilityState: "visible" })
  vi.stubGlobal("document", doc)
  vi.stubGlobal("window", new EventTarget())
  vi.stubGlobal("requestAnimationFrame", (callback: (ts: number) => void) => {
    const id = nextId++
    callbacks.set(id, callback)
    return id
  })
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    callbacks.delete(id)
  })
})
afterEach(() => {
  vi.unstubAllGlobals()
})

const S = (p95Ms: number, frames = 100, steady = false) => ({ p95Ms, medianMs: 16.7, frames, steady })

describe("judge and decide", () => {
  it("judges a 60 fps sample", () => {
    expect(probe.judge(Array<number>(120).fill(16.7))).toEqual({ p95Ms: 16.7, medianMs: 16.7, frames: 120, steady: false })
  })

  // game 210: iOS Low Power Mode caps at 30 fps, 59 frames in 2 s, p95 59 ms
  const steady30 = (): number[] => [...Array<number>(55).fill(33.3), 59, 59, 59, 59]
  // 30 fps median, but a fifth of the frames are 50 ms drops: p95 50 (borderline band), more than 10 % drops
  const janky30 = (): number[] => [...Array<number>(48).fill(33.3), ...Array<number>(12).fill(50)]

  it("calls a 30 fps cap with a few drops steady, and confirms it with a second steady sample", () => {
    const sample = probe.judge(steady30())!
    expect(sample).toMatchObject({ medianMs: 33.3, p95Ms: 59, steady: true })
    expect(probe.decide([sample])).toBeUndefined()
    expect(probe.decide([sample, probe.judge(steady30())!])).toMatchObject({ weak: false, rule: "steady-cap" })
  })

  it("confirms weak when a steady first sample is followed by a weak-looking second one (a weak phone at 30 fps)", () => {
    const first = probe.judge(steady30())!
    expect(probe.decide([first, S(55)])).toMatchObject({ weak: true, rule: "weak-confirmed" })
  })

  it("does not call a janky 33 ms-median phone steady: it follows the #522 second-sample rule", () => {
    const sample = probe.judge(janky30())!
    expect(sample).toMatchObject({ medianMs: 33.3, p95Ms: 50, steady: false })
    expect(probe.decide([sample])).toBeUndefined()
    expect(probe.decide([sample, S(52)])).toMatchObject({ weak: true, rule: "weak-confirmed" })
    expect(probe.decide([sample, S(48)])).toMatchObject({ weak: false, rule: "borderline-fine" })
  })

  it("is weak for a slow Android-like sample whatever its spread", () => {
    const slow = probe.judge([...Array<number>(20).fill(100), ...Array<number>(10).fill(200)])!
    expect(slow.steady).toBe(false)
    expect(probe.decide([slow])).toMatchObject({ weak: true, rule: "weak" })
  })

  it("does not treat a 60 fps phone with a spiky tail as a cap", () => {
    const spiky = probe.judge([...Array<number>(110).fill(16.7), ...Array<number>(10).fill(55)])!
    expect(spiky.steady).toBe(false)
  })

  it("clears a borderline first sample when the second one is steady", () => {
    expect(probe.decide([S(55), S(58, 60, true)])).toMatchObject({ weak: false, rule: "borderline-fine" })
  })

  it("has no sample with no frames", () => {
    expect(probe.judge([])).toBeUndefined()
  })

  it("keeps full mode below the band at once", () => {
    expect(probe.decide([S(44.9)])).toMatchObject({ weak: false, rule: "fine" })
  })

  it("asks for a second sample exactly at the old limit of 50 ms", () => {
    expect(probe.decide([S(50, 94)])).toBeUndefined()
  })

  it("asks for a second sample at the bottom of the band, and weak starts at 60", () => {
    expect(probe.decide([S(45)])).toBeUndefined()
    expect(probe.decide([S(59.9)])).toBeUndefined()
    expect(probe.decide([S(60)])).toMatchObject({ weak: true, rule: "weak" })
  })

  it("is weak at once for a clearly weak phone, whatever a second sample would say", () => {
    for (const p95 of [83, 133]) expect(probe.decide([S(p95)])).toMatchObject({ weak: true, rule: "weak" })
  })

  it("clears a borderline phone when the second sample is fine", () => {
    expect(probe.decide([S(50, 94), S(30)])).toMatchObject({ weak: false, rule: "borderline-fine", p95Ms: 30 })
  })

  it("clears a borderline phone when the second sample is exactly 50 (strict line)", () => {
    expect(probe.decide([S(55), S(50)])).toMatchObject({ weak: false, rule: "borderline-fine" })
  })

  it("switches a borderline phone when both samples are weak", () => {
    const result = probe.decide([S(50, 94), S(52, 90)])
    expect(result).toMatchObject({ weak: true, rule: "weak-confirmed", samples: [S(50, 94), S(52, 90)] })
  })
})

describe("runProbe", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  const fresh = (): import("./device-probe").ProbeProgress => ({ samples: [], attempts: 0 })

  /** warm up, then run one sample of the given frame time */
  function runSample(delta: number): void {
    vi.advanceTimersByTime(probe.PROBE_WARMUP_MS)
    frames([0, ...Array<number>(Math.ceil(probe.PROBE_MEASURE_MS / delta) + 1).fill(delta)])
  }

  /** warm up, start a sample, and hide the page during it */
  function hideMidSample(): void {
    vi.advanceTimersByTime(probe.PROBE_WARMUP_MS)
    frames([0, 20])
    setVisibility("hidden")
  }

  it("decides on one sample for a clearly weak phone", () => {
    const done = vi.fn()
    probe.runProbe(fresh(), done)
    runSample(80)
    expect(done).toHaveBeenCalledTimes(1)
    expect(done.mock.calls[0][0]).toMatchObject({ weak: true, rule: "weak", attempts: 0 })
    expect(done.mock.calls[0][0].samples).toHaveLength(1)
  })

  it("decides on one sample for a fine phone", () => {
    const done = vi.fn()
    probe.runProbe(fresh(), done)
    runSample(16.7)
    expect(done.mock.calls[0][0]).toMatchObject({ weak: false, rule: "fine" })
  })

  it("takes a second sample inside the band and keeps full mode when it is fine", () => {
    const done = vi.fn()
    probe.runProbe(fresh(), done)
    runSample(52)
    expect(done).not.toHaveBeenCalled()
    runSample(16.7)
    expect(done).toHaveBeenCalledTimes(1)
    const result = done.mock.calls[0][0]
    expect(result).toMatchObject({ weak: false, rule: "borderline-fine" })
    expect(result.samples.map((x: { p95Ms: number }) => Math.round(x.p95Ms))).toEqual([52, 17])
  })

  it("switches when both samples are weak", () => {
    const done = vi.fn()
    probe.runProbe(fresh(), done)
    runSample(52)
    runSample(55)
    expect(done.mock.calls[0][0]).toMatchObject({ weak: true, rule: "weak-confirmed" })
  })

  it("retries a hidden sample when the page shows, and does not count the time hidden", () => {
    const done = vi.fn()
    const progress = fresh()
    probe.runProbe(progress, done)
    runSample(52)
    hideMidSample()
    expect(done).not.toHaveBeenCalled()
    expect(progress.attempts).toBe(1)
    vi.advanceTimersByTime(30_000)
    frames([16.7, 16.7])
    expect(progress.attempts).toBe(1)
    expect(callbacks.size).toBe(0)
    setVisibility("visible")
    runSample(16.7)
    expect(done).toHaveBeenCalledTimes(1)
    expect(done.mock.calls[0][0]).toMatchObject({ weak: false, rule: "borderline-fine", attempts: 1 })
    expect(done.mock.calls[0][0].samples).toHaveLength(2)
  })

  it("turns low power on with no-verdict after three hidden samples", () => {
    const done = vi.fn()
    probe.runProbe(fresh(), done)
    for (let i = 0; i < probe.PROBE_MAX_ATTEMPTS; i++) {
      if (i > 0) setVisibility("visible")
      hideMidSample()
    }
    expect(done).toHaveBeenCalledTimes(1)
    expect(done.mock.calls[0][0]).toMatchObject({ weak: true, rule: "no-verdict", attempts: 3, p95Ms: null, samples: [] })
    setVisibility("visible")
    vi.advanceTimersByTime(10_000)
    expect(done).toHaveBeenCalledTimes(1)
  })

  it("reports nothing on a cancel after a borderline first sample, and the next run takes the second sample only", () => {
    const first = vi.fn()
    const progress = fresh()
    const cancel = probe.runProbe(progress, first)
    runSample(52)
    vi.advanceTimersByTime(probe.PROBE_WARMUP_MS)
    frames([0, 20])
    cancel()
    cancel()
    frames([3000])
    setVisibility("hidden")
    vi.advanceTimersByTime(10_000)
    expect(first).not.toHaveBeenCalled()
    expect(callbacks.size).toBe(0)
    expect(progress.attempts).toBe(0)
    expect(progress.samples).toHaveLength(1)

    setVisibility("visible")
    const second = vi.fn()
    probe.runProbe(progress, second)
    runSample(55)
    expect(second).toHaveBeenCalledTimes(1)
    expect(second.mock.calls[0][0]).toMatchObject({ weak: true, rule: "weak-confirmed", attempts: 0 })
    expect(second.mock.calls[0][0].samples).toHaveLength(2)
  })

  it("reports nothing when cancelled before any sample, or after the decision", () => {
    const early = vi.fn()
    probe.runProbe(fresh(), early)()
    const late = vi.fn()
    const cancel = probe.runProbe(fresh(), late)
    runSample(16.7)
    cancel()
    vi.advanceTimersByTime(10_000)
    expect(early).not.toHaveBeenCalled()
    expect(late).toHaveBeenCalledTimes(1)
    expect(late.mock.calls[0][0].rule).toBe("fine")
  })

  it("turns low power on with no-frames when no frame comes before the sample limit", () => {
    const done = vi.fn()
    probe.runProbe(fresh(), done)
    vi.advanceTimersByTime(probe.PROBE_WARMUP_MS)
    vi.advanceTimersByTime(probe.PROBE_SAMPLE_LIMIT_MS - 1)
    expect(done).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(done).toHaveBeenCalledTimes(1)
    expect(done.mock.calls[0][0]).toMatchObject({ weak: true, rule: "no-frames", p95Ms: null, attempts: 0 })
    expect(callbacks.size).toBe(0)
  })

  it("judges a slow sample that ends on the limit on the frames it has", () => {
    const done = vi.fn()
    probe.runProbe(fresh(), done)
    vi.advanceTimersByTime(probe.PROBE_WARMUP_MS)
    frames([0, 300, 300])
    vi.advanceTimersByTime(probe.PROBE_SAMPLE_LIMIT_MS)
    expect(done).toHaveBeenCalledTimes(1)
    expect(done.mock.calls[0][0]).toMatchObject({ weak: true, rule: "weak", p95Ms: 300, frames: 2 })
  })

  it("fits the two samples well inside the 20 s before kickoff", () => {
    expect(2 * (probe.PROBE_WARMUP_MS + probe.PROBE_MEASURE_MS)).toBeLessThan(probe.PROBE_AT_SECONDS * 1000 - 2000)
  })
})

describe("sampleFrames", () => {
  it("stops after the given frame time", () => {
    const done = vi.fn()
    probe.sampleFrames(100, done)
    frames([0, 20, 20, 20, 20])
    expect(done).not.toHaveBeenCalled()
    frames([20])
    expect(done).toHaveBeenCalledWith([20, 20, 20, 20, 20])
    expect(callbacks.size).toBe(0)
    frames([20])
    expect(done).toHaveBeenCalledTimes(1)
  })

  it("calls done(null) when the page hides", () => {
    const done = vi.fn()
    probe.sampleFrames(100, done)
    frames([0, 20])
    setVisibility("hidden")
    expect(done).toHaveBeenCalledWith(null)
    expect(callbacks.size).toBe(0)
    setVisibility("visible")
    setVisibility("hidden")
    expect(done).toHaveBeenCalledTimes(1)
  })

  it("calls done(null) at once on a hidden page", () => {
    doc.visibilityState = "hidden"
    const done = vi.fn()
    probe.sampleFrames(100, done)
    expect(done).toHaveBeenCalledWith(null)
    expect(callbacks.size).toBe(0)
  })

  it("never calls done after the cancel", () => {
    const done = vi.fn()
    const cancel = probe.sampleFrames(100, done)
    frames([0, 20])
    cancel()
    expect(callbacks.size).toBe(0)
    frames([200])
    setVisibility("hidden")
    expect(done).not.toHaveBeenCalled()
  })
})

describe("applyProbe", () => {
  const weak = { p95Ms: 80, frames: 40, weak: true, samples: [S(80, 40)], rule: "weak" as const, attempts: 0 }
  const fine = { p95Ms: 16.7, frames: 120, weak: false, samples: [S(16.7, 120)], rule: "fine" as const, attempts: 0 }
  const noVerdict = { p95Ms: null, frames: 0, weak: true, samples: [], rule: "no-verdict" as const, attempts: 3 }

  it("turns low power mode on for a weak device", () => {
    probe.applyProbe(weak, "countdown")
    expect(lp.getLowPower()).toBe(true)
    expect(probe.getProbeResult()).toEqual(weak)
  })

  it("keeps full mode for a device that is not weak", () => {
    probe.applyProbe(fine, "countdown")
    expect(lp.getLowPower()).toBe(false)
    expect(probe.getProbeResult()).toEqual(fine)
  })

  it("turns low power mode on with probe-no-verdict when the check could not measure", () => {
    probe.applyProbe(noVerdict, "late")
    expect(lp.getLowPower()).toBe(true)
    expect(lp.getLowPowerReason()).toBe("probe-no-verdict")
    expect(probe.getProbeResult()).toEqual(noVerdict)
  })

  it("has no result before a probe", () => {
    expect(probe.getProbeResult()).toBeUndefined()
  })
})

describe("the probe metrics", () => {
  type Point = { name: string; value: number; unit: string; attributes: Record<string, { value: unknown }> }
  let init: typeof import("./telemetry/init")
  let telemetry: typeof import("./telemetry")
  let sink: ReturnType<typeof import("./telemetry/test-transport").recordingTransport>

  beforeEach(async () => {
    init = await import("./telemetry/init")
    telemetry = await import("./telemetry")
    const { recordingTransport, testConfig } = await import("./telemetry/test-transport")
    await init.resetTelemetryForTests()
    sink = recordingTransport()
    init.startTelemetryWith(testConfig({ makeTransport: sink.factory }))
  })
  afterEach(async () => {
    await init.resetTelemetryForTests()
  })

  async function probePoints(): Promise<Point[]> {
    telemetry.flushMetrics()
    await Sentry.flush(1000)
    const points = sink.items("trace_metric").flatMap((item) => item.payload.items as Point[])
    return points.filter((point) => point.name.startsWith("ui.probe_"))
  }

  const plain = (point: Point, keys: string[]) => Object.fromEntries(keys.map((key) => [key, point.attributes[key]?.value]))

  const weakResult = { p95Ms: 80, frames: 40, weak: true, samples: [S(80, 40)], rule: "weak" as const, attempts: 0 }

  it("sends the median beside the p95, with the deciding sample's tags", async () => {
    probe.applyProbe({ ...weakResult, samples: [{ ...S(80, 40), medianMs: 70 }] }, "countdown")
    const p50 = (await probePoints()).filter((point) => point.name === "ui.probe_frame_median_ms")
    expect(p50.map((point) => [point.name, point.value, point.attributes.stat])).toEqual([["ui.probe_frame_median_ms", 70, undefined]])
    expect(plain(p50[0], ["probe.rule", "probe.samples"])).toEqual({ "probe.rule": "weak", "probe.samples": "1" })
  })

  it("sends the per-device metrics and one sample point, with the version, the band, the rule, the stage and the final tags", async () => {
    probe.applyProbe({ ...weakResult, attempts: 1 }, "late")
    const points = await probePoints()
    expect(points.map((point) => [point.name, point.value, point.unit])).toEqual([
      ["ui.probe_frame_ms", 80, "millisecond"],
      ["ui.probe_frame_median_ms", 16.7, "millisecond"],
      ["ui.probe_frames", 40, "none"],
      ["ui.probe_sample_ms", 80, "millisecond"],
      ["ui.probe_sample_frames", 40, "none"],
    ])
    const keys = ["probe.version", "probe.borderline_from_ms", "probe.weak_from_ms", "probe.rule", "probe.stage", "probe.attempts", "probe.samples", "probe", "lowpower"]
    const tags = {
      "probe.version": "5",
      "probe.borderline_from_ms": "45",
      "probe.weak_from_ms": "60",
      "probe.rule": "weak",
      "probe.stage": "late",
      "probe.attempts": "1",
      "probe.samples": "1",
      probe: "done",
      lowpower: "on",
    }
    expect(plain(points[0], [...keys, "stat"])).toEqual({ ...tags, stat: "p95" })
    expect(plain(points[2], keys)).toEqual(tags)
    expect(points[0].attributes["probe.sample"]).toBeUndefined()
    expect(plain(points[3], ["probe.sample"])).toEqual({ "probe.sample": "1" })
  })

  it("counts a confirmed borderline phone once in the per-device metrics, with every sample under the sample names", async () => {
    probe.applyProbe({ p95Ms: 52, frames: 90, weak: true, samples: [S(50, 94), S(52, 90)], rule: "weak-confirmed", attempts: 0 }, "countdown")
    const points = await probePoints()
    expect(points.map((point) => [point.name, point.value, point.attributes["probe.sample"]?.value])).toEqual([
      ["ui.probe_frame_ms", 52, undefined],
      ["ui.probe_frame_median_ms", 16.7, undefined],
      ["ui.probe_frames", 90, undefined],
      ["ui.probe_sample_ms", 50, "1"],
      ["ui.probe_sample_frames", 94, "1"],
      ["ui.probe_sample_ms", 52, "2"],
      ["ui.probe_sample_frames", 90, "2"],
    ])
    for (const point of points) expect(plain(point, ["probe.rule"])).toEqual({ "probe.rule": "weak-confirmed" })
  })

  it("sends a no-verdict phone as low power with the samples it has, the stage and the attempts", async () => {
    probe.applyProbe({ p95Ms: 50, frames: 94, weak: true, samples: [S(50, 94)], rule: "no-verdict", attempts: 3 }, "late")
    const points = await probePoints()
    expect(points[0]).toMatchObject({ name: "ui.probe_frame_ms", value: 50 })
    expect(plain(points[0], ["probe.rule", "probe.stage", "probe.attempts", "lowpower", "lowpower.reason"])).toEqual({
      "probe.rule": "no-verdict",
      "probe.stage": "late",
      "probe.attempts": "3",
      lowpower: "on",
      "lowpower.reason": "probe-no-verdict",
    })
  })

  it("sends both metrics with lowpower=off for a device that is not weak", async () => {
    probe.applyProbe({ p95Ms: 16.7, frames: 120, weak: false, samples: [S(16.7, 120)], rule: "fine", attempts: 0 }, "countdown")
    const points = await probePoints()
    expect(points.map((point) => point.name)).toEqual(["ui.probe_frame_ms", "ui.probe_frame_median_ms", "ui.probe_frames", "ui.probe_sample_ms", "ui.probe_sample_frames"])
    for (const point of points) expect(plain(point, ["probe", "lowpower"])).toEqual({ probe: "done", lowpower: "off" })
  })

  it("tags the reason: probe-weak for one clear sample, probe-weak-confirmed for two", async () => {
    probe.applyProbe(weakResult, "countdown")
    expect(plain((await probePoints())[0], ["lowpower.reason"])).toEqual({ "lowpower.reason": "probe-weak" })
  })

  it("tags probe-weak-confirmed after a confirmed borderline phone", async () => {
    probe.applyProbe({ p95Ms: 52, frames: 90, weak: true, samples: [S(50, 94), S(52, 90)], rule: "weak-confirmed", attempts: 0 }, "countdown")
    expect(plain((await probePoints())[0], ["lowpower.reason"])).toEqual({ "lowpower.reason": "probe-weak-confirmed" })
  })

  it("tags none and keeps full mode for a steady cap", async () => {
    probe.applyProbe({ p95Ms: 59, frames: 59, weak: false, samples: [S(59, 59, true)], rule: "steady-cap", attempts: 0 }, "countdown")
    expect(plain((await probePoints())[0], ["lowpower", "lowpower.reason"])).toEqual({ lowpower: "off", "lowpower.reason": "none" })
    expect(lp.getLowPower()).toBe(false)
  })

  it("sends no metric for a result with no sample, but still turns low power on", async () => {
    probe.applyProbe({ p95Ms: null, frames: 0, weak: true, samples: [], rule: "no-frames", attempts: 0 }, "late")
    expect(await probePoints()).toEqual([])
    expect(lp.getLowPowerReason()).toBe("probe-no-verdict")
  })
})
