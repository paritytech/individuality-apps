// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, describe, expect, it, vi } from "vitest"
import type { CollectablesView } from "@jollity/collectables"
import type { GameSource } from "../game-source"
import { holdCollectablesFeed, resetCollectablesFeedsForTest, type CollectablesFeedEvent, type CollectablesFeedReads } from "./collectables-feed"

const SOURCE = {} as GameSource
const view = (over: Partial<CollectablesView> = {}): CollectablesView => ({ gameIndex: 7, seed: "p:7", items: [], unprovable: 0, pending: 0, claimed: 0, ...over })
const claim = (n: number) => ({ ...view(), hash: `0x0${n}` }) as unknown as CollectablesView["items"][number]

function fakeReads() {
  const answers: ((v: CollectablesView) => void)[] = []
  const aborted: AbortSignal[] = []
  const held: boolean[] = []
  const reads: CollectablesFeedReads = {
    game: 7,
    player: undefined,
    read: (_source, options) =>
      new Promise((resolve) => {
        answers.push(resolve)
        aborted.push(options.signal)
        held.push(options.holdWhileVoting === true)
      }),
    watch: () => new Promise(() => {}),
    picks: async () => [new Map(), new Map()],
    wait: async () => {},
    log: () => {},
  }
  return { reads, answers, aborted, held }
}
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

afterEach(() => {
  resetCollectablesFeedsForTest()
  vi.useRealTimers()
})

describe("the shared claims feed", () => {
  it("hands a later holder what it already found, then what comes", async () => {
    const { reads, answers } = fakeReads()
    const early = holdCollectablesFeed(SOURCE, reads, null, 60_000)
    early()
    await flush()
    answers[0]!(view({ items: [claim(1)], settling: true }))
    await flush()
    const heard: CollectablesFeedEvent["type"][] = []
    holdCollectablesFeed(SOURCE, reads, (event) => heard.push(event.type))
    expect(heard).toEqual(["answered"])
    expect(answers).toHaveLength(1)
  })

  it("keeps a run its last holder let go for the grace it asked, then lets it go", async () => {
    vi.useFakeTimers()
    const { reads, aborted } = fakeReads()
    holdCollectablesFeed(SOURCE, reads, null, 60_000)()
    await vi.advanceTimersByTimeAsync(59_000)
    expect(aborted[0]!.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(aborted[0]!.aborted).toBe(true)
  })

  it("lets a run go at once when its last holder needs no grace, and starts afresh after", async () => {
    const { reads, aborted } = fakeReads()
    const release = holdCollectablesFeed(SOURCE, reads, () => {})
    release()
    expect(aborted[0]!.aborted).toBe(true)
    holdCollectablesFeed(SOURCE, reads, () => {})
    await flush()
    expect(aborted).toHaveLength(2)
  })

  it("reads afresh rather than hand over a run that answered without claims", async () => {
    const { reads, answers } = fakeReads()
    holdCollectablesFeed(SOURCE, reads, null, 180_000)()
    await flush()
    // the draw's early read failed on a blip; by the time the collectables screen opens, the chain answers
    answers[0]!(view({ failed: "timeout" }))
    await flush()
    const heard: CollectablesFeedEvent[] = []
    holdCollectablesFeed(SOURCE, reads, (event) => heard.push(event))
    await flush()
    expect(heard).toEqual([])
    expect(answers).toHaveLength(2)
    answers[1]!(view({ items: [claim(1)] }))
    await flush()
    expect(heard.map((event) => (event.type === "answered" ? event.answer.kind : event.type))).toEqual(["claims"])
  })

  it("shares no run when the game is not known", async () => {
    const { reads, answers } = fakeReads()
    const unknown = { ...reads, game: undefined }
    // the draw's early start has nothing to key its run on: it starts none
    holdCollectablesFeed(SOURCE, unknown, null, 180_000)()
    await flush()
    expect(answers).toHaveLength(0)
    const release = holdCollectablesFeed(SOURCE, unknown, () => {})
    holdCollectablesFeed(SOURCE, unknown, () => {})
    await flush()
    expect(answers).toHaveLength(2)
    release()
  })

  it("keeps one run per player and game", async () => {
    const { reads, answers } = fakeReads()
    holdCollectablesFeed(SOURCE, reads, () => {})
    holdCollectablesFeed(SOURCE, reads, () => {})
    holdCollectablesFeed(SOURCE, { ...reads, game: 8 }, () => {})
    await flush()
    expect(answers).toHaveLength(2)
  })

  it("after a voting answer, holds one more read and follows what it finds", async () => {
    const { reads, answers, held } = fakeReads()
    const heard: CollectablesFeedEvent[] = []
    holdCollectablesFeed(SOURCE, { ...reads, watch: async () => {} }, (event) => heard.push(event))
    await flush()
    answers[0]!(view({ voting: true }))
    await flush()
    expect(held).toEqual([false, true])
    answers[1]!(view({ items: [claim(1)], settling: true }))
    await flush()
    answers[2]!(view({ items: [claim(1)] }))
    await flush()
    expect(heard.map((event) => (event.type === "answered" ? event.answer.kind : event.type))).toEqual(["waiting", "claims", "settled"])
  })

  it("after a voting answer, hands on the final empty collectables screen", async () => {
    const { reads, answers } = fakeReads()
    const heard: CollectablesFeedEvent[] = []
    holdCollectablesFeed(SOURCE, reads, (event) => heard.push(event))
    await flush()
    answers[0]!(view({ voting: true }))
    await flush()
    answers[1]!(view({ verdict: "failed", reportSent: true }))
    await flush()
    expect(heard.map((event) => (event.type === "answered" ? event.answer : event.type))).toEqual([
      { kind: "waiting", game: 7, failed: false, voting: true },
      { kind: "nothing", game: 7, why: "not-recognised" },
    ])
    expect(answers).toHaveLength(2)
  })

  it("stops the held read on abort", async () => {
    const { reads, answers, aborted } = fakeReads()
    const heard: CollectablesFeedEvent[] = []
    const release = holdCollectablesFeed(SOURCE, reads, (event) => heard.push(event))
    await flush()
    answers[0]!(view({ voting: true }))
    await flush()
    release()
    answers[1]!(view({ items: [claim(1)], settling: true }))
    await flush()
    expect(aborted[1]!.aborted).toBe(true)
    expect(heard).toHaveLength(1)
  })
})
