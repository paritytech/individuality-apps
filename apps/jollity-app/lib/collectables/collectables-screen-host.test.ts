// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { beforeEach, describe, expect, it } from "vitest"
import type { CollectablesItem, CollectablesView } from "@jollity/collectables"
import type { GameSource } from "../game-source"
import { createPayoffScreenRunner } from "../payoff-screen-runner"
import { resetPayoffSessionsForTest } from "../payoff-session"
import { runCollectablesFeed, SETTLED_RETRY_MS, type CollectablesFeedReads } from "./collectables-feed"
import { createCollectablesScreenHost, type CollectablesScreenDeps } from "./collectables-screen-host"

const item = (n: number): CollectablesItem => ({
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
const view = (over: Partial<CollectablesView> = {}): CollectablesView => ({ gameIndex: 7, seed: "p:7", items: [], unprovable: 0, pending: 0, claimed: 0, ...over })

/** deps that write what they are asked into `calls`, and hand each read, watch and timer to the test */
function fakeDeps(over: Partial<CollectablesScreenDeps> = {}) {
  const calls: string[] = []
  const reads: { afterSettle: boolean; held: boolean; answer(v: CollectablesView | null): void; aborted: () => boolean }[] = []
  const watches: { onItems: (items: CollectablesItem[]) => void; settle(): void }[] = []
  const timers: { ms: number; onElapsed: () => void }[] = []
  const waits: number[] = []
  let reread: (() => Promise<boolean>) | null = null
  // the feed's own reads, faked; the run is the real one (./collectables-feed)
  const feedReads: CollectablesFeedReads = {
    game: 7,
    player: undefined,
    read: (_source, options) =>
      new Promise((resolve) => {
        calls.push(`read afterSettle=${options.afterSettle === true}`)
        reads.push({
          afterSettle: options.afterSettle === true,
          held: options.holdWhileVoting === true,
          answer: resolve,
          aborted: () => options.signal.aborted,
        })
      }),
    watch: (_source, options) =>
      new Promise((resolve) => {
        calls.push(`watch shown=${options.shown.length}`)
        watches.push({ onItems: options.onItems, settle: () => resolve() })
      }),
    picks: async () => [new Map(), new Map()],
    // the settle's retries wait no time here; the test reads how long they asked for
    wait: async (ms) => void waits.push(ms),
    log: (message) => calls.push(`log ${message}`),
  }
  const deps: CollectablesScreenDeps = {
    game: 7,
    override: undefined,
    source: async () => ({ player: "p" }) as GameSource,
    seed: () => "p:7",
    feed: (source, _options, listener) => {
      const controller = new AbortController()
      void runCollectablesFeed(source, feedReads, listener, controller.signal)
      return () => controller.abort()
    },
    payoff: createPayoffScreenRunner(7, "/collectables"),
    collectablesOpened: () => calls.push("collectablesOpened"),
    collectablesShown: (facts) => calls.push(`collectablesShown ${JSON.stringify(facts)}`),
    collectablesReadRecovered: () => calls.push("collectablesReadRecovered"),
    payoffStalled: (stage) => calls.push(`payoffStalled ${stage}`),
    payoffHandedOff: () => calls.push("payoffHandedOff"),
    leaveForHumanity: () => calls.push("leaveForHumanity"),
    markSeen: (game) => calls.push(`markSeen ${game}`),
    savePick: (hash, id) => calls.push(`savePick ${hash.slice(0, 10)} ${id}`),
    timer: (ms, onElapsed) => {
      calls.push(`timer ${ms}`)
      const armed = { ms, onElapsed }
      timers.push(armed)
      return () => {
        calls.push(`timer ${ms} cleared`)
        timers.splice(timers.indexOf(armed), 1)
      }
    },
    rereads: (callback) => {
      calls.push("rereads armed")
      reread = callback
      return () => calls.push("rereads stopped")
    },
    now: () => 0,
    log: (message) => calls.push(`log ${message}`),
    ...over,
  }
  /** every timer armed for `ms`, in the order they were armed, as the clock would run them */
  const elapse = (ms: number) => timers.filter((armed) => armed.ms === ms).forEach((armed) => armed.onElapsed())
  return { deps, calls, reads, watches, waits, elapse, reread: () => reread!() }
}
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  resetPayoffSessionsForTest()
})

describe("the collectables screen's host", () => {
  it("is pure until the page attaches, then opens: the payoff hears it, the slow and voting notice waits are armed, the feed starts", async () => {
    const { deps, calls } = fakeDeps()
    const host = createCollectablesScreenHost(deps)
    await flush()
    expect(calls).toEqual([])
    host.attach()
    await flush()
    expect(calls).toEqual(["collectablesOpened", "timer 60000", "timer 10000", "read afterSettle=false"])
  })

  it("puts the vessel up on the source's seed, before the read answers", async () => {
    const { deps } = fakeDeps()
    const host = createCollectablesScreenHost(deps)
    host.attach()
    await flush()
    expect(host.view()).toMatchObject({ kind: "chest", vessel: { seed: "p:7", pieces: [] } })
  })

  it("feeds a collectables read before the settle: its claims, what lands, then the settle's read", async () => {
    const { deps, calls, reads, watches, waits } = fakeDeps()
    const host = createCollectablesScreenHost(deps)
    host.attach()
    await flush()
    reads[0]!.answer(view({ items: [item(1)], settling: true }))
    await flush()
    expect(calls).toContain('collectablesShown {"chest.outcome":"collectables","chest.count":"1","chest.settling":"true"}')
    expect(calls).toContain("watch shown=1")
    watches[0]!.onItems([item(2)])
    expect(host.view()).toMatchObject({ vessel: { pieces: [item(1), item(2)] } })
    watches[0]!.settle()
    await flush()
    // it keeps trying past the schedule's end, each wait longer, until the settle's read comes
    const failures = SETTLED_RETRY_MS.length + 2
    for (let attempt = 1; attempt <= failures; attempt++) {
      reads.at(-1)!.answer(view({ failed: "timeout" }))
      await flush()
    }
    reads.at(-1)!.answer(view({ items: [item(1), item(2), item(3)] }))
    await flush()
    expect(calls.filter((call) => call === "read afterSettle=true")).toHaveLength(failures + 1)
    expect(calls.filter((call) => call === "log the chest read after the settle failed")).toHaveLength(failures)
    expect(waits).toEqual([...SETTLED_RETRY_MS, 30_000, 30_000])
    expect(host.view()).toMatchObject({ vessel: { pieces: [item(1), item(2), item(3)] } })
  })

  it("arms the collect wait on the landing, and opens the vessel when it runs out", async () => {
    const { deps, reads, elapse } = fakeDeps()
    const host = createCollectablesScreenHost(deps)
    host.attach()
    await flush()
    reads[0]!.answer(view({ items: [item(1), item(2)], settling: true }))
    await flush()
    host.send({ type: "landed" })
    host.send({ type: "collected", count: 1 })
    expect(host.view()).toMatchObject({ vessel: { open: false, canOpen: true } })
    elapse(10_000)
    expect(host.view()).toMatchObject({ vessel: { open: true } })
  })

  it("says it is taking longer when the landed vessel has waited 10 s with nothing read", async () => {
    const { deps, calls, elapse } = fakeDeps()
    const host = createCollectablesScreenHost(deps)
    host.attach()
    await flush()
    host.send({ type: "landed" })
    expect(host.view()).toMatchObject({ notice: null, action: null })
    elapse(10_000)
    expect(host.view()).toMatchObject({ notice: "slow", action: "skip", vessel: { seed: "p:7" } })
    expect(calls).toContain("payoffStalled chest.slow")
  })

  it("says nothing yet while players are still voting, 10 s after the open, with a way on", async () => {
    const { deps, calls, reads, elapse } = fakeDeps()
    const host = createCollectablesScreenHost(deps)
    host.attach()
    await flush()
    host.send({ type: "landed" })
    reads[0]!.answer(view({ voting: true }))
    await flush()
    expect(host.view()).toMatchObject({ notice: null, action: null, vessel: { seed: "p:7", pieces: [] } })
    expect(calls).toContain('collectablesShown {"chest.outcome":"none","chest.reason":"voting"}')
    expect(calls).not.toContain("rereads armed")
    expect(reads.map((read) => read.held)).toEqual([false, true])
    elapse(10_000)
    expect(host.view()).toMatchObject({ notice: "voting", action: "skip", vessel: { seed: "p:7", pieces: [] } })
    elapse(60_000)
    expect(calls.filter((call) => call.startsWith("payoffStalled"))).toEqual([])
    expect(host.view()).toMatchObject({ notice: "voting", action: "skip" })
  })

  it("shows a voting answer that comes 10 s after the open at once", async () => {
    const { deps, reads, elapse } = fakeDeps()
    const host = createCollectablesScreenHost(deps)
    host.attach()
    await flush()
    elapse(10_000)
    expect(host.view()).toMatchObject({ notice: null, action: null })
    reads[0]!.answer(view({ voting: true }))
    await flush()
    expect(host.view()).toMatchObject({ notice: "voting", action: "skip" })
  })

  it("keeps Continue when the read after the voting wait fails", async () => {
    const { deps, calls, reads, elapse } = fakeDeps()
    const host = createCollectablesScreenHost(deps)
    host.attach()
    await flush()
    elapse(10_000)
    reads[0]!.answer(view({ voting: true }))
    await flush()
    reads[1]!.answer(view({ failed: "game 7 has not settled after 180 seconds" }))
    await flush()
    expect(host.view()).toMatchObject({ action: "skip" })
    host.send({ type: "cta" })
    await flush()
    expect(calls).not.toContain("markSeen 7")
    expect(deps.payoff.current().kind).toBe("ended")
  })

  it("collects a claim that lands after the voting wait", async () => {
    const { deps, calls, reads } = fakeDeps()
    const host = createCollectablesScreenHost(deps)
    host.attach()
    await flush()
    reads[0]!.answer(view({ voting: true }))
    await flush()
    reads[1]!.answer(view({ items: [item(1)], settling: true }))
    await flush()
    expect(host.view()).toMatchObject({ notice: null, vessel: { pieces: [item(1)] } })
    expect(calls).toContain("watch shown=1")
    expect(calls.filter((call) => call.startsWith("collectablesShown"))).toHaveLength(1)
  })

  it("ends the voting wait on the final empty collectables screen, and Continue marks it seen", async () => {
    const { deps, calls, reads } = fakeDeps()
    const host = createCollectablesScreenHost(deps)
    host.attach()
    await flush()
    reads[0]!.answer(view({ voting: true }))
    await flush()
    reads[1]!.answer(view({ verdict: "failed", attended: false, reportSent: true }))
    await flush()
    expect(host.view()).toMatchObject({ notice: { nothing: "not-recognised" }, action: "continue" })
    host.send({ type: "cta" })
    expect(calls).toContain("markSeen 7")
  })

  it("leaves the voting wait without marking the collectables screen seen", async () => {
    const { deps, calls, reads, elapse } = fakeDeps()
    const host = createCollectablesScreenHost(deps)
    host.attach()
    await flush()
    elapse(10_000)
    reads[0]!.answer(view({ voting: true }))
    await flush()
    host.send({ type: "cta" })
    await flush()
    expect(calls).not.toContain("markSeen 7")
    expect(deps.payoff.current().kind).toBe("ended")
  })

  it("steps an event sent while a command runs after that command's step", async () => {
    const order: string[] = []
    const { deps } = fakeDeps({
      collectablesOpened: () => {
        order.push("collectablesOpened")
        host.send({ type: "landed" })
        order.push("collectablesOpened done")
      },
      timer: (ms) => {
        order.push(`timer ${ms}`)
        return () => {}
      },
    })
    const host = createCollectablesScreenHost(deps)
    host.attach()
    expect(order).toEqual(["collectablesOpened", "collectablesOpened done", "timer 60000", "timer 10000", "timer 10000"])
  })

  it("survives StrictMode's replay, and lets the feed go once really unmounted", async () => {
    const { deps, reads } = fakeDeps()
    const host = createCollectablesScreenHost(deps)
    host.attach()
    await flush()
    host.detach()
    host.attach()
    await flush()
    expect(reads[0]!.aborted()).toBe(false)
    host.detach()
    await flush()
    expect(reads[0]!.aborted()).toBe(true)
  })

  it("rereads on its own schedule, and tells the schedule whether the collectables screen is there", async () => {
    const { deps, calls, reads, reread } = fakeDeps()
    const host = createCollectablesScreenHost(deps)
    host.attach()
    await flush()
    reads[0]!.answer(view({ failed: "timeout" }))
    await flush()
    expect(calls).toContain("rereads armed")
    const recovered = reread()
    await flush()
    expect(reads).toHaveLength(2)
    reads[1]!.answer(view({ items: [item(1)] }))
    await flush()
    await expect(recovered).resolves.toBe(true)
    expect(calls).toContain("collectablesReadRecovered")
  })

  it("rereads even when the payoff ignores the reread (it is not reading the collectables)", async () => {
    const payoff = createPayoffScreenRunner(7, "/collectables")
    const deaf = { ...payoff, send: () => [] }
    const { deps, reads, reread } = fakeDeps({ payoff: deaf })
    const host = createCollectablesScreenHost(deps)
    host.attach()
    await flush()
    reads[0]!.answer(view({ failed: "timeout" }))
    await flush()
    const recovered = reread()
    await flush()
    expect(reads).toHaveLength(2)
    reads[1]!.answer(view({ items: [item(1)] }))
    await flush()
    await expect(recovered).resolves.toBe(true)
    expect(host.view()).toMatchObject({ vessel: { pieces: [item(1)] } })
  })

  it("answers a reread whose read throws, so the schedule goes on", async () => {
    const { deps, reread } = fakeDeps()
    let attempt = 0
    const throwing: CollectablesScreenDeps = {
      ...deps,
      feed: (source, _options, listener) => {
        const controller = new AbortController()
        attempt += 1
        const reads: CollectablesFeedReads = {
          game: 7,
          player: undefined,
          read: () => (attempt === 1 ? Promise.resolve(view({ failed: "timeout" })) : Promise.reject(new Error("rpc gone"))),
          watch: () => Promise.resolve(),
          picks: () => Promise.reject(new Error("host gone")),
          wait: async () => {},
          log: () => {},
        }
        void runCollectablesFeed(source, reads, listener, controller.signal)
        return () => controller.abort()
      },
    }
    const host = createCollectablesScreenHost(throwing)
    host.attach()
    await flush()
    await expect(reread()).resolves.toBe(false)
    expect(host.view()).toMatchObject({ kind: "chest", vessel: { pieces: [] } })
  })

  it("tries the hand-off again once the payoff has ended, and saves a pick", async () => {
    const { deps, calls, reads } = fakeDeps()
    const host = createCollectablesScreenHost(deps)
    host.attach()
    await flush()
    reads[0]!.answer(view({ items: [item(1)] }))
    await flush()
    host.send({ type: "landed" })
    host.send({ type: "collected", count: 1 })
    host.send({ type: "vessel-opened" })
    host.send({ type: "pick", index: 0, collectionId: 18 })
    host.send({ type: "cta" })
    host.send({ type: "album-done" })
    host.send({ type: "album-done" })
    expect(calls.filter((call) => /savePick|markSeen|payoffHandedOff|leaveForHumanity/.test(call))).toEqual([
      `savePick ${item(1).hash.slice(0, 10)} 18`,
      "markSeen 7",
      "payoffHandedOff",
      "leaveForHumanity",
      "leaveForHumanity",
    ])
  })

  it("brings the album back when the host refuses the hand-off", async () => {
    const { deps, reads } = fakeDeps({ leaveForHumanity: (refused) => refused() })
    const host = createCollectablesScreenHost(deps)
    host.attach()
    await flush()
    reads[0]!.answer(view({ items: [item(1)] }))
    await flush()
    for (const input of [{ type: "landed" }, { type: "collected", count: 1 }, { type: "vessel-opened" }, { type: "cta" }, { type: "album-done" }] as const)
      host.send(input)
    expect(host.view()).toMatchObject({ closing: { refusals: 1 } })
  })

  it("with no player, says so at once and reads nothing", async () => {
    const { deps, calls } = fakeDeps({ seed: () => null })
    const host = createCollectablesScreenHost(deps)
    host.attach()
    await flush()
    expect(host.view()).toMatchObject({ kind: "chest", notice: { nothing: "no-identity" }, action: "continue" })
    expect(calls).toContain('collectablesShown {"chest.outcome":"none","chest.reason":"no-identity"}')
  })
})
