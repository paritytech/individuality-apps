// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import fc from "fast-check"
import { describe, expect, it, vi } from "vitest"
import {
  backoffMs,
  classifyRetry,
  HOST_NOTICE_UNKNOWN_LIMIT,
  HOST_PROBE_EVERY_MS,
  isActionableRetry,
  SLOW_AFTER_MS,
  SURFACE_AFTER_MS,
  signupWithRetry,
  waitsOnBind,
  waitsOnSeat,
  type ActionableRetryReason,
  type AttemptResult,
  type RetryReason,
  type SignupEnd,
  type SignupPhase,
  type SignupRetryDeps,
} from "@individuality/sign-up"
import { runStateMachineSuite } from "./framework"
import { signupRetryMachineDefinition, signupRetryRegressionCorpus, signupRetryTransitionTable, signupRetryWitnesses } from "./signup-retry.definition"

/**
 * Frozen copy of main's pre-extraction doorway. Keep this structurally unchanged:
 * it is the behavior oracle for the reducer-backed host below.
 */
async function signupWithRetryBeforeReducer(deps: SignupRetryDeps): Promise<{ end: SignupEnd; attempts: number; elapsedMs: number }> {
  const startedAt = deps.now()
  const elapsed = () => deps.now() - startedAt
  let finished = false
  let cancelSlow = () => {}
  let cancelProbe = () => {}
  let hostLost = false
  let surfaced: ActionableRetryReason | undefined
  const slowPhase = (): SignupPhase => surfaced ?? (hostLost ? "host-chain" : "slow")
  const armProbe = (delayMs: number) => {
    cancelProbe = deps.startTimer(delayMs, () => {
      if (finished) return
      if (deps.stopped()) {
        armProbe(1_000)
        return
      }
      void probe()
    })
  }
  let timeouts = 0
  let noVerdicts = 0
  const probe = async () => {
    let raw: "lost" | "healthy" | "timeout" | "unknown" = "unknown"
    try {
      raw = (await deps.probeHostChain?.()) ?? "unknown"
    } catch {
      // a probe that throws gives no verdict
    }
    if (finished) return
    if (deps.stopped()) {
      armProbe(1_000)
      return
    }
    timeouts = raw === "timeout" ? timeouts + 1 : 0
    const verdict = raw === "timeout" ? (timeouts >= 2 ? "lost" : "unknown") : raw
    noVerdicts = verdict === "unknown" ? noVerdicts + 1 : 0
    const next = verdict === "lost" ? true : verdict === "healthy" || noVerdicts >= HOST_NOTICE_UNKNOWN_LIMIT ? false : hostLost
    if (next !== hostLost) {
      hostLost = next
      if (!surfaced) deps.onPhase(hostLost ? "host-chain" : "slow")
      if (hostLost && surfaced !== "host-chain") deps.onErrorSurfaced?.("host-chain")
    }
    if (verdict === "healthy" && surfaced === "host-chain") {
      clearActionable()
      deps.onPhase("slow")
    }
    armProbe(HOST_PROBE_EVERY_MS)
  }
  const armSlow = (delayMs: number) => {
    cancelSlow = deps.startTimer(delayMs, () => {
      if (finished) return
      if (deps.stopped()) {
        armSlow(1_000)
        return
      }
      deps.onPhase(slowPhase())
      if (deps.probeHostChain) void probe()
    })
  }
  armSlow(SLOW_AFTER_MS)
  let attempts = 0
  let lastReason: RetryReason | undefined
  let actionable: ActionableRetryReason | undefined
  let cancelSurface = () => {}
  const clearActionable = () => {
    cancelSurface()
    cancelSurface = () => {}
    actionable = undefined
    surfaced = undefined
  }
  const armSurface = (reason: ActionableRetryReason, delayMs: number) => {
    cancelSurface = deps.startTimer(delayMs, () => {
      if (finished || actionable !== reason) return
      if (deps.stopped()) {
        armSurface(reason, 1_000)
        return
      }
      surfaced = reason
      deps.onPhase(reason)
      deps.onErrorSurfaced?.(reason)
    })
  }
  const trackActionable = (reason: RetryReason) => {
    if (!isActionableRetry(reason)) {
      clearActionable()
      return
    }
    if (actionable === reason) return
    clearActionable()
    actionable = reason
    armSurface(reason, SURFACE_AFTER_MS)
  }
  const done = (end: SignupEnd, phase: SignupPhase) => {
    finished = true
    deps.onPhase(phase)
    return { end, attempts, elapsedMs: elapsed() }
  }
  try {
    for (;;) {
      if (deps.stopped()) return done("stopped", "idle")
      const open = await deps.windowOpen()
      if (open === "registered") return done("registered", "idle")
      if (!open) return done("closed", "closed")
      attempts += 1
      if (attempts === 1) deps.onPhase("sending")
      else if (surfaced) deps.onPhase(surfaced)
      else if (elapsed() >= SLOW_AFTER_MS) deps.onPhase(slowPhase())
      else if (lastReason && !waitsOnSeat(lastReason)) deps.onPhase("sending")
      const result = await deps.attempt(attempts, deps.onWire)
      if (deps.stopped()) return done("stopped", "idle")
      if (result.kind === "landed") return done("landed", "idle")
      if (result.kind === "registered") return done("registered", "idle")
      if (result.kind === "closed") return done("closed", "closed")
      if (result.kind === "refused") return done("refused", "refused")
      trackActionable(result.reason)
      lastReason = result.reason
      const waitMs = backoffMs(attempts)
      deps.onRetry({ attempt: attempts, reason: result.reason, waitMs, elapsedMs: elapsed() })
      deps.onPhase(elapsed() >= SLOW_AFTER_MS ? slowPhase() : (surfaced ?? (waitsOnSeat(result.reason) ? "waiting-seat" : "sending")))
      await deps.wait(result.reason, waitMs)
    }
  } finally {
    finished = true
    cancelSlow()
    cancelProbe()
    cancelSurface()
  }
}

describe("signup-retry state-machine model", () => {
  it("matches the independent model, checks every invariant and gates transition coverage", async () => {
    const { coverage } = await runStateMachineSuite(signupRetryMachineDefinition)
    expect(coverage.missing).toEqual([])
    expect(coverage.impossibleObserved).toEqual([])
    expect(coverage.hit).toBe(coverage.declared)
    expect(coverage.hits["checking-window::window-open::transition"]).toBeGreaterThan(0)
    expect(coverage.hits["attempting::retry-network::transition"]).toBeGreaterThan(0)
    expect(coverage.hits["waiting::wait-finished::transition"]).toBeGreaterThan(0)
    expect(coverage.hits["finished:closed::window-open::no-op"]).toBeGreaterThan(0)
    expect(coverage.hits["attempting::stale-attempt-landed::no-op"]).toBeGreaterThan(0)
    expect(coverage.generatedSequenceLengths).toMatchObject({
      count: 300,
      min: 0,
    })
    expect(coverage.generatedSequenceLengths?.p95).toBeGreaterThanOrEqual(60)
    expect(coverage.generatedSequenceLengths?.max).toBeGreaterThanOrEqual(70)
  })

  it("keeps the full state-event table and deterministic witnesses exhaustive", () => {
    const declared = Object.values(signupRetryTransitionTable).reduce((total, row) => total + Object.keys(row).length, 0)
    expect(signupRetryWitnesses).toHaveLength(declared)
    expect(new Set(signupRetryWitnesses.map((witness) => witness.name)).size).toBe(declared)
  })

  it("keeps terminality, duplicate-submit and stale-event regressions on every run", () => {
    expect(signupRetryRegressionCorpus.map((entry) => entry.name)).toEqual([
      "retry rechecks the window before another submit",
      "closed registration stops all later retries",
      "registered wins when the window closed behind the player",
      "duplicate and stale completions cannot duplicate a submit",
      "late attempt success cannot replace a closed result",
      "player stop is terminal from every active stage",
    ])
  })
})

describe("signup-retry doorway differential", () => {
  const retryReasons: RetryReason[] = ["bind-pending", "name-pending", "stale-alias", "no-alias", "tracking-lost", "timeout", "host-chain", "network", "other"]
  const scriptArbitrary = fc.record({
    initiallyStopped: fc.boolean(),
    windows: fc.array(
      fc.record({
        result: fc.constantFrom<boolean | "registered">(true, false, "registered"),
        stopDuring: fc.boolean(),
        elapsedMs: fc.integer({ min: 0, max: 25_000 }),
      }),
      { maxLength: 5 },
    ),
    attempts: fc.array(
      fc.record({
        kind: fc.constantFrom<AttemptResult["kind"] | "throw">("landed", "registered", "closed", "refused", "retry", "throw"),
        reason: fc.constantFrom(...retryReasons),
        onWire: fc.boolean(),
        stopAfter: fc.boolean(),
        elapsedMs: fc.integer({ min: 0, max: 25_000 }),
      }),
      { maxLength: 5 },
    ),
    stopAfterWait: fc.array(fc.boolean(), { maxLength: 5 }),
    hasProbe: fc.boolean(),
  })

  type Script = {
    initiallyStopped: boolean
    windows: Array<{ result: boolean | "registered"; stopDuring: boolean; elapsedMs: number }>
    attempts: Array<{
      kind: AttemptResult["kind"] | "throw"
      reason: RetryReason
      onWire: boolean
      stopAfter: boolean
      elapsedMs: number
    }>
    stopAfterWait: boolean[]
    hasProbe: boolean
  }
  async function runScript(
    implementation: (deps: SignupRetryDeps) => Promise<{ end: SignupEnd; attempts: number; elapsedMs: number }>,
    script: Script,
  ) {
    let clock = 0
    let stopped = script.initiallyStopped
    let windowIndex = 0
    let attemptIndex = 0
    let waitIndex = 0
    let timerId = 0
    const log: string[] = []
    const deps: SignupRetryDeps = {
      windowOpen: async () => {
        const entry = script.windows[windowIndex++] ?? { result: true as const, stopDuring: false, elapsedMs: 0 }
        clock += entry.elapsedMs
        log.push(`window:${entry.result}:${entry.elapsedMs}`)
        if (entry.stopDuring) stopped = true
        return entry.result
      },
      attempt: async (attemptNo, onWire) => {
        const entry = script.attempts[attemptIndex++] ?? {
          kind: "landed" as const,
          reason: "other" as const,
          onWire: true,
          stopAfter: false,
          elapsedMs: 0,
        }
        clock += entry.elapsedMs
        log.push(`attempt:${attemptNo}:${entry.kind}:${entry.reason}:${entry.elapsedMs}`)
        if (entry.onWire) onWire()
        if (entry.stopAfter) stopped = true
        if (entry.kind === "throw") throw new Error("scripted refusal")
        if (entry.kind === "retry") return { kind: "retry", reason: entry.reason }
        if (entry.kind === "refused") return { kind: "refused", reason: "scripted refusal" }
        if (entry.kind === "landed") return { kind: "landed" }
        if (entry.kind === "registered") return { kind: "registered" }
        return { kind: "closed" }
      },
      wait: async (reason, ms) => {
        clock += ms
        log.push(`wait:${reason}:${ms}`)
        if (script.stopAfterWait[waitIndex++]) stopped = true
      },
      now: () => clock,
      stopped: () => stopped,
      startTimer: (ms) => {
        const id = ++timerId
        log.push(`timer:${id}:${ms}`)
        return () => log.push(`cancel:${id}`)
      },
      onPhase: (phase) => log.push(`phase:${phase}`),
      onRetry: ({ attempt, reason, waitMs, elapsedMs }) => log.push(`retry:${attempt}:${reason}:${waitMs}:${elapsedMs}`),
      onErrorSurfaced: (reason) => log.push(`surfaced:${reason}`),
      onWire: () => log.push("wire"),
      ...(script.hasProbe
        ? {
            probeHostChain: async () => {
              log.push("probe")
              return "healthy" as const
            },
          }
        : {}),
    }
    try {
      const result = await implementation(deps)
      return { log, result: { status: "resolved" as const, value: result } }
    } catch (error) {
      return {
        log,
        result: {
          status: "rejected" as const,
          value: error instanceof Error ? error.message : String(error),
        },
      }
    }
  }

  it("matches main's frozen doorway over generated transport scripts", async () => {
    await fc.assert(
      fc.asyncProperty(scriptArbitrary, async (script) => {
        expect(await runScript(signupWithRetry, script)).toEqual(await runScript(signupWithRetryBeforeReducer, script))
      }),
      { numRuns: 1_000 },
    )
  })
})

describe("signup-retry mutation guards", () => {
  it("keeps every retry-reason predicate exact", () => {
    const reasons: RetryReason[] = ["bind-pending", "name-pending", "name-unowned", "stale-alias", "no-alias", "tracking-lost", "timeout", "host-chain", "network", "other"]
    expect(reasons.map((reason) => [reason, waitsOnBind(reason), waitsOnSeat(reason), isActionableRetry(reason)])).toEqual([
      ["bind-pending", true, true, false],
      ["name-pending", false, true, false],
      ["name-unowned", false, true, true],
      ["stale-alias", false, false, false],
      ["no-alias", true, true, false],
      ["tracking-lost", false, false, false],
      ["timeout", false, false, false],
      ["host-chain", false, false, true],
      ["network", false, false, true],
      ["other", false, false, false],
    ])
  })

  it("recognizes both compact and separated timeout spellings", () => {
    expect(classifyRetry("operation timeout")).toBe("timeout")
    expect(classifyRetry("operation timedout")).toBe("timeout")
    expect(classifyRetry("operation timed out")).toBe("timeout")
  })

  it("reports elapsed time from the injected steady-clock origin", async () => {
    let now = 41_000
    const result = await signupWithRetry({
      attempt: async () => {
        now = 44_250
        return { kind: "landed" }
      },
      windowOpen: async () => true,
      wait: async () => {},
      now: () => now,
      stopped: () => false,
      startTimer: () => () => {},
      onPhase: () => {},
      onRetry: () => {},
      onWire: () => {},
    })
    expect(result).toEqual({ end: "landed", attempts: 1, elapsedMs: 3_250 })
  })

  it("cancels the slow, probe and actionable timers after success", async () => {
    let now = 0
    let attempts = 0
    const timers: Array<{
      ms: number
      fn: () => void
      cancel: ReturnType<typeof vi.fn>
    }> = []
    const phases: SignupPhase[] = []
    const probe = vi.fn(async () => "healthy" as const)
    const result = await signupWithRetry({
      attempt: async () => {
        attempts += 1
        return attempts === 1 ? { kind: "retry", reason: "network" } : { kind: "landed" }
      },
      windowOpen: async () => true,
      wait: async (_reason, ms) => {
        now += ms
        const slow = timers.find((timer) => timer.ms === 20_000)
        slow?.fn()
        await Promise.resolve()
        await Promise.resolve()
      },
      now: () => now,
      stopped: () => false,
      startTimer: (ms, fn) => {
        const timer = { ms, fn, cancel: vi.fn() }
        timers.push(timer)
        return timer.cancel
      },
      onPhase: (phase) => phases.push(phase),
      onRetry: () => {},
      onWire: () => {},
      probeHostChain: probe,
    })
    expect(result.end).toBe("landed")
    expect(phases).toContain("slow")
    expect(timers.map((timer) => timer.ms)).toEqual(expect.arrayContaining([20_000, 60_000, 15_000]))
    for (const timer of timers) expect(timer.cancel).toHaveBeenCalledOnce()
    timers.find((timer) => timer.ms === 15_000)!.fn()
    await Promise.resolve()
    expect(probe).toHaveBeenCalledOnce()
  })

  it("defers a probe verdict returned while paused and probes again after resume", async () => {
    let paused = false
    let releaseProbe!: (verdict: "lost") => void
    let probeCalls = 0
    let releaseAttempt!: () => void
    const phases: SignupPhase[] = []
    const surfaced: string[] = []
    const timers: Array<{ ms: number; fn: () => void }> = []
    const run = signupWithRetry({
      attempt: () =>
        new Promise<AttemptResult>((resolve) => {
          releaseAttempt = () => resolve({ kind: "landed" })
        }),
      windowOpen: async () => true,
      wait: async () => {},
      now: () => 0,
      stopped: () => paused,
      startTimer: (ms, fn) => {
        const timer = { ms, fn }
        timers.push(timer)
        return () => void timers.splice(timers.indexOf(timer), 1)
      },
      onPhase: (phase) => phases.push(phase),
      onRetry: () => {},
      onErrorSurfaced: (reason) => surfaced.push(reason),
      onWire: () => {},
      probeHostChain: () => {
        probeCalls += 1
        return probeCalls === 1
          ? new Promise((resolve) => {
              releaseProbe = resolve
            })
          : Promise.resolve("lost")
      },
    })
    while (!releaseAttempt) await Promise.resolve()
    timers.find((timer) => timer.ms === 20_000)!.fn()
    while (!releaseProbe) await Promise.resolve()
    paused = true
    releaseProbe("lost")
    await Promise.resolve()
    await Promise.resolve()
    expect(surfaced).toEqual([])
    paused = false
    timers.find((timer) => timer.ms === 1_000)!.fn()
    await Promise.resolve()
    await Promise.resolve()
    expect(surfaced).toEqual(["host-chain"])
    releaseAttempt()
    await run
  })

  it("treats thrown probes as unknown verdicts that eventually clear a lost notice", async () => {
    let probeCalls = 0
    let releaseAttempt!: () => void
    const phases: SignupPhase[] = []
    const timers: Array<{ ms: number; fn: () => void }> = []
    const run = signupWithRetry({
      attempt: () =>
        new Promise<AttemptResult>((resolve) => {
          releaseAttempt = () => resolve({ kind: "landed" })
        }),
      windowOpen: async () => true,
      wait: async () => {},
      now: () => 0,
      stopped: () => false,
      startTimer: (ms, fn) => {
        const timer = { ms, fn }
        timers.push(timer)
        return () => void timers.splice(timers.indexOf(timer), 1)
      },
      onPhase: (phase) => phases.push(phase),
      onRetry: () => {},
      onWire: () => {},
      probeHostChain: async () => {
        probeCalls += 1
        if (probeCalls === 1) return "lost"
        throw new Error("no verdict")
      },
    })
    while (!releaseAttempt) await Promise.resolve()
    timers.find((timer) => timer.ms === 20_000)!.fn()
    for (let i = 0; i < 8; i++) await Promise.resolve()
    for (let count = 0; count < 3; count += 1) {
      timers.find((timer) => timer.ms === 15_000)!.fn()
      for (let i = 0; i < 8; i++) await Promise.resolve()
    }
    expect(phases).toEqual(["sending", "slow", "host-chain", "slow"])
    releaseAttempt()
    await run
  })

  it("does not start window or attempt work when already stopped", async () => {
    const windowOpen = vi.fn(async () => true)
    const attempt = vi.fn(async (): Promise<AttemptResult> => ({
      kind: "landed",
    }))
    const phases: SignupPhase[] = []
    await expect(
      signupWithRetry({
        attempt,
        windowOpen,
        wait: async () => {},
        now: () => 0,
        stopped: () => true,
        startTimer: () => () => {},
        onPhase: (phase) => phases.push(phase),
        onRetry: () => {},
        onWire: () => {},
      }),
    ).resolves.toEqual({ end: "stopped", attempts: 0, elapsedMs: 0 })
    expect(windowOpen).not.toHaveBeenCalled()
    expect(attempt).not.toHaveBeenCalled()
    expect(phases).toEqual(["idle"])
  })

  it("makes every retained timer callback inert after the run finishes", async () => {
    const timers: Array<() => void> = []
    const phases: SignupPhase[] = []
    const surfaced: string[] = []
    const probe = vi.fn(async () => "lost" as const)
    const result = await signupWithRetry({
      attempt: async (): Promise<AttemptResult> => ({ kind: "landed" }),
      windowOpen: async () => true,
      wait: async () => {},
      now: () => 0,
      stopped: () => false,
      startTimer: (_ms, fn) => {
        timers.push(fn)
        return () => {}
      },
      onPhase: (phase) => phases.push(phase),
      onRetry: () => {},
      onErrorSurfaced: (reason) => surfaced.push(reason),
      onWire: () => {},
      probeHostChain: probe,
    })
    expect(result.end).toBe("landed")
    for (const timer of timers) timer()
    await Promise.resolve()
    await Promise.resolve()
    expect(phases).toEqual(["sending", "idle"])
    expect(surfaced).toEqual([])
    expect(probe).not.toHaveBeenCalled()
  })

  it("rechecks a scheduled host probe after pause without probing while paused", async () => {
    let paused = false
    let releaseAttempt!: () => void
    const timers: Array<{ ms: number; fn: () => void }> = []
    const probe = vi.fn(async () => "healthy" as const)
    const run = signupWithRetry({
      attempt: () =>
        new Promise<AttemptResult>((resolve) => {
          releaseAttempt = () => resolve({ kind: "landed" })
        }),
      windowOpen: async () => true,
      wait: async () => {},
      now: () => 0,
      stopped: () => paused,
      startTimer: (ms, fn) => {
        const timer = { ms, fn }
        timers.push(timer)
        return () => void timers.splice(timers.indexOf(timer), 1)
      },
      onPhase: () => {},
      onRetry: () => {},
      onWire: () => {},
      probeHostChain: probe,
    })
    while (!releaseAttempt) await Promise.resolve()
    timers.find((timer) => timer.ms === 20_000)!.fn()
    for (let i = 0; i < 4; i++) await Promise.resolve()
    expect(probe).toHaveBeenCalledOnce()
    paused = true
    timers.find((timer) => timer.ms === 15_000)!.fn()
    expect(probe).toHaveBeenCalledOnce()
    expect(timers.some((timer) => timer.ms === 1_000)).toBe(true)
    paused = false
    timers.find((timer) => timer.ms === 1_000)!.fn()
    await Promise.resolve()
    expect(probe).toHaveBeenCalledTimes(2)
    releaseAttempt()
    await run
  })

  it("cancels a persistent actionable notice when the failure changes", async () => {
    let attempts = 0
    const timers: Array<{ ms: number; fn: () => void }> = []
    const surfaced: string[] = []
    const phases: SignupPhase[] = []
    await signupWithRetry({
      attempt: async (): Promise<AttemptResult> => {
        attempts += 1
        if (attempts === 1) return { kind: "retry", reason: "network" }
        if (attempts === 2) return { kind: "retry", reason: "other" }
        return { kind: "landed" }
      },
      windowOpen: async () => true,
      wait: async () => {},
      now: () => 0,
      stopped: () => false,
      startTimer: (ms, fn) => {
        const timer = { ms, fn }
        timers.push(timer)
        return () => {}
      },
      onPhase: (phase) => phases.push(phase),
      onRetry: () => {},
      onErrorSurfaced: (reason) => surfaced.push(reason),
      onWire: () => {},
    })
    for (const timer of timers) timer.fn()
    expect(surfaced).toEqual([])
    expect(phases).not.toContain("network")
  })

  it("announces the exact retry phase before and at the slow boundary", async () => {
    let now = 0
    let attempts = 0
    const phases: SignupPhase[] = []
    await signupWithRetry({
      attempt: async (): Promise<AttemptResult> => {
        attempts += 1
        if (attempts === 1) {
          now = 20_000
          return { kind: "retry", reason: "other" }
        }
        return { kind: "landed" }
      },
      windowOpen: async () => true,
      wait: async () => {},
      now: () => now,
      stopped: () => false,
      startTimer: () => () => {},
      onPhase: (phase) => phases.push(phase),
      onRetry: () => {},
      onWire: () => {},
    })
    expect(phases).toEqual(["sending", "slow", "slow", "idle"])
  })

  it("repeats a surfaced notice when the next attempt starts", async () => {
    let attempts = 0
    const timers: Array<{ ms: number; fn: () => void }> = []
    const phases: SignupPhase[] = []
    await signupWithRetry({
      attempt: async (): Promise<AttemptResult> => {
        attempts += 1
        return attempts === 1 ? { kind: "retry", reason: "network" } : { kind: "landed" }
      },
      windowOpen: async () => true,
      wait: async () => {
        timers.find((timer) => timer.ms === 60_000)!.fn()
      },
      now: () => 0,
      stopped: () => false,
      startTimer: (ms, fn) => {
        const timer = { ms, fn }
        timers.push(timer)
        return () => {}
      },
      onPhase: (phase) => phases.push(phase),
      onRetry: () => {},
      onWire: () => {},
    })
    expect(phases.filter((phase) => phase === "network")).toHaveLength(2)
  })

  it("does not probe or schedule probe polling when no probe capability exists", async () => {
    let releaseAttempt!: () => void
    const timers: Array<{ ms: number; fn: () => void }> = []
    const run = signupWithRetry({
      attempt: () =>
        new Promise<AttemptResult>((resolve) => {
          releaseAttempt = () => resolve({ kind: "landed" })
        }),
      windowOpen: async () => true,
      wait: async () => {},
      now: () => 0,
      stopped: () => false,
      startTimer: (ms, fn) => {
        const timer = { ms, fn }
        timers.push(timer)
        return () => void timers.splice(timers.indexOf(timer), 1)
      },
      onPhase: () => {},
      onRetry: () => {},
      onWire: () => {},
    })
    while (!releaseAttempt) await Promise.resolve()
    timers.find((timer) => timer.ms === 20_000)!.fn()
    for (let i = 0; i < 4; i++) await Promise.resolve()
    expect(timers.map((timer) => timer.ms)).toEqual([20_000])
    releaseAttempt()
    await run
  })

  it("keeps a cancelled actionable callback inert while the run is still active", async () => {
    let attempts = 0
    let waits = 0
    const timers: Array<{ ms: number; fn: () => void }> = []
    const surfaced: string[] = []
    await signupWithRetry({
      attempt: async (): Promise<AttemptResult> => {
        attempts += 1
        if (attempts === 1) return { kind: "retry", reason: "network" }
        if (attempts === 2) return { kind: "retry", reason: "other" }
        return { kind: "landed" }
      },
      windowOpen: async () => true,
      wait: async () => {
        waits += 1
        if (waits === 2) {
          expect(timers.filter((timer) => timer.ms === 60_000)).toHaveLength(1)
          timers.find((timer) => timer.ms === 60_000)!.fn()
        }
      },
      now: () => 0,
      stopped: () => false,
      startTimer: (ms, fn) => {
        timers.push({ ms, fn })
        return () => {}
      },
      onPhase: () => {},
      onRetry: () => {},
      onErrorSurfaced: (reason) => surfaced.push(reason),
      onWire: () => {},
    })
    expect(surfaced).toEqual([])
  })

  it("uses host-chain as the slow phase after a lost probe", async () => {
    let attempts = 0
    let now = 0
    let releaseFirst!: () => void
    const timers: Array<{ ms: number; fn: () => void }> = []
    const phases: SignupPhase[] = []
    const run = signupWithRetry({
      attempt: async (): Promise<AttemptResult> => {
        attempts += 1
        if (attempts === 1)
          return new Promise((resolve) => {
            releaseFirst = () => resolve({ kind: "retry", reason: "other" })
          })
        return { kind: "landed" }
      },
      windowOpen: async () => true,
      wait: async () => {},
      now: () => now,
      stopped: () => false,
      startTimer: (ms, fn) => {
        const timer = { ms, fn }
        timers.push(timer)
        return () => void timers.splice(timers.indexOf(timer), 1)
      },
      onPhase: (phase) => phases.push(phase),
      onRetry: () => {},
      onWire: () => {},
      probeHostChain: async () => "lost",
    })
    while (!releaseFirst) await Promise.resolve()
    now = 20_000
    timers.find((timer) => timer.ms === 20_000)!.fn()
    for (let i = 0; i < 4; i++) await Promise.resolve()
    releaseFirst()
    await run
    expect(phases.filter((phase) => phase === "host-chain")).toHaveLength(3)
    expect(phases).not.toContain("" as SignupPhase)
  })

  it("treats an undefined probe response as an unknown verdict", async () => {
    const verdicts: Array<"lost" | undefined> = ["lost", undefined, undefined, undefined]
    let releaseAttempt!: () => void
    const timers: Array<{ ms: number; fn: () => void }> = []
    const phases: SignupPhase[] = []
    const run = signupWithRetry({
      attempt: () =>
        new Promise<AttemptResult>((resolve) => {
          releaseAttempt = () => resolve({ kind: "landed" })
        }),
      windowOpen: async () => true,
      wait: async () => {},
      now: () => 0,
      stopped: () => false,
      startTimer: (ms, fn) => {
        const timer = { ms, fn }
        timers.push(timer)
        return () => void timers.splice(timers.indexOf(timer), 1)
      },
      onPhase: (phase) => phases.push(phase),
      onRetry: () => {},
      onWire: () => {},
      probeHostChain: async () => verdicts.shift() as "lost",
    })
    while (!releaseAttempt) await Promise.resolve()
    timers.find((timer) => timer.ms === 20_000)!.fn()
    for (let i = 0; i < 5; i++) await Promise.resolve()
    for (let step = 0; step < 3; step += 1) {
      timers.find((timer) => timer.ms === 15_000)!.fn()
      for (let i = 0; i < 5; i++) await Promise.resolve()
    }
    expect(phases.at(-1)).toBe("slow")
    releaseAttempt()
    await run
  })

  it.each([
    ["healthy", 2, "sending"],
    ["lost", 1, "host-chain"],
  ] as const)("%s probe handling preserves the retry-surfaced host notice rule", async (verdict, surfaceTimers, retryPhase) => {
    let attempts = 0
    let releaseSecond!: () => void
    let waits = 0
    const timers: Array<{ ms: number; fn: () => void }> = []
    const phases: SignupPhase[] = []
    const run = signupWithRetry({
      attempt: async (): Promise<AttemptResult> => {
        attempts += 1
        if (attempts === 1) return { kind: "retry", reason: "host-chain" }
        if (attempts === 2)
          return new Promise((resolve) => {
            releaseSecond = () => resolve({ kind: "retry", reason: "host-chain" })
          })
        return { kind: "landed" }
      },
      windowOpen: async () => true,
      wait: async () => {
        waits += 1
        if (waits === 1) timers.find((timer) => timer.ms === 60_000)!.fn()
      },
      now: () => 0,
      stopped: () => false,
      startTimer: (ms, fn) => {
        const timer = { ms, fn }
        timers.push(timer)
        return () => {}
      },
      onPhase: (phase) => phases.push(phase),
      onRetry: () => {},
      onWire: () => {},
      probeHostChain: async () => verdict,
    })
    while (!releaseSecond) await Promise.resolve()
    timers.find((timer) => timer.ms === 20_000)!.fn()
    for (let i = 0; i < 5; i++) await Promise.resolve()
    releaseSecond()
    await run
    expect(timers.filter((timer) => timer.ms === 60_000)).toHaveLength(surfaceTimers)
    expect(phases.at(-3)).toBe(retryPhase)
  })

  it("announces sending on every fast non-seat retry and next attempt", async () => {
    let attempts = 0
    const phases: SignupPhase[] = []
    await signupWithRetry({
      attempt: async (): Promise<AttemptResult> => {
        attempts += 1
        return attempts < 3 ? { kind: "retry", reason: "other" } : { kind: "landed" }
      },
      windowOpen: async () => true,
      wait: async () => {},
      now: () => 0,
      stopped: () => false,
      startTimer: () => () => {},
      onPhase: (phase) => phases.push(phase),
      onRetry: () => {},
      onWire: () => {},
    })
    expect(phases).toEqual(["sending", "sending", "sending", "sending", "sending", "idle"])
  })

  async function surfacedProbeScenario(reason: "network" | "host-chain", verdict: "lost" | "healthy") {
    let attempts = 0
    let releaseAttempt!: () => void
    const timers: Array<{ ms: number; fn: () => void }> = []
    const phases: SignupPhase[] = []
    const surfaced: string[] = []
    const run = signupWithRetry({
      attempt: async (): Promise<AttemptResult> => {
        attempts += 1
        if (attempts === 1) return { kind: "retry", reason }
        return new Promise((resolve) => {
          releaseAttempt = () => resolve({ kind: "landed" })
        })
      },
      windowOpen: async () => true,
      wait: async () => {
        timers.find((timer) => timer.ms === 60_000)!.fn()
      },
      now: () => 0,
      stopped: () => false,
      startTimer: (ms, fn) => {
        const timer = { ms, fn }
        timers.push(timer)
        return () => void timers.splice(timers.indexOf(timer), 1)
      },
      onPhase: (phase) => phases.push(phase),
      onRetry: () => {},
      onErrorSurfaced: (value) => surfaced.push(value),
      onWire: () => {},
      probeHostChain: async () => verdict,
    })
    while (!releaseAttempt) await Promise.resolve()
    timers.find((timer) => timer.ms === 20_000)!.fn()
    for (let i = 0; i < 6; i++) await Promise.resolve()
    releaseAttempt()
    await run
    return { phases, surfaced }
  }

  it("does not replace a surfaced network notice with the host probe phase", async () => {
    const lost = await surfacedProbeScenario("network", "lost")
    expect(lost.phases).not.toContain("host-chain")
    expect(lost.surfaced).toEqual(["network", "host-chain"])
    const healthy = await surfacedProbeScenario("network", "healthy")
    expect(healthy.surfaced).toEqual(["network"])
  })

  it("does not duplicate a surfaced host-chain notice and clears it only on healthy", async () => {
    const lost = await surfacedProbeScenario("host-chain", "lost")
    expect(lost.surfaced).toEqual(["host-chain"])
    const healthy = await surfacedProbeScenario("host-chain", "healthy")
    expect(healthy.phases.at(-2)).toBe("slow")
    expect(healthy.surfaced).toEqual(["host-chain"])
  })

  it("counts a timeout plus two unknown probes before clearing a lost notice", async () => {
    const verdicts = ["lost", "timeout", "unknown", "unknown"] as const
    let probeIndex = 0
    let releaseAttempt!: () => void
    const timers: Array<{ ms: number; fn: () => void }> = []
    const phases: SignupPhase[] = []
    const run = signupWithRetry({
      attempt: () =>
        new Promise<AttemptResult>((resolve) => {
          releaseAttempt = () => resolve({ kind: "landed" })
        }),
      windowOpen: async () => true,
      wait: async () => {},
      now: () => 0,
      stopped: () => false,
      startTimer: (ms, fn) => {
        const timer = { ms, fn }
        timers.push(timer)
        return () => void timers.splice(timers.indexOf(timer), 1)
      },
      onPhase: (phase) => phases.push(phase),
      onRetry: () => {},
      onWire: () => {},
      probeHostChain: async () => verdicts[probeIndex++] ?? "unknown",
    })
    while (!releaseAttempt) await Promise.resolve()
    timers.find((timer) => timer.ms === 20_000)!.fn()
    for (let i = 0; i < 6; i++) await Promise.resolve()
    expect(phases.at(-1)).toBe("host-chain")
    for (let step = 0; step < 2; step += 1) {
      timers.find((timer) => timer.ms === 15_000)!.fn()
      for (let i = 0; i < 6; i++) await Promise.resolve()
      expect(phases.at(-1)).toBe("host-chain")
    }
    timers.find((timer) => timer.ms === 15_000)!.fn()
    for (let i = 0; i < 6; i++) await Promise.resolve()
    expect(phases.at(-1)).toBe("slow")
    releaseAttempt()
    await run
  })
})
