// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * MODEL-BASED PROPERTY TESTS for the turn-books reducer (step 1).
 *
 * Seeded random games (mulberry32, fixed seed list, so every run is the same)
 * drive a page through ticks, throttle bursts, backward chain steps (inside a
 * round and across a round boundary), decoded frames, taps, bans, undos and
 * relaunches (prompt and slow stored reads, during a turn, the gap or
 * reporting). After every event the per-step invariants are checked; at the
 * end the reducer's verdict for every (turn, co-player) is compared with the
 * independent model in ./turn-books.harness.ts (`expectedVerdict`).
 *
 * The generator stays hand-made so its event mix and verdict oracle remain
 * independent from the fast-check model suite on main.
 */
import { describe, expect, it } from "vitest"
import { calculateSnapshot } from "@jollity/game-chain/game"

import type { Vote } from "../game-session"
import {
  GAME_DATE,
  Page,
  REPORTING,
  STRIDE,
  TIMING,
  TOTAL_TURNS,
  WAITING,
  at,
  candidatesOf,
  disagreements,
  int,
  newTruth,
  pick,
  recordGesture,
  relaunch,
  rng,
  type Truth,
} from "./turn-books.harness"

interface Played {
  page: Page
  truth: Truth
  log: string[]
  violations: string[]
  stats: { autos: number; persons: number; bans: number; relaunches: number; backs: number }
}

/** the first turn a page loaded at `second` is charged from */
function entryAt(second: number): number {
  const snap = calculateSnapshot(second, TIMING)
  if (snap.kind === "round") return snap.round * STRIDE + snap.hostPosition
  if (snap.kind === "between-rounds") return snap.nextRound * STRIDE
  if (snap.kind === "reporting" || snap.kind === "finished") return TOTAL_TURNS
  return 0
}

function play(seed: number, lag: boolean): Played {
  const random = rng(seed)
  const log: string[] = []
  const violations: string[] = []
  const stats = { autos: 0, persons: 0, bans: 0, relaunches: 0, backs: 0 }
  const door = random() < 0.6
  let page: Page
  let second: number
  let truth: Truth
  if (door) {
    page = new Page({ door: true, restorePending: true })
    page.tick(WAITING)
    page.restore(null, false)
    second = GAME_DATE - 2
    truth = newTruth(0)
    log.push("door")
  } else {
    second = int(random, GAME_DATE, at(1, 3, 6))
    page = relaunch(null, second, { door: false })
    truth = newTruth(entryAt(second))
    log.push(`late join @${second - GAME_DATE} entry ${truth.entry}`)
  }
  const floor = second
  let highest = second
  page.lagRender = lag

  // per-page invariants, checked after every event
  let sealedBefore = new Set(page.books.sealed)
  let boundariesBefore = { ...page.books.videoRoleHistory }
  const banOwned = new Map<number, Set<string>>()
  const check = (what: string) => {
    for (const turn of sealedBefore) if (!page.books.sealed.has(turn)) violations.push(`${what}: turn ${turn} unsealed (clause 1)`)
    for (const [id, entry] of Object.entries(boundariesBefore)) {
      const now = page.books.videoRoleHistory[id]
      if (now === undefined) violations.push(`${what}: ${id} became unseen (clause 6)`)
      else if (typeof entry?.fromTurn === "number" && (now.fromTurn === null || now.fromTurn > entry.fromTurn))
        violations.push(`${what}: ${id} boundary moved later ${entry.fromTurn} → ${now.fromTurn} (clause 6)`)
    }
    // clause 4: a Person gesture is never overwritten by a NotPerson the player did not give
    for (const [turn, gestures] of truth.gestures)
      for (const [id, verdict] of gestures)
        if (verdict === "person" && page.verdict(turn, id) === "notperson")
          violations.push(`${what}: turn ${turn} ${id} Person tap filed NotPerson (clause 4)`)
    const rows = new Map<number, number>()
    for (const step of page.trail)
      if (step.kind === "row" && step.message === "turn sealed") rows.set(step.data.turn as number, (rows.get(step.data.turn as number) ?? 0) + 1)
    for (const [turn, count] of rows) if (count > 1) violations.push(`${what}: turn ${turn} sealed ${count}× (clause 1)`)
    sealedBefore = new Set(page.books.sealed)
    boundariesBefore = { ...page.books.videoRoleHistory }
  }

  for (let step = 0; step < 400 && second < REPORTING; step++) {
    const open = page.open()
    const roll = random()
    if (roll < 0.45) {
      second += int(random, 1, 4)
      page.tick(second)
      log.push(`tick +${second - GAME_DATE}`)
    } else if (roll < 0.5) {
      second += int(random, 10, 40)
      page.tick(second)
      log.push(`burst → ${second - GAME_DATE}`)
    } else if (roll < 0.62) {
      // a decoded frame in the open turn (only while living new time: §3 never back-dates)
      if (open < 0 || second < highest) continue
      const unseen = candidatesOf(open).filter((id) => truth.seenFrom[id] === undefined)
      if (unseen.length === 0) continue
      const id = pick(random, unseen)
      page.see(id)
      truth.seenFrom[id] = open
      log.push(`see ${id} @turn ${open}`)
    } else if (roll < 0.76) {
      if (open < 0) continue
      const votable = candidatesOf(open).filter((id) => (truth.seenFrom[id] ?? Infinity) <= open && !page.books.banned.has(id))
      if (votable.length === 0) continue
      const id = pick(random, votable)
      const verdict: Vote = random() < 0.6 ? "person" : "notperson"
      page.tap(id, verdict)
      banOwned.get(open)?.delete(id)
      recordGesture(truth, open, id, verdict)
      log.push(`tap ${id} ${verdict} @turn ${open}`)
    } else if (roll < 0.8) {
      if (open < 0) continue
      const bannable = candidatesOf(open).filter((id) => (truth.seenFrom[id] ?? Infinity) <= open && !page.books.banned.has(id))
      if (bannable.length === 0) continue
      const id = pick(random, bannable)
      const overwrittenGesture = truth.gestures.get(open)?.get(id)
      const owned = banOwned.get(open) ?? new Set<string>()
      if (overwrittenGesture === "notperson") owned.delete(id)
      else owned.add(id)
      banOwned.set(open, owned)
      page.ban(id)
      recordGesture(truth, open, id, "notperson")
      stats.bans++
      log.push(`ban ${id} @turn ${open}`)
    } else if (roll < 0.84) {
      const banned = [...page.books.banned]
      if (banned.length === 0) continue
      const id = pick(random, banned)
      // the undo takes back the ban's reject in the turn on screen; it is a
      // gesture the player made there, so the turn falls back to its default
      if (open >= 0 && banOwned.get(open)?.has(id)) {
        recordGesture(truth, open, id, null)
        banOwned.get(open)?.delete(id)
      }
      page.unban(id)
      log.push(`unban ${id} @turn ${open}`)
    } else if (roll < 0.9) {
      // a backward chain step, possibly across a round boundary
      const back = Math.max(floor, Math.max(GAME_DATE, second - int(random, 3, 20)))
      if (back >= second) continue
      second = back
      page.tick(second)
      stats.backs++
      log.push(`back → ${second - GAME_DATE}`)
    } else if (roll < 0.95) {
      if (!door && page.books.firstOpenedTurn === undefined) continue
      const stored = page.save()
      second += int(random, 0, 30)
      const slowRead = random() < 0.5
      page = relaunch(stored, Math.min(second, REPORTING), { door, slowRead })
      // the relaunch's own ticks (the held read, the 3 s release) move the clock on
      second = page.now
      page.lagRender = lag
      sealedBefore = new Set(page.books.sealed)
      boundariesBefore = { ...page.books.videoRoleHistory }
      stats.relaunches++
      log.push(`relaunch @${second - GAME_DATE}${slowRead ? " slow" : ""}`)
    } else {
      continue
    }
    highest = Math.max(highest, second)
    if (lag && random() < 0.5) page.commit()
    check(log[log.length - 1])
  }
  page.commit()
  page.tick(REPORTING)
  page.topUp()
  page.tick(REPORTING + 1)
  check("settled")
  truth.endedThrough = TOTAL_TURNS
  for (let turn = 0; turn < TOTAL_TURNS; turn++)
    for (const id of candidatesOf(turn)) {
      const verdict = page.verdict(turn, id)
      if (verdict === "person") stats.persons++
      if (verdict === "notperson" && (page.books.autoSeals[turn] ?? []).includes(id)) stats.autos++
    }
  return { page, truth, log, violations, stats }
}

const SEEDS = Array.from({ length: 400 }, (_, i) => 1000 + i * 7919)

function failures(lag: boolean): string[] {
  const out: string[] = []
  for (const seed of SEEDS) {
    const { page, truth, log, violations } = play(seed, lag)
    const wrong = disagreements(page, truth)
    if (violations.length > 0 || wrong.length > 0)
      out.push(`seed ${seed}: ${[...violations.slice(0, 2), ...wrong.slice(0, 3)].join("; ")} | ${log.join(", ")}`)
  }
  return out
}

describe("turn books agree with the model of the settled rules", () => {
  it("preserves a Person tap when unbanning that player on a replayed sealed turn", () => {
    const page = new Page({ door: true })
    page.tick(WAITING)
    page.tick(at(0, 0))
    page.see("C")
    page.tap("C", "person")
    page.tick(at(0, 1))
    page.ban("C")
    page.tick(at(0, 0, 6))
    page.unban("C")

    expect(page.verdict(0, "C")).toBe("person")
    expect(page.books.autoSeals[0]).not.toContain("C")
  })

  it("preserves a NotPerson tap when unbanning that player on a replayed sealed turn", () => {
    const page = new Page({ door: true })
    page.tick(WAITING)
    page.tick(at(0, 0))
    page.see("C")
    page.tap("C", "notperson")
    page.tick(at(0, 1))
    page.ban("C")
    page.tick(at(0, 0, 6))
    page.unban("C")

    expect(page.verdict(0, "C")).toBe("notperson")
    expect(page.books.autoSeals[0]).not.toContain("C")
  })

  it("the generator is not vacuous: games carry defaults, Person taps, bans, relaunches and backward steps", () => {
    const totals = { autos: 0, persons: 0, bans: 0, relaunches: 0, backs: 0 }
    for (const seed of SEEDS) {
      const { stats } = play(seed, false)
      for (const key of Object.keys(totals) as (keyof typeof totals)[]) totals[key] += stats[key]
    }
    for (const [key, value] of Object.entries(totals)) expect(value, key).toBeGreaterThan(50)
  })

  it("every verdict per co-player per turn matches the model, render committed after every event", () => {
    expect(failures(false)).toEqual([])
  })

  it("every verdict per co-player per turn matches the model, render lagging the books by up to one event", () => {
    expect(failures(true)).toEqual([])
  })

  it("the same game played twice gives the same books (determinism; no hidden clock)", () => {
    for (const seed of SEEDS.slice(0, 40)) {
      const a = play(seed, false)
      const b = play(seed, false)
      expect(b.page.books).toEqual(a.page.books)
    }
  })

  it("replaying every tick of a settled game a second time changes nothing (clause 7)", () => {
    for (const seed of SEEDS.slice(0, 60)) {
      const { page } = play(seed, false)
      const before = page.books
      page.tick(REPORTING + 1)
      page.tick(REPORTING + 1)
      expect(page.books).toEqual(before)
    }
  })
})
