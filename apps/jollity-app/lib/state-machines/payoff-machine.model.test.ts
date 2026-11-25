// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * MODEL-BASED PROPERTY TESTS for the payoff machine (step 0).
 *
 * Seeded random journeys (fixed seeds, mulberry32) send every event type
 * with the current tag, a stale epoch, another game's index, duplicates and
 * out-of-order answers. After every event the transition is checked against
 * a small independent model of §7's diagram and the step 0 contract:
 *
 *   draw-waiting → draw-showing → collectables-reading → collectables-showing
 *        └─(no draw / bypass)──────┘        └─(skip)──┐     ↓ (Continue)
 *                                                    ended(shown | stalled) + hand-off
 *
 * plus: one end per journey, the log only with the hand-off, stale
 * answers inert, drawShown and payoffStalled at most once, the route only
 * moving forward, the epoch never going back, lifecycle observations inert.
 */
import { describe, expect, it } from "vitest"
import {
  payoff,
  payoffTag,
  startPayoff,
  type PayoffActiveKind,
  type PayoffInput,
  type PayoffRoute,
  type PayoffState,
  type PayoffTag,
} from "../payoff-machine"
import { int, pick, rng } from "./turn-books.harness"

type Kind = PayoffActiveKind | "ended"

/** §7's edges; every other kind change is a violation */
const EDGES: Record<Kind, Kind[]> = {
  "draw-waiting": ["draw-showing", "collectables-reading", "ended"],
  "draw-showing": ["collectables-reading", "ended"],
  "collectables-reading": ["collectables-showing", "ended"],
  "collectables-showing": ["ended"],
  ended: [],
}
const ROUTE_ORDER: PayoffRoute[] = ["/prize-draw", "/collectables"]

const INPUTS: PayoffInput[] = [
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
  { type: "hidden", at: 0 },
  { type: "visible", at: 1 },
]
/** the forward path, weighted so journeys reach the end often */
const FORWARD: PayoffInput[] = [
  { type: "draw-result" },
  { type: "draw-offered" },
  { type: "draw-continue" },
  { type: "collectables-opened" },
  { type: "collectables-result" },
  { type: "collectables-continue" },
]
/** the event that makes each end */
const END_EVENT: Record<string, string[]> = {
  "handed-off": ["collectables-continue", "collectables-skip"],
  "next-game": ["next-game"],
  "app-gone": ["app-gone"],
}
const LIFECYCLE = new Set(["hidden", "visible", "return-after-long-absence"])

interface Journey {
  violations: string[]
  ended: boolean
  outcome?: string
  log: string[]
}

function journey(seed: number): Journey {
  const random = rng(seed)
  const game = 50 + int(random, 0, 3)
  const route = pick(random, ROUTE_ORDER)
  let state: PayoffState = startPayoff(game, route)
  const violations: string[] = []
  const log: string[] = [`start ${route}`]
  const oldTags: PayoffTag[] = [payoffTag(state)]
  let ends = 0
  let drawShown = 0
  let stalls = 0
  let stalledAccepted = false
  let outcome: string | undefined

  for (let step = 0; step < 60; step++) {
    const roll = random()
    const event = roll < 0.45 ? pick(random, FORWARD) : pick(random, INPUTS)
    const tagRoll = random()
    const current = payoffTag(state)
    const tag: PayoffTag =
      tagRoll < 0.75
        ? current
        : tagRoll < 0.9
          ? pick(random, oldTags)
          : { gameIndex: current.gameIndex + pick(random, [-1, 1]), epoch: current.epoch }
    const stale = tag.gameIndex !== current.gameIndex || tag.epoch !== current.epoch
    const before = state
    const { state: after, commands } = payoff(state, { ...event, ...tag } as Parameters<typeof payoff>[1])
    const what = `${event.type}${stale ? " (stale)" : ""} in ${before.kind}`
    log.push(what)

    // stale, terminal and lifecycle inputs are inert
    if (stale || before.kind === "ended" || LIFECYCLE.has(event.type)) {
      if (commands.length > 0) violations.push(`${what}: emitted ${JSON.stringify(commands)}`)
      if (JSON.stringify(after) !== JSON.stringify(before)) violations.push(`${what}: state changed`)
    }
    // §7's edges only
    if (after.kind !== before.kind && !EDGES[before.kind].includes(after.kind)) violations.push(`${what}: ${before.kind} → ${after.kind}`)
    // the route only moves forward, and every replace-route names the new route
    if (ROUTE_ORDER.indexOf(after.route) < ROUTE_ORDER.indexOf(before.route)) violations.push(`${what}: route back to ${after.route}`)
    for (const c of commands) if (c.kind === "replace-route" && c.route !== after.route) violations.push(`${what}: replace-route ${c.route} but state route ${after.route}`)
    // the epoch never goes back; the game never changes
    if (after.epoch < before.epoch) violations.push(`${what}: epoch went back`)
    if (after.gameIndex !== before.gameIndex) violations.push(`${what}: game changed`)
    // the end: exactly on entering `ended`, once
    const endCommands = commands.filter((c) => c.kind === "end-payoff")
    if ((after.kind === "ended") !== (before.kind === "ended" || endCommands.length > 0))
      violations.push(`${what}: ended without end-payoff, or end-payoff without ending`)
    for (const c of endCommands) {
      if (c.kind !== "end-payoff") continue
      ends++
      outcome = c.outcome
      if (!END_EVENT[c.cause]?.includes(event.type)) violations.push(`${what}: end cause ${c.cause}`)
      if (c.sendGameLog !== (c.cause === "handed-off")) violations.push(`${what}: sendGameLog ${c.sendGameLog} for ${c.cause}`)
      if (c.outcome !== "shown" && c.outcome !== "stalled") violations.push(`${what}: outcome ${c.outcome}`)
      const expected = c.cause === "handed-off" && !stalledAccepted ? "shown" : "stalled"
      if (c.outcome !== expected) violations.push(`${what}: outcome ${c.outcome}, model ${expected}`)
      if (after.kind === "ended" && after.outcome !== c.outcome) violations.push(`${what}: state outcome differs from command`)
    }
    // the hand-off: only leaving a shown collectables screen, or skipping one still reading, and only with the end
    const handOffs = commands.filter((c) => c.kind === "hand-off").length
    if (handOffs !== (endCommands.some((c) => c.kind === "end-payoff" && c.cause === "handed-off") ? 1 : 0))
      violations.push(`${what}: ${handOffs} hand-offs`)
    if (handOffs > 0 && !(before.kind === "collectables-showing" && event.type === "collectables-continue") && !(before.kind === "collectables-reading" && event.type === "collectables-skip"))
      violations.push(`${what}: handed off from ${before.kind}`)
    // facts at most once
    for (const c of commands) {
      if (c.kind === "telemetry" && c.fact === "drawShown") drawShown++
      if (c.kind === "telemetry" && c.fact === "payoffStalled") {
        stalls++
        stalledAccepted = true
      }
      // the idle is armed only once the shown draw offers a way on, and cancelled whenever the draw is left onward
      if (c.kind === "arm-draw-idle" && !(before.kind === "draw-showing" && event.type === "draw-offered")) violations.push(`${what}: armed the idle`)
    }
    if (before.kind === "draw-showing" && after.kind === "collectables-reading" && !commands.some((c) => c.kind === "cancel-draw-idle"))
      violations.push(`${what}: left the draw without cancelling the idle`)
    if (after.kind === "draw-showing" && before.kind !== "draw-showing" && event.type !== "draw-result") violations.push(`${what}: draw shown without a draw result`)

    if (after.epoch !== before.epoch) oldTags.push(payoffTag(before))
    state = after
  }
  if (ends > 1) violations.push(`${ends} ends`)
  if (drawShown > 1) violations.push(`drawShown ×${drawShown}`)
  if (stalls > 1) violations.push(`payoffStalled ×${stalls}`)
  return { violations, ended: state.kind === "ended", outcome, log }
}

const SEEDS = Array.from({ length: 2000 }, (_, i) => 77 + i * 104729)

describe("payoff machine agrees with the model of §7 and the step 0 contract", () => {
  it("the generator is not vacuous: journeys end every way, shown and stalled", () => {
    const outcomes = new Map<string, number>()
    let ended = 0
    for (const seed of SEEDS) {
      const j = journey(seed)
      if (j.ended) ended++
      if (j.outcome) outcomes.set(j.outcome, (outcomes.get(j.outcome) ?? 0) + 1)
    }
    expect(ended).toBeGreaterThan(SEEDS.length / 2)
    expect(outcomes.get("shown") ?? 0).toBeGreaterThan(50)
    expect(outcomes.get("stalled") ?? 0).toBeGreaterThan(50)
  })

  it("no random journey violates an edge, the end rules, staleness or the fact counts", () => {
    const bad: string[] = []
    for (const seed of SEEDS) {
      const j = journey(seed)
      if (j.violations.length > 0) bad.push(`seed ${seed}: ${j.violations.slice(0, 3).join("; ")} | ${j.log.join(", ")}`)
    }
    expect(bad).toEqual([])
  })
})
