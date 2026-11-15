// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { beforeEach, describe, expect, it, vi } from "vitest"
import type { GameSource } from "./game-source"

const M = vi.hoisted(() => ({
  remembered: undefined as number | undefined,
  joined: false,
  stored: undefined as number | undefined,
  scheduled: undefined as number | undefined,
  remember: vi.fn(),
}))

const host = vi.hoisted(() => {
  const values = new Map<string, unknown>()
  return {
    values,
    readJSON: async (key: string) => values.get(key) ?? null,
    writeJSON: async (key: string, value: unknown) => {
      values.set(key, value)
    },
  }
})
vi.mock("@parity/product-sdk-host", () => ({
  getHostLocalStorage: async () => ({ readJSON: host.readJSON, writeJSON: host.writeJSON }),
}))

vi.mock("./post-game", () => ({
  postGameIndex: () => M.remembered,
  rememberPostGame: M.remember,
}))
vi.mock("./joined", () => ({ hasJoined: () => M.joined }))
vi.mock("./game-votes", () => ({ storedVotesGame: () => Promise.resolve(M.stored) }))
vi.mock("./draw/draw-schedule", () => ({
  peekDrawSchedule: () => M.scheduled,
  drawEntryPath: (scheduled: number | undefined) => scheduled === 0 ? "/chest" : "/prize-draw",
}))

const { handoffFromStatus, playedGameIndex, resolvePostGameHandoff, tapDestination, waitForPostGameHandoff } =
  await import("./post-game-handoff")

function source(reportStatus: GameSource["reportStatus"], player = "alice"): GameSource {
  return { player, reportStatus } as GameSource
}

beforeEach(() => {
  M.remembered = undefined
  M.joined = false
  M.stored = undefined
  M.scheduled = undefined
  M.remember.mockClear()
  host.values.clear()
})

describe("post-game handoff", () => {

  it("routes a counted report to the draw and a no-draw game to the chest", () => {
    expect(handoffFromStatus({ gameIndex: 7, closed: true, report: "sent" })?.href)
      .toBe("/prize-draw?game=7")
    M.scheduled = 0
    expect(handoffFromStatus({ gameIndex: 7, closed: true, report: "sent" })?.href)
      .toBe("/chest?game=7")
  })

  it("tells the card that a counted report landed", async () => {
    // When
    handoffFromStatus({ gameIndex: 7, closed: true, report: "sent" })

    // Then
    await vi.waitFor(() => expect(host.values.get("jollity.seen:7")).toEqual({ chest: false, draw: false, report: true }))
  })

  it.each(["not-sent", "gone"] as const)("tells the card nothing of a final %s report", async (report) => {
    // When
    handoffFromStatus({ gameIndex: 7, closed: true, report })
    await new Promise((resolve) => setTimeout(resolve, 0))

    // Then
    expect(host.values.has("jollity.seen:7")).toBe(false)
  })

  it.each(["not-sent", "gone"] as const)("routes final %s to the chest", (report) => {
    expect(handoffFromStatus({ gameIndex: 1097, closed: true, report })?.href)
      .toBe("/chest?game=1097")
  })

  it("does not redirect an open or unknown game", () => {
    expect(handoffFromStatus({ gameIndex: 7, closed: false, report: "not-sent" })).toBeNull()
    expect(handoffFromStatus({ gameIndex: 7, closed: true, report: "unknown" })).toBeNull()
  })

  it("prefers a newer joined-current game over remembered and stored games", async () => {
    M.remembered = 265
    M.stored = 264
    M.joined = true
    expect(await playedGameIndex(source(async () => ({ gameIndex: 266, gameDate: 50, closed: false, report: "unknown" })))).toBe(266)
  })

  it("keeps a remembered handoff for the same game or an unrelated current game", async () => {
    M.remembered = 265
    M.joined = true
    expect(await playedGameIndex(source(async () => ({ gameIndex: 265, gameDate: 50, closed: true, report: "sent" })))).toBe(265)
    M.joined = false
    expect(await playedGameIndex(source(async () => ({ gameIndex: 266, gameDate: 60, closed: false, report: "unknown" })))).toBe(265)
  })

  it("falls back to the retained vote book when no remembered or joined game exists", async () => {
    M.stored = 6
    expect(await playedGameIndex(source(async () => ({ gameIndex: 5, gameDate: 50, closed: false, report: "unknown" })))).toBe(6)
  })

  it("a help-page arrival before settlement waits and then hands off once, without a game loop", async () => {
    M.remembered = 1097
    const statuses = [
      { gameIndex: 1097, closed: false, report: "not-sent" as const },
      { gameIndex: 1097, closed: true, report: "gone" as const },
    ]
    const read = vi.fn(async () => statuses.shift()!)
    const abort = new AbortController()
    const result = await waitForPostGameHandoff(source(read), { signal: abort.signal, pollMs: 0 })
    expect(result).toEqual({ gameIndex: 1097, href: "/chest?game=1097", report: "gone" })
    expect(read).toHaveBeenCalledTimes(2)
    expect(result?.href).not.toBe("/game")
  })

  it("cancels a pending settlement watch on unmount", async () => {
    M.remembered = 9
    const abort = new AbortController()
    const waiting = waitForPostGameHandoff(
      source(async () => ({ gameIndex: 9, closed: false, report: "not-sent" })),
      { signal: abort.signal, pollMs: 10_000 },
    )
    abort.abort()
    await expect(waiting).resolves.toBeNull()
  })

  it("does nothing when no played game can be resolved", async () => {
    const missing = source(async () => ({ gameIndex: 12, gameDate: 120, closed: false, report: "unknown" }), "")
    await expect(resolvePostGameHandoff(missing)).resolves.toBeNull()
  })

  // H-P1 (formal lane P, variant 2): the watch picked its game ONCE, so a
  // first read that failed — the unknown status names no game, so the intact
  // joined marker cannot be checked — ended the watch for good and the player
  // stayed on the help page after the game. The next read answers.
  it("H-P1: a watch whose first pick is undefined keeps looking and hands off", async () => {
    M.joined = true
    const read = vi.fn(async () => read.mock.calls.length === 1
      ? { gameIndex: undefined, closed: false, report: "unknown" as const }
      : { gameIndex: 7, gameDate: 50, closed: true, report: "not-sent" as const })
    const controller = new AbortController()
    const waiting = waitForPostGameHandoff(source(read), { signal: controller.signal, pollMs: 1 })
    const result = await Promise.race([
      waiting,
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 1_000)),
    ])
    controller.abort()
    expect(result).not.toBe("timeout")
    expect(result).toEqual({ gameIndex: 7, href: "/chest?game=7", report: "not-sent" })
  })

  // H-P3 (formal lane P, variant 2): the watcher hands off while a tap is
  // between its read and its route; the tap's own handoff is then refused and
  // the page replaced /game after the chest. The tap must route nowhere.
  it("H-P3: a tap that resolves after a handoff routes nowhere", async () => {
    M.remembered = 7
    M.joined = true
    const src = source(async (gameIndex?: number) => ({
      gameIndex: gameIndex ?? 7,
      gameDate: 50,
      closed: true,
      report: "sent" as const,
    }))
    // the watcher handed off while this read was in flight
    expect(await tapDestination(src, () => true)).toBeNull()
  })

  it("H-P3 control: a tap that runs alone takes its handoff, or falls back to /game", async () => {
    M.remembered = 7
    M.joined = true
    const src = source(async (gameIndex?: number) => ({
      gameIndex: gameIndex ?? 7,
      gameDate: 50,
      closed: true,
      report: "sent" as const,
    }))
    expect(await tapDestination(src, () => false)).toEqual({
      gameIndex: 7,
      href: "/prize-draw?game=7",
      report: "sent",
    })
    expect(await tapDestination(null, () => false)).toBe("/game")
  })
})
