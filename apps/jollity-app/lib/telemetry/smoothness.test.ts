// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("./metrics", async () => (await import("./testing")).fakeTelemetryModule())
vi.mock("./boot", async () => (await import("./testing")).fakeTelemetryModule())

import { recorded, resetRecorded } from "./testing"
import {
  effectsHealthSnapshot,
  enterScene,
  leaveAllScenes,
  leaveScene,
  longTaskSnapshot,
  recordHeap,
  resetEffectsHealth,
  resetLongTasks,
  setMoment,
  startScene,
} from "./smoothness"

// a fake requestAnimationFrame the test steps by hand
let callbacks = new Map<number, (ts: number) => void>()
let nextId = 1
let now = 0
const doc = {
  visibilityState: "visible" as string,
  listeners: new Set<() => void>(),
  addEventListener(_: string, fn: () => void) {
    this.listeners.add(fn)
  },
  removeEventListener(_: string, fn: () => void) {
    this.listeners.delete(fn)
  },
}

// the window, where the sampler listens in the capture phase: a document
// event reaches the window's capture listeners before the document's own
const win = {
  listeners: new Set<() => void>(),
  addEventListener(_: string, fn: () => void, capture?: boolean) {
    if (capture) this.listeners.add(fn)
  },
  removeEventListener(_: string, fn: () => void, capture?: boolean) {
    if (capture) this.listeners.delete(fn)
  },
}

/** advance the clock by each delta, running one frame per delta */
function setVisibility(state: "visible" | "hidden"): void {
  doc.visibilityState = state
  for (const listener of [...win.listeners, ...doc.listeners]) listener()
}

function frames(deltas: number[]): void {
  for (const delta of deltas) {
    now += delta
    const due = [...callbacks.entries()]
    callbacks = new Map()
    for (const [, callback] of due) callback(now)
  }
}

class FakeObserver {
  static last: FakeObserver | null = null
  disconnected = false
  observed: unknown = null
  constructor(readonly callback: (list: { getEntries(): { duration: number; startTime?: number }[] }) => void) {
    FakeObserver.last = this
  }
  observe(options: unknown) {
    this.observed = options
  }
  disconnect() {
    this.disconnected = true
  }
  deliverEntries(entries: { duration: number; startTime?: number }[]) {
    this.callback({ getEntries: () => entries })
  }
  deliver(durations: number[]) {
    this.callback({ getEntries: () => durations.map((duration) => ({ duration })) })
  }
}

const named = (name: string) => recorded.metrics.filter((metric) => metric.name === name)

beforeEach(() => {
  resetRecorded()
  leaveAllScenes()
  resetEffectsHealth()
  resetLongTasks()
  setMoment(null)
  callbacks = new Map()
  nextId = 1
  now = 1000
  doc.visibilityState = "visible"
  doc.listeners.clear()
  win.listeners.clear()
  FakeObserver.last = null
  vi.stubGlobal("requestAnimationFrame", (callback: (ts: number) => void) => {
    const id = nextId++
    callbacks.set(id, callback)
    return id
  })
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    callbacks.delete(id)
  })
  vi.stubGlobal("document", doc)
  vi.stubGlobal("window", win)
  vi.stubGlobal("PerformanceObserver", FakeObserver)
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe("the frame sampler", () => {
  it("returns rolling p95 and slow-frame share without resetting scene telemetry", () => {
    const scene = startScene("game.round")
    frames([0, 16, 16, 20, 55, 80])
    expect(effectsHealthSnapshot(now + 10_000)).toMatchObject({ windowMs: 30_000, frameP95Ms: 80, slowFrameShare: 0.4 })
    expect(recorded.metrics).toEqual([])
    scene?.stop()
  })

  it("expires controller frame evidence outside the requested window", () => {
    const scene = startScene("game.round")
    frames([0, 16, 60, 80])
    expect(effectsHealthSnapshot(now + 30_001)).toEqual({ windowMs: 30_000 })
    scene?.stop()
  })

  it("omits LoAF evidence where the browser does not expose it", () => {
    startScene("game.round")
    frames([0, 16, 16, 16])
    expect(effectsHealthSnapshot(now)).not.toHaveProperty("loafP95Ms")
  })

  it("emits p50, p95 and the slow-frame share from the frame deltas, once, on stop", () => {
    const scene = startScene("game.round")
    frames([0, 16, 16, 16, 16, 16, 16, 16, 16, 60, 100]) // first frame is the baseline
    expect(recorded.metrics).toEqual([])
    scene?.stop()
    const frame = named("ui.frame_ms")
    expect(frame.map((m) => [m.attrs.stat, m.value])).toEqual([
      ["p50", 16],
      ["p95", 100],
    ])
    expect(frame.every((m) => m.type === "distribution" && m.unit === "millisecond" && m.attrs.scene === "game.round")).toBe(true)
    const slow = named("ui.slow_frame_pct")
    expect(slow).toHaveLength(1)
    expect(slow[0]).toMatchObject({ type: "gauge", unit: "percent", value: 20, attrs: { scene: "game.round" } })
    // no flush mid-game: the SDK's 5 s timer and its own flush on hidden send it
    expect(recorded.metricFlushes).toBe(0)
  })

  it("stop is idempotent: one emission per scene", () => {
    const scene = startScene("chest")
    frames([0, 16, 16, 16])
    scene?.stop()
    scene?.stop()
    expect(named("ui.slow_frame_pct")).toHaveLength(1)
    frames([16, 16])
    expect(named("ui.slow_frame_pct")).toHaveLength(1)
  })

  it("a stop with too few frames emits nothing", () => {
    const scene = startScene("chest")
    frames([0, 16])
    scene?.stop()
    expect(recorded.metrics).toEqual([])
  })

  it("emits every 30 s for a long GAME scene and starts a fresh window", () => {
    const scene = startScene("game.round")
    frames([0, ...Array<number>(1900).fill(16)]) // 30.4 s of frames
    expect(named("ui.slow_frame_pct")).toHaveLength(1)
    scene?.stop()
    expect(named("ui.slow_frame_pct")).toHaveLength(2)
  })

  it("the waiting room emits once, on stop, however long it is open", () => {
    const scene = startScene("waiting")
    // three minutes at 60 Hz: past the window AND past the ring's capacity
    frames([0, ...Array<number>(10_000).fill(16), ...Array<number>(800).fill(16), 100, 100])
    expect(recorded.metrics).toEqual([])
    scene?.stop()
    const slow = named("ui.slow_frame_pct")
    expect(slow).toHaveLength(1)
    // the share counts every frame of the scene, not only the ring's last ones
    expect(slow[0].value).toBeCloseTo((2 / 10_802) * 100, 5)
    const frame = named("ui.frame_ms")
    expect(frame.map((m) => [m.attrs.stat, m.value])).toEqual([
      ["p50", 16],
      ["p95", 16],
    ])
  })

  it("stops itself when the page turns hidden, and emits then", () => {
    startScene("waiting")
    frames([0, 16, 16, 16])
    setVisibility("hidden")
    expect(named("ui.slow_frame_pct")).toHaveLength(1)
    expect(callbacks.size).toBe(0)
    expect(win.listeners.size).toBe(0)
  })

  it("emits on hidden BEFORE the SDK's own flush on hidden (a document listener added at init)", () => {
    let seenByFlush = -1
    doc.addEventListener("visibilitychange", () => {
      seenByFlush = named("ui.slow_frame_pct").length
    })
    startScene("chest")
    frames([0, 16, 16, 16])
    setVisibility("hidden")
    expect(seenByFlush).toBe(1)
  })

  it("does nothing without requestAnimationFrame, and never throws", () => {
    vi.stubGlobal("requestAnimationFrame", undefined)
    const scene = startScene("game.round")
    expect(() => scene?.stop()).not.toThrow()
    expect(recorded.metrics).toEqual([])
  })

  it("is cheap per frame: one callback queued at a time", () => {
    startScene("draw.wheel")
    frames([0, 16, 16])
    expect(callbacks.size).toBe(1)
  })
})

describe("long tasks", () => {
  it("sends their p95, their max and their count per window, not one point per task, and disconnects", () => {
    const scene = startScene("game.confirm")
    expect(FakeObserver.last?.observed).toMatchObject({ type: "longtask" })
    FakeObserver.last?.deliver(Array.from({ length: 30 }, (_, i) => 60 + i * 10)) // 60 … 350
    frames([0, 16, 16, 16])
    scene?.stop()
    const tasks = named("ui.long_task_ms")
    expect(tasks.map((m) => [m.attrs.stat, m.value])).toEqual([
      ["p95", 340],
      ["max", 350],
    ])
    expect(tasks.every((m) => m.type === "distribution" && m.unit === "millisecond" && m.attrs.scene === "game.confirm")).toBe(true)
    expect(named("ui.long_tasks")).toMatchObject([{ type: "count", value: 30, attrs: { scene: "game.confirm" } }])
    expect(FakeObserver.last?.disconnected).toBe(true)
  })

  it("the max counts a task past the buffer's capacity", () => {
    const scene = startScene("chest")
    FakeObserver.last?.deliver([...Array<number>(300).fill(60), 900])
    frames([0, 16, 16, 16])
    scene?.stop()
    expect(named("ui.long_task_ms").find((m) => m.attrs.stat === "max")?.value).toBe(900)
    expect(named("ui.long_tasks")[0].value).toBe(301)
  })

  it("skips silently where the observer or the longtask type is missing", () => {
    vi.stubGlobal("PerformanceObserver", undefined)
    const scene = startScene("chest")
    frames([0, 16, 16, 16])
    scene?.stop()
    expect(named("ui.long_tasks")).toEqual([])
    expect(named("ui.slow_frame_pct")).toHaveLength(1)
    class Throwing extends FakeObserver {
      observe() {
        throw new TypeError("unsupported entry type")
      }
    }
    vi.stubGlobal("PerformanceObserver", Throwing)
    expect(() => startScene("chest")?.stop()).not.toThrow()
  })
})

describe("the long-task snapshot", () => {
  it("keeps the stalls of a second or more, from the same entries as ui.long_task_ms, with when they ended and in which scene", () => {
    vi.stubGlobal("performance", { timeOrigin: 1_000_000, now: () => now })
    const scene = startScene("game.round")
    FakeObserver.last?.deliverEntries([{ duration: 60, startTime: 10 }, { duration: 15_700, startTime: 2000 }, { duration: 999, startTime: 30_000 }])
    frames([0, 16, 16, 16])
    scene?.stop()
    expect(longTaskSnapshot()).toEqual([{ ms: 15_700, endedAt: 1_000_000 + 2000 + 15_700, scene: "game.round" }])
    expect(named("ui.long_task_ms").find((m) => m.attrs.stat === "max")?.value).toBe(15_700)
  })

  it("falls back to the wall clock for an entry with no start time, keeps the last 16, and hands out a copy", () => {
    vi.stubGlobal("performance", {})
    vi.spyOn(Date, "now").mockReturnValue(42)
    const scene = startScene("waiting")
    FakeObserver.last?.deliverEntries(Array.from({ length: 20 }, (_, i) => ({ duration: 1000 + i })))
    const snap = longTaskSnapshot()
    expect(snap).toHaveLength(16)
    expect(snap[0]).toEqual({ ms: 1004, endedAt: 42, scene: "waiting" })
    snap.pop()
    expect(longTaskSnapshot()).toHaveLength(16)
    scene?.stop()
    vi.restoreAllMocks()
  })

  it("is empty when nothing stalled", () => expect(longTaskSnapshot()).toEqual([]))
})

describe("moments of the round", () => {
  const moments = () => named("ui.moment_frame_ms").map((m) => [m.attrs.moment, m.attrs.stat, m.value])

  it("splits a game.round window by moment", () => {
    const scene = startScene("game.round")
    frames([0])
    setMoment("intro")
    frames([16, 16, 16])
    setMoment("turned")
    frames([20, 20, 50])
    scene?.stop()
    expect(moments()).toEqual([
      ["intro", "avg", 16],
      ["intro", "max", 16],
      ["turned", "avg", 30],
      ["turned", "max", 50],
    ])
    const points = named("ui.moment_frame_ms")
    expect(points.every((m) => m.type === "distribution" && m.unit === "millisecond" && !("scene" in m.attrs))).toBe(true)
    expect(named("ui.frame_ms").map((m) => [m.attrs.stat, m.value])).toEqual([
      ["p50", 16],
      ["p95", 50],
    ])
    expect(named("ui.slow_frame_pct")).toMatchObject([{ value: 0, attrs: { scene: "game.round" } }])
  })

  it("sends no moment points without a moment, for a short moment, or in another scene", () => {
    setMoment("play")
    const round = startScene("game.round")
    frames([0, 16, 16])
    setMoment(null)
    frames([16, 16, 16])
    round?.stop()
    expect(named("ui.slow_frame_pct")).toHaveLength(1)
    expect(moments()).toEqual([])
    setMoment("play")
    const collectables = startScene("chest")
    frames([0, 16, 16, 16])
    collectables?.stop()
    expect(named("ui.slow_frame_pct")).toHaveLength(2)
    expect(moments()).toEqual([])
  })

  it("each 30 s window starts the moments from zero", () => {
    setMoment("play")
    const scene = startScene("game.round")
    frames([0, ...Array<number>(1875).fill(16)]) // exactly 30 s: the cut runs on the last frame
    setMoment("gap")
    frames([16, 16, 16])
    scene?.stop()
    expect(moments()).toEqual([
      ["play", "avg", 16],
      ["play", "max", 16],
      ["gap", "avg", 16],
      ["gap", "max", 16],
    ])
  })
})

describe("one foreground scene", () => {
  it("entering a scene stops the previous one, which emits", () => {
    enterScene("game.round")
    frames([0, 16, 16, 16])
    enterScene("game.confirm")
    expect(named("ui.slow_frame_pct").map((m) => m.attrs.scene)).toEqual(["game.round"])
    enterScene("game.confirm") // idempotent
    expect(callbacks.size).toBe(1)
    leaveScene("game.round") // not the active one: nothing happens
    expect(named("ui.slow_frame_pct")).toHaveLength(1)
    frames([16, 16, 16, 16])
    leaveScene("game.confirm")
    expect(named("ui.slow_frame_pct").map((m) => m.attrs.scene)).toEqual(["game.round", "game.confirm"])
  })

  it("a scene the page hid resumes when it is shown again, under the same name", () => {
    enterScene("chest")
    frames([0, 16, 16, 16])
    setVisibility("hidden")
    expect(named("ui.slow_frame_pct")).toHaveLength(1)
    expect(callbacks.size).toBe(0)
    setVisibility("visible")
    expect(callbacks.size).toBe(1)
    frames([0, 16, 16, 16])
    leaveScene("chest")
    expect(named("ui.slow_frame_pct").map((m) => m.attrs.scene)).toEqual(["chest", "chest"])
  })

  it("entering the same scene again after its sampler stopped restarts it", () => {
    enterScene("waiting")
    setVisibility("hidden")
    doc.visibilityState = "visible" // no event: only the re-entry can restart it
    enterScene("waiting")
    expect(callbacks.size).toBe(1)
  })

  it("a scene entered while hidden starts once the page is visible", () => {
    doc.visibilityState = "hidden"
    enterScene("waiting")
    expect(callbacks.size).toBe(0)
    setVisibility("visible")
    expect(callbacks.size).toBe(1)
  })

  it("a left scene does not come back on visible", () => {
    enterScene("waiting")
    leaveScene("waiting")
    setVisibility("hidden")
    setVisibility("visible")
    expect(callbacks.size).toBe(0)
    expect(doc.listeners.size + win.listeners.size).toBe(0)
  })
})

describe("recordHeap", () => {
  it("records the used JS heap in MB where the browser reports it", () => {
    vi.stubGlobal("performance", { memory: { usedJSHeapSize: 52_428_800 } })
    recordHeap()
    expect(named("ui.js_heap_mb")).toMatchObject([{ type: "gauge", unit: "none", value: 50 }])
  })

  it("is silent where there is no performance.memory, and never flushes", () => {
    vi.stubGlobal("performance", {})
    recordHeap()
    expect(named("ui.js_heap_mb")).toEqual([])
    vi.stubGlobal("performance", { memory: { usedJSHeapSize: 1e6 } })
    recordHeap()
    expect(recorded.metricFlushes).toBe(0)
  })
})
