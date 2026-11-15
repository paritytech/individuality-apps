// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { livenessSummary, mergeLivenessSummaries, newTally, recordLeaf } from "./liveness-stats"

const leaf = (ms: number, steps: number, steady = true) => ({ steady, ms, steps })

describe("L1 tally", () => {
  it("keeps the maximum drain, the maximum fake time and the worst leaf's path", () => {
    const tally = newTally(1)
    recordLeaf(tally, leaf(4000, 12), ["x"])
    recordLeaf(tally, leaf(31_500, 90), ["a", "b", "c"])
    recordLeaf(tally, leaf(9000, 400), ["d"])
    recordLeaf(tally, leaf(90_000, 5, false), ["stuck"])
    expect(livenessSummary(tally)).toMatchObject({
      checked: 4, steady: 3, stuck: 1, maxDrainSteps: 400, maxFakeS: 31.5,
      worst: { fakeS: 31.5, steps: 90, labels: ["a", "b", "c"] },
    })
  })

  it("without a bound no leaf is a finding; with one, only a steady leaf past it is", () => {
    const tally = newTally(1)
    expect(recordLeaf(tally, leaf(31_500, 90), ["a"])).toBeUndefined()
    expect(recordLeaf(tally, leaf(30_000, 90), ["a"], 30)).toBeUndefined()
    expect(recordLeaf(tally, leaf(90_000, 90, false), ["a"], 30)).toBeUndefined()
    expect(recordLeaf(tally, leaf(31_500, 90), ["a", "b"], 30)).toEqual({
      property: "L1", labels: ["a", "b"], atStep: 1, detail: "recovered after 31.5 s, bound 30 s", sampled: false,
      check: { kind: "liveness-bound", boundS: 30 },
    })
  })

  it("merges shard summaries: counts add, maxima and the worst path take the largest", () => {
    const one = newTally(1)
    recordLeaf(one, leaf(2000, 5), ["p"])
    const two = newTally(1)
    recordLeaf(two, leaf(8000, 50), ["q"])
    recordLeaf(two, leaf(1000, 7), ["r"])
    const merged = mergeLivenessSummaries([livenessSummary(one), livenessSummary(two)])
    expect(merged).toMatchObject({ checked: 3, steady: 3, maxDrainSteps: 50, maxFakeS: 8, worst: { labels: ["q"] } })
  })

  it("keeps the exact maximum paired with its path regardless of shard order", () => {
    const lower = newTally(1)
    recordLeaf(lower, leaf(62_251, 5), ["lower"])
    const higher = newTally(1)
    recordLeaf(higher, leaf(62_349, 7), ["higher"])
    const lowerSummary = livenessSummary(lower)
    const higherSummary = livenessSummary(higher)

    expect(lowerSummary.worst?.fakeS).toBe(62.3)
    expect(higherSummary.worst?.fakeS).toBe(62.3)
    for (const parts of [[lowerSummary, higherSummary], [higherSummary, lowerSummary]]) {
      expect(mergeLivenessSummaries(parts).worst).toMatchObject({ fakeS: 62.3, steps: 7, labels: ["higher"] })
    }
  })

  it("uses the path as a stable tie-break for exact raw-millisecond ties", () => {
    const z = newTally(1)
    recordLeaf(z, leaf(1_000, 9), ["z-path"])
    const a = newTally(1)
    recordLeaf(a, leaf(1_000, 4), ["a-path"])
    const zSummary = livenessSummary(z)
    const aSummary = livenessSummary(a)

    for (const parts of [[zSummary, aSummary], [aSummary, zSummary]]) {
      expect(mergeLivenessSummaries(parts).worst).toMatchObject({ fakeS: 1, steps: 4, labels: ["a-path"] })
    }
  })
})
