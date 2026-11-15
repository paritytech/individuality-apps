// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, describe, expect, it, vi } from "vitest"

// A minimal hook runner: no DOM here, so React's three hooks are stood in for
// by a renderer that runs changed effects after each render, the way React
// commits them, and re-renders on a state change.
const runner = vi.hoisted(() => {
  type Effect = { deps?: unknown[]; cleanup?: void | (() => void) }
  const slots: unknown[] = []
  const effects: Effect[] = []
  const pending: Array<() => void> = []
  let cursor = 0
  let rerender: () => void = () => {}
  const changed = (a?: unknown[], b?: unknown[]) =>
    !a || !b || a.length !== b.length || a.some((value, i) => !Object.is(value, b[i]))
  return {
    useState<T>(initial: T) {
      const i = cursor++
      if (!(i in slots)) slots[i] = initial
      const set = (next: T) => {
        if (Object.is(slots[i], next)) return
        slots[i] = next
        rerender()
      }
      return [slots[i] as T, set] as const
    },
    useRef<T>(initial: T) {
      const i = cursor++
      if (!(i in slots)) slots[i] = { current: initial }
      return slots[i] as { current: T }
    },
    useEffect(effect: () => void | (() => void), deps?: unknown[]) {
      const i = cursor++
      const previous = effects[i]
      if (previous && !changed(previous.deps, deps)) return
      pending.push(() => {
        if (typeof previous?.cleanup === "function") previous.cleanup()
        effects[i] = { deps, cleanup: effect() }
      })
    },
    mount<P, R>(hook: (props: P) => R, props: P) {
      let current = props
      let result!: R
      rerender = () => {
        cursor = 0
        result = hook(current)
        const run = pending.splice(0)
        for (const commit of run) commit()
      }
      rerender()
      return {
        result: () => result,
        update(next: P) {
          current = next
          rerender()
        },
      }
    },
    reset() {
      slots.length = 0
      effects.length = 0
      pending.length = 0
    },
  }
})

vi.mock("react", () => ({
  useState: runner.useState,
  useRef: runner.useRef,
  useEffect: runner.useEffect,
  useCallback: <T>(callback: T) => callback,
}))
vi.mock("./telemetry", () => ({ recordCount: vi.fn(), recordDistribution: vi.fn() }))
vi.mock("./chain-restart", () => ({ recordRestartCardShown: vi.fn(async () => undefined) }))

import {
  RECONNECTING_BEFORE_RESTART_MS,
  reduceHostStuckEvidence,
  resetHostStuckEvidenceOnReturn,
  restartCardCopy,
  chainHealthCardAfterReturn,
  type ChainHealthCardState,
  type ChainHealthResult,
  type RestartCardReason,
} from "./chain-health"
import { recordRestartCardShown } from "./chain-restart"
import { lastBackgroundReturnAtMs } from "./background-return"
import { reportPageActivity } from "./page-lifecycle"
import { chainHealthCardStep } from "./use-chain-health-card"
import { useReconnectWindow } from "./use-reconnect-window"

/** the round's bar as /game wires it: armed while the host is stuck and the
 *  player's own network is up */
interface Round {
  hostStuck: boolean
  isolated: boolean
  reason?: RestartCardReason
}
const useRoundBar = ({ hostStuck, isolated, reason = "host-unanswered" }: Round) =>
  useReconnectWindow({
    visible: hostStuck && !isolated,
    reason,
    consecutiveLost: 0,
    healthy: false,
    where: "recheck",
    surface: "bar",
  })

describe("the in-round stuck bar's minute", () => {
  afterEach(() => {
    vi.useRealTimers()
    runner.reset()
  })

  it("reads Reconnecting for under a minute of stuckness and the restart advice after it", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] })
    const view = runner.mount(useRoundBar, { hostStuck: true, isolated: false })
    expect(view.result()).toBe(true)
    await vi.advanceTimersByTimeAsync(RECONNECTING_BEFORE_RESTART_MS - 1)
    expect(view.result()).toBe(true)
    await vi.advanceTimersByTimeAsync(1)
    expect(view.result()).toBe(false)
    // the bar persists no restart marker: only the blocking card does
    expect(recordRestartCardShown).not.toHaveBeenCalled()
  })

  it("restarts the minute from zero when the player's network comes back", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] })
    const view = runner.mount(useRoundBar, { hostStuck: true, isolated: false })
    await vi.advanceTimersByTimeAsync(50_000)
    view.update({ hostStuck: true, isolated: true }) // the network drops
    await vi.advanceTimersByTimeAsync(2 * RECONNECTING_BEFORE_RESTART_MS)
    view.update({ hostStuck: true, isolated: false }) // and comes back, host still marked stuck
    expect(view.result()).toBe(true)
    await vi.advanceTimersByTimeAsync(RECONNECTING_BEFORE_RESTART_MS - 1)
    expect(view.result()).toBe(true)
    await vi.advanceTimersByTimeAsync(1)
    expect(view.result()).toBe(false)
  })

  it("waits out a network switch's chain loss too", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] })
    const view = runner.mount(useRoundBar, { hostStuck: true, isolated: false, reason: "chain-lost" })
    expect(view.result()).toBe(true)
  })
})

/** The registered home's restart card as app/page.tsx wires it to the card
 * the chain-health hook keeps. */
const useHomeCard = ({ card, consecutiveLost }: { card: ChainHealthCardState; consecutiveLost: number }) =>
  useReconnectWindow({
    visible: card.lost,
    reason: card.reason,
    consecutiveLost,
    healthy: card.answering === true,
    where: "registered",
    since: card.reconnectingSince,
  })

const DROPPED: ChainHealthResult = {
  outcome: "host-chain-lost",
  latencyMs: 40,
  errorClass: "subscription-dropped",
  error: "subscription dropped",
  consecutiveLost: 1,
}
const PROBE_HEALTHY: ChainHealthResult = { outcome: "healthy", latencyMs: 300, consecutiveLost: 0 }
const PROBE_TIMEOUT: ChainHealthResult = {
  outcome: "unknown",
  latencyMs: 5000,
  errorClass: "timeout",
  error: "chain health probe timed out",
}
const RESTART_HEADING = "Restart the Polkadot app"

/** one probe result through the hook's own card step, at the current time */
const applyProbe = (previous: ChainHealthCardState, result: ChainHealthResult) =>
  chainHealthCardStep({
    previous,
    result,
    phase: "pre-game",
    acceptForCard: true,
    returnedAtMs: lastBackgroundReturnAtMs(),
    nowMs: performance.now(),
  })

/** the Polkadot app goes to the background for `awayMs` and comes back */
async function background(awayMs: number) {
  reportPageActivity(true)
  await vi.advanceTimersByTimeAsync(awayMs)
  reportPageActivity(false)
}

describe("the registered home back from the background", () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.mocked(recordRestartCardShown).mockClear()
    runner.reset()
  })

  it("reads Reconnecting, never Restart, while the host reconnects after the return", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] })
    let card: ChainHealthCardState = { lost: false, answering: true }
    await background(4 * 60_000)
    expect(lastBackgroundReturnAtMs()).toBe(performance.now())
    await vi.advanceTimersByTimeAsync(1000)

    // the first probe after the return finds the subscription dropped
    const lost = applyProbe(card, DROPPED)
    expect(lost.advice).toBe(false)
    card = lost.next
    expect(card.lost).toBe(true)
    const view = runner.mount(useHomeCard, { card, consecutiveLost: 1 })
    expect(view.result()).toBe(true)
    expect(restartCardCopy(card.reason!, 1, "", view.result()).heading).not.toBe(RESTART_HEADING)

    // 40 s later the host answers again
    await vi.advanceTimersByTimeAsync(40_000)
    expect(view.result()).toBe(true)
    const healthy = applyProbe(card, PROBE_HEALTHY)
    card = healthy.next
    view.update({ card, consecutiveLost: 0 })
    expect(card.lost).toBe(false)
    expect(healthy.advice).toBe(false)
    expect(view.result()).toBe(false)
    await vi.advanceTimersByTimeAsync(2 * RECONNECTING_BEFORE_RESTART_MS)
    expect(recordRestartCardShown).not.toHaveBeenCalled()
  })

  it("prescribes the restart once the loss outlasts the minute counted from the return", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] })
    await background(4 * 60_000)
    const returnedAt = performance.now()
    await vi.advanceTimersByTimeAsync(2000)
    const { next: card } = applyProbe({ lost: false }, DROPPED)
    const view = runner.mount(useHomeCard, { card, consecutiveLost: 1 })
    expect(view.result()).toBe(true)

    await vi.advanceTimersByTimeAsync(returnedAt + RECONNECTING_BEFORE_RESTART_MS - 1 - performance.now())
    expect(view.result()).toBe(true)
    // a re-check within the window leaves the stamp and so the window alone
    const recheck = applyProbe(card, DROPPED)
    expect(recheck.advice).toBe(false)
    expect(recheck.next.reconnectingSince).toBe(returnedAt)
    await vi.advanceTimersByTimeAsync(1)
    expect(view.result()).toBe(false)
    expect(restartCardCopy(card.reason!, 1, "", view.result()).heading).toBe(RESTART_HEADING)
    expect(recordRestartCardShown).toHaveBeenCalledTimes(1)
  })

  it("never pairs a timeout from before the background with one after it", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] })
    let evidence = reduceHostStuckEvidence({ lastTimeoutAtMs: null }, PROBE_TIMEOUT, performance.now()).state
    await background(5000)
    await vi.advanceTimersByTimeAsync(5000)
    const after = reduceHostStuckEvidence(
      resetHostStuckEvidenceOnReturn(evidence, lastBackgroundReturnAtMs()),
      PROBE_TIMEOUT,
      performance.now(),
    )
    expect(after.result.outcome).toBe("unknown")
    evidence = after.state
    // the run starts again after the return: a second timeout there counts
    await vi.advanceTimersByTimeAsync(10_000)
    const second = reduceHostStuckEvidence(
      resetHostStuckEvidenceOnReturn(evidence, lastBackgroundReturnAtMs()),
      PROBE_TIMEOUT,
      performance.now(),
    )
    expect(second.result.outcome).toBe("host-chain-lost")
  })

  it("lowers a card that was up before the background without claiming the host answers", () => {
    expect(chainHealthCardAfterReturn({ lost: true, reason: "chain-lost" })).toEqual({ lost: false })
    const answering = { lost: false, answering: true }
    expect(chainHealthCardAfterReturn(answering)).toBe(answering)
  })

  it("keeps a chain loss with no background spell an immediate restart", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] })
    await background(1000)
    // long after the return: an ordinary loss
    await vi.advanceTimersByTimeAsync(RECONNECTING_BEFORE_RESTART_MS)
    const { next: card, advice } = applyProbe({ lost: false, answering: true }, DROPPED)
    expect(advice).toBe(true)
    expect(card.reconnectingSince).toBeUndefined()
    const view = runner.mount(useHomeCard, { card, consecutiveLost: 1 })
    expect(view.result()).toBe(false)
    expect(restartCardCopy(card.reason!, 1, "", view.result()).heading).toBe(RESTART_HEADING)
    // and a page that has never been away
    expect(
      chainHealthCardStep({
        previous: { lost: false },
        result: DROPPED,
        phase: "pre-game",
        acceptForCard: true,
        returnedAtMs: null,
        nowMs: performance.now(),
      }).advice,
    ).toBe(true)
  })
})
