// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import type { CDPSession, Page } from "@playwright/test"
import { RESOURCE_COUNTERS_INIT_SCRIPT } from "../../apps/jollity-app/lib/telemetry/resource-counters"
export { RESOURCE_COUNTERS_INIT_SCRIPT } from "../../apps/jollity-app/lib/telemetry/resource-counters"

/** The page-side read of the counters RESOURCE_COUNTERS_INIT_SCRIPT installs, as one self-contained expression for page.evaluate.
 *  apps/jollity-app/lib/telemetry/resource-counters.ts keeps its collector private (collectPageResourceCounters), so the bot mirrors it
 *  here; it reads the same `__jollityResourceCounters` registry and returns the same fields, with the DOM node count included. */
export const RESOURCE_COUNTERS_READ_SCRIPT = String.raw`(() => {
  try {
    const state = globalThis.__jollityResourceCounters
    if (!state) return null
    const alive = (refs) => {
      const values = []
      const retained = []
      for (const ref of refs) {
        try {
          const value = ref.deref()
          if (value) { values.push(value); retained.push(ref) }
        } catch {}
      }
      try { refs.splice(0, refs.length, ...retained) } catch {}
      return values
    }
    const peerConnections = alive(state.peerConnections)
    const glContexts = alive(state.glContexts)
    const videos = [...document.querySelectorAll("video")]
    const liveVideos = videos.filter((video) => video.srcObject != null)
    const resolutions = liveVideos.map((video) => [Number(video.videoWidth) || 0, Number(video.videoHeight) || 0])
    let domNodes
    try { domNodes = document.getElementsByTagName("*").length } catch {}
    return {
      installed: true,
      peerConnections: peerConnections.filter((pc) => pc.connectionState !== "closed" && pc.signalingState !== "closed").length,
      glContexts: glContexts.length,
      glLive: glContexts.filter((gl) => typeof gl.isContextLost !== "function" || !gl.isContextLost()).length,
      glLost: glContexts.filter((gl) => typeof gl.isContextLost === "function" && gl.isContextLost()).length,
      videos: videos.length,
      videosWithStream: liveVideos.length,
      videoMaxWidth: Math.max(0, ...resolutions.map(([width]) => width)),
      videoMaxHeight: Math.max(0, ...resolutions.map(([, height]) => height)),
      videoPixels: resolutions.reduce((total, [width, height]) => total + width * height, 0),
      videoResolutions: [...new Set(resolutions.map(([width, height]) => width + "x" + height))].slice(0, 8).join(",") || "none",
      canvases: document.querySelectorAll("canvas").length,
      ...(domNodes === undefined ? {} : { domNodes }),
    }
  } catch { return null }
})()`

/**
 * Whole-process memory. The JS heap cannot see video decode, the camera, WebRTC buffers or GPU memory, which is what
 * kills a phone WebView, so each sample also sums the Chromium processes by type (bytes, raw numbers). The list comes
 * from the BROWSER-level CDP session (SystemInfo.getProcessInfo: type + pid) and the figures from /proc on Linux
 * (Pss from smaps_rollup, else VmRSS). Everything here is null off Linux or on any failure; it never throws into a bot.
 *
 * Scope: getProcessInfo is per browser, not per page. The live E2E runs every bot as a context of ONE browser, so the
 * gpu, utility and browser figures (and the renderer sum) are the whole browser's, the same for every bot at one
 * moment. Per-bot attribution needs one browser per bot.
 */
export interface ProcessMemory {
  procRendererBytes: number | null
  procGpuBytes: number | null
  procUtilityBytes: number | null
  procBrowserBytes: number | null
  procOtherBytes: number | null
  procTotalBytes: number | null
}

export const NO_PROCESS_MEMORY: ProcessMemory = {
  procRendererBytes: null, procGpuBytes: null, procUtilityBytes: null, procBrowserBytes: null, procOtherBytes: null, procTotalBytes: null,
}

export interface ChromiumProcess { type: string; id: number }

/** Pss of a /proc/<pid>/smaps_rollup text, in bytes (the file reports kB). */
export function parseSmapsRollupPss(text: string): number | null {
  const match = /^Pss:\s+(\d+)\s+kB/m.exec(text)
  return match ? Number(match[1]) * 1024 : null
}

/** VmRSS of a /proc/<pid>/status text, in bytes. */
export function parseStatusRssBytes(text: string): number | null {
  const match = /^VmRSS:\s+(\d+)\s+kB/m.exec(text)
  return match ? Number(match[1]) * 1024 : null
}

type ProcessBucket = "procRendererBytes" | "procGpuBytes" | "procUtilityBytes" | "procBrowserBytes" | "procOtherBytes"

/** Chromium reports "browser", "renderer", "GPU", "utility" and mojo service names ("network.mojom.NetworkService", audio, video capture) as the type. */
const bucketOf = (rawType: string): ProcessBucket => {
  const type = rawType.toLowerCase()
  if (type === "renderer") return "procRendererBytes"
  if (type === "gpu") return "procGpuBytes"
  if (type === "browser") return "procBrowserBytes"
  if (type === "utility" || type.includes(".mojom.") || type.includes("service")) return "procUtilityBytes"
  return "procOtherBytes"
}

/** Sum per-process bytes by Chromium process type. A process that could not be read is skipped; none read = all null. */
export function sumProcessMemory(processes: ChromiumProcess[], bytesOf: (pid: number) => number | null): ProcessMemory {
  const sums: Record<ProcessBucket, number> = { procRendererBytes: 0, procGpuBytes: 0, procUtilityBytes: 0, procBrowserBytes: 0, procOtherBytes: 0 }
  let read = 0
  for (const { type, id } of processes) {
    const bytes = bytesOf(id)
    if (bytes === null) continue
    sums[bucketOf(type)] += bytes
    read += 1
  }
  if (read === 0) return { ...NO_PROCESS_MEMORY }
  return { ...sums, procTotalBytes: Object.values(sums).reduce((total, value) => total + value, 0) }
}

type ReadProcFile = (path: string) => Promise<string>

/** Per-sample bookkeeping: which browser the figures came from, and how trustworthy they are. */
export interface ProcessMeta {
  /** The browser process pid (a relaunched browser has a new one); null when unknown. */
  procBrowserId: number | null
  /** Always "browser-wide": the figures cover every context of the sampled browser, not just this bot. */
  procScope: "browser-wide"
  /** Processes listed but unreadable, so missing from the sums; null when nothing was attempted. */
  procSkipped: number | null
  /** Processes read from VmRSS because smaps_rollup failed (RSS double-counts shared pages). */
  procRssFallback: number | null
}

export const NO_PROCESS_META: ProcessMeta = { procBrowserId: null, procScope: "browser-wide", procSkipped: null, procRssFallback: null }

async function readPidBytes(pid: number, read: ReadProcFile): Promise<{ bytes: number; fallback: boolean } | null> {
  try {
    const pss = parseSmapsRollupPss(await read(`/proc/${pid}/smaps_rollup`))
    if (pss !== null) return { bytes: pss, fallback: false }
  } catch { /* smaps_rollup is root-or-owner only and absent on old kernels: fall back to status */ }
  try {
    const rss = parseStatusRssBytes(await read(`/proc/${pid}/status`))
    return rss === null ? null : { bytes: rss, fallback: true }
  } catch {
    return null
  }
}

export async function readProcessMemory(processes: ChromiumProcess[], read: ReadProcFile): Promise<ProcessMemory & ProcessMeta> {
  const results = await Promise.all(processes.map(({ id }) => readPidBytes(id, read)))
  const byPid = new Map(processes.map(({ id }, index) => [id, results[index]]))
  const memory = sumProcessMemory(processes, (pid) => byPid.get(pid)?.bytes ?? null)
  return {
    ...memory, ...NO_PROCESS_META,
    procBrowserId: processes.find(({ type }) => type === "browser")?.id ?? null,
    procSkipped: results.filter((result) => result === null).length,
    procRssFallback: results.filter((result) => result?.fallback).length,
  }
}

export interface MemorySample extends ProcessMemory, ProcessMeta {
  bot: number
  persona: string
  at: string
  elapsedMs: number
  reason: "interval" | "screen-change" | "final"
  route: string
  screen: string
  stage: string | null
  round: number | null
  turn: number | null
  heapBytes: number
  nodes: number
  listeners: number
  documents: number
  countersInstalled: boolean
  peerConnections: number
  glContexts: number
  glLive: number
  glLost: number
  videos: number
  videosWithStream: number
  canvases: number
}

interface ScreenFacts {
  route: string
  testId: string | null
  stage: string | null
  turn: number | null
  heading: string | null
}

type Peak = Pick<MemorySample, "heapBytes" | "nodes" | "listeners" | "documents" | "peerConnections" | "glContexts" | "glLive" | "glLost" | "videos" | "videosWithStream" | "canvases" | keyof ProcessMemory>

export interface MemorySummary {
  samples: number
  missingCounterSamples: number
  peaks: Record<string, Peak>
  turnGrowth: (Peak & { firstTurn: number; lastTurn: number }) | null
}

const peakKeys: (keyof Peak)[] = ["heapBytes", "nodes", "listeners", "documents", "peerConnections", "glContexts", "glLive", "glLost", "videos", "videosWithStream", "canvases", ...(Object.keys(NO_PROCESS_MEMORY) as (keyof ProcessMemory)[])]

const maxOrNull = (one: number | null, two: number | null): number | null => one === null ? two : two === null ? one : Math.max(one, two)

export function memoryScreenIdentity(facts: ScreenFacts): string {
  const route = facts.route.split("?")[0].replace(/^\/+|\/+$/g, "") || "home"
  if (route === "game") return `game|${facts.stage ?? "unknown"}|${facts.turn ?? "?"}`
  if (facts.testId === "home" || route === "home") return "home"
  return facts.testId || route || facts.heading || "unknown"
}

const metricValues = (sample: MemorySample): Peak => Object.fromEntries(peakKeys.map((key) => [key, sample[key]])) as Peak

export function summarizeMemorySamples(samples: MemorySample[]): MemorySummary {
  const peaks: Record<string, Peak> = {}
  for (const sample of samples) {
    const screen = sample.screen.split("|")[0]
    const peak = (peaks[screen] ??= metricValues(sample))
    for (const key of peakKeys) (peak as Record<string, number | null>)[key] = maxOrNull(peak[key], sample[key])
  }
  const turns = samples.filter((sample) => sample.turn !== null).sort((one, two) => one.elapsedMs - two.elapsedMs)
  const first = turns[0]
  const last = turns.at(-1)
  // process figures from two different browsers (a relaunch) are not comparable: growth is null then
  const sameBrowser = first && last && first.procBrowserId !== null && first.procBrowserId === last.procBrowserId
  const procKeys = Object.keys(NO_PROCESS_MEMORY)
  const turnGrowth = first && last
    ? Object.assign(Object.fromEntries(peakKeys.map((key) => [key, last[key] === null || first[key] === null || (procKeys.includes(key) && !sameBrowser) ? null : last[key]! - first[key]!])) as Peak, { firstTurn: first.turn!, lastTurn: last.turn! })
    : null
  return { samples: samples.length, missingCounterSamples: samples.filter((sample) => !sample.countersInstalled).length, peaks, turnGrowth }
}

interface ResourceCounters {
  installed: boolean
  peerConnections: number
  glContexts: number
  glLive: number
  glLost: number
  videos: number
  videosWithStream: number
  canvases: number
}

const screenScript = `(() => {
  const game = document.querySelector("[data-stage]")
  const test = document.querySelector("[data-testid=home], main[data-testid], [data-testid$=-screen]")
  const heading = document.querySelector("h1, h2")
  const number = (value) => value == null || value === "" || !Number.isFinite(Number(value)) ? null : Number(value)
  return {
    route: location.pathname + location.search,
    testId: test?.getAttribute("data-testid") ?? null,
    stage: game?.getAttribute("data-stage") ?? null,
    round: number(game?.getAttribute("data-round")),
    turn: number(game?.getAttribute("data-turn")),
    heading: heading?.textContent?.trim() ?? null,
  }
})()`

const mib = (value: number | null): string => value === null ? "n/a" : `${(value / 1_048_576).toFixed(0)} MiB`

const compact = (value: number): string => value >= 1_048_576 ? `${(value / 1_048_576).toFixed(1)} MiB` : String(value)

export function formatMemorySummary(bot: number, persona: string, summary: MemorySummary): string {
  const peaks = Object.entries(summary.peaks).map(([screen, peak]) =>
    `${screen} [heap ${compact(peak.heapBytes)}, nodes ${peak.nodes}, listeners ${peak.listeners}, docs ${peak.documents}, pc ${peak.peerConnections}, gl ${peak.glLive}/${peak.glContexts} live, lost ${peak.glLost}, video ${peak.videosWithStream}/${peak.videos}, canvas ${peak.canvases}; browser-wide proc renderer ${mib(peak.procRendererBytes)}, gpu ${mib(peak.procGpuBytes)}, total ${mib(peak.procTotalBytes)}]`,
  ).join("; ")
  const growth = summary.turnGrowth
    ? `; turn ${summary.turnGrowth.firstTurn}→${summary.turnGrowth.lastTurn} growth [heap ${compact(summary.turnGrowth.heapBytes)}, nodes ${summary.turnGrowth.nodes >= 0 ? "+" : ""}${summary.turnGrowth.nodes}, listeners ${summary.turnGrowth.listeners >= 0 ? "+" : ""}${summary.turnGrowth.listeners}, browser-wide proc total ${summary.turnGrowth.procTotalBytes === null ? "n/a" : `${summary.turnGrowth.procTotalBytes >= 0 ? "+" : ""}${mib(summary.turnGrowth.procTotalBytes)}`}]`
    : ""
  const counterHealth = summary.missingCounterSamples > 0 ? `; WARNING counters not installed on ${summary.missingCounterSamples}/${summary.samples} samples` : ""
  return `- player ${bot} memory (${persona}): ${summary.samples} samples; peaks ${peaks || "none"}${growth}${counterHealth}`
}

export class BotMemorySampler {
  readonly samples: MemorySample[] = []
  readonly errors: string[] = []
  private page: Page | null = null
  private cdp: CDPSession | null = null
  private browserCdp: CDPSession | null = null
  private readonly procFailures = new Map<string, number>()
  private interval: ReturnType<typeof setInterval> | null = null
  private screenPoll: ReturnType<typeof setInterval> | null = null
  private serial = Promise.resolve()
  private lastScreen: string | null = null
  private readonly startedAt = Date.now()

  constructor(private readonly options: { enabled: boolean; bot: number; persona: string; outDir: string; intervalMs?: number; screenPollMs?: number; captureTimeoutMs?: number; platform?: string; readProcFile?: ReadProcFile; sessionTimeoutMs?: number }) {}

  async attach(page: Page): Promise<void> {
    if (!this.options.enabled) return
    this.stopTimers()
    if (this.cdp) await this.cdp.detach().catch(() => {})
    if (this.browserCdp) await this.browserCdp.detach().catch(() => {})
    this.browserCdp = null
    await page.addInitScript(RESOURCE_COUNTERS_INIT_SCRIPT)
    this.page = page
    this.cdp = await page.context().newCDPSession(page)
    await this.cdp.send("Performance.enable")
    await this.attachBrowserSession(page)
    const enqueue = (reason: MemorySample["reason"]) => {
      this.serial = this.serial.then(() => this.captureWithin(reason)).catch((error: unknown) => {
        this.errors.push(String(error).split("\n")[0])
      })
    }
    this.interval = setInterval(() => enqueue("interval"), this.options.intervalMs ?? 15_000)
    this.screenPoll = setInterval(() => {
      this.serial = this.serial.then(() => this.withTimeout((async () => {
        const facts = await this.readScreen()
        const screen = memoryScreenIdentity(facts)
        if (this.lastScreen !== null && screen !== this.lastScreen) await this.captureWithin("screen-change", facts)
        this.lastScreen = screen
      })(), "screen poll")).catch((error: unknown) => {
        this.errors.push(String(error).split("\n")[0])
      })
    }, this.options.screenPollMs ?? 2_500)
  }

  async finish(): Promise<MemorySummary | null> {
    if (!this.options.enabled) return null
    this.stopTimers()
    this.serial = this.serial.then(() => this.captureWithin("final")).catch((error: unknown) => {
      this.errors.push(String(error).split("\n")[0])
    })
    await this.serial
    if (this.cdp) await this.cdp.detach().catch(() => {})
    if (this.browserCdp) await this.browserCdp.detach().catch(() => {})
    for (const [message, count] of this.procFailures) if (count > 1) this.errors.push(`process memory unavailable: ${message} (x${count})`)
    const summary = summarizeMemorySamples(this.samples)
    mkdirSync(this.options.outDir, { recursive: true })
    writeFileSync(join(this.options.outDir, `memory-${this.options.bot}.json`), JSON.stringify({ bot: this.options.bot, persona: this.options.persona, samples: this.samples, errors: this.errors, summary }, null, 2))
    appendFileSync(join(this.options.outDir, "summary.md"), `\n${formatMemorySummary(this.options.bot, this.options.persona, summary)}\n`)
    if (summary.samples === 0) throw new Error(`player ${this.options.bot}: memory sampling was enabled but produced no valid samples (${this.errors.join("; ") || "no capture attempted"})`)
    return summary
  }

  private noteProcessError(message: string): void {
    const seen = this.procFailures.get(message) ?? 0
    this.procFailures.set(message, seen + 1)
    if (seen === 0) this.errors.push(`process memory unavailable: ${message}`)
  }

  private async attachBrowserSession(page: Page): Promise<void> {
    const platform = this.options.platform ?? process.platform
    if (platform !== "linux") return this.noteProcessError(`needs Linux /proc (running on ${platform})`)
    try {
      const browser = page.context().browser?.()
      if (!browser) return this.noteProcessError("no browser handle (persistent context)")
      const pending = browser.newBrowserCDPSession()
      pending.catch(() => {})
      const limitMs = this.options.sessionTimeoutMs ?? 5_000
      let timer: ReturnType<typeof setTimeout> | undefined
      const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`browser CDP session timed out after ${limitMs}ms`)), limitMs) })
      try { this.browserCdp = await Promise.race([pending, timeout]) } finally { if (timer) clearTimeout(timer) }
    } catch (error) {
      this.noteProcessError(String(error).split("\n")[0])
    }
  }

  /** Never throws and never outlasts half the capture timeout: a failure is null figures plus one error note. */
  private async readProcessMemory(): Promise<ProcessMemory & ProcessMeta> {
    const session = this.browserCdp
    if (!session) return { ...NO_PROCESS_MEMORY, ...NO_PROCESS_META }
    const budgetMs = Math.max(1, Math.floor((this.options.captureTimeoutMs ?? 5_000) / 2))
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const work = (async () => {
        const info = await session.send("SystemInfo.getProcessInfo") as { processInfo: { type: string; id: number }[] }
        return readProcessMemory(info.processInfo.map(({ type, id }) => ({ type, id })), this.options.readProcFile ?? ((path) => readFile(path, "utf8")))
      })()
      work.catch(() => {})
      const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`process memory read timed out after ${budgetMs}ms`)), budgetMs) })
      return await Promise.race([work, timeout])
    } catch (error) {
      this.noteProcessError(String(error).split("\n")[0])
      return { ...NO_PROCESS_MEMORY, ...NO_PROCESS_META }
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  private stopTimers(): void {
    if (this.interval) clearInterval(this.interval)
    if (this.screenPoll) clearInterval(this.screenPoll)
    this.interval = null
    this.screenPoll = null
  }

  private async readScreen(): Promise<ScreenFacts & { round: number | null }> {
    if (!this.page || this.page.isClosed()) throw new Error("memory sampler page is closed")
    return this.page.evaluate(screenScript) as Promise<ScreenFacts & { round: number | null }>
  }

  private async withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
    const timeoutMs = this.options.captureTimeoutMs ?? 5_000
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs)
    })
    try {
      return await Promise.race([promise, timeout])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  private captureWithin(reason: MemorySample["reason"], knownFacts?: ScreenFacts & { round: number | null }): Promise<void> {
    return this.withTimeout(this.capture(reason, knownFacts), `${reason} capture`)
  }

  private async capture(reason: MemorySample["reason"], knownFacts?: ScreenFacts & { round: number | null }): Promise<void> {
    if (!this.page || this.page.isClosed() || !this.cdp) return
    const [facts, performance, counters, processMemory] = await Promise.all([
      knownFacts ?? this.readScreen(),
      this.cdp.send("Performance.getMetrics"),
      this.page.evaluate(RESOURCE_COUNTERS_READ_SCRIPT) as Promise<ResourceCounters | null>,
      this.readProcessMemory(),
    ])
    const metrics = new Map(performance.metrics.map(({ name, value }) => [name, value]))
    const screen = memoryScreenIdentity(facts)
    this.lastScreen = screen
    this.samples.push({
      bot: this.options.bot, persona: this.options.persona,
      at: new Date().toISOString(), elapsedMs: Date.now() - this.startedAt, reason,
      route: facts.route, screen, stage: facts.stage, round: facts.round, turn: facts.turn,
      heapBytes: metrics.get("JSHeapUsedSize") ?? 0, nodes: metrics.get("Nodes") ?? 0,
      listeners: metrics.get("JSEventListeners") ?? 0, documents: metrics.get("Documents") ?? 0,
      countersInstalled: counters?.installed ?? false,
      peerConnections: counters?.peerConnections ?? 0, glContexts: counters?.glContexts ?? 0, glLive: counters?.glLive ?? 0,
      glLost: counters?.glLost ?? 0, videos: counters?.videos ?? 0, videosWithStream: counters?.videosWithStream ?? 0, canvases: counters?.canvases ?? 0,
      ...processMemory,
    })
  }
}
