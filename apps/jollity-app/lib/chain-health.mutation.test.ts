// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, describe, expect, it, vi } from "vitest"
import { classifyHostFailure } from "@individuality/people-chain"
import {
  armChainLostRecheck,
  chestRestartCardCopy,
  confirmTurnProofTimeoutWithProbe,
  isTurnCredentialTimeout,
  reduceHostStuckEvidence,
  restartCardCopy,
  runChainHealthProbe,
  shouldWaitForReconnect,
  signupHostChainVerdict,
  turnProofChainHealthResult,
  turnProofTimeoutNeedsProbe,
} from "./chain-health"
import { HEALTHY, TIMED_OUT } from "./chain-health-fixtures"

const proofTimeout = {
  received: "false",
  stage: "proof",
  cause: "timeout",
  reason: "turn/proof: no answer in 5000ms",
} as const

afterEach(() => vi.useRealTimers())

describe("chain-health pure helpers, pinned for mutation testing", () => {
  it("recognises a TURN proof timeout only when every part matches", () => {
    expect(isTurnCredentialTimeout(proofTimeout)).toBe(true)
    expect(isTurnCredentialTimeout({ ...proofTimeout, stage: "issue" })).toBe(false)
    expect(isTurnCredentialTimeout({ ...proofTimeout, cause: "refused" } as never)).toBe(false)
    expect(isTurnCredentialTimeout({ ...proofTimeout, reason: "turn/proof: refused" })).toBe(false)
    expect(isTurnCredentialTimeout({ received: "true" } as never)).toBe(false)
    expect(isTurnCredentialTimeout({ received: "cached", ttlLeftS: 5 } as never)).toBe(false)
  })

  it("asks for a probe on a TURN timeout unless the host answered within 30 s", () => {
    expect(turnProofTimeoutNeedsProbe({ received: "true" } as never, null, 0)).toBe(false)
    expect(turnProofTimeoutNeedsProbe(proofTimeout, null, 0)).toBe(true)
    expect(turnProofTimeoutNeedsProbe(proofTimeout, 0, 30_000)).toBe(false)
    expect(turnProofTimeoutNeedsProbe(proofTimeout, 0, 30_001)).toBe(true)
  })

  it("confirms only a timed-out unknown probe, with the TURN wording", () => {
    expect(confirmTurnProofTimeoutWithProbe(TIMED_OUT)).toMatchObject({
      outcome: "host-chain-lost",
      errorClass: "timeout",
      error: "TURN proof and chain health probe timed out",
    })
    const other = { outcome: "unknown", latencyMs: 1, errorClass: "unknown", error: "e" } as const
    expect(confirmTurnProofTimeoutWithProbe(other)).toBe(other)
    const lostTimeout = { outcome: "host-chain-lost", latencyMs: 1, errorClass: "timeout", error: "e" } as const
    expect(confirmTurnProofTimeoutWithProbe(lostTimeout)).toBe(lostTimeout)
    const unknownBlock = { outcome: "unknown", latencyMs: 1, errorClass: "cannot-get-current-block", error: "e" } as const
    expect(confirmTurnProofTimeoutWithProbe(unknownBlock)).toBe(unknownBlock)
  })

  it("names the two classes of lost chain apart", () => {
    expect(classifyHostFailure(new Error("RPC error: subscription dropped"))).toBe("subscription-dropped")
    expect(classifyHostFailure(new Error("cannot get the current block"))).toBe("cannot-get-current-block")
    expect(classifyHostFailure(new Error("subscription dropped, CannotGetCurrentBlock"))).toBe("cannot-get-current-block")
  })

  it("turns a TURN outcome into the card contract", () => {
    const refused = { received: "false", stage: "proof-chain", reason: "no proof: CannotGetCurrentBlock" } as const
    expect(turnProofChainHealthResult(refused, 4)).toEqual({
      outcome: "host-chain-lost",
      latencyMs: 0,
      errorClass: "cannot-get-current-block",
      error: "no proof: CannotGetCurrentBlock",
      order: 4,
    })
    expect(turnProofChainHealthResult(refused)).not.toHaveProperty("order")
    expect(turnProofChainHealthResult({ received: "false", stage: "proof-chain" } as never)).toMatchObject({
      error: "TURN proof failed after the host chain was lost",
      errorClass: "unknown",
    })
    expect(turnProofChainHealthResult({ ...refused, reason: "weird" })).toMatchObject({ outcome: "host-chain-lost", errorClass: "unknown" })
    // healthy evidence needs an order and an issued or issue-stage outcome
    expect(turnProofChainHealthResult({ received: "true" } as never, 2)).toEqual({ outcome: "healthy", latencyMs: 0, order: 2 })
    expect(turnProofChainHealthResult({ received: "false", stage: "issue" } as never, 2)).toMatchObject({ outcome: "healthy" })
    expect(turnProofChainHealthResult({ received: "false", stage: "issue" } as never)).toBeNull()
    expect(turnProofChainHealthResult({ received: "true" } as never)).toBeNull()
    expect(turnProofChainHealthResult({ received: "false", stage: "proof", reason: "x" } as never, 2)).toBeNull()
    expect(turnProofChainHealthResult({ received: "cached", ttlLeftS: 1 } as never, 2)).toBeNull()
    // a timed-out proof is ambiguous, with or without an order
    expect(turnProofChainHealthResult(proofTimeout, 2)).toBeNull()
    expect(turnProofChainHealthResult({ ...proofTimeout, stage: "proof-chain" } as never, 2)).toMatchObject({ outcome: "host-chain-lost" })
  })

  it("words the promoted double timeout", () => {
    const next = reduceHostStuckEvidence({ lastTimeoutAtMs: 0 }, TIMED_OUT, 1000)
    expect(next.result).toMatchObject({ outcome: "host-chain-lost", error: "two chain health probes timed out in a row" })
  })

  it("lets the sign-up act on a plain unknown failure as unknown", () => {
    expect(signupHostChainVerdict({ outcome: "unknown", latencyMs: 1, errorClass: "unknown", error: "e" })).toBe("unknown")
    expect(signupHostChainVerdict({ outcome: "declined", latencyMs: 1, error: "e" })).toBe("unknown")
  })
})

describe("runChainHealthProbe, pinned for mutation testing", () => {
  const clock = (...values: number[]) => {
    const queue = [...values]
    return () => queue.shift() ?? 0
  }

  it("reports healthy with the measured latency", async () => {
    const result = await runChainHealthProbe(async () => {}, clock(100, 142))
    expect(result).toMatchObject({ outcome: "healthy", latencyMs: 42 })
    expect(result.order).toBeGreaterThan(0)
  })

  it("never reports a negative latency", async () => {
    const result = await runChainHealthProbe(async () => {}, clock(100, 90))
    expect(result.latencyMs).toBe(0)
  })

  it("reads its default clock", async () => {
    const result = await runChainHealthProbe(async () => {})
    expect(result.latencyMs).toBeGreaterThanOrEqual(0)
    expect(Number.isFinite(result.latencyMs)).toBe(true)
  })

  it("names a lost chain and an unknown failure apart, with a latency", async () => {
    const lost = await runChainHealthProbe(async () => { throw new Error("cannot get the current block") }, clock(10, 25))
    expect(lost).toMatchObject({ outcome: "host-chain-lost", latencyMs: 15, errorClass: "cannot-get-current-block" })
    const unknown = await runChainHealthProbe(async () => { throw new Error("nope") }, clock(10, 25))
    expect(unknown).toMatchObject({ outcome: "unknown", latencyMs: 15, errorClass: "unknown" })
    const never = await runChainHealthProbe(async () => { throw new Error("nope") }, clock(30, 5))
    expect(never.latencyMs).toBe(0)
  })

  it("names a declined signing with a latency and an order", async () => {
    const declined = await runChainHealthProbe(async () => { throw new Error("createTransaction failed: Rejected") }, clock(10, 25))
    expect(declined).toMatchObject({ outcome: "declined", latencyMs: 15, error: "createTransaction failed: Rejected" })
    expect(declined.order).toBeGreaterThan(0)
    const never = await runChainHealthProbe(async () => { throw new Error("createTransaction failed: Rejected") }, clock(30, 5))
    expect(never.latencyMs).toBe(0)
  })

  it("names a host that does not answer within the bound", async () => {
    vi.useFakeTimers()
    const pending = runChainHealthProbe(() => new Promise<void>(() => {}), clock(0, 5000))
    await vi.advanceTimersByTimeAsync(5000)
    expect(await pending).toMatchObject({ outcome: "unknown", errorClass: "timeout", latencyMs: 5000, error: "chain health probe timed out" })
    const negative = runChainHealthProbe(() => new Promise<void>(() => {}), clock(9000, 5000))
    await vi.advanceTimersByTimeAsync(5000)
    expect((await negative).latencyMs).toBe(0)
  })
})

describe("the restart card's words and gate, pinned for mutation testing", () => {
  it("decides who waits for a reconnect", () => {
    expect(shouldWaitForReconnect(undefined, 0)).toBe(false)
    expect(shouldWaitForReconnect(undefined, 0, "bar")).toBe(false)
    expect(shouldWaitForReconnect("chain-lost", 0)).toBe(false)
    expect(shouldWaitForReconnect("chain-lost", 0, "card")).toBe(false)
    expect(shouldWaitForReconnect("chain-lost", 0, "bar")).toBe(true)
    expect(shouldWaitForReconnect("host-unanswered", 0)).toBe(true)
    expect(shouldWaitForReconnect("read-unanswered", 1)).toBe(true)
    expect(shouldWaitForReconnect("host-unanswered", 2)).toBe(false)
    expect(shouldWaitForReconnect("chain-lost", 2, "bar")).toBe(false)
  })

  it("says what each reason means, restart first", () => {
    expect(restartCardCopy("host-unanswered", 0, "")).toEqual({
      eyebrow: "No answer",
      heading: "Restart the Polkadot app",
      body: "Your Polkadot app is not answering. Close it fully (swipe it away) and open it again. Your place in the game is kept.",
      escalated: false,
    })
    expect(restartCardCopy("chain-lost", 0, "")).toEqual({
      eyebrow: "Connection lost",
      heading: "Restart the Polkadot app",
      body: "Your Polkadot app lost its connection to the network. Close it fully (swipe it away) and open it again. Your place in the game is kept.",
      escalated: false,
    })
    expect(restartCardCopy("host-unanswered", 0, "", true)).toMatchObject({ eyebrow: "Reconnecting…", heading: "Getting the connection back" })
    expect(restartCardCopy("chain-lost", 0, "", true).eyebrow).toBe("Reconnecting…")
    expect(restartCardCopy("chain-lost", 2, " 5s").escalated).toBe(true)
    expect(chestRestartCardCopy()).toMatchObject({
      eyebrow: "No answer",
      heading: "Restart the Polkadot app",
      body: "Your Polkadot app is not answering. Close it fully (swipe it away) and open it again. Your chest and collectables are kept.",
    })
    expect(chestRestartCardCopy(true).heading).toBe("Getting the connection back")
  })
})

describe("armChainLostRecheck, pinned for mutation testing", () => {
  function arm(probe: () => Promise<typeof HEALTHY | undefined>, isHidden = () => false) {
    const listeners: (() => void)[] = []
    const unsubscribe = vi.fn()
    const stop = armChainLostRecheck({
      probe,
      hidden: isHidden,
      onVisibility: (listener) => {
        listeners.push(listener)
        return unsubscribe
      },
    })
    return { stop, unsubscribe, show: () => listeners.forEach((l) => l()) }
  }

  it("re-checks after 5 s, doubling to a 30 s cap, and waits 30 s after a timeout", async () => {
    vi.useFakeTimers()
    const results = [HEALTHY, HEALTHY, HEALTHY, HEALTHY, TIMED_OUT, undefined, HEALTHY]
    const probe = vi.fn(async () => results[probe.mock.calls.length - 1])
    arm(probe)
    await vi.advanceTimersByTimeAsync(4999)
    expect(probe).toHaveBeenCalledTimes(0)
    await vi.advanceTimersByTimeAsync(1) // 5 s
    expect(probe).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(10_000) // then 10 s
    expect(probe).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(20_000) // then 20 s
    expect(probe).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(30_000) // then the cap
    expect(probe).toHaveBeenCalledTimes(4)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(probe).toHaveBeenCalledTimes(5) // returns a timeout
    await vi.advanceTimersByTimeAsync(29_999)
    expect(probe).toHaveBeenCalledTimes(5)
    await vi.advanceTimersByTimeAsync(1) // 30 s after a timeout, not the doubled one
    expect(probe).toHaveBeenCalledTimes(6) // returns undefined
    await vi.advanceTimersByTimeAsync(30_000)
    expect(probe).toHaveBeenCalledTimes(7)
  })

  it("does not read an unknown non-timeout failure as a timeout", async () => {
    vi.useFakeTimers()
    const other = { outcome: "unknown", latencyMs: 1, errorClass: "unknown", error: "e" } as never
    const probe = vi.fn(async () => other)
    arm(probe)
    await vi.advanceTimersByTimeAsync(5000)
    expect(probe).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(10_000) // the doubled delay, not the 30 s cap
    expect(probe).toHaveBeenCalledTimes(2)
  })

  it("waits for the page to show when a re-check falls due while hidden", async () => {
    vi.useFakeTimers()
    let hidden = true
    const probe = vi.fn(async () => HEALTHY)
    const { show } = arm(probe, () => hidden)
    show() // nothing due yet
    expect(probe).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(5000)
    expect(probe).not.toHaveBeenCalled()
    show() // still hidden
    expect(probe).not.toHaveBeenCalled()
    hidden = false
    show()
    expect(probe).toHaveBeenCalledTimes(1)
    show() // the due flag is spent
    expect(probe).toHaveBeenCalledTimes(1)
  })

  it("ignores a visibility change while nothing is due", () => {
    vi.useFakeTimers()
    const probe = vi.fn(async () => HEALTHY)
    const { show } = arm(probe)
    show()
    expect(probe).not.toHaveBeenCalled()
  })

  it("stops cleanly: no timer, no subscription, no re-arm from a pending probe", async () => {
    vi.useFakeTimers()
    const probe = vi.fn(async () => HEALTHY)
    const first = arm(probe)
    first.stop()
    expect(first.unsubscribe).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(probe).not.toHaveBeenCalled()

    let settle: (value: typeof HEALTHY) => void = () => {}
    const slow = vi.fn(() => new Promise<typeof HEALTHY>((resolve) => { settle = resolve }))
    const second = arm(slow)
    await vi.advanceTimersByTimeAsync(5000)
    expect(slow).toHaveBeenCalledTimes(1)
    second.stop()
    settle(HEALTHY)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(slow).toHaveBeenCalledTimes(1)
  })
})
