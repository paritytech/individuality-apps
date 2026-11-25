// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { GameSource } from "../game-source"
import { resetPayoffSessionsForTest } from "../payoff-session"
import type { DrawLoadResult } from "./draw-load"
import { createDrawScreenHost, type DrawScreenDeps } from "./draw-screen-host"
import { createPrizeDrawPayoffRunner } from "./payoff-runner"
import type { PrizeDrawView } from "./prize-draw"
import { createDrawCeremony } from "./wheel/ceremony"
import { winnersByRule } from "./wheel/rule"
import type { StageEvents } from "./wheel/stage-runner"

const slot = (n: number): string => n.toString(16).padStart(64, "0")
const TICKETS = [1, 2, 3, 4].map(slot)
const MINE = slot(2)

/** a drawn draw of four tickets and one winner: yours and won, yours and
 *  lost, or one you only watch (no ticket of yours) */
function draw(kind: "cash-win" | "no-win" | "not-in-draw"): PrizeDrawView {
  // a win cuts at the player's own slot, anything else just after it
  const target = kind === "cash-win" ? MINE : slot(3)
  return {
    gameIndex: 7,
    airdropIndex: 0,
    phase: "drawn",
    prizeUsd: 200,
    prizeSymbol: null,
    claimed: false,
    claimable: false,
    claimBlockedReason: null,
    userTicket: kind === "not-in-draw" ? "" : MINE,
    won: kind === "cash-win",
    totalEntries: TICKETS.length,
    winningTickets: winnersByRule(TICKETS, target, 1),
    wheel: { tickets: TICKETS, target, winners: 1 },
  }
}

/** a host on fakes that write what they were asked into `calls` */
function world({ preloaded, mountsAtOnce = false }: { preloaded?: DrawLoadResult; mountsAtOnce?: boolean } = {}) {
  const calls: string[] = []
  const at = { stage: null as StageEvents | null, answer: null as ((result: DrawLoadResult) => void) | null }
  const deps: DrawScreenDeps = {
    game: 7,
    override: undefined,
    peek: () => preloaded,
    miss: () => undefined,
    source: async () => ({}) as GameSource,
    load: () => {
      calls.push("load")
      const promise = new Promise<DrawLoadResult>((resolve) => (at.answer = resolve))
      return { promise, result: undefined, waiting: false, subscribe: () => () => {}, release: () => void calls.push("load.release") }
    },
    claim: (_source, won) => void calls.push(`claim ${won.gameIndex}`),
    payoff: createPrizeDrawPayoffRunner(7),
    drawShown: (state) => void calls.push(`drawShown ${state.kind}`),
    markSeen: (game) => void calls.push(`markSeen ${game}`),
    toCollectables: () => void calls.push("toCollectables"),
    preloadCollectables: () => void calls.push("preloadCollectables"),
    idle: (key) => {
      calls.push(`idle ${key}`)
      return { start: () => calls.push("idle.start"), stop: () => calls.push("idle.stop"), touch: () => {}, detach: () => calls.push("idle.detach") }
    },
    touch: () => () => {},
    stage: (_element, wheel, { held }, on) => {
      calls.push(`stage ${wheel.mine ? "ticket" : "spectator"} held=${held}`)
      at.stage = on
      // a stage that says it is mounted while its own start is still running
      if (mountsAtOnce) on.mounted({ held, progressMs: 40_000 })
      return { release: () => calls.push("stage.release"), progress: () => ({ frames: 1 }), destroy: () => calls.push("stage.destroy") }
    },
    names: async () => null,
    friends: () => [],
    ceremony: () =>
      createDrawCeremony({ devLog: (message, data) => calls.push(`ceremony: ${message} ${JSON.stringify(data)}`), report: () => calls.push("report") }),
    hidden: () => false,
    log: () => {},
    describe: (error) => (error as Error).message,
  }
  return { host: createDrawScreenHost(deps), calls, at }
}

const element = {} as HTMLElement
/** the calls that are not the ceremony's own log lines */
const acts = (calls: string[]) => calls.filter((call) => !call.startsWith("ceremony:"))

beforeEach(() => {
  vi.useFakeTimers()
  resetPayoffSessionsForTest()
})
afterEach(() => {
  vi.useRealTimers()
})

describe("the draw screen's host", () => {
  it("opens on a preloaded draw with nothing run, and runs it all once attached", async () => {
    const { host, calls } = world({ preloaded: { kind: "ready", draw: draw("cash-win") } })
    expect(host.view().kind).toBe("wheel")
    expect(calls).toEqual([])
    host.stageElement(element)
    host.attach()
    await vi.advanceTimersByTimeAsync(0)
    expect(acts(calls)).toEqual(["preloadCollectables", "drawShown ready", "stage ticket held=false", "load"])
  })

  it("steps an event sent while a step's commands run only after them", () => {
    const { host } = world({ preloaded: { kind: "ready", draw: draw("not-in-draw") }, mountsAtOnce: true })
    const armed = vi.spyOn(globalThis, "setTimeout")
    host.stageElement(element)
    host.attach()
    // the intro's timer (the answer's last command) before the progress bound (the mount's)
    expect(armed.mock.calls.map(([, ms]) => ms).filter((ms) => ms === 8_000 || ms === 48_000)).toEqual([8_000, 48_000])
  })

  it("survives StrictMode's replay, and tears down a microtask after a real detach", async () => {
    const { host, calls, at } = world({ preloaded: { kind: "ready", draw: draw("cash-win") } })
    host.stageElement(element)
    host.attach()
    at.stage!.mounted({ held: false, progressMs: 40_000 })
    at.stage!.ended()
    host.detach()
    host.attach()
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).not.toContain("stage.destroy")

    host.detach()
    await vi.advanceTimersByTimeAsync(0)
    expect(acts(calls).slice(-4)).toEqual(["idle.detach", "stage.destroy", "report", "load.release"])
    expect(vi.getTimerCount()).toBe(0)
    host.send({ type: "continue" })
    expect(calls).not.toContain("toCollectables")
  })

  it("waits for the stage's element, and mounts unheld a stage let go before it is there", async () => {
    const { host, calls, at } = world()
    host.attach()
    await vi.advanceTimersByTimeAsync(0)
    at.answer!({ kind: "ready", draw: draw("not-in-draw") })
    await vi.advanceTimersByTimeAsync(8_000)
    expect(calls.some((call) => call.startsWith("stage "))).toBe(false)
    host.stageElement(element)
    expect(calls).toContain("stage spectator held=false")
    expect(calls).not.toContain("stage.release")
  })

  it("starts the idle only once the payoff arms it for a way on, and stops it on the way out", async () => {
    const { host, calls, at } = world({ preloaded: { kind: "ready", draw: draw("no-win") } })
    host.stageElement(element)
    host.attach()
    at.stage!.mounted({ held: false, progressMs: 40_000 })
    expect(calls.some((call) => call.startsWith("idle"))).toBe(false)
    at.stage!.ended()
    expect(acts(calls).filter((call) => call.startsWith("idle"))).toEqual(["idle 7", "idle.start"])
    at.stage!.done()
    expect(acts(calls).slice(-4)).toEqual(["markSeen 7", "idle.stop", "preloadCollectables", "toCollectables"])
  })

  it("hands the ceremony the stage's error, or where a stage that never ended stood", async () => {
    const failed = world({ preloaded: { kind: "ready", draw: draw("no-win") } })
    failed.host.stageElement(element)
    failed.host.attach()
    failed.at.stage!.failed("mount", new Error("no WebGL"))
    expect(failed.calls.find((call) => call.includes("fallback"))).toContain('"reason":"mount-failed","detail":"no WebGL"')

    const stalled = world({ preloaded: { kind: "ready", draw: draw("no-win") } })
    stalled.host.stageElement(element)
    stalled.host.attach()
    stalled.at.stage!.mounted({ held: false, progressMs: 40_000 })
    await vi.advanceTimersByTimeAsync(40_000)
    expect(stalled.calls.find((call) => call.includes("fallback"))).toContain('"reason":"never-ended","progress":{"frames":1}')
    expect(stalled.host.view()).toMatchObject({ kind: "wheel", fallback: true })
  })
})
