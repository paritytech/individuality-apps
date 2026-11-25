// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("./metrics", async () => (await import("./testing")).fakeTelemetryModule())

import { pageFreezeThresholdMs, watchPageActivity } from "../page-lifecycle"
import {
  AWAY_MIN_LOGGED_MS,
  AWAY_RUNNING_LOGGED_MS,
  type AwayOpen,
  type AwayRunning,
  FOREGROUND_TICK_MS,
  consumeNotificationReturnSource,
  foregroundContext,
  recordForegroundReturn,
  watchForegroundReturn,
  watchForegroundReturns,
  type AwayInterval,
  type ForegroundContext,
  type ForegroundReturn,
} from "./foreground"
import { recorded, resetRecorded } from "./testing"

interface Harness {
  setNow(value: number): void
  setWall(value: number): void
  setMono(value: number): void
  setContext(value: ForegroundContext): void
  setHidden(value: boolean): void
  setReturnSource(value: "notification" | null): void
  hidden(): void
  shown(): void
  tick(): void
  stop: () => void
  returns: ForegroundReturn[]
  cleared: number[]
}

function harness(initialSource: "notification" | null = null): Harness {
  let wall = 100
  let mono = 100
  let context: ForegroundContext = { screen: "home", stage: "none", playStarted: false }
  let hidden = false
  let onHidden = () => {}
  let onShown = () => {}
  let tick = () => {}
  let source = initialSource
  const returns: ForegroundReturn[] = []
  const cleared: number[] = []
  const stop = watchForegroundReturns({
    wallNow: () => wall,
    monoNow: () => mono,
    pageHidden: () => hidden,
    context: () => context,
    watchPageHidden: (hide, show) => {
      onHidden = hide
      onShown = show
      return () => {
        onHidden = () => {}
        onShown = () => {}
      }
    },
    setInterval: (callback) => {
      tick = callback
      return 7
    },
    clearInterval: (id) => cleared.push(id as number),
    returnSource: () => {
      const value = source
      source = null
      return value
    },
    emit: (value) => returns.push(value),
  })
  return {
    setNow(value) {
      wall = value
      mono = value
    },
    setWall(value) {
      wall = value
    },
    setMono(value) {
      mono = value
    },
    setContext(value) {
      context = value
    },
    setHidden(value) {
      hidden = value
    },
    setReturnSource(value) {
      source = value
    },
    hidden: () => onHidden(),
    shown: () => onShown(),
    tick: () => tick(),
    stop,
    returns,
    cleared,
  }
}

function initiallyHiddenHarness(): Harness {
  let wall = 50
  let mono = 50
  let onShown = () => {}
  const returns: ForegroundReturn[] = []
  const stop = watchForegroundReturns({
    wallNow: () => wall,
    monoNow: () => mono,
    pageHidden: () => wall < 1_050,
    context: () => ({ screen: "home", stage: "none", playStarted: false }),
    watchPageHidden: (_hide, show) => {
      onShown = show
      return () => {}
    },
    setInterval: () => 1,
    clearInterval: () => {},
    emit: (value) => returns.push(value),
  })
  return {
    setNow(value) {
      wall = value
      mono = value
    },
    setWall(value) {
      wall = value
    },
    setMono(value) {
      mono = value
    },
    setContext() {},
    setHidden() {},
    setReturnSource() {},
    hidden() {},
    shown: () => onShown(),
    tick() {},
    stop,
    returns,
    cleared: [],
  }
}

it("shares hide, show and silent-suspension edges with active subsystems", () => {
  const edges: Array<[boolean, boolean]> = []
  const stopActivity = watchPageActivity((hidden, suspended) => edges.push([hidden, suspended]))
  const h = harness()
  h.hidden()
  h.shown()
  h.setWall(6_101)
  h.setMono(600)
  h.tick()
  h.stop()
  stopActivity()
  expect(edges).toEqual([
    [true, false],
    [false, false],
    [true, true],
    [false, true],
  ])
})

beforeEach(resetRecorded)
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe("foreground return watcher", () => {
  it("records one explicit hide-to-show return with both contexts and its monotonic duration", () => {
    const h = harness()
    h.hidden()
    h.setNow(2_100)
    h.setContext({ screen: "game", stage: "game.round.play", playStarted: true })
    h.shown()
    expect(h.returns).toEqual([
      {
        awayMs: 2_000,
        left: { screen: "home", stage: "none", playStarted: false },
        returned: { screen: "game", stage: "game.round.play", playStarted: true },
        suspended: false,
        source: "other",
      },
    ])
  })

  it("deduplicates visibilitychange/pagehide and visibilitychange/pageshow pairs", () => {
    const h = harness()
    h.hidden()
    h.setNow(400)
    h.hidden()
    h.setNow(1_100)
    h.shown()
    h.setNow(1_200)
    h.shown()
    expect(h.returns).toHaveLength(1)
    expect(h.returns[0].awayMs).toBe(1_000)
  })

  it("detects a visible frozen-page gap when the wall advances but the monotonic clock stops", () => {
    const h = harness()
    h.setContext({ screen: "waiting", stage: "none", playStarted: false })
    h.tick() // the last alive context
    h.setWall(60_100)
    h.setMono(500)
    h.setContext({ screen: "game", stage: "game.round.intro", playStarted: true })
    h.tick()
    expect(h.returns).toEqual([
      {
        awayMs: 59_600,
        left: { screen: "waiting", stage: "none", playStarted: false },
        returned: { screen: "game", stage: "game.round.intro", playStarted: true },
        suspended: true,
        source: "other",
      },
    ])
  })

  it("does not call a long busy-main-thread stall a suspension when both clocks advance", () => {
    const h = harness()
    const gap = pageFreezeThresholdMs(FOREGROUND_TICK_MS) + 1
    h.setNow(100 + gap)
    h.tick()
    expect(h.returns).toEqual([])
  })

  it("uses the wall duration across a hidden freeze, but ignores a backward wall step", () => {
    const h = harness()
    h.hidden()
    h.setWall(900_100)
    h.setMono(3_100)
    h.shown()
    expect(h.returns[0].awayMs).toBe(900_000)

    h.hidden()
    h.setWall(50)
    h.setMono(4_100)
    h.shown()
    expect(h.returns[1].awayMs).toBe(1_000)
  })

  it("does not call an on-time tick a suspension and waits for show while hidden", () => {
    const h = harness()
    h.setNow(100 + pageFreezeThresholdMs(FOREGROUND_TICK_MS))
    h.tick()
    expect(h.returns).toEqual([])
    h.setHidden(true)
    h.hidden()
    h.setNow(20_000)
    h.tick()
    expect(h.returns).toEqual([])
    h.setHidden(false)
    h.shown()
    expect(h.returns).toHaveLength(1)
    expect(h.returns[0]).toMatchObject({ awayMs: 20_000 - (100 + pageFreezeThresholdMs(FOREGROUND_TICK_MS)), suspended: false })
  })

  it("unsubscribes and clears its heartbeat", () => {
    const h = harness()
    h.stop()
    h.hidden()
    h.tick()
    expect(h.returns).toEqual([])
    expect(h.cleared).toEqual([7])
  })

  it("counts a return when the watcher itself mounted while hidden", () => {
    const h = initiallyHiddenHarness()
    h.setNow(1_050)
    h.shown()
    expect(h.returns).toHaveLength(1)
    expect(h.returns[0]).toMatchObject({ awayMs: 1_000, suspended: false })
  })

  it("attributes explicit and frozen returns to a reminder once", () => {
    const h = harness()
    h.hidden()
    h.setNow(1_100)
    h.setReturnSource("notification")
    h.shown()
    expect(h.returns[0]).toMatchObject({ source: "notification", awayMs: 1_000, suspended: false })

    h.setWall(60_100)
    h.setMono(1_500)
    h.setReturnSource("notification")
    h.tick()
    expect(h.returns[1]).toMatchObject({ source: "notification", suspended: true })

    h.hidden()
    h.setNow(61_100)
    h.shown()
    expect(h.returns[2]).toMatchObject({ source: "other" })
  })

  it("counts a visible notification open without inventing an away duration", () => {
    const h = harness("notification")
    expect(h.returns).toEqual([
      {
        awayMs: null,
        left: { screen: "home", stage: "none", playStarted: false },
        returned: { screen: "home", stage: "none", playStarted: false },
        suspended: false,
        source: "notification",
      },
    ])
  })

  it("counts a reminder marker that arrives on a visible page exactly once", () => {
    const h = harness()
    h.setReturnSource("notification")
    h.tick()
    h.tick()
    expect(h.returns).toHaveLength(1)
    expect(h.returns[0]).toMatchObject({ awayMs: null, source: "notification" })
  })

  it("ignores a marker that Next restores after the first attribution", () => {
    const returns: ForegroundReturn[] = []
    let tick = () => {}
    watchForegroundReturns({
      wallNow: () => 100,
      monoNow: () => 100,
      pageHidden: () => false,
      context: () => ({ screen: "home", stage: "none", playStarted: false }),
      watchPageHidden: () => () => {},
      setInterval: (callback) => {
        tick = callback
        return 1
      },
      clearInterval: () => {},
      returnSource: () => "notification",
      emit: (value) => returns.push(value),
    })

    tick()
    tick()
    expect(returns).toHaveLength(1)
  })

  it("publishes the measured return to lifecycle observers", () => {
    const observed: ForegroundReturn[] = []
    const stop = watchForegroundReturn((value) => observed.push(value))
    const h = harness()
    h.hidden()
    h.setNow(70_100)
    h.shown()
    expect(observed).toEqual([h.returns[0]])
    stop()
  })
})

describe("notification return source", () => {
  it("consumes the reminder moment and sends it with the notification-open metric", () => {
    const replaceState = vi.fn()
    vi.stubGlobal("location", {
      search: "?game=7&jollity-notification=reminder&moment=start-5m",
      pathname: "/game",
      hash: "#turn",
    })
    vi.stubGlobal("history", { state: { kept: true }, replaceState })

    expect(consumeNotificationReturnSource()).toBe("notification")
    expect(replaceState).toHaveBeenCalledWith({ kept: true }, "", "/game?game=7#turn")
    recordForegroundReturn({
      awayMs: null,
      left: { screen: "home", stage: "none", playStarted: false },
      returned: { screen: "home", stage: "none", playStarted: false },
      suspended: false,
      source: "notification",
    })
    expect(recorded.metrics[0]).toMatchObject({ attrs: { "app.return_source": "notification", "notification.moment": "start-5m" } })
  })

  it("maps an unknown reminder moment to other", () => {
    vi.stubGlobal("location", {
      search: "?jollity-notification=reminder&moment=hand-made",
      pathname: "/",
      hash: "",
    })
    vi.stubGlobal("history", { state: null, replaceState: vi.fn() })

    expect(consumeNotificationReturnSource()).toBe("notification")
    recordForegroundReturn({
      awayMs: null,
      left: { screen: "home", stage: "none", playStarted: false },
      returned: { screen: "home", stage: "none", playStarted: false },
      suspended: false,
      source: "notification",
    })
    expect(recorded.metrics[0]).toMatchObject({ attrs: { "notification.moment": "other" } })
  })

  it("keeps a legacy reminder link counting as a notification open", () => {
    const replaceState = vi.fn()
    vi.stubGlobal("location", {
      search: "?jollity-notification=reminder",
      pathname: "/",
      hash: "",
    })
    vi.stubGlobal("history", { state: null, replaceState })

    expect(consumeNotificationReturnSource()).toBe("notification")
    recordForegroundReturn({
      awayMs: null,
      left: { screen: "home", stage: "none", playStarted: false },
      returned: { screen: "home", stage: "none", playStarted: false },
      suspended: false,
      source: "notification",
    })
    expect(recorded.metrics[0]).toMatchObject({ attrs: { "app.return_source": "notification" } })
    expect(recorded.metrics[0]?.attrs).not.toHaveProperty("notification.moment")
  })
})

describe("foreground context", () => {
  it.each([
    ["/", undefined, undefined, { screen: "home", stage: "none", playStarted: false }],
    ["/", "waiting", undefined, { screen: "waiting", stage: "none", playStarted: false }],
    ["/game", undefined, undefined, { screen: "game", stage: "connecting", playStarted: false }],
    ["/game", "game.round", "warn", { screen: "game", stage: "game.round.warn", playStarted: true }],
    ["/game", "game.confirm", undefined, { screen: "game", stage: "game.confirm", playStarted: true }],
    ["/collectables", "chest", undefined, { screen: "payoff", stage: "none", playStarted: false }],
  ] as const)("classifies %s / %s / %s", (pathname, scene, moment, expected) => {
    expect(foregroundContext(pathname, scene, moment)).toEqual(expected)
  })
})

describe("foreground metrics", () => {
  it("keeps away_ms numeric and every grouping field categorical", () => {
    recordForegroundReturn({
      awayMs: 16_250,
      left: { screen: "waiting", stage: "none", playStarted: false },
      returned: { screen: "game", stage: "game.round.play", playStarted: true },
      suspended: true,
      source: "notification",
    })
    expect(recorded.metrics).toEqual([
      {
        type: "distribution",
        name: "app.away_ms",
        value: 16_250,
        unit: "millisecond",
        attrs: {
          "app.screen.from": "waiting",
          "app.screen": "game",
          "game.stage.from": "none",
          "game.stage": "game.round.play",
          "app.suspended": "true",
          "play.started": "true",
          "app.return_source": "notification",
        },
      },
      {
        type: "count",
        name: "app.resumed",
        value: 1,
        attrs: {
          "app.screen.from": "waiting",
          "app.screen": "game",
          "game.stage.from": "none",
          "game.stage": "game.round.play",
          "app.suspended": "true",
          "play.started": "true",
          "app.return_source": "notification",
        },
      },
    ])
  })

  it("counts a notification open separately without recording a resume or zero duration", () => {
    recordForegroundReturn({
      awayMs: null,
      left: { screen: "home", stage: "none", playStarted: false },
      returned: { screen: "home", stage: "none", playStarted: false },
      suspended: false,
      source: "notification",
    })
    expect(recorded.metrics.map((metric) => metric.name)).toEqual(["app.opened_from_notification"])
    expect(recorded.metrics[0]).toMatchObject({ attrs: { "app.return_source": "notification" } })
    expect(recorded.metrics[0]?.attrs).not.toHaveProperty("app.screen.from")
  })
})

describe("away intervals for the game log (#435)", () => {
  function intervalHarness(chain: { now: number | null | "throw" } = { now: 5_000_000 }) {
    let wall = 1_000
    let mono = 1_000
    let hiddenNow = false
    let onHidden = () => {}
    let onShown: (event?: { type?: string }) => void = () => {}
    let tick = () => {}
    const intervals: AwayInterval[] = []
    const opens: AwayOpen[] = []
    const runnings: AwayRunning[] = []
    const stop = watchForegroundReturns({
      wallNow: () => wall,
      monoNow: () => mono,
      pageHidden: () => hiddenNow,
      context: () => ({ screen: "game", stage: "game.round.play", playStarted: true }),
      watchPageHidden: (hide, show) => {
        onHidden = hide
        onShown = show
        return () => {}
      },
      setInterval: (callback) => {
        tick = callback
        return 1
      },
      clearInterval: () => {},
      returnSource: () => null,
      emit: () => {},
      chainNow: () => {
        if (chain.now === "throw") throw new Error("no clock")
        return chain.now
      },
      logInterval: (interval: AwayInterval) => intervals.push(interval),
      logOpen: (open: AwayOpen) => opens.push(open),
      logRunning: (running: AwayRunning) => runnings.push(running),
    })
    return {
      intervals,
      opens,
      runnings,
      stop,
      advance(ms: number, monoMs = ms) {
        wall += ms
        mono += monoMs
        if (chain.now !== null && chain.now !== "throw") chain.now += ms
      },
      hide() {
        hiddenNow = true
        onHidden()
      },
      show(event?: { type?: string }) {
        hiddenNow = false
        onShown(event)
      },
      tick: () => tick(),
    }
  }

  it("records a hide and show with wall, monotonic and chain edges", () => {
    const h = intervalHarness()
    h.advance(10)
    h.hide()
    h.advance(20_000, 20_000)
    h.show()
    expect(h.intervals).toEqual([
      {
        hiddenAtMs: 1_010,
        shownAtMs: 21_010,
        hiddenMono: 1_010,
        shownMono: 21_010,
        hiddenChainS: 5_000.01,
        shownChainS: 5_020.01,
        via: "visibility",
        from: "game",
        fromStage: "game.round.play",
        to: "game",
        toStage: "game.round.play",
        suspended: false,
        source: "other",
        seq: 1,
        startedHidden: false,
        // no tick came while hidden: that is a gap longer than a freeze
        ranHiddenMs: 0,
        suspendedHidden: true,
      },
    ])
  })

  it("logs one 'away running' line when the hidden page keeps ticking, and the interval shows the run", () => {
    const h = intervalHarness()
    h.hide()
    for (let i = 0; i < 24; i++) {
      h.advance(FOREGROUND_TICK_MS)
      h.tick()
    }
    expect(h.runnings).toEqual([{ hiddenAtMs: 1_000, hiddenMono: 1_000, ranHiddenMs: AWAY_RUNNING_LOGGED_MS, from: "game", fromStage: "game.round.play" }])
    h.show()
    expect(h.intervals[0]).toMatchObject({ ranHiddenMs: 12_000, suspendedHidden: false })
    expect(h.runnings).toHaveLength(1)
  })

  it("sees a suspension: ticks for 3 s, then a 40 s gap, is no 'away running'", () => {
    const h = intervalHarness()
    h.hide()
    for (let i = 0; i < 6; i++) {
      h.advance(FOREGROUND_TICK_MS)
      h.tick()
    }
    h.advance(40_000)
    h.tick()
    h.advance(FOREGROUND_TICK_MS)
    h.tick()
    h.show()
    expect(h.runnings).toHaveLength(0)
    expect(h.intervals[0]).toMatchObject({ ranHiddenMs: 3_000, suspendedHidden: true })
  })

  it("writes no 'away running' for a short hide", () => {
    const h = intervalHarness()
    h.hide()
    for (let i = 0; i < 12; i++) {
      h.advance(FOREGROUND_TICK_MS)
      h.tick()
    }
    h.show()
    expect(h.runnings).toHaveLength(0)
    expect(h.intervals[0]).toMatchObject({ ranHiddenMs: 6_000, suspendedHidden: false })
  })

  it("marks a pageshow return (bfcache restore) and does not record the visibility event after it twice", () => {
    const h = intervalHarness()
    h.hide()
    h.advance(8_000)
    h.show({ type: "pageshow" })
    h.show()
    expect(h.intervals.map((interval) => interval.via)).toEqual(["pageshow"])
  })

  it("records a silent freeze found by the heartbeat, with the last tick as its start", () => {
    const h = intervalHarness()
    h.advance(500)
    h.tick()
    h.advance(30_000, 0)
    h.tick()
    expect(h.intervals).toHaveLength(1)
    expect(h.intervals[0]).toMatchObject({ via: "freeze-detected", suspended: true, hiddenAtMs: 1_500, shownAtMs: 31_500, hiddenMono: 1_500, shownMono: 1_500 })
    // the chain clock reads behind across a visible freeze: no chain edges, so a reader uses the wall
    expect(h.intervals[0]).toMatchObject({ hiddenChainS: null, shownChainS: null })
  })

  it("keeps the interval with null chain edges before the chain clock has an anchor, or when it throws", () => {
    for (const now of [null, "throw"] as const) {
      const h = intervalHarness({ now })
      h.hide()
      h.advance(6_000)
      h.show()
      expect(h.intervals[0]).toMatchObject({ hiddenChainS: null, shownChainS: null, hiddenAtMs: 1_000, shownAtMs: 7_000 })
    }
  })

  it("ignores flaps shorter than the minimum and numbers the rest", () => {
    const h = intervalHarness()
    h.hide()
    h.advance(AWAY_MIN_LOGGED_MS - 1)
    h.show()
    for (let i = 0; i < 3; i++) {
      h.hide()
      h.advance(AWAY_MIN_LOGGED_MS)
      h.show()
    }
    expect(h.intervals.map((interval) => interval.seq)).toEqual([1, 2, 3])
  })

  it("writes an open marker once a hide has lasted the minimum, matched by hiddenAtMs, and none for a flap", () => {
    const h = intervalHarness()
    h.hide()
    h.advance(300)
    h.tick()
    expect(h.opens).toHaveLength(0)
    h.advance(900)
    h.tick()
    h.tick()
    expect(h.opens).toEqual([{ hiddenAtMs: 1_000, hiddenMono: 1_000, hiddenChainS: 5_000, from: "game", fromStage: "game.round.play", startedHidden: false }])
    h.advance(5_000)
    h.show()
    expect(h.intervals[0].hiddenAtMs).toBe(h.opens[0].hiddenAtMs)
  })

  it("labels an interval whose hidden edge is the install time", () => {
    let wall = 1_000
    let hiddenNow = true
    let onShown: () => void = () => {}
    const intervals: AwayInterval[] = []
    watchForegroundReturns({
      wallNow: () => wall,
      monoNow: () => wall,
      pageHidden: () => hiddenNow,
      context: () => ({ screen: "home", stage: "none", playStarted: false }),
      watchPageHidden: (_hide, show) => {
        onShown = show
        return () => {}
      },
      setInterval: () => 1,
      clearInterval: () => {},
      returnSource: () => null,
      emit: () => {},
      chainNow: () => null,
      logInterval: (interval: AwayInterval) => intervals.push(interval),
      logOpen: () => {},
    })
    wall = 9_000
    hiddenNow = false
    onShown()
    expect(intervals[0].startedHidden).toBe(true)
  })
})
