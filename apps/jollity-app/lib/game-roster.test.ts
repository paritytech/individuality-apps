// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { buildReport, coPlayers, countReport, predictVerdict, sealTurnVotes, sharedTurnWith, summarizeVotes, type TurnVotes } from "./game-roster"
import type { LiveSeat } from "./game-source"

const seat = (index: number, who: string): LiveSeat => ({
  index,
  player: { type: "Account", value: who },
})
const alias = (index: number, hex: string): LiveSeat => ({
  index,
  player: { type: "Person", value: hex },
})
/** a chair the shuffle never reached */
const empty = (index: number): LiveSeat => ({ index, player: null })

// one group, the same three chairs in both rounds
const STILL: LiveSeat[][] = [
  [seat(0, "me"), seat(1, "bee"), seat(2, "cee")],
  [seat(0, "me"), seat(1, "bee"), seat(2, "cee")],
]

// the chain reshuffles: you move from chair 0 to chair 1, cee drops out and
// dee arrives
const SHUFFLED: LiveSeat[][] = [
  [seat(0, "me"), seat(1, "bee"), seat(2, "cee")],
  [seat(3, "dee"), seat(4, "me"), seat(5, "bee")],
]
const SHUFFLED_MINE = [0, 1]

// a cap of four with three players: the last chair holds nobody
const GHOSTED: LiveSeat[][] = [[seat(0, "me"), seat(1, "bee"), seat(2, "cee"), empty(3)]]

describe("coPlayers", () => {
  it("lists the group once when the rounds do not move anyone", () => {
    expect(coPlayers(STILL, [0, 0])).toEqual(["bee", "cee"])
  })

  it("keeps the last round in its seat order, then appends whoever only an earlier round met", () => {
    expect(coPlayers(SHUFFLED, SHUFFLED_MINE)).toEqual(["dee", "bee", "cee"])
  })

  it("never lists you, wherever the round seated you", () => {
    expect(coPlayers(SHUFFLED, SHUFFLED_MINE)).not.toContain("me")
  })

  it("names an alias player by the alias", () => {
    const rounds = [[seat(0, "me"), alias(1, "0xabcd")]]
    expect(coPlayers(rounds, [0])).toEqual(["person:0xabcd"])
  })

  it("passes a chair nobody holds by", () => {
    expect(coPlayers(GHOSTED, [0])).toEqual(["bee", "cee"])
  })
})

describe("sharedTurnWith (#520)", () => {
  // SHUFFLED with a three-turn round: round 0 is turns 0-2, round 1 turns 3-5
  const shared = (id: string, firstTurn: number) => sharedTurnWith(SHUFFLED, SHUFFLED_MINE, id, firstTurn, 3)

  it("a player there from turn 0 shared a turn with everyone they were grouped with", () => {
    expect(["bee", "cee", "dee"].map((id) => shared(id, 0))).toEqual([true, true, true])
  })

  it("a latecomer from round 1 never shared a turn with a round-0-only co-player", () => {
    expect(shared("cee", 3)).toBe(false)
    expect(shared("bee", 3)).toBe(true)
    expect(shared("dee", 3)).toBe(true)
  })

  it("a latecomer in round 0's last turn shared it with that round's group, its host included", () => {
    expect(shared("cee", 2)).toBe(true)
  })

  it("you and a player outside every group are never shared", () => {
    expect(shared("me", 0)).toBe(false)
    expect(shared("zed", 0)).toBe(false)
  })
})

describe("predictVerdict", () => {
  const votes: TurnVotes = {
    0: { bee: "person", cee: "notperson" },
    1: { bee: "person" },
    5: { bee: "notperson", cee: "person" },
  }

  it("takes the majority of the taps across every turn of the game", () => {
    expect(predictVerdict(votes, "bee")).toBe("person")
  })

  it("rejects on a tie", () => {
    expect(predictVerdict(votes, "cee")).toBe("notperson")
  })

  it("rejects a player no turn ever decided, by default", () => {
    expect(predictVerdict(votes, "dee")).toBe("notperson")
  })

  it("gives a player you never saw the benefit of the doubt when asked (late join)", () => {
    // a late joiner has no turn with the players of the rounds they missed
    expect(predictVerdict(votes, "dee", "person")).toBe("person")
  })

  it("still rejects a player whose one seen turn was a reject, late join or not", () => {
    expect(predictVerdict({ 3: { eff: "notperson" } }, "eff", "person")).toBe("notperson")
  })
})

describe("buildReport", () => {
  const never = () => undefined

  it("files one vote per co-player of that round's group", () => {
    const report = buildReport(SHUFFLED, SHUFFLED_MINE, never)
    expect(report.map((round) => round.length)).toEqual([
      SHUFFLED[0].length - 1,
      SHUFFLED[1].length - 1,
    ])
  })

  it("rejects a member no verdict was filed for", () => {
    expect(buildReport(SHUFFLED, SHUFFLED_MINE, never)).toEqual([
      ["NotPerson", "NotPerson"],
      ["NotPerson", "NotPerson"],
    ])
  })

  it("writes one verdict into every round, at that round's own position", () => {
    const report = buildReport(SHUFFLED, SHUFFLED_MINE, (id) =>
      id === "bee" ? "person" : "notperson",
    )
    // round 0 seats bee at chair 1, round 1 at chair 5 — after you drop out
    // that is position 0 and position 1
    expect(report).toEqual([
      ["Person", "NotPerson"],
      ["NotPerson", "Person"],
    ])
  })

  it("files nothing for a chair nobody holds", () => {
    const report = buildReport(GHOSTED, [0], (id) => (id === "bee" ? "person" : "notperson"))
    expect(report).toEqual([["Person", "NotPerson"]])
  })

  it("keeps the seat order, which is ascending player index", () => {
    const rounds = [[seat(0, "me"), seat(1, "bee"), empty(2), seat(3, "cee")]]
    const report = buildReport(rounds, [0], (id) => (id === "cee" ? "person" : "notperson"))
    expect(report).toEqual([["NotPerson", "Person"]])
  })
})

/** a trail for a seen co-player: what is filed is what the votes predict */
const seenSummary = (
  tv: TurnVotes, as: Record<number, readonly string[]>, id: string, ov: "person" | "notperson" | undefined, unseen: "person" | "notperson" = "notperson",
) => summarizeVotes(tv, as, id, ov, unseen, { verdict: ov ?? predictVerdict(tv, id, unseen), seen: true })

describe("the vote trail", () => {
  it("seals the undecided as NotPerson and names who was tapped and who was defaulted", () => {
    const cast = { bee: "person", cee: "notperson" } as const
    const sealed = sealTurnVotes(cast, ["bee", "cee", "dee", "eve"])
    expect(sealed.votes).toEqual({ bee: "person", cee: "notperson", dee: "notperson", eve: "notperson" })
    expect(sealed.auto).toEqual(["dee", "eve"])
    expect(sealed.tapped).toEqual({ person: ["bee"], notperson: ["cee"] })
    expect(cast).toEqual({ bee: "person", cee: "notperson" })
  })

  it("seals nothing when everyone was decided", () => {
    expect(sealTurnVotes({ bee: "person" }, ["bee"]).auto).toEqual([])
  })

  const votes: TurnVotes = {
    0: { bee: "person", cee: "notperson", dee: "notperson" },
    1: { bee: "person", cee: "person", dee: "notperson" },
    2: { bee: "notperson", cee: "person" },
  }
  const auto = { 0: ["dee"], 1: ["dee"], 2: [] }

  it("a majority", () => {
    expect(seenSummary(votes, auto, "bee", undefined)).toMatchObject({
      verdict: "person", personTurns: 2, notPersonTurns: 1, autoTurns: 0, source: "majority",
    })
  })

  it("counts the default seals among the NotPerson turns", () => {
    expect(seenSummary(votes, auto, "dee", undefined)).toMatchObject({
      verdict: "notperson", personTurns: 0, notPersonTurns: 2, autoTurns: 2, source: "majority",
    })
  })

  it("a tie rejects", () => {
    expect(seenSummary({ 0: { bee: "person" }, 1: { bee: "notperson" } }, {}, "bee", undefined)).toMatchObject({
      verdict: "notperson", source: "tie",
    })
  })

  it("an override wins and says so", () => {
    expect(seenSummary(votes, auto, "dee", "person")).toMatchObject({
      verdict: "person", notPersonTurns: 2, autoTurns: 2, source: "override",
    })
  })

  it("an unseen co-player takes the caller's default", () => {
    expect(seenSummary(votes, auto, "zed", undefined, "person")).toMatchObject({
      verdict: "person", personTurns: 0, notPersonTurns: 0, autoTurns: 0, source: "unseen",
    })
  })

  it("logs the filed verdict, and keeps the prediction apart (#520)", () => {
    // no decoded video: the report files NotPerson even though late join predicts Person
    expect(summarizeVotes(votes, auto, "zed", undefined, "person", { verdict: "notperson", seen: false })).toEqual({
      verdict: "notperson", predicted: "person", personTurns: 0, notPersonTurns: 0, autoTurns: 0, source: "unseen",
      unseenChoice: "default-notperson",
    })
    // seen: the filed value is the prediction or the override
    expect(summarizeVotes(votes, auto, "bee", undefined, "person", { verdict: "person", seen: true })).toMatchObject({
      verdict: "person", predicted: "person", source: "majority",
    })
    expect(summarizeVotes(votes, auto, "dee", "person", "person", { verdict: "person", seen: true })).toMatchObject({
      verdict: "person", predicted: "person", source: "override",
    })
  })

  it("a never-seen co-player the latecomer never shared a turn with logs the late-join Person as never-shared (#520)", () => {
    const s = summarizeVotes(votes, auto, "zed", undefined, "person", { verdict: "person", seen: false, shared: false })
    expect(s).toEqual({ verdict: "person", predicted: "person", personTurns: 0, notPersonTurns: 0, autoTurns: 0, source: "never-shared" })
    // a shared turn with no decoded video stays #445's unseen NotPerson
    expect(summarizeVotes(votes, auto, "zed", undefined, "person", { verdict: "notperson", seen: false, shared: true }).source).toBe("unseen")
    // both are never seen, so both count as unseen
    expect(countReport([s])).toMatchObject({ person: 1, notperson: 0, unseen: 1 })
  })

  it("#871 records each shared-turn never-seen choice apart from timer seals", () => {
    const left = summarizeVotes({}, {}, "zed", undefined, "person", {
      verdict: "notperson",
      seen: false,
      shared: true,
    })
    const flipped = summarizeVotes({}, {}, "bee", "person", "person", {
      verdict: "person",
      seen: false,
      shared: true,
    }, true)
    const flippedBack = summarizeVotes({}, {}, "cee", "notperson", "person", {
      verdict: "notperson",
      seen: false,
      shared: true,
    }, true)
    expect(left).toMatchObject({ source: "unseen", unseenChoice: "default-notperson", autoTurns: 0 })
    expect(flipped).toMatchObject({ source: "unseen", unseenChoice: "flipped-person", unseenEverFlipped: true, autoTurns: 0 })
    expect(flippedBack).toMatchObject({ source: "unseen", unseenChoice: "default-notperson", unseenEverFlipped: true, autoTurns: 0 })
    expect(countReport([left, flipped, flippedBack])).toMatchObject({
      unseen: 3,
      unseenDefault: 2,
      unseenFlipped: 1,
      autoOnly: 0,
    })
  })

  it("countReport follows the filed verdict: an unseen co-player the votes lean Person on counts NotPerson and unseen (#520)", () => {
    const leaning = { 0: { zed: "person" as const }, 1: { zed: "person" as const } }
    const filed = summarizeVotes(leaning, {}, "zed", undefined, "person", { verdict: "notperson", seen: false })
    expect(filed).toMatchObject({ verdict: "notperson", predicted: "person", source: "unseen" })
    expect(countReport([filed])).toMatchObject({ person: 0, notperson: 1, unseen: 1, ties: 0 })
  })

  it("counts how the report split, and which NotPersons were all default", () => {
    const summaries = ["bee", "cee", "dee", "zed"].map((id) => seenSummary(votes, auto, id, undefined, "person"))
    expect(countReport(summaries)).toEqual({
      person: 3,
      notperson: 1,
      autoOnly: 1,
      ties: 0,
      unseen: 1,
      unseenDefault: 0,
      unseenFlipped: 0,
    })
  })

  it("a tapped reject or an override is never auto-only; a tie of defaults is", () => {
    const tapped = seenSummary({ 0: { bee: "notperson" } }, {}, "bee", undefined)
    const overridden = seenSummary({ 0: { bee: "notperson" } }, { 0: ["bee"] }, "bee", "notperson")
    const tie = seenSummary({ 0: { bee: "person" }, 1: { bee: "notperson" } }, { 1: ["bee"] }, "bee", undefined)
    expect(countReport([tapped, overridden])).toMatchObject({ notperson: 2, autoOnly: 0 })
    expect(countReport([tie])).toMatchObject({ ties: 1, autoOnly: 1 })
  })
})
