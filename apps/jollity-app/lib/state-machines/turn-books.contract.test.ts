// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * INDEPENDENT CONTRACT TESTS for the turn-books reducer, written from the
 * settled product rules, not from the implementation: relaunch vs late join,
 * the lifecycle invariants, evidence, and the vote and the seal.
 *
 * Black-box: only the reducer's exported entry (`turnBooks`) and its books
 * are touched. The harness (./turn-books.harness.ts) plays the runner.
 *
 * A test marked `it.fails` is a FINDING: the expected rule is stated above
 * it, with the sequence and what the reducer did instead.
 */
import { describe, expect, it } from "vitest"
import {
  ME,
  Page,
  REPORTING,
  WAITING,
  at,
  candidatesOf,
  inGap,
  relaunch,
} from "./turn-books.harness"

/** a door page that lived from the waiting room into the game */
function doorPage(): Page {
  const page = new Page({ door: true, restorePending: true })
  page.tick(WAITING)
  page.restore(null, false)
  page.tick(WAITING + 1)
  return page
}

/** tick every second from `from` to `to` inclusive */
function run(page: Page, from: number, to: number): void {
  for (let s = from; s <= to; s++) page.tick(s)
}

/** how many "turn sealed" rows a turn produced */
function sealRows(page: Page, turn: number): number {
  return page.trail.filter((step) => step.kind === "row" && step.message === "turn sealed" && step.data.turn === turn).length
}

describe("clause 1 — monotone seals (R4)", () => {
  it("the sealed set only grows over a whole game, and every turn seals exactly once", () => {
    const page = doorPage()
    let before = new Set<number>()
    for (let s = at(0, 0, 0); s <= REPORTING; s++) {
      page.tick(s)
      for (const turn of before) expect(page.books.sealed.has(turn)).toBe(true)
      before = new Set(page.books.sealed)
    }
    for (let turn = 0; turn < 8; turn++) expect(sealRows(page, turn), `turn ${turn}`).toBe(1)
    expect(page.books.turnsSealed).toBe(8)
  })

  it("a backward snapshot re-opens a turn but never seals one", () => {
    const page = doorPage()
    run(page, at(0, 0, 0), at(0, 2, 3))
    const sealed = new Set(page.books.sealed)
    page.tick(at(0, 0, 4)) // a chain jump back into turn 0
    expect(page.open()).toBe(0)
    expect(new Set(page.books.sealed)).toEqual(sealed)
    expect(page.books.sealed.has(2)).toBe(false) // the turn we left is not completed by the jump
    run(page, at(0, 0, 5), at(0, 3, 1))
    for (let turn = 0; turn < 3; turn++) expect(sealRows(page, turn), `turn ${turn}`).toBe(1)
  })

  it("a sealed default changes only to a gesture the player made on the re-lived turn (#569 b)", () => {
    const page = doorPage()
    page.tick(at(0, 0, 0))
    page.see("A")
    page.see("B")
    run(page, at(0, 0, 1), at(0, 1, 2))
    expect(page.verdict(0, "A")).toBe("notperson")
    expect(page.books.autoSeals[0]).toContain("A")
    page.tick(at(0, 0, 6)) // backward step re-lives turn 0
    page.tap("A", "person")
    expect(page.verdict(0, "A")).toBe("person")
    expect(page.books.autoSeals[0]).not.toContain("A")
    expect(page.verdict(0, "B")).toBe("notperson") // the untouched default stands
    run(page, at(0, 1, 0), at(0, 2, 0))
    expect(page.verdict(0, "A")).toBe("person") // moving forward again re-seals nothing
    expect(sealRows(page, 0)).toBe(1)
  })
})

describe("clause 2 — missed turns are rejects (R1, #527)", () => {
  /** a door player who saw everyone in round 0, then died during turn 1 */
  function diedInTurn1(): Page {
    const page = doorPage()
    page.tick(at(0, 0, 0))
    for (const id of ["A", "B", "C"]) page.see(id)
    run(page, at(0, 0, 1), at(0, 1, 4))
    return page
  }

  function expectRejects(page: Page, turns: number[]): void {
    for (const turn of turns)
      for (const id of candidatesOf(turn).filter((id) => ["A", "B", "C"].includes(id)))
        expect(page.verdict(turn, id), `turn ${turn} ${id}`).toBe("notperson")
  }

  it("a relaunch with a prompt stored read seals every turn it sat out NotPerson", () => {
    const stored = diedInTurn1().save()
    const page = relaunch(stored, at(0, 3, 5), { door: true })
    expectRejects(page, [1, 2])
  })

  it("a relaunch whose stored read lands after the 3 s release still seals the missed turns (#567, #570)", () => {
    const stored = diedInTurn1().save()
    const page = relaunch(stored, at(0, 3, 5), { door: true, slowRead: true })
    expectRejects(page, [1, 2])
  })

  it("the stored first-opened turn alone (no door marker) proves the rejoin", () => {
    const stored = diedInTurn1().save()
    expect(stored.firstOpenedTurn).toBe(0)
    const page = relaunch(stored, at(0, 3, 5), { door: false })
    expectRejects(page, [1, 2])
  })

  it("a page throttled across several turns replays each one in order on its return tick", () => {
    const page = doorPage()
    page.tick(at(0, 0, 0))
    for (const id of ["A", "B", "C"]) page.see(id)
    page.tick(at(0, 3, 3)) // one tick after ~36 s asleep
    expectRejects(page, [0, 1, 2])
    for (const turn of [0, 1, 2]) expect(sealRows(page, turn)).toBe(1)
  })

  // §1's probable bug (#1178): the clock turns ready before the game window
  // lands, so the first ticks carry no coldStartedAt and the page opens a
  // turn on its own before the cold reconcile runs.
  it("#1178: ready before the window, door marker — the missed turns still seal NotPerson", () => {
    const stored = diedInTurn1().save()
    const page = relaunch(stored, at(0, 3, 2), { door: true, readyBeforeWindow: 3 })
    expectRejects(page, [1, 2])
  })

  it("#1178: ready before the window, stored first-opened turn only — the missed turns still seal NotPerson", () => {
    const stored = diedInTurn1().save()
    const page = relaunch(stored, at(0, 3, 2), { door: false, readyBeforeWindow: 3 })
    expectRejects(page, [1, 2])
  })

  it("#1178: ready before the window, first ready tick in the between-rounds gap", () => {
    const stored = diedInTurn1().save()
    const page = relaunch(stored, inGap(1, 1), { door: true, readyBeforeWindow: 3 })
    expectRejects(page, [1, 2, 3])
  })

  it("#1178: ready before the window, first ready tick in reporting", () => {
    const stored = diedInTurn1().save()
    const page = relaunch(stored, REPORTING, { door: true, readyBeforeWindow: 3 })
    expectRejects(page, [1, 2, 3])
    // round 1: A is the only co-player this player saw, and A sits in turns 4, 5, 7
    for (const turn of [4, 5, 7]) expect(page.verdict(turn, "A"), `turn ${turn}`).toBe("notperson")
  })

  it("a relaunch during the between-rounds gap seals the rest of round 0", () => {
    const stored = diedInTurn1().save()
    const page = relaunch(stored, inGap(1, 3), { door: true })
    expectRejects(page, [1, 2, 3])
    expect(page.verdict(4, "A")).toBeUndefined() // round 1 has not begun
  })

  it("a relaunch during reporting seals every turn after the crash (#1178)", () => {
    const stored = diedInTurn1().save()
    const page = relaunch(stored, REPORTING, { door: true })
    expectRejects(page, [1, 2, 3])
    for (const turn of [4, 5, 7]) expect(page.verdict(turn, "A"), `turn ${turn}`).toBe("notperson")
  })

  it("a relaunch during reporting with a slow stored read seals every turn after the crash", () => {
    const stored = diedInTurn1().save()
    const page = relaunch(stored, REPORTING, { door: true, slowRead: true })
    expectRejects(page, [1, 2, 3])
    for (const turn of [4, 5, 7]) expect(page.verdict(turn, "A"), `turn ${turn}`).toBe("notperson")
  })

  it("a relaunch after turns no page lived through raises the away latch once (#599)", () => {
    const stored = diedInTurn1().save()
    const page = relaunch(stored, at(0, 3, 5), { door: true })
    expect(page.awayCount()).toBe(1)
  })
})

describe("clause 3 — late join is not charged (R2, #520)", () => {
  function lateJoin(loadSecond: number, readyBeforeWindow?: number): Page {
    return relaunch(null, loadSecond, { door: false, readyBeforeWindow })
  }

  it("turns that ended before a genuine late joiner's load hold no verdict", () => {
    const page = lateJoin(at(0, 2, 3))
    page.see("A")
    page.see("C")
    run(page, at(0, 2, 4), REPORTING)
    for (const turn of [0, 1]) for (const id of candidatesOf(turn)) expect(page.verdict(turn, id), `turn ${turn} ${id}`).toBeUndefined()
    // the load turn and after are the late joiner's own: seen co-players are charged
    expect(page.verdict(2, "A")).toBe("notperson")
    expect(page.verdict(3, "A")).toBe("notperson")
    expect(page.verdict(4, "A")).toBe("notperson")
    // B was never seen: the turn books hold nothing for B (the confirm projection decides, step 3)
    expect(page.verdict(3, "B")).toBeUndefined()
  })

  it("a late join in the gap is charged from round 1 only", () => {
    const page = lateJoin(inGap(1, 2))
    page.see("A", null) // a frame before a trustworthy turn: pending
    run(page, inGap(1, 3), REPORTING)
    for (let turn = 0; turn < 4; turn++) for (const id of candidatesOf(turn)) expect(page.verdict(turn, id)).toBeUndefined()
    expect(page.verdict(4, "A")).toBe("notperson")
  })

  it("a late join in reporting charges nobody", () => {
    const page = lateJoin(REPORTING)
    run(page, REPORTING + 1, REPORTING + 3)
    expect(page.books.turnVotes).toEqual({})
  })

  it("a late joiner whose clock is ready before the window is still not charged for earlier turns (#1178 path)", () => {
    const page = lateJoin(at(0, 2, 3), 3)
    page.see("A")
    run(page, at(0, 2, 7), REPORTING)
    for (const turn of [0, 1]) for (const id of candidatesOf(turn)) expect(page.verdict(turn, id), `turn ${turn} ${id}`).toBeUndefined()
  })

  // A backward step into a turn before the late joiner's load re-opens it but
  // never seals it: the entry floor in sealThrough (the model's own
  // presentBeforeFirstTurn ? 0 : firstOpenedTurn) keeps turn 1 below the
  // late joiner's entry unsealed, so the seal files nothing.
  it("a backward step into a turn before a late joiner's load files no verdict in that turn", () => {
    const page = lateJoin(at(0, 2, 3))
    page.see("A")
    page.see("C")
    page.tick(at(0, 1, 6)) // backward chain step into turn 1
    run(page, at(0, 1, 7), at(0, 3, 1))
    for (const id of candidatesOf(1)) expect(page.verdict(1, id), `turn 1 ${id}`).toBeUndefined()
  })

  it("a late join is not a rejoin: no away latch", () => {
    const page = lateJoin(at(0, 2, 3))
    expect(page.awayCount()).toBe(0)
  })
})

describe("clause 4 — taps win (R5)", () => {
  it("a Person tap survives the turn's seal", () => {
    const page = doorPage()
    page.tick(at(0, 0, 0))
    page.see("A")
    page.see("B")
    page.tap("A", "person")
    run(page, at(0, 0, 1), at(0, 1, 1))
    expect(page.verdict(0, "A")).toBe("person")
    expect(page.verdict(0, "B")).toBe("notperson")
    expect(page.books.autoSeals[0]).toEqual(["B"])
  })

  it("a Person tap on the last second of a turn survives the seal on the next second", () => {
    const page = doorPage()
    page.tick(at(0, 0, 0))
    page.see("A")
    page.tick(at(0, 0, 11))
    page.tap("A", "person")
    page.tick(at(0, 1, 0))
    expect(page.verdict(0, "A")).toBe("person")
  })

  it("a Person tap the render has not committed yet when the seal lands still wins", () => {
    const page = doorPage()
    page.tick(at(0, 0, 0))
    page.see("A")
    page.tick(at(0, 0, 11))
    page.lagRender = true
    page.tap("A", "person")
    page.tick(at(0, 1, 0)) // the tick runs before the commit
    page.commit()
    expect(page.verdict(0, "A")).toBe("person")
  })

  // FINDING (low). Rule: autoSeals records the defaults a seal filed, and a
  // tapped player is not a default (#569; the trail's `auto`, summarizeVotes'
  // autoTurns and the `auto` count read it). Sequence: A seen in turn 0, Person
  // tap in the turn's last second, the seal's tick runs before the render
  // commits the tap. Observed: the verdict is Person (correct) but autoSeals[0]
  // lists A, because sealTurn computes `auto` from world.renderedVotes, not
  // from the books it holds. The spec says the reducer holds one copy of the
  // books with no render lag; the extraction kept the lag for the auto list.
  it.fails("a Person tap the render has not committed when the seal lands is not recorded as an auto-seal", () => {
    const page = doorPage()
    page.tick(at(0, 0, 0))
    page.see("A")
    page.tick(at(0, 0, 11))
    page.lagRender = true
    page.tap("A", "person")
    page.tick(at(0, 1, 0))
    page.commit()
    expect(page.books.autoSeals[0] ?? []).not.toContain("A")
  })

  it("a stored tap beats a local default (#429)", () => {
    // page 1 taps A Person in turn 1 and dies before turn 1 seals
    const first = doorPage()
    first.tick(at(0, 0, 0))
    for (const id of ["A", "B", "C"]) first.see(id)
    run(first, at(0, 0, 1), at(0, 1, 3))
    first.tap("B", "person")
    const stored = first.save()
    // page 2 relaunches with a slow read: it seals turn 1 on its own first
    const page = new Page({ door: true, restorePending: true })
    page.clockState = { ready: true, coldStartedAt: at(0, 2, 5) }
    page.tick(at(0, 2, 5))
    page.restorePending = false
    page.tick(at(0, 2, 8))
    page.see("B", 0) // page 2 decoded B too, so its own seal defaults B
    page.tick(at(0, 3, 1))
    page.restore(stored, true)
    run(page, at(0, 3, 2), at(0, 3, 4))
    expect(page.verdict(1, "B")).toBe("person")
  })

  it("a local tap beats a stored default (#429)", () => {
    const first = doorPage()
    first.tick(at(0, 0, 0))
    for (const id of ["A", "B", "C"]) first.see(id)
    run(first, at(0, 0, 1), at(0, 2, 3))
    expect(first.verdict(1, "B")).toBe("notperson") // a default
    const stored = first.save()
    const page = new Page({ door: true, restorePending: true })
    page.clockState = { ready: true, coldStartedAt: at(0, 2, 5) }
    page.tick(at(0, 2, 5))
    page.restorePending = false
    page.tick(at(0, 2, 8))
    page.see("B", 0)
    page.tick(at(0, 1, 6)) // a chain jump re-lives turn 1 on this page
    page.tap("B", "person")
    page.restore(stored, true) // the stored default lands after the tap
    run(page, at(0, 1, 7), at(0, 3, 1))
    expect(page.verdict(1, "B")).toBe("person")
  })
})

describe("clause 5 — the ban holds by account (R6)", () => {
  /** A is banned in turn 1 of round 0; A sits in seat 2 of round 1 */
  function bannedA(): Page {
    const page = doorPage()
    page.tick(at(0, 0, 0))
    for (const id of ["A", "B", "C"]) page.see(id)
    run(page, at(0, 0, 1), at(0, 2, 3)) // turn 2: host B, A judged
    page.ban("A")
    return page
  }

  it("every later turn the banned player is eligible in holds a deliberate NotPerson, in the next round's seat too", () => {
    const page = bannedA()
    run(page, at(0, 2, 4), REPORTING)
    for (const turn of [2, 3, 4, 5, 7]) {
      expect(page.verdict(turn, "A"), `turn ${turn}`).toBe("notperson")
      expect(page.books.autoSeals[turn] ?? [], `turn ${turn} is deliberate`).not.toContain("A")
    }
  })

  it("the ban survives a relaunch and reaches the turns replayed after the restore", () => {
    const stored = bannedA().save()
    expect(stored.banned).toEqual(["A"])
    const page = relaunch(stored, at(1, 1, 3), { door: true })
    expect(page.books.banned.has("A")).toBe(true)
    run(page, at(1, 1, 4), REPORTING)
    for (const turn of [3, 4, 5, 7]) {
      expect(page.verdict(turn, "A"), `turn ${turn}`).toBe("notperson")
      expect(page.books.autoSeals[turn] ?? [], `turn ${turn} is deliberate`).not.toContain("A")
    }
  })

  it("the ban survives a relaunch with a slow read: the missed turns are topped up as deliberate rejects (#567)", () => {
    const stored = bannedA().save()
    const page = relaunch(stored, at(1, 1, 3), { door: true, slowRead: true })
    run(page, at(1, 1, 8), REPORTING)
    for (const turn of [3, 4, 5, 7]) expect(page.verdict(turn, "A"), `turn ${turn}`).toBe("notperson")
  })

  it("ban, unban in the same turn: the ban's reject is taken back and the turn's seal defaults it", () => {
    const page = bannedA()
    page.unban("A")
    expect(page.verdict(2, "A")).toBeUndefined()
    run(page, at(0, 2, 4), at(0, 3, 1))
    expect(page.verdict(2, "A")).toBe("notperson")
    expect(page.books.autoSeals[2]).toContain("A")
  })

  it("ban, unban, then the player rejoins next round: later turns are defaults, not ban rejects", () => {
    const page = bannedA()
    page.unban("A")
    run(page, at(0, 2, 4), at(1, 0, 1))
    page.tap("A", "person") // A is back, the player accepts them
    run(page, at(1, 0, 2), REPORTING)
    expect(page.books.banned.has("A")).toBe(false)
    expect(page.verdict(4, "A")).toBe("person")
    expect(page.verdict(5, "A")).toBe("notperson")
    expect(page.books.autoSeals[5]).toContain("A")
  })

  it("an unban on a re-lived sealed turn restores the seal's default, it never deletes a sealed vote (#569)", () => {
    const page = doorPage()
    page.tick(at(0, 0, 0))
    for (const id of ["A", "B", "C"]) page.see(id)
    run(page, at(0, 0, 1), at(0, 3, 1)) // turn 2 sealed with A defaulted
    page.tick(at(0, 2, 5)) // re-live turn 2
    page.ban("A")
    page.unban("A")
    expect(page.verdict(2, "A")).toBe("notperson")
    expect(page.books.autoSeals[2]).toContain("A")
  })

  it("the ban is the account's, not the seat's: the player who takes A's old seat is not rejected", () => {
    const page = bannedA()
    page.see("D", 4)
    page.see("E", 4)
    run(page, at(0, 2, 4), REPORTING)
    // round 1 seat 1 is ME and seat 2 is A; D and E take other chairs — the
    // ban follows A, and D/E carry only defaults
    for (const turn of [4, 5, 6, 7])
      for (const id of candidatesOf(turn).filter((id) => id !== "A" && id !== ME))
        expect(page.books.autoSeals[turn] ?? [], `turn ${turn} ${id}`).toContain(id)
  })
})

describe("clause 6 — monotone evidence", () => {
  it("a pending observation binds to the first trustworthy turn that opens after it", () => {
    const page = doorPage()
    run(page, at(0, 0, 0), inGap(1, 1))
    page.see("D", null)
    run(page, inGap(1, 2), at(1, 0, 2))
    expect(page.books.videoRoleHistory.D).toEqual({ fromTurn: 4 })
  })

  // FINDING (latent). Rule: §3, "the boundary is the turn the frame arrived
  // in, never back-dated"; clause 6, "a pending observation binds to the first
  // trustworthy turn that opens after it". Sequence: door player saw A and B,
  // died in turn 1; the relaunch page records C pending (fromTurn null) while
  // the clock is cold, then the cold reconcile (ready in turn 3) replays the
  // missed turns from 0. Observed: openTurn binds C to turn 0, the first
  // REPLAYED turn, so C is charged NotPerson in turns 1 and 2, which C was
  // never seen in. The live runner cannot produce a null boundary today
  // (markVideoArrived needs clockReady && inRound since #602), so this is
  // reachable only through a stored null from an older record; the reducer
  // itself does not guard it.
  it.fails("a frame decoded before a relaunch's clock is ready binds to the load turn, not to a missed turn the reconcile replays", () => {
    // page 1 saw A and B, never C, and died in turn 1
    const first = doorPage()
    first.tick(at(0, 0, 0))
    first.see("A")
    first.see("B")
    run(first, at(0, 0, 1), at(0, 1, 4))
    const stored = first.save()
    // page 2: C's frame decodes before the clock is ready (the runner marks it
    // pending, fromTurn null); the clock then turns ready in turn 3
    const page = new Page({ door: true, restorePending: true, clockState: { ready: false } })
    page.tick(at(0, 3, 1)) // cold
    page.see("C", null)
    page.clockState = { ready: true, coldStartedAt: at(0, 3, 2) }
    page.restore(stored, false)
    page.tick(at(0, 3, 2))
    // §3: the boundary is the turn the frame arrived in, never back-dated.
    // C arrived in turn 3; turns 1 and 2 ended before it, with no frame of C.
    expect(page.books.videoRoleHistory.C).toEqual({ fromTurn: 3 })
    expect(page.verdict(1, "C")).toBeUndefined()
    expect(page.verdict(2, "C")).toBeUndefined()
    // A and B were seen before the crash: their missed turns are rejects
    expect(page.verdict(1, "B")).toBe("notperson")
    expect(page.verdict(2, "A")).toBe("notperson")
  })

  it("a restore never moves a boundary later, and takes an earlier one", () => {
    const page = doorPage()
    run(page, at(0, 0, 0), at(0, 1, 0))
    page.see("A", 1)
    page.see("B", 1)
    const stored = { ...page.save(), videoRoleHistory: { A: { fromTurn: 3 }, B: { fromTurn: 0 } } }
    page.restore(stored, false)
    expect(page.books.videoRoleHistory.A).toEqual({ fromTurn: 1 })
    expect(page.books.videoRoleHistory.B).toEqual({ fromTurn: 0 })
  })

  it("a seen co-player stays seen through a backward step, a round change and a relaunch", () => {
    const page = doorPage()
    page.tick(at(0, 0, 0))
    page.see("A")
    run(page, at(0, 0, 1), at(1, 0, 1))
    page.tick(at(0, 3, 4)) // backward across the round boundary
    expect(page.books.videoRoleHistory.A).toEqual({ fromTurn: 0 })
    const next = relaunch(page.save(), at(1, 1, 1), { door: true })
    expect(next.books.videoRoleHistory.A).toEqual({ fromTurn: 0 })
  })
})

describe("clause 7 — idempotence", () => {
  it("the same tick twice gives the same books and no new trail", () => {
    const page = doorPage()
    page.tick(at(0, 0, 0))
    page.see("A")
    run(page, at(0, 0, 1), at(0, 1, 3))
    const before = page.books
    const trail = page.trail.length
    page.tick(at(0, 1, 3))
    expect(page.books).toEqual(before)
    expect(page.trail.length).toBe(trail)
  })

  it("a restore of the books the session already holds changes nothing", () => {
    const page = doorPage()
    page.tick(at(0, 0, 0))
    for (const id of ["A", "B"]) page.see(id)
    run(page, at(0, 0, 1), at(0, 2, 3))
    page.tap("A", "person")
    page.ban("C")
    page.restore(page.save(), false)
    const before = page.books
    page.restore(page.save(), false)
    expect(page.books).toEqual(before)
  })

  it("a restore of the books it already holds, taken mid-game, leaves every verdict as it was", () => {
    const page = doorPage()
    page.tick(at(0, 0, 0))
    for (const id of ["A", "B", "C"]) page.see(id)
    run(page, at(0, 0, 1), at(0, 2, 3))
    page.tap("A", "person")
    const votes = page.books.turnVotes
    const autoSeals = page.books.autoSeals
    const sealed = new Set(page.books.sealed)
    page.restore(page.save(), false)
    expect(page.books.turnVotes).toEqual(votes)
    expect(page.books.autoSeals).toEqual(autoSeals)
    expect(new Set(page.books.sealed)).toEqual(sealed)
  })
})

describe("adversarial sequences", () => {
  it("a slow stored read lands in the middle of a tick burst after a throttle", () => {
    const first = doorPage()
    first.tick(at(0, 0, 0))
    for (const id of ["A", "B", "C"]) first.see(id)
    first.tap("A", "person")
    run(first, at(0, 0, 1), at(0, 1, 2))
    const stored = first.save()
    const page = new Page({ door: true, restorePending: true })
    page.clockState = { ready: true, coldStartedAt: at(0, 2, 0) }
    page.tick(at(0, 2, 0))
    page.restorePending = false
    page.tick(at(0, 2, 3)) // released
    page.tick(at(1, 0, 3)) // throttled across the gap
    page.restore(stored, true) // the read lands inside the burst
    page.tick(at(1, 0, 4))
    page.tick(at(1, 1, 1))
    page.topUp()
    expect(page.verdict(0, "A")).toBe("person")
    for (const turn of [1, 2, 3]) for (const id of candidatesOf(turn)) expect(page.verdict(turn, id), `turn ${turn} ${id}`).toBe("notperson")
    for (let turn = 0; turn < 5; turn++) expect(sealRows(page, turn), `turn ${turn}`).toBeLessThanOrEqual(1)
  })

  it("a backward step across a round boundary re-opens the last turn of the round before, seals nothing, and a tap there wins", () => {
    const page = doorPage()
    page.tick(at(0, 0, 0))
    for (const id of ["A", "B", "C"]) page.see(id)
    run(page, at(0, 0, 1), at(1, 0, 5))
    const sealed = new Set(page.books.sealed)
    page.tick(at(0, 3, 6)) // chain jump back: gap and round 0's last turn
    expect(page.open()).toBe(3)
    expect(new Set(page.books.sealed)).toEqual(sealed)
    page.tap("B", "person")
    run(page, at(0, 3, 7), at(1, 1, 1))
    expect(page.verdict(3, "B")).toBe("person")
    expect(sealRows(page, 3)).toBe(1)
    expect(sealRows(page, 4)).toBe(1)
  })

  it("a backward step into the gap seals nothing and the next round still seals once", () => {
    const page = doorPage()
    page.tick(at(0, 0, 0))
    page.see("A")
    run(page, at(0, 0, 1), at(1, 1, 2))
    const sealed = new Set(page.books.sealed)
    page.tick(inGap(1, 3))
    expect(new Set(page.books.sealed)).toEqual(sealed)
    run(page, at(1, 0, 0), at(1, 2, 1))
    expect(sealRows(page, 4)).toBe(1)
    expect(sealRows(page, 5)).toBe(1)
  })

  it("a relaunch in the gap followed by a second relaunch in reporting charges every missed turn exactly once", () => {
    const first = doorPage()
    first.tick(at(0, 0, 0))
    for (const id of ["A", "B", "C"]) first.see(id)
    run(first, at(0, 0, 1), at(0, 0, 8))
    const second = relaunch(first.save(), inGap(1, 2), { door: true })
    const third = relaunch(second.save(), REPORTING, { door: true, slowRead: true })
    for (let turn = 0; turn < 8; turn++)
      for (const id of candidatesOf(turn).filter((id) => ["A", "B", "C"].includes(id)))
        expect(third.verdict(turn, id), `turn ${turn} ${id}`).toBe("notperson")
  })

  it("a frozen page's return tick raises the away latch", () => {
    const page = doorPage()
    run(page, at(0, 0, 0), at(0, 0, 3))
    page.frozeNext = true
    page.tick(at(0, 2, 0))
    expect(page.awayCount()).toBe(1)
  })
})
