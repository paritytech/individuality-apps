// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { buildCheckWanted, ENTRY_RECHECK_LEAD, entryBuildClear, entryRecheck, homeGate } from "./home-gate"
import type { GameStatus } from "./game-source"
import { handoverAt } from "./joined"
import type { BuildAnswer } from "./release/stale-build"

const registration = (registered: boolean) =>
  ({ kind: "registration", gameAt: 1, closesAt: 1, registered, withinHour: true, offerRegister: true, seat: { path: "free", ready: true } }) as GameStatus
const live = (registered: boolean, playEndsAt = 2): GameStatus => ({
  kind: "live",
  gameAt: 1,
  endsAt: 300,
  playEndsAt,
  registered,
  gameIndex: 1,
  rounds: 2,
  maxGroupSize: 6,
})
const waiting: GameStatus = { kind: "waiting", gameAt: 1000 }
/** a device that is not in the status's game, and no page load held */
const OUT = { joined: false, held: false }
/** a device already in the status's game: a reload or relaunch mid-game */
const IN = { joined: true, held: false }
const HANDOVER = handoverAt(waiting.gameAt)

describe("homeGate", () => {
  it("a stale build before sign-up gets the update screen", () => {
    expect(homeGate(false, "stale", registration(false), 0, OUT)).toBe("update")
  })
  it("the same build, or one we could not read, is allowed", () => {
    expect(homeGate(false, "current", registration(false), 0, OUT)).toBeNull()
    expect(homeGate(false, "unknown", registration(false), 0, OUT)).toBeNull()
    expect(homeGate(false, "current", live(true), 0, OUT)).toBeNull()
    expect(homeGate(false, "unknown", { kind: "processing" }, 0, { joined: false, held: true })).toBeNull()
  })
  it("covers a registered player before the game: sign-up closed, starting, and the waiting room", () => {
    expect(homeGate(false, "stale", registration(true), 0, OUT)).toBe("update")
    expect(homeGate(false, "stale", { kind: "starting", gameAt: 1000, registered: true, withinHour: true }, 0, OUT)).toBe("update")
    expect(homeGate(false, "stale", waiting, 0, OUT)).toBe("update")
  })
  it("keeps the door shut past the handover for a device not yet in the game (#1102)", () => {
    expect(homeGate(false, "stale", waiting, HANDOVER - 1, OUT)).toBe("update")
    expect(homeGate(false, "stale", waiting, HANDOVER, OUT)).toBe("update")
    expect(homeGate(false, "stale", waiting, 999, OUT)).toBe("update")
  })
  it("stops a late joiner going in for the first time (#1102)", () => {
    expect(homeGate(false, "stale", live(true), 0, OUT)).toBe("update")
  })
  it("never stops a device already in the game: from the handover on, mid-game", () => {
    expect(homeGate(false, "stale", waiting, HANDOVER - 1, IN)).toBe("update")
    expect(homeGate(false, "stale", waiting, HANDOVER, IN)).toBeNull()
    expect(homeGate(false, "stale", live(true), 0, IN)).toBeNull()
  })
  it("not over a game the player cannot go into, nor while it is processed", () => {
    expect(homeGate(false, "stale", live(false), 0, OUT)).toBeNull()
    // the last turn is over
    expect(homeGate(false, "stale", live(true, 2), 2, OUT)).toBeNull()
    expect(homeGate(false, "stale", { kind: "processing" }, 0, OUT)).toBeNull()
  })
  it("a player who cannot sign up any more is not gated", () => {
    expect(homeGate(false, "stale", { kind: "starting", gameAt: 1000, registered: false, withinHour: true }, 0, OUT)).toBeNull()
  })
  it("a page load held at home on a stale build gets the update screen, whatever the status (#1137)", () => {
    const held = { joined: false, held: true }
    expect(homeGate(false, "stale", { kind: "processing" }, 0, held)).toBe("update")
    expect(homeGate(false, "stale", { kind: "none" }, 0, held)).toBe("update")
    expect(homeGate(false, "stale", live(false), 0, held)).toBe("update")
  })
  it("no host comes first", () => {
    expect(homeGate(true, "stale", registration(false), 0, OUT)).toBe("host-only")
    expect(homeGate(true, "current", { kind: "loading" }, 0, OUT)).toBe("host-only")
    expect(homeGate(true, "stale", { kind: "processing" }, 0, { joined: false, held: true })).toBe("host-only")
  })
})

describe("buildCheckWanted", () => {
  it("runs before the game, and on the way in for a device not yet in it", () => {
    expect(buildCheckWanted({ kind: "loading" }, 0, OUT)).toBe(true)
    expect(buildCheckWanted(registration(true), 0, OUT)).toBe(true)
    expect(buildCheckWanted(waiting, HANDOVER - 1, OUT)).toBe(true)
    expect(buildCheckWanted(waiting, HANDOVER, OUT)).toBe(true)
    expect(buildCheckWanted(live(true), 0, OUT)).toBe(true)
  })
  it("stops for a device in the game, a game it cannot go into, and while it is processed", () => {
    expect(buildCheckWanted(waiting, HANDOVER - 1, IN)).toBe(true)
    expect(buildCheckWanted(waiting, HANDOVER, IN)).toBe(false)
    expect(buildCheckWanted(live(true), 0, IN)).toBe(false)
    expect(buildCheckWanted(live(false), 0, OUT)).toBe(false)
    expect(buildCheckWanted(live(true, 2), 2, OUT)).toBe(false)
    expect(buildCheckWanted({ kind: "processing" }, 0, OUT)).toBe(false)
  })
  it("always runs for a page load held at home (#1137)", () => {
    const held = { joined: true, held: true }
    expect(buildCheckWanted({ kind: "processing" }, 0, held)).toBe(true)
    expect(buildCheckWanted(live(true), 0, held)).toBe(true)
  })
})

describe("entryRecheck", () => {
  it("asks again for the waiting room from ENTRY_RECHECK_LEAD before its handover", () => {
    const from = handoverAt(1000) - ENTRY_RECHECK_LEAD
    expect(entryRecheck(waiting, from - 1, false)).toBeUndefined()
    expect(entryRecheck(waiting, from, false)).toBe(1000)
    expect(entryRecheck(waiting, 999, false)).toBe(1000)
  })
  it("asks again for a late joiner's game while turns remain", () => {
    expect(entryRecheck(live(true), 0, false)).toBe(1)
    expect(entryRecheck(live(true, 2), 2, false)).toBeUndefined()
    expect(entryRecheck(live(false), 0, false)).toBeUndefined()
  })
  it("never for a device already in the game, nor without a game to enter", () => {
    expect(entryRecheck(waiting, 999, true)).toBeUndefined()
    expect(entryRecheck(live(true), 0, true)).toBeUndefined()
    expect(entryRecheck(registration(true), 0, false)).toBeUndefined()
    expect(entryRecheck({ kind: "processing" }, 0, false)).toBeUndefined()
  })
})

describe("entryBuildClear", () => {
  const atDoor = handoverAt(1000)
  const answer = (over: Partial<BuildAnswer>): BuildAnswer => ({ state: "unknown", ...over })

  it("waits at the door until the build is asked for this game (game 268)", () => {
    // current since the app opened, before the release: not enough to go in
    expect(entryBuildClear(waiting, atDoor, false, answer({ state: "current", last: "current" }))).toBe(false)
    // asked for another game
    expect(entryBuildClear(waiting, atDoor, false, answer({ state: "current", last: "current", askedFor: 400 }))).toBe(false)
    expect(entryBuildClear(waiting, atDoor, false, answer({ state: "current", last: "current", askedFor: 1000 }))).toBe(true)
  })
  it("a stale build never goes in, whatever it was asked for", () => {
    expect(entryBuildClear(waiting, atDoor, false, answer({ state: "stale", last: "stale", askedFor: 1000 }))).toBe(false)
    expect(entryBuildClear(live(true), 0, false, answer({ state: "stale", last: "stale", askedFor: 1 }))).toBe(false)
  })
  it("a late joiner waits for its own answer too", () => {
    expect(entryBuildClear(live(true), 0, false, answer({}))).toBe(false)
    expect(entryBuildClear(live(true), 0, false, answer({ state: "current", last: "current", askedFor: 1 }))).toBe(true)
  })
  it("fails open: a check that could not tell, and a refused grant", () => {
    expect(entryBuildClear(waiting, atDoor, false, answer({ last: "unknown", askedFor: 1000 }))).toBe(true)
    expect(entryBuildClear(waiting, atDoor, false, answer({ last: "denied" }))).toBe(true)
    // a recheck that could not tell keeps the standing "current"
    expect(entryBuildClear(waiting, atDoor, false, answer({ state: "current", last: "unknown", askedFor: 1000 }))).toBe(true)
  })
  it("a device already in the game goes back in at once, whatever the build", () => {
    expect(entryBuildClear(waiting, atDoor, true, answer({ state: "stale", last: "stale" }))).toBe(true)
    expect(entryBuildClear(live(true), 0, true, answer({}))).toBe(true)
  })
  it("nothing to wait for without an entry", () => {
    expect(entryBuildClear(registration(true), 0, false, answer({}))).toBe(true)
  })
})
