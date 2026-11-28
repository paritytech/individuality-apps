// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { detectSynchronizedPcFailure, parsePcTimeline, type PcTimelineLine, type PcTimelineTransition } from "./pc-timeline"

const lines = (rows: Array<[number, string, unknown?]>, sessionId = "doc-a"): PcTimelineLine[] =>
  rows.map(([ts, message, data]) => ({ ts, sessionId, tag: "rtc", message, ...(data === undefined ? {} : { data }) }))

const detect = (rows: Array<[number, string, unknown?]>, sessionId?: string) =>
  detectSynchronizedPcFailure(parsePcTimeline(lines(rows, sessionId)), { withinMs: 5_000, minPeers: 2 })

describe("parsePcTimeline", () => {
  it("parses exact production RTC prose behind explicit prefixes", () => {
    expect(parsePcTimeline(lines([
      [4, "[jollity-rtc] peer back alice"],
      [1, "[jollity-rtc] pc alice connected"],
      [3, "[jollity-rtc] peer away alice said"],
      [2, "[jollity-rtc] pc alice failed"],
    ]))).toEqual<PcTimelineTransition[]>([
      { ts: 1, kind: "pc", peer: "alice", state: "connected" },
      { ts: 2, kind: "pc", peer: "alice", state: "failed" },
      { ts: 3, kind: "away", peer: "alice" },
      { ts: 4, kind: "back", peer: "alice" },
    ])
  })

  it("uses structured room and generation data for mesh lifecycle identity", () => {
    expect(parsePcTimeline(lines([
      [1, "mesh opening", { room: "g7:alice_bob", generation: 4 }],
      [2, "mesh closing", { room: "g7:alice_bob", generation: 4, cause: "inactive" }],
    ], "document-7"))).toEqual<PcTimelineTransition[]>([
      { ts: 1, kind: "mesh", state: "opening", room: "g7:alice_bob", lifecycle: "document-7:4", cause: null },
      { ts: 2, kind: "mesh", state: "closing", room: "g7:alice_bob", lifecycle: "document-7:4", cause: "inactive" },
    ])
  })

  it("ignores wrong tags, missing timestamps, unrelated prose, and near-miss wording", () => {
    const input: PcTimelineLine[] = [
      { ts: 1, tag: "journey", message: "[jollity-rtc] pc alice connected" },
      { tag: "rtc", message: "[jollity-rtc] pc alice connected" },
      { ts: 2, tag: "rtc", message: "ordinary RTC note" },
      { ts: 3, tag: "rtc", message: "[jollity-rtc] pc alice disconnected" },
      { ts: 4, tag: "rtc", message: "[jollity-rtc] peer away alice timeout" },
      { ts: 5, tag: "rtc", message: "[jollity-rtc] peer returned alice" },
    ]
    expect(parsePcTimeline(input)).toEqual([])
  })
})

describe("detectSynchronizedPcFailure", () => {
  it("reports a collapse of the peers connected when the failure window started", () => {
    expect(detect([
      [1, "[jollity-rtc] pc alice connected"],
      [2, "[jollity-rtc] pc bob connected"],
      [3, "[jollity-rtc] pc carol connected"],
      [10_000, "[jollity-rtc] pc alice failed"],
      [30_000, "[jollity-rtc] pc bob failed"],
      [32_000, "[jollity-rtc] pc carol failed"],
    ])).toEqual({ collapse: { peers: 2, span: 2_000 }, peakPeers: 3 })
  })

  it("keeps staggered and recovered failures from combining", () => {
    expect(detect([
      [1, "[jollity-rtc] pc alice connected"],
      [2, "[jollity-rtc] pc bob connected"],
      [10_000, "[jollity-rtc] pc alice failed"],
      [11_000, "[jollity-rtc] pc alice connected"],
      [20_000, "[jollity-rtc] pc bob failed"],
    ])).toEqual({ peakPeers: 2 })
  })

  it("removes explicit departures and restores only observed returning peers", () => {
    expect(detect([
      [1, "[jollity-rtc] pc alice connected"],
      [2, "[jollity-rtc] pc bob connected"],
      [3, "[jollity-rtc] peer back carol"],
      [4, "[jollity-rtc] peer away alice said"],
      [5, "[jollity-rtc] peer back alice"],
      [10_000, "[jollity-rtc] pc alice failed"],
      [12_000, "[jollity-rtc] pc bob failed"],
      [13_000, "[jollity-rtc] pc carol failed"],
    ])).toEqual({ collapse: { peers: 2, span: 2_000 }, peakPeers: 2 })
  })

  it("suppresses only a timely planned close of the same room lifecycle", () => {
    expect(detect([
      [1, "mesh opening", { room: "g7:alice_bob", generation: 1 }],
      [2, "[jollity-rtc] pc alice connected"],
      [3, "[jollity-rtc] pc bob connected"],
      [10_000, "[jollity-rtc] pc alice failed"],
      [12_000, "[jollity-rtc] pc bob failed"],
      [12_500, "mesh closing", { room: "g7:alice_bob", generation: 1, cause: "inactive" }],
    ])).toEqual({ peakPeers: 2 })
  })

  it.each([
    ["network recovery", { room: "g7:alice_bob", generation: 1, cause: "network-recovery" }],
    ["missing cause", { room: "g7:alice_bob", generation: 1 }],
    ["room mismatch", { room: "g7:carol_dave", generation: 1, cause: "room-change" }],
    ["generation mismatch", { room: "g7:alice_bob", generation: 2, cause: "inactive" }],
  ])("fails closed for %s teardown", (_name, close) => {
    expect(detect([
      [1, "mesh opening", { room: "g7:alice_bob", generation: 1 }],
      [2, "[jollity-rtc] pc alice connected"],
      [3, "[jollity-rtc] pc bob connected"],
      [10_000, "[jollity-rtc] pc alice failed"],
      [12_000, "[jollity-rtc] pc bob failed"],
      [12_500, "mesh closing", close],
    ])).toEqual({ collapse: { peers: 2, span: 2_000 }, peakPeers: 2 })
  })

  it("does not let another document's equal generation suppress a collapse", () => {
    const transitions = parsePcTimeline([
      ...lines([
        [1, "mesh opening", { room: "g7:alice_bob", generation: 1 }],
        [2, "[jollity-rtc] pc alice connected"],
        [3, "[jollity-rtc] pc bob connected"],
        [10_000, "[jollity-rtc] pc alice failed"],
        [12_000, "[jollity-rtc] pc bob failed"],
      ], "document-a"),
      ...lines([[12_500, "mesh closing", { room: "g7:alice_bob", generation: 1, cause: "inactive" }]], "document-b"),
    ])
    expect(detectSynchronizedPcFailure(transitions, { withinMs: 5_000, minPeers: 2 }))
      .toEqual({ collapse: { peers: 2, span: 2_000 }, peakPeers: 2 })
  })
})
