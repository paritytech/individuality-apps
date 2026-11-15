// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// The same minimal hook runner as use-reconnect-window.test.ts: no DOM, so
// React's hooks are stood in for by a renderer that runs changed effects
// after each render and re-renders on a state change.
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
        // a nested render (a state change inside an earlier effect) may have
        // committed this slot already
        const committed = effects[i]
        if (committed !== previous && committed && !changed(committed.deps, deps)) return
        if (typeof committed?.cleanup === "function") committed.cleanup()
        // recorded before it runs: a state change inside it re-renders at once
        const entry: Effect = { deps }
        effects[i] = entry
        entry.cleanup = effect()
      })
    },
    useCallback<T>(callback: T, deps?: unknown[]) {
      const i = cursor++
      const previous = slots[i] as { callback: T; deps?: unknown[] } | undefined
      if (previous && !changed(previous.deps, deps)) return previous.callback
      slots[i] = { callback, deps }
      return callback
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
    unmount() {
      for (const effect of effects) if (typeof effect?.cleanup === "function") effect.cleanup()
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
  useCallback: runner.useCallback,
}))
vi.mock("./telemetry", () => ({ recordCount: vi.fn(), recordDistribution: vi.fn() }))
vi.mock("./chain-restart", () => ({
  applyRestartProbe: vi.fn(async () => ({ pending: false, succeeded: null })),
  forgetRestartCardTiming: vi.fn(),
  recordRestartCardCleared: vi.fn(),
  recordRestartCardShown: vi.fn(async () => undefined),
}))
vi.mock("./chain-lost-streak", () => ({
  noteChainLostStreak: vi.fn(async (result: { outcome: string }) =>
    result.outcome === "healthy" ? 0 : result.outcome === "host-chain-lost" ? 1 : undefined,
  ),
}))
vi.mock("./debug/log-store", () => ({ devLog: vi.fn() }))
vi.mock("./webrtc/ice", () => ({
  lastTurnChainHealthOutcome: () => undefined,
  observeTurnChainHealthOutcome: () => () => {},
  turnOutcomeChainHealthOrder: () => undefined,
  TURN_OUTCOME_REPLAY_MAX_MS: 0,
}))

import {
  RECONNECTING_BEFORE_RESTART_MS,
  reduceHostStuckEvidence,
  resetHostStuckEvidenceOnReturn,
  type ChainHealthResult,
  type HostStuckEvidenceState,
} from "./chain-health"
import { lastBackgroundReturnAtMs } from "./background-return"
import { reportPageActivity } from "./page-lifecycle"
import { useChainHealthCard } from "./use-chain-health-card"
import { useReconnectWindow } from "./use-reconnect-window"

const DROPPED: ChainHealthResult = {
  outcome: "host-chain-lost",
  latencyMs: 40,
  errorClass: "subscription-dropped",
  error: "subscription dropped",
}
const HEALTHY: ChainHealthResult = { outcome: "healthy", latencyMs: 40 }
const TIMEOUT: ChainHealthResult = {
  outcome: "unknown",
  latencyMs: 5000,
  errorClass: "timeout",
  error: "chain health probe timed out",
}

interface Scripted {
  result: ChainHealthResult
  /** how long the host takes to answer; 0 answers at once */
  afterMs: number
}

/** A source whose probes answer from a script, with the doorway's two-timeout
 * rule applied the way lib/game-source applies it. */
function scriptedSource(next: () => Scripted) {
  let evidence: HostStuckEvidenceState = { lastTimeoutAtMs: null }
  const probeChainHealth = vi.fn(async () => {
    const startedAtMs = performance.now()
    const { result, afterMs } = next()
    if (afterMs > 0) await new Promise((resolve) => setTimeout(resolve, afterMs))
    const promoted = reduceHostStuckEvidence(
      resetHostStuckEvidenceOnReturn(evidence, lastBackgroundReturnAtMs()),
      result,
      startedAtMs,
    )
    evidence = promoted.state
    return promoted.result
  })
  return { nowSeconds: () => 0, probeChainHealth }
}

type Source = ReturnType<typeof scriptedSource>

/** A card surface with no periodic probe of its own: the game's connecting
 * card, wired as app/game/page.tsx wires it. */
const useSurface = ({ source, phase }: { source: Source; phase: "pre-game" | "round" }) => {
  const health = useChainHealthCard({
    source,
    waiting: false,
    phase,
    registered: true,
    probeOnOpen: false,
  })
  const reconnecting = useReconnectWindow({
    visible: health.card.lost,
    reason: health.card.reason,
    consecutiveLost: health.consecutiveLost,
    healthy: health.card.answering === true,
    where: "handover",
    since: health.card.reconnectingSince,
  })
  return { ...health, reconnecting }
}

const doc = { hidden: false, addEventListener: () => {}, removeEventListener: () => {} }

async function background(awayMs: number) {
  doc.hidden = true
  reportPageActivity(true)
  await vi.advanceTimersByTimeAsync(awayMs)
  doc.hidden = false
  reportPageActivity(false)
}

describe("the chain-health card across a return from the background", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] })
    doc.hidden = false
    vi.stubGlobal("document", doc)
  })
  afterEach(() => {
    runner.unmount()
    runner.reset()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it("probes a dead host after the return and prescribes the restart when the minute ends", async () => {
    const source = scriptedSource(() => ({ result: DROPPED, afterMs: 50 }))
    const view = runner.mount(useSurface, { source, phase: "pre-game" })
    await background(3 * 60_000)
    const returnedAt = performance.now()
    await vi.advanceTimersByTimeAsync(1000)
    expect(source.probeChainHealth).toHaveBeenCalled()
    expect(view.result().card.lost).toBe(true)
    expect(view.result().reconnecting).toBe(true)
    await vi.advanceTimersByTimeAsync(returnedAt + RECONNECTING_BEFORE_RESTART_MS - performance.now())
    expect(view.result().card.lost).toBe(true)
    expect(view.result().reconnecting).toBe(false)
  })

  it("raises the silent-host card after two timeouts that follow the return", async () => {
    const source = scriptedSource(() => ({ result: TIMEOUT, afterMs: 5000 }))
    const view = runner.mount(useSurface, { source, phase: "pre-game" })
    await background(3 * 60_000)
    await vi.advanceTimersByTimeAsync(31_000)
    expect(source.probeChainHealth).toHaveBeenCalledTimes(2)
    expect(view.result().card).toMatchObject({ lost: true, reason: "host-unanswered" })
  })

  it("keeps an in-round bar and its reappearance gate across a return", async () => {
    const script: ChainHealthResult[] = [DROPPED, HEALTHY, DROPPED, DROPPED]
    const source = scriptedSource(() => ({ result: script.shift() ?? HEALTHY, afterMs: 0 }))
    const view = runner.mount(useSurface, { source, phase: "round" })
    await view.result().probe("recheck")
    expect(view.result().card.lost).toBe(true)
    await background(10_000)
    expect(view.result().card.lost).toBe(true)
    expect(source.probeChainHealth).toHaveBeenCalledTimes(1)

    await view.result().probe("recheck") // healthy: the bar clears and the gate arms
    expect(view.result().card.lost).toBe(false)
    await background(10_000)
    expect(source.probeChainHealth).toHaveBeenCalledTimes(2)
    await view.result().probe("recheck") // one stale-looking loss is held back
    expect(view.result().card.lost).toBe(false)
    await view.result().probe("recheck") // the second in a row shows the bar
    expect(view.result().card.lost).toBe(true)
  })

  it("drops a loss from a probe that started before the background", async () => {
    const script: Scripted[] = [
      { result: DROPPED, afterMs: 10_000 },
      { result: HEALTHY, afterMs: 15_000 },
    ]
    const source = scriptedSource(() => script.shift() ?? { result: HEALTHY, afterMs: 0 })
    const view = runner.mount(useSurface, { source, phase: "pre-game" })
    void view.result().probe("open")
    await vi.advanceTimersByTimeAsync(1000)
    await background(4000)
    expect(source.probeChainHealth).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(6000) // the old probe answers lost
    expect(view.result().card.lost).toBe(false)
  })

  it("drops a healthy answer from a probe that started before the background", async () => {
    const script: Scripted[] = [
      { result: HEALTHY, afterMs: 10_000 },
      { result: TIMEOUT, afterMs: 15_000 },
    ]
    const source = scriptedSource(() => script.shift() ?? { result: TIMEOUT, afterMs: 5000 })
    const view = runner.mount(useSurface, { source, phase: "pre-game" })
    void view.result().probe("open")
    await vi.advanceTimersByTimeAsync(1000)
    await background(4000)
    await vi.advanceTimersByTimeAsync(6000) // the old probe answers healthy
    expect(view.result().card.answering).toBeUndefined()
  })
})
