// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, describe, expect, it, vi } from "vitest"
import { reduceChainHealthCard, reduceHostStuckEvidence, type ChainHealthCardState, type ChainHealthResult } from "./chain-health"

import {
  armPreGameChainHealthProbes,
  chainHealthElapsedNowMs,
  gateRoundLostReappearance,
  noteRoundLostClear,
  PRE_GAME_HEALTH_STOP_SECONDS,
  REGISTERED_HEALTH_FAST_MS,
  REGISTERED_HEALTH_SLOW_MS,
  REGISTERED_HEALTH_START_SECONDS,
  restartAdviceForLoss,
  turnProofTimeoutNeedsProbeNow,
} from "./use-chain-health-card"
import type { TurnOutcome } from "./webrtc/ice"

afterEach(() => vi.restoreAllMocks())

const HEALTHY: ChainHealthResult = { outcome: "healthy", latencyMs: 1 }
const TIMED_OUT: ChainHealthResult = {
  outcome: "unknown",
  latencyMs: 5000,
  errorClass: "timeout",
  error: "chain health probe timed out",
}

const LOST: ChainHealthResult = {
  outcome: "host-chain-lost",
  latencyMs: 5,
  errorClass: "cannot-get-current-block",
  error: "cannot get current block",
}

const TURN_PROOF_TIMEOUT = {
  received: "false",
  stage: "proof",
  cause: "timeout",
  reason: "turn/proof: no answer in 5000ms",
} as TurnOutcome

describe("TURN timeout chain-health probes", () => {
  it("does not let a backward wall-clock step suppress a due probe", () => {
    const monotonicNow = vi.spyOn(performance, "now").mockReturnValue(10_000)
    const wallNow = vi.spyOn(Date, "now").mockReturnValue(1_000_000)
    const lastHealthyAtMs = chainHealthElapsedNowMs()

    monotonicNow.mockReturnValue(40_001)
    wallNow.mockReturnValue(1)

    expect(turnProofTimeoutNeedsProbeNow(TURN_PROOF_TIMEOUT, lastHealthyAtMs)).toBe(true)
  })
})

describe("in-round chain-health bar recovery", () => {
  it("keeps one lost recheck clear after store evidence recovers the bar, then re-shows on two", () => {
    let card: ChainHealthCardState = { lost: true, reason: "chain-lost" }
    let gate = { afterRecovery: false, consecutiveLost: 0 }

    // noteHealthy turns successful signed-transaction/store evidence into the
    // same healthy result. The protection follows the actual lost -> clear
    // transition rather than depending on the probe that supplied it.
    const beforeRecovery = card
    const recovered = gateRoundLostReappearance(card, HEALTHY, "round", gate)
    gate = recovered.state
    card = reduceChainHealthCard(card, HEALTHY)
    gate = noteRoundLostClear(beforeRecovery, card, "round", gate)
    expect(card.lost).toBe(false)
    expect(gate).toEqual({ afterRecovery: true, consecutiveLost: 0 })

    const firstLost = gateRoundLostReappearance(card, LOST, "round", gate)
    gate = firstLost.state
    expect(firstLost.acceptForCard).toBe(false)
    if (firstLost.acceptForCard) card = reduceChainHealthCard(card, LOST)
    expect(card.lost).toBe(false)

    const secondLost = gateRoundLostReappearance(card, LOST, "round", gate)
    expect(secondLost.acceptForCard).toBe(true)
    if (secondLost.acceptForCard) card = reduceChainHealthCard(card, LOST)
    expect(card).toMatchObject({ lost: true, reason: "chain-lost" })
  })
})

describe("restart advice transitions", () => {
  it("records immediate advice when a silent host becomes a concrete chain loss", () => {
    expect(
      restartAdviceForLoss(
        { lost: true, reason: "host-unanswered" },
        LOST,
        "pre-game",
        true,
      ),
    ).toBe(true)
  })

  it("does not count an in-round silent-to-concrete transition as a second bar", () => {
    expect(
      restartAdviceForLoss(
        { lost: true, reason: "host-unanswered" },
        LOST,
        "round",
        true,
      ),
    ).toBe(false)
  })
})

describe("registered-player chain-health probes (#762)", () => {
  afterEach(() => vi.useRealTimers())

  function harness(options: {
    gameAt?: number
    waiting?: boolean
    hidden?: boolean
    probe?: () => Promise<ChainHealthResult | undefined>
  } = {}) {
    const gameAt = options.gameAt ?? 600
    let hidden = options.hidden ?? false
    let visibility: (() => void) | undefined
    const starts: Array<{ at: number; where: string }> = []
    const supplied = options.probe
    const probe = vi.fn(async (where: string) => {
      starts.push({ at: Date.now(), where })
      return supplied ? supplied() : HEALTHY
    })
    const stop = armPreGameChainHealthProbes({
      nowSeconds: () => Date.now() / 1000,
      gameAt,
      waiting: options.waiting ?? false,
      probe,
      hidden: () => hidden,
      onVisibility: (listener) => {
        visibility = listener
        return () => (visibility = undefined)
      },
    })
    return {
      probe,
      starts,
      stop,
      setHidden(value: boolean) {
        hidden = value
        visibility?.()
      },
    }
  }

  it("catches a host that hangs at T-10 min and shows the card before T-5 min", async () => {
    vi.useFakeTimers({ now: 0 })
    let evidence = { lastTimeoutAtMs: null as number | null }
    let card: ChainHealthCardState = { lost: false }
    const h = harness({
      probe: async () => {
        const promoted = reduceHostStuckEvidence(evidence, TIMED_OUT, Date.now())
        evidence = promoted.state
        card = reduceChainHealthCard(card, promoted.result)
        return promoted.result
      },
    })

    await vi.advanceTimersByTimeAsync(0)
    expect(card.lost).toBe(false)
    await vi.advanceTimersByTimeAsync(REGISTERED_HEALTH_FAST_MS)

    expect(h.starts.map(({ at }) => at)).toEqual([0, REGISTERED_HEALTH_FAST_MS])
    expect(card).toMatchObject({ lost: true, reason: "host-unanswered" })
    expect(h.starts[1].at).toBeLessThan((600 - 5 * 60) * 1000)
    h.stop()
  })

  it("runs each minute until T-5 min, then every 20 seconds", async () => {
    vi.useFakeTimers({ now: 0 })
    const h = harness()

    await vi.advanceTimersByTimeAsync(5 * REGISTERED_HEALTH_SLOW_MS)
    await vi.advanceTimersByTimeAsync(2 * REGISTERED_HEALTH_FAST_MS)

    expect(h.starts.map(({ at }) => at)).toEqual([
      0,
      60_000,
      120_000,
      180_000,
      240_000,
      300_000,
      320_000,
      340_000,
    ])
    expect(h.starts.every(({ where }) => where === "registered")).toBe(true)
    h.stop()
  })

  it("waits until T-15 min, labels waiting-room probes, and stops at T-30 s", async () => {
    vi.useFakeTimers({ now: 0 })
    const h = harness({ gameAt: 20 * 60, waiting: true })

    await vi.advanceTimersByTimeAsync((20 * 60 - REGISTERED_HEALTH_START_SECONDS) * 1000 - 1)
    expect(h.probe).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(h.starts[0]).toEqual({ at: 300_000, where: "waiting" })
    await vi.advanceTimersByTimeAsync((REGISTERED_HEALTH_START_SECONDS - PRE_GAME_HEALTH_STOP_SECONDS + 60) * 1000)
    expect(h.starts.at(-1)?.at).toBe(1_160_000)
    expect(h.starts.every(({ where }) => where === "waiting")).toBe(true)
    const stoppedAt = h.starts.length
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(h.starts).toHaveLength(stoppedAt)
    h.stop()
  })

  it("pauses a due probe while hidden and never overlaps a slow probe", async () => {
    vi.useFakeTimers({ now: 0 })
    let answer: (() => void) | undefined
    const h = harness({
      hidden: true,
      probe: () => new Promise<ChainHealthResult>((resolve) => (answer = () => resolve(HEALTHY))),
    })

    await vi.advanceTimersByTimeAsync(120_000)
    expect(h.probe).not.toHaveBeenCalled()
    h.setHidden(false)
    await vi.advanceTimersByTimeAsync(0)
    expect(h.probe).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(h.probe).toHaveBeenCalledOnce()
    answer?.()
    await vi.advanceTimersByTimeAsync(REGISTERED_HEALTH_SLOW_MS)
    expect(h.probe).toHaveBeenCalledTimes(2)
    h.stop()
  })
})
