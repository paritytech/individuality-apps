// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, describe, expect, it, vi } from "vitest"
import type { ChestView } from "@jollity/collectables"
import type { GameSource } from "../game-source"
import { holdChestFeed, resetChestFeedsForTest, type ChestFeedEvent, type ChestFeedReads } from "./chest-feed"

const SOURCE = {} as GameSource
const view = (over: Partial<ChestView> = {}): ChestView => ({ gameIndex: 7, seed: "p:7", items: [], unprovable: 0, pending: 0, claimed: 0, ...over })
const claim = (n: number) => ({ ...view(), hash: `0x0${n}` }) as unknown as ChestView["items"][number]

function fakeReads() {
  const answers: ((v: ChestView) => void)[] = []
  const aborted: AbortSignal[] = []
  const reads: ChestFeedReads = {
    game: 7,
    player: undefined,
    read: (_source, options) =>
      new Promise((resolve) => {
        answers.push(resolve)
        aborted.push(options.signal)
      }),
    watch: () => new Promise(() => {}),
    picks: async () => [new Map(), new Map()],
    wait: async () => {},
    log: () => {},
  }
  return { reads, answers, aborted }
}
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

afterEach(() => {
  resetChestFeedsForTest()
  vi.useRealTimers()
})

describe("the shared claims feed", () => {
  it("hands a later holder what it already found, then what comes", async () => {
    const { reads, answers } = fakeReads()
    const early = holdChestFeed(SOURCE, reads, null, 60_000)
    early()
    await flush()
    answers[0]!(view({ items: [claim(1)], settling: true }))
    await flush()
    const heard: ChestFeedEvent["type"][] = []
    holdChestFeed(SOURCE, reads, (event) => heard.push(event.type))
    expect(heard).toEqual(["answered"])
    expect(answers).toHaveLength(1)
  })

  it("keeps a run its last holder let go for the grace it asked, then lets it go", async () => {
    vi.useFakeTimers()
    const { reads, aborted } = fakeReads()
    holdChestFeed(SOURCE, reads, null, 60_000)()
    await vi.advanceTimersByTimeAsync(59_000)
    expect(aborted[0]!.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(aborted[0]!.aborted).toBe(true)
  })

  it("lets a run go at once when its last holder needs no grace, and starts afresh after", async () => {
    const { reads, aborted } = fakeReads()
    const release = holdChestFeed(SOURCE, reads, () => {})
    release()
    expect(aborted[0]!.aborted).toBe(true)
    holdChestFeed(SOURCE, reads, () => {})
    await flush()
    expect(aborted).toHaveLength(2)
  })

  it("reads afresh rather than hand over a run that answered without claims", async () => {
    const { reads, answers } = fakeReads()
    holdChestFeed(SOURCE, reads, null, 180_000)()
    await flush()
    // the draw's early read failed on a blip; by the time the chest opens, the chain answers
    answers[0]!(view({ failed: "timeout" }))
    await flush()
    const heard: ChestFeedEvent[] = []
    holdChestFeed(SOURCE, reads, (event) => heard.push(event))
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
    holdChestFeed(SOURCE, unknown, null, 180_000)()
    await flush()
    expect(answers).toHaveLength(0)
    const release = holdChestFeed(SOURCE, unknown, () => {})
    holdChestFeed(SOURCE, unknown, () => {})
    await flush()
    expect(answers).toHaveLength(2)
    release()
  })

  it("keeps one run per player and game", async () => {
    const { reads, answers } = fakeReads()
    holdChestFeed(SOURCE, reads, () => {})
    holdChestFeed(SOURCE, reads, () => {})
    holdChestFeed(SOURCE, { ...reads, game: 8 }, () => {})
    await flush()
    expect(answers).toHaveLength(2)
  })
})
