// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { payoff, startPayoff, type PayoffCommand, type PayoffEvent, type PayoffState } from "./payoff-machine"

const facts = (commands: PayoffCommand[]) =>
  commands.flatMap((command) =>
    command.kind === "telemetry"
      ? [command.fact]
      : command.kind === "end-payoff"
        ? [`endPayoff:${command.outcome}`]
        : command.kind === "hand-off"
          ? ["handOff"]
          : [],
  )

function run(events: PayoffEvent[], initial: PayoffState = startPayoff(5, "/prize-draw")) {
  let state = initial
  const commands: PayoffCommand[] = []
  for (const event of events) {
    const next = payoff(state, event)
    state = next.state
    commands.push(...next.commands)
  }
  return { state, commands }
}

const at = (type: PayoffEvent["type"], extra: Record<string, unknown> = {}) =>
  ({ type, gameIndex: 5, epoch: 0, ...extra }) as PayoffEvent

describe("payoff machine", () => {
  it.each([
    ["normal", [at("draw-result"), at("draw-continue"), at("chest-result"), at("chest-continue")]],
    ["idle advance", [at("draw-result"), at("draw-idle"), at("chest-result"), at("chest-continue")]],
  ])("keeps the %s telemetry order identical", (_, events) => {
    expect(facts(run(events).commands)).toEqual(["drawShown", "chestShown", "endPayoff:shown", "handOff"])
  })

  it("keeps the stalled telemetry order identical", () => {
    const events = [
      at("draw-result"),
      at("draw-continue"),
      at("payoff-stalled", { stage: "chest.load" }),
      at("chest-result"),
      at("chest-continue"),
    ]
    expect(facts(run(events).commands)).toEqual(["drawShown", "payoffStalled", "chestShown", "endPayoff:stalled", "handOff"])
  })

  it("keeps the unscheduled-draw telemetry order identical", () => {
    const events = [at("draw-none"), at("chest-result"), at("chest-continue")]
    expect(facts(run(events).commands)).toEqual(["drawShown", "chestShown", "endPayoff:shown", "handOff"])
  })

  it("ends once and absorbs every later event", () => {
    const ended = run([at("draw-none"), at("chest-result"), at("chest-continue")])
    const after = payoff(ended.state, at("chest-continue"))
    expect(after).toEqual({ state: ended.state, commands: [] })
    expect(facts(ended.commands)).toEqual(["drawShown", "chestShown", "endPayoff:shown", "handOff"])
  })

  it("hands a chest that is taking longer than usual off to Humanity, stalled, and only while it loads", () => {
    const reading = run([at("draw-result"), at("draw-continue")]).state
    expect(reading.kind).toBe("chest-reading")
    const skipped = run([at("payoff-stalled", { stage: "chest.slow" }), at("chest-skip")], reading)
    expect(skipped.state.kind).toBe("ended")
    expect(facts(skipped.commands)).toEqual(["payoffStalled", "endPayoff:stalled", "handOff"])

    // a chest that has shown goes on by its own Continue, never by a skip
    const showing = run([at("chest-result")], reading).state
    expect(payoff(showing, at("chest-skip"))).toEqual({ state: showing, commands: [] })
  })

  it("moves a shown draw to the chest on the 60 s idle event", () => {
    const result = run([at("draw-result"), at("draw-idle")])
    expect(result.state.kind).toBe("chest-reading")
    expect(result.commands).toContainEqual({ kind: "replace-route", route: "/chest" })
  })

  it("ignores stale game and attempt results", () => {
    const initial = startPayoff(5, "/prize-draw")
    expect(payoff(initial, { type: "draw-result", gameIndex: 4, epoch: 0 })).toEqual({ state: initial, commands: [] })
    expect(payoff(initial, { type: "draw-result", gameIndex: 5, epoch: 1 })).toEqual({ state: initial, commands: [] })

    const chest = run([at("draw-none")]).state
    const reread = payoff(chest, { type: "chest-reread-due", gameIndex: 5, epoch: 0 })
    expect(reread.state.epoch).toBe(1)
    expect(payoff(reread.state, { type: "chest-result", gameIndex: 5, epoch: 0 })).toEqual({ state: reread.state, commands: [] })
  })

  it("bootstraps a reload without commands or reopening an ended payoff", () => {
    expect(startPayoff(5, "/prize-draw")).toEqual(expect.objectContaining({ kind: "draw-waiting", gameIndex: 5, epoch: 0 }))
    const ended = startPayoff(5, "/chest", { ended: "shown" })
    expect(ended).toEqual(expect.objectContaining({ kind: "ended", outcome: "shown" }))
    expect(payoff(ended, at("chest-continue"))).toEqual({ state: ended, commands: [] })
  })

  it.each([
    "/prize-draw",
    "/chest",
  ] as const)("does not change the active %s route after a long absence", (route) => {
    const initial = startPayoff(5, route)
    expect(payoff(initial, at("return-after-long-absence"))).toEqual({ state: initial, commands: [] })
  })

  it("ends the payoff journey once at the hand-off, and sends its log", () => {
    const result = run([at("draw-none"), at("chest-result"), at("chest-continue"), at("chest-continue")])
    expect(result.commands.filter((command) => command.kind === "end-payoff" || command.kind === "hand-off")).toEqual([
      { kind: "end-payoff", outcome: "shown", cause: "handed-off", sendGameLog: true },
      { kind: "hand-off" },
    ])
  })

  it.each([
    ["next-game", "next-game"],
    ["app-gone", "app-gone"],
  ] as const)("ends a live journey as stalled on %s without sending the payoff log", (event, cause) => {
    const result = payoff(startPayoff(5, "/chest"), at(event))
    expect(result.state).toEqual(expect.objectContaining({ kind: "ended", outcome: "stalled" }))
    expect(result.commands).toEqual([{ kind: "end-payoff", outcome: "stalled", cause, sendGameLog: false }])
  })

  it("keeps injected lifecycle observations as no-ops across read epochs", () => {
    const initial = startPayoff(5, "/chest")
    const reread = payoff(initial, { type: "chest-reread-due", gameIndex: 5, epoch: 0 }).state
    expect(payoff(reread, { type: "hidden", gameIndex: 5, epoch: 0, at: 123 })).toEqual({ state: reread, commands: [] })
    expect(payoff(reread, { type: "visible", gameIndex: 5, epoch: 0, at: 130 })).toEqual({ state: reread, commands: [] })
  })
})
