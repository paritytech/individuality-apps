// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import type { NetworkCallRun } from "./network"
import { gameEndAt, TURN_S, turnStartS } from "./roles"
import { profileByName } from "./profile"
import { TILE_DROP_LAG_MS, accumulateWatchedClock, chainSecondAt, freshestAnchor, linkRecovery, readingAnchor, regroupWallMs, selectWatchedAnchor, switchPlanOf, turnAtChainSecond, verifySwitch, watchedClockAnchor, type SwitchEvidence, type SwitchRow } from "./switch-proof"

// The synthetic switch: a turn-6 cut in an EIGHT-seat game, so the cut sits mid-round (the round ends at 96 s) and the tiles
// can show it. In a six-seat game turn 6 is the round's last, and the round change meets the cut first (the real games below).
const GAME = { gameAt: 1_791_631_200, rounds: 2, maxGroupSize: 6 }
const GAME8 = { ...GAME, maxGroupSize: 8 }
const T0 = Date.parse("2026-10-10T11:20:00.000Z")
const ANCHOR = { chainNowS: GAME.gameAt, wallNowMs: T0 }
const at = (sinceGameS: number): number => T0 + sinceGameS * 1000
const run = (step: number, call: NetworkCallRun["call"], startS: number, endS: number, o: Partial<NetworkCallRun> = {}): NetworkCallRun => ({ step, call, startMs: at(startS), endMs: at(endS), ok: true, inconclusive: false, ...o })
// one frame at `s` s into the game; each tile is [id, text] (a Co-player)
const row = (s: number, ...tiles: [string, string][]): SwitchRow => ({ snapshotAt: new Date(at(s)).toISOString(), tiles: tiles.map(([id, text]) => ({ id, role: "coplayer", text })) })
const ROWS: SwitchRow[] = [row(55, ["a", ""], ["b", ""]), row(66, ["a", ""], ["b", ""]), row(80, ["a", "Connecting"], ["b", "Connecting"]), row(90, ["a", "Connecting…"], ["b", ""]), row(96, ["a", ""], ["b", ""])]
const EV: SwitchEvidence = {
  plan: { step: 1, atTurn: 6, blackoutS: 15 },
  live: true,
  runs: [run(1, ["swap", "lte-good"], 67.55, 67.68), run(1, ["blackout", "15"], 67.68, 91.2)],
  pageTurn: 6,
  appClock: { nowMs: (GAME8.gameAt + 67) * 1000, nowSeconds: GAME8.gameAt + 67, offset: -7, block: 1, readAtMs: at(67) },
  anchor: ANCHOR,
  game: GAME8,
  rows: ROWS,
  gameEndMs: at(200),
}
const statuses = (e: SwitchEvidence) => verifySwitch(4, e).map((c) => c.status)

describe("the turn on the chain clock", () => {
  it("maps a chain second to its turn and the seconds into it, with the round gap", () => {
    expect(turnAtChainSecond(GAME, GAME.gameAt + 67.55)).toMatchObject({ turn: 6, inGap: false })
    expect(turnAtChainSecond(GAME, GAME.gameAt + 67.55).intoS).toBeCloseTo(7.55)
    expect(turnAtChainSecond(GAME, GAME.gameAt - 5)).toMatchObject({ turn: 0 })
    // the first turn of round 2 starts after round 1's six turns AND the gap (turnStartS owns the gap)
    expect(turnAtChainSecond(GAME, GAME.gameAt + turnStartS(GAME, 7)).turn).toBe(7)
    expect(turnStartS(GAME, 7)).toBeGreaterThan(6 * TURN_S)
  })
  it("chainSecondAt walks the anchor by the wall", () => {
    expect(chainSecondAt(T0 + 10_000, ANCHOR)).toBe(GAME.gameAt + 10)
  })
  it("anchors at read end so query error is stale-only, and drops invalid or long reads", () => {
    expect(readingAnchor(1000, 1500, 77)).toEqual({ chainNowS: 77, wallNowMs: 1500 })
    expect(readingAnchor(1000, 1500, 77, "watch")).toEqual({ chainNowS: 77, wallNowMs: 1500, source: "watch", readSpanMs: 500 })
    expect(readingAnchor(1000, 1500, undefined)).toBeNull()
    expect(readingAnchor(1000, 3001, 77)).toBeNull()
  })
  it("keeps the freshest repeated best-block offset, not merely the newest read", () => {
    const stale = { chainNowS: 80, wallNowMs: 100_000 }
    const fresh = { chainNowS: 95, wallNowMs: 108_000 }
    const repeated = { chainNowS: 95, wallNowMs: 114_000 }
    expect(freshestAnchor([stale, fresh, repeated])).toEqual(fresh)
    expect(freshestAnchor([null, stale])).toEqual(stale)
    expect(freshestAnchor([null])).toBeNull()
  })
  it("drops the subprocess seed when the first valid watch sample arrives", () => {
    const biasedSeed = { chainNowS: 100, wallNowMs: 100_000, source: "seed" as const, readSpanMs: 100 }
    const watch = { chainNowS: 94, wallNowMs: 100_000, source: "watch" as const, readSpanMs: 200 }
    expect(selectWatchedAnchor(biasedSeed, watch, 1)).toEqual({ ...watch, sampleCount: 1 })
    const fresherWatch = { chainNowS: 96, wallNowMs: 101_000, source: "watch" as const, readSpanMs: 150 }
    expect(selectWatchedAnchor(watch, fresherWatch, 2)).toEqual({ ...fresherWatch, sampleCount: 2 })
  })
  it("decodes only complete finite samples from the watch's mixed stderr", () => {
    expect(watchedClockAnchor('CLOCK {"readStartMs":1000,"readEndMs":1500,"chainBestNow":77}')).toEqual({ chainNowS: 77, wallNowMs: 1500, source: "watch", readSpanMs: 500 })
    expect(watchedClockAnchor("EVENT GameEnded #1")).toBeNull()
    expect(watchedClockAnchor('CLOCK {"readStartMs":5000,"readEndMs":1000,"chainBestNow":77}')).toBeNull()
    expect(watchedClockAnchor('CLOCK {"readStartMs":1000}')).toBeNull()
    expect(watchedClockAnchor("CLOCK nope")).toBeNull()
  })
  it("drops a long-span sample whose midpoint would beat the honest stale-only anchor", () => {
    const honest = watchedClockAnchor('CLOCK {"readStartMs":100000,"readEndMs":100500,"chainBestNow":95}')
    const stalled = watchedClockAnchor('CLOCK {"readStartMs":100000,"readEndMs":120000,"chainBestNow":115}')
    expect(honest).not.toBeNull()
    expect(stalled).toBeNull()
    expect(freshestAnchor([honest, stalled])).toEqual(honest)
    // The rejected midpoint would have been +5 s off the wall, fresher-looking than honest's -5.5 s.
    expect(115 - (100000 + 120000) / 2 / 1000).toBe(5)
  })
  it("accumulates split and coalesced stderr lines while retaining a trailing partial", () => {
    const one = 'CLOCK {"readStartMs":1000,"readEndMs":1500,"chainBestNow":77}\n'
    const two = 'CLOCK {"readStartMs":2000,"readEndMs":2200,"chainBestNow":78}\n'
    const split = accumulateWatchedClock("", one.slice(0, 24))
    expect(split).toEqual({ tail: one.slice(0, 24), anchors: [] })
    const joined = accumulateWatchedClock(split.tail, `${one.slice(24)}${two}CLOCK {`)
    expect(joined.tail).toBe("CLOCK {")
    expect(joined.anchors).toHaveLength(2)
    expect(joined.anchors.map((anchor) => anchor.chainNowS)).toEqual([77, 78])
    expect(accumulateWatchedClock(joined.tail, "").anchors).toEqual([])
  })
})

describe("verifySwitch", () => {
  it("a mid-round cut that drops and recovers passes all four", () => {
    expect(statuses(EV)).toEqual(["pass", "pass", "pass", "pass"])
  })
  it("a swap two turns late fails the turn check and only that one", () => {
    const late = { ...EV, game: GAME, runs: [run(1, ["swap", "lte-good"], 91.5, 91.6), run(1, ["blackout", "15"], 91.6, 115)], rows: [row(85, ["a", ""]), row(125, ["a", "Connecting"]), row(135, ["a", ""])] }
    const checks = verifySwitch(4, late)
    expect(checks.map((c) => c.status)).toEqual(["pass", "fail", "pass", "pass"])
    expect(checks[1].detail).toMatch(/calculateSnapshot says turn 8/)
  })
  it("one turn early fails once repeated sampling removes the timestamp step", () => {
    const swapAt = (s: number) => verifySwitch(4, { ...EV, appClock: { ...EV.appClock!, nowMs: (GAME8.gameAt + s) * 1000, nowSeconds: GAME8.gameAt + s, readAtMs: at(s) }, runs: [run(1, ["swap", "lte-good"], s, s + 0.1), run(1, ["blackout", "15"], s + 0.1, s + 24)] })[1].status
    expect(swapAt(60 - TURN_S)).toBe("fail")
    expect(swapAt(60 - 2 * TURN_S)).toBe("fail")
  })
  it("accepts only the calculateSnapshot turn, with no block-arrival slack", () => {
    const edge = (s: number) => verifySwitch(4, { ...EV, appClock: { ...EV.appClock!, nowMs: (GAME8.gameAt + s) * 1000, nowSeconds: GAME8.gameAt + s, readAtMs: at(s) }, runs: [run(1, ["swap", "x"], s, s + 0.1), run(1, ["blackout", "15"], s + 0.1, s + 24)] })[1].status
    expect(edge(59.9)).toBe("fail")
    expect(edge(60)).toBe("pass")
    expect(edge(71.9)).toBe("pass")
    expect(edge(72)).toBe("fail")
  })
  it("reports the independent watch only as a diagnostic", () => {
    const anchor = { ...watchedClockAnchor('CLOCK {"readStartMs":1000,"readEndMs":1400,"chainBestNow":1}')!, sampleCount: 7 }
    const detail = verifySwitch(4, { ...EV, anchor })[1].detail
    expect(detail).toMatch(/independent best-block diagnostic/)
  })
  it("a blackout that ran short, failed or never ran fails", () => {
    expect(verifySwitch(4, { ...EV, runs: [run(1, ["swap", "x"], 67.5, 67.6), run(1, ["blackout", "15"], 67.6, 75)] })[2].status).toBe("fail")
    expect(statuses({ ...EV, runs: [run(1, ["swap", "x"], 67.5, 67.6), run(1, ["blackout", "15"], 67.6, 90, { ok: false })] })[0]).toBe("fail")
    expect(statuses({ ...EV, runs: [run(1, ["swap", "x"], 67.5, 67.6)] })).toEqual(["fail", "pass", "fail", "pass"])
  })
  it("an inconclusive or failed swap is never a pass", () => {
    expect(statuses({ ...EV, runs: [run(1, ["swap", "x"], 67.5, 67.6, { inconclusive: true }), run(1, ["blackout", "15"], 67.6, 91)] })[0]).toBe("fail")
    expect(verifySwitch(4, { ...EV, runs: [] }).map((c) => c.status)).toEqual(["fail", "fail", "fail", "fail"])
  })
  it("netem not active proves nothing: unchecked, one check", () => {
    expect(verifySwitch(4, { ...EV, live: false }).map((c) => c.status)).toEqual(["unchecked"])
  })
  it("without a best-block time the app-clock turn is still judged", () => {
    expect(verifySwitch(4, { ...EV, anchor: null })[1].status).toBe("pass")
  })
  it("another step's calls are not this step's evidence", () => {
    expect(statuses({ ...EV, runs: EV.runs.map((r) => ({ ...r, step: 2 })) })[0]).toBe("fail")
  })
  it("a plan with no blackout asks for none", () => {
    const e = { ...EV, plan: { ...EV.plan, blackoutS: 0 }, runs: [run(1, ["swap", "x"], 67.5, 67.6)] }
    expect(verifySwitch(4, e).map((c) => c.name.split(": ")[1])).toEqual(["ran", "landed in its turn", "link recovered"])
  })
})

describe("linkRecovery", () => {
  const from = at(67.68)
  it("peers that were clear, dropped and are clear again recover", () => {
    expect(linkRecovery(ROWS, from, at(200))).toMatchObject({ dropped: ["a", "b"], recovered: ["a", "b"], ignored: [], droppedAtMs: at(80), recoveredAtMs: at(96) })
  })
  it("a link that never showed a status did not drop: the blackout did not bite", () => {
    expect(linkRecovery([row(66, ["a", ""]), row(90, ["a", ""])], from, at(200)).dropped).toEqual([])
  })
  it("a peer still down at the game's end did not recover", () => {
    const r = linkRecovery([row(66, ["a", ""]), row(80, ["a", "Connecting"]), row(120, ["a", "Connecting"])], from, at(200))
    expect(r).toMatchObject({ dropped: ["a"], recovered: [] })
  })
  it("a peer dark all game is not judged and does not fail the one that dropped and came back", () => {
    const rows = [row(66, ["a", ""], ["dark", "No signal"]), row(80, ["a", "Connecting"], ["dark", "No signal"]), row(96, ["a", ""], ["dark", "No signal"])]
    expect(linkRecovery(rows, from, at(200))).toMatchObject({ dropped: ["a"], recovered: ["a"], ignored: ["dark"] })
  })
  it("a peer degraded before the cut is not counted as dropped", () => {
    const r = linkRecovery([row(66, ["dark", "Can't connect"]), row(80, ["dark", "Can't connect"])], from, at(200))
    expect(r.dropped).toEqual([])
    expect(r.ignored).toEqual(["dark"])
  })
  it("a status after the regroup is the next round's Connecting, never the drop", () => {
    // game 301's shape: a peer in both groups reads Connecting at the round start; before the fix that was the "drop"
    const rows = [row(66, ["a", ""]), row(70, ["a", ""]), row(80, ["a", "Connecting"]), row(96, ["a", ""])]
    expect(linkRecovery(rows, from, at(200)).dropped).toEqual(["a"])
    expect(linkRecovery(rows, from, at(200), at(79.3))).toMatchObject({ dropped: [], regroupMs: at(79.3), next: { peers: ["a"], clear: ["a"] } })
  })
  it("a peer that dropped and then left the grid at the round change is left, not lost", () => {
    const rows = [row(66, ["a", ""], ["b", ""]), row(75, ["a", "Connecting"], ["b", "Connecting"]), row(80, ["c", "Connecting"], ["b", "Connecting"]), row(90, ["c", ""], ["b", ""])]
    expect(linkRecovery(rows, from, at(200), at(79))).toMatchObject({ dropped: ["a", "b"], recovered: ["b"], left: ["a"] })
  })
  it("no frame just before the cut is not provable", () => {
    expect(linkRecovery([row(10, ["a", ""]), row(80, ["a", "Connecting"])], from, at(200)).framedBefore).toBe(false)
  })
  it("the unseen tile's permanent Can't connect is not a peer", () => {
    const unseen: SwitchRow = { snapshotAt: new Date(at(66)).toISOString(), tiles: [{ id: "u", role: "unseen", text: "Can't connect" }, { id: "a", role: "coplayer", text: "" }] }
    expect(linkRecovery([unseen], from, at(200)).ignored).toEqual([])
  })
  it("frames after the game's end do not count", () => {
    expect(linkRecovery([row(66, ["a", ""]), row(300, ["a", "Connecting"])], from, at(200)).dropped).toEqual([])
  })
})

describe("the round change", () => {
  it("regroups at the end of the round the cut is in, never in the last round, never without an anchor", () => {
    expect(regroupWallMs(GAME, ANCHOR, at(67.7))).toBe(at(turnStartS(GAME, 6) + TURN_S))
    expect(regroupWallMs(GAME8, ANCHOR, at(67.7))).toBe(at(turnStartS(GAME8, 8) + TURN_S))
    expect(regroupWallMs(GAME, ANCHOR, at(100))).toBeNull()
    expect(regroupWallMs(GAME, null, at(67.7))).toBeNull()
  })
  const cut = (from: number) => [run(1, ["swap", "lte-good"], from - 0.1, from), run(1, ["blackout", "15"], from, from + 23.6)]
  it("a cut the round change meets before a tile can show it is not provable, never a fail", () => {
    // six seats: the round ends at 72 s, 4.3 s into the cut
    const rows = [row(66, ["a", ""]), row(71, ["a", ""]), row(73, ["n", "Connecting"]), row(90, ["n", ""])]
    const c = verifySwitch(4, { ...EV, game: GAME, runs: cut(67.7), rows })[3]
    expect(c.status).toBe("unchecked")
    expect(c.detail).toMatch(/round changed 4\.3 s after the cut began/)
    expect(c.detail).toMatch(/next group's 1 peer\(s\): 1 shown clear, the first 22\.3 s/)
  })
  it("still fails when the next group never comes clear", () => {
    const rows = [row(66, ["a", ""]), row(73, ["n", "Connecting"]), row(190, ["n", "Can't connect"])]
    const c = verifySwitch(4, { ...EV, game: GAME, runs: cut(67.7), rows })[3]
    expect(c.status).toBe("fail")
    expect(c.detail).toMatch(/none ever clear/)
  })
  it("no frame after the round change is a recorder gap: not provable, never a fail", () => {
    const c = verifySwitch(4, { ...EV, game: GAME, runs: cut(67.7), rows: [row(66, ["a", ""]), row(71, ["a", ""])] })[3]
    expect(c.status).toBe("unchecked")
    expect(c.detail).toMatch(/next group's 0 peer\(s\)/)
  })
  it("a round change well after the cut leaves the no-drop verdict a fail", () => {
    // eight seats: the round ends at 96 s, 28 s into the cut, long past the tile's lag
    expect(96 - 67.7).toBeGreaterThan(TILE_DROP_LAG_MS / 1000)
    const rows = [row(66, ["a", ""]), row(90, ["a", ""]), row(97, ["n", "Connecting"]), row(110, ["n", ""])]
    const c = verifySwitch(4, { ...EV, runs: cut(67.7), rows })[3]
    expect(c.status).toBe("fail")
    expect(c.detail).toMatch(/after it began \(looked for until the round changed, 28\.3 s in\): the blackout did not reach the link/)
  })
  it("no frame just before the cut is unchecked, not a fail", () => {
    expect(verifySwitch(4, { ...EV, rows: [row(10, ["a", ""]), row(120, ["a", ""])] })[3].status).toBe("unchecked")
  })
  it("a recorder that wrote no frame at all around the cut is a fail", () => {
    const c = verifySwitch(4, { ...EV, rows: [row(10, ["a", ""])] })[3]
    expect(c.status).toBe("fail")
    expect(c.detail).toMatch(/recorder was silent/)
  })
  it("no peer clear going in (turn 1 still on Connecting) is unchecked, never \"did not reach\"", () => {
    const rows = [row(60, ["a", "Connecting"], ["b", "Connecting…"]), row(80, ["a", "Connecting"], ["b", ""]), row(96, ["a", ""], ["b", ""])]
    const c = verifySwitch(4, { ...EV, rows })[3]
    expect(c.status).toBe("unchecked")
    expect(c.detail).toMatch(/no peer was clear going in/)
  })
  it("a switch on a round's last turn is not provable for that game (a two-seat game's turn 2)", () => {
    // no best-block anchor and no frame that swaps players: only the plan says the round ended
    const c = verifySwitch(4, { ...EV, anchor: null, game: { ...GAME, maxGroupSize: 2 }, plan: { ...EV.plan, atTurn: 2 }, rows: [row(66, ["a", ""]), row(90, ["a", ""])] })[3]
    expect(c.status).toBe("unchecked")
    expect(c.detail).toMatch(/last turn of a round in this 2-seat game/)
  })
})

// THE REAL GAMES (previewnet, bot 4 = switcher-pixel6a-wifi-to-cell, six seats, two rounds, turn 6 = the round's LAST turn).
// Tiles trimmed to id/role/text, runs of identical frames kept by their edges. netem.log stamps a call when it RETURNS: the
// swap returned at :07.7 and the blackout at :31.3 (23.6 s), so the cut began ~:07.7. The chain clock ran ~7.3 s behind the
// wall (the swap started +0.3 s into chain turn 6), and the round's end at chain 72 s meets the cut at ~:19.3, 11.6 s in.
describe("game 339: a page that was right, no longer judged on a stale best-block read", () => {
  // RECONSTRUCTED from the run (38096161932, bot 4): the record keeps no anchor values, so the anchor is the one read at
  // (c)'s start, about 8 minutes before the swap, with the offset that gives the reported -11.5 s (-18.755 s: a 12 s step
  // heard 5.4 s late, plus the read). Every page in the game held -7 s and sealed turn 1 at 00:00:19.06 UTC.
  const G339 = { gameAt: 1_791_676_800, rounds: 2, maxGroupSize: 6 }
  const readMs = Date.parse("2026-10-10T23:52:30.000Z")
  const anchor = { chainNowS: readMs / 1000 - 18.755, wallNowMs: readMs }
  const swapMs = Date.parse("2026-10-11T00:00:19.255Z")
  const ev: SwitchEvidence = {
    ...EV,
    plan: { step: 1, atTurn: 2, blackoutS: 15 },
    pageTurn: 2,
    appClock: { nowMs: (G339.gameAt + 12) * 1000, nowSeconds: G339.gameAt + 12, offset: -7, block: 333_968, readAtMs: swapMs },
    anchor,
    game: G339,
    runs: [{ step: 1, call: ["swap", "lte-good"], startMs: swapMs, endMs: swapMs + 130, ok: true, inconclusive: false }, { step: 1, call: ["blackout", "15"], startMs: swapMs + 28_630, endMs: swapMs + 57_230, ok: true, inconclusive: false }],
  }
  it("the single stale read is diagnostic and cannot overturn the app clock", () => {
    const rel = chainSecondAt(swapMs, anchor) - (G339.gameAt + turnStartS(G339, 2))
    expect(rel).toBeCloseTo(-11.5, 1)
    expect(rel < -9).toBe(true)
    expect(verifySwitch(4, ev)[1].status).toBe("pass")
  })
  it("a later fresh read matches the page and makes the real turn-2 swap pass", () => {
    // the newest block at the swap read 00:00:12 UTC (#333968), heard ~5.4 s later; the pages held -7 s
    const pageAnchor = { chainNowS: swapMs / 1000 - 7, wallNowMs: swapMs }
    const selected = freshestAnchor([anchor, pageAnchor])
    expect(selected).toEqual(pageAnchor)
    expect(turnAtChainSecond(G339, chainSecondAt(swapMs, selected!))).toMatchObject({ turn: 2, inGap: false })
    expect(verifySwitch(4, { ...ev, anchor: selected })[1].status).toBe("pass")
  })
})

describe("the real games", () => {
  const load = (f: string): SwitchRow[] => readFileSync(join(__dirname, "fixtures", f), "utf8").trim().split("\n").map((l) => JSON.parse(l) as SwitchRow)
  // each game's own netem.log: the step fired at `fired`, the swap returned at `swapped`, the blackout returned at `cutEnd`
  const real = (gameAt: number, hhmm: string, f: string, [fired, swapped, cutEnd]: [string, string, string]): SwitchEvidence => {
    const w = (s: string) => Date.parse(`2026-10-10T${hhmm}:${s}Z`)
    const anchor = { chainNowS: gameAt + 60.3, wallNowMs: w(fired) }
    const g = { gameAt, rounds: 2, maxGroupSize: 6 }
    const appClock = { nowMs: (gameAt + 60) * 1000, nowSeconds: gameAt + 60, offset: -7, block: 1, readAtMs: w(fired) - 300 }
    return { plan: { step: 1, atTurn: 6, blackoutS: 15 }, live: true, runs: [{ step: 1, call: ["swap", "lte-good"], startMs: w(fired), endMs: w(swapped), ok: true, inconclusive: false }, { step: 1, call: ["blackout", "15"], startMs: w(swapped), endMs: w(cutEnd), ok: true, inconclusive: false }], pageTurn: 6, appClock, anchor, game: g, rows: load(f), gameEndMs: appClock.readAtMs + (gameEndAt(g) - appClock.nowSeconds) * 1000 }
  }
  // e2e-live a live run: the app logged ICE disconnected on all four links at :15.9-:17.6 and connection_stalled at :18.4,
  // the mesh closed at :19.4 and the next group sat on Connecting through the cut, all clear by :35.6
  it("game 311: the round change met the cut 11.6 s in, so the drop is not provable, not a failure", () => {
    const c = verifySwitch(4, real(1_791_643_200, "14:41", "run-i-bot4-switch-tiles.jsonl", ["07.597", "07.726", "31.279"]))
    expect(c.map((x) => x.status)).toEqual(["pass", "pass", "pass", "unchecked"])
    expect(c[3].detail).toMatch(/round changed 11\.6 s after the cut began/)
    expect(c[3].detail).toMatch(/next group's 5 peer\(s\): 5 shown clear, the first 20\.7 s/)
  })
  // e2e-live a live run: the same shape; 5CBLSmZy sat in both groups and its round-start Connecting at :20.6 was the "drop"
  it("game 301: the peer in both groups no longer passes on its round-start Connecting", () => {
    const e = real(1_791_631_200, "11:21", "run-h-bot4-switch-tiles.jsonl", ["07.550", "07.678", "31.184"])
    // the frame that swapped players ends the drop window even with no schedule (no best-block anchor)
    expect(linkRecovery(e.rows, e.runs[1].startMs, e.gameEndMs)).toMatchObject({ dropped: [], regroupMs: Date.parse("2026-10-10T11:21:20.559Z") })
    const c = verifySwitch(4, e)[3]
    expect(c.status).toBe("unchecked")
    expect(c.detail).toMatch(/round changed 11\.6 s after the cut began/)
  })
  // e2e-live a live run: the switch on turn 2 (16:40:19.5; the swap returned at :19.6, the blackout at :43.2). The three
  // peers went to Connecting at :34.9 and were clear by :48.0. Bot 24 (5EL5eDDp) reloaded its own page at 16:42:14, and its tile
  // on this grid read Connecting again at 16:42:33.5-:36.6, in turn 12: that is not this cut, and it once read "clear again by 137.0 s".
  it("game 317: the recovery is the cut's own, not a co-player's reload two minutes later", () => {
    const w = (s: string) => Date.parse(`2026-10-10T16:40:${s}Z`)
    const g = { gameAt: 1_791_650_400, rounds: 2, maxGroupSize: 6 }
    const anchor = { chainNowS: g.gameAt + turnStartS(g, 1) + 6.3, wallNowMs: w("19.485") }
    const e: SwitchEvidence = {
      plan: { step: 1, atTurn: 2, blackoutS: 15 },
      live: true,
      runs: [
        { step: 1, call: ["swap", "lte-good"], startMs: w("19.485"), endMs: w("19.623"), ok: true, inconclusive: false },
        { step: 1, call: ["blackout", "15"], startMs: w("19.623"), endMs: w("43.172"), ok: true, inconclusive: false },
      ],
      pageTurn: 2,
      appClock: { nowMs: (g.gameAt + 12) * 1000, nowSeconds: g.gameAt + 12, offset: -7, block: 1, readAtMs: w("19.185") },
      anchor,
      game: g,
      rows: load("run-j-bot4-switch-tiles.jsonl"),
      gameEndMs: anchor.wallNowMs + (gameEndAt(g) - anchor.chainNowS) * 1000,
    }
    const r = linkRecovery(e.rows, w("19.623"), e.gameEndMs, regroupWallMs(g, anchor, w("19.623")))
    expect(r.dropped.sort()).toEqual(["5CBLSmZy", "5CinLJ3t", "5EL5eDDp"])
    expect(r.recoveredAtMs).toBe(w("48.016"))
    const c = verifySwitch(4, e)
    expect(c.map((x) => x.status)).toEqual(["pass", "pass", "pass", "pass"])
    expect(c[3].detail).toMatch(/first 15\.4 s after the cut began\) and 3 were clear again by 28\.4 s$/)
  })
})

describe("the switcher profile", () => {
  // games 301 and 311 put the switch on turn 6, a six-seat round's LAST turn, so the round change met every cut ~11.6 s in.
  // Turn 2 is the first turn whose frame before the cut shows the round's peers clear (both games' tiles), and it leaves the
  // drop clear of the turn-3/4 steps other bots run (storm, chain/relay/udp outage, video stall): a tile shows the drop
  // ~11.5 s after the call, before theirs could show.
  const plan = switchPlanOf(profileByName("switcher-pixel6a-wifi-to-cell").network)
  it("switches mid-round, never on a round's last turn, for any group of three seats or more", () => {
    expect(plan).not.toBeNull()
    for (let seats = 3; seats <= 8; seats++) {
      const g = { gameAt: 0, rounds: 2, maxGroupSize: seats }
      const cutStartMs = turnStartS(g, plan!.atTurn) * 1000
      const regroup = regroupWallMs(g, { chainNowS: 0, wallNowMs: 0 }, cutStartMs) as number
      expect(plan!.atTurn % seats).not.toBe(0)
      expect(regroup - cutStartMs).toBeGreaterThanOrEqual(TILE_DROP_LAG_MS)
    }
  })
})

describe("switchPlanOf", () => {
  it("is the profile's switch, step 1, and null without one", () => {
    expect(switchPlanOf({ switchAtTurn: 6, switchTo: "lte-good", blackoutS: 15 })).toEqual({ step: 1, atTurn: 6, blackoutS: 15 })
    expect(switchPlanOf({ switchAtTurn: 6, switchTo: "lte-good" })).toEqual({ step: 1, atTurn: 6, blackoutS: 0 })
    expect(switchPlanOf({})).toBeNull()
  })
})
