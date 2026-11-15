// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("./self-reload", () => ({ requestSelfReload: vi.fn(() => true) }))
vi.mock("./debug/log-store", () => ({ devLog: vi.fn() }))
vi.mock("./telemetry/metrics", () => ({ recordCount: vi.fn(), recordDistribution: vi.fn() }))

import { requestSelfReload } from "./self-reload"
import { resetChainClockForTests, setChainNow } from "./chain-clock"
import { recordCount, recordDistribution } from "./telemetry/metrics"
import {
  LONG_RETURN_OBSERVE_MS,
  LONG_SUSPENSION_RELOAD_MS,
  RETURN_CANDIDATE_WINDOW_MS,
  noteHeldSeat,
  observeForegroundReturn,
  reloadAllowedAfterReturn,
  resetResumeReloadForTests,
  takeReturnCandidateProbe,
  watchLongSuspensionReload,
} from "./resume-reload"
import { watchForegroundReturns, type ForegroundContext, type ForegroundReturn } from "./telemetry/foreground"

const waiting: ForegroundContext = { screen: "waiting", stage: "none", playStarted: false }
const connecting: ForegroundContext = { screen: "game", stage: "connecting", playStarted: false }
const round: ForegroundContext = { screen: "game", stage: "game.round", playStarted: true }

function returned(awayMs: number, context = waiting, suspended = false): ForegroundReturn {
  return { awayMs, left: context, returned: context, suspended, source: "other" }
}

describe("reload after a long suspension", () => {
  const values = new Map<string, string>()
  beforeEach(() => {
    values.clear()
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    vi.stubGlobal("sessionStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    })
    vi.mocked(requestSelfReload).mockClear().mockReturnValue(true)
    vi.mocked(recordCount).mockClear()
    vi.mocked(recordDistribution).mockClear()
    resetResumeReloadForTests()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it("allows only the waiting room and /game before round zero", () => {
    expect(reloadAllowedAfterReturn(waiting)).toBe(true)
    expect(reloadAllowedAfterReturn(connecting)).toBe(true)
    for (const context of [round, { screen: "game", stage: "game.confirm", playStarted: true }, { screen: "home", stage: "none", playStarted: false }, { screen: "payoff", stage: "none", playStarted: false }] as ForegroundContext[])
      expect(reloadAllowedAfterReturn(context)).toBe(false)
  })

  it("observes from one minute but reloads only from five minutes", () => {
    observeForegroundReturn(returned(LONG_RETURN_OBSERVE_MS - 1))
    expect(recordCount).not.toHaveBeenCalled()

    observeForegroundReturn(returned(LONG_SUSPENSION_RELOAD_MS - 1))
    expect(recordCount).toHaveBeenCalledWith("app.long_return", 1, expect.objectContaining({ "app.reloaded": "false" }))
    expect(requestSelfReload).not.toHaveBeenCalled()

    observeForegroundReturn(returned(LONG_SUSPENSION_RELOAD_MS, connecting, true))
    expect(requestSelfReload).toHaveBeenCalledWith(
      "long-suspension",
      expect.objectContaining({ awayMs: LONG_SUSPENSION_RELOAD_MS, screen: "game", stage: "connecting" }),
      expect.any(Function),
    )
    expect(recordCount).toHaveBeenLastCalledWith("app.long_return", 1, expect.objectContaining({ "app.reloaded": "true", "app.suspended": "true" }))
  })

  it("never reloads during a turn even after two hours", () => {
    observeForegroundReturn(returned(2 * 60 * 60_000, round))
    expect(requestSelfReload).not.toHaveBeenCalled()
    expect(recordDistribution).toHaveBeenCalledWith("app.long_return_ms", 2 * 60 * 60_000, "millisecond", expect.objectContaining({ "app.reloaded": "false" }))
  })

  it("measures the first peer's local candidates for five seconds", () => {
    observeForegroundReturn(returned(LONG_RETURN_OBSERVE_MS, waiting))
    const first = takeReturnCandidateProbe("peer-a")
    expect(takeReturnCandidateProbe("peer-b")).toBeNull()
    first?.candidate()
    first?.candidate()
    vi.advanceTimersByTime(RETURN_CANDIDATE_WINDOW_MS)
    expect(recordDistribution).toHaveBeenCalledWith("rtc.return_local_candidates", 2, "none", expect.objectContaining({ "app.screen": "waiting" }))
  })
})

/**
 * #1157, g270: the player left the HOME screen (seat held, kickoff 1 h 49 min
 * away) and came back 46 s before kickoff. Driven through the real foreground
 * watcher and the real listener wiring, with the page's clocks injected: only
 * requestSelfReload (and its budget, tested in self-reload.test.ts) is mocked.
 */
describe("a long return on the home screen with a seat in an imminent game (#1157)", () => {
  const home: ForegroundContext = { screen: "home", stage: "none", playStarted: false }
  const KICKOFF_S = 1_800_000_000
  const AWAY_MS = (60 + 49) * 60_000
  const RETURN_BEFORE_KICKOFF_MS = 46_000
  const leftAtWallMs = KICKOFF_S * 1000 - RETURN_BEFORE_KICKOFF_MS - AWAY_MS

  let wall = 0
  let mono = 0
  let hidden = false
  /** the game clock lags the true time by this much (a visible freeze reads behind) */
  let chainLagMs = 0
  let onHidden: () => void = () => {}
  let onShown: () => void = () => {}
  let tick: () => void = () => {}
  let stops: Array<() => void> = []

  beforeEach(() => {
    vi.mocked(requestSelfReload).mockClear().mockReturnValue(true)
    vi.stubGlobal("sessionStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} })
    resetResumeReloadForTests()
    wall = leftAtWallMs
    mono = 10_000
    hidden = false
    chainLagMs = 0
    setChainNow(() => wall - chainLagMs)
    stops = [
      watchLongSuspensionReload(),
      watchForegroundReturns({
        wallNow: () => wall,
        monoNow: () => mono,
        pageHidden: () => hidden,
        context: () => home,
        watchPageHidden: (h, s) => {
          onHidden = h
          onShown = s
          return () => {}
        },
        setInterval: (callback) => {
          tick = callback
          return 1
        },
        clearInterval: () => {},
        emit: () => {},
        returnSource: () => null,
        chainNow: () => wall - chainLagMs,
        logInterval: () => {},
        logOpen: () => {},
      }),
    ]
  })
  afterEach(() => {
    for (const stop of stops) stop()
    resetChainClockForTests()
    vi.unstubAllGlobals()
  })

  /** hidden for the whole absence: the wall (and the game clock) moved on */
  function hideAndReturn(awayMs = AWAY_MS): void {
    hidden = true
    onHidden()
    wall += awayMs
    hidden = false
    onShown()
  }

  /** iOS froze the visible page: wall moved, monotonic did not, game clock reads behind */
  function freezeAndReturn(awayMs = AWAY_MS): void {
    wall += awayMs
    mono += 500
    chainLagMs = awayMs
    tick()
  }

  it("reloads the home screen 46 s before kickoff after 1 h 49 min hidden", () => {
    noteHeldSeat(KICKOFF_S)
    hideAndReturn()
    expect(requestSelfReload).toHaveBeenCalledWith(
      "long-suspension",
      expect.objectContaining({ awayMs: AWAY_MS, screen: "home", stage: "none" }),
      expect.any(Function),
    )
  })

  it("reloads after the same absence as a visible freeze, whose game clock reads behind", () => {
    noteHeldSeat(KICKOFF_S)
    freezeAndReturn()
    expect(requestSelfReload).toHaveBeenCalledWith(
      "long-suspension",
      expect.objectContaining({ screen: "home" }),
      expect.any(Function),
    )
  })

  it("stays put without a held seat", () => {
    noteHeldSeat(null)
    hideAndReturn()
    expect(requestSelfReload).not.toHaveBeenCalled()
  })

  it("stays put when the held game is still 30 minutes away", () => {
    noteHeldSeat(KICKOFF_S + 30 * 60)
    hideAndReturn()
    expect(requestSelfReload).not.toHaveBeenCalled()
  })

  it("stays put when the held game kicked off long ago", () => {
    noteHeldSeat(KICKOFF_S - 3 * 60 * 60)
    hideAndReturn()
    expect(requestSelfReload).not.toHaveBeenCalled()
  })

  it("stays put before the game clock has a value", () => {
    setChainNow(null)
    noteHeldSeat(KICKOFF_S)
    hideAndReturn()
    expect(requestSelfReload).not.toHaveBeenCalled()
  })

  it("stays put after a short absence even with kickoff close", () => {
    noteHeldSeat(KICKOFF_S)
    wall = KICKOFF_S * 1000 - RETURN_BEFORE_KICKOFF_MS - (LONG_SUSPENSION_RELOAD_MS - 1)
    hideAndReturn(LONG_SUSPENSION_RELOAD_MS - 1)
    expect(requestSelfReload).not.toHaveBeenCalled()
  })
})
