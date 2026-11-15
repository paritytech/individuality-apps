// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it, vi } from "vitest"
import type { TurnOutcome } from "./webrtc/ice"
import { describeError } from "./host/error-detail"
import { classifyHostFailure } from "@individuality/people-chain"
import {
  acceptChainHealthResult,
  chainHealthCardVisible,
  CHAIN_HEALTH_TIMEOUT_MS,
  confirmTurnProofTimeoutWithProbe,
  consumeTurnChainHealthResult,
  nextChainHealthOrder,
  reduceChainHealthCard,
  reduceHostStuckEvidence,
  runChainHealthProbe,
  shouldWaitForReconnect,
  signupHostChainVerdict,
  type ChainHealthCardState,
  turnProofTimeoutNeedsProbe,
  turnProofChainHealthResult,
} from "./chain-health"

describe("host chain health", () => {
  it("routes a known TURN proof-chain refusal through the same restart-card result", () => {
    expect(
      turnProofChainHealthResult({
        received: "false",
        stage: "proof-chain",
        reason: "no proof: CannotGetCurrentBlock { reason: Rpc(SubscriptionDropped) }",
      }),
    ).toMatchObject({ outcome: "host-chain-lost", errorClass: "cannot-get-current-block" })
    expect(
      turnProofChainHealthResult({ received: "false", stage: "proof", reason: "user refused" }),
    ).toBeNull()
    expect(turnProofChainHealthResult({ received: "cached", ttlLeftS: 1200 })).toBeNull()
    expect(turnProofChainHealthResult({ received: "true", ttlLeftS: 1800 }, 7)).toEqual({
      outcome: "healthy",
      latencyMs: 0,
      order: 7,
    })
    expect(
      turnProofChainHealthResult(
        { received: "false", stage: "issue", reason: "issuer unavailable" },
        8,
      ),
    ).toEqual({ outcome: "healthy", latencyMs: 0, order: 8 })
    expect(
      turnProofChainHealthResult({
        received: "false",
        stage: "issue",
        reason: "no credentials after 8 s",
        cause: "timeout",
      }),
    ).toBeNull()
    expect(
      turnProofChainHealthResult({
        received: "false",
        stage: "proof",
        reason: "turn/proof: no answer in 5000ms",
        cause: "timeout",
      }),
    ).toBeNull()
  })

  it("ignores a TURN proof timeout after recent health and otherwise requires a probe timeout", () => {
    const turnTimeout = {
      received: "false" as const,
      stage: "proof" as const,
      reason: "turn/proof: no answer in 5000ms",
      cause: "timeout" as const,
    }
    expect(turnProofTimeoutNeedsProbe(turnTimeout, 1_000, 4_000)).toBe(false)
    expect(turnProofTimeoutNeedsProbe(turnTimeout, 1_000, 31_000)).toBe(false)
    expect(turnProofTimeoutNeedsProbe(turnTimeout, 1_000, 31_001)).toBe(true)
    expect(turnProofTimeoutNeedsProbe(turnTimeout, null, 4_000)).toBe(true)

    const timedOutProbe = {
      outcome: "unknown" as const,
      latencyMs: 5_000,
      errorClass: "timeout" as const,
      error: "chain health probe timed out",
    }
    expect(confirmTurnProofTimeoutWithProbe(timedOutProbe)).toMatchObject({
      outcome: "host-chain-lost",
      errorClass: "timeout",
    })
    expect(confirmTurnProofTimeoutWithProbe({ outcome: "healthy", latencyMs: 4 })).toEqual({
      outcome: "healthy",
      latencyMs: 4,
    })
  })

  it("promotes only two nearby consecutive probe timeouts and resets on health", () => {
    const timeout = {
      outcome: "unknown" as const,
      latencyMs: 5000,
      errorClass: "timeout" as const,
      error: "chain health probe timed out",
    }
    const first = reduceHostStuckEvidence({ lastTimeoutAtMs: null }, timeout, 1_000)
    expect(first.result.outcome).toBe("unknown")
    const healthy = reduceHostStuckEvidence(first.state, { outcome: "healthy", latencyMs: 2 }, 2_000)
    expect(healthy.state.lastTimeoutAtMs).toBeNull()
    const afterHealth = reduceHostStuckEvidence(healthy.state, timeout, 3_000)
    expect(afterHealth.result.outcome).toBe("unknown")
    const promoted = reduceHostStuckEvidence(afterHealth.state, timeout, 8_000)
    expect(promoted.result).toMatchObject({ outcome: "host-chain-lost", errorClass: "timeout" })
    const stale = reduceHostStuckEvidence({ lastTimeoutAtMs: 1_000 }, timeout, 40_000)
    expect(stale.result.outcome).toBe("unknown")
  })

  it("does not count a link interruption as a missed answer", () => {
    const timeout = {
      outcome: "unknown" as const,
      latencyMs: 5000,
      errorClass: "timeout" as const,
      error: "chain health probe timed out",
    }
    const interrupted = {
      outcome: "unknown" as const,
      latencyMs: 4000,
      errorClass: "host-interrupted" as const,
      error: "The host channel was interrupted (the app likely resumed). <- TrUAPI host connection interrupted",
    }
    const first = reduceHostStuckEvidence({ lastTimeoutAtMs: null }, timeout, 1_000)
    const afterInterruption = reduceHostStuckEvidence(first.state, interrupted, 2_000)
    expect(afterInterruption).toEqual({ state: { lastTimeoutAtMs: null }, result: interrupted })
    expect(reduceHostStuckEvidence(afterInterruption.state, timeout, 3_000).result).toEqual(timeout)
  })

  it("consumes replay once and rejects an older async success", () => {
    const oldSuccessOrder = nextChainHealthOrder()
    const lossOrder = nextChainHealthOrder()
    const outcome = {
      received: "false",
      stage: "proof-chain",
      reason: "CannotGetCurrentBlock: subscription dropped",
    } satisfies TurnOutcome
    const loss = consumeTurnChainHealthResult(outcome, lossOrder)!
    expect(acceptChainHealthResult(loss)).toBe(true)

    const healthy = {
      outcome: "healthy" as const,
      latencyMs: 0,
      order: nextChainHealthOrder(),
    }
    expect(acceptChainHealthResult(healthy)).toBe(true)
    expect(consumeTurnChainHealthResult(outcome, lossOrder)).toBeNull()
    expect(
      acceptChainHealthResult({ outcome: "healthy", latencyMs: 0, order: oldSuccessOrder }),
    ).toBe(false)
  })

  it("measures a no-submit build and reports a known host loss", async () => {
    const ticks = [10, 37]
    const result = await runChainHealthProbe(
      async () => {
        throw new Error("cannot get the current block: subscription dropped")
      },
      () => ticks.shift()!,
    )
    expect(result).toMatchObject({
      outcome: "host-chain-lost",
      latencyMs: 27,
      errorClass: "cannot-get-current-block",
    })
  })

  it("classes a host link interruption apart and keeps the probe diagnostic", async () => {
    const reset = Object.assign(new Error("TrUAPI host connection interrupted"), { name: "ConnectionResetError" })
    const wrapped = new Error(
      "Could not process the host's response to createTransaction failed: TrUAPI host connection interrupted. The usual cause is a protocol-version skew between the host app and the @parity/truapi version this product is built against; a host channel that closed mid-call looks the same.",
      { cause: reset },
    )
    expect([reset, wrapped, describeError(wrapped)].map((error) => classifyHostFailure(error))).toEqual([
      "host-interrupted",
      "host-interrupted",
      "host-interrupted",
    ])
    await expect(
      runChainHealthProbe(async () => {
        throw wrapped
      }),
    ).resolves.toMatchObject({ outcome: "unknown", errorClass: "host-interrupted" })
  })

  it("leaves a thrown timeout text out of the stuck-host count", async () => {
    const probe = () =>
      runChainHealthProbe(async () => {
        throw new Error("RPC error: Request timeout")
      })
    const first = await probe()
    expect(first).toMatchObject({ outcome: "unknown", errorClass: "unknown" })

    const once = reduceHostStuckEvidence({ lastTimeoutAtMs: null }, first, 1_000)
    const twice = reduceHostStuckEvidence(once.state, await probe(), 2_000)
    expect(twice.result).toMatchObject({ outcome: "unknown", errorClass: "unknown" })
  })

  it("records a closed socket as network and keeps the probe diagnostic", async () => {
    await expect(
      runChainHealthProbe(async () => {
        throw new Error("WebSocket connection closed")
      }),
    ).resolves.toMatchObject({ outcome: "unknown", errorClass: "network" })
  })

  it.each([
    "HostRejectedError: Host rejected the request",
    "createTransaction failed: Rejected",
    "Transaction signing was rejected.",
    "createTransaction failed: user rejected the confirmation",
  ])("reads %s as a declined probe", async (message) => {
    const result = await runChainHealthProbe(async () => {
      throw new Error(message)
    })
    expect(result).toMatchObject({ outcome: "declined", error: message })
    expect(result).not.toHaveProperty("errorClass")
  })

  it("bounds a hung host build as diagnostic-only", async () => {
    vi.useFakeTimers()
    try {
      const pending = runChainHealthProbe(() => new Promise(() => {}))
      await vi.advanceTimersByTimeAsync(CHAIN_HEALTH_TIMEOUT_MS)
      await expect(pending).resolves.toMatchObject({
        outcome: "unknown",
        errorClass: "timeout",
        error: "chain health probe timed out",
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it("shows before the game, clears on the next success, and never shows in a round", () => {
    const lost = reduceChainHealthCard(
      { lost: false },
      {
        outcome: "host-chain-lost",
        latencyMs: 4,
        errorClass: "subscription-dropped",
        error: "subscription dropped",
      },
    )
    expect(chainHealthCardVisible(lost, "pre-game")).toBe(true)
    expect(lost.reason).toBe("chain-lost")
    expect(chainHealthCardVisible(lost, "round")).toBe(false)
    expect(chainHealthCardVisible(lost, "post-game")).toBe(false)

    const recovered = reduceChainHealthCard(lost, { outcome: "healthy", latencyMs: 3 })
    expect(chainHealthCardVisible(recovered, "pre-game")).toBe(false)
    expect(recovered.answering).toBe(true)

    const unknown = reduceChainHealthCard(lost, {
      outcome: "unknown",
      latencyMs: 5000,
      errorClass: "unknown",
      error: "chain health probe timed out",
    })
    expect(chainHealthCardVisible(unknown, "pre-game")).toBe(true)
    const declined = reduceChainHealthCard(lost, { outcome: "declined", latencyMs: 2, error: "not now" })
    expect(chainHealthCardVisible(declined, "pre-game")).toBe(true)

    const unanswered = reduceChainHealthCard(
      { lost: false },
      {
        outcome: "host-chain-lost",
        latencyMs: 5000,
        errorClass: "timeout",
        error: "two chain health probes timed out in a row",
      },
    )
    expect(unanswered).toEqual({ lost: true, reason: "host-unanswered" })
  })

  it("keeps a concrete chain loss sticky when its recheck only times out", () => {
    const concrete: ChainHealthCardState = { lost: true, reason: "chain-lost" }
    expect(
      reduceChainHealthCard(concrete, {
        outcome: "host-chain-lost",
        latencyMs: 5000,
        errorClass: "timeout",
        error: "recheck timed out",
      }),
    ).toEqual(concrete)
  })

  it("uses one eligibility rule for first-open silence and repeated-open escalation", () => {
    expect(shouldWaitForReconnect("host-unanswered", 1)).toBe(true)
    expect(shouldWaitForReconnect("read-unanswered", 1)).toBe(true)
    expect(shouldWaitForReconnect("chain-lost", 1)).toBe(false)
    expect(shouldWaitForReconnect("host-unanswered", 2)).toBe(false)
  })

  it("waits out any loss right after a return from the background", () => {
    expect(shouldWaitForReconnect("chain-lost", 1, "card", true)).toBe(true)
    expect(shouldWaitForReconnect("chain-lost", 2, "card", true)).toBe(true)
    expect(shouldWaitForReconnect(undefined, 0, "card", true)).toBe(false)
  })
})

describe("signupHostChainVerdict", () => {
  it("maps a result to what the sign-up may act on, without reading error text", () => {
    expect(signupHostChainVerdict({ outcome: "healthy", latencyMs: 1 })).toBe("healthy")
    expect(
      signupHostChainVerdict({ outcome: "host-chain-lost", latencyMs: 1, errorClass: "subscription-dropped", error: "x" }),
    ).toBe("lost")
    expect(signupHostChainVerdict({ outcome: "unknown", latencyMs: 1, errorClass: "timeout", error: "nope" })).toBe("timeout")
    expect(signupHostChainVerdict({ outcome: "unknown", latencyMs: 1, errorClass: "unknown", error: "timed out" })).toBe("unknown")
    expect(signupHostChainVerdict({ outcome: "unknown", latencyMs: 1, errorClass: "host-interrupted", error: "x" })).toBe("unknown")
    expect(signupHostChainVerdict({ outcome: "declined", latencyMs: 1, error: "x" })).toBe("unknown")
  })
})
