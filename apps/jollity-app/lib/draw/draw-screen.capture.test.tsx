// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// @vitest-environment jsdom
/**
 * THE PRIZE DRAW SCREEN, CAPTURED — what /prize-draw does in each named
 * scenario, recorded at its edges, so that its reducer and host
 * (lib/draw/draw-screen.ts, lib/draw/draw-screen-host.ts) are held to it.
 *
 * Real here: the page, WheelStage, the ceremony, the payoff session, the idle
 * watch, the rule check and the words. Faked at the module boundary: the chain
 * (the source, the draw load, the claim), the stage (mountWheel and the coins),
 * the router, the host's seen-mark, telemetry and the debug log. Every fake
 * writes what it was asked to do into one trace, stamped with the fake clock,
 * and the trace is a golden, together with the debug log's lines.
 *
 * Defects were captured as they were, and their fixes changed these goldens on
 * purpose: a failed read now says so, with Continue on to the collectables screen, and the
 * 60 s idle counts from the way on (the stage's Continue, the words, a
 * fallback), no longer from the stage's mount.
 */
import { act, cleanup, fireEvent, render, screen, type RenderResult } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { DrawLoadResult } from "./draw-load"
import type { PrizeDrawView } from "./prize-draw"
import { slotHex, winnersByRule } from "./wheel/rule"

const h = vi.hoisted(() => {
  const rec = {
    t0: 0,
    trace: [] as string[],
    logs: [] as string[],
    /** a line of the trace, at the fake clock's ms since the scenario began */
    note(line: string) {
      rec.trace.push(`${String(Date.now() - rec.t0).padStart(6)} ${line}`)
    },
  }
  const ctl = {
    /** what getGameSource gives: a source, or null for no identity */
    source: {} as object | null,
    /** what peekDraw gives: the game session's preloaded answer, if any */
    preloaded: undefined as DrawLoadResult | undefined,
    coinsFail: false,
    mountFails: false,
    stage: { ended: false, done: false },
    /** what the mounted stage calls back: its Continue up, the player through */
    on: null as null | { onEnded?: () => void; onDone?: () => void },
    load: null as null | { wait(): void; answer(result: DrawLoadResult): void; fail(): void },
  }
  // one router for the page's life, as next/navigation's is
  const router = {
    replace: (href: string) => rec.note(`router.replace ${href}`),
    push: () => {},
    prefetch: () => {},
    back: () => {},
    forward: () => {},
    refresh: () => {},
  }
  return { rec, ctl, router }
})

vi.mock("next/navigation", () => ({ useRouter: () => h.router }))
vi.mock("@/lib/game-source", () => ({ getGameSource: async () => h.ctl.source }))
vi.mock("@/lib/draw/draw-load", () => ({
  peekDraw: () => h.ctl.preloaded,
  loadDraw: (_source: unknown, game?: number, player?: string) => {
    h.rec.note(`loadDraw game=${game} player=${player ?? "-"}`)
    let waiting = false
    let result: DrawLoadResult | undefined
    const listeners = new Set<() => void>()
    let resolve!: (value: DrawLoadResult) => void
    let reject!: (error: Error) => void
    const promise = new Promise<DrawLoadResult>((res, rej) => {
      resolve = res
      reject = rej
    })
    h.ctl.load = {
      wait() {
        waiting = true
        listeners.forEach((listener) => listener())
      },
      // as draw-load settles: the answer and waiting=false told first, then the promise
      answer(answer) {
        result = answer
        waiting = false
        listeners.forEach((listener) => listener())
        resolve(answer)
      },
      // as draw-load fails: nobody told, the promise rejected
      fail() {
        reject(new Error("capture: the draw read failed"))
      },
    }
    return {
      promise,
      get result() {
        return result
      },
      get waiting() {
        return waiting
      },
      subscribe(listener: () => void) {
        listeners.add(listener)
        return () => void listeners.delete(listener)
      },
      release() {},
    }
  },
}))
vi.mock("@/lib/draw/auto-claim", () => ({
  startAutoClaim: (_source: unknown, draw: PrizeDrawView) => h.rec.note(`startAutoClaim ${draw.gameIndex}:${draw.airdropIndex}`),
}))
vi.mock("@/lib/worker-bridge", () => ({
  markSeen: async (game: number, what: string) => h.rec.note(`markSeen ${game} ${what}`),
}))
vi.mock("@/lib/journeys/game-trace", () => ({
  drawShown: (state: { kind: string }, check: { ok: boolean; code?: string } | null, game?: number) =>
    h.rec.note(`drawShown ${state.kind} ${check === null ? "no-check" : check.ok ? "ok" : check.code} game=${game}`),
}))
vi.mock("@/lib/telemetry", () => ({
  reportDrawCeremony: (evidence: object) => h.rec.note(`reportDrawCeremony ${JSON.stringify(evidence)}`),
  recordCount: () => {},
  recordDistribution: () => {},
  reportFailure: () => {},
}))
vi.mock("@/lib/telemetry/use-scene", () => ({ useScene: () => {} }))
vi.mock("@/lib/debug/log-store", () => ({
  devLog: (tag: string, message: string, data?: unknown, level?: string) =>
    h.rec.logs.push(`${level ?? "info"} [${tag}] ${message}${data === undefined ? "" : ` ${JSON.stringify(data)}`}`),
}))
// the collectables screen's own preload (its claims feed) is the collectables screen's, tested there; that the draw starts it is recorded here
vi.mock("@/lib/collectables/collectables-screen-deps", () => ({ preloadCollectablesFeed: () => h.rec.note("preloadCollectablesFeed") }))
vi.mock("@/lib/draw/draw-name-lookup", () => ({ readDrawName: async () => null }))
vi.mock("@/lib/draw/wheel/baked-coin", () => ({
  loadBakedCoins: async () => {
    h.rec.note("loadBakedCoins")
    if (h.ctl.coinsFail) throw new Error("capture: the coins did not load")
  },
  loadPrizeCoin: async (amount: string, unit: string) => h.rec.note(`loadPrizeCoin ${amount} ${unit}`),
}))
vi.mock("@/lib/draw/wheel/mount", () => ({
  WHEEL_PROGRESS_TIMEOUT_MS: 40_000,
  mountWheel: (
    _host: HTMLElement,
    draw: { mine: string; won: boolean; tickets: readonly string[] },
    opts?: { held?: boolean; onEnded?: () => void; onDone?: () => void },
  ) => {
    h.rec.note(`mountWheel ${draw.mine ? "ticket" : "spectator"} won=${draw.won} tickets=${draw.tickets.length} held=${Boolean(opts?.held)}`)
    if (h.ctl.mountFails) throw new Error("capture: the stage did not mount")
    h.ctl.on = opts ?? null
    // a stage told to have ended before it was up says so as soon as it is
    queueMicrotask(() => {
      if (h.ctl.stage.ended) opts?.onEnded?.()
      if (h.ctl.stage.done) opts?.onDone?.()
    })
    return {
      release: () => h.rec.note("stage.release"),
      progress: () => ({ frames: 1 }),
      destroy: () => h.rec.note("stage.destroy"),
    }
  },
}))

const { default: PrizeDrawPage } = await import("@/app/prize-draw/page")
const { resetPayoffSessionsForTest } = await import("@/lib/payoff-session")
const { resetDeviceClockForTests } = await import("@/lib/device-clock")

const { rec, ctl } = h

/** a deterministic 64-hex ticket, so a draw's tickets never move */
function ticket(seed: number): string {
  let h = 2166136261 ^ seed
  let out = ""
  while (out.length < 64) {
    h = Math.imul(h ^ (h >>> 15), h | 1)
    h ^= h + Math.imul(h ^ (h >>> 7), h | 61)
    out += ((h ^ (h >>> 14)) >>> 0).toString(16).padStart(8, "0")
  }
  return out.slice(0, 64)
}

/** a draw the wheel can run: `players` tickets with yours among them, one
 *  winner, and a target that gives `won`. The winners are the rule's own
 *  (lib/draw/wheel/rule.ts), so the page's check passes as it does on chain. */
function wheelDraw(players: number, won: boolean) {
  const mine = ticket(7)
  const tickets = [mine, ...Array.from({ length: players - 1 }, (_, i) => ticket(100 + i))]
  const sorted = tickets.map(slotHex).sort()
  const at = sorted.indexOf(slotHex(mine))
  // a win cuts right at your slot; a loss starts the run just after it
  const target = sorted[won ? at : (at + 1) % players] as string
  return { userTicket: mine, won, totalEntries: players, winningTickets: winnersByRule(tickets, target, 1), wheel: { tickets, target, winners: 1 } }
}

/** the draws the scenarios are handed: the shape prizeDrawView returns, minus the chain */
function fixture(name: "cash-win" | "no-win" | "not-in-draw" | "no-wheel"): PrizeDrawView {
  const base = {
    gameIndex: 7,
    airdropIndex: 0,
    phase: "drawn" as const,
    prizeUsd: 200,
    prizeSymbol: "pUSD",
    claimed: false,
    claimable: false,
    claimBlockedReason: null,
  }
  if (name === "cash-win") return { ...base, ...wheelDraw(24, true) }
  // signed up, but the sign-up entered no draw: they still watch it
  if (name === "not-in-draw") return { ...base, ...wheelDraw(12, false), userTicket: "", won: false }
  // the entries are cleared: the plain result stands in for the wheel
  if (name === "no-wheel") return { ...base, ...wheelDraw(24, false), wheel: null }
  return { ...base, ...wheelDraw(24, false) }
}
const ready = (draw: PrizeDrawView): DrawLoadResult => ({ kind: "ready", draw })

/** what is on screen, in a line */
function dom(): string {
  const parts: string[] = []
  if (document.querySelector(".wheel-host")) parts.push("wheel")
  const intro = document.querySelector(".wheel-intro")
  if (intro) parts.push(intro.classList.contains("is-leaving") ? "intro (leaving)" : "intro")
  const fallback = document.querySelector(".wheel-fallback .wheel-note-heading")
  if (fallback) parts.push(`fallback "${fallback.textContent}"`)
  const headings = [...document.querySelectorAll("h1")].filter((el) => !el.closest(".wheel-intro")).map((el) => el.textContent)
  if (headings.length) parts.push(`h1 "${headings.join(" / ")}"`)
  const buttons = screen.queryAllByRole("button").map((button) => button.textContent?.trim())
  if (buttons.length) parts.push(`buttons [${buttons.join(", ")}]`)
  if (document.querySelector('[aria-busy="true"]')) parts.push("busy")
  return parts.join(" · ") || "empty"
}

let view: RenderResult | null = null
let shown = ""
function look() {
  const now = dom()
  if (now === shown) return
  shown = now
  rec.note(`dom: ${now}`)
}
/** run the fake clock to `ms` after the start, in slices, noting what the screen shows */
async function to(ms: number) {
  while (Date.now() - rec.t0 < ms) {
    const step = Math.min(50, ms - (Date.now() - rec.t0))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(step)
    })
    look()
  }
}

interface Step {
  at: number
  label: string
  run: () => void
}
/** render the page, play the steps at their times, and run on to `until` */
async function scenario(steps: Step[], until: number) {
  view = render(<PrizeDrawPage />)
  look()
  for (const step of [...steps].sort((a, b) => a.at - b.at)) {
    await to(step.at)
    rec.note(`— ${step.label}`)
    await act(async () => step.run())
    look()
  }
  await to(until)
  return { trace: rec.trace, logs: [...rec.logs].sort() }
}

// the steps the scenarios share
const answer = (at: number, result: DrawLoadResult, label: string): Step => ({ at, label: `the read answers: ${label}`, run: () => ctl.load!.answer(result) })
const ended = (at: number): Step => ({
  at,
  label: "the stage offers its Continue",
  run: () => {
    ctl.stage.ended = true
    ctl.on?.onEnded?.()
  },
})
const done = (at: number): Step => ({
  at,
  label: "the stage is done (its Continue pressed, a loss's fall played)",
  run: () => {
    ctl.stage.done = true
    ctl.on?.onDone?.()
  },
})
const pressContinue = (at: number): Step => ({ at, label: "Continue pressed", run: () => void fireEvent.click(screen.getByRole("button", { name: "Continue" })) })
let visibility: DocumentVisibilityState = "visible"
const setVisibility = (at: number, state: DocumentVisibilityState): Step => ({
  at,
  label: `the page turns ${state}`,
  run: () => {
    visibility = state
    document.dispatchEvent(new Event("visibilitychange"))
  },
})

const lines = (trace: string[], needle: string) => trace.filter((line) => line.includes(needle))

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance"] })
  vi.setSystemTime(new Date("2026-11-02T12:00:00Z"))
  rec.t0 = Date.now()
  rec.trace = []
  rec.logs = []
  Object.assign(ctl, { source: {}, preloaded: undefined, coinsFail: false, mountFails: false, stage: { ended: false, done: false }, on: null, load: null })
  shown = ""
  visibility = "visible"
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility })
  sessionStorage.clear()
  localStorage.clear()
  window.history.replaceState({}, "", "/prize-draw?game=7")
  resetPayoffSessionsForTest()
  resetDeviceClockForTests()
})
afterEach(() => {
  cleanup()
  view = null
  vi.useRealTimers()
})

describe("the prize draw screen today, captured", () => {
  it("a winner plays the wheel and goes on to the collectables screen", async () => {
    const run = await scenario([answer(100, ready(fixture("cash-win")), "a win"), ended(4000), done(7000)], 8000)
    expect(lines(run.trace, "startAutoClaim").length).toBeGreaterThan(0)
    expect(lines(run.trace, "markSeen")).toHaveLength(1)
    expect(lines(run.trace, "router.replace")).toEqual([expect.stringContaining("router.replace /collectables?game=7")])
    expect(lines(run.trace, "reportDrawCeremony")).toHaveLength(1)
    expect(run).toMatchSnapshot()
  })

  it("a loser plays the wheel, and goes on once the fall has played", async () => {
    const run = await scenario([answer(100, ready(fixture("no-win")), "a loss"), ended(4000), done(9000)], 10_000)
    expect(lines(run.trace, "startAutoClaim")).toHaveLength(0)
    expect(lines(run.trace, "router.replace")).toHaveLength(1)
    expect(run).toMatchSnapshot()
  })

  it("a spectator is told what the draw is over the held stage, then watches it", async () => {
    const run = await scenario([answer(100, ready(fixture("not-in-draw")), "no ticket of theirs"), ended(20_000), done(22_000)], 23_000)
    expect(lines(run.trace, "mountWheel")).toEqual([expect.stringContaining("spectator won=false tickets=12 held=true")])
    expect(lines(run.trace, "stage.release")).toHaveLength(1)
    expect(run).toMatchSnapshot()
  })

  it("a loss the wheel cannot tell is told in words", async () => {
    const run = await scenario([answer(100, ready(fixture("no-wheel")), "a loss with no wheel"), pressContinue(3000)], 4000)
    expect(lines(run.trace, "mountWheel")).toHaveLength(0)
    expect(run).toMatchSnapshot()
  })

  it("a win the wheel cannot tell is told in words, and claimed at once", async () => {
    const run = await scenario([answer(100, ready({ ...fixture("cash-win"), wheel: null }), "a win with no wheel"), pressContinue(3000)], 4000)
    expect(lines(run.trace, "startAutoClaim").length).toBeGreaterThan(0)
    expect(run).toMatchSnapshot()
  })

  it("no draw this game goes straight to the collectables screen", async () => {
    const run = await scenario([answer(100, { kind: "none" }, "no draw")], 1000)
    expect(lines(run.trace, "router.replace")).toHaveLength(1)
    expect(run).toMatchSnapshot()
  })

  it("a draw still drawing says so, and Continue skips it", async () => {
    const run = await scenario(
      [{ at: 100, label: "the read says the chain is still drawing", run: () => ctl.load!.wait() }, pressContinue(2000)],
      3000,
    )
    expect(run).toMatchSnapshot()
  })

  it("a draw still drawing that then lands plays the wheel", async () => {
    const run = await scenario(
      [{ at: 100, label: "the read says the chain is still drawing", run: () => ctl.load!.wait() }, answer(3100, ready(fixture("no-win")), "a loss"), ended(6000), done(9000)],
      10_000,
    )
    expect(run).toMatchSnapshot()
  })

  it("no player identity says so, and Continue skips it", async () => {
    ctl.source = null
    const run = await scenario([pressContinue(1000)], 2000)
    expect(run).toMatchSnapshot()
  })

  it("a failed read says so, and Continue goes on to the collectables screen", async () => {
    const run = await scenario([{ at: 100, label: "the read fails", run: () => ctl.load!.fail() }, pressContinue(3000)], 4000)
    expect(lines(run.trace, "dom:").at(-1)).toContain("Couldn't load the draw")
    expect(lines(run.trace, "markSeen")).toHaveLength(0)
    expect(lines(run.trace, "router.replace")).toHaveLength(1)
    expect(run).toMatchSnapshot()
  })

  it("a stage whose code does not load falls back to words and the page's Continue", async () => {
    ctl.coinsFail = true
    const run = await scenario([answer(100, ready(fixture("cash-win")), "a win"), pressContinue(3000)], 4000)
    expect(run).toMatchSnapshot()
  })

  it("a stage that does not mount falls back to words and the page's Continue", async () => {
    ctl.mountFails = true
    const run = await scenario([answer(100, ready(fixture("no-win")), "a loss"), pressContinue(3000)], 4000)
    expect(run).toMatchSnapshot()
  })

  it("a stage that never ends falls back once its bound runs out", async () => {
    const run = await scenario([answer(100, ready(fixture("cash-win")), "a win"), pressContinue(45_000)], 46_000)
    expect(run).toMatchSnapshot()
  })

  it("a player left idle is moved on a minute after their Continue, the draw not marked seen", async () => {
    const run = await scenario([answer(100, ready(fixture("no-win")), "a loss"), ended(4000)], 65_000)
    expect(lines(run.trace, "markSeen")).toHaveLength(0)
    expect(lines(run.trace, "router.replace")).toEqual([expect.stringMatching(/^ 64000 router.replace/)])
    expect(run).toMatchSnapshot()
  })

  it("a spectator gets a full minute from their Continue, not from the stage's mount", async () => {
    const run = await scenario([answer(100, ready(fixture("not-in-draw")), "no ticket of theirs"), ended(22_000)], 83_000)
    expect(lines(run.trace, "router.replace")).toEqual([expect.stringMatching(/^ 82000 router.replace/)])
    expect(lines(run.trace, "reportDrawCeremony")).toEqual([expect.stringContaining('"continueVisibleMs":60000')])
    expect(run).toMatchSnapshot()
  })

  it("the words move on after a minute too", async () => {
    const run = await scenario([answer(100, ready(fixture("no-wheel")), "a loss with no wheel")], 61_000)
    expect(lines(run.trace, "markSeen")).toHaveLength(0)
    expect(lines(run.trace, "router.replace")).toEqual([expect.stringMatching(/^ 60100 router.replace/)])
    expect(run).toMatchSnapshot()
  })

  it("time hidden is counted in the ceremony", async () => {
    const run = await scenario(
      [answer(100, ready(fixture("cash-win")), "a win"), setVisibility(1000, "hidden"), setVisibility(4000, "visible"), ended(5000), done(6000)],
      7000,
    )
    expect(run).toMatchSnapshot()
  })

  it("a page hidden for good reports the ceremony once, and a later Continue still goes on", async () => {
    const run = await scenario(
      [answer(100, ready(fixture("cash-win")), "a win"), { at: 2000, label: "pagehide", run: () => void window.dispatchEvent(new Event("pagehide")) }, ended(3000), done(4000)],
      5000,
    )
    expect(lines(run.trace, "reportDrawCeremony")).toHaveLength(1)
    expect(run).toMatchSnapshot()
  })

  it("leaving the screen tears the stage down and reports the ceremony", async () => {
    const run = await scenario([answer(100, ready(fixture("cash-win")), "a win"), { at: 2000, label: "the page unmounts", run: () => view!.unmount() }], 3000)
    expect(lines(run.trace, "stage.destroy")).toHaveLength(1)
    expect(run).toMatchSnapshot()
  })

  it("a draw preloaded on the confirm screen opens on the wheel, with no black frame", async () => {
    ctl.preloaded = ready(fixture("cash-win"))
    const run = await scenario([answer(100, ready(fixture("cash-win")), "the same win, from the page's own read"), ended(3000), done(4000)], 5000)
    expect(lines(run.trace, "dom:")[0]).toContain("wheel")
    expect(lines(run.trace, "dom:")[0]).not.toContain("busy")
    expect(run).toMatchSnapshot()
  })
})
