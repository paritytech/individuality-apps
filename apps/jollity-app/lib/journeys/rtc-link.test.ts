// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { linkRow, type LinkFacts } from "./rtc-link"

const facts = (over: Partial<LinkFacts> = {}): LinkFacts => ({
  connected: true,
  video: true,
  stages: { offer: 1200, answer: 1900, ice_checking: 2000, connected: 2600, first_frame: 4100 },
  sdp: { rtx: true, red: true, ulpfec: true, flexfec: false },
  seen: true,
  links: 1,
  freezeMs: 0,
  ...over,
})

describe("linkRow: one row per link per round", () => {
  it("a link with video: outcome, the furthest stage, the repair formats, seen, no rebuild", () => {
    const row = linkRow(facts())
    expect(row.attrs).toEqual({
      "rtc.outcome": "video",
      "rtc.last_stage": "first_frame",
      "rtc.seen": "true",
      "rtc.rtx": "true",
      "rtc.red": "true",
      "rtc.ulpfec": "true",
      "rtc.flexfec": "false",
      "rtc.rebuilds": "0",
    })
  })

  it("time to first frame runs from the link's first offer to its first decoded frame", () => {
    expect(linkRow(facts()).ttffMs).toBe(2900)
  })

  it("no time to first frame without both stamps: a link carried over from an earlier round's room has none", () => {
    const carried = linkRow(facts({ stages: {} }))
    expect(carried.ttffMs).toBeUndefined()
    expect(carried.attrs["rtc.last_stage"]).toBe("carried")
    expect(linkRow(facts({ stages: { first_frame: 3000 } })).ttffMs).toBeUndefined()
  })

  it("freeze time is always on the row, 0 included, so a p95 over links is honest", () => {
    expect(linkRow(facts()).freezeMs).toBe(0)
    expect(linkRow(facts({ freezeMs: 1234 })).freezeMs).toBe(1234)
  })

  it("connected without a decoded frame is its own outcome, and never seen", () => {
    const row = linkRow(facts({ video: false, seen: false, stages: { offer: 1, answer: 2, ice_checking: 3, connected: 4 } }))
    expect(row.attrs).toMatchObject({ "rtc.outcome": "connected-no-video", "rtc.last_stage": "connected", "rtc.seen": "false" })
    expect(row.ttffMs).toBeUndefined()
  })

  it("a link that never connected says the last stage it reached", () => {
    const row = linkRow(facts({ connected: false, video: false, seen: false, stages: { offer: 1, answer: 2, ice_checking: 3 }, sdp: undefined }))
    expect(row.attrs).toMatchObject({ "rtc.outcome": "not-connected", "rtc.last_stage": "ice_checking", "rtc.rtx": "unsupported", "rtc.red": "unsupported" })
  })

  it("a browser with no frame counter cannot say whether video came: connected-unmeasured", () => {
    expect(linkRow(facts({ video: undefined, stages: { offer: 1, connected: 2 } })).attrs["rtc.outcome"]).toBe("connected-unmeasured")
    // the funnel's first_frame stamp is video even then
    expect(linkRow(facts({ video: undefined })).attrs["rtc.outcome"]).toBe("video")
  })

  it("rebuilds are the extra connections the link went through this round, capped into a small set", () => {
    expect(linkRow(facts({ links: 2 })).attrs["rtc.rebuilds"]).toBe("1")
    expect(linkRow(facts({ links: 3 })).attrs["rtc.rebuilds"]).toBe("2")
    expect(linkRow(facts({ links: 9 })).attrs["rtc.rebuilds"]).toBe("3+")
  })
})
