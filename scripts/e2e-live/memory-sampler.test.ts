// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import vm from "node:vm"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  BotMemorySampler,
  RESOURCE_COUNTERS_INIT_SCRIPT,
  RESOURCE_COUNTERS_READ_SCRIPT,
  formatMemorySummary,
  memoryScreenIdentity,
  parseSmapsRollupPss,
  parseStatusRssBytes,
  readProcessMemory,
  sumProcessMemory,
  summarizeMemorySamples,
  type MemorySample,
} from "./memory-sampler"

class FakeWeakRef<T extends object> {
  static refs: FakeWeakRef<object>[] = []
  value: T | undefined

  constructor(value: T) {
    this.value = value
    FakeWeakRef.refs.push(this as FakeWeakRef<object>)
  }

  deref(): T | undefined {
    return this.value
  }

  static dropAll(): void {
    for (const ref of FakeWeakRef.refs) ref.value = undefined
  }
}

function counterContext() {
  class PeerConnection {
    connectionState = "new"
    signalingState = "stable"
    close() {
      this.connectionState = "closed"
      this.signalingState = "closed"
    }
  }
  class Canvas {
    context = { lost: false, isContextLost() { return this.lost } }
    getContext() {
      return this.context
    }
  }
  const videos = [{ srcObject: {} }, { srcObject: null }]
  const context = vm.createContext({
    WeakRef: FakeWeakRef,
    WeakSet,
    RTCPeerConnection: PeerConnection,
    HTMLCanvasElement: Canvas,
    document: {
      querySelectorAll(selector: string) {
        if (selector === "video") return videos
        if (selector === "canvas") return [new Canvas()]
        return []
      },
    },
  })
  vm.runInContext("globalThis.window = globalThis", context)
  return { context, Canvas }
}

describe("browser resource counters", () => {
  it("counts live resources without becoming their owner", () => {
    FakeWeakRef.refs = []
    const { context, Canvas } = counterContext()
    vm.runInContext(RESOURCE_COUNTERS_INIT_SCRIPT, context)
    vm.runInContext("globalThis.pc = new RTCPeerConnection(); globalThis.canvas = new HTMLCanvasElement(); globalThis.gl = canvas.getContext('webgl')", context)

    expect(vm.runInContext(RESOURCE_COUNTERS_READ_SCRIPT, context)).toMatchObject({
      installed: true,
      peerConnections: 1,
      glContexts: 1,
      glLive: 1,
      glLost: 0,
      videos: 2,
      videosWithStream: 1,
    })

    vm.runInContext("pc.close(); gl.lost = true", context)
    expect(vm.runInContext(RESOURCE_COUNTERS_READ_SCRIPT, context)).toMatchObject({ peerConnections: 0, glLive: 0, glLost: 1 })

    FakeWeakRef.dropAll()
    expect(vm.runInContext(RESOURCE_COUNTERS_READ_SCRIPT, context)).toMatchObject({ peerConnections: 0, glContexts: 0 })
    expect(new Canvas().getContext()).toBeDefined()
  })
})

const sample = (overrides: Partial<MemorySample>): MemorySample => ({
  bot: 1,
  persona: "baseline",
  at: "2026-10-23T00:00:00.000Z",
  elapsedMs: 0,
  reason: "interval",
  route: "/game",
  screen: "game|play|1",
  stage: "play",
  round: null,
  turn: 1,
  heapBytes: 100,
  nodes: 10,
  listeners: 2,
  documents: 1,
  countersInstalled: true,
  peerConnections: 1,
  glContexts: 1,
  glLive: 1,
  glLost: 0,
  videos: 1,
  videosWithStream: 1,
  canvases: 1,
  procRendererBytes: null, procGpuBytes: null, procUtilityBytes: null, procBrowserBytes: null, procOtherBytes: null, procTotalBytes: null,
  procBrowserId: null, procScope: "browser-wide", procSkipped: null, procRssFallback: null,
  ...overrides,
})

describe("memory summaries", () => {
  it("reports screen peaks and first-turn to last-turn growth", () => {
    const summary = summarizeMemorySamples([
      sample({ elapsedMs: 1, heapBytes: 100, nodes: 10, listeners: 2, turn: 1 }),
      sample({ elapsedMs: 2, heapBytes: 180, nodes: 14, listeners: 3, turn: 2 }),
      sample({ elapsedMs: 3, route: "/results", screen: "results", stage: null, turn: null, heapBytes: 150, nodes: 12 }),
    ])

    expect(summary.peaks.game).toMatchObject({ heapBytes: 180, nodes: 14, listeners: 3 })
    expect(summary.peaks.results).toMatchObject({ heapBytes: 150, nodes: 12 })
    expect(summary.turnGrowth).toMatchObject({ heapBytes: 80, nodes: 4, listeners: 1, firstTurn: 1, lastTurn: 2 })
    expect(formatMemorySummary(1, "baseline", summary)).toContain("game [heap 180, nodes 14, listeners 3")
    expect(formatMemorySummary(1, "baseline", summary)).toContain("turn 1→2 growth [heap 80, nodes +4")
  })

  it("normalizes route and game stage into a stable screen identity", () => {
    expect(memoryScreenIdentity({ route: "/game?x=1", testId: null, stage: "play", turn: 4, heading: "Copy the gesture" })).toBe("game|play|4")
    expect(memoryScreenIdentity({ route: "/", testId: "home", stage: null, turn: null, heading: "Jollity" })).toBe("home")
  })

  it("bounds a frozen page capture and preserves earlier evidence", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "jollity-memory-sampler-"))
    const session = {
      send: async (method: string) => method === "Performance.enable" ? {} : { metrics: [] },
      detach: async () => {},
    }
    const page = {
      addInitScript: async () => {},
      context: () => ({ newCDPSession: async () => session }),
      isClosed: () => false,
      evaluate: async () => new Promise<never>(() => {}),
    }
    const sampler = new BotMemorySampler({ enabled: true, bot: 1, persona: "baseline", outDir, captureTimeoutMs: 10, intervalMs: 60_000, screenPollMs: 60_000 })
    sampler.samples.push(sample({ elapsedMs: 1 }))
    await sampler.attach(page as never)

    const started = Date.now()
    await expect(sampler.finish()).resolves.toMatchObject({ samples: 1 })
    expect(Date.now() - started).toBeLessThan(500)
    expect(sampler.errors).toContain("Error: final capture timed out after 10ms")
    expect(JSON.parse(readFileSync(join(outDir, "memory-1.json"), "utf8")).samples).toHaveLength(1)
    rmSync(outDir, { recursive: true, force: true })
  })
})

const MiB = 1_048_576

describe("whole-process memory", () => {
  it("parses Pss from smaps_rollup and VmRSS from status, in bytes", () => {
    expect(parseSmapsRollupPss("00400000-ffff r-xp\nRss:  5000 kB\nPss:                1234 kB\nPss_Anon: 9 kB\n")).toBe(1234 * 1024)
    expect(parseSmapsRollupPss("Rss: 5 kB\n")).toBeNull()
    expect(parseStatusRssBytes("Name:\tchrome\nVmRSS:\t   2048 kB\nThreads:\t4\n")).toBe(2048 * 1024)
    expect(parseStatusRssBytes("")).toBeNull()
  })

  it("sums by process type and skips unreadable processes", () => {
    const bytes: Record<number, number | null> = { 1: 100, 2: 200, 3: 50, 4: 30, 5: 7, 6: null, 7: 11 }
    const sum = sumProcessMemory(
      [{ type: "browser", id: 1 }, { type: "renderer", id: 2 }, { type: "renderer", id: 7 }, { type: "GPU", id: 3 }, { type: "network.mojom.NetworkService", id: 4 }, { type: "zygote", id: 5 }, { type: "renderer", id: 6 }],
      (pid) => bytes[pid],
    )
    expect(sum).toEqual({ procRendererBytes: 211, procGpuBytes: 50, procUtilityBytes: 30, procBrowserBytes: 100, procOtherBytes: 7, procTotalBytes: 398 })
    expect(sumProcessMemory([{ type: "gpu", id: 6 }], () => null).procTotalBytes).toBeNull()
  })

  it("reads /proc through the injected reader, falling back to status", async () => {
    const files: Record<string, string> = {
      "/proc/10/smaps_rollup": "Pss: 4 kB\n",
      "/proc/11/status": "VmRSS: 8 kB\n",
    }
    const read = async (path: string) => { if (path in files) return files[path]; throw new Error("ENOENT") }
    const sum = await readProcessMemory([{ type: "renderer", id: 10 }, { type: "gpu", id: 11 }, { type: "utility", id: 12 }], read)
    expect(sum).toMatchObject({ procRendererBytes: 4096, procGpuBytes: 8192, procUtilityBytes: 0, procTotalBytes: 12288, procBrowserId: null, procSkipped: 1, procRssFallback: 1 })
  })

  it("reports skipped and fallback counts, and nulls process growth across a browser relaunch", () => {
    const MiBs = 1_048_576
    const a = sample({ elapsedMs: 1, turn: 1, procBrowserId: 10, procTotalBytes: 100 * MiBs, procRendererBytes: 1 })
    const same = summarizeMemorySamples([a, sample({ elapsedMs: 2, turn: 2, procBrowserId: 10, procTotalBytes: 150 * MiBs, procRendererBytes: 2 })])
    expect(same.turnGrowth?.procTotalBytes).toBe(50 * MiBs)
    const relaunched = summarizeMemorySamples([a, sample({ elapsedMs: 2, turn: 2, procBrowserId: 99, procTotalBytes: 150 * MiBs, procRendererBytes: 2 })])
    expect(relaunched.turnGrowth).toMatchObject({ procTotalBytes: null, procRendererBytes: null, heapBytes: 0 })
    expect(formatMemorySummary(1, "baseline", relaunched)).toContain("browser-wide proc total n/a")
  })

  it("puts peaks, growth and null-safe formatting in the summary", () => {
    const summary = summarizeMemorySamples([
      sample({ elapsedMs: 1, turn: 1, procBrowserId: 5, procRendererBytes: 100 * MiB, procGpuBytes: 50 * MiB, procTotalBytes: 400 * MiB }),
      sample({ elapsedMs: 2, turn: 2, procBrowserId: 5, procRendererBytes: 150 * MiB, procGpuBytes: 40 * MiB, procTotalBytes: 500 * MiB }),
      sample({ elapsedMs: 3, route: "/", screen: "home", stage: null, turn: null }),
    ])
    expect(summary.peaks.game).toMatchObject({ procRendererBytes: 150 * MiB, procGpuBytes: 50 * MiB, procTotalBytes: 500 * MiB })
    expect(summary.peaks.home.procTotalBytes).toBeNull()
    expect(summary.turnGrowth).toMatchObject({ procTotalBytes: 100 * MiB, procGpuBytes: -10 * MiB })
    const line = formatMemorySummary(1, "baseline", summary)
    expect(line).toContain("browser-wide proc renderer 150 MiB, gpu 50 MiB, total 500 MiB")
    expect(line).toContain("home [")
    expect(line).toContain("browser-wide proc renderer n/a, gpu n/a, total n/a")
    expect(line).toContain("browser-wide proc total +100 MiB")
    expect(formatMemorySummary(1, "baseline", summarizeMemorySamples([sample({ turn: 1 }), sample({ turn: 2, elapsedMs: 1 })]))).toContain("proc total n/a]")
  })

  it("records process figures per sample, and null plus one note off Linux", async () => {
    const mk = (platform: string, processInfo: { type: string; id: number }[]) => {
      const outDir = mkdtempSync(join(tmpdir(), "jollity-memory-sampler-"))
      const session = { send: async (m: string) => m === "Performance.getMetrics" ? { metrics: [] } : m === "SystemInfo.getProcessInfo" ? { processInfo } : {}, detach: async () => {} }
      const page = {
        addInitScript: async () => {},
        context: () => ({ newCDPSession: async () => session, browser: () => ({ newBrowserCDPSession: async () => session }) }),
        isClosed: () => false,
        evaluate: async (script: string) => script.includes("__jollityResourceCounters") ? { installed: true, peerConnections: 0, glContexts: 0, glLive: 0, glLost: 0, videos: 0, videosWithStream: 0, canvases: 0 } : { route: "/", testId: "home", stage: null, round: null, turn: null, heading: null },
      }
      const sampler = new BotMemorySampler({ enabled: true, bot: 1, persona: "baseline", outDir, platform, intervalMs: 60_000, screenPollMs: 60_000, readProcFile: async (path) => `Pss: ${path.includes("/7/") ? 2 : 1} kB\n` })
      return { sampler, page, outDir }
    }
    const linux = mk("linux", [{ type: "renderer", id: 7 }, { type: "gpu", id: 8 }])
    await linux.sampler.attach(linux.page as never)
    await linux.sampler.finish()
    expect(linux.sampler.samples[0]).toMatchObject({ procRendererBytes: 2048, procGpuBytes: 1024, procTotalBytes: 3072 })
    expect(linux.sampler.errors).toEqual([])

    const mac = mk("darwin", [])
    await mac.sampler.attach(mac.page as never)
    await mac.sampler.finish()
    expect(mac.sampler.samples[0]).toMatchObject({ procTotalBytes: null, procRendererBytes: null })
    expect(mac.sampler.errors.filter((e) => e.startsWith("process memory unavailable"))).toHaveLength(1)
    rmSync(linux.outDir, { recursive: true, force: true })
    rmSync(mac.outDir, { recursive: true, force: true })
  })

  it("does not stall attach on a hung browser session", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "jollity-memory-sampler-"))
    const session = { send: async (m: string) => m === "SystemInfo.getProcessInfo" ? { processInfo: [] } : { metrics: [] }, detach: async () => {} }
    const page = {
      addInitScript: async () => {},
      context: () => ({ newCDPSession: async () => session, browser: () => ({ newBrowserCDPSession: () => new Promise<never>(() => {}) }) }),
      isClosed: () => false,
      evaluate: async (script: string) => script.includes("__jollityResourceCounters") ? { installed: true, peerConnections: 0, glContexts: 0, glLive: 0, glLost: 0, videos: 0, videosWithStream: 0, canvases: 0 } : { route: "/", testId: "home", stage: null, round: null, turn: null, heading: null },
    }
    const sampler = new BotMemorySampler({ enabled: true, bot: 1, persona: "baseline", outDir, platform: "linux", sessionTimeoutMs: 20, intervalMs: 60_000, screenPollMs: 60_000 })
    const started = Date.now()
    await sampler.attach(page as never)
    expect(Date.now() - started).toBeLessThan(1000)
    expect(sampler.errors).toEqual(["process memory unavailable: Error: browser CDP session timed out after 20ms"])
    await sampler.finish()
    expect(sampler.samples[0]).toMatchObject({ procTotalBytes: null, procBrowserId: null })
    rmSync(outDir, { recursive: true, force: true })
  })
})
