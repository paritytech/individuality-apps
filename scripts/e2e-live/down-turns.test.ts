// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { checkChainVotes, type FiledReport } from "./chain-checks"
import { downTurns, downWindows, expectedVerdicts, missedTurns, tapEvidence, votableIn, type DownInfo } from "./down-turns"
import { VOTABLE_STAGES, landedResult, parseTaps, type TapRecord, type TickRow } from "./record"
import type { RoleAction } from "./role-proof"

interface Fixture {
  maxGroupSize: number
  rows: TickRow[]
  acts: RoleAction[]
  report: FiledReport
  /** the bot's own taps-N.log, where the fixture has one */
  taps?: TapRecord[]
}
const load = (name: string): Fixture => JSON.parse(readFileSync(join(__dirname, "fixtures", name), "utf8"))
// game 194 as it played: bot 5 killed in turn 8 and relaunched in turn 11; bot 10's host killed for 2.5 s in turn 8
const BOT5 = load("bot5-down.json")
const BOT10 = load("bot10-hostcrash.json")
const GQO = "5GM6acWtRvK94BYHt5nf7jMjDuAu36FjDnot71z1aa97Fuo1"
const ECS = "5Dx3i9TAy3ebb4B7d7mP3MJKRa3JSVEACohrv3yASamr2pq5"

describe("downWindows", () => {
  it("pairs each kill with its relaunch, and a host kill with its restart", () => {
    // bot 5 also hid after the confirm stage (its background act): a blind window after the last turn, which misses nothing (below)
    expect(downWindows(BOT5.acts)).toEqual([
      { from: "2026-10-04T17:56:39.181Z", to: "2026-10-04T17:57:26.761Z", what: "killed, relaunched" },
      { from: "2026-10-04T17:57:47.609Z", to: "2026-10-04T17:58:23.415Z", what: "hidden, visible", blind: true },
    ])
    expect(downWindows(BOT10.acts)).toEqual([{ from: "2026-10-04T17:56:38.776Z", to: "2026-10-04T17:56:41.286Z", what: "host-killed, host-restarted" }])
  })
  it("a kill that never relaunched is open-ended; acts of other kinds are no window", () => {
    const acts: RoleAction[] = [
      { id: "confirm-tap", at: "2026-10-04T17:00:00.000Z", detail: "" },
      { id: "killed", at: "2026-10-04T17:00:01.000Z", detail: "" },
    ]
    expect(downWindows(acts)).toEqual([{ from: "2026-10-04T17:00:01.000Z", to: null, what: "killed, relaunched" }])
  })
})

describe("missedTurns (the turns no frame of the bot's timeline shows it playing)", () => {
  it("game 194 bot 5: killed in turn 8's intro, back in turn 11: turns 8, 9 and 10 were missed", () => {
    expect(missedTurns(BOT5.rows, downWindows(BOT5.acts), 12)).toEqual([8, 9, 10])
  })
  it("game 194 bot 10: the host was down for 2.5 s but the page kept playing every turn: nothing missed", () => {
    expect(missedTurns(BOT10.rows, downWindows(BOT10.acts), 12)).toEqual([])
  })
  it("no window, nothing missed (a gap in the frames alone is never an excuse)", () => {
    expect(missedTurns(BOT5.rows, [], 12)).toEqual([])
  })
  it("a kill that never came back misses every turn to the end", () => {
    const rows: TickRow[] = [
      { t: "2026-10-04T17:00:00.000Z", stage: "play", turn: 1 },
      { t: "2026-10-04T17:00:05.000Z", stage: "play", turn: 2 },
    ]
    expect(missedTurns(rows, [{ from: "2026-10-04T17:00:06.000Z", to: null, what: "killed, relaunched" }], 4)).toEqual([3, 4])
  })
})

describe("expectedVerdicts (the app's own rule: a turn missed is sealed NotPerson, the verdict is the strict majority)", () => {
  const exp = expectedVerdicts(BOT5.report, BOT5.maxGroupSize, [8, 9, 10])
  it("5GM6acWt: Person on turns 7 and 12, NotPerson on 8, 9 and 10 (turn 11 is its own): NotPerson", () => {
    expect(exp.get(GQO)).toEqual({ verdict: "NotPerson", person: 2, notPerson: 3, missedTurns: [8, 9, 10] })
  })
  it("5Dx3i9TA hosts turn 8, so only 9 and 10 cost it: 3 against 2 is still Person", () => {
    expect(exp.get(ECS)).toEqual({ verdict: "Person", person: 3, notPerson: 2, missedTurns: [9, 10] })
  })
  it("a co-player of round 1 alone, met before the kill, stays Person", () => {
    const gkf = BOT5.report.rounds[0].members.find((m) => m.index === 5)!.player
    expect(exp.get(gkf)).toMatchObject({ verdict: "Person", notPerson: 0, missedTurns: [] })
  })
  it("a tie is a reject", () => {
    // two votable turns in a one-round game of three seats: miss one of them
    const report: FiledReport = { who: "me", block: 1, extrinsic: 0, rounds: [{ ownIndex: 0, members: [{ index: 0, player: "me" }, { index: 1, player: "a" }, { index: 2, player: "b" }] }], fullReport: [["Person", "Person"]] }
    // turns: 1 me, 2 a, 3 b. "a" is votable on turns 1 and 3
    expect(expectedVerdicts(report, 3, [3]).get("a")).toEqual({ verdict: "NotPerson", person: 1, notPerson: 1, missedTurns: [3] })
    expect(expectedVerdicts(report, 3, []).get("a")?.verdict).toBe("Person")
  })
  it("a missed turn the co-player hosts costs nothing", () => {
    expect(expectedVerdicts(BOT5.report, BOT5.maxGroupSize, [11]).get(GQO)).toMatchObject({ verdict: "Person", missedTurns: [] })
  })
})

describe("checkChainVotes with a role that was down", () => {
  const down = (missed: number[]): DownInfo => ({ missed, maxGroupSize: BOT5.maxGroupSize, windows: "killed 17:56:39, relaunched 17:57:26 (CEST)" })
  const bots: string[] = []
  it("game 194 bot 5 as it filed: NotPerson on 5GM6acWt is what the missed turns decide, so it PASSES, and says which turns", () => {
    const c = checkChainVotes("player 5", BOT5.report, bots, false, down([8, 9, 10]))
    expect(c.status).toBe("pass")
    expect(c.detail).toContain("missed turns 8, 9, 10")
    expect(c.detail).toContain("5GM6acWt")
  })
  it("the same report with nothing down still FAILS, as it did", () => {
    expect(checkChainVotes("player 5", BOT5.report, bots, false).status).toBe("fail")
    expect(checkChainVotes("player 5", BOT5.report, bots, false, down([])).status).toBe("fail")
  })
  it("a Person filed where the missed turns decide NotPerson FAILS, naming the turns", () => {
    const allPerson: FiledReport = { ...BOT5.report, fullReport: BOT5.report.fullReport.map((r) => r.map(() => "Person")) }
    const c = checkChainVotes("player 5", allPerson, bots, false, down([8, 9, 10]))
    expect(c.status).toBe("fail")
    expect(c.detail).toMatch(/5GM6acWt.*expected NotPerson.*missed turns 8, 9, 10/)
  })
  it("a NotPerson on someone the missed turns do not decide FAILS", () => {
    const hurt: FiledReport = { ...BOT5.report, fullReport: [["NotPerson", "Person", "Person", "Person"], BOT5.report.fullReport[1]] }
    const c = checkChainVotes("player 5", hurt, bots, false, down([8, 9, 10]))
    expect(c.status).toBe("fail")
    expect(c.detail).toContain("expected Person")
  })
  it("bot 10 (host crash, nothing missed) is held to all-Person as before", () => {
    expect(checkChainVotes("player 10", BOT10.report, bots, false, down(missedTurns(BOT10.rows, downWindows(BOT10.acts), 12))).status).toBe("pass")
  })
})

describe("windows the page lived through (reload, hidden, frozen)", () => {
  const T = (s: number) => new Date(Date.UTC(2026, 9, 4, 17, 0, s)).toISOString()
  // a turn a 12 s beat: turn n is in play from 12(n-1)+2 to 12(n-1)+10
  const frames = (from: number, to: number): TickRow[] => {
    const out: TickRow[] = []
    for (let s = from; s <= to; s += 2) out.push({ t: T(s), stage: s % 12 < 2 ? "intro" : s % 12 < 10 ? "play" : "other", turn: Math.floor(s / 12) + 1 })
    return out
  }
  it("a reload is a window like a kill; hidden and frozen are BLIND (the page drew turns the bot could not tap)", () => {
    const acts: RoleAction[] = [
      { id: "reloading", at: T(1), detail: "" },
      { id: "reloaded", at: T(5), detail: "" },
      { id: "hidden", at: T(10), detail: "" },
      { id: "visible", at: T(20), detail: "" },
      { id: "frozen", at: T(30), detail: "" },
      { id: "thawed", at: T(40), detail: "" },
    ]
    expect(downWindows(acts)).toEqual([
      { from: T(1), to: T(5), what: "reloading, reloaded" },
      { from: T(10), to: T(20), what: "hidden, visible", blind: true },
      { from: T(30), to: T(40), what: "frozen, thawed", blind: true },
    ])
  })
  it("hidden from turn 5 to turn 7: turns 5 and 6 were missed although the page kept drawing them", () => {
    const rows = frames(0, 95)
    const w = downWindows([
      { id: "hidden", at: T(48), detail: "at game turn 5 (intro)" },
      { id: "visible", at: T(72), detail: "at game turn 7 (intro)" },
    ])
    expect(missedTurns(rows, w, 12)).toEqual([5, 6])
  })
  it("a frozen page draws nothing; the frame read as it thaws is stamped inside the window and proves nothing", () => {
    const rows = [...frames(0, 98), ...frames(120, 140)]
    rows.push({ t: T(105), stage: "play", turn: 9 })
    rows.sort((a, b) => ((a.t ?? "") < (b.t ?? "") ? -1 : 1))
    const w = downWindows([
      { id: "frozen", at: T(99), detail: "at turn 9 (play)" },
      { id: "thawed", at: T(120), detail: "" },
    ])
    // turn 9 was played before the freeze; 10 never showed in play outside it
    expect(missedTurns(rows, w, 12)).toEqual([10])
  })
  it("a hide after the last turn (the background role) misses nothing", () => {
    const rows = [...frames(0, 143), { t: T(150), stage: "confirm" as const, turn: null }]
    expect(missedTurns(rows, downWindows([{ id: "hidden", at: T(146), detail: "" }, { id: "visible", at: T(155), detail: "" }]), 12)).toEqual([])
  })
})

describe("a healthy bot's check covers only the votes IT filed", () => {
  it("a disrupted co-player's own missed turns cannot fail it: no window, every co-player Person, whatever the others did", () => {
    // BOT10's report as filed: every co-player Person. Its check reads its own report alone, never the co-players' reports,
    // so a co-player that froze, hid or reloaded (and was charged NotPerson by others) changes nothing here
    const check = checkChainVotes("healthy", BOT10.report, [], false)
    expect(check.status).toBe("pass")
    // the same report checked against a disrupted bot's windows is the disrupted bot's business only
    expect(checkChainVotes("healthy", BOT10.report, [], false, undefined).detail).not.toMatch(/down/)
  })
})

// previewnet game 57 (a live run), bot 5 (kill-background): killed in turn 8, relaunched into turn 11 (the app's 0-based turn
// 10) four seconds before it sealed. The harness clicked four tiles in it, all "ok", but only the first landed in the gameplay
// stage: the click that came back after 1.6 s on the cold page held the pass, and the other three went out in the ending stage,
// where the auto-reject flash is turning the tiles. The app auto-rejected them, so FWKAbZ4 and HmsLeob came out 2P/3N.
// The fixture's stage stamps are derived after the fact (see its stampsDerived): the run predates data-stage.
describe("what the bot actually tapped (game 57 bot 5, #351 and #399)", () => {
  const G57 = load("bot5-rejoin.json")
  const FWK = "5EfCujEZFXU8687YFLVXvzXD5d2M5XdW9TvbbFMik4LWcMXX"
  const FLB = "5ENU9kDJncCMuK64pTy4cPTvAePChT22bf5tjhLLYUfD7Ku7"
  const HMS = "5HmAJrrZ4mcRE22SCgt93QmY4TMzKwbDU2tf3xoQtkcAMbyL"
  const CWK = "5CigJEmwxWTHagtc5mcdaAa8s2M38xSNPDFvPyiQU4LwJQuE"
  const CAM = "5CBLSmZyQaF3J9fckgFxRnRHQ5iyhzskk1rj7LxBahqqkdv5"
  const taps = G57.taps!
  const missed = missedTurns(G57.rows, downWindows(G57.acts), 12)
  const filed = Object.fromEntries(G57.report.rounds[1].members.filter((m) => m.index !== G57.report.rounds[1].ownIndex).map((m, i) => [m.player, G57.report.fullReport[1][i]]))
  it("the missed turns are still 8, 9 and 10; turn 11 was shown, so it was played", () => {
    expect(missed).toEqual([8, 9, 10])
  })
  it("turn 11: four votable co-players, the host (CwKodoH) is none of them", () => {
    expect(votableIn(G57.report, G57.maxGroupSize, 11).sort()).toEqual([CAM, FWK, FLB, HMS].sort())
  })
  it("gives exactly the verdicts the app filed: only CaMvWsj counts as tapped in turn 11", () => {
    const exp = expectedVerdicts(G57.report, G57.maxGroupSize, missed, taps)
    expect(exp.get(FWK)).toMatchObject({ verdict: "NotPerson", person: 2, notPerson: 3, untappedTurns: [11] })
    expect(exp.get(HMS)).toMatchObject({ verdict: "NotPerson", person: 2, notPerson: 3, untappedTurns: [11] })
    expect(exp.get(CWK)).toMatchObject({ verdict: "NotPerson", person: 2, notPerson: 3 })
    expect(exp.get(CWK)?.untappedTurns).toBeUndefined()
    expect(exp.get(CAM)?.untappedTurns).toBeUndefined()
    for (const a of [CAM, FWK, FLB, HMS, CWK]) expect(exp.get(a)?.verdict, a.slice(0, 8)).toBe(filed[a])
  })
  it("without the tap log it is the old all-Person turn, which is the bug", () => {
    expect(expectedVerdicts(G57.report, G57.maxGroupSize, missed).get(FWK)?.verdict).toBe("Person")
  })
  it("only an ok tap stamped a votable stage of that turn counts (introduction or gameplay): ending, another turn, a skip and a failed click do not", () => {
    const base = { at: "2026-10-06T08:02:25.000Z", turn: 11, id: FWK, result: "ok", stage: "gameplay" }
    const verdict = (tap: TapRecord) => expectedVerdicts(G57.report, G57.maxGroupSize, missed, [...taps.filter((t) => t.id !== FWK || t.turn !== 11), tap]).get(FWK)?.verdict
    expect(verdict(base)).toBe("Person")
    expect(verdict({ ...base, stage: "ending" })).toBe("NotPerson")
    // the app records an intro tap for the new turn (voteFor has no stage check; game 61's tap-storm regression, #398)
    expect(verdict({ ...base, stage: "introduction" })).toBe("Person")
    expect(verdict({ ...base, turn: 12 })).toBe("NotPerson")
    expect(verdict({ ...base, result: "skipped: page showed ending, turn 11" })).toBe("NotPerson")
    expect(verdict({ ...base, result: "error: click timeout" })).toBe("NotPerson")
  })
  it("tapEvidence: none, unstamped (a build before data-stage) and stamped", () => {
    expect(tapEvidence(undefined)).toBe("none")
    expect(tapEvidence([])).toBe("none")
    expect(tapEvidence(taps.map((t) => ({ ...t, stage: undefined })))).toBe("unstamped")
    expect(tapEvidence(taps.map((t) => ({ ...t, stage: "unknown" })))).toBe("unstamped")
    expect(tapEvidence(taps)).toBe("stamped")
  })
  it("checkChainVotes PASSES the report as filed and names the missed turns and the untapped one", () => {
    const down: DownInfo = { missed, taps, maxGroupSize: G57.maxGroupSize, windows: "killed 08:01:38, relaunched 08:02:23" }
    const c = checkChainVotes("player 5", G57.report, [], false, down)
    expect(c.status).toBe("pass")
    expect(c.detail).toContain("missed turns 8, 9, 10")
    expect(c.detail).toContain("untapped in turn 11")
  })
  it("a log with no stamps is not guessed at: the tap check is skipped and the check says so", () => {
    const unstamped = taps.map((t) => ({ ...t, stage: undefined }))
    const c = checkChainVotes("player 5", G57.report, [], false, { missed, taps: unstamped, maxGroupSize: G57.maxGroupSize, windows: "killed, relaunched" })
    expect(c.detail).toContain("taps unstamped: build predates data-stage, tap check skipped")
    expect(c.detail).not.toContain("untapped in turn")
    // game 57 on a build without data-stage: the rejoined turn's late clicks look like play, so the mismatch is no
    // evidence against the app; inconclusive, never a fail (the old guess failed this exact bot, #351)
    expect(c.status).toBe("inconclusive")
  })
  it("a bot that never went down is still judged: no down info means a mismatch fails", () => {
    const c = checkChainVotes("player 5", G57.report, [], false, undefined)
    expect(c.status).toBe("fail")
  })
  it("with stamped taps and no missed turn the oracle still opens: a turn with no tap at all is untapped, whatever the windows say", () => {
    const c = checkChainVotes("player 5", G57.report, [], false, { missed: [], taps, maxGroupSize: G57.maxGroupSize, windows: "reloading, reloaded" })
    expect(c.status).toBe("pass")
    expect(c.detail).toContain("untapped in turn 9, 10, 11")
  })
})

describe("a late tap (the click returned after the page had left gameplay of its turn)", () => {
  const G57 = load("bot5-rejoin.json")
  const FWK = "5EfCujEZFXU8687YFLVXvzXD5d2M5XdW9TvbbFMik4LWcMXX"
  const FLB = "5ENU9kDJncCMuK64pTy4cPTvAePChT22bf5tjhLLYUfD7Ku7"
  const missed = [8, 9, 10]
  const down = (taps: TapRecord[]): DownInfo => ({ missed, taps, maxGroupSize: G57.maxGroupSize, windows: "killed, relaunched" })
  // FWKAbZ4's turn-11 tap came back in the ending flip: it is "late", no longer an ok gameplay tap
  const lateFwk = G57.taps!.map((t) => (t.id === FWK && t.turn === 11 ? { ...t, result: "late: ending, turn 11", stage: "gameplay" } : t))
  it("is inconclusive on that co-player, whichever verdict was filed, and the detail names it", () => {
    const asFiled = checkChainVotes("player 5", G57.report, [], false, down(lateFwk))
    expect(asFiled.status).toBe("pass")
    expect(asFiled.detail).toContain("late tap on 5EfCujEZ in turn 11 (landed in ending)")
    // had the app counted the tap, FWKAbZ4 would be Person: the oracle takes no side
    const person = { ...G57.report, fullReport: G57.report.fullReport.map((r, i) => (i === 1 ? ["Person", ...r.slice(1)] : r)) }
    const c = checkChainVotes("player 5", person, [], false, down(lateFwk))
    expect(c.status).toBe("inconclusive")
    expect(c.detail).toContain("late tap on 5EfCujEZ")
  })
  it("a mismatch on another co-player still fails", () => {
    const both = { ...G57.report, fullReport: G57.report.fullReport.map((r, i) => (i === 1 ? ["Person", "NotPerson", ...r.slice(2)] : r)) }
    expect(both.fullReport[1][1]).toBe("NotPerson")
    expect(G57.report.rounds[1].members.filter((m) => m.index !== G57.report.rounds[1].ownIndex)[1].player).toBe(FLB)
    expect(checkChainVotes("player 5", both, [], false, down(lateFwk)).status).toBe("fail")
  })
})

describe("parseTaps", () => {
  it("a torn last line drops only itself", () => {
    const good = '{"at":"2026-10-06T08:00:00.000Z","turn":1,"id":"a","result":"ok","stage":"gameplay"}'
    expect(parseTaps(`${good}\n${good}\n{"at":"2026-10-06T08:00:0`)).toHaveLength(2)
  })
})

describe("VOTABLE_STAGES (the per-click guard and the oracle read the same set)", () => {
  it("introduction and gameplay take a tap; ending, none and unknown do not (game 61: holding taps to gameplay pushed the tap-storm settle past play)", () => {
    for (const s of ["introduction", "gameplay"]) expect(VOTABLE_STAGES.has(s)).toBe(true)
    for (const s of ["ending", "none", "unknown", "confirm"]) expect(VOTABLE_STAGES.has(s)).toBe(false)
  })
})

describe("landedResult (the late check after a click returns)", () => {
  it("an intro click that returns in gameplay of the same turn is ok; one that returns in ending, another turn or unread is late", () => {
    const intro = { stage: "introduction", turn: 3 }
    expect(landedResult(intro, { stage: "gameplay", turn: 3 })).toBe("ok")
    expect(landedResult(intro, { stage: "introduction", turn: 3 })).toBe("ok")
    expect(landedResult({ stage: "gameplay", turn: 3 }, { stage: "ending", turn: 3 })).toBe("late: ending, turn 3")
    expect(landedResult({ stage: "gameplay", turn: 3 }, { stage: "introduction", turn: 4 })).toBe("late: introduction, turn 4")
    expect(landedResult({ stage: "gameplay", turn: 3 }, { stage: "none", turn: 3 })).toBe("late: none, turn 3")
    expect(landedResult({ stage: "gameplay", turn: 3 }, null)).toBe("late: unknown, turn unknown")
  })
})

// game 190 (a live run, attempt 1): three down-and-back personas flagged on the turn their page was recovering (#499)
describe("downTurns (a down window and the one recovery turn after it) on game 190's real timelines", () => {
  // act times are the ms role-action rows of each bot's tiles-N.jsonl
  const cases: [string, number[], number][] = [
    // killed in turn 8, relaunched, first frame turn 9 (missed turn 8); flagged turn 9. Its confirm-stage hide/show pair
    // (22:22:42, after the last play frame: turn 12 was played in full) adds nothing.
    ["bot2-kill-background.json", [8, 9], 9],
    // host killed in turn 8, back in turn 9, the reopened page's first frame is turn 10: nothing missed; flagged turn 10
    ["bot12-host-crash-long.json", [8, 9, 10], 10],
    // JS frozen 20 s from turn 9: nothing missed; flagged turn 10
    ["bot14-visible-freeze.json", [9, 10], 10],
  ]
  for (const [file, band, flagged] of cases)
    it(`${file}: the band is exactly turns ${band.join(", ")}, covering the flagged turn ${flagged}`, () => {
      const f = load(file)
      const w = downWindows(f.acts)
      expect(w.length).toBeGreaterThan(0)
      expect(downTurns(f.rows, w, 12)).toEqual(band)
      expect(band).toContain(flagged)
    })
  it("bot 2's confirm-stage hide opens after the last play frame and adds no turn", () => {
    const f = load("bot2-kill-background.json")
    const w = downWindows(f.acts)
    expect(w.map((x) => x.what)).toEqual(["killed, relaunched", "hidden, visible"])
    expect(downTurns(f.rows, [w[1]], 12)).toEqual([])
    expect(downTurns(f.rows, [w[0]], 12)).toEqual([8, 9])
  })
  it("bot 12 and bot 14 missed no turn, yet both had a window", () => {
    for (const file of ["bot12-host-crash-long.json", "bot14-visible-freeze.json"]) {
      const f = load(file)
      expect(missedTurns(f.rows, downWindows(f.acts), 12)).toEqual([])
    }
    const b2 = load("bot2-kill-background.json")
    expect(missedTurns(b2.rows, downWindows(b2.acts), 12)).toEqual([8])
  })
  it("no window, no down turns; a window that never closed runs to the last turn", () => {
    const f = load("bot14-visible-freeze.json")
    expect(downTurns(f.rows, [], 12)).toEqual([])
    expect(downTurns(f.rows, [{ from: "2026-10-08T22:21:52.000Z", to: null, what: "killed, relaunched" }], 12)).toEqual([9, 10, 11, 12])
  })
})
