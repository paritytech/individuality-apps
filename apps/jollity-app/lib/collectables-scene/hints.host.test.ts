// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Finger, FingerTarget } from "./finger"
import { HINT, armHints, type HintLook, type Hints } from "./hints"

/** a finger that records what it was asked, and presses when told */
function fakeFinger() {
  const played: { target: FingerTarget; onPress: () => void }[] = []
  let stops = 0
  const finger: Finger = {
    play: (target, onPress) => played.push({ target, onPress }),
    stop: () => {
      stops += 1
    },
  }
  return { finger, played, stops: () => stops }
}

const pieces = [
  { index: 0, x: 40, y: 40 },
  { index: 1, x: 190, y: 330 },
]

describe("armHints, the hints' host", () => {
  let hints: Hints | null = null
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
  })
  afterEach(() => {
    hints?.stop()
    hints = null
    vi.useRealTimers()
  })
  /** each look reads the time it runs at (the fake timers move Date along) */
  const pass = (ms: number) => vi.advanceTimersByTime(ms)

  const arm = (look: () => HintLook | null) => {
    const f = fakeFinger()
    const nudged: number[] = []
    hints = armHints({
      finger: f.finger,
      look,
      engine: () => ({ bubbleAt: () => ({ x: 1, y: 2 }), pulseBubble: () => {}, nudge: (index) => nudged.push(index) }),
      piece: (index) => pieces.find((p) => p.index === index) ?? null,
      now: () => Date.now(),
    })
    return { ...f, nudged }
  }
  const floating = (over: Partial<HintLook> = {}): HintLook => ({
    bubble: null,
    floatingSince: 0,
    focused: -1,
    pieces,
    opened: [],
    middle: { x: 195, y: 340 },
    ...over,
  })

  it("shows a still player the wrapped piece nearest the middle, and rocks it on the press", () => {
    const f = arm(() => floating())
    pass(HINT.idleMs - HINT.lookEveryMs)
    expect(f.played).toHaveLength(0)
    pass(HINT.lookEveryMs * 2)
    expect(f.played).toHaveLength(1)
    expect(f.played[0]!.target()).toMatchObject({ x: 190, y: 330 })
    f.played[0]!.onPress()
    expect(f.nudged).toEqual([1])
  })

  it("stops a hint at a press anywhere, and waits for stillness again", () => {
    const f = arm(() => floating())
    pass(HINT.idleMs + HINT.lookEveryMs)
    expect(f.played).toHaveLength(1)
    window.dispatchEvent(new Event("pointerdown"))
    expect(f.stops()).toBe(1)
    pass(HINT.idleMs - HINT.lookEveryMs)
    expect(f.played).toHaveLength(1)
    pass(HINT.everyMs)
    expect(f.played).toHaveLength(2)
  })

  it("never shows a lesson done, and stops it if it is playing", () => {
    const f = arm(() => floating())
    pass(HINT.idleMs + HINT.lookEveryMs)
    expect(f.played).toHaveLength(1)
    hints!.learned("look")
    expect(f.stops()).toBe(1)
    pass(HINT.everyMs * 3)
    expect(f.played).toHaveLength(1)
  })

  it("plays nothing while the screen says no hint may (the picker open, the book's cover moving)", () => {
    const f = arm(() => null)
    pass(HINT.everyMs * 3)
    expect(f.played).toHaveLength(0)
  })

  it("brings the fallback words in only after a long stillness, and a press sends them out", () => {
    arm(() => null)
    expect(hints!.fallback(HINT.fallbackMs)).toBe(0)
    expect(hints!.fallback(HINT.fallbackMs + 600)).toBe(1)
    pass(HINT.fallbackMs + 600)
    window.dispatchEvent(new Event("pointerdown"))
    expect(hints!.fallback(Date.now())).toBe(0)
  })

  it("stops looking and listening once stopped", () => {
    const f = arm(() => floating())
    hints!.stop()
    hints = null
    pass(HINT.everyMs * 3)
    window.dispatchEvent(new Event("pointerdown"))
    expect(f.played).toHaveLength(0)
    expect(f.stops()).toBe(1)
  })
})
