// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import type { ChestItem } from "@jollity/collectables"
import { COLLECT_MS } from "../chest-collect"
import { SLOW_PAYOFF_MS } from "../slow-payoff"
import {
  chestScreenStep,
  chestScreenView,
  classifyChest,
  startChestScreen,
  type ChestAnswer,
  type ChestScreenEvent,
  type ChestScreenState,
} from "./chest-screen"

const TAG = { gameIndex: 7, epoch: 3 }
const item = (n: number): ChestItem => ({
  hash: `0x${n.toString(16).padStart(64, "0")}`,
  proof: null,
  state: "claimable",
  name: `Piece ${n}`,
  rarity: "common",
  image: `art:${n}`,
  collection: "Coffee and Tea",
  choices: [
    { collectionId: 17, collection: "Coffee and Tea", name: `Piece ${n}`, rarity: "common", image: `art:${n}` },
    { collectionId: 18, collection: "Jobs", name: `Job ${n}`, rarity: "common", image: `job:${n}` },
  ],
})
const TWO = [item(1), item(2)]
const claims = (settling = false, items = TWO): ChestAnswer => ({ kind: "claims", game: 7, seed: "p:7", items, settling, partial: false })

function walk(events: ((state: ChestScreenState) => ChestScreenEvent)[], from = startChestScreen()) {
  let state = from
  let commands: ReturnType<typeof chestScreenStep>["commands"] = []
  for (const event of events) ({ state, commands } = chestScreenStep(state, event(state)))
  return { state, commands }
}
const opened = () => ({ type: "opened" }) as const
const source = (seed: string | null = "p:7") => () => ({ type: "source", seed, game: 7 }) as const
const answer = (a: ChestAnswer) => (state: ChestScreenState): ChestScreenEvent => ({ type: "answered", epoch: state.epoch, answer: a, tag: TAG })
const is = (type: "landed" | "vessel-opened" | "cta" | "album-done" | "reread-due" | "load-chest" | "unmounted") => () => ({ type }) as ChestScreenEvent
const timer = (name: "slow" | "collect") => () => ({ type: "timer", timer: name }) as const
const collected = (count: number) => () => ({ type: "collected", count }) as const
const settled = (items: ChestItem[]) => (state: ChestScreenState): ChestScreenEvent => ({ type: "settled", epoch: state.epoch, items, partial: false })
const came = (items: ChestItem[]) => (state: ChestScreenState): ChestScreenEvent => ({ type: "came", epoch: state.epoch, items })

describe("chest-screen mutation guards", () => {
  it("pins a cold open: the payoff hears it, the slow wait, the feed", () => {
    expect(chestScreenStep(startChestScreen(), { type: "opened" }).commands).toEqual([
      { kind: "payoff", input: { type: "chest-opened" } },
      { kind: "arm-timer", timer: "slow", ms: SLOW_PAYOFF_MS },
      { kind: "read", epoch: 1 },
    ])
    expect(chestScreenView(startChestScreen())).toMatchObject({ kind: "chest", vessel: null, action: null })
  })

  it("puts the vessel up on the seed alone, before any claim, and says so at once with no player", () => {
    expect(chestScreenView(walk([opened, source()]).state)).toMatchObject({ vessel: { seed: "p:7", pieces: [], open: false, canOpen: false } })
    const none = walk([opened, source(null)])
    expect(none.state.phase).toBe("nothing")
    expect(none.commands).toEqual([
      { kind: "stop-feed" },
      { kind: "clear-timer", timer: "slow" },
      { kind: "payoff", input: { type: "chest-result" }, tag: "capture", facts: { "chest.outcome": "none", "chest.reason": "no-identity" } },
    ])
    expect(walk([opened, source(), source("other")]).state.seed).toBe("p:7")
  })

  it("classifies each read the way the screen takes it", () => {
    const view = { gameIndex: 7, seed: "s", items: [], unprovable: 0, pending: 0, claimed: 0 }
    expect(classifyChest(null)).toEqual({ kind: "nothing", game: null, why: "no-identity" })
    expect(classifyChest({ ...view, items: TWO, settling: true, partial: true })).toMatchObject({ kind: "claims", settling: true, partial: true })
    expect(classifyChest({ ...view, failed: "x" })).toEqual({ kind: "waiting", game: 7, failed: true })
    expect(classifyChest({ ...view, pending: 1 })).toEqual({ kind: "waiting", game: 7, failed: false })
    expect(classifyChest({ ...view, claimed: 1 })).toEqual({ kind: "nothing", game: 7, why: "pocketed" })
    expect(classifyChest({ ...view, unprovable: 2 })).toEqual({ kind: "nothing", game: 7, why: "pruned" })
    expect(classifyChest({ ...view, attended: true })).toEqual({ kind: "nothing", game: 7, why: "no-attestations" })
  })

  it("collects on the first claims and tells the payoff once, with the read's tag", () => {
    const first = walk([opened, source(), answer(claims(true))])
    expect(first.state.phase).toBe("collecting")
    expect(first.commands).toEqual([
      { kind: "payoff", input: { type: "chest-result" }, tag: TAG, facts: { "chest.outcome": "collectables", "chest.count": "2", "chest.settling": "true" } },
    ])
    expect(walk([came([item(3)])], first.state)).toMatchObject({ commands: [], state: { claims: [...TWO, item(3)] } })
    expect(walk([came([item(1)])], first.state).state).toBe(first.state)
    expect(walk([settled([item(2), item(4)])], first.state).state).toMatchObject({ allIn: true, claims: [...TWO, item(4)] })
  })

  it("opens 10 s after the landing with something in, at once when all are in and flown in, and on a tap", () => {
    const shut = walk([opened, source(), answer(claims(true)), is("landed")])
    expect(shut.commands).toEqual([{ kind: "arm-timer", timer: "collect", ms: COLLECT_MS }])
    expect(chestScreenView(walk([collected(1)], shut.state).state)).toMatchObject({ vessel: { open: false, canOpen: true } })
    expect(chestScreenView(walk([collected(1), timer("collect")], shut.state).state)).toMatchObject({ vessel: { open: true } })
    expect(chestScreenView(walk([timer("collect")], shut.state).state)).toMatchObject({ vessel: { open: false } })
    const all = walk([opened, source(), answer(claims()), is("landed"), collected(2)])
    expect(chestScreenView(all.state)).toMatchObject({ vessel: { open: true } })
    expect(walk([collected(1), is("vessel-opened")], shut.state).commands).toEqual([
      { kind: "log", message: "the vessel opened", data: { by: "a tap", collected: 1, shown: 2 } },
    ])
    expect(walk([is("vessel-opened")], shut.state).state).toBe(shut.state)
  })

  it("keeps waiting on a failed read, rereads, and reports the recovery", () => {
    const failed = walk([opened, source(), answer({ kind: "waiting", game: 7, failed: true })])
    expect(failed.commands).toEqual([{ kind: "rereads", on: true }])
    // the reread reads at once, whatever the payoff does with it; its load-chest is that same read
    const reading = walk([is("reread-due")], failed.state)
    expect(reading.commands).toEqual([
      { kind: "payoff", input: { type: "chest-reread-due" } },
      { kind: "read", epoch: 2 },
    ])
    expect(walk([is("load-chest")], reading.state).state).toBe(reading.state)
    expect(walk([answer(claims())], reading.state).commands.slice(0, 2)).toEqual([{ kind: "read-recovered" }, { kind: "rereads", on: false }])
    expect(walk([is("reread-due")], walk([opened]).state).state.epoch).toBe(1)
  })

  it("puts up the restart card while waiting, for good: the feed stops and the payoff hears it", () => {
    const up = walk([opened, source(), () => ({ type: "health", health: { lost: true, reason: "chain-lost", stall: undefined } })])
    expect(up.commands).toEqual([
      { kind: "stop-feed" },
      { kind: "clear-timer", timer: "slow" },
      { kind: "payoff", input: { type: "chest-result" }, tag: "capture", facts: { "chest.outcome": "none", "chest.reason": "failed" } },
      { kind: "payoff", input: { type: "payoff-stalled", stage: "chest.load" } },
    ])
    expect(chestScreenView(up.state)).toEqual({ kind: "restart", reason: "chain-lost" })
    expect(walk([() => ({ type: "health", health: { lost: false, stall: undefined } })], up.state).state).toBe(up.state)
    const collecting = walk([opened, source(), answer(claims())]).state
    expect(walk([() => ({ type: "health", health: { lost: true, stall: undefined } })], collecting).state).toBe(collecting)
  })

  it("says it is taking longer once the collect wait runs out with nothing read, and skips from there", () => {
    const slow = walk([opened, source(), is("landed"), timer("collect")])
    expect(slow.commands).toEqual([{ kind: "payoff", input: { type: "payoff-stalled", stage: "chest.slow" } }])
    expect(chestScreenView(slow.state)).toMatchObject({ notice: "slow", action: "skip", vessel: { seed: "p:7" } })
    expect(walk([is("cta")], slow.state).commands).toEqual([{ kind: "leave", via: "chest-skip" }])
    expect(walk([is("cta")], walk([opened, source(), is("landed")]).state).commands).toEqual([])
    // the backstop, for a vessel that never landed, says the same; once said, neither says it again
    expect(walk([opened, source(), timer("slow")]).commands).toEqual([{ kind: "payoff", input: { type: "payoff-stalled", stage: "chest.slow" } }])
    expect(walk([timer("slow")], slow.state).commands).toEqual([])
    // with claims read, the collect wait only opens the vessel; the backstop still offers a way on
    const reading = walk([opened, source(), answer(claims()), is("landed"), timer("collect")])
    expect(reading.commands).toEqual([])
    expect(chestScreenView(reading.state)).toMatchObject({ notice: null, action: null })
    const unopened = walk([opened, source(), answer(claims()), timer("slow")])
    expect(unopened.commands).toEqual([])
    expect(chestScreenView(unopened.state)).toMatchObject({ action: "continue" })
  })

  it("keeps the Continue when claims come after the long-wait notice, and opens on the first", () => {
    const late = walk([opened, source(), is("landed"), timer("collect"), answer(claims(true))])
    expect(chestScreenView(late.state)).toMatchObject({ notice: null, action: "continue", vessel: { open: false } })
    expect(chestScreenView(walk([collected(1)], late.state).state)).toMatchObject({ vessel: { open: true } })
  })

  it("leaves a chest that is all in seen through the album, one still settling unseen, and a nothing screen at once", () => {
    const open = walk([opened, source(), answer(claims()), is("landed"), collected(2), is("vessel-opened")])
    expect(walk([is("cta")], open.state)).toMatchObject({ commands: [{ kind: "mark-seen", game: 7 }], state: { closing: true } })
    expect(walk([is("cta"), is("album-done")], open.state).commands).toEqual([{ kind: "leave", via: "chest-continue" }])
    expect(walk([is("album-done")], open.state).commands).toEqual([])
    expect(walk([is("cta")], walk([opened, source(), answer(claims(true)), is("landed"), collected(2), is("vessel-opened")]).state).commands).toEqual([])
    expect(walk([is("cta")], walk([opened, source(), answer(claims())]).state).commands).toEqual([])
    expect(walk([is("cta")], walk([opened, source(), answer({ kind: "nothing", game: 7, why: "absent" })]).state).commands).toEqual([
      { kind: "mark-seen", game: 7 },
      { kind: "leave", via: "chest-continue" },
    ])
  })

  it("counts a refused hand-off only while the album is up", () => {
    const open = walk([opened, source(), answer(claims()), is("landed"), collected(2), is("vessel-opened")])
    const refused = () => ({ type: "hand-off-refused" }) as const
    expect(walk([refused], open.state).state).toBe(open.state)
    expect(chestScreenView(walk([is("cta"), refused, refused], open.state).state)).toMatchObject({ closing: { refusals: 2 } })
  })

  it("offers Continue the moment the vessel opens, and saves a pick on a changeable piece", () => {
    const shut = walk([opened, source(), answer(claims()), is("landed"), collected(2)])
    expect(chestScreenView(shut.state)).toMatchObject({ action: null })
    const shown = walk([is("vessel-opened")], shut.state)
    expect(chestScreenView(shown.state)).toMatchObject({ action: "continue" })
    expect(walk([() => ({ type: "pick", index: 0, collectionId: 18 })], shown.state).commands).toEqual([
      { kind: "save-pick", hash: TWO[0]!.hash, collectionId: 18 },
    ])
    expect(walk([() => ({ type: "pick", index: 9, collectionId: 18 })], shown.state).state).toBe(shown.state)
  })

  it("is inert before it opens, after it closes, and to a stale answer", () => {
    const start = startChestScreen()
    expect(chestScreenStep(start, { type: "cta" }).state).toBe(start)
    const open = walk([opened, source()]).state
    expect(chestScreenStep(open, { type: "answered", epoch: 9, answer: claims(), tag: TAG }).state).toBe(open)
    const closed = chestScreenStep(open, { type: "unmounted" })
    expect(closed.commands).toEqual([{ kind: "stop-feed" }, { kind: "clear-timer", timer: "slow" }, { kind: "clear-timer", timer: "collect" }])
    expect(walk([answer(claims())], closed.state).state).toBe(closed.state)
  })
})
