// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import type { GameStatus } from "./game-source"
import type { HomeView } from "./home-gate"
import { homeHandover, homeScreen, homeSituation, type HomeScreenInput } from "./home-screen"
import { handoverAt } from "./joined"

const NOW = 1_700_000_000
const GAME_AT = NOW + 1_200
const FUNDS = { free: 0n, required: 20n, decimals: 10, symbol: "PAS" }

const registration = (over: Partial<Extract<GameStatus, { kind: "registration" }>> = {}): GameStatus => ({
  kind: "registration",
  gameAt: GAME_AT,
  closesAt: GAME_AT - 90,
  registered: false,
  withinHour: true,
  offerRegister: true,
  signup: "idle",
  ...over,
})
const starting = (registered: boolean): GameStatus => ({ kind: "starting", gameAt: NOW + 28, registered, withinHour: true })
const live = (registered: boolean, playEndsAt = NOW + 100): GameStatus => ({
  kind: "live",
  gameAt: NOW - 50,
  endsAt: NOW + 500,
  playEndsAt,
  registered,
  gameIndex: 3,
  rounds: 2,
  maxGroupSize: 6,
})
const scheduled = (gameAt: number): GameStatus => ({
  kind: "scheduled",
  gameAt,
  registrationAt: gameAt - 3_690,
  withinHour: NOW >= gameAt - 3_600,
})

const input = (status: GameStatus, over: Partial<HomeScreenInput> = {}): HomeScreenInput => ({
  view: { status, gate: null, platform: "other" },
  reconnecting: false,
  ...over,
})
const gated = (status: GameStatus, gate: HomeView["gate"]): HomeScreenInput => ({
  view: { status, gate, platform: "ios" },
  reconnecting: false,
})
const kind = (status: GameStatus, over?: Partial<HomeScreenInput>) => homeScreen(input(status, over), NOW).kind

describe("homeScreen: the gates come first, in their order", () => {
  const restart = { reason: "chain-lost", consecutiveLost: 1 } as const

  it("host-only covers everything, the restart card included", () => {
    expect(homeScreen({ ...gated(starting(false), "host-only"), restart }, NOW)).toEqual({ kind: "host-only" })
  })
  it("an update covers the restart card and the status", () => {
    expect(homeScreen({ ...gated(registration(), "update"), restart }, NOW)).toEqual({ kind: "update", platform: "ios" })
  })
  it("the restart card covers the status, a missed game included", () => {
    expect(kind(starting(false), { restart })).toBe("restart")
    expect(kind(registration(), { restart })).toBe("restart")
  })
  it("a page load passing through to a game page shows the bare title, not a screen it is about to leave", () => {
    expect(kind(registration(), { passing: true })).toBe("loading")
    expect(kind(starting(false), { passing: true })).toBe("loading")
    expect(kind({ kind: "none" }, { passing: true })).toBe("loading")
    // the gates and the restart card still come first
    expect(homeScreen({ ...gated(registration(), "update"), passing: true }, NOW)).toEqual({ kind: "update", platform: "ios" })
    expect(kind(registration(), { passing: true, restart })).toBe("restart")
  })
  it("the restart card carries the game's time for its countdown, and the reconnect minute", () => {
    expect(homeScreen(input(starting(true), { restart, reconnecting: true }), NOW)).toEqual({
      kind: "restart",
      reason: "chain-lost",
      consecutiveLost: 1,
      reconnecting: true,
      gameAt: NOW + 28,
    })
    expect(homeScreen(input({ kind: "none" }, { restart }), NOW)).not.toHaveProperty("gameAt")
  })
  it("the waiting room keeps its screen and carries the restart card on its line", () => {
    expect(homeScreen(input({ kind: "waiting", gameAt: GAME_AT }, { restart, reconnecting: true }), NOW)).toEqual({
      kind: "waiting-room",
      gameAt: GAME_AT,
      restart: { reason: "chain-lost", consecutiveLost: 1, reconnecting: true },
    })
    expect(homeScreen(input({ kind: "waiting", gameAt: GAME_AT }), NOW)).toEqual({ kind: "waiting-room", gameAt: GAME_AT })
  })
  it("an update still covers the waiting room under a restart card", () => {
    expect(homeScreen({ ...gated({ kind: "waiting", gameAt: GAME_AT }, "update"), restart }, NOW)).toEqual({
      kind: "update",
      platform: "ios",
    })
  })
})

describe("homeScreen: the status", () => {
  it.each<[string, GameStatus, string]>([
    ["loading", { kind: "loading" }, "loading"],
    ["no game", { kind: "none" }, "no-game"],
    ["a queue more than an hour out", scheduled(NOW + 7_200), "queued"],
    ["a queue within the hour", scheduled(NOW + 1_800), "queued"],
    ["registration open", registration(), "register"],
    ["registered while registration is open", registration({ registered: true, offerRegister: false }), "registered"],
    ["registered after it closed", starting(true), "registered"],
    ["not registered after it closed", starting(false), "missed"],
    ["a running game without the player", live(false), "missed"],
    ["registered in a running game with turns left", live(true), "loading"],
    ["the waiting room", { kind: "waiting", gameAt: NOW + 200 }, "waiting-room"],
    ["the result being processed", { kind: "processing" }, "wrapping-up"],
  ])("%s", (_case, status, expected) => {
    expect(kind(status)).toBe(expected)
  })

  it("shows a player who never signed up the one missed screen, closed or running", () => {
    expect(homeScreen(input(starting(false)), NOW)).toEqual({ kind: "missed" })
    expect(homeScreen(input(live(false)), NOW)).toEqual({ kind: "missed" })
  })

  it("shows the bare title exactly while the late join hands over", () => {
    // the source ends live at playEndsAt
    for (const playEndsAt of [NOW + 100, NOW + 1]) {
      const status = live(true, playEndsAt)
      expect(kind(status) === "loading").toBe(homeHandover(status, NOW, false) !== null)
    }
  })

  it("asks an unfunded account to top up, and offers Register once the funds are not known", () => {
    const seat = { path: "unfunded" } as never
    expect(homeScreen(input(registration({ seat, funds: FUNDS as never })), NOW)).toEqual({
      kind: "unfunded",
      gameAt: GAME_AT,
      funds: FUNDS,
    })
    expect(kind(registration({ seat }))).toBe("register")
  })

  it("hands Register the deadline and the sign-up under way", () => {
    expect(homeScreen(input(registration({ signup: "sending" })), NOW)).toEqual({
      kind: "register",
      gameAt: GAME_AT,
      closesAt: GAME_AT - 90,
      signup: "sending",
    })
  })

  it("shows a queued game's time, however far out it is", () => {
    for (const at of [NOW + 1_800, NOW + 7_200]) {
      expect(homeScreen(input(scheduled(at)), NOW)).toEqual({ kind: "queued", gameAt: at })
    }
  })
})

describe("homeSituation: what the hooks key off", () => {
  it("is registered before the game only, and in the waiting room on its own", () => {
    expect(homeSituation(starting(true), NOW)).toMatchObject({ registered: true, inWaiting: false, goesIn: false })
    expect(homeSituation({ kind: "waiting", gameAt: GAME_AT }, NOW)).toMatchObject({ registered: false, inWaiting: true, gameAt: GAME_AT })
    expect(homeSituation(live(true), NOW)).toMatchObject({ registered: false, goesIn: true, gameAt: undefined })
  })
  it("keeps a restart card's situation: the hooks do not see the card", () => {
    // the same status under a card keeps the waiting room's wake lock and camera
    expect(homeSituation({ kind: "waiting", gameAt: GAME_AT }, NOW).inWaiting).toBe(true)
  })
})

describe("homeHandover: into /game", () => {
  it("takes a late joiner in while turns remain, not through the door", () => {
    expect(homeHandover(live(true), NOW, false)).toEqual({ gameAt: NOW - 50, door: false })
    expect(homeHandover(live(true, NOW), NOW, true)).toBeNull()
    expect(homeHandover(live(false), NOW, true)).toBeNull()
  })
  it("opens the waiting-room door at the handover, and only with the camera live", () => {
    const status: GameStatus = { kind: "waiting", gameAt: GAME_AT }
    expect(homeHandover(status, handoverAt(GAME_AT) - 1, true)).toBeNull()
    expect(homeHandover(status, handoverAt(GAME_AT), false)).toBeNull()
    expect(homeHandover(status, handoverAt(GAME_AT), true)).toEqual({ gameAt: GAME_AT, door: true })
  })
  it("never hands over from a status before the waiting room", () => {
    expect(homeHandover(starting(true), NOW + 1_000, true)).toBeNull()
    expect(homeHandover(registration({ registered: true }), NOW + 1_000, true)).toBeNull()
  })
})
