// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * INDEPENDENT CONTRACT TESTS for the payoff machine, written from its
 * contract and its five gates, not from the implementation, plus the
 * settled rules: the payoff ends once per journey, outcomes are
 * shown | stalled only, the game log goes only with the hand-off to Humanity
 * that leaving the collectables screen makes, stale
 * async answers never change state, and the draw moves on after 60 s idle.
 *
 * Black-box through the exported API: the reducer (`payoff`, `startPayoff`,
 * `payoffTag`), the page runners and their command executors, and the draw
 * idle timer that executes the 60 s rule.
 *
 * A test marked `it.fails` is a FINDING: the expected rule is stated above
 * it, with the sequence and what the code did instead.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  payoff,
  payoffTag,
  startPayoff,
  type PayoffCommand,
  type PayoffInput,
  type PayoffRoute,
  type PayoffState,
  type PayoffTag,
} from "../payoff-machine"
import { createPayoffScreenRunner, executeCollectablesCommands, sendCollectablesPageResult } from "../payoff-screen-runner"
import { createPrizeDrawPayoffRunner, executePrizeDrawCommands } from "../draw/payoff-runner"
import { DRAW_IDLE_MS, createDrawIdle } from "../draw/draw-idle"
import { resetPayoffSessionsForTest } from "../payoff-session"

const GAME = 41

/** drives the reducer like a page: every event carries the current tag unless given one */
class Journey {
  state: PayoffState
  commands: PayoffCommand[] = []
  constructor(route: PayoffRoute = "/prize-draw", gameIndex = GAME) {
    this.state = startPayoff(gameIndex, route)
  }
  tag(): PayoffTag {
    return payoffTag(this.state)
  }
  send(event: PayoffInput, tag: PayoffTag = this.tag()): PayoffCommand[] {
    const next = payoff(this.state, { ...event, ...tag } as Parameters<typeof payoff>[1])
    this.state = next.state
    this.commands.push(...next.commands)
    return next.commands
  }
  facts(): string[] {
    return this.commands.flatMap((c) =>
      c.kind === "telemetry"
        ? [c.fact]
        : c.kind === "end-payoff"
          ? [`end:${c.outcome}:${c.cause}:${c.sendGameLog ? "log" : "nolog"}`]
          : c.kind === "hand-off"
            ? ["hand-off"]
            : [],
    )
  }
  ends(): Extract<PayoffCommand, { kind: "end-payoff" }>[] {
    return this.commands.filter((c): c is Extract<PayoffCommand, { kind: "end-payoff" }> => c.kind === "end-payoff")
  }
  routes(): PayoffRoute[] {
    return this.commands.flatMap((c) => (c.kind === "replace-route" ? [c.route] : []))
  }
}

const EVERY_INPUT: PayoffInput[] = [
  { type: "draw-result" },
  { type: "draw-none" },
  { type: "draw-bypass" },
  { type: "draw-continue" },
  { type: "draw-idle" },
  { type: "draw-error" },
  { type: "draw-offered" },
  { type: "collectables-opened" },
  { type: "collectables-result" },
  { type: "collectables-error" },
  { type: "collectables-reread-due" },
  { type: "collectables-continue" },
  { type: "collectables-skip" },
  { type: "payoff-stalled", stage: "chest.load" },
  { type: "next-game" },
  { type: "return-after-long-absence" },
  { type: "app-gone" },
  { type: "hidden", at: 1 },
  { type: "visible", at: 2 },
]

/** the normal path through a game with a draw */
function normalPath(j: Journey): void {
  j.send({ type: "draw-result" })
  j.send({ type: "draw-continue" })
  j.send({ type: "collectables-opened" })
  j.send({ type: "collectables-result" })
  j.send({ type: "collectables-continue" })
}

describe("step 0 contract — one end per payoff journey", () => {
  it("the normal path ends once, as shown, with the game log", () => {
    const j = new Journey()
    normalPath(j)
    expect(j.state.kind).toBe("ended")
    expect(j.ends()).toEqual([{ kind: "end-payoff", outcome: "shown", cause: "handed-off", sendGameLog: true }])
    expect(j.commands.at(-1)).toEqual({ kind: "hand-off" })
  })

  it.each(EVERY_INPUT)("after the end, $type emits nothing and re-enters no active state", (event) => {
    const j = new Journey()
    normalPath(j)
    const ended = j.state
    expect(j.send(event)).toEqual([])
    expect(j.state).toEqual(ended)
  })

  it("every way to end ends once: the hand-off, the next game, the app going away", () => {
    for (const end of [{ type: "next-game" }, { type: "app-gone" }] as PayoffInput[]) {
      const j = new Journey()
      j.send({ type: "draw-result" })
      j.send(end)
      j.send(end)
      j.send({ type: "collectables-continue" })
      expect(j.ends()).toHaveLength(1)
    }
  })

  it("the outcomes are shown | stalled only, and only the hand-off sends the game log", () => {
    const outcomes = new Set<string>()
    for (const end of ["handed-off", "next-game", "app-gone"] as const)
      for (const stall of [false, true]) {
        const j = new Journey("/collectables")
        if (stall) j.send({ type: "payoff-stalled", stage: "chest.load" })
        j.send({ type: "collectables-result" })
        j.send({ type: end === "handed-off" ? "collectables-continue" : end })
        const [ended] = j.ends()
        expect(ended, `${end} ${stall}`).toBeDefined()
        outcomes.add(ended.outcome)
        expect(ended.sendGameLog, `${end}`).toBe(end === "handed-off")
        if (end !== "handed-off") expect(ended.outcome).toBe("stalled")
      }
    expect([...outcomes].sort()).toEqual(["shown", "stalled"])
  })

  it("a payoff that stalled and then handed off ends stalled, and still sends the log", () => {
    const j = new Journey("/collectables")
    j.send({ type: "payoff-stalled", stage: "chest.load" })
    j.send({ type: "collectables-result" })
    j.send({ type: "collectables-continue" })
    expect(j.ends()).toEqual([{ kind: "end-payoff", outcome: "stalled", cause: "handed-off", sendGameLog: true }])
  })

  it("only a shown collectables screen's Continue, or the skip of a collectables screen still reading, hands off", () => {
    const draw = new Journey("/prize-draw")
    draw.send({ type: "collectables-continue" })
    draw.send({ type: "collectables-skip" })
    expect(draw.ends()).toEqual([])
    const reading = new Journey("/collectables")
    reading.send({ type: "collectables-continue" })
    expect(reading.ends()).toEqual([])
    const showing = new Journey("/collectables")
    showing.send({ type: "collectables-result" })
    showing.send({ type: "collectables-skip" })
    expect(showing.ends()).toEqual([])
    for (const j of [draw, reading, showing]) expect(j.state.kind).not.toBe("ended")
  })
})

describe("step 0 contract — stale async answers never change state", () => {
  it("a collectables read from an earlier attempt is ignored after the re-read", () => {
    const j = new Journey("/collectables")
    const first = j.tag()
    j.send({ type: "collectables-reread-due" })
    const before = j.state
    expect(j.send({ type: "collectables-result" }, first)).toEqual([])
    expect(j.state).toEqual(before)
    expect(j.send({ type: "collectables-result" })).toEqual([{ kind: "telemetry", fact: "collectablesShown" }])
  })

  it("an answer for another game is ignored, every event type", () => {
    for (const event of EVERY_INPUT) {
      const j = new Journey()
      const before = j.state
      expect(j.send(event, { gameIndex: GAME - 1, epoch: 0 }), event.type).toEqual([])
      expect(j.state).toEqual(before)
    }
  })

  it("the epoch never goes back, and a duplicated re-read answer counts once", () => {
    const j = new Journey("/collectables")
    j.send({ type: "collectables-reread-due" })
    j.send({ type: "collectables-reread-due" })
    const tag = j.tag()
    expect(tag.epoch).toBe(2)
    j.send({ type: "collectables-result" }, tag)
    j.send({ type: "collectables-result" }, tag)
    expect(j.facts().filter((f) => f === "collectablesShown")).toHaveLength(1)
    expect(j.state.epoch).toBe(2)
  })

  it("a duplicated draw answer emits drawShown once; a contradicting late draw-none does not move the route", () => {
    const j = new Journey()
    j.send({ type: "draw-result" })
    j.send({ type: "draw-result" })
    j.send({ type: "draw-none" })
    expect(j.facts()).toEqual(["drawShown"])
    expect(j.state.kind).toBe("draw-showing")
    expect(j.routes()).toEqual([])
  })

  it("a collectables answer that lands after the player left for Humanity changes nothing", () => {
    const j = new Journey("/collectables")
    const read = j.tag()
    j.send({ type: "collectables-result" })
    j.send({ type: "collectables-continue" })
    const before = j.state
    expect(j.send({ type: "collectables-result" }, read)).toEqual([])
    expect(j.state).toEqual(before)
  })
})

describe("step 0 contract — the draw never holds the collectables screen past the idle rule", () => {
  it("a way on offered arms the 60 s idle, the draw coming up does not; the idle moves on to the collectables screen without marking the draw seen", () => {
    const j = new Journey()
    expect(j.send({ type: "draw-result" })).not.toContainEqual({ kind: "arm-draw-idle" })
    expect(j.send({ type: "draw-offered" })).toEqual([{ kind: "arm-draw-idle" }])
    const cmds = j.send({ type: "draw-idle" })
    expect(j.state.kind).toBe("collectables-reading")
    expect(cmds).toContainEqual({ kind: "replace-route", route: "/collectables" })
    expect(cmds).toContainEqual({ kind: "load-collectables" })
    expect(cmds).not.toContainEqual({ kind: "mark-draw-seen" })
  })

  it("Continue moves on and marks the draw seen; both ways cancel the idle", () => {
    const j = new Journey()
    j.send({ type: "draw-result" })
    const cmds = j.send({ type: "draw-continue" })
    expect(cmds).toContainEqual({ kind: "mark-draw-seen" })
    expect(cmds).toContainEqual({ kind: "cancel-draw-idle" })
  })

  it("a game with no draw goes straight to the collectables screen, emitting drawShown once", () => {
    const j = new Journey()
    j.send({ type: "draw-none" })
    expect(j.state.kind).toBe("collectables-reading")
    expect(j.facts()).toEqual(["drawShown"])
    expect(j.routes()).toEqual(["/collectables"])
  })

  it("an idle that fires after Continue already moved on is a no-op (one route change)", () => {
    const j = new Journey()
    j.send({ type: "draw-result" })
    j.send({ type: "draw-continue" })
    j.send({ type: "draw-idle" })
    expect(j.routes()).toEqual(["/collectables"])
  })

  describe("the idle timer (the executor of the 60 s rule)", () => {
    function idle(device = { t: 1_000_000 }, mono = { t: 0 }, store = new Map<string, string>(), unloading = false) {
      const timers: { at: number; fn: () => void; live: boolean }[] = []
      const visible: (() => void)[] = []
      const onAdvance = vi.fn()
      const idleTimer = createDrawIdle({
        key: "g41",
        onAdvance,
        deviceNowMs: () => device.t,
        monoNowMs: () => mono.t,
        store: { get: (k) => store.get(k) ?? null, set: (k, v) => void store.set(k, v), remove: (k) => void store.delete(k) },
        setTimer: (fn, ms) => {
          const timer = { at: mono.t + ms, fn, live: true }
          timers.push(timer)
          return () => void (timer.live = false)
        },
        onVisible: (fn) => {
          visible.push(fn)
          return () => {}
        },
        unloading: () => unloading,
      })
      const advance = (ms: number) => {
        device.t += ms
        mono.t += ms
        for (const timer of [...timers])
          if (timer.live && timer.at <= mono.t) {
            timer.live = false
            timer.fn()
          }
      }
      const wake = () => visible.forEach((fn) => fn())
      return { idleTimer, onAdvance, advance, wake, device, mono, store }
    }

    it("is 60 s", () => {
      expect(DRAW_IDLE_MS).toBe(60_000)
    })

    it("moves on after 60 s without a tap, once", () => {
      const t = idle()
      t.idleTimer.start()
      t.advance(59_999)
      expect(t.onAdvance).not.toHaveBeenCalled()
      t.advance(1)
      t.advance(120_000)
      expect(t.onAdvance).toHaveBeenCalledTimes(1)
    })

    it("a tap restarts the 60 s", () => {
      const t = idle()
      t.idleTimer.start()
      t.advance(50_000)
      t.idleTimer.touch()
      t.advance(50_000)
      expect(t.onAdvance).not.toHaveBeenCalled()
      t.advance(10_000)
      expect(t.onAdvance).toHaveBeenCalledTimes(1)
    })

    it("the larger of the monotonic and device clocks counts (a suspended device stops the monotonic one)", () => {
      const t = idle()
      t.idleTimer.start()
      t.device.t += 61_000 // the phone slept: wall time moved, the monotonic clock did not
      t.wake() // the page comes back visible
      expect(t.onAdvance).toHaveBeenCalledTimes(1)
    })

    it("a reload keeps the start: the 60 s are not granted again", () => {
      const store = new Map<string, string>()
      const device = { t: 1_000_000 }
      const first = idle(device, { t: 0 }, store, true)
      first.idleTimer.start()
      first.advance(40_000)
      first.idleTimer.detach() // the page unloads: the stored start is kept
      // the reloaded page's monotonic clock starts again from zero
      const second = idle(device, { t: 0 }, store)
      second.idleTimer.start()
      second.advance(20_000)
      expect(second.onAdvance).toHaveBeenCalledTimes(1)
    })
  })
})

describe("step 0 gates", () => {
  it("gate 1: the normal path's facts in order", () => {
    const j = new Journey()
    normalPath(j)
    expect(j.facts()).toEqual(["drawShown", "collectablesOpened", "collectablesShown", "end:shown:handed-off:log", "hand-off"])
  })

  it("gate 1: the 60 s idle advance's facts in order", () => {
    const j = new Journey()
    j.send({ type: "draw-result" })
    j.send({ type: "draw-idle" })
    j.send({ type: "collectables-opened" })
    j.send({ type: "collectables-result" })
    j.send({ type: "collectables-continue" })
    expect(j.facts()).toEqual(["drawShown", "collectablesOpened", "collectablesShown", "end:shown:handed-off:log", "hand-off"])
  })

  it("gate 1: a collectables screen stall's facts in order, the stall reported once", () => {
    const j = new Journey()
    j.send({ type: "draw-result" })
    j.send({ type: "draw-continue" })
    j.send({ type: "collectables-opened" })
    j.send({ type: "collectables-error" })
    j.send({ type: "payoff-stalled", stage: "chest.load" })
    j.send({ type: "collectables-reread-due" })
    j.send({ type: "payoff-stalled", stage: "chest.load" })
    j.send({ type: "collectables-result" })
    j.send({ type: "collectables-continue" })
    expect(j.facts()).toEqual(["drawShown", "collectablesOpened", "payoffStalled", "collectablesShown", "end:stalled:handed-off:log", "hand-off"])
  })

  it("gate 1: a game with no draw", () => {
    const j = new Journey()
    j.send({ type: "draw-none" })
    j.send({ type: "collectables-opened" })
    j.send({ type: "collectables-result" })
    j.send({ type: "collectables-continue" })
    expect(j.facts()).toEqual(["drawShown", "collectablesOpened", "collectablesShown", "end:shown:handed-off:log", "hand-off"])
  })

  it("gate 2: a reload bootstrap emits nothing, on every route", () => {
    for (const route of ["/prize-draw", "/collectables"] as PayoffRoute[]) {
      const state = startPayoff(GAME, route)
      expect(state.kind).not.toBe("ended")
      expect(state.route).toBe(route)
    }
  })

  it.each(["/prize-draw", "/collectables"] as PayoffRoute[])("gate 2: a reload of an ended payoff on %s never re-opens it", (route) => {
    const state = startPayoff(GAME, route, { ended: "shown", epoch: 3 })
    expect(state.kind).toBe("ended")
    for (const event of EVERY_INPUT) {
      const next = payoff(state, { ...event, ...payoffTag(state) } as Parameters<typeof payoff>[1])
      expect(next.commands, event.type).toEqual([])
      expect(next.state).toEqual(state)
    }
  })

  it("gate 3: the commands of a whole payoff run every fact once", () => {
    const handlers = {
      drawShown: vi.fn(),
      markDrawSeen: vi.fn(),
      replaceCollectables: vi.fn(),
      collectablesOpened: vi.fn(),
      collectablesShown: vi.fn(),
      payoffStalled: vi.fn(),
      payoffEnded: vi.fn(),
      handOff: vi.fn(),
      armIdle: vi.fn(),
      cancelIdle: vi.fn(),
      loadCollectables: vi.fn(),
    }
    const j = new Journey()
    normalPath(j)
    executePrizeDrawCommands(j.commands, handlers)
    executeCollectablesCommands(j.commands, handlers)
    for (const fact of ["drawShown", "markDrawSeen", "collectablesOpened", "collectablesShown", "payoffEnded", "handOff", "cancelIdle"] as const)
      expect(handlers[fact], fact).toHaveBeenCalledTimes(1)
  })

  it.each(["draw-waiting", "draw-showing", "collectables-reading", "collectables-showing"])(
    "gate 4: a return after a long absence in %s keeps the screen and its route",
    (kind) => {
      const j = new Journey()
      const steps: Record<string, PayoffInput[]> = {
        "draw-waiting": [],
        "draw-showing": [{ type: "draw-result" }],
        "collectables-reading": [{ type: "draw-result" }, { type: "draw-continue" }],
        "collectables-showing": [{ type: "draw-result" }, { type: "draw-continue" }, { type: "collectables-result" }],
      }
      for (const step of steps[kind]) j.send(step)
      expect(j.state.kind).toBe(kind)
      const before = j.state
      expect(j.send({ type: "hidden", at: 0 })).toEqual([])
      expect(j.send({ type: "return-after-long-absence" })).toEqual([])
      expect(j.send({ type: "visible", at: 60 * 60_000 })).toEqual([])
      expect(j.state).toEqual(before)
    },
  )

  it("no Date.now (or any clock) in the reducer", () => {
    const source = readFileSync(join(__dirname, "..", "payoff-machine.ts"), "utf8")
    expect(source).not.toMatch(/Date\.now|performance\.now|new Date\(/)
  })
})

describe("adversarial — the page runners", () => {
  beforeEach(() => resetPayoffSessionsForTest())

  it("the next game starting during the payoff ends it once, without the log, and later answers are ignored", () => {
    const runner = createPayoffScreenRunner(GAME, "/collectables")
    const read = runner.capture()
    const end = runner.send({ type: "next-game" })
    expect(end).toEqual([{ kind: "end-payoff", outcome: "stalled", cause: "next-game", sendGameLog: false }])
    expect(runner.send({ type: "collectables-result" }, read)).toEqual([])
    expect(runner.send({ type: "collectables-continue" })).toEqual([])
  })

  it("a collectables screen restart card uses the current epoch, so it is not dropped as stale", () => {
    const runner = createPayoffScreenRunner(GAME, "/collectables")
    const oldRead = runner.capture()
    runner.send({ type: "collectables-reread-due" })
    expect(sendCollectablesPageResult(runner, oldRead, true)).toEqual([{ kind: "telemetry", fact: "collectablesShown" }])
  })

  it("a normal collectables result from a superseded read is dropped", () => {
    const runner = createPayoffScreenRunner(GAME, "/collectables")
    const oldRead = runner.capture()
    runner.send({ type: "collectables-reread-due" })
    expect(sendCollectablesPageResult(runner, oldRead, false)).toEqual([])
  })

  it("reload mid-collectables: the new runner starts silent at the collectables read", () => {
    const before = createPayoffScreenRunner(GAME, "/collectables")
    before.send({ type: "collectables-opened" })
    resetPayoffSessionsForTest()
    const after = createPayoffScreenRunner(GAME, "/collectables")
    expect(after.current().kind).toBe("collectables-reading")
    expect(after.current().epoch).toBe(0)
  })

  it("the prize-draw runner keeps a load attempt's tag: an answer captured before the game changed is dropped", () => {
    const runner = createPrizeDrawPayoffRunner(GAME)
    expect(runner.send({ type: "draw-result" }, { gameIndex: GAME + 1, epoch: 0 })).toEqual([])
    expect(runner.current().kind).toBe("draw-waiting")
  })

  // The shared per-game payoff session keeps a stall on the draw across the
  // client-side /prize-draw -> /collectables route replacement.
  it("a stall on the draw is still the payoff's outcome when the collectables screen hands off", () => {
    const draw = createPrizeDrawPayoffRunner(GAME)
    draw.send({ type: "payoff-stalled", stage: "draw.load" })
    draw.send({ type: "draw-result" })
    draw.send({ type: "draw-continue" })
    const collectables = createPayoffScreenRunner(GAME, "/collectables")
    collectables.send({ type: "collectables-result" })
    const [end] = collectables.send({ type: "collectables-continue" }).filter((c) => c.kind === "end-payoff")
    expect(end).toMatchObject({ outcome: "stalled" })
  })
})
