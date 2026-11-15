// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, describe, expect, it, vi } from "vitest"

const store = new Map<string, string>()
vi.stubGlobal("sessionStorage", {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => void store.set(key, value),
  removeItem: (key: string) => void store.delete(key),
})

const { drawIntro, drawMissFor, drawMissReason, drawResultLine, forgetDrawMisses, rememberDrawMiss } = await import("./draw-miss")
const { PRIZE_UNIT } = await import("./prize-unit")

afterEach(() => forgetDrawMisses())

/** the draw fields `drawResultLine` reads */
const draw = (overrides: Partial<import("./prize-draw").PrizeDraw> = {}): import("./prize-draw").PrizeDraw => ({
  prizeUsd: 200,
  userTicket: "aa",
  winningTickets: ["aa"],
  won: true,
  ...overrides,
})

describe("the draw, explained before the wheel to a player who is not in it", () => {
  const prize = `$200 ${PRIZE_UNIT}`

  it("says what is about to happen, how the wheel picks, and that draws are for members", () => {
    const intro = drawIntro(draw({ userTicket: "", won: false, winningTickets: ["bb"] }))
    expect(intro.heading).toBe("Someone's about to win")
    expect(intro.prize).toBe(prize)
    expect(intro.paragraphs).toEqual(["The ticket that stops at the top wins.", "Draws are for members. Keep playing to join."])
  })

  it("counts the winners when there are several", () => {
    const intro = drawIntro(draw({ userTicket: "", won: false, winningTickets: ["bb", "cc", "dd"] }))
    expect(intro.heading).toBe("3 people are about to win")
    expect(intro.paragraphs[0]).toBe("The 3 tickets that stop at the top win.")
  })
})

describe("why the player is not in the draw", () => {
  it("remembers the sign-up's reason for that game only", () => {
    rememberDrawMiss(150, "signature")
    expect(drawMissFor(150)).toBe("signature")
    expect(drawMissFor(151)).toBeUndefined()
  })

  it("says why when it knows, and nothing when it does not", () => {
    expect(drawMissReason("signature")).toBe("Your ticket wasn't signed when you signed up.")
    expect(drawMissReason("not-member-yet")).toBe(
      "Only members can claim prizes, and this game couldn't make you one yet. You'll be in the draw once a game can.",
    )
    expect(drawMissReason(undefined)).toBeNull()
  })

  it("keeps the reason across a reload, from sessionStorage", async () => {
    rememberDrawMiss(150, "verified-person")
    vi.resetModules()
    const { drawMissFor: afterReload } = await import("./draw-miss")
    expect(afterReload(150)).toBe("verified-person")
  })
})

describe("the chain's result in words", () => {
  it("says the player won, with the prize", () => {
    expect(drawResultLine(draw({ won: true, winningTickets: ["aa"] }), null)).toEqual({
      heading: "You won",
      body: `$200 ${PRIZE_UNIT} is yours.`,
    })
  })

  it("says not this time, and names the one winning ticket", () => {
    expect(drawResultLine(draw({ won: false, winningTickets: ["bb"] }), null)).toEqual({
      heading: "Not this time",
      body: `One ticket won $200 ${PRIZE_UNIT}.`,
    })
  })

  it("says not this time, and counts the winning tickets", () => {
    expect(drawResultLine(draw({ won: false, winningTickets: ["bb", "cc"] }), null)).toEqual({
      heading: "Not this time",
      body: `2 tickets won $200 ${PRIZE_UNIT}.`,
    })
  })

  it("says the player was not in the draw, with the reason when known", () => {
    expect(drawResultLine(draw({ userTicket: "", won: false }), null)).toEqual({
      heading: "You weren't in this draw",
      body: "Your sign-up didn't enter this game's prize draw.",
    })
    expect(drawResultLine(draw({ userTicket: "", won: false }), "reason")).toEqual({
      heading: "You weren't in this draw",
      body: "reason",
    })
  })
})
