// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import {
  advance,
  betterSample,
  clockSyncStep,
  confirmPeerMedian,
  createClockSync,
  PEER_CONFIRM_MS,
  peerVerdict,
  setTarget,
  type ClockSync,
} from "./clock-sync"

/** A clock with the device at 0 ms. */
function at(shownMs: number, targetMs: number): ClockSync {
  return { ...createClockSync(), shownMs, targetMs, lastDeviceMs: 0 }
}

describe("the start", () => {
  it("offers a pure event step without changing the caller's state", () => {
    const before = createClockSync()
    const result = clockSyncStep(before, { type: "advance", deviceMs: 5_000 })
    expect(before).toEqual(createClockSync())
    expect(result).toEqual({ state: { ...before, lastDeviceMs: 5_000 }, commands: [] })
  })

  it("is the device time, and the first advance only takes the device ms", () => {
    const s = createClockSync()
    expect(s).toEqual({ targetMs: 0, shownMs: 0, correcting: false })
    expect(advance(s, 5_000)).toEqual([])
    expect(s).toEqual({ targetMs: 0, shownMs: 0, correcting: false, lastDeviceMs: 5_000 })
  })
})

describe("peerVerdict", () => {
  it("needs 3 peers", () => {
    expect(peerVerdict([])).toEqual({ result: "few", peers: 0 })
    expect(peerVerdict([0, 100])).toEqual({ result: "few", peers: 2 })
  })

  it("takes the median when the peers agree", () => {
    expect(peerVerdict([200, 0, 100])).toEqual({ result: "ok", peers: 3, medianMs: 100, agree: 3 })
    expect(peerVerdict([0, 50, 9_000])).toEqual({ result: "ok", peers: 3, medianMs: 50, agree: 2 })
    expect(peerVerdict([1_000, 2_000, 10_000])).toEqual({ result: "ok", peers: 3, medianMs: 2_000, agree: 2 })
  })

  it("takes the mean of the two middle values for an even count", () => {
    expect(peerVerdict([0, 100, 200, 300])).toEqual({ result: "ok", peers: 4, medianMs: 150, agree: 4 })
  })

  it("is split when half of the peers or fewer agree", () => {
    expect(peerVerdict([0, 0, 0, 8_000, 8_000, 8_000])).toEqual({ result: "split", peers: 6, medianMs: 4_000, agree: 0 })
    expect(peerVerdict([0, 0, 5_000, 5_000])).toMatchObject({ result: "split", agree: 0 })
    expect(peerVerdict([-2_000, 0, 1_000, 1_000, 5_000, 10_000])).toEqual({
      result: "split",
      peers: 6,
      medianMs: 1_000,
      agree: 3,
    })
  })
})

describe("betterSample", () => {
  it("takes the new sample when no sample is kept", () => {
    expect(betterSample(undefined, { offsetMs: 120, rttMs: 400 })).toEqual({ offsetMs: 120, rttMs: 400 })
  })

  it("replaces the kept sample with a shorter round trip", () => {
    expect(betterSample({ offsetMs: 120, rttMs: 400 }, { offsetMs: -30, rttMs: 90 })).toEqual({ offsetMs: -30, rttMs: 90 })
  })

  it("keeps the kept sample against a longer round trip", () => {
    expect(betterSample({ offsetMs: -30, rttMs: 90 }, { offsetMs: 120, rttMs: 400 })).toEqual({ offsetMs: -30, rttMs: 90 })
  })

  it("keeps the kept sample on a tie", () => {
    const kept = { offsetMs: -30, rttMs: 90 }
    expect(betterSample(kept, { offsetMs: 120, rttMs: 90 })).toBe(kept)
  })
})

describe("confirmPeerMedian", () => {
  it("waits one ping period", () => {
    expect(PEER_CONFIRM_MS).toBe(2_000)
  })

  it("moves nothing and clears the candidate inside the dead band, also at exactly 250 ms", () => {
    const candidate = { medianMs: 900, sinceMs: 0 }
    expect(confirmPeerMedian(candidate, 100, 0, 5_000)).toEqual({ candidate: undefined, move: false })
    expect(confirmPeerMedian(undefined, 250, 0, 5_000)).toEqual({ candidate: undefined, move: false })
    expect(confirmPeerMedian(undefined, -250, 0, 5_000)).toEqual({ candidate: undefined, move: false })
  })

  it("starts a first candidate for a median out of the dead band", () => {
    expect(confirmPeerMedian(undefined, 251, 0, 5_000)).toEqual({ candidate: { medianMs: 251, sinceMs: 5_000 }, move: false })
  })

  it("holds the first sinceMs for a second median within 250 ms before 2 s", () => {
    const candidate = { medianMs: 800, sinceMs: 5_000 }
    expect(confirmPeerMedian(candidate, 1_050, 0, 6_999)).toEqual({ candidate, move: false })
  })

  it("moves when the same median holds for exactly 2 s", () => {
    const candidate = { medianMs: 800, sinceMs: 5_000 }
    expect(confirmPeerMedian(candidate, 600, 0, 7_000)).toEqual({ candidate: undefined, move: true })
  })

  it("replaces the candidate with a new sinceMs for a median more than 250 ms off", () => {
    const candidate = { medianMs: 800, sinceMs: 5_000 }
    expect(confirmPeerMedian(candidate, 1_051, 0, 9_000)).toEqual({ candidate: { medianMs: 1_051, sinceMs: 9_000 }, move: false })
  })

  it("clears the candidate when the median comes back into the dead band", () => {
    const candidate = { medianMs: 800, sinceMs: 5_000 }
    expect(confirmPeerMedian(candidate, 3_100, 3_000, 9_000)).toEqual({ candidate: undefined, move: false })
  })

  it("never moves for medians -477 ms then +425 ms 4 s apart against a target of 0", () => {
    const first = peerVerdict([-600, -477, -300])
    const second = peerVerdict([300, 425, 700])
    expect(first).toMatchObject({ result: "ok", medianMs: -477 })
    expect(second).toMatchObject({ result: "ok", medianMs: 425 })
    if (first.result === "few" || second.result === "few") throw new Error("no median")

    const a = confirmPeerMedian(undefined, first.medianMs, 0, 10_000)
    expect(a.move).toBe(false)
    const b = confirmPeerMedian(a.candidate, second.medianMs, 0, 14_000)
    expect(b).toEqual({ candidate: { medianMs: 425, sinceMs: 14_000 }, move: false })
  })
})

describe("setTarget", () => {
  it("keeps the shown offset, and the next advance starts the correction", () => {
    const s = at(0, 0)
    expect(setTarget(s, 3_000)).toEqual([])
    expect(s).toMatchObject({ targetMs: 3_000, shownMs: 0 })
    expect(advance(s, 100)).toEqual([{ kind: "correction", fromMs: 0, toMs: 3_000, speed: 2 }])
    expect(s.shownMs).toBe(100)
  })

  it("mid-correction starts a new correction toward the new target", () => {
    const s = at(0, 0)
    setTarget(s, 3_000)
    advance(s, 100)
    setTarget(s, -2_000)
    expect(advance(s, 200)).toEqual([{ kind: "correction", fromMs: 100, toMs: -2_000, speed: 0.5 }])
    expect(s.shownMs).toBe(50)
  })
})

describe("the dead band", () => {
  it("starts no correction at the exact 250 ms boundary", () => {
    const s = at(0, 250)
    expect(advance(s, 100)).toEqual([])
    expect(s).toMatchObject({ shownMs: 0, correcting: false })
  })

  it("starts no correction for a 200 ms gap", () => {
    const s = at(0, 200)
    expect(advance(s, 1_000)).toEqual([])
    expect(s).toMatchObject({ shownMs: 0, correcting: false })
  })

  it("corrects a 300 ms gap to 0, also inside the band", () => {
    const s = at(0, 300)
    expect(advance(s, 100)).toEqual([])
    expect(s).toMatchObject({ shownMs: 100, correcting: true })
    advance(s, 200)
    expect(s.shownMs).toBe(200)
    expect(advance(s, 300)).toEqual([{ kind: "corrected", offsetMs: 300 }])
    expect(s).toMatchObject({ shownMs: 300, correcting: false })
  })
})

describe("the speed table", () => {
  it("uses the game speed when the previous shown time is exactly gameFromMs", () => {
    const s = at(1_000, 2_000)
    expect(advance(s, 100, 1_000)).toEqual([])
    expect(s.shownMs).toBe(1_050)
  })

  // the shown game time stays near 1_000_000, so gameFromMs 0 is the game zone
  it.each([
    { zone: "waiting", gap: 1_000, speed: 2, after: 100 },
    { zone: "waiting", gap: 10_000, speed: 4, after: 300 },
    { zone: "waiting", gap: -1_000, speed: 0.5, after: -50 },
    { zone: "waiting", gap: -10_000, speed: 0.25, after: -75 },
    { zone: "game", gap: 1_000, speed: 1.5, after: 50 },
    { zone: "game", gap: 5_000, speed: 1.5, after: 50 },
    { zone: "game", gap: -1_000, speed: 0.67, after: -33 },
    { zone: "game", gap: -10_000, speed: 0.25, after: -75 },
  ])("$zone, gap $gap ms: $speed×", ({ zone, gap, speed, after }) => {
    const s = at(1_000_000, 1_000_000 + gap)
    const events = advance(s, 100, zone === "game" ? 0 : undefined)
    expect(s.shownMs - 1_000_000).toBeCloseTo(after, 6)
    expect(events).toEqual(
      Math.abs(gap) > 1_000 ? [{ kind: "correction", fromMs: 1_000_000, toMs: 1_000_000 + gap, speed }] : [],
    )
  })

  it("keeps the shown game time moving forward at every speed", () => {
    for (const gap of [10_000, -10_000, -1_000]) {
      for (const gameFromMs of [undefined, 0]) {
        const s = at(1_000_000, 1_000_000 + gap)
        advance(s, 100, gameFromMs)
        expect(100 + s.shownMs).toBeGreaterThan(1_000_000)
      }
    }
  })

  it("picks the speed from the gap of each step", () => {
    const s = at(0, 6_000)
    advance(s, 500)
    expect(s.shownMs).toBe(1_500)
    advance(s, 1_000)
    expect(s.shownMs).toBe(2_000)
  })
})

describe("the jumps", () => {
  it("jumps to the target when a waiting-zone catch-up is still behind at gameFromMs", () => {
    const s = at(0, 3_000)
    expect(advance(s, 500, 1_000)).toEqual([
      { kind: "correction", fromMs: 0, toMs: 3_000, speed: 2 },
      { kind: "jump", reason: "tiles-enter", fromMs: 500, toMs: 3_000 },
    ])
    expect(s).toMatchObject({ shownMs: 3_000, correcting: false })
  })

  it("does not jump when the catch-up ends before gameFromMs", () => {
    const s = at(0, 400)
    for (let t = 100; t <= 1_000; t += 100) {
      expect(advance(s, t, 10_000).some((e) => e.kind === "jump")).toBe(false)
    }
    expect(s).toMatchObject({ shownMs: 400, correcting: false })
  })

  it("does not jump at the exact 250 ms remaining-gap boundary", () => {
    const s = at(0, 350)
    expect(advance(s, 100, 200)).toEqual([])
    expect(s).toMatchObject({ shownMs: 100, targetMs: 350, correcting: true })
  })

  it("jumps in the game for a gap behind over 5 s, and runs 1.5× at 5 s", () => {
    const s = at(1_000_000, 1_005_001)
    expect(advance(s, 100, 0)).toEqual([{ kind: "jump", reason: "game", fromMs: 1_000_000, toMs: 1_005_001 }])
    expect(s.shownMs).toBe(1_005_001)

    const t = at(1_000_000, 1_005_000)
    advance(t, 100, 0)
    expect(t.shownMs).toBe(1_000_050)
  })
})

describe("the clock never moves backward", () => {
  it("moves nothing for a device ms that does not increase", () => {
    const s = at(0, 3_000)
    advance(s, 1_000)
    const shown = s.shownMs
    expect(advance(s, 1_000)).toEqual([])
    expect(advance(s, 900)).toEqual([])
    expect(s).toMatchObject({ shownMs: shown, lastDeviceMs: 1_000 })
  })

  function random(seed: number) {
    return () => {
      seed = (seed + 0x6d2b79f5) | 0
      let x = Math.imul(seed ^ (seed >>> 15), 1 | seed)
      x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x
      return ((x ^ (x >>> 14)) >>> 0) / 4294967296
    }
  }

  it.each([1, 2, 3, 4])("over random targets and steps (seed %i)", (seed) => {
    const rand = random(seed)
    const s = createClockSync()
    const gameFromMs = 1_058_000
    let deviceMs = 0
    let lastShown = -Infinity
    const kinds = new Set<string>()
    for (let i = 0; i < 5_000; i++) {
      deviceMs += Math.floor(rand() * 2_000)
      if (rand() < 0.05) setTarget(s, 1_000_000 + Math.floor((rand() - 0.5) * 40_000))
      // the source reads the time only through advance()
      advance(s, deviceMs, gameFromMs).forEach((e) => kinds.add(e.kind))
      const shown = deviceMs + s.shownMs
      expect(Number.isFinite(shown)).toBe(true)
      expect(shown).toBeGreaterThanOrEqual(lastShown)
      lastShown = shown
    }
    expect([...kinds]).toEqual(expect.arrayContaining(["correction", "corrected", "jump"]))
  })
})
