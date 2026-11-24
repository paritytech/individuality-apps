// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { drawScreenDraw, type DrawCase } from "../state-machines/draw-screen.definition"
import {
  COIN_WAIT_MS,
  drawScreenStep,
  drawScreenView,
  startDrawScreen,
  type DrawAnswer,
  type DrawScreenEvent,
  type DrawScreenState,
} from "./draw-screen"

const OPENED = { gameIndex: 7, epoch: 0 }
const ANSWER = { gameIndex: 7, epoch: 3 }
const start = startDrawScreen({ game: 7, override: undefined })
const ready = (name: DrawCase): DrawAnswer => ({ kind: "ready", draw: drawScreenDraw(name), miss: null })
const answer = (name: DrawCase | "none" | "no-identity", epoch = 1): DrawScreenEvent => ({
  type: "load-answered",
  epoch,
  answer: name === "none" || name === "no-identity" ? { kind: name } : ready(name),
  payoffTag: ANSWER,
})

/** the state after `events` from a cold open, and the last step's commands */
function walk(events: readonly DrawScreenEvent[], from: DrawScreenState = start) {
  let state = drawScreenStep(from, { type: "opened", payoffTag: OPENED }).state
  let commands: ReturnType<typeof drawScreenStep>["commands"] = []
  for (const event of events) ({ state, commands } = drawScreenStep(state, event))
  return { state, commands }
}
const shown = (name: DrawCase) => ({ draw: drawScreenDraw(name), miss: null, check: expect.objectContaining({ ok: true }) })

describe("draw-screen mutation guards", () => {
  it("pins the start and a cold open", () => {
    expect(start).toEqual({ phase: "new", game: 7, override: undefined, epoch: 0 })
    expect(drawScreenStep(start, { type: "opened", payoffTag: OPENED })).toEqual({
      state: { phase: "loading", game: 7, override: undefined, epoch: 1 },
      commands: [{ kind: "log", note: { what: "opened", preloaded: "nothing" } }, { kind: "preload-chest" }, { kind: "load-draw", epoch: 1 }],
    })
  })

  it("pins a preloaded open: the wheel at once, the result with the opening tag; a preloaded no-identity still loads", () => {
    const opened = drawScreenStep(start, { type: "opened", preloaded: ready("won"), payoffTag: OPENED })
    expect(opened).toEqual({
      state: { phase: "wheel", game: 7, override: undefined, epoch: 1, answer: shown("won"), stage: "loading", intro: "off", exit: null },
      commands: [
        { kind: "log", note: { what: "opened", preloaded: "ready" } },
        { kind: "preload-chest" },
        { kind: "load-draw", epoch: 1 },
        { kind: "log", note: { what: "shows", shown: "the wheel", draw: drawScreenDraw("won") } },
        { kind: "payoff", input: { type: "draw-result" }, tag: OPENED },
        { kind: "ceremony", mark: "load-started" },
        { kind: "start-stage", held: false, coin: true, prize: true },
      ],
    })
    expect(drawScreenStep(start, { type: "opened", preloaded: { kind: "no-identity" }, payoffTag: OPENED })).toEqual({
      state: { phase: "loading", game: 7, override: undefined, epoch: 1 },
      commands: [{ kind: "log", note: { what: "opened", preloaded: "no identity" } }, { kind: "preload-chest" }, { kind: "load-draw", epoch: 1 }],
    })
    expect(drawScreenStep(start, { type: "opened", preloaded: { kind: "none" }, payoffTag: OPENED }).commands.slice(3)).toEqual([
      { kind: "log", note: { what: "no-draw" } },
      { kind: "payoff", input: { type: "draw-none" }, tag: OPENED },
    ])
  })

  it("pins every answer: none, no identity, words with and without a wheel, a spectator", () => {
    expect(walk([answer("none")])).toEqual({
      state: { phase: "none", game: 7, override: undefined, epoch: 1 },
      commands: [{ kind: "log", note: { what: "no-draw" } }, { kind: "payoff", input: { type: "draw-none" }, tag: ANSWER }],
    })
    expect(walk([answer("no-identity")])).toEqual({
      state: { phase: "no-identity", game: 7, override: undefined, epoch: 1 },
      commands: [{ kind: "log", note: { what: "shows", shown: "No player identity", draw: null } }],
    })
    expect(walk([answer("words-won")]).commands).toEqual([
      { kind: "log", note: { what: "no-wheel", reason: "the chain has no ticket list or target for this draw" } },
      { kind: "log", note: { what: "shows", shown: "You won (words, no wheel)", draw: drawScreenDraw("words-won") } },
      { kind: "payoff", input: { type: "draw-result" }, tag: ANSWER },
      { kind: "start-claim" },
      { kind: "payoff", input: { type: "draw-offered" } },
    ])
    expect(walk([answer("words-lost")]).commands.map((c) => (c.kind === "log" && c.note.what === "shows" ? c.note.shown : c.kind))).toEqual([
      "log",
      "Not this time (words, no wheel)",
      "payoff",
      "payoff",
    ])
    expect(walk([answer("words-out")]).commands[1]).toEqual({ kind: "log", note: { what: "shows", shown: "You weren't in this draw", draw: drawScreenDraw("words-out") } })
    const disagree = walk([answer("disagree")])
    expect(disagree.state).toMatchObject({ phase: "words", answer: { check: { ok: false, code: "result-disagree" } } })
    expect(disagree.commands[0]).toEqual({ kind: "log", note: { what: "no-wheel", reason: "the rule and the chain disagree on the player's result" } })
    expect(walk([answer("spectator")])).toEqual({
      state: { phase: "wheel", game: 7, override: undefined, epoch: 1, answer: shown("spectator"), stage: "loading", intro: "up", exit: null },
      commands: [
        { kind: "log", note: { what: "shows", shown: "the wheel, watching: You weren't in this draw", draw: drawScreenDraw("spectator") } },
        { kind: "payoff", input: { type: "draw-result" }, tag: ANSWER },
        { kind: "ceremony", mark: "load-started" },
        { kind: "start-stage", held: true, coin: false, prize: false },
        { kind: "arm-timer", timer: "intro-auto", ms: 8_000 },
      ],
    })
    expect(walk([answer("lost")]).commands[3]).toEqual({ kind: "start-stage", held: false, coin: true, prize: false })
  })

  it("pins the drawing message: only from loading, and Continue bypasses only there and with no identity", () => {
    expect(walk([{ type: "load-waiting", epoch: 1 }])).toEqual({
      state: { phase: "waiting", game: 7, override: undefined, epoch: 1 },
      commands: [{ kind: "log", note: { what: "shows", shown: "Drawing the winners…", draw: null } }],
    })
    expect(walk([{ type: "load-waiting", epoch: 1 }, { type: "load-waiting", epoch: 1 }]).commands).toEqual([])
    expect(walk([{ type: "load-waiting", epoch: 1 }, { type: "bypass" }]).commands).toEqual([{ kind: "payoff", input: { type: "draw-bypass" } }])
    expect(walk([answer("no-identity"), { type: "bypass" }]).commands).toEqual([{ kind: "payoff", input: { type: "draw-bypass" } }])
    expect(walk([{ type: "bypass" }]).commands).toEqual([])
    expect(walk([answer("none"), { type: "bypass" }]).commands).toEqual([])
  })

  it("pins a failed read: said so, loading or still drawing, with Continue bypassing to the chest", () => {
    const failed = {
      state: { phase: "failed", game: 7, override: undefined, epoch: 1 },
      commands: [{ kind: "log", note: { what: "shows", shown: "Couldn't load the draw", draw: null } }, { kind: "payoff", input: { type: "draw-error" } }],
    }
    expect(walk([{ type: "load-failed", epoch: 1 }])).toEqual(failed)
    expect(walk([{ type: "load-waiting", epoch: 1 }, { type: "load-failed", epoch: 1 }])).toEqual(failed)
    expect(drawScreenView(failed.state as DrawScreenState)).toEqual({ kind: "message", message: "failed" })
    expect(walk([{ type: "load-failed", epoch: 1 }, { type: "bypass" }]).commands).toEqual([{ kind: "payoff", input: { type: "draw-bypass" } }])
    for (const later of [answer("won"), { type: "load-waiting", epoch: 1 }, { type: "continue" }, { type: "idle-elapsed" }] as const)
      expect(walk([{ type: "load-failed", epoch: 1 }, later]).commands).toEqual([])
    expect(walk([answer("lost"), { type: "load-failed", epoch: 1 }]).commands).toEqual([])
  })

  it("pins the stage's mount, held and unheld, and its ending", () => {
    expect(walk([answer("spectator"), { type: "stage-mounted", held: true, progressMs: 40_000 }])).toEqual({
      state: expect.objectContaining({ stage: "mounted", intro: "up", exit: null }),
      commands: [{ kind: "ceremony", mark: "mounted" }, { kind: "arm-timer", timer: "progress", ms: 48_000 }],
    })
    const mounted = walk([answer("won"), { type: "stage-mounted", held: false, progressMs: 40_000 }])
    expect(mounted.commands[1]).toEqual({ kind: "arm-timer", timer: "progress", ms: 40_000 })
    expect(drawScreenStep(mounted.state, { type: "stage-mounted", held: false, progressMs: 40_000 }).commands).toEqual([])
    expect(drawScreenStep(mounted.state, { type: "stage-ended" })).toEqual({
      state: { ...mounted.state, stage: "offered" },
      commands: [
        { kind: "clear-timer", timer: "progress" },
        { kind: "ceremony", mark: "ended" },
        { kind: "start-claim" },
        { kind: "payoff", input: { type: "draw-offered" } },
      ],
    })
    expect(walk([answer("won"), { type: "stage-ended" }]).commands).toEqual([])
    expect(walk([answer("won"), { type: "stage-done" }]).commands).toEqual([])
    expect(drawScreenStep(mounted.state, { type: "stage-done" }).commands).toEqual([])
  })

  it("pins the bound: the coin's own while the stage waits for it, the animation's again from when it goes in, and only while the stage is up", () => {
    const mounted = walk([answer("won"), { type: "stage-mounted", held: false, progressMs: 40_000 }])
    expect(drawScreenStep(mounted.state, { type: "stage-started", progressMs: 40_000 })).toEqual({
      state: mounted.state,
      commands: [
        { kind: "clear-timer", timer: "progress" },
        { kind: "arm-timer", timer: "progress", ms: 40_000 },
      ],
    })
    expect(walk([answer("won"), { type: "stage-started", progressMs: 40_000 }]).commands).toEqual([])
    const offered = drawScreenStep(mounted.state, { type: "stage-ended" }).state
    expect(drawScreenStep(offered, { type: "stage-started", progressMs: 40_000 }).commands).toEqual([])
    // waiting at the coin: the wait's own, longer bound, so a coin that can never go in still reaches the fallback
    expect(drawScreenStep(mounted.state, { type: "stage-waiting" })).toEqual({
      state: mounted.state,
      commands: [
        { kind: "clear-timer", timer: "progress" },
        { kind: "arm-timer", timer: "progress", ms: COIN_WAIT_MS },
      ],
    })
    const stalled = drawScreenStep(drawScreenStep(mounted.state, { type: "stage-waiting" }).state, { type: "timer", timer: "progress" })
    expect(stalled.state).toEqual(expect.objectContaining({ stage: "fallback" }))
    expect(drawScreenStep(offered, { type: "stage-waiting" }).commands).toEqual([])
  })

  it("pins the intro: released at 8 s, faded over 0.5 s, and gone", () => {
    const intro = walk([answer("spectator"), { type: "timer", timer: "intro-auto" }])
    expect(intro).toEqual({
      state: expect.objectContaining({ stage: "loading", intro: "leaving" }),
      commands: [{ kind: "release-stage" }, { kind: "arm-timer", timer: "intro-out", ms: 500 }],
    })
    expect(drawScreenStep(intro.state, { type: "timer", timer: "intro-auto" }).commands).toEqual([])
    expect(drawScreenStep(intro.state, { type: "timer", timer: "intro-out" })).toEqual({ state: { ...intro.state, intro: "off" }, commands: [] })
    expect(walk([answer("spectator"), { type: "timer", timer: "intro-out" }]).commands).toEqual([])
    expect(walk([answer("won"), { type: "timer", timer: "progress" }]).commands).toEqual([])
  })

  it("pins each fallback: a load, a mount, a bound run out under the intro and as it fades", () => {
    expect(walk([answer("won"), { type: "stage-failed", reason: "load" }])).toEqual({
      state: expect.objectContaining({ stage: "fallback", intro: "off", exit: null }),
      commands: [{ kind: "ceremony-fallback", reason: "load-failed" }, { kind: "start-claim" }, { kind: "payoff", input: { type: "draw-offered" } }],
    })
    expect(walk([answer("lost"), { type: "stage-failed", reason: "mount" }]).commands).toEqual([
      { kind: "ceremony-fallback", reason: "mount-failed" },
      { kind: "payoff", input: { type: "draw-offered" } },
    ])
    const held = [answer("spectator"), { type: "stage-mounted", held: true, progressMs: 40_000 }] as const
    expect(walk([...held, { type: "timer", timer: "progress" }])).toEqual({
      state: expect.objectContaining({ stage: "fallback", intro: "off" }),
      commands: [
        { kind: "ceremony-fallback", reason: "never-ended" },
        { kind: "clear-timer", timer: "intro-auto" },
        { kind: "release-stage" },
        { kind: "payoff", input: { type: "draw-offered" } },
      ],
    })
    expect(walk([...held, { type: "timer", timer: "intro-auto" }, { type: "timer", timer: "progress" }]).commands).toEqual([
      { kind: "ceremony-fallback", reason: "never-ended" },
      { kind: "clear-timer", timer: "intro-out" },
      { kind: "payoff", input: { type: "draw-offered" } },
    ])
    const fallen = walk([answer("won"), { type: "stage-failed", reason: "mount" }]).state
    expect(drawScreenStep(fallen, { type: "stage-failed", reason: "load" }).commands).toEqual([])
    expect(drawScreenStep(fallen, { type: "stage-ended" }).commands).toEqual([])
    expect(drawScreenStep(fallen, { type: "timer", timer: "progress" }).commands).toEqual([])
  })

  it("pins leaving by tap and by idle, once, and the idle only once a way on is offered", () => {
    const mounted = [answer("won"), { type: "stage-mounted", held: false, progressMs: 40_000 }] as const
    const offered = walk([...mounted, { type: "stage-ended" }]).state
    for (const tap of [{ type: "stage-done" }, { type: "continue" }] as const)
      expect(drawScreenStep(offered, tap)).toEqual({
        state: { ...offered, exit: "tap" },
        commands: [{ kind: "ceremony-report", cause: "tap" }, { kind: "start-claim" }, { kind: "payoff", input: { type: "draw-continue" } }],
      })
    const tapped = drawScreenStep(offered, { type: "continue" }).state
    for (const again of [{ type: "continue" }, { type: "stage-done" }, { type: "idle-elapsed" }] as const) expect(drawScreenStep(tapped, again).commands).toEqual([])

    expect(drawScreenStep(offered, { type: "idle-elapsed" })).toEqual({
      state: { ...offered, exit: "idle" },
      commands: [{ kind: "ceremony-report", cause: "idle" }, { kind: "start-claim" }, { kind: "payoff", input: { type: "draw-idle" } }],
    })
    const fallen = walk([...mounted, { type: "timer", timer: "progress" }]).state
    expect(drawScreenStep(fallen, { type: "idle-elapsed" }).commands.at(-1)).toEqual({ kind: "payoff", input: { type: "draw-idle" } })
    // before a way on: no idle, however long the stage takes
    expect(walk([...mounted, { type: "idle-elapsed" }]).commands).toEqual([])
    expect(walk([answer("spectator"), { type: "stage-mounted", held: true, progressMs: 40_000 }, { type: "idle-elapsed" }]).commands).toEqual([])
    expect(walk([answer("won"), { type: "idle-elapsed" }]).commands).toEqual([])
    // the words idle too
    expect(walk([answer("words-won"), { type: "idle-elapsed" }]).commands).toEqual([{ kind: "start-claim" }, { kind: "payoff", input: { type: "draw-idle" } }])
  })

  it("pins the ceremony's marks and the report asked for at every page-left", () => {
    const wheel = walk([answer("lost")]).state
    expect(drawScreenStep(wheel, { type: "hidden" }).commands).toEqual([{ kind: "ceremony", mark: "hidden" }])
    expect(drawScreenStep(wheel, { type: "visible" }).commands).toEqual([{ kind: "ceremony", mark: "visible" }])
    expect(drawScreenStep(wheel, { type: "page-left" }).commands).toEqual([{ kind: "ceremony-report", cause: "left" }])
    for (const type of ["hidden", "visible", "page-left"] as const) expect(walk([answer("words-lost"), { type }]).commands).toEqual([])
  })

  it("pins the unmount: a spectator mid-intro, a player mid-stage, a fading intro and the words", () => {
    expect(walk([answer("spectator"), { type: "stage-mounted", held: true, progressMs: 40_000 }, { type: "unmounted" }])).toEqual({
      state: { phase: "closed", game: 7, override: undefined, epoch: 1 },
      commands: [
        { kind: "clear-timer", timer: "intro-auto" },
        { kind: "clear-timer", timer: "progress" },
        { kind: "detach-idle" },
        { kind: "destroy-stage" },
        { kind: "ceremony-report", cause: "left" },
      ],
    })
    expect(walk([answer("spectator"), { type: "timer", timer: "intro-auto" }, { type: "unmounted" }]).commands[0]).toEqual({ kind: "clear-timer", timer: "intro-out" })
    expect(walk([answer("won"), { type: "unmounted" }]).commands).toEqual([{ kind: "detach-idle" }, { kind: "destroy-stage" }, { kind: "ceremony-report", cause: "left" }])
    expect(walk([answer("words-won"), { type: "unmounted" }]).commands).toEqual([])
    expect(drawScreenStep(start, { type: "unmounted" }).state).toEqual({ phase: "closed", game: 7, override: undefined, epoch: 0 })
    const closed = walk([{ type: "unmounted" }]).state
    expect(drawScreenStep(closed, answer("won"))).toEqual({ state: closed, commands: [] })
    expect(drawScreenStep(closed, { type: "opened", payoffTag: OPENED })).toEqual({ state: closed, commands: [] })
  })

  it("pins the epoch: older and newer are both stale, and only load events carry one", () => {
    const loading = walk([]).state
    for (const epoch of [0, 2]) {
      expect(drawScreenStep(loading, answer("won", epoch))).toEqual({ state: loading, commands: [] })
      expect(drawScreenStep(loading, { type: "load-waiting", epoch })).toEqual({ state: loading, commands: [] })
    }
    expect(drawScreenStep(start, answer("won", 0))).toEqual({ state: start, commands: [] })
    expect(drawScreenStep(loading, { type: "opened", payoffTag: OPENED })).toEqual({ state: loading, commands: [] })
  })

  it("pins the claim rule: a win only, never with an override, and an empty ?player= claims as today", () => {
    expect(walk([answer("words-lost"), { type: "continue" }]).commands).toEqual([{ kind: "payoff", input: { type: "draw-continue" } }])
    const words = walk([answer("words-won")])
    expect(drawScreenStep(words.state, { type: "continue" }).commands).toEqual([{ kind: "start-claim" }, { kind: "payoff", input: { type: "draw-continue" } }])
    const overridden = walk([answer("words-won")], startDrawScreen({ game: 7, override: "5Grw" }))
    expect(overridden.commands.map((c) => c.kind)).not.toContain("start-claim")
    expect(walk([answer("words-won")], startDrawScreen({ game: 7, override: "" })).commands.map((c) => c.kind)).toContain("start-claim")
  })

  it("pins a second answer after a preloaded one: logged again, the words claim again, nothing else", () => {
    const words = walk([answer("words-won")]).state
    expect(drawScreenStep(words, answer("words-won"))).toEqual({
      state: words,
      commands: [{ kind: "log", note: { what: "shows", shown: "You won (words, no wheel)", draw: drawScreenDraw("words-won") } }, { kind: "start-claim" }],
    })
    expect(drawScreenStep(words, answer("none")).commands).toEqual([])
    const wheel = walk([answer("won")]).state
    expect(drawScreenStep(wheel, answer("won"))).toEqual({
      state: wheel,
      commands: [{ kind: "log", note: { what: "shows", shown: "the wheel", draw: drawScreenDraw("won") } }],
    })
    expect(drawScreenStep(wheel, answer("no-identity")).commands).toEqual([])
    expect(drawScreenStep(walk([answer("none")]).state, answer("won")).commands).toEqual([])
    expect(drawScreenStep(walk([answer("no-identity")]).state, answer("won")).commands).toEqual([])
  })

  it("pins the view of every phase", () => {
    expect(drawScreenView(start)).toEqual({ kind: "blank" })
    expect(drawScreenView(walk([]).state)).toEqual({ kind: "blank" })
    expect(drawScreenView(walk([{ type: "load-waiting", epoch: 1 }]).state)).toEqual({ kind: "message", message: "waiting" })
    expect(drawScreenView(walk([answer("no-identity")]).state)).toEqual({ kind: "message", message: "no-identity" })
    expect(drawScreenView(walk([answer("none")]).state)).toEqual({ kind: "blank", label: "Opening the chest" })
    expect(drawScreenView(walk([answer("words-out")]).state)).toEqual({ kind: "words", draw: drawScreenDraw("words-out"), miss: null })
    const spectator = walk([answer("spectator")]).state
    expect(drawScreenView(spectator)).toEqual({ kind: "wheel", draw: drawScreenDraw("spectator"), miss: null, intro: "up", fallback: false, offered: false })
    expect(drawScreenView(drawScreenStep(spectator, { type: "timer", timer: "intro-auto" }).state)).toMatchObject({ intro: "leaving", fallback: false })
    expect(drawScreenView(drawScreenStep(spectator, { type: "stage-failed", reason: "load" }).state)).toMatchObject({ intro: null, fallback: true })
    expect(drawScreenView(walk([{ type: "unmounted" }]).state)).toEqual({ kind: "blank" })
  })
})
