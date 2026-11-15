// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Extraction parity capture against origin/main at
 * bd16745608ce6938d41844681f72eb0009b75a40. The frozen public launch and
 * read implementations below are copied verbatim from that revision; the
 * abstract decision oracles then extend the comparison across arbitrary
 * event orderings that the public async hosts cannot directly inject.
 */
import fc from "fast-check"
import { describe, expect, it, vi } from "vitest"
import {
  cameraRecoveryStep,
  startCameraRecovery,
  type CameraRecoveryCommand,
  type CameraRecoveryEvent,
  type CameraFailure,
} from "./camera"
import type { CameraOpenTrigger } from "./camera-diagnostics"
import type { ChainHealthResult } from "./chain-health"
import { armLaunchStall } from "./launch-stall"
import {
  READ_ATTEMPT_MS,
  READ_RETRY_DELAYS_MS,
  ReadTimeoutError,
  readAbortReason,
  retryRead,
  waitForRead,
} from "./read-retry"
import { withTimeout } from "./with-timeout"

const frozenMainLaunch = (() => {
  const LAUNCH_STALL_MS = 15_000
  const LAUNCH_STALL_GRACE_MS = 30_000

  function armLaunchStall(options: {
    hasSource: () => boolean
    probe: () => Promise<ChainHealthResult | undefined>
    onStall: (reason: "host-unanswered" | "chain-lost" | "read-unanswered") => void
  }): () => void {
    const { hasSource, probe, onStall } = options
    let cancelled = false
    let graceTimer: ReturnType<typeof setTimeout> | undefined
    const stall = (reason: "host-unanswered" | "chain-lost" | "read-unanswered") => {
      if (!cancelled) onStall(reason)
    }
    const timer = setTimeout(() => {
      if (!hasSource()) return stall("host-unanswered")
      probe()
        .catch(() => undefined)
        .then((result) => {
          if (cancelled) return
          // only the host's own "chain lost" is proof; no probe, an unknown
          // classification and a throw are diagnostic, so they wait like a healthy one
          if (result?.outcome === "host-chain-lost")
            stall(result.errorClass === "timeout" ? "host-unanswered" : "chain-lost")
          else graceTimer = setTimeout(() => stall("read-unanswered"), LAUNCH_STALL_GRACE_MS)
        })
    }, LAUNCH_STALL_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
      clearTimeout(graceTimer)
    }
  }

  return armLaunchStall
})()

const frozenMainRead = (() => {
  function waitDelay(ms: number, signal?: AbortSignal): Promise<void> {
    if (!signal) return new Promise((resolve) => setTimeout(resolve, ms))
    let timer: ReturnType<typeof setTimeout> | undefined
    return waitForRead(
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms)
      }),
      signal,
    ).finally(() => clearTimeout(timer))
  }

  async function retryRead<T>(
    read: (signal: AbortSignal) => Promise<T>,
    options: {
      onRetry?: (error: unknown, retry: number) => void
      attemptMs?: number
      delaysMs?: readonly number[]
      /** Aborts the current attempt and prevents another one from starting. */
      signal?: AbortSignal
    } = {},
  ): Promise<T> {
    const { onRetry, attemptMs = READ_ATTEMPT_MS, delaysMs = READ_RETRY_DELAYS_MS, signal } = options
    for (let retry = 1; ; retry += 1) {
      if (signal?.aborted) throw readAbortReason(signal)
      const attempt = new AbortController()
      const abortAttempt = () => attempt.abort(readAbortReason(signal!))
      signal?.addEventListener("abort", abortAttempt, { once: true })
      try {
        // boxed, so a read that answers null is not mistaken for the deadline
        const answer = await withTimeout(
          waitForRead(Promise.resolve().then(() => read(attempt.signal)), attempt.signal).then((value) => ({ value })),
          attemptMs,
        )
        if (answer === null) {
          const timeout = new ReadTimeoutError(attemptMs)
          attempt.abort(timeout)
          throw timeout
        }
        return answer.value
      } catch (error) {
        if (signal?.aborted) throw readAbortReason(signal)
        const retryDelay = delaysMs[retry - 1]
        if (retryDelay === undefined) throw error
        onRetry?.(error, retry)
        await waitDelay(retryDelay, signal)
      } finally {
        signal?.removeEventListener("abort", abortAttempt)
        attempt.abort()
      }
    }
  }

  return retryRead
})()

async function launchTrace(
  arm: typeof armLaunchStall,
  hasSource: boolean,
  result: ChainHealthResult | undefined,
): Promise<string[]> {
  vi.useFakeTimers()
  const trace: string[] = []
  try {
    arm({ hasSource: () => hasSource, probe: async () => result, onStall: (reason) => trace.push(reason) })
    await vi.advanceTimersByTimeAsync(15_000)
    await vi.advanceTimersByTimeAsync(30_000)
    return trace
  } finally {
    vi.clearAllTimers()
    vi.useRealTimers()
  }
}

async function readTrace(implementation: typeof frozenMainRead, failures: number) {
  let attempts = 0
  const retries: number[] = []
  try {
    const value = await implementation(
      async () => {
        attempts++
        if (attempts <= failures) throw new Error(`failure-${attempts}`)
        return `answer-${attempts}`
      },
      { delaysMs: [0, 0], attemptMs: 1000, onRetry: (_error, retry) => retries.push(retry) },
    )
    return { attempts, retries, value, error: null }
  } catch (error) {
    return { attempts, retries, value: null, error: error instanceof Error ? error.message : String(error) }
  }
}

function createFrozenMainCamera() {
  const RETRY_BACKOFF_MS = [2000, 4000, 8000, 10_000]
  const BUSY_RETRY_MS = 2000
  let holders = 1
  let hidden = false
  let retries = 0
  let recoverWhenVisible = false
  let unwatchTrack: (() => void) | null = null
  let mutedTimer: number | undefined
  let retryTimer: number | undefined
  let retryCallback: (() => void) | undefined
  let retryAttempt: number | undefined
  const wasLive = false
  let recoveryReason: string | null = null
  let state: { kind: "off" | "unavailable" | "live"; stream?: object; muted?: boolean } = { kind: "off" }
  const commands: CameraRecoveryCommand[] = []
  const pageHidden = () => hidden
  const devLog = (...args: unknown[]) => { void args }
  const recordCameraTrail = (...args: unknown[]) => { void args }
  const recordCount = (_name: string, _value: number, attrs: Record<string, string>) => {
    commands.push({
      kind: "schedule",
      reason: attrs["camera.reason"]! as CameraFailure,
      trigger: attrs["camera.trigger"] === "open" ? "warm-up" : attrs["camera.trigger"]! as CameraOpenTrigger,
      attempt: Number(attrs["camera.attempt"]),
      waitMs: Number(attrs["camera.wait_ms"]),
    })
  }
  const setTimeout = (callback: () => void, _wait: number) => {
    void _wait
    retryCallback = callback
    retryAttempt = retries
    return retries + 1
  }
  const clearTimeout = (_timer: number) => {
    void _timer
    retryCallback = undefined
    retryAttempt = undefined
  }
  const openCameraFor = (_force: boolean, trigger: CameraOpenTrigger) => {
    commands.push({ kind: "recover", reason: recoveryReason ?? "back in front", trigger })
    return Promise.resolve(null)
  }

  function clearRecovery() {
    unwatchTrack?.()
    unwatchTrack = null
    if (mutedTimer) clearTimeout(mutedTimer)
    if (retryTimer) clearTimeout(retryTimer)
    mutedTimer = retryTimer = undefined
    recoverWhenVisible = false
  }

  /** reopen now if the page is in front, or as soon as it comes back */
  function recover(reason: string, trigger: CameraOpenTrigger = "force") {
    if (holders === 0) return
    if (pageHidden()) {
      recoverWhenVisible = true
      return
    }
    devLog("camera", "reopening the camera", { reason }, "warn")
    recordCameraTrail("recover.started", state.kind === "live" ? state.stream : null, { reason, trigger })
    if (recoveryReason !== "no-frames") recoveryReason = reason
    void openCameraFor(true, trigger)
  }

  function scheduleRetry(reason: CameraFailure, waitOverride?: number, trigger: CameraOpenTrigger = "warm-up") {
    if (holders === 0) return
    // hidden: no timed retry, and none counted; the return reopens it once
    if (pageHidden()) {
      recoverWhenVisible = true
      return
    }
    const wait = waitOverride ?? (reason === "busy" ? BUSY_RETRY_MS : RETRY_BACKOFF_MS[Math.min(retries, RETRY_BACKOFF_MS.length - 1)]!)
    retries++
    recordCount("camera.retry", 1, {
      "camera.open": wasLive ? "recovery" : "first",
      "camera.reason": reason,
      "camera.attempt": String(retries),
      "camera.wait_ms": String(wait),
      "camera.trigger": trigger === "warm-up" ? "open" : trigger,
    })
    retryTimer = setTimeout(() => {
      retryTimer = undefined
      recover(`retry ${retries}`, "retry")
    }, wait)
  }

  /** back in front: finish a recovery that had to wait, try a camera that could
   *  not be opened (the player may have just allowed it in their settings), and
   *  look at one that may have been taken while nobody was watching. Once per
   *  return: the open it starts is the one open in flight. */
  function onShown() {
    if (pageHidden() || holders === 0) return
    if (recoverWhenVisible || state.kind === "unavailable") {
      recoverWhenVisible = false
      recover("back in front", "return")
      return
    }
  }

  return (event: CameraRecoveryEvent) => {
    commands.length = 0
    if (event.kind === "recover") {
      holders = event.held ? 1 : 0
      hidden = event.hidden
      if (event.hidden && event.deferWithoutHolder) recoverWhenVisible = true
      else recover(event.reason, event.trigger)
    } else if (event.kind === "retry") {
      holders = event.held ? 1 : 0
      hidden = event.hidden
      scheduleRetry(event.reason, event.waitOverride, event.trigger)
    } else if (event.kind === "retry-fired") {
      holders = event.held ? 1 : 0
      hidden = event.hidden
      if (event.attempt === retryAttempt) {
        const callback = retryCallback
        retryCallback = undefined
        retryAttempt = undefined
        callback?.()
      }
    } else if (event.kind === "shown") {
      holders = event.held ? 1 : 0
      hidden = event.hidden
      state = event.unavailable ? { kind: "unavailable" } : { kind: "off" }
      onShown()
    } else if (event.kind === "clear") clearRecovery()
    else if (event.kind === "live") {
      retries = 0
    } else {
      clearRecovery()
      retries = 0
    }
    return {
      state: { retries, deferred: recoverWhenVisible, scheduledAttempt: retryTimer === undefined ? null : retryAttempt ?? null },
      commands: [...commands],
    }
  }
}

const launchResult: ChainHealthResult = { outcome: "host-chain-lost", latencyMs: 4, errorClass: "subscription-dropped", error: "lost" }
const cameraEvent = fc.oneof(
  fc.constantFrom<CameraRecoveryEvent>({ kind: "clear" }, { kind: "live" }, { kind: "stop" }),
  fc.record({ kind: fc.constant("recover"), held: fc.boolean(), hidden: fc.boolean(), reason: fc.constantFrom("ended", "muted"), trigger: fc.constantFrom("force", "return"), deferWithoutHolder: fc.boolean() }),
  fc.record({ kind: fc.constant("retry"), held: fc.boolean(), hidden: fc.boolean(), reason: fc.constantFrom("busy", "unknown", "denied"), waitOverride: fc.option(fc.constantFrom(500, 2500), { nil: undefined }), trigger: fc.constantFrom("warm-up", "return") }),
  fc.record({ kind: fc.constant("retry-fired"), attempt: fc.integer({ min: 0, max: 8 }), held: fc.boolean(), hidden: fc.boolean() }),
  fc.record({ kind: fc.constant("shown"), held: fc.boolean(), hidden: fc.boolean(), unavailable: fc.boolean() }),
)
const legacyCameraResult = (result: ReturnType<typeof cameraRecoveryStep>) => ({
  state: {
    retries: result.state.retries,
    deferred: result.state.deferred,
    scheduledAttempt: result.state.scheduledAttempt,
  },
  commands: result.commands,
})
describe("S8 reducer extraction parity", () => {
  it("keeps reachable camera recovery decisions equal to verbatim main branches", () => {
    const events: CameraRecoveryEvent[] = [
      { kind: "recover", held: false, hidden: false, reason: "ended", trigger: "force" },
      { kind: "recover", held: true, hidden: true, reason: "ended", trigger: "force" },
      { kind: "shown", held: true, hidden: false, unavailable: false },
      { kind: "clear" },
      { kind: "retry", held: true, hidden: false, reason: "busy", trigger: "warm-up" },
      { kind: "retry-fired", attempt: 1, held: true, hidden: false },
      { kind: "retry", held: true, hidden: false, reason: "unknown", trigger: "warm-up" },
      { kind: "retry-fired", attempt: 2, held: true, hidden: false },
      { kind: "retry", held: true, hidden: false, reason: "denied", waitOverride: 500, trigger: "return" },
      { kind: "retry-fired", attempt: 3, held: true, hidden: false },
      { kind: "retry", held: true, hidden: true, reason: "unknown", trigger: "warm-up" },
      { kind: "shown", held: true, hidden: false, unavailable: false },
      { kind: "live" },
      { kind: "stop" },
    ]
    const frozen = createFrozenMainCamera()
    let state = startCameraRecovery()
    for (const event of events) {
      const next = cameraRecoveryStep(state, event)
      expect(legacyCameraResult(next)).toEqual(frozen(event))
      state = next.state
    }
  })

  it("keeps launch-stall public outcomes equal to verbatim main", async () => {
    const outcomes: Array<[boolean, ChainHealthResult | undefined]> = [
      [false, undefined],
      [true, { outcome: "healthy", latencyMs: 4 }],
      [true, launchResult],
      [true, { outcome: "host-chain-lost", latencyMs: 5000, errorClass: "timeout", error: "silent" }],
      [true, { outcome: "unknown", latencyMs: 4, errorClass: "unknown", error: "diagnostic" }],
    ]
    for (const [hasSource, result] of outcomes)
      expect(await launchTrace(armLaunchStall, hasSource, result)).toEqual(
        await launchTrace(frozenMainLaunch, hasSource, result),
      )
  })

  it("keeps read-retry public outcomes equal to verbatim main", async () => {
    for (const failures of [0, 1, 2, 3, 4])
      expect(await readTrace(retryRead, failures)).toEqual(await readTrace(frozenMainRead, failures))
  })

  it("keeps camera recovery decisions equal to the frozen main recovery host", () => {
    fc.assert(fc.property(fc.array(cameraEvent, { maxLength: 60 }), (events) => {
      const frozen = createFrozenMainCamera()
      let reducer = startCameraRecovery()
      for (const event of events) {
        const old = frozen(event); const next = cameraRecoveryStep(reducer, event)
        expect(legacyCameraResult(next)).toEqual(old); reducer = next.state
      }
    }), { numRuns: 500 })
  })
})
