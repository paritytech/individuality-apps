// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { SEAT_TIMES, phoneStruggles, seatState, seatTransitionMessage, settleSeat, streak, type LinkWindow, type SeatFacts, type ShownSeat, type Streak } from "./seat-state"

const T0 = 1_000_000
const facts = (over: Partial<SeatFacts> = {}): SeatFacts => ({
  conn: "new",
  signalingState: "stable",
  everConnected: false,
  firstHeardAt: T0,
  lastSignalAt: T0,
  lastFrameAt: -Infinity,
  upAt: 0,
  channelOpenAt: 0,
  downAt: 0,
  away: null,
  cameraOff: false,
  ...over,
})
const ctx = (now: number, over: { selfSuspect?: boolean; weak?: boolean } = {}) => ({ now: T0 + now, heardFrom: T0, selfSuspect: false, weak: false, ...over })

describe("seat transition logging", () => {
  it("puts signalingState on cant-connect lines only", () => {
    expect(seatTransitionMessage("peer", "connecting", "cant-connect", "have-local-offer")).toBe(
      "[jollity-rtc] seat peer: connecting → cant-connect signalingState=have-local-offer",
    )
    expect(seatTransitionMessage("peer", "connecting", "live", "stable")).toBe("[jollity-rtc] seat peer: connecting → live")
  })
})

describe("what a seat shows", () => {
  it("never heard: Connecting… in grace, then No signal", () => {
    expect(seatState(undefined, ctx(10_000))).toBe("connecting")
    expect(seatState(facts({ firstHeardAt: -Infinity, lastSignalAt: -Infinity }), ctx(25_000))).toBe("no-signal")
  })

  it("heard, never linked: Connecting… within the budget, then Can't connect while we still hear them", () => {
    expect(seatState(facts(), ctx(20_000))).toBe("connecting")
    expect(seatState(facts({ lastSignalAt: T0 + 25_000 }), ctx(31_000))).toBe("cant-connect")
  })

  it("never says Can't connect to a player we no longer hear; quiet for long reads No signal", () => {
    expect(seatState(facts(), ctx(31_000))).toBe("connecting")
    expect(seatState(facts(), ctx(46_000))).toBe("no-signal")
  })

  it("live while frames flow, weak when they flow badly", () => {
    const flowing = facts({ conn: "connected", everConnected: true, upAt: T0, lastFrameAt: T0 + 9_000 })
    expect(seatState(flowing, ctx(10_000))).toBe("live")
    expect(seatState(flowing, ctx(10_000, { weak: true }))).toBe("weak")
  })

  it("linked, video gone: Connecting… within the budget, then Can't connect", () => {
    const stalled = facts({ conn: "connected", everConnected: true, upAt: T0, lastFrameAt: T0 + 1_000, lastSignalAt: T0 + 25_000 })
    expect(seatState(stalled, ctx(15_000))).toBe("connecting")
    expect(seatState(stalled, ctx(25_000))).toBe("cant-connect")
  })

  it("counts video grace from channel open, but bounds a channel that never opens from ICE connected", () => {
    const stalled = facts({ conn: "connected", everConnected: true, upAt: T0, channelOpenAt: T0 + 8_000, lastSignalAt: T0 + 28_000 })
    const noChannel = facts({ conn: "connected", everConnected: true, upAt: T0, lastSignalAt: T0 + 28_000 })
    expect(seatState(facts({ conn: "connected", everConnected: true, lastSignalAt: T0 + 28_000 }), ctx(29_000))).toBe("connecting")
    expect(seatState(noChannel, ctx(19_000))).toBe("connecting")
    expect(seatState(noChannel, ctx(21_000))).toBe("cant-connect")
    expect(seatState(stalled, ctx(25_000))).toBe("connecting")
    expect(seatState(stalled, ctx(29_000))).toBe("cant-connect")
  })

  it("a link that dropped: Connecting… while it comes back, Can't connect after", () => {
    const dropped = facts({ conn: "disconnected", everConnected: true, downAt: T0 + 10_000, lastFrameAt: T0 + 9_000, lastSignalAt: T0 + 28_000 })
    expect(seatState(dropped, ctx(25_000))).toBe("connecting")
    expect(seatState(dropped, ctx(31_000))).toBe("cant-connect")
  })

  it("Away when their phone said so; Camera off when their view says so", () => {
    expect(seatState(facts({ away: "said" }), ctx(5_000))).toBe("away")
    expect(seatState(facts({ away: "timeout", conn: "disconnected", everConnected: true, downAt: T0 + 1_000 }), ctx(5_000))).toBe("connecting")
    expect(seatState(facts({ cameraOff: true, conn: "connected", upAt: T0 }), ctx(5_000))).toBe("camera-off")
  })

  it("blames nobody while the trouble may be ours", () => {
    expect(seatState(facts({ lastSignalAt: T0 + 25_000 }), ctx(31_000, { selfSuspect: true }))).toBe("connecting")
    expect(seatState(undefined, ctx(25_000, { selfSuspect: true }))).toBe("connecting")
  })
})

describe("settling a seat", () => {
  const run = (steps: Array<[number, Parameters<typeof settleSeat>[1]]>) => {
    let shown: ShownSeat | undefined
    return steps.map(([at, next]) => (shown = settleSeat(shown, next, at)).state)
  }

  it("shows up into live at once, and holds live through a short blip", () => {
    expect(run([[0, "connecting"], [100, "live"], [5_000, "connecting"], [6_500, "live"]])).toEqual(["connecting", "live", "live", "live"])
  })

  it("lets live fall once the drop outlasts the blip", () => {
    expect(run([[0, "live"], [5_000, "connecting"], [5_000 + SEAT_TIMES.blipMs, "connecting"]])).toEqual(["live", "live", "connecting"])
  })

  it("holds every other change, and shows Away at once", () => {
    expect(run([[0, "connecting"], [20_000, "no-signal"], [21_000, "no-signal"], [21_600, "no-signal"]])).toEqual(["connecting", "connecting", "connecting", "no-signal"])
    expect(run([[0, "live"], [100, "away"]])).toEqual(["live", "away"])
  })
})

describe("whether the trouble is this phone's", () => {
  const link = (over: Partial<LinkWindow> = {}): LinkWindow => ({ video: true, weak: false, cpuLimitedS: 0, seconds: 3, ...over })

  it("is ours when every link carrying video is weak at once, and two or more do", () => {
    expect(phoneStruggles([link({ weak: true }), link({ weak: true }), link({ video: false })])).toBe(true)
    expect(phoneStruggles([link({ weak: true }), link()])).toBe(false) // one weak link may be the peer's
    expect(phoneStruggles([link({ weak: true })])).toBe(false)
  })

  it("is ours when the encoder spent most of the window held back by the CPU", () => {
    expect(phoneStruggles([link({ cpuLimitedS: 2 })])).toBe(true)
    expect(phoneStruggles([link({ cpuLimitedS: 1 })])).toBe(false)
  })

  it("turns only after two windows in a row say so, either way", () => {
    let s: Streak = { on: false, count: 0 }
    const seen = [true, false, true, true, false, true, false, false].map((now) => (s = streak(s, now)).on)
    expect(seen).toEqual([false, false, false, true, true, true, true, false])
  })
})
