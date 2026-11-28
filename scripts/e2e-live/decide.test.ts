// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { decide, dedupeKey, registrationStartFor, scheduledTriggerWaitMs, sleepMsFor, TRIGGER_LATE_TOLERANCE_MS, wallMsFor, type DecideInput, type Phases } from "./decide"
import { loadProfiles } from "./profile"
import { coldSuiteCandidateMinLeftS } from "./timing"

// paseo-next-v2's real phases (Game.StoredPhaseDurations, 2026-10-01): a
// 180 s sign-up window is what makes "start when it opens" too late
const phases: Phases = { registration: 180, shuffle: 120, postShuffleMargin: 30 }
const SPAN = phases.registration + phases.shuffle + phases.postShuffleMargin
const NOW = 1_000_000
const base: DecideInput = {
  chainNow: NOW,
  schedulePlayTimes: [],
  phases,
  minLeftS: 90,
  leadS: 3600,
  network: "paseo-next-v2",
}
const game = (over: Partial<NonNullable<DecideInput["game"]>> = {}) => ({
  index: 7,
  state: "Registration",
  registrationEnds: NOW + 150,
  gameAt: NOW + 150 + phases.shuffle + phases.postShuffleMargin,
  ...over,
})
// a schedule whose registration opens `secs` from now
const opensIn = (secs: number) => NOW + secs + SPAN

describe("decide", () => {
  it("plays a game in Registration with at least MIN_LEFT_S left", () => {
    const v = decide({ ...base, game: game() })
    expect(v.decision).toBe("play")
    expect(v.gameIndex).toBe(7)
    expect(v.registrationStart).toBe(NOW + 150 - 180)
    expect(v.chainNow).toBe(NOW)
  })

  it("plays at exactly MIN_LEFT_S, not at one second less", () => {
    expect(decide({ ...base, game: game({ registrationEnds: NOW + 90 }) }).decision).toBe("play")
    expect(decide({ ...base, game: game({ registrationEnds: NOW + 89 }) }).decision).toBe("skip")
  })

  it("plays a schedule whose registration opens within LEAD_S, and says when", () => {
    const v = decide({ ...base, schedulePlayTimes: [opensIn(59 * 60)] })
    expect(v.decision).toBe("play")
    expect(v.registrationStart).toBe(NOW + 59 * 60)
    expect(v.registrationEnds).toBe(NOW + 59 * 60 + 180)
    expect(v.gameAt).toBe(opensIn(59 * 60))
    expect(v.gameIndex).toBeNull()
  })

  it("plays at exactly LEAD_S, skips one second beyond", () => {
    expect(decide({ ...base, schedulePlayTimes: [opensIn(3600)] }).decision).toBe("play")
    expect(decide({ ...base, schedulePlayTimes: [opensIn(3601)] }).decision).toBe("skip")
  })

  it("a registration closing too soon falls through to the next schedule", () => {
    const v = decide({ ...base, game: game({ registrationEnds: NOW + 30 }), schedulePlayTimes: [opensIn(1200)] })
    expect(v.decision).toBe("play")
    expect(v.registrationStart).toBe(NOW + 1200)
    expect(v.reason).toContain("closes in 30 s")
  })

  it("rejects the too-late live game 916 snapshot and selects its next schedule", () => {
    const previewPhases: Phases = { registration: 300, shuffle: 60, postShuffleMargin: 30 }
    const chainNow = 1_792_368_804
    const v = decide({
      ...base,
      chainNow,
      phases: previewPhases,
      game: game({ index: 916, registrationEnds: 1_792_369_110 }),
      schedulePlayTimes: [1_792_370_400],
      candidateMinLeftS: 390,
    })
    expect(v).toMatchObject({
      decision: "play",
      gameIndex: null,
      gameAt: 1_792_370_400,
      registrationStart: 1_792_370_010,
      registrationEnds: 1_792_370_310,
    })
    expect(v.reason).toContain("need 390 s")
  })

  it("skips a joinable game when cold CI cannot reach a profile's T-300 action", () => {
    const previewPhases: Phases = { registration: 300, shuffle: 60, postShuffleMargin: 30 }
    const profile = loadProfiles().find(({ name }) => name === "host-stuck-waiting")!
    const candidateMinLeftS = coldSuiteCandidateMinLeftS([profile], previewPhases)
    const currentGameAt = NOW + 540
    const nextGameAt = NOW + 1_740
    const v = decide({
      ...base,
      phases: previewPhases,
      game: game({ gameAt: currentGameAt, registrationEnds: currentGameAt - previewPhases.shuffle - previewPhases.postShuffleMargin }),
      schedulePlayTimes: [nextGameAt],
      candidateMinLeftS,
    })
    expect(v).toMatchObject({ decision: "play", gameIndex: null, gameAt: nextGameAt })
    expect(v.reason).toContain("need 600 s")
  })

  it("applies the cold suite floor to scheduled candidates before registration opens", () => {
    const previewPhases: Phases = { registration: 300, shuffle: 60, postShuffleMargin: 30 }
    const tooSoonRegistration = NOW + 89
    const nextRegistration = NOW + 900
    const gameAt = (registrationStart: number) => registrationStart + previewPhases.registration + previewPhases.shuffle + previewPhases.postShuffleMargin
    const v = decide({
      ...base,
      phases: previewPhases,
      schedulePlayTimes: [gameAt(tooSoonRegistration), gameAt(nextRegistration)],
      candidateMinLeftS: 390,
    })
    expect(v).toMatchObject({ decision: "play", gameIndex: null, registrationStart: nextRegistration })
  })

  it("accepts the suite floor boundary and rejects one second less", () => {
    expect(decide({ ...base, game: game({ registrationEnds: NOW + 390 }), candidateMinLeftS: 390 }).gameIndex).toBe(7)
    expect(decide({ ...base, game: game({ registrationEnds: NOW + 389 }), candidateMinLeftS: 390 }).decision).toBe("skip")
  })

  it("returns a normal skip when no candidate meets the cold suite floor", () => {
    const v = decide({ ...base, game: game({ registrationEnds: NOW + 300 }), candidateMinLeftS: 390 })
    expect(v.decision).toBe("skip")
    expect(v.reason).toContain("need 390 s")
  })

  it("keeps ordinary runs on the current joinable registration", () => {
    const previewPhases: Phases = { registration: 300, shuffle: 60, postShuffleMargin: 30 }
    const v = decide({
      ...base,
      phases: previewPhases,
      game: game({ registrationEnds: NOW + 300 }),
      schedulePlayTimes: [NOW + 900 + previewPhases.registration + previewPhases.shuffle + previewPhases.postShuffleMargin],
    })
    expect(v).toMatchObject({ decision: "play", gameIndex: 7 })
  })

  it("picks the earliest upcoming schedule", () => {
    const v = decide({ ...base, schedulePlayTimes: [opensIn(3000), opensIn(900)] })
    expect(v.registrationStart).toBe(NOW + 900)
  })

  it("skips with no game and no schedule", () => {
    const v = decide(base)
    expect(v.decision).toBe("skip")
    expect(v.gameIndex).toBeNull()
    expect(v.dedupeKey).toBeNull()
  })

  it("skips a game past registration", () => {
    const v = decide({ ...base, game: game({ state: "Shuffle", registrationEnds: NOW - 10 }) })
    expect(v.decision).toBe("skip")
    expect(v.reason).toContain("already Shuffle")
  })

  it("a schedule whose registration already opened counts only while MIN_LEFT_S remains", () => {
    // opened 60 s ago: 120 s of the 180 s window left
    expect(decide({ ...base, schedulePlayTimes: [opensIn(-60)] }).decision).toBe("play")
    // opened 100 s ago: 80 s left
    expect(decide({ ...base, schedulePlayTimes: [opensIn(-100)] }).decision).toBe("skip")
  })

  it("skips when the whole window is shorter than MIN_LEFT_S", () => {
    const v = decide({ ...base, phases: { ...phases, registration: 60 }, schedulePlayTimes: [NOW + 2000] })
    expect(v.decision).toBe("skip")
    expect(v.reason).toContain("shorter than MIN_LEFT_S")
  })

  it("keys a game the same whether it is seen as a schedule or in Registration", () => {
    // the pallet copies GameSchedules[].game_play_time into Game.game_date
    const gameAt = opensIn(600)
    const asSchedule = decide({ ...base, schedulePlayTimes: [gameAt] })
    const later = NOW + 600 + 10
    const asGame = decide({
      ...base,
      chainNow: later,
      game: game({ registrationEnds: gameAt - phases.shuffle - phases.postShuffleMargin, gameAt }),
    })
    expect(asSchedule.decision).toBe("play")
    expect(asGame.decision).toBe("play")
    expect(asSchedule.dedupeKey).toBe(`e2e-live-played-paseo-next-v2-${gameAt}`)
    expect(asGame.dedupeKey).toBe(asSchedule.dedupeKey)
    expect(asGame.registrationStart).toBe(asSchedule.registrationStart)
  })
})

describe("registrationStartFor", () => {
  it("is the game time less the three phases", () => {
    expect(registrationStartFor(10_000, phases)).toBe(10_000 - 330)
  })
})

describe("dedupeKey", () => {
  it("names the game by its play time", () => {
    expect(dedupeKey(1_788_893_903, "previewnet")).toBe("e2e-live-played-previewnet-1788893903")
  })
  it("differs per network for the same play time (both play on :00 / :30)", () => {
    expect(dedupeKey(1_788_893_903, "previewnet")).not.toBe(dedupeKey(1_788_893_903, "paseo-next-v2"))
  })
})

describe("wallMsFor", () => {
  it("converts a chain second to the wall clock through one measured offset", () => {
    // the chain runs 5 s behind the wall
    const at = { chainNowS: 1000, wallNowMs: 1_005_000 }
    expect(wallMsFor(1000, at)).toBe(1_005_000)
    expect(wallMsFor(1060, at)).toBe(1_065_000)
  })

  it("handles a chain ahead of the wall", () => {
    expect(wallMsFor(2000, { chainNowS: 2000, wallNowMs: 1_990_000 })).toBe(1_990_000)
  })
})

describe("scheduledTriggerWaitMs", () => {
  it("fires an exactly-on-time trigger and absorbs only sub-second scheduler jitter", () => {
    expect(scheduledTriggerWaitMs(10_000, 10_000)).toBe(0)
    expect(scheduledTriggerWaitMs(10_000, 10_000 + TRIGGER_LATE_TOLERANCE_MS)).toBe(0)
  })

  it("still rejects a materially late trigger instead of moving a real fault window", () => {
    expect(scheduledTriggerWaitMs(10_000, 10_000 + TRIGGER_LATE_TOLERANCE_MS + 1)).toBeNull()
  })
})

describe("registration already open", () => {
  it("never reports a start later than now when the window outlasts phases.registration", () => {
    // game 163: scheduled into a window that had been open ~13 min
    const v = decide({ ...base, game: game({ registrationEnds: NOW + 381 + 180 }) })
    expect(v.decision).toBe("play")
    expect(v.registrationStart).toBeLessThanOrEqual(NOW)
  })

  it("keeps the earlier start when the window opened a full phases.registration ago", () => {
    const v = decide({ ...base, game: game({ registrationEnds: NOW + 100 }) })
    expect(v.registrationStart).toBe(NOW + 100 - 180)
  })
})

describe("sleepMsFor", () => {
  const at = { chainNowS: NOW, wallNowMs: 5_000_000 }
  const MIN = 90
  it("sleeps until the start (+3 s) when it is ahead and the window is long", () => {
    expect(sleepMsFor(NOW + 600, NOW + 780, at, MIN)).toBe(603_000)
  })
  it("is 0 when registration is already open", () => {
    expect(sleepMsFor(NOW - 30, NOW + 150, at, MIN)).toBe(0)
  })
  it("never sleeps past registrationEnds - minLeft", () => {
    // start is 381 s away but the window closes in 200 s: wake with 90 s left
    expect(sleepMsFor(NOW + 381, NOW + 200, at, MIN)).toBe(110_000)
  })
  it("is 0 when the window has under minLeft left", () => {
    expect(sleepMsFor(NOW + 50, NOW + 60, at, MIN)).toBe(0)
  })
  it("ignores a missing end", () => {
    expect(sleepMsFor(NOW + 10, NaN, at, MIN)).toBe(13_000)
  })
})
