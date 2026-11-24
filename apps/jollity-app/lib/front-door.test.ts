// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  arrivalStep,
  behindHome,
  dropArrival,
  dropStrayHome,
  frontDoorHolds,
  frontDoorOpen,
  heldArrival,
  holdArrival,
  openFrontDoor,
  resetFrontDoor,
  watchFrontDoor,
} from "./front-door"
import type { GameStatus } from "./game-source"
import { handoverAt } from "./joined"
import type { BuildAnswer } from "./release/stale-build"

beforeEach(() => resetFrontDoor())

const registration: GameStatus = {
  kind: "registration",
  gameAt: 5000,
  closesAt: 4700,
  registered: false,
  withinHour: true,
  offerRegister: true,
  seat: { path: "free", ready: true },
}
const live = (registered: boolean, playEndsAt = 200): GameStatus => ({
  kind: "live",
  gameAt: 100,
  endsAt: 400,
  playEndsAt,
  registered,
  gameIndex: 7,
  rounds: 2,
  maxGroupSize: 6,
})
const CURRENT: BuildAnswer = { state: "current", last: "current" }
const STALE: BuildAnswer = { state: "stale", last: "stale" }
const step = (over: Partial<Parameters<typeof arrivalStep>[0]>) =>
  arrivalStep({
    href: "/chest?game=7",
    status: registration,
    now: 0,
    hostOnly: false,
    joined: false,
    gateDone: true,
    build: CURRENT,
    ...over,
  })

describe("the front door", () => {
  it("guards the game's pages, and nothing else", () => {
    for (const path of ["/game", "/prize-draw", "/chest", "/chest/"]) expect(behindHome(path)).toBe(true)
    for (const path of ["/", "/nux", "/permissions", "/connection-help"])
      expect(behindHome(path)).toBe(false)
  })

  it("a fresh load starts closed and opens once home is on screen", () => {
    expect(frontDoorOpen()).toBe(false)
    expect(frontDoorHolds("/chest", frontDoorOpen())).toBe(true)
    openFrontDoor()
    expect(frontDoorOpen()).toBe(true)
    expect(frontDoorHolds("/chest", true)).toBe(false)
    expect(frontDoorHolds("/game", true)).toBe(false)
  })

  it("never holds home and the other pages", () => {
    expect(frontDoorHolds("/", false)).toBe(false)
    expect(frontDoorHolds("/nux", false)).toBe(false)
    expect(frontDoorHolds("/connection-help", false)).toBe(false)
  })

  it("holds the URL the load was going to until it is let go", () => {
    expect(heldArrival()).toBeNull()
    holdArrival("/chest?game=270")
    expect(heldArrival()).toBe("/chest?game=270")
    // still there for home after the permission gate's detour
    expect(heldArrival()).toBe("/chest?game=270")
    dropArrival()
    expect(heldArrival()).toBeNull()
  })

  it("tells its watchers when the door opens and a load is held or let go, once each", () => {
    const listener = vi.fn()
    const stop = watchFrontDoor(listener)
    openFrontDoor()
    openFrontDoor()
    expect(listener).toHaveBeenCalledTimes(1)
    holdArrival("/game")
    dropArrival()
    dropArrival()
    expect(listener).toHaveBeenCalledTimes(3)
    stop()
    holdArrival("/chest")
    expect(listener).toHaveBeenCalledTimes(3)
  })

  it("takes out home's markup that a held load arrived with, and nothing else", () => {
    // Given a /chest load the host answered with the root page: home's prerender, which React did not claim
    document.body.innerHTML =
      '<div id="next-root"></div>' +
      '<div data-testid="home" data-state="loading"><main><h1>Jollity</h1></main></div>' +
      '<div class="pocket-claim"></div>'
    // When the door holds it
    const dropped = dropStrayHome(document)
    // Then home's leftover is gone and the page's own layers stay
    expect(dropped).toBe(1)
    expect(document.querySelector('[data-testid="home"]')).toBeNull()
    expect(document.getElementById("next-root")).not.toBeNull()
    expect(document.querySelector(".pocket-claim")).not.toBeNull()
  })

  it("leaves a load that arrived with its own page alone", () => {
    document.body.innerHTML = '<div id="next-root"></div>'
    expect(dropStrayHome(document)).toBe(0)
    expect(document.body.innerHTML).toBe('<div id="next-root"></div>')
  })
})

describe("arrivalStep", () => {
  it("sends a reopened chest on once the gates have run on a current build (23 Oct)", () => {
    expect(step({})).toBe("go")
    expect(step({ status: { kind: "none" } })).toBe("go")
    expect(step({ status: { kind: "processing" } })).toBe("go")
  })

  it("holds a stale build at home: the update screen, not the chest", () => {
    expect(step({ build: STALE })).toBe("hold")
    expect(step({ href: "/prize-draw?game=7", build: STALE, status: { kind: "processing" } })).toBe("hold")
  })

  it("waits for the status, the permission check and the build's first answer", () => {
    expect(step({ status: { kind: "loading" } })).toBe("wait")
    expect(step({ gateDone: false })).toBe("wait")
    expect(step({ build: { state: "unknown" } })).toBe("wait")
  })

  it("fails open, as the check does: an answer that could not tell, or a refused grant", () => {
    expect(step({ build: { state: "unknown", last: "unknown" } })).toBe("go")
    expect(step({ build: { state: "unknown", last: "denied" } })).toBe("go")
  })

  it("with no host the status never loads: it goes on after the gates", () => {
    expect(step({ status: { kind: "loading" }, hostOnly: true })).toBe("go")
    expect(step({ status: { kind: "loading" }, hostOnly: true, gateDone: false })).toBe("wait")
  })

  it("a reload mid-game goes straight back into the game, unchecked (decided 22 Oct)", () => {
    const now = 150
    expect(step({ href: "/game", status: live(true), now, joined: true, gateDone: false, build: STALE })).toBe("go")
    expect(step({ href: "/game", status: live(true, 120), now, joined: true, build: { state: "unknown" } })).toBe("go")
    expect(step({ href: "/game", status: { kind: "waiting", gameAt: 1000 }, now: handoverAt(1000), joined: true })).toBe("go")
  })

  it("a reload in the report window goes straight back into the game just played (#1418)", () => {
    const next = { kind: "scheduled", gameAt: 5000, registrationAt: 4400, withinHour: false } as const
    const reporting: GameStatus = { ...next, reportingGameAt: 100 }
    expect(step({ href: "/game", status: reporting, now: 300, joined: true, gateDone: false, build: STALE })).toBe("go")
    expect(step({ href: "/game", status: { kind: "none", reportingGameAt: 100 }, now: 300, joined: true, build: STALE })).toBe("go")
    // not in that game, or no game in its report window: the gates and the build check
    expect(step({ href: "/game", status: reporting, now: 300, build: STALE })).toBe("hold")
    expect(step({ href: "/game", status: next, now: 300, joined: true, build: STALE })).toBe("hold")
  })

  it("leaves a game to go into to home's own handover, with its own check", () => {
    // a late joiner, and a fresh load on yesterday's chest while today's room is open
    expect(step({ href: "/game", status: live(true), now: 150 })).toBe("drop")
    expect(step({ status: live(true), now: 150, joined: true })).toBe("drop")
    expect(step({ status: { kind: "waiting", gameAt: 1000 }, now: 900 })).toBe("drop")
  })

  it("a game the player is not in, or whose turns are over, is not home's to hand over", () => {
    expect(step({ status: live(false), now: 150 })).toBe("go")
    expect(step({ status: live(false), now: 150, build: STALE })).toBe("hold")
    // the last turn is over and this device never went in
    expect(step({ href: "/game", status: live(true, 120), now: 150, build: STALE })).toBe("hold")
  })
})
