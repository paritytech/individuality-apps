// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, describe, expect, it, vi } from "vitest"
import type { GameSource } from "../game-source"
import type { PrizeDrawView } from "./prize-draw"
import { doubtOf, loadDraw, peekDraw } from "./draw-load"
import { forgetDrawMisses, rememberDrawMiss } from "./draw-miss"

const draw = (phase: PrizeDrawView["phase"]): PrizeDrawView =>
  ({ airdropIndex: 0, phase, prizeUsd: 10, userTicket: "aa", winningTickets: ["aa"], won: true } as PrizeDrawView)

/** a source whose draw reads come back in the order given */
function sourceReturning(...reads: PrizeDrawView[][]) {
  // the last read repeats once the script runs out, as a chain that has not moved
  const prizeDrawView = vi.fn(async () => (reads.length > 1 ? reads.shift()! : (reads[0] ?? [])))
  return { source: { prizeDrawView } as unknown as GameSource, prizeDrawView }
}

let game = 1000 // every test its own game, since loads are shared per game
afterEach(() => {
  vi.useRealTimers()
  forgetDrawMisses()
})

describe("loadDraw", () => {
  it("shares one load per game between the session and the page", async () => {
    const g = game++
    const { source, prizeDrawView } = sourceReturning([draw("drawn")])
    const first = loadDraw(source, g)
    const second = loadDraw(source, g)
    expect(second).toBe(first)
    await first.promise
    expect(prizeDrawView).toHaveBeenCalledTimes(1)
  })

  it("hands the page the answer to open on, once it has one", async () => {
    const g = game++
    const { source } = sourceReturning([draw("drawn")])
    expect(peekDraw(g)).toBeUndefined()
    await loadDraw(source, g).promise
    expect(peekDraw(g)).toMatchObject({ kind: "ready", draw: { phase: "drawn" } })
  })

  it("says it is waiting only when the chain says the draw is not drawn, and resolves once it is", async () => {
    vi.useFakeTimers()
    const g = game++
    const { source } = sourceReturning([draw("waiting")], [draw("drawn")])
    const load = loadDraw(source, g)
    expect(load.waiting).toBe(false)
    const told = vi.fn()
    load.subscribe(told)
    await vi.advanceTimersByTimeAsync(0)
    expect(load.waiting).toBe(true)
    await vi.advanceTimersByTimeAsync(3000)
    await expect(load.promise).resolves.toMatchObject({ kind: "ready", draw: { phase: "drawn" } })
    expect(load.waiting).toBe(false)
    expect(told).toHaveBeenCalled()
  })

  it("never hands over a draw that is not drawn, however long it waits", async () => {
    vi.useFakeTimers()
    const g = game++
    const { source } = sourceReturning([draw("waiting")])
    const load = loadDraw(source, g)
    let settled = false
    void load.promise.then(() => (settled = true))
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(settled).toBe(false)
    expect(load.waiting).toBe(true)
  })

  it("stops reading a draw still drawing once nobody holds it, and the next ask starts afresh", async () => {
    vi.useFakeTimers()
    const g = game++
    const { source, prizeDrawView } = sourceReturning([draw("waiting")])
    const load = loadDraw(source, g)
    await vi.advanceTimersByTimeAsync(0)
    expect(load.waiting).toBe(true)
    load.release()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(prizeDrawView).toHaveBeenCalledTimes(1)
    const again = loadDraw(source, g)
    expect(again).not.toBe(load)
    await vi.advanceTimersByTimeAsync(0)
    expect(prizeDrawView).toHaveBeenCalledTimes(2)
    again.release()
  })

  it("keeps reading while anyone holds it, and a hand-over within one poll keeps the read", async () => {
    vi.useFakeTimers()
    const g = game++
    const { source, prizeDrawView } = sourceReturning([draw("waiting")])
    // the confirm screen's preload, let go of as the route changes, and the page picking it up
    const preload = loadDraw(source, g)
    await vi.advanceTimersByTimeAsync(0)
    preload.release()
    const page = loadDraw(source, g)
    expect(page).toBe(preload)
    await vi.advanceTimersByTimeAsync(9_000)
    expect(prizeDrawView).toHaveBeenCalledTimes(4)
    page.release()
    page.release() // a second release by mistake takes nothing below none
    await vi.advanceTimersByTimeAsync(60_000)
    expect(prizeDrawView).toHaveBeenCalledTimes(4)
  })

  it("reports a game with no draw, once reading again has not found one", async () => {
    vi.useFakeTimers()
    const g = game++
    const { source, prizeDrawView } = sourceReturning([])
    const load = loadDraw(source, g)
    await vi.advanceTimersByTimeAsync(10_000)
    await expect(load.promise).resolves.toEqual({ kind: "none" })
    expect(prizeDrawView).toHaveBeenCalledTimes(4)
    expect(peekDraw(g)).toEqual({ kind: "none" })
  })

  it("never turns failed reads into no-draw, and can recover a drawn result", async () => {
    const g = game++
    const prizeDrawView = vi
      .fn<GameSource["prizeDrawView"]>()
      .mockRejectedValueOnce(new Error("rpc 1"))
      .mockRejectedValueOnce(new Error("rpc 2"))
      .mockRejectedValueOnce(new Error("rpc 3"))
      .mockRejectedValueOnce(new Error("rpc 4"))
      .mockResolvedValue([draw("drawn")])
    const source = { prizeDrawView } as unknown as GameSource

    for (let attempt = 0; attempt < 4; attempt += 1) {
      await expect(loadDraw(source, g).promise).rejects.toThrow(`rpc ${attempt + 1}`)
      expect(peekDraw(g)).toBeUndefined()
    }
    await expect(loadDraw(source, g).promise).resolves.toMatchObject({ kind: "ready" })
    expect(peekDraw(g)).toMatchObject({ kind: "ready" })
  })

  // ── a drawn read that looks wrong ─────────────────────────────────────────
  // Measured 2026-09-30 on paseo, game 147: an Android host read returned the
  // draw without the player's own ticket, which the chain held the whole time.

  it("takes a clean read at its word, reading once", async () => {
    const g = game++
    const { source, prizeDrawView } = sourceReturning([{ ...draw("drawn"), listedEntries: 3, totalEntries: 3 }])
    await loadDraw(source, g).promise
    expect(prizeDrawView).toHaveBeenCalledTimes(1)
  })

  it("reads again when the entry list comes back short, and keeps the full one", async () => {
    vi.useFakeTimers()
    const g = game++
    const short = { ...draw("drawn"), userTicket: "", listedEntries: 2, totalEntries: 3 }
    const full = { ...draw("drawn"), listedEntries: 3, totalEntries: 3 }
    const { source, prizeDrawView } = sourceReturning([short], [full])
    const load = loadDraw(source, g)
    await vi.advanceTimersByTimeAsync(1_000)
    await expect(load.promise).resolves.toMatchObject({ kind: "ready", draw: { listedEntries: 3, userTicket: "aa" } })
    expect(prizeDrawView).toHaveBeenCalledTimes(2)
    expect(peekDraw(g)).toMatchObject({ kind: "ready" })
  })

  it("shows a read that stays wrong, but does not keep it: the next ask reads afresh", async () => {
    vi.useFakeTimers()
    const g = game++
    // a list the read cannot tell complete: no count of the chain's to hold it to
    const missing = { ...draw("drawn"), userTicket: "", won: false, listedEntries: 3, totalEntries: undefined }
    const { source, prizeDrawView } = sourceReturning([missing])
    const preload = loadDraw(source, g)
    await vi.advanceTimersByTimeAsync(10_000)
    await expect(preload.promise).resolves.toMatchObject({ kind: "ready", draw: { userTicket: "" } })
    expect(prizeDrawView).toHaveBeenCalledTimes(4)
    // the draw page, after the confirm screen's preload
    expect(peekDraw(g)).toBeUndefined()
    const page = loadDraw(source, g)
    expect(page).not.toBe(preload)
  })

  it("opens a spectator's draw on the first read when the list is complete", async () => {
    const g = game++
    const watching = { ...draw("drawn"), userTicket: "", won: false, listedEntries: 28, totalEntries: 28 }
    const { source, prizeDrawView } = sourceReturning([watching])
    await expect(loadDraw(source, g).promise).resolves.toMatchObject({ kind: "ready", draw: { userTicket: "" } })
    expect(prizeDrawView).toHaveBeenCalledTimes(1)
    // kept: the draw screen opens on it, with no second load
    expect(peekDraw(g)).toMatchObject({ kind: "ready" })
  })

  it("takes a missing ticket at its word when this phone's sign-up left it out (#167)", async () => {
    const g = game++
    rememberDrawMiss(g, "not-member-yet")
    const watching = { ...draw("drawn"), userTicket: "", won: false, listedEntries: 3, totalEntries: 3 }
    const { source, prizeDrawView } = sourceReturning([watching])
    await expect(loadDraw(source, g).promise).resolves.toMatchObject({ kind: "ready", draw: { userTicket: "" } })
    expect(prizeDrawView).toHaveBeenCalledTimes(1)
    expect(peekDraw(g)).toMatchObject({ kind: "ready" })
  })
})

describe("doubtOf", () => {
  const drawn = { ...draw("drawn"), listedEntries: 3, totalEntries: 3 }
  it("finds nothing wrong with a full read that holds the player's ticket", () => {
    expect(doubtOf([drawn], drawn)).toBeNull()
  })
  it("names each thing that makes a read suspect", () => {
    expect(doubtOf([], undefined)).toBe("no draw came back")
    expect(doubtOf([drawn], { ...drawn, listedEntries: 2 })).toBe("the entry list came back short (2 of 3)")
    expect(doubtOf([drawn], { ...drawn, userTicket: "", totalEntries: undefined })).toBe("no ticket for this player in the entries")
  })
  it("takes a complete list without the player at its word: a spectator, not a misread", () => {
    expect(doubtOf([drawn], { ...drawn, userTicket: "" })).toBeNull()
  })
  it("expects no ticket from a player known to hold none", () => {
    expect(doubtOf([drawn], { ...drawn, userTicket: "" }, false)).toBeNull()
  })
})
