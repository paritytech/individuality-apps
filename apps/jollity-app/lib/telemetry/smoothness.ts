// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * APP SMOOTHNESS: how the screen the player is looking at actually ran.
 * Framework-free (AGENTS.md architecture rule 6): the screens never measure, they only
 * say which scene is on screen — the payoff screens and the waiting room
 * through `useScene` (use-scene.ts), the game's round and confirm stages
 * from the session (lib/journeys/game-trace.ts).
 *
 * A scene is sampled with requestAnimationFrame deltas into a fixed ring
 * buffer (nothing is allocated per frame), and a PerformanceObserver on
 * "longtask" (Chromium only) counts the main-thread stalls. A window ends on
 * stop or when the page turns hidden and emits through the metrics doorway
 * (one unit per name, see metrics.ts). Only the GAME's scenes also cut a
 * window every WINDOW_MS: a game is ~2.5 min of the heaviest frames (the
 * FLIP, the stagger, decode ramping up as peers join), which would overrun
 * the ring and lose its first rounds. Every other scene — the waiting room
 * above all, open for minutes on a static screen — emits ONCE: its ring
 * wraps (the percentiles read its last FRAME_CAP frames, the slow share
 * counts all of them), so it adds one metric envelope, not one per 30 s:
 *
 *   ui.frame_ms         distribution, millisecond   attrs scene, stat=p50|p95
 *   ui.slow_frame_pct   gauge, percent              frames slower than SLOW_FRAME_MS
 *   ui.long_task_ms     distribution, millisecond   stat=p95|max over the window's tasks
 *   ui.long_tasks       count                       long tasks in the window
 *   ui.js_heap_mb       gauge, none                 recordHeap(), Chromium only
 *   ui.moment_frame_ms  distribution, millisecond   game.round only: moment, stat=avg|max
 *
 * The game screen names the part of the round on screen (setMoment), and a
 * window sends the average and the worst frame of each part.
 *
 * Nothing is flushed here: the SDK sends on its 5 s timer and on hidden (the
 * window that ends on hidden emits first, see sample()). A
 * scene the page hid comes back when it is shown again. Nothing runs without
 * telemetry or a rAF; nothing here throws. Time is the frame clock's
 * own, never Date.now().
 */
import { telemetryLive } from "./boot"
import { recordCount, recordDistribution, recordGauge } from "./metrics"
import { pageHidden, percentile } from "./util"

export type SceneName = "game.round" | "game.confirm" | "chest" | "draw.wheel" | "waiting"

export const MOMENTS = ["intro", "play", "turned", "warn", "ending", "gap"] as const
export type MomentName = (typeof MOMENTS)[number]

/** the index in MOMENTS of the part of the round on screen, -1 for none */
let moment = -1

/** never throws; null means "no moment" */
export function setMoment(next: MomentName | null): void {
  try {
    moment = next === null ? -1 : MOMENTS.indexOf(next)
  } catch {
    /* never throws */
  }
}

/** The chain-driven part of the round currently on screen. */
export function currentMoment(): MomentName | undefined {
  return moment < 0 ? undefined : MOMENTS[moment]
}

/** a frame slower than this is "slow" */
const SLOW_FRAME_MS = 50
/** a long GAME scene reports every this long */
const WINDOW_MS = 30_000
/** fewer deltas than this say nothing */
const MIN_FRAMES = 3
/** ring capacity: 30 s at 120 Hz is 3600; a full game ring reports early,
 *  any other scene's wraps */
const FRAME_CAP = 4096
const TASK_CAP = 256
const MB = 1024 * 1024

const HEALTH_CAP = 4096
const healthAt = new Float64Array(HEALTH_CAP)
const healthDuration = new Float32Array(HEALTH_CAP)
const healthScratch = new Float32Array(HEALTH_CAP)
const loafAt = new Float64Array(TASK_CAP)
const loafDuration = new Float32Array(TASK_CAP)
const loafScratch = new Float32Array(TASK_CAP)
let healthWrite = 0
let healthCount = 0
let loafWrite = 0
let loafCount = 0
let healthLoafObserver: PerformanceObserver | null = null

export interface EffectsHealthSnapshot {
  windowMs: number
  frameP95Ms?: number
  slowFrameShare?: number
  loafP95Ms?: number
  loafMaxMs?: number
}

function recordHealthFrame(at: number, duration: number): void {
  healthAt[healthWrite] = at
  healthDuration[healthWrite] = duration
  healthWrite = (healthWrite + 1) % HEALTH_CAP
  healthCount = Math.min(HEALTH_CAP, healthCount + 1)
}

function recordHealthLoaf(at: number, duration: number): void {
  loafAt[loafWrite] = at
  loafDuration[loafWrite] = duration
  loafWrite = (loafWrite + 1) % TASK_CAP
  loafCount = Math.min(TASK_CAP, loafCount + 1)
}

function ensureHealthLoafObserver(): void {
  if (healthLoafObserver || typeof PerformanceObserver !== "function") return
  try {
    if (!PerformanceObserver.supportedEntryTypes?.includes("long-animation-frame")) return
    healthLoafObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) recordHealthLoaf(entry.startTime + entry.duration, entry.duration)
    })
    healthLoafObserver.observe({ type: "long-animation-frame", buffered: true })
  } catch {
    healthLoafObserver = null
  }
}

/** Rolling controller evidence. It never changes effects or low-power state. */
export function effectsHealthSnapshot(nowMs: number, windowMs = 30_000): EffectsHealthSnapshot {
  const earliest = nowMs - windowMs
  let frames = 0
  let slow = 0
  for (let i = 0; i < healthCount; i++) {
    const index = (healthWrite - healthCount + i + HEALTH_CAP) % HEALTH_CAP
    const at = healthAt[index]
    if (at < earliest || at > nowMs) continue
    const duration = healthDuration[index]
    healthScratch[frames++] = duration
    if (duration > SLOW_FRAME_MS) slow++
  }
  let loafs = 0
  let loafMax = 0
  for (let i = 0; i < loafCount; i++) {
    const index = (loafWrite - loafCount + i + TASK_CAP) % TASK_CAP
    const at = loafAt[index]
    if (at < earliest || at > nowMs) continue
    const duration = loafDuration[index]
    loafScratch[loafs++] = duration
    loafMax = Math.max(loafMax, duration)
  }
  const snapshot: EffectsHealthSnapshot = { windowMs }
  if (frames) {
    const sorted = healthScratch.slice(0, frames).sort()
    snapshot.frameP95Ms = percentile(sorted, 0.95)
    snapshot.slowFrameShare = slow / frames
  }
  if (loafs) {
    const sorted = loafScratch.slice(0, loafs).sort()
    snapshot.loafP95Ms = percentile(sorted, 0.95)
    snapshot.loafMaxMs = loafMax
  }
  return snapshot
}

/** Test isolation for the controller-only rolling evidence. */
export function resetEffectsHealth(): void {
  healthWrite = 0
  healthCount = 0
  loafWrite = 0
  loafCount = 0
  healthLoafObserver?.disconnect()
  healthLoafObserver = null
}

export interface Scene {
  stop(): void
  /** stopped by stop(), by the page turning hidden, or by an error */
  readonly stopped: boolean
}

function usable(): boolean {
  try {
    return (
      telemetryLive() &&
      typeof requestAnimationFrame === "function" &&
      typeof cancelAnimationFrame === "function" &&
      !pageHidden()
    )
  } catch {
    return false
  }
}

/** Sample the frames of `scene` until stop(). Idempotent stop; one emission.
 *  Null where nothing can be sampled (no telemetry, no rAF, a hidden page). */
export function startScene(scene: SceneName): Scene | null {
  try {
    if (!usable()) return null
    ensureHealthLoafObserver()
    return sample(scene)
  } catch {
    return null
  }
}

function sample(scene: SceneName): Scene {
  const windowed = scene.startsWith("game.")
  const split = scene === "game.round"
  const deltas = new Float32Array(FRAME_CAP)
  const tasks = new Float32Array(TASK_CAP)
  const momentFrames = new Uint32Array(MOMENTS.length)
  const momentSum = new Float64Array(MOMENTS.length)
  const momentMax = new Float32Array(MOMENTS.length)
  let frameCount = 0
  let slow = 0
  let taskCount = 0
  let taskMax = 0
  let last = -1
  let windowStart = -1
  let raf = 0
  let stopped = false
  let observer: PerformanceObserver | null = null

  try {
    if (typeof PerformanceObserver === "function") {
      observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (taskCount < TASK_CAP) tasks[taskCount] = entry.duration
          if (entry.duration > taskMax) taskMax = entry.duration
          taskCount += 1
        }
      })
      observer.observe({ type: "longtask" })
    }
  } catch {
    observer = null // not Chromium: no long tasks, frames still sampled
  }

  const emit = (): void => {
    try {
      if (frameCount >= MIN_FRAMES) {
        const sorted = deltas.subarray(0, Math.min(frameCount, FRAME_CAP)).sort()
        recordDistribution("ui.frame_ms", percentile(sorted, 0.5) ?? NaN, "millisecond", { scene, stat: "p50" })
        recordDistribution("ui.frame_ms", percentile(sorted, 0.95) ?? NaN, "millisecond", { scene, stat: "p95" })
        recordGauge("ui.slow_frame_pct", (slow / frameCount) * 100, "percent", { scene })
        if (taskCount > 0) {
          const sortedTasks = tasks.subarray(0, Math.min(taskCount, TASK_CAP)).sort()
          recordDistribution("ui.long_task_ms", percentile(sortedTasks, 0.95) ?? NaN, "millisecond", { scene, stat: "p95" })
          recordDistribution("ui.long_task_ms", taskMax, "millisecond", { scene, stat: "max" })
          recordCount("ui.long_tasks", taskCount, { scene })
        }
        for (let i = 0; i < MOMENTS.length; i++) {
          if (momentFrames[i] < MIN_FRAMES) continue
          recordDistribution("ui.moment_frame_ms", momentSum[i] / momentFrames[i], "millisecond", { moment: MOMENTS[i], stat: "avg" })
          recordDistribution("ui.moment_frame_ms", momentMax[i], "millisecond", { moment: MOMENTS[i], stat: "max" })
        }
      }
    } catch {
      /* never throws */
    }
    frameCount = 0
    slow = 0
    taskCount = 0
    taskMax = 0
    momentFrames.fill(0)
    momentSum.fill(0)
    momentMax.fill(0)
  }

  const onFrame = (ts: number): void => {
    raf = 0
    if (stopped) return
    try {
      if (last >= 0) {
        const delta = ts - last
        deltas[frameCount % FRAME_CAP] = delta
        recordHealthFrame(ts, delta)
        frameCount += 1
        if (delta > SLOW_FRAME_MS) slow += 1
        if (split && moment >= 0) {
          momentFrames[moment] += 1
          momentSum[moment] += delta
          if (delta > momentMax[moment]) momentMax[moment] = delta
        }
        if (windowed && (frameCount >= FRAME_CAP || ts - windowStart >= WINDOW_MS)) {
          emit()
          windowStart = ts
        }
      } else windowStart = ts
      last = ts
      raf = requestAnimationFrame(onFrame)
    } catch {
      stopped = true
    }
  }

  const onVisibility = (): void => {
    if (pageHidden()) stop()
  }

  function stop(): void {
    if (stopped) return
    stopped = true
    try {
      if (raf) cancelAnimationFrame(raf)
      window.removeEventListener("visibilitychange", onVisibility, true)
      observer?.disconnect()
    } catch {
      /* never throws */
    }
    emit()
  }

  // On the WINDOW, in the capture phase: the SDK flushes on hidden from a
  // document listener it added at init (browser client.js, the flush queued
  // as a microtask, which runs before the next listener). Capture on the
  // window runs before any document listener, so this window's points are
  // in the buffer that flush sends.
  try {
    window.addEventListener("visibilitychange", onVisibility, true)
  } catch {
    /* no window: nothing to listen to */
  }
  raf = requestAnimationFrame(onFrame)
  return {
    stop,
    get stopped() {
      return stopped
    },
  }
}

// ── one foreground scene at a time ──────────────────────────────────────────
// The screens are exclusive, so one sampler runs: entering a scene ends the
// previous one (which reports), and leaving one that is not on screen is a
// no-op. `wanted` is the scene on screen; `active` is its sampler, which the
// page turning hidden stops (and reports). Shown again, the wanted scene gets
// a fresh sampler, so a scene survives the phone being locked in it.

let wanted: SceneName | null = null
let active: { scene: SceneName; handle: Scene } | null = null
let listening = false

function endActive(): void {
  active?.handle.stop()
  active = null
}

function startWanted(): void {
  if (!wanted) return
  const handle = startScene(wanted)
  active = handle ? { scene: wanted, handle } : null
}

function onVisible(): void {
  try {
    if (pageHidden() || (active && !active.handle.stopped)) return
    startWanted()
  } catch {
    /* never throws */
  }
}

function listen(on: boolean): void {
  if (listening === on) return
  try {
    if (typeof document === "undefined") {
      listening = false
      return
    }
    if (on) document.addEventListener("visibilitychange", onVisible)
    else document.removeEventListener("visibilitychange", onVisible)
    listening = on
  } catch {
    /* no document: a hidden scene simply stays ended */
  }
}

export function enterScene(scene: SceneName): void {
  try {
    if (wanted === scene && active && !active.handle.stopped) return
    endActive()
    wanted = scene
    sceneChanged()
    listen(true)
    startWanted()
  } catch {
    /* never throws */
  }
}

export function leaveScene(scene: SceneName): void {
  if (wanted === scene) leaveAllScenes()
}

export function leaveAllScenes(): void {
  try {
    endActive()
    wanted = null
    listen(false)
    sceneChanged()
  } catch {
    /* never throws */
  }
}

/** The scene on screen, for the last-session record (session-record.ts). */
export function currentScene(): SceneName | undefined {
  return wanted ?? undefined
}

let sceneListener: (() => void) | null = null

/** One listener, told when the scene on screen changes. Never throws. */
export function setSceneListener(listener: (() => void) | null): void {
  sceneListener = listener
}

function sceneChanged(): void {
  try {
    sceneListener?.()
  } catch {
    /* never throws */
  }
}

/** The JS heap in MB right now, where the browser reports it. */
export function heapMbNow(): number | undefined {
  try {
    const used = (performance as { memory?: { usedJSHeapSize?: number } }).memory?.usedJSHeapSize
    return typeof used === "number" ? used / MB : undefined
  } catch {
    return undefined
  }
}

/** The JS heap in MB, once, where the browser reports it (Chromium). The
 *  metrics doorway is the telemetry check. */
export function recordHeap(): void {
  const heap = heapMbNow()
  if (heap !== undefined) recordGauge("ui.js_heap_mb", heap, "none", {})
}
