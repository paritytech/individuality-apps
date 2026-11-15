// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it, vi } from "vitest"
import {
  backoffMs,
  classifyPermanent,
  classifyRetry,
  signupWithRetry,
  HOST_PROBE_EVERY_MS,
  SLOW_AFTER_MS,
  type ActionableRetryReason,
  type AttemptResult,
  type RetryReason,
  type SignupPhase,
} from "./signup-retry"

/** a fake clock the waits advance, so nothing here uses a timer */
function harness(
  results: Array<AttemptResult | Error>,
  options: { closeAfter?: number; stopAfter?: number; inWhenClosed?: boolean } = {},
) {
  let clock = 0
  const timers: Array<{ at: number; fn: () => void }> = []
  const phases: SignupPhase[] = []
  const phaseAt: Array<[SignupPhase, number]> = []
  const waits: Array<[RetryReason, number]> = []
  const retries: Array<{ attempt: number; reason: RetryReason; waitMs: number }> = []
  let attempts = 0
  const onWire = vi.fn()
  const run = signupWithRetry({
    attempt: async (_n, wire) => {
      attempts += 1
      const next = results.shift() ?? ({ kind: "landed" } as AttemptResult)
      if (next instanceof Error) throw next
      if (next.kind === "landed") wire()
      return next
    },
    windowOpen: async () =>
      options.closeAfter === undefined || attempts < options.closeAfter || (options.inWhenClosed ? "registered" : false),
    wait: async (reason, ms) => {
      waits.push([reason, ms])
      advance(ms)
    },
    now: () => clock,
    stopped: () => options.stopAfter !== undefined && attempts >= options.stopAfter,
    startTimer: (ms: number, fn: () => void) => {
      timers.push({ at: clock + ms, fn })
      return () => void timers.splice(0, timers.length, ...timers.filter((t) => t.fn !== fn))
    },
    onPhase: (phase) => {
      phases.push(phase)
      phaseAt.push([phase, clock])
    },
    onRetry: ({ attempt, reason, waitMs }) => retries.push({ attempt, reason, waitMs }),
    onWire,
  })
  /** move the clock and fire what is due, as a hung attempt would see it */
  function advance(ms: number) {
    const target = clock + ms
    for (;;) {
      const next = timers.filter((t) => t.at <= target).sort((a, b) => a.at - b.at)[0]
      if (!next) break
      clock = next.at
      timers.splice(timers.indexOf(next), 1)
      next.fn()
    }
    clock = target
  }
  return { run, phases, phaseAt, waits, retries, onWire, attempts: () => attempts, advance }
}
const retry = (reason: RetryReason): AttemptResult => ({ kind: "retry", reason })
const SDK_INTERRUPTED =
  "Could not process the host's response to createTransaction failed: TrUAPI host connection interrupted. The usual cause is a protocol-version skew between the host app and the @parity/truapi version this product is built against; a host channel that closed mid-call looks the same."

describe("the backoff", () => {
  it("is 2, 4, 8 s and then every 15 s", () => {
    expect([1, 2, 3, 4, 5, 9].map(backoffMs)).toEqual([2000, 4000, 8000, 15000, 15000, 15000])
  })
})

describe("classifyRetry", () => {
  it.each([
    ["Invalid transaction: Custom(175)", "no-alias"],
    ["AliasNotBound", "no-alias"],
    ["Invalid transaction: Custom(172)", "stale-alias"],
    ["Tracking stopped", "tracking-lost"],
    ["request timed out", "timeout"],
    ["createTransaction failed: RPC error: subscription dropped", "host-chain"],
    ["Block 0x89b2 is not pinned (stop-storage) <- BlockNotPinnedError", "host-chain"],
    ["TrUAPI host connection interrupted", "host-interrupted"],
    [SDK_INTERRUPTED, "host-interrupted"],
    ["HostDisconnectedError: host went away", "network"],
    ["Transaction signing was rejected.", "other"],
    ["Host rejected the request", "other"],
    ["something nobody has met", "other"],
  ])("%s is %s", (error, reason) => {
    expect(classifyRetry(error)).toBe(reason)
  })

  it("shares the cannot-get-current-block signature with the health probe", () => {
    expect(classifyRetry("cannot get the current block")).toBe("host-chain")
  })
})

describe("classifyPermanent", () => {
  it.each([
    ["Game.AlreadyRegistered", "registered"],
    ["InvalidGameState", "closed"],
    ["NoGame", "closed"],
    // the Game pallet's own names (descriptors' Game error enum, #581): the
    // window closed, or the game is under way
    ["NoRegistration", "closed"],
    ["GameOngoing", "closed"],
    ["UseInviteButAlreadyPlaying", "refused"],
    ["CreditCapacityExhausted", "refused"],
    ["Invalid transaction: Payment", "refused"],
    ["BadOrigin", "refused"],
  ])("%s ends it as %s", (error, kind) => {
    expect(classifyPermanent(error)).toBe(kind)
  })
  it.each(["Invalid transaction: Custom(172)", "Custom(175)", "Tracking stopped", "InvalidAirdropVrfCount", "something new"])(
    "%s is retried",
    (error) => {
      expect(classifyPermanent(error)).toBeNull()
    },
  )
})

describe("signupWithRetry", () => {
  it("finishes an attempt whose window check was already in flight when stopped", async () => {
    let stopped = false
    let releaseWindow!: () => void
    let releaseAttempt!: () => void
    const phases: SignupPhase[] = []
    const timers: Array<{ ms: number; fn: () => void }> = []
    const attempt = vi.fn(
      (_attemptNo: number, onWire: () => void) =>
        new Promise<AttemptResult>((resolve) => {
          onWire()
          releaseAttempt = () => resolve({ kind: "registered" })
        }),
    )
    let resolveTap!: () => void
    const tap = new Promise<void>((resolve) => {
      resolveTap = resolve
    })
    const run = signupWithRetry({
      attempt: (attemptNo, onWire) =>
        attempt(attemptNo, () => {
          onWire()
          resolveTap()
        }),
      windowOpen: () =>
        new Promise<boolean>((resolve) => {
          releaseWindow = () => resolve(true)
        }),
      wait: async () => {},
      now: () => 0,
      stopped: () => stopped,
      startTimer: (ms, fn) => {
        timers.push({ ms, fn })
        return () => {}
      },
      onPhase: (phase) => phases.push(phase),
      onRetry: () => {},
      onWire: () => {},
    })

    while (!releaseWindow) await Promise.resolve()
    stopped = true
    releaseWindow()
    while (!releaseAttempt) await Promise.resolve()
    await expect(tap).resolves.toBeUndefined()
    stopped = false
    timers.find((timer) => timer.ms === SLOW_AFTER_MS)!.fn()
    stopped = true
    releaseAttempt()

    await expect(run).resolves.toEqual({ end: "stopped", attempts: 1, elapsedMs: 0 })
    expect(attempt).toHaveBeenCalledOnce()
    expect(phases).toEqual(["sending", "slow", "idle"])
  })

  it("announces 'taking longer' from a timer while one attempt hangs, with no loop turn", async () => {
    let release!: () => void
    const phases: SignupPhase[] = []
    const timers: Array<() => void> = []
    const run = signupWithRetry({
      attempt: () => new Promise((resolve) => (release = () => resolve({ kind: "landed" }))),
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
      onWire: () => {},
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(phases).toEqual(["sending"])
    timers[0]!()
    expect(phases).toEqual(["sending", "slow"])
    release()
    await run
    expect(phases).not.toContain("network")
    expect(phases).not.toContain("host-chain")
  })

  it("retains the slow notice when its timer fires during a pause", async () => {
    let stopped = false
    let release!: () => void
    const phases: SignupPhase[] = []
    const timers: Array<{ ms: number; fn: () => void }> = []
    const run = signupWithRetry({
      attempt: () => new Promise((resolve) => (release = () => resolve({ kind: "landed" }))),
      windowOpen: async () => true,
      wait: async () => {},
      now: () => 0,
      stopped: () => stopped,
      startTimer: (ms, fn) => {
        const timer = { ms, fn }
        timers.push(timer)
        return () => void timers.splice(timers.indexOf(timer), 1)
      },
      onPhase: (phase) => phases.push(phase),
      onRetry: () => {},
      onWire: () => {},
    })
    while (!release) await Promise.resolve()
    stopped = true
    timers.find((timer) => timer.ms === 20_000)!.fn()
    expect(phases).toEqual(["sending"])
    stopped = false
    timers.find((timer) => timer.ms === 1_000)!.fn()
    expect(phases).toEqual(["sending", "slow"])
    release()
    await run
  })

  it.each([
    ["closed", "closed"],
    ["refused", "refused"],
  ] as const)("ends %s on the chain's word, with no retry", async (kind, phase) => {
    const h = harness([kind === "closed" ? { kind: "closed" } : { kind: "refused", reason: "NoInvites" }])
    expect(await h.run).toMatchObject({ end: kind, attempts: 1 })
    expect(h.phases[h.phases.length - 1]).toBe(phase)
    expect(h.waits).toEqual([])
  })

  it("lands first time without waiting", async () => {
    const h = harness([{ kind: "landed" }])
    expect(await h.run).toMatchObject({ end: "landed", attempts: 1 })
    expect(h.waits).toEqual([])
    expect(h.onWire).toHaveBeenCalledTimes(1)
    expect(h.phases).toEqual(["sending", "idle"])
  })

  it("keeps retrying past many failures, on the backoff, and then lands", async () => {
    const h = harness([retry("other"), retry("network"), retry("stale-alias"), retry("timeout"), retry("other"), retry("other")])
    const done = await h.run
    expect(done).toMatchObject({ end: "landed", attempts: 7 })
    expect(h.waits.map(([, ms]) => ms)).toEqual([2000, 4000, 8000, 15000, 15000, 15000])
    expect(h.retries.map((r) => r.reason)).toEqual(["other", "network", "stale-alias", "timeout", "other", "other"])
  })

  it("says it is taking longer once past the threshold, and not before", async () => {
    const h = harness([retry("network"), retry("network"), retry("network")])
    await h.run
    // waits of 2, 4, 8 s: 14 s on the clock after the third failure, so never slow
    expect(h.phases).not.toContain("slow")
    const slow = harness([retry("network"), retry("network"), retry("network"), retry("network")])
    await slow.run
    // 2 + 4 + 8 + 15 = 29 s: the fourth failure is past SLOW_AFTER_MS
    expect(SLOW_AFTER_MS).toBe(20_000)
    expect(slow.phases).toContain("slow")
    expect(slow.phases[slow.phases.length - 1]).toBe("idle")
  })

  it("surfaces an actionable reason exactly 60 seconds after the first matching failure", async () => {
    const h = harness(Array.from({ length: 8 }, () => retry("network")))
    await h.run
    expect(h.phaseAt).toContainEqual(["network", 60_000])
    expect(h.phases[h.phases.length - 1]).toBe("idle")
  })

  it("surfaces an unowned username on its first failure", async () => {
    const h = harness([retry("name-unowned"), retry("name-unowned")])
    await h.run
    expect(h.phaseAt).toContainEqual(["name-unowned", 0])
    expect(h.phases).not.toContain("slow")
  })

  it("retries a host interruption on the backoff with no notice", async () => {
    const h = harness(Array.from({ length: 7 }, () => retry(classifyRetry(SDK_INTERRUPTED))))
    expect(await h.run).toMatchObject({ end: "landed", attempts: 8, elapsedMs: 74_000 })
    expect(h.waits).toEqual(
      [2000, 4000, 8000, 15000, 15000, 15000, 15000].map((ms) => ["host-interrupted", ms]),
    )
    expect([...new Set(h.phases)]).toEqual(["sending", "slow", "idle"])
  })

  it("cancels the actionable timer when a later attempt throws", async () => {
    const h = harness([retry("host-chain"), new Error("signing cancelled")])
    await expect(h.run).rejects.toThrow("signing cancelled")
    h.advance(70_000)
    expect(h.phases).not.toContain("host-chain")
  })

  it("does not surface while an in-flight attempt is stopping", async () => {
    let stopped = false
    let attempts = 0
    let release!: () => void
    const phases: SignupPhase[] = []
    const surfaced: ActionableRetryReason[] = []
    const timers: Array<() => void> = []
    const run = signupWithRetry({
      attempt: async () => {
        attempts += 1
        if (attempts === 1) return retry("host-chain")
        return new Promise((resolve) => (release = () => resolve({ kind: "landed" })))
      },
      windowOpen: async () => true,
      wait: async () => {},
      now: () => 0,
      stopped: () => stopped,
      startTimer: (_ms, fn) => {
        timers.push(fn)
        return () => void timers.splice(timers.indexOf(fn), 1)
      },
      onPhase: (phase) => phases.push(phase),
      onRetry: () => {},
      onErrorSurfaced: (reason) => surfaced.push(reason),
      onWire: () => {},
    })
    while (!release) await Promise.resolve()
    stopped = true
    for (const timer of [...timers]) timer()
    expect(phases).not.toContain("host-chain")
    expect(surfaced).toEqual([])
    release()
    await expect(run).resolves.toMatchObject({ end: "stopped" })
  })

  it("retains the actionable notice when a paused attempt resumes", async () => {
    let stopped = false
    let release!: () => void
    let attempts = 0
    const surfaced: ActionableRetryReason[] = []
    const timers: Array<{ ms: number; fn: () => void }> = []
    const run = signupWithRetry({
      attempt: async () => {
        attempts += 1
        if (attempts === 1) return retry("host-chain")
        return new Promise((resolve) => (release = () => resolve({ kind: "landed" })))
      },
      windowOpen: async () => true,
      wait: async () => {},
      now: () => 0,
      stopped: () => stopped,
      startTimer: (ms, fn) => {
        const timer = { ms, fn }
        timers.push(timer)
        return () => void timers.splice(timers.indexOf(timer), 1)
      },
      onPhase: () => {},
      onRetry: () => {},
      onErrorSurfaced: (reason) => surfaced.push(reason),
      onWire: () => {},
    })
    while (!release) await Promise.resolve()
    stopped = true
    timers.find((timer) => timer.ms === 60_000)!.fn()
    expect(surfaced).toEqual([])
    stopped = false
    timers.find((timer) => timer.ms === 1_000)!.fn()
    expect(surfaced).toEqual(["host-chain"])
    release()
    await run
  })

  it("surfaces one persistent failure while the next attempt is still blocked", async () => {
    let clock = 0
    let release!: () => void
    let attempts = 0
    const phases: SignupPhase[] = []
    const surfaced: ActionableRetryReason[] = []
    const timers: Array<{ at: number; fn: () => void }> = []
    const run = signupWithRetry({
      attempt: async () => {
        attempts += 1
        if (attempts === 1) return retry("host-chain")
        return new Promise((resolve) => (release = () => resolve({ kind: "landed" })))
      },
      windowOpen: async () => true,
      wait: async (_reason, ms) => void (clock += ms),
      now: () => clock,
      stopped: () => false,
      startTimer: (ms, fn) => {
        const timer = { at: clock + ms, fn }
        timers.push(timer)
        return () => void timers.splice(timers.indexOf(timer), 1)
      },
      onPhase: (phase) => phases.push(phase),
      onRetry: () => {},
      onErrorSurfaced: (reason) => surfaced.push(reason),
      onWire: () => {},
    })
    while (attempts < 2) await Promise.resolve()
    clock += 70_000
    for (const timer of [...timers].filter((candidate) => candidate.at <= clock)) timer.fn()
    release()
    await run
    expect(phases).toContain("host-chain")
    expect(surfaced).toEqual(["host-chain"])
  })

  it("does not surface either actionable reason when the failure keeps changing", async () => {
    const h = harness(Array.from({ length: 10 }, (_, i) => retry(i % 2 === 0 ? "network" : "host-chain")))
    await h.run
    expect(h.phases).not.toContain("network")
    expect(h.phases).not.toContain("host-chain")
  })

  it("does not announce or record a failure returned after the run stopped", async () => {
    let stopped = false
    let release!: () => void
    const phases: SignupPhase[] = []
    const retries: RetryReason[] = []
    const surfaced: ActionableRetryReason[] = []
    const run = signupWithRetry({
      attempt: () => new Promise((resolve) => (release = () => resolve(retry("network")))),
      windowOpen: async () => true,
      wait: async () => {},
      now: () => 70_000,
      stopped: () => stopped,
      startTimer: () => () => {},
      onPhase: (phase) => phases.push(phase),
      onRetry: ({ reason }) => retries.push(reason),
      onErrorSurfaced: (reason) => surfaced.push(reason),
      onWire: () => {},
    })
    while (!release) await Promise.resolve()
    stopped = true
    release()
    expect(await run).toMatchObject({ end: "stopped", attempts: 1 })
    expect(phases).toEqual(["sending", "idle"])
    expect(retries).toEqual([])
    expect(surfaced).toEqual([])
  })

  it("shows waiting-seat while it waits on the bind", async () => {
    const h = harness([retry("bind-pending")])
    await h.run
    expect(h.phases).toEqual(["sending", "waiting-seat", "idle"])
    expect(h.waits).toEqual([["bind-pending", 2000]])
  })

  it("shows waiting-seat while it waits on the name link, and keeps it for the next attempt", async () => {
    const h = harness([retry("name-pending"), retry("name-pending")])
    await h.run
    expect(h.phases).toEqual(["sending", "waiting-seat", "waiting-seat", "idle"])
    expect(h.waits).toEqual([["name-pending", 2000], ["name-pending", 4000]])
  })

  it("stops with closed when the registration window shuts, with no further attempt", async () => {
    const h = harness([retry("other"), retry("other"), retry("other")], { closeAfter: 2 })
    expect(await h.run).toMatchObject({ end: "closed", attempts: 2 })
    expect(h.attempts()).toBe(2)
    expect(h.phases[h.phases.length - 1]).toBe("closed")
  })

  // #582 (found by a model check): a closed window is no miss for a player
  // the chain already has
  it("ends registered, not closed, when the window shut behind a player who is in", async () => {
    const h = harness([retry("other"), retry("other"), retry("other")], { closeAfter: 2, inWhenClosed: true })
    expect(await h.run).toMatchObject({ end: "registered", attempts: 2 })
    expect(h.phases[h.phases.length - 1]).toBe("idle")
  })

  it("stops when told to", async () => {
    const h = harness([retry("other"), retry("other"), retry("other")], { stopAfter: 1 })
    expect(await h.run).toMatchObject({ end: "stopped", attempts: 1 })
    expect(h.phases[h.phases.length - 1]).toBe("idle")
  })

  it("ends registered when the chain already has the player", async () => {
    const h = harness([retry("tracking-lost"), { kind: "registered" }])
    expect(await h.run).toMatchObject({ end: "registered", attempts: 2 })
  })

  it("lets a final refusal through", async () => {
    const h = harness([retry("other"), new Error("Transaction signing was rejected.")])
    await expect(h.run).rejects.toThrow("signing was rejected")
  })
})

describe("a hung attempt on a host that lost the chain (#507)", () => {
  /** one attempt that never answers, a fake clock, and a scripted probe */
  function hung(
    verdicts: Array<"lost" | "healthy" | "timeout" | "unknown" | Error>,
    resolveWith?: AttemptResult,
    options: { paused?: () => boolean } = {},
  ) {
    const surfaced: string[] = []
    let clock = 0
    const timers: Array<{ at: number; fn: () => void }> = []
    const phases: Array<[SignupPhase, number]> = []
    let release!: () => void
    const probe = vi.fn(async () => {
      const next = verdicts.shift() ?? "unknown"
      if (next instanceof Error) throw next
      return next
    })
    const run = signupWithRetry({
      attempt: () => new Promise((resolve) => (release = () => resolve(resolveWith ?? { kind: "landed" }))),
      windowOpen: async () => true,
      wait: async () => {},
      now: () => clock,
      stopped: () => options.paused?.() ?? false,
      onErrorSurfaced: (reason) => surfaced.push(reason),
      startTimer: (ms, fn) => {
        const t = { at: clock + ms, fn }
        timers.push(t)
        return () => {
          const i = timers.indexOf(t)
          if (i >= 0) timers.splice(i, 1)
        }
      },
      onPhase: (phase) => phases.push([phase, clock]),
      onRetry: () => {},
      onWire: () => {},
      probeHostChain: probe,
    })
    const advance = async (ms: number) => {
      const target = clock + ms
      for (;;) {
        const next = timers.filter((t) => t.at <= target).sort((a, b) => a.at - b.at)[0]
        if (!next) break
        clock = next.at
        timers.splice(timers.indexOf(next), 1)
        next.fn()
        for (let i = 0; i < 5; i++) await Promise.resolve()
      }
      clock = target
    }
    return { run, phases, probe, advance, surfaced, release: () => release() }
  }
  const names = (h: { phases: Array<[SignupPhase, number]> }) => h.phases.map(([p]) => p)

  it("moves to host-chain at the slow threshold when the probe says the chain is lost", async () => {
    const h = hung(["lost"])
    await Promise.resolve()
    await h.advance(SLOW_AFTER_MS)
    expect(names(h)).toEqual(["sending", "slow", "host-chain"])
    expect(h.phases[2]![1]).toBe(SLOW_AFTER_MS)
    h.release()
    await h.run
  })

  it("stays slow when the host is healthy", async () => {
    const h = hung(["healthy", "healthy"])
    await Promise.resolve()
    await h.advance(SLOW_AFTER_MS + 30_000)
    expect(names(h)).toEqual(["sending", "slow"])
    expect(h.probe).toHaveBeenCalledTimes(3)
    h.release()
    await h.run
  })

  it("clears back to slow once a later probe is healthy", async () => {
    const h = hung(["lost", "healthy"])
    await Promise.resolve()
    await h.advance(SLOW_AFTER_MS + HOST_PROBE_EVERY_MS)
    expect(names(h)).toEqual(["sending", "slow", "host-chain", "slow"])
    h.release()
    await h.run
  })

  // #585 (found by a model check): one rule for the notice, whichever path
  // raised it. A healthy probe clears it, the probe's own "lost" or 60 s of
  // "host-chain" retries alike, and the next "host-chain" retry arms the
  // 60 s again.
  it("clears a retry-surfaced host-chain notice on a healthy probe", async () => {
    let clock = 0
    const timers: Array<{ at: number; fn: () => void }> = []
    const phases: Array<[SignupPhase, number]> = []
    const RECOVER_AT = 74_000
    const advance = async (ms: number) => {
      const target = clock + ms
      for (;;) {
        const next = timers.filter((t) => t.at <= target).sort((a, b) => a.at - b.at)[0]
        if (!next) break
        clock = next.at
        timers.splice(timers.indexOf(next), 1)
        next.fn()
        for (let i = 0; i < 5; i++) await Promise.resolve()
      }
      clock = target
    }
    void signupWithRetry({
      // every Players read fails until RECOVER_AT ("host-chain"); then one
      // attempt is in flight while the host is healthy
      attempt: () =>
        clock < RECOVER_AT
          ? Promise.resolve<AttemptResult>({ kind: "retry", reason: "host-chain" })
          : new Promise<AttemptResult>(() => {}),
      windowOpen: async () => true,
      wait: (_reason, ms) => advance(ms),
      now: () => clock,
      stopped: () => false,
      startTimer: (ms, fn) => {
        const t = { at: clock + ms, fn }
        timers.push(t)
        return () => {
          const i = timers.indexOf(t)
          if (i >= 0) timers.splice(i, 1)
        }
      },
      onPhase: (phase) => phases.push([phase, clock]),
      onRetry: () => {},
      onWire: () => {},
      probeHostChain: async () => (clock < RECOVER_AT ? "unknown" : "healthy"),
    })
    for (let i = 0; i < 50; i++) await Promise.resolve()
    await advance(60_000)
    // the notice came from the retry path: no probe ever said lost
    expect(phases.find(([phase]) => phase === "host-chain")?.[1]).toBeLessThan(RECOVER_AT)
    expect(clock).toBeGreaterThan(RECOVER_AT + HOST_PROBE_EVERY_MS)
    expect(phases[phases.length - 1]?.[0]).toBe("slow")
  })

  it("keeps the last phase when the probe gives no verdict", async () => {
    const h = hung(["lost", "unknown"])
    await Promise.resolve()
    await h.advance(SLOW_AFTER_MS + HOST_PROBE_EVERY_MS)
    expect(names(h)).toEqual(["sending", "slow", "host-chain"])
    h.release()
    await h.run
  })

  it("never probes or shows it for an attempt that resolves before the threshold", async () => {
    const h = hung(["lost"])
    await Promise.resolve()
    await h.advance(SLOW_AFTER_MS - 1)
    h.release()
    await h.run
    await h.advance(60_000)
    expect(h.probe).not.toHaveBeenCalled()
    expect(names(h)).toEqual(["sending", "idle"])
  })

  it("does not show it from a probe that returns after the attempt resolved", async () => {
    let resolveProbe!: (v: "lost") => void
    const phases: SignupPhase[] = []
    let fire!: () => void
    let release!: () => void
    const run = signupWithRetry({
      attempt: () => new Promise((resolve) => (release = () => resolve({ kind: "landed" }))),
      windowOpen: async () => true,
      wait: async () => {},
      now: () => 0,
      stopped: () => false,
      startTimer: (_ms, fn) => {
        fire ??= fn
        return () => {}
      },
      onPhase: (p) => phases.push(p),
      onRetry: () => {},
      onWire: () => {},
      probeHostChain: () => new Promise((resolve) => (resolveProbe = resolve)),
    })
    await Promise.resolve()
    await Promise.resolve()
    fire()
    release()
    await run
    resolveProbe("lost")
    await Promise.resolve()
    await Promise.resolve()
    expect(phases).toEqual(["sending", "slow", "idle"])
  })

  it("counts the notice once when it appears", async () => {
    const h = hung(["lost", "lost"])
    await Promise.resolve()
    await h.advance(SLOW_AFTER_MS + HOST_PROBE_EVERY_MS)
    expect(h.surfaced).toEqual(["host-chain"])
    h.release()
    await h.run
  })

  it("needs two timeouts in a row; one stays slow", async () => {
    const one = hung(["timeout", "healthy"])
    await Promise.resolve()
    await one.advance(SLOW_AFTER_MS + HOST_PROBE_EVERY_MS)
    expect(names(one)).toEqual(["sending", "slow"])
    expect(one.surfaced).toEqual([])
    one.release()
    await one.run
    const two = hung(["timeout", "timeout"])
    await Promise.resolve()
    await two.advance(SLOW_AFTER_MS + HOST_PROBE_EVERY_MS)
    expect(names(two)).toEqual(["sending", "slow", "host-chain"])
    two.release()
    await two.run
  })

  it("does not count timeouts that an unknown separates", async () => {
    const h = hung(["timeout", "unknown", "timeout"])
    await Promise.resolve()
    await h.advance(SLOW_AFTER_MS + 2 * HOST_PROBE_EVERY_MS)
    expect(names(h)).toEqual(["sending", "slow"])
    h.release()
    await h.run
  })

  it("stays slow on an unknown first probe and on a probe that throws", async () => {
    const h = hung(["unknown", new Error("boom")])
    await Promise.resolve()
    await h.advance(SLOW_AFTER_MS + HOST_PROBE_EVERY_MS)
    expect(names(h)).toEqual(["sending", "slow"])
    expect(h.probe).toHaveBeenCalledTimes(2)
    h.release()
    await h.run
  })

  it("clears a shown notice after a run of probes with no verdict", async () => {
    const h = hung(["lost", "unknown", "unknown", "unknown"])
    await Promise.resolve()
    await h.advance(SLOW_AFTER_MS + 3 * HOST_PROBE_EVERY_MS)
    expect(names(h)).toEqual(["sending", "slow", "host-chain", "slow"])
    h.release()
    await h.run
  })

  it("looks again after a pause instead of applying a verdict that returned while paused", async () => {
    let paused = false
    const h = hung(["lost", "lost"], undefined, { paused: () => paused })
    await Promise.resolve()
    paused = true
    await h.advance(SLOW_AFTER_MS)
    expect(names(h)).toEqual(["sending"])
    paused = false
    await h.advance(1_000)
    expect(h.probe).toHaveBeenCalledTimes(1)
    await h.advance(HOST_PROBE_EVERY_MS)
    expect(names(h)).toContain("host-chain")
    h.release()
    await h.run
  })
})
