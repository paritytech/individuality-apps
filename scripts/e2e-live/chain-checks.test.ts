// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  NEVER_REGISTERED,
  bootSeatVerdict,
  chainVoteTable,
  checkAbsent,
  checkChainVotes,
  checkSignedUp,
  compareAccounts,
  checkReports,
  checkSettled,
  runBotAccounts,
  reportVerdicts,
  settleDeadline,
  type ChainReader,
  type FiledReport,
  type PlayerRecord,
  type ReportEvent,
  type VideoRoleEvidence,
} from "./chain-checks"
import type { DownInfo } from "./down-turns"

const A = "5GzdFDQkYceNADTY373MDGscTFkuUUjfmHazGe1o467943s2"
const B = "5DZWn7j19HSuW9VbHFUNupSgBNvXvUGYtzEuQH9cixSLMvVJ"
const C = "5DjqhkyaU1GQaDQp9VDi3aKM3NwCX2D1wYZXQwRbMYXpLGVr"

const record = (over: Partial<PlayerRecord> = {}): PlayerRecord => ({
  first_game: 3,
  registered: true,
  sent_report: false,
  ...over,
})
// an in-memory chain: only the accounts in `players` have a record
const reader = (players: Record<string, PlayerRecord>): ChainReader => ({
  player: async (account) => players[account],
})

describe("checkSignedUp", () => {
  it("passes for an account whose record says registered", async () => {
    const c = await checkSignedUp(reader({ [A]: record() }), A)
    expect(c.status).toBe("pass")
  })

  it("fails for a record left over from an earlier game that is not registered now", async () => {
    const c = await checkSignedUp(reader({ [A]: record({ registered: false }) }), A)
    expect(c.status).toBe("fail")
    expect(c.detail).toContain("registered=false")
  })

  it("fails for an account with no record", async () => {
    const c = await checkSignedUp(reader({}), A)
    expect(c.status).toBe("fail")
    expect(c.detail).toContain("no Game.Players record")
  })
})

describe("checkAbsent (negative control)", () => {
  it("passes when the never-registered account has no record", async () => {
    expect((await checkAbsent(reader({ [A]: record() }), NEVER_REGISTERED)).status).toBe("pass")
  })

  it("fails when the chain reports a record for it, so a reader that answers yes to everything is caught", async () => {
    const yesToAll: ChainReader = { player: async () => record() }
    expect((await checkAbsent(yesToAll, NEVER_REGISTERED)).status).toBe("fail")
  })

  it("the signed-up check on that account fails, which is what makes it a control", async () => {
    expect((await checkSignedUp(reader({ [A]: record() }), NEVER_REGISTERED)).status).toBe("fail")
  })
})

describe("compareAccounts", () => {
  it("passes when the UI shows the oracle's account", () => {
    expect(compareAccounts(A, A).status).toBe("pass")
  })

  it("fails when fed a mismatched account", () => {
    const c = compareAccounts(B, A)
    expect(c.status).toBe("fail")
    expect(c.detail).toContain(B)
    expect(c.detail).toContain(A)
  })

  it("is unchecked, not passed, when the UI exposes no account (before the home test hooks)", () => {
    expect(compareAccounts(undefined, A).status).toBe("unchecked")
    expect(compareAccounts("", A).status).toBe("unchecked")
  })

  it("fails when the oracle has no account to compare with", () => {
    expect(compareAccounts(A, "").status).toBe("fail")
  })
})

describe("checkReports", () => {
  const ev = (who: string, game = 9): ReportEvent => ({ who: { type: "Account", value: who }, game_index: game })

  it("passes when every account reported in this game", () => {
    const c = checkReports([ev(A), ev(B), ev(C)], 9, [A, B, C])
    expect(c.every((x) => x.status === "pass")).toBe(true)
  })

  it("does not count a report from another game", () => {
    const c = checkReports([ev(A), ev(B), ev(C, 8)], 9, [A, B, C])
    expect(c.map((x) => x.status)).toEqual(["pass", "pass", "fail"])
  })

  it("does not count a Person-keyed report as an account's", () => {
    const person: ReportEvent = { who: { type: "Person", value: "0x" + "11".repeat(32) }, game_index: 9 }
    expect(checkReports([person], 9, [A])[0].status).toBe("fail")
  })
})

describe("checkSettled", () => {
  it("passes once the chain holds no game or a later one", () => {
    expect(checkSettled(undefined, 9, []).status).toBe("pass")
    expect(checkSettled({ index: 10, state: "Registration" }, 9, []).status).toBe("pass")
  })

  it("passes on a GameEnded for this game even while the slot still shows it", () => {
    expect(checkSettled({ index: 9, state: "PlayerProcess" }, 9, [9]).status).toBe("pass")
  })

  it("fails while the game is still processing", () => {
    const c = checkSettled({ index: 9, state: "PlayerProcess" }, 9, [])
    expect(c.status).toBe("fail")
    expect(c.detail).toContain("PlayerProcess")
  })
})

describe("settleDeadline", () => {
  it("is report_ends plus the margin, in chain seconds", () => {
    expect(settleDeadline(5000, 300)).toBe(5300)
  })
})

// the shape chain-read.mts `votes` returns. G164 is game 164 as decoded live:
// three bots, one group of three (indices 0..2), two rounds, all Person.
const H = "5CLy4fTaWKpTA9L8hvf3QK3Hz9ddZ3JBDBn2gzwnYruqAeoB" // a human co-player
const group = (...players: string[]) => players.map((player, index) => ({ index, player }))
const filed = (over: Partial<FiledReport> = {}): FiledReport => ({
  who: A,
  block: 1267536,
  extrinsic: 2,
  rounds: [
    { ownIndex: 1, members: group(B, A, C) },
    { ownIndex: 0, members: group(A, C, B) },
  ],
  fullReport: [
    ["Person", "Person"],
    ["Person", "Person"],
  ],
  ...over,
})

describe("reportVerdicts", () => {
  it("maps each position to the co-player at that ascending index, skipping the reporter", () => {
    const { rows, error } = reportVerdicts(filed({ fullReport: [["Person", "NotPerson"], ["NotPerson", "Person"]] }))
    expect(error).toBeNull()
    expect(rows).toEqual([
      { round: 0, index: 0, attestee: B, verdict: "Person" },
      { round: 0, index: 2, attestee: C, verdict: "NotPerson" },
      { round: 1, index: 1, attestee: C, verdict: "NotPerson" },
      { round: 1, index: 2, attestee: B, verdict: "Person" },
    ])
  })
  it("sorts members it is handed out of order", () => {
    const r = filed({ rounds: [{ ownIndex: 4, members: [{ index: 9, player: C }, { index: 4, player: A }, { index: 1, player: B }] }], fullReport: [["Person", "NotPerson"]] })
    expect(reportVerdicts(r).rows.map((x) => [x.attestee, x.verdict])).toEqual([
      [B, "Person"],
      [C, "NotPerson"],
    ])
  })
  it("a length that does not match the group is an error", () => {
    expect(reportVerdicts(filed({ fullReport: [["Person"], ["Person", "Person"]] })).error).toMatch(/round 1: 1 votes for 2/)
    expect(reportVerdicts(filed({ fullReport: [["Person", "Person"]] })).error).toMatch(/1 rounds/)
  })
})

describe("checkChainVotes", () => {
  const bots = [A, B, C]
  it("passes when every round verdict is Person", () => {
    const c = checkChainVotes("bot A", filed(), bots, false)
    expect(c.status).toBe("pass")
    expect(c.detail).toContain("4/4")
  })
  it("FAILS on one NotPerson (a WARN under diagnose), naming who and whether it is a bot", () => {
    const r = filed({ rounds: [{ ownIndex: 1, members: group(B, A, H) }], fullReport: [["Person", "NotPerson"]] })
    const c = checkChainVotes("bot A", r, bots, false)
    expect(c.status).toBe("fail")
    expect(c.detail).toContain("round 1 5CLy4fTa (human)=NotPerson")
    expect(checkChainVotes("bot A", r, bots, true).status).toBe("warn")
  })
  it("game 1391 names a bot from another runner as a bot", () => {
    const fixture = JSON.parse(readFileSync(join(__dirname, "fixtures", "cross-runner-bot.json"), "utf8")) as {
      crossRunnerBot: string
      localBots: string[]
      runBots: string[]
      report: FiledReport
    }
    const local = checkChainVotes("g1391 bot 8", fixture.report, fixture.localBots, false)
    expect(local.detail).toContain(`${fixture.crossRunnerBot.slice(0, 8)} (human)=NotPerson`)

    const all = checkChainVotes("g1391 bot 8", fixture.report, runBotAccounts(JSON.stringify(fixture.runBots), fixture.localBots), false)
    expect(all.detail).toContain(`${fixture.crossRunnerBot.slice(0, 8)} (bot)=NotPerson`)
    expect(all.detail).not.toContain(`${fixture.crossRunnerBot.slice(0, 8)} (human)`)
  })
  it("no report or an undecodable report is a miss, never a pass", () => {
    expect(checkChainVotes("x", undefined, bots, false).status).toBe("fail")
    expect(checkChainVotes("x", filed({ fullReport: [[], []] }), bots, false).status).toBe("fail")
    expect(checkChainVotes("x", undefined, bots, true).status).toBe("warn")
  })

  it("passes an empty verdict report when every decoded round proves the player was alone", () => {
    const solo = filed({ rounds: [{ ownIndex: 0, members: group(A) }], fullReport: [[]] })
    const check = checkChainVotes("solo bot", solo, bots, false)
    expect(check.status).toBe("pass")
    expect(check.detail).toContain("solo roster")
    expect(check.detail).toContain("no co-player verdicts expected")
    expect(checkChainVotes("wrong reporter", filed({ rounds: [{ ownIndex: 0, members: group(B) }], fullReport: [[]] }), bots, false).status).toBe("fail")
    expect(checkChainVotes("empty roster", filed({ rounds: [], fullReport: [] }), bots, false).status).toBe("fail")
  })

  it("expects NotPerson only for never-seen peers and still fails a missed Co-player", () => {
    const oneRound = {
      rounds: [{ ownIndex: 1, members: group(B, A, C) }],
      fullReport: [["NotPerson", "Person"]],
    }
    const roles = {
      turns: [
        { turn: 1, roles: { [B]: "host" as const, [C]: "coplayer" as const } },
        { turn: 2, roles: { [B]: "unseen" as const, [C]: "coplayer" as const } },
        { turn: 3, roles: { [B]: "unseen" as const, [C]: "host" as const } },
      ],
    }
    const neverSeen = checkChainVotes("bot A", filed(oneRound), bots, false, undefined, roles)
    expect(neverSeen.status).toBe("pass")
    expect(neverSeen.detail).toContain("never-seen expects NotPerson")

    const missedCoplayer = checkChainVotes(
      "bot A",
      filed({ ...oneRound, fullReport: [["NotPerson", "NotPerson"]] }),
      bots,
      false,
      undefined,
      roles,
    )
    expect(missedCoplayer.status).toBe("fail")
    expect(missedCoplayer.detail).toContain(`${C.slice(0, 8)} (bot)=NotPerson`)
  })

  it("counts only turns at and after the Unseen to Co-player flip", () => {
    const roles = {
      turns: [
        { turn: 1, roles: { [B]: "unseen" as const, [C]: "coplayer" as const } },
        { turn: 2, roles: { [B]: "unseen" as const, [C]: "coplayer" as const } },
        { turn: 3, roles: { [B]: "coplayer" as const, [C]: "host" as const } },
      ],
    }
    const report = filed({ rounds: [{ ownIndex: 1, members: group(B, A, C) }], fullReport: [["Person", "Person"]] })
    expect(checkChainVotes("bot A", report, bots, false, undefined, roles).status).toBe("pass")
  })

  it("does not invent eligible Person votes before a late sender's first observed role row", () => {
    const oneRound = { rounds: [{ ownIndex: 1, members: group(B, A, C) }] }
    const lateRoles = {
      turns: [
        { turn: 2, roles: { [B]: "unseen" as const, [C]: "unseen" as const } },
        { turn: 3, roles: { [B]: "unseen" as const, [C]: "host" as const } },
      ],
    }
    const correct = checkChainVotes("late bot A", filed({ ...oneRound, fullReport: [["NotPerson", "NotPerson"]] }), bots, false, undefined, lateRoles)
    expect(correct.status).toBe("pass")
    expect(correct.detail).toContain("2/2 round verdicts as expected")

    const wrongPerson = checkChainVotes("late bot A", filed({ ...oneRound, fullReport: [["Person", "Person"]] }), bots, false, undefined, lateRoles)
    expect(wrongPerson.status).toBe("fail")
    expect(wrongPerson.detail).toContain("expected NotPerson")
  })

  it("keeps a missing role after observation distinct from the initial missing prefix", () => {
    const establishedRoles = {
      turns: [
        { turn: 1, roles: { [B]: "host" as const, [C]: "unseen" as const } },
        { turn: 2, roles: { [B]: "unseen" as const, [C]: "unseen" as const } },
        { turn: 3, roles: { [C]: "host" as const } },
      ],
    }
    const report = filed({ rounds: [{ ownIndex: 1, members: group(B, A, C) }], fullReport: [["Person", "NotPerson"]] })
    expect(checkChainVotes("established bot A", report, bots, false, undefined, establishedRoles).status).toBe("pass")
  })

  it("fails closed when a peer has no authoritative role row anywhere", () => {
    const partialRoles = {
      turns: [
        { turn: 1, roles: { [C]: "coplayer" as const } },
        { turn: 2, roles: { [C]: "coplayer" as const } },
        { turn: 3, roles: { [C]: "host" as const } },
      ],
    }
    const oneRound = { rounds: [{ ownIndex: 1, members: group(B, A, C) }] }
    const unsupportedNotPerson = checkChainVotes("partial bot A", filed({ ...oneRound, fullReport: [["NotPerson", "Person"]] }), bots, false, undefined, partialRoles)
    expect(unsupportedNotPerson.status).toBe("fail")
    expect(unsupportedNotPerson.detail).toContain(`${B.slice(0, 8)} (bot)=NotPerson, expected Person`)

    const failClosedPerson = checkChainVotes("partial bot A", filed({ ...oneRound, fullReport: [["Person", "Person"]] }), bots, false, undefined, partialRoles)
    expect(failClosedPerson.status).toBe("pass")
  })

  it("uses the report's padded round width when occupied groups have only three members", () => {
    const D = "5D11111111111111111111111111111111111111111111111"
    const E = "5E11111111111111111111111111111111111111111111111"
    const report = filed({
      maxGroupSize: 6,
      rounds: [
        { ownIndex: 1, members: group(B, A, C) },
        { ownIndex: 1, members: group(D, A, E) },
      ],
      fullReport: [["Person", "Person"], ["Person", "Person"]],
    })
    const roles = {
      turns: [
        ...Array.from({ length: 6 }, (_, index) => ({ turn: index + 1, roles: { [B]: "coplayer" as const, [C]: "coplayer" as const } })),
        ...Array.from({ length: 6 }, (_, index) => ({ turn: index + 7, roles: { [D]: "coplayer" as const, [E]: "coplayer" as const } })),
      ],
    }
    expect(checkChainVotes("mixed group bot", report, [A, B, C, D, E], false, undefined, roles)).toMatchObject({ status: "pass", detail: expect.stringContaining("4/4") })
  })

  it("fails one missed eligible Co-player turn even when later Person votes win the majority", () => {
    const roles = {
      turns: [
        { turn: 0, roles: { [B]: "coplayer" as const }, verdicts: { [B]: "missed" as const } },
        { turn: 1, roles: { [B]: "coplayer" as const }, verdicts: { [B]: "approved" as const } },
        { turn: 2, roles: { [B]: "coplayer" as const }, verdicts: { [B]: "approved" as const } },
      ],
    }
    const report = filed({ rounds: [{ ownIndex: 0, members: group(A, B) }], fullReport: [["Person"]] })
    const check = checkChainVotes("bot A", report, bots, false, undefined, roles)
    expect(check.status).toBe("fail")
    expect(check.detail).toContain("turn 0")
  })

  it("blocks unknown opportunity evidence and does not let the delegated oracle pass it", () => {
    const roles = {
      turns: [
        { turn: 1, roles: { [B]: "coplayer" as const }, verdicts: { [B]: "unknown" as const } },
        { turn: 2, roles: { [B]: "coplayer" as const }, verdicts: { [B]: "approved" as const } },
        { turn: 3, roles: { [B]: "coplayer" as const }, verdicts: { [B]: "approved" as const } },
      ],
    }
    const report = filed({ rounds: [{ ownIndex: 0, members: group(A, B) }], fullReport: [["Person"]] })
    const check = checkChainVotes("bot A", report, bots, false, undefined, roles)
    expect(check.status).toBe("fail")
    expect(check.detail).toContain("opportunity evidence unknown")
    expect(check.detail).toContain("turn 1")

    const legacyUnknown = {
      turns: [{ turn: 1, roles: { [B]: undefined }, verdicts: { [B]: "unknown" as const } }],
    }
    expect(checkChainVotes("legacy bot A", report, bots, false, undefined, legacyUnknown).status).toBe("fail")
  })

  describe("unknown evidence of a bot that was down (#499)", () => {
    const unknownAt = (...turns: number[]) => ({
      turns: [1, 2, 3, 4, 5, 6].map((turn) => ({
        turn,
        roles: { [B]: "coplayer" as const },
        verdicts: { [B]: turns.includes(turn) ? ("unknown" as const) : ("approved" as const) },
      })),
    })
    const report = filed({ maxGroupSize: 6, rounds: [{ ownIndex: 0, members: group(A, B) }], fullReport: [["Person"]] })
    // down in turn 3, recovering on turn 4
    const down = { missed: [] as number[], downTurns: [3, 4], maxGroupSize: 6, windows: "killed 22:21:38 UTC, relaunched 22:21:48 UTC" }
    it("unknown on the recovery turn is inconclusive, naming the turn", () => {
      const c = checkChainVotes("bot A", report, bots, false, down, unknownAt(4))
      expect(c.status).toBe("inconclusive")
      expect(c.detail).toContain("turn 4")
      expect(c.detail).toContain("recovery turn")
    })
    it("unknown on a turn inside the window is inconclusive", () => {
      expect(checkChainVotes("bot A", report, bots, false, down, unknownAt(3)).status).toBe("inconclusive")
    })
    it("unknown two turns after the window still fails, even next to a tolerated one", () => {
      const c = checkChainVotes("bot A", report, bots, false, down, unknownAt(4, 5))
      expect(c.status).toBe("fail")
      expect(c.detail).toContain("turn 5")
      expect(c.detail).not.toContain("turn 4")
      expect(checkChainVotes("bot A", report, bots, false, down, unknownAt(6)).status).toBe("fail")
    })
    it("no down window: unknown fails as before; a down info without turns is no excuse either", () => {
      expect(checkChainVotes("bot A", report, bots, false, undefined, unknownAt(4)).status).toBe("fail")
      expect(checkChainVotes("bot A", report, bots, false, { missed: [], maxGroupSize: 6, windows: "" }, unknownAt(4)).status).toBe("fail")
      expect(checkChainVotes("bot A", report, bots, false, { ...down, downTurns: [] }, unknownAt(4)).status).toBe("fail")
    })
    it("a wrong verdict stays a failure beside a tolerated unknown", () => {
      const wrong = filed({ maxGroupSize: 6, rounds: [{ ownIndex: 0, members: group(A, B) }], fullReport: [["NotPerson"]] })
      expect(checkChainVotes("bot A", wrong, bots, false, down, unknownAt(4)).status).toBe("fail")
    })
    it("a missed turn inside the window or on the recovery turn is no independent miss (#526)", () => {
      for (const turn of [3, 4]) {
        const roles = unknownAt()
        roles.turns[turn - 1].verdicts = { [B]: "missed" as never }
        const c = checkChainVotes("bot A", report, bots, false, down, roles)
        expect(c.status).toBe("inconclusive")
        expect(c.detail).toContain(`turn ${turn}`)
      }
      const wrong = filed({ maxGroupSize: 6, rounds: [{ ownIndex: 0, members: group(A, B) }], fullReport: [["NotPerson"]] })
      const roles = unknownAt()
      roles.turns[3].verdicts = { [B]: "missed" as never }
      expect(checkChainVotes("bot A", wrong, bots, false, down, roles).status).toBe("fail")
    })
    it("a missed eligible turn outside the window still fails", () => {
      const roles = unknownAt(4)
      roles.turns[0].verdicts = { [B]: "missed" as never }
      expect(checkChainVotes("bot A", report, bots, false, down, roles).status).toBe("fail")
    })
  })

  it("counts proven post-cutoff no-opportunity as the product's auto-NotPerson without rewriting the role", () => {
    const tieRoles = {
      turns: [
        { turn: 1, roles: { [B]: "coplayer" as const }, verdicts: { [B]: "no-opportunity" as const } },
        { turn: 2, roles: { [B]: "host" as const }, verdicts: { [B]: "not-votable" as const } },
        { turn: 3, roles: { [B]: "coplayer" as const }, verdicts: { [B]: "approved" as const } },
      ],
    }
    const tieNotPerson = filed({ maxGroupSize: 3, rounds: [{ ownIndex: 0, members: group(A, B) }], fullReport: [["NotPerson"]] })
    const tiePerson = filed({ maxGroupSize: 3, rounds: [{ ownIndex: 0, members: group(A, B) }], fullReport: [["Person"]] })
    expect(checkChainVotes("bot A", tieNotPerson, bots, false, undefined, tieRoles).status).toBe("pass")
    expect(checkChainVotes("bot A", tiePerson, bots, false, undefined, tieRoles).status).toBe("fail")

    const majorityPerson = {
      turns: [
        { turn: 1, roles: { [B]: "coplayer" as const }, verdicts: { [B]: "no-opportunity" as const } },
        { turn: 2, roles: { [B]: "host" as const }, verdicts: { [B]: "not-votable" as const } },
        { turn: 3, roles: { [B]: "coplayer" as const }, verdicts: { [B]: "approved" as const } },
        { turn: 4, roles: { [B]: "coplayer" as const }, verdicts: { [B]: "approved" as const } },
      ],
    }
    const correctPerson = filed({ maxGroupSize: 4, rounds: [{ ownIndex: 0, members: group(A, B) }], fullReport: [["Person"]] })
    expect(checkChainVotes("bot A", correctPerson, bots, false, undefined, majorityPerson).status).toBe("pass")

    const allNoOpportunity = {
      turns: [
        { turn: 1, roles: { [B]: "coplayer" as const }, verdicts: { [B]: "no-opportunity" as const } },
        { turn: 2, roles: { [B]: "host" as const }, verdicts: { [B]: "not-votable" as const } },
        { turn: 3, roles: { [B]: "coplayer" as const }, verdicts: { [B]: "no-opportunity" as const } },
        { turn: 4, roles: { [B]: "coplayer" as const }, verdicts: { [B]: "no-opportunity" as const } },
      ],
    }
    const expectedNotPerson = filed({ maxGroupSize: 4, rounds: [{ ownIndex: 0, members: group(A, B) }], fullReport: [["NotPerson"]] })
    expect(checkChainVotes("bot A", expectedNotPerson, bots, false, undefined, allNoOpportunity).status).toBe("pass")
    const wrongPerson = filed({ maxGroupSize: 4, rounds: [{ ownIndex: 0, members: group(A, B) }], fullReport: [["Person"]] })
    expect(checkChainVotes("bot A", wrongPerson, bots, false, undefined, allNoOpportunity).status).toBe("fail")
  })
})

describe("turns before the page played any turn are initial absence for every co-player (game 287: bot 6)", () => {
  // fixtures/bot6-unplayed-round.json: a late join whose page entered at the round change after turn 6, so its
  // timeline holds turns 7-12 only. Its three round-1 co-players appear in no row, and the (pre-#520) app filed them
  // NotPerson. Since #520 (late join wins) they never shared a turn with the latecomer and are expected Person.
  const g = JSON.parse(readFileSync(join(__dirname, "fixtures/bot6-unplayed-round.json"), "utf8")) as { self: string; report: FiledReport; turns: VideoRoleEvidence["turns"] }
  const roundTwo = new Set(g.report.rounds[1].members.map((m) => m.player))
  const roundOne = g.report.rounds[0].members.map((m) => m.player).filter((p) => p !== g.self && !roundTwo.has(p))
  it("the page played no turn of round 1, and no round-1 co-player appears in any row", () => {
    expect(Math.min(...g.turns.map((t) => t.turn))).toBe(7)
    expect(roundOne.map((p) => p.slice(0, 8)).sort()).toEqual(["5ENU9kDJ", "5FFrmp87", "5Fcrfviy"])
    for (const p of roundOne) expect(g.turns.some((t) => t.roles[p] !== undefined)).toBe(false)
  })
  it("they never shared a turn with the latecomer, so the late-join Person is expected and the recorded NotPerson fails (#520)", () => {
    const c = checkChainVotes("votes", g.report, [g.self], false, undefined, { turns: g.turns })
    expect(c.status, c.detail).toBe("fail")
    expect(c.detail).toMatch(/5\/8 round verdicts as expected/)
    for (const p of roundOne) expect(c.detail).toContain(`round 1 ${p.slice(0, 8)} (human)=NotPerson, expected Person`)
  })
  it("the report a #520 build files for them, Person, passes", () => {
    const fixed = { ...g.report, fullReport: [g.report.fullReport[0].map(() => "Person" as const), g.report.fullReport[1]] }
    const c = checkChainVotes("votes", fixed, [g.self], false, undefined, { turns: g.turns })
    expect(c.status, c.detail).toBe("pass")
    expect(c.detail).toMatch(/8\/8 round verdicts as expected/)
    expect(c.detail).toContain("never-shared (late join) expects Person (5FFrmp87, 5ENU9kDJ, 5Fcrfviy)")
  })
  it("a round-2 co-player the latecomer shared turns with but never saw still expects NotPerson (#445)", () => {
    const hidden = g.report.rounds[1].members.find((m) => m.player !== g.self && !g.report.rounds[0].members.some((r) => r.player === m.player))!.player
    const turns = g.turns.map((t) => (t.roles[hidden] === undefined ? t : { ...t, roles: { ...t.roles, [hidden]: "unseen" as const }, verdicts: { ...t.verdicts, [hidden]: "unseen" as const } }))
    const at = g.report.rounds[1].members.filter((m) => m.index !== g.report.rounds[1].ownIndex).sort((a, b) => a.index - b.index).findIndex((m) => m.player === hidden)
    const fullReport = [g.report.fullReport[0].map(() => "Person" as const), g.report.fullReport[1].map((v, i) => (i === at ? ("NotPerson" as const) : v))]
    const c = checkChainVotes("votes", { ...g.report, fullReport }, [g.self], false, undefined, { turns })
    expect(c.status, c.detail).toBe("pass")
    const wrong = checkChainVotes("votes", { ...g.report, fullReport: [fullReport[0], g.report.fullReport[1]] }, [g.self], false, undefined, { turns })
    expect(wrong.status).toBe("fail")
    expect(wrong.detail).toContain(`${hidden.slice(0, 8)} (human)=Person`)
  })
  it("a turn the bot's down window missed stays eligible, and its sealed NotPerson still counts", () => {
    const down = { missed: [1, 2, 3, 4, 5, 6], maxGroupSize: g.report.maxGroupSize ?? 6, windows: "test" }
    const c = checkChainVotes("votes", g.report, [g.self], false, down, { turns: g.turns })
    // eligible again: the down turns are sealed NotPerson, which is what was filed
    expect(c.detail).toMatch(/expected NotPerson, missed turns/)
  })
  it("a co-player with no row while the page WAS playing their turns stays eligible (a recorder hole is not absence)", () => {
    const shifted = g.turns.map((t) => ({ ...t, turn: t.turn - 6 }))
    const c = checkChainVotes("votes", g.report, [g.self], false, undefined, { turns: shifted })
    expect(c.status).toBe("fail")
  })
})

describe("a single recorder gap turn between non-Co-player rows is not eligible (game 409: bot 6)", () => {
  // g409 bot 6, a late joiner that played from turn 3 and hosted turn 4 itself. Turn 4 lasted about a second on the page
  // (intro-only rows), so the timeline has no row for it. The human co-player (H) read unseen at turns 3 and 5 and host at
  // 6: never Co-player, shared turns, never seen, so the app files NotPerson (#445, #520). The gap used to count as an
  // eligible Person vote and the oracle invented "expected Person". The excuse is bounded: ONE row-less turn, rows on both
  // adjacent turns of the same round, neither Co-player, no tap on H in it, no down window over it.
  const [X, Y, Z, W] = [B, C, "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty", "5FLSigC9HGRKVhB9FiEo4Y3koPsNmBmLJbpXg2mp1hXcPm9m"]
  const own = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY"
  const members = group(X, Y, Z, own, W, H)
  const one = (verdicts: FiledReport["fullReport"][number]) => filed({ who: own, rounds: [{ ownIndex: 3, members }], fullReport: [verdicts] })
  const two = (verdicts: FiledReport["fullReport"][number]) =>
    filed({ who: own, rounds: [{ ownIndex: 3, members }, { ownIndex: 3, members }], fullReport: [verdicts, verdicts] })
  const P5 = ["Person", "Person", "Person", "Person", "Person"] as FiledReport["fullReport"][number]
  const NP5 = ["Person", "Person", "Person", "Person", "NotPerson"] as FiledReport["fullReport"][number]
  // a row per turn in h (H's role there, plus the turn's verdict when given); the others read Co-player throughout
  const rows = (h: Record<number, "unseen" | "coplayer" | "host" | [("unseen" | "coplayer" | "host"), "no-opportunity"]>) => ({
    turns: Object.entries(h).map(([turn, v]) => {
      const [role, verdict] = Array.isArray(v) ? v : [v, undefined]
      return {
        turn: Number(turn),
        roles: { [X]: "coplayer" as const, [Y]: "coplayer" as const, [Z]: "coplayer" as const, [W]: "coplayer" as const, [H]: role },
        ...(verdict ? { verdicts: { [H]: verdict } } : {}),
      }
    }),
  })
  const run = (r: FiledReport, t: ReturnType<typeof rows>, down?: DownInfo) => checkChainVotes("g409 bot 6", r, [], false, down, t)
  const hGap = `${H.slice(0, 8)} (human)=NotPerson, expected Person`

  it("the game-409 shape expects NotPerson, and the filed NotPerson passes", () => {
    const c = run(one(NP5), rows({ 3: "unseen", 5: "unseen", 6: "host" }))
    expect(c.status, c.detail).toBe("pass")
    expect(c.detail).toContain("5/5 round verdicts as expected")
    expect(run(one(P5), rows({ 3: "unseen", 5: "unseen", 6: "host" })).status).toBe("fail")
  })
  it("a Co-player beside the gap keeps it eligible, and the gap vote decides the tally", () => {
    // turn 5 Person + turn 6 auto-rejected is 1P/1N (NotPerson) alone; the gap turn 4 makes it 2P/1N
    const t = rows({ 3: "unseen", 5: "coplayer", 6: ["coplayer", "no-opportunity"] })
    expect(run(one(NP5), t).detail).toContain(hGap)
    expect(run(one(P5), t).status).toBe("pass")
  })
  it("a two-turn gap stays eligible", () => {
    const t = rows({ 3: "unseen", 6: "unseen" })
    expect(run(one(NP5), t).detail).toContain(hGap)
  })
  it("a gap at a round boundary stays eligible", () => {
    const t = rows({ 3: "unseen", 5: "unseen", 6: "unseen", 8: "unseen", 9: "unseen" })
    expect(run(two(NP5), t).detail).toContain(hGap)
  })
  it("a tap on the player in the gap turn keeps it eligible", () => {
    const taps = [{ at: "2026-10-12T00:00:00Z", turn: 4, id: H, result: "ok", stage: "gameplay" }]
    const c = run(one(NP5), rows({ 3: "unseen", 5: "unseen", 6: "host" }), { missed: [], taps, maxGroupSize: 6, windows: "none" })
    expect(c.detail).toContain(hGap)
  })
  it("a trailing gap at the end of the timeline stays eligible", () => {
    const t = rows({ 3: "unseen", 4: "unseen" })
    expect(run(one(NP5), t).detail).toContain(hGap)
  })
  it("a down-window turn stays eligible and its sealed NotPerson counts (the app seals it)", () => {
    const t = rows({ 3: "host", 6: "unseen" })
    const down: DownInfo = { missed: [4, 5], maxGroupSize: 6, windows: "killed, relaunched" }
    const c = run(one(P5), t, down)
    expect(c.status).toBe("fail")
    expect(c.detail).toContain(`${H.slice(0, 8)} (human)=Person, expected NotPerson (missed turns 4, 5)`)
  })
})

describe("chainVoteTable", () => {
  it("a row per reporter and co-player, a column per round", () => {
    const r2 = filed({ who: B, rounds: [{ ownIndex: 0, members: group(B, A, C) }, { ownIndex: 0, members: group(B, H) }], fullReport: [["Person", "Person"], ["NotPerson"]] })
    const md = chainVoteTable([filed(), r2], { [A]: "eea", [B]: "eeb", [C]: "eec" })
    expect(md.split("\n")).toEqual([
      "| reporter | co-player | round 1 | round 2 |",
      "|---|---|---|---|",
      "| eea | eeb | Person | Person |",
      "| eea | eec | Person | Person |",
      "| eeb | eea | Person | · |",
      "| eeb | eec | Person | · |",
      "| eeb | 5CLy4fTa | · | NotPerson |",
    ])
  })
})

describe("bootSeatVerdict", () => {
  it("fails closed: no seat read is unknown, never free", () => {
    expect(bootSeatVerdict(undefined)).toBe("unknown")
    expect(bootSeatVerdict(null)).toBe("unknown")
    expect(bootSeatVerdict({ blockers: ["AlreadyRegistered"] })).toBe("registered")
    expect(bootSeatVerdict({ blockers: [] })).toBe("free")
  })
})

describe("a verdict only the unrecorded tail of a turn explains is open, not a failure (game 323: bot 6)", () => {
  // fixtures/bot6-unseen-tail.json: the late joiner filed 5CAgroLW NotPerson for round 1. The timeline shows it
  // Unseen through turn 4, hosting turn 5 and approved in turn 6, so 1P/0N expects Person. The app saw its first frame
  // in turn 4's last instant, after the recorder's last row, and sealed turn 4 NotPerson: 1P/1N, a tie, NotPerson.
  const g = JSON.parse(readFileSync(join(__dirname, "fixtures/bot6-unseen-tail.json"), "utf8")) as { self: string; report: FiledReport; turns: VideoRoleEvidence["turns"] }
  const TAIL = "5CAgroLWQcLAHu1UHyBdaWmGJATLmMZg2ato8uN6wVwNEt2k"
  const withoutTail = g.turns.map(({ unseenTail: _unseenTail, ...t }) => t)
  const flip = (player: string, to: "Person" | "NotPerson") => {
    const fullReport = g.report.rounds.map(({ ownIndex, members }, round) => {
      const others = [...members].sort((a, b) => a.index - b.index).filter((m) => m.index !== ownIndex)
      return g.report.fullReport[round].map((v, i) => (others[i].player === player ? to : v))
    })
    return { ...g.report, fullReport }
  }

  it("without the tail evidence it fails exactly as the run did", () => {
    const c = checkChainVotes("votes", g.report, [g.self], false, undefined, { turns: withoutTail })
    expect(c.status).toBe("fail")
    expect(c.detail).toContain("8/9 round verdicts as expected; round 1 5CAgroLW (human)=NotPerson, expected Person")
  })
  it("with it the NotPerson is open: inconclusive, and the detail says why", () => {
    const c = checkChainVotes("votes", g.report, [g.self], false, undefined, { turns: g.turns })
    expect(c.status, c.detail).toBe("inconclusive")
    expect(c.detail).toContain("5CAgroLW read Unseen in the last row of turn 4 and Co-player at the next row that tells")
  })
  it("the Person the timeline alone expects still passes", () => {
    const c = checkChainVotes("votes", flip(TAIL, "Person"), [g.self], false, undefined, { turns: g.turns })
    expect(c.status, c.detail).toBe("pass")
  })
  it("any other mismatch beside it still fails: the tail excuses only the verdict it explains", () => {
    const c = checkChainVotes("votes", flip("5EE2TJKas8eMUdt8DGSibrTxFoVtrqghuxbks3bMf5boDb5C", "NotPerson"), [g.self], false, undefined, { turns: g.turns })
    expect(c.status).toBe("fail")
    expect(c.detail).toContain("5EE2TJKa (human)=NotPerson")
  })
  it("a tail that cannot change the majority leaves the mismatch firm", () => {
    // 5EE2TJKa was approved in turns 4, 5 and 6: with turn 4 read as a sealed tail it is still 2P/1N, Person
    const other = "5EE2TJKas8eMUdt8DGSibrTxFoVtrqghuxbks3bMf5boDb5C"
    const turns = g.turns.map((t) => (t.turn === 4 ? { ...t, unseenTail: [...(t.unseenTail ?? []), other] } : t))
    const c = checkChainVotes("votes", flip(other, "NotPerson"), [g.self], false, undefined, { turns })
    expect(c.status).toBe("fail")
    expect(c.detail).toContain("5EE2TJKa (human)=NotPerson")
  })
})

describe("a verdict only a host's hidden first frame explains is open, not a failure (game 327: bot 27)", () => {
  // fixtures/bot27-hosted-first-frame.json: the late joiner filed 5EFNJJ8n (bot 29) Person for round 1. The timeline
  // shows it Unseen through turn 5 and Host in turn 6, its only eligible turn, which takes no vote: 0P/0N, never seen,
  // NotPerson expected. The app saw its first frame inside turn 6 (a Host tile hides it) and filed the default Person.
  const g = JSON.parse(readFileSync(join(__dirname, "fixtures/bot27-hosted-first-frame.json"), "utf8")) as { self: string; report: FiledReport; turns: VideoRoleEvidence["turns"] }
  const HOST = "5EFNJJ8nPaQP7D8REQctLx19LhyjQu2LeHAQHfw1pnMH8vKS"
  const withoutHosted = g.turns.map(({ hostedFirstFrame: _hosted, ...t }) => t)
  const flip = (player: string, to: "Person" | "NotPerson") => {
    const fullReport = g.report.rounds.map(({ ownIndex, members }, round) => {
      const others = [...members].sort((a, b) => a.index - b.index).filter((m) => m.index !== ownIndex)
      return g.report.fullReport[round].map((v, i) => (others[i].player === player ? to : v))
    })
    return { ...g.report, fullReport }
  }

  it("without the hosted-arrival evidence it fails exactly as the run did", () => {
    const c = checkChainVotes("votes", g.report, [g.self], false, undefined, { turns: withoutHosted })
    expect(c.status).toBe("fail")
    expect(c.detail).toContain("9/10 round verdicts as expected; round 1 5EFNJJ8n (human)=Person, expected NotPerson")
  })
  it("with it the Person is open: inconclusive, and the detail says why", () => {
    const c = checkChainVotes("votes", g.report, [g.self], false, undefined, { turns: g.turns })
    expect(c.status, c.detail).toBe("inconclusive")
    expect(c.detail).toContain("5EFNJJ8n read Unseen before turn 6 and Co-player right after")
  })
  it("names the Unseen read when the page showed the host before, and the absence when it did not", () => {
    const absent = g.turns.map((t) => (t.hostedFirstFrame?.includes(HOST) ? { ...t, hostedAbsentBefore: [HOST] } : t))
    const c = checkChainVotes("votes", g.report, [g.self], false, undefined, { turns: absent })
    expect(c.detail).toContain("5EFNJJ8n not shown before turn 6 and Co-player right after")
    expect(c.detail).not.toContain("5EFNJJ8n read Unseen before")
  })
  it("the NotPerson the never-seen reading expects still passes", () => {
    const c = checkChainVotes("votes", flip(HOST, "NotPerson"), [g.self], false, undefined, { turns: g.turns })
    expect(c.status, c.detail).toBe("pass")
  })
  it("any other mismatch beside it still fails", () => {
    const c = checkChainVotes("votes", flip("5EE2TJKas8eMUdt8DGSibrTxFoVtrqghuxbks3bMf5boDb5C", "NotPerson"), [g.self], false, undefined, { turns: g.turns })
    expect(c.status).toBe("fail")
    expect(c.detail).toContain("5EE2TJKa (human)=NotPerson")
  })
  it("a host that also has votable turns is judged on those: the hosted reading excuses nothing", () => {
    // 5HjBMBes hosted turn 4 after reading Unseen in turn 3, but it was approved in turns 5 and 6: Person
    const c = checkChainVotes("votes", flip("5HjBMBesAzNXXGxLDFyu8zA4ybHuPnakRN5etiES4vxzWRSW", "NotPerson"), [g.self], false, undefined, { turns: g.turns })
    expect(c.status).toBe("fail")
    expect(c.detail).toContain("5HjBMBes (human)=NotPerson")
  })
})
