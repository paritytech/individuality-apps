// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { OfferClock } from "./offer-clock"

describe("OfferClock", () => {
  it("times an answer from the offer going out, by the route it took, once", () => {
    const clock = new OfferClock()
    clock.sent("channel", 1000)
    expect(clock.answered(1180)).toEqual({ ms: 180, via: "channel", peerPresent: true })
    expect(clock.answered(1500)).toBeNull()
  })
  it("has nothing for an answer to no offer of ours", () => {
    expect(new OfferClock().answered(10)).toBeNull()
  })
  it("times from the latest offer", () => {
    const clock = new OfferClock()
    clock.sent("statement", 0)
    clock.sent("statement", 900)
    expect(clock.answered(1000)?.ms).toBe(100)
  })
  it("flags an offer posted to a peer who was there, and has no from-seen time for it", () => {
    const clock = new OfferClock()
    clock.sent("statement", 0, true)
    clock.seen(500)
    expect(clock.answered(900)).toEqual({ ms: 900, via: "statement", peerPresent: true })
  })
  it("times an offer to an absent peer from the peer's first frame as well (game 206)", () => {
    const clock = new OfferClock()
    clock.sent("statement", 0, false)
    clock.seen(70_000) // the app comes back
    clock.seen(70_100) // later frames do not move it
    expect(clock.answered(70_300)).toEqual({ ms: 70_300, via: "statement", peerPresent: false, fromSeenMs: 300 })
  })
  it("has no from-seen time when the answer was the first sign of the peer", () => {
    const clock = new OfferClock()
    clock.sent("statement", 0, false)
    clock.seen(70_300) // the answer itself
    expect(clock.answered(70_300)).toEqual({ ms: 70_300, via: "statement", peerPresent: false })
  })
  it("forgets a sighting from before a newer offer", () => {
    const clock = new OfferClock()
    clock.sent("statement", 0, false)
    clock.seen(100)
    clock.sent("statement", 200, false)
    expect(clock.answered(700)).toEqual({ ms: 500, via: "statement", peerPresent: false })
  })
})
