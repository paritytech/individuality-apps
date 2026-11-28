// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { INVITE_AFTER_OPEN, INVITE_LATE } from "@/lib/pocket/motion"
import { HINT, fallbackShown, hintWords, nextHint, pickTarget, piecesSettled, type HintLook, type HintState } from "./hints"

/** a screen 20 s in, nobody has pressed for a minute, the pieces floating since 10 s, nothing opened */
const state = (over: Partial<HintState> = {}): HintState => ({
  now: 20_000,
  pressedAt: -60_000,
  lastHintAt: -Infinity,
  bubbleUp: false,
  canOpen: false,
  floatingSince: 17_000,
  piecesStill: true,
  firstOpenedAt: null,
  zoomed: false,
  zoomedWrapped: false,
  wrapped: 3,
  opened: 0,
  learned: new Set(),
  shown: {},
  ...over,
})

describe("the collectables screen's hints", () => {
  it("shows the bubble once something is in, and only to a player gone still", () => {
    const bubble = { bubbleUp: true, floatingSince: null }
    expect(nextHint(state({ ...bubble, canOpen: false }))).toBeNull()
    expect(nextHint(state({ ...bubble, canOpen: true }))).toBe("bubble")
    expect(nextHint(state({ ...bubble, canOpen: true, pressedAt: 20_000 - HINT.idleMs + 1 }))).toBeNull()
    expect(nextHint(state({ ...bubble, canOpen: true, learned: new Set(["bubble"]) }))).toBeNull()
    expect(nextHint(state({ ...bubble, canOpen: true, shown: { bubble: HINT.plays.bubble } }))).toBeNull()
  })

  it("leaves room between hints", () => {
    expect(nextHint(state({ lastHintAt: 20_000 - HINT.everyMs + 1 }))).toBeNull()
    expect(nextHint(state({ lastHintAt: 20_000 - HINT.everyMs }))).toBe("look")
  })

  it("shows a wrapped piece only before the book's own finger starts", () => {
    const lastChance = 20_000 - (INVITE_LATE * 1000 - HINT.playMs)
    expect(nextHint(state({ floatingSince: lastChance }))).toBe("look")
    expect(nextHint(state({ floatingSince: lastChance - 1 }))).toBeNull()
    expect(nextHint(state({ learned: new Set(["look"]) }))).toBeNull()
    expect(nextHint(state({ wrapped: 0 }))).toBeNull()
  })

  it("waits for the pieces out of the pop to reach their places, and to come to rest", () => {
    expect(nextHint(state({ floatingSince: 20_000 - HINT.settleMs + 1 }))).toBeNull()
    expect(nextHint(state({ floatingSince: 20_000 - HINT.settleMs }))).toBe("look")
    expect(nextHint(state({ piecesStill: false }))).toBeNull()
    expect(nextHint(state({ opened: 1, wrapped: 2, firstOpenedAt: 19_000, piecesStill: false }))).toBeNull()
  })

  it("zoomed in on a wrapped piece, shows the tap that unwraps it, sooner", () => {
    const zoomed = { zoomed: true, zoomedWrapped: true, pressedAt: 20_000 - HINT.unwrapIdleMs }
    expect(nextHint(state(zoomed))).toBe("unwrap")
    expect(nextHint(state({ ...zoomed, zoomedWrapped: false }))).toBeNull()
    expect(nextHint(state({ ...zoomed, learned: new Set(["unwrap"]) }))).toBeNull()
  })

  it("shows the swap once, after the first piece is opened and before the book's finger starts on it", () => {
    const opened = { opened: 1, wrapped: 2 }
    const lastChance = 20_000 - (INVITE_AFTER_OPEN * 1000 - HINT.playMs)
    expect(nextHint(state({ ...opened, firstOpenedAt: lastChance }))).toBe("swap")
    expect(nextHint(state({ ...opened, firstOpenedAt: lastChance - 1 }))).toBeNull()
    expect(nextHint(state({ ...opened, firstOpenedAt: lastChance, shown: { swap: 1 } }))).toBeNull()
    // opened, so the look lesson is over: the book's finger takes it from there
    expect(nextHint(state({ ...opened, firstOpenedAt: lastChance - 1, shown: { swap: 1 } }))).toBeNull()
  })

  it("brings the words back only after a long stillness", () => {
    expect(fallbackShown(20_000, 20_000 - HINT.fallbackMs)).toBe(0)
    expect(fallbackShown(20_000, 20_000 - HINT.fallbackMs - 300)).toBeCloseTo(0.5)
    expect(fallbackShown(20_000, 20_000 - HINT.fallbackMs - 600)).toBe(1)
  })
})

describe("the hints' words, stillness and targets", () => {
  it("words the fallback in the order a player meets it, with the swap under it once something is open", () => {
    expect(hintWords({ zoomed: false, opened: 0, late: false })).toEqual({ line: "Tap a collectable to look closer", sub: null })
    expect(hintWords({ zoomed: true, opened: 2, late: true })).toEqual({ line: "Tap again to unwrap it", sub: null })
    expect(hintWords({ zoomed: false, opened: 0, late: true }).sub).toBeNull()
    expect(hintWords({ zoomed: false, opened: 1, late: false })).toEqual({
      line: "Close the book to add them to your Pocket",
      sub: "Tap one to swap its collection",
    })
  })

  it("calls the pieces at rest only when every one is within a few px of where it was, and was seen", () => {
    const before = new Map<number, readonly [number, number]>([[0, [100, 100]], [1, [200, 200]]])
    expect(piecesSettled(before, [{ index: 0, x: 101, y: 102 }, { index: 1, x: 200, y: 199 }])).toBe(true)
    expect(piecesSettled(before, [{ index: 0, x: 100 + HINT.stillPx, y: 100 }])).toBe(false)
    expect(piecesSettled(before, [{ index: 2, x: 0, y: 0 }])).toBe(false)
    expect(piecesSettled(before, [])).toBe(false)
  })

  const look = (over: Partial<HintLook> = {}): HintLook => ({
    bubble: null,
    floatingSince: 0,
    focused: -1,
    pieces: [{ index: 0, x: 40, y: 40 }, { index: 1, x: 190, y: 330 }, { index: 2, x: 300, y: 500 }],
    opened: [],
    middle: { x: 195, y: 340 },
    ...over,
  })

  it("taps the bubble, the piece zoomed in on, the last one opened still out, or the wrapped one nearest the middle", () => {
    expect(pickTarget("bubble", look({ bubble: { canOpen: true } }))).toEqual({ kind: "bubble" })
    expect(pickTarget("bubble", look())).toBeNull()
    expect(pickTarget("unwrap", look({ focused: 2 }))).toEqual({ kind: "piece", index: 2 })
    expect(pickTarget("unwrap", look({ focused: 7 }))).toBeNull()
    // 2 was opened last but the Pocket has it (it is not out): the one before
    expect(pickTarget("swap", look({ opened: [0, 1, 4] }))).toEqual({ kind: "piece", index: 1 })
    expect(pickTarget("swap", look({ opened: [] }))).toBeNull()
    expect(pickTarget("look", look())).toEqual({ kind: "piece", index: 1 })
    expect(pickTarget("look", look({ opened: [1] }))).toEqual({ kind: "piece", index: 2 })
    expect(pickTarget("look", look({ opened: [0, 1, 2] }))).toBeNull()
  })
})

describe("the hints' rules, by property", () => {
  const kinds = ["bubble", "look", "unwrap", "swap"] as const
  const states: fc.Arbitrary<HintState> = fc
    .record({
      now: fc.integer({ min: 0, max: 60_000 }),
      pressedAgo: fc.integer({ min: 0, max: 20_000 }),
      lastAgo: fc.oneof(fc.constant(Infinity), fc.integer({ min: 0, max: 20_000 })),
      bubbleUp: fc.boolean(),
      canOpen: fc.boolean(),
      floatingAgo: fc.option(fc.integer({ min: 0, max: 20_000 }), { nil: null }),
      piecesStill: fc.boolean(),
      openedAgo: fc.option(fc.integer({ min: 0, max: 20_000 }), { nil: null }),
      zoomed: fc.boolean(),
      zoomedWrapped: fc.boolean(),
      wrapped: fc.integer({ min: 0, max: 10 }),
      opened: fc.integer({ min: 0, max: 10 }),
      learned: fc.subarray([...kinds]),
      shown: fc.record({ bubble: fc.nat(4), look: fc.nat(4), unwrap: fc.nat(4), swap: fc.nat(2) }),
    })
    .map((r) => ({
      now: r.now,
      pressedAt: r.now - r.pressedAgo,
      lastHintAt: r.now - r.lastAgo,
      bubbleUp: r.bubbleUp,
      canOpen: r.canOpen,
      floatingSince: r.floatingAgo === null ? null : r.now - r.floatingAgo,
      piecesStill: r.piecesStill,
      firstOpenedAt: r.openedAgo === null ? null : r.now - r.openedAgo,
      zoomed: r.zoomed,
      zoomedWrapped: r.zoomedWrapped,
      wrapped: r.wrapped,
      opened: r.opened,
      learned: new Set(r.learned),
      shown: r.shown,
    }))

  it("never plays too soon after the last, before the player is still, a lesson done, or one shown out", () => {
    fc.assert(
      fc.property(states, (s) => {
        const kind = nextHint(s)
        if (kind === null) return
        expect(s.now - s.lastHintAt).toBeGreaterThanOrEqual(HINT.everyMs)
        expect(s.now - s.pressedAt).toBeGreaterThanOrEqual(kind === "unwrap" ? HINT.unwrapIdleMs : HINT.idleMs)
        expect(s.learned.has(kind)).toBe(false)
        expect(s.shown[kind] ?? 0).toBeLessThan(HINT.plays[kind])
      }),
    )
  })

  it("shows each lesson only where it belongs, and never while the book's own finger may play", () => {
    fc.assert(
      fc.property(states, (s) => {
        const kind = nextHint(s)
        if (kind === "bubble") expect(s.bubbleUp && s.canOpen).toBe(true)
        if (kind === "unwrap") expect(s.zoomed && s.zoomedWrapped && !s.bubbleUp).toBe(true)
        if (kind === "look" || kind === "swap") {
          expect(s.bubbleUp || s.zoomed).toBe(false)
          expect(s.piecesStill).toBe(true)
        }
        if (kind === "look") {
          expect(s.opened === 0 || s.firstOpenedAt === null).toBe(true)
          expect(s.now - s.floatingSince! + HINT.playMs).toBeLessThanOrEqual(INVITE_LATE * 1000)
          expect(s.now - s.floatingSince!).toBeGreaterThanOrEqual(HINT.settleMs)
        }
        if (kind === "swap") expect(s.now - s.firstOpenedAt! + HINT.playMs).toBeLessThanOrEqual(INVITE_AFTER_OPEN * 1000)
      }),
    )
  })
})
