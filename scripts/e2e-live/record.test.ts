// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  RoundTracker,
  checkVotes,
  fullyInView,
  inferSelf,
  settleRetappable,
  describeMisses,
  isApproved,
  lateTaps,
  misses,
  parseExport,
  parseLog,
  parseRotY,
  parseRotateY,
  parseRows,
  readStage,
  shotName,
  stormVerdict,
  tapResult,
  tapLogResult,
  tapBlocker,
  nextPostPassRescan,
  POST_PASS_RESCAN_ATTEMPTS,
  TAP_REACTION_MS,
  tapPassPriority,
  tapPassSettlementBlocker,
  tileTapReady,
  tileRole,
  tileVotable,
  turnEnds,
  verdictMarkdown,
  verdictTable,
  voteTable,
  voteTrail,
  type TickRow,
  type TapRecord,
  type VoteTrail,
} from "./record"
import { checkChainVotes, type FiledReport } from "./chain-checks"

const built = (players: Record<string, { verdict: string; source?: string; unseenChoice?: "default-notperson" | "flipped-person"; unseenEverFlipped?: boolean }>, filedBy = "auto-confirm") =>
  parseLog([{ ts: 1, tag: "vote", message: "report built", data: JSON.stringify({ filedBy, players }) }])

describe("parseRotateY", () => {
  it("reads the angle, absolute", () => {
    expect(parseRotateY("perspective(900px) rotateY(-180deg) scale(1)")).toBe(180)
    expect(parseRotateY("rotateY(0deg)")).toBe(0)
    expect(parseRotateY("scale(1)")).toBeNull()
    expect(parseRotateY(undefined)).toBeNull()
  })
})

describe("readStage", () => {
  const base = { url: "http://x/game", pillLabel: "Turn 3 of 6", introHeadline: false, confirmButton: false }
  it("play, intro, confirm, waiting, other", () => {
    expect(readStage(base)).toEqual({ stage: "play", turn: 3, turnsPerRound: 6 })
    expect(readStage({ ...base, introHeadline: true }).stage).toBe("intro")
    expect(readStage({ ...base, confirmButton: true }).stage).toBe("confirm")
    expect(readStage({ ...base, pillLabel: null }).stage).toBe("waiting")
    expect(readStage({ ...base, url: "http://x/prize-draw" }).stage).toBe("other")
  })
})

describe("RoundTracker / shotName", () => {
  it("counts a wrap of the turn number as a new round", () => {
    const r = new RoundTracker()
    expect([1, 2, 6, null, 1, 2].map((t) => r.next(t))).toEqual([0, 0, 0, 0, 1, 1])
    expect(shotName(1, 2, "intro", 7)).toBe("c-r1-t2-intro-7.png")
  })
})

describe("the vote trail", () => {
  it("keeps the app's own reason when it switched auto-confirm off (games 196, 197: a stalled page)", () => {
    const t = voteTrail(parseLog([{ ts: 7, tag: "vote", message: "auto-confirm off", data: JSON.stringify({ reason: "off-after-background" }) }]))
    expect(t.autoConfirmOff).toEqual({ ts: 7, reason: "off-after-background" })
    expect(voteTrail([]).autoConfirmOff).toBeUndefined()
  })
  it("counts taps and seals and keeps every report", () => {
    const lines = parseLog([
      { ts: 1, tag: "vote", message: "tap", data: "{}" },
      { ts: 2, tag: "vote", message: "turn sealed", data: "{}" },
      { ts: 3, tag: "other", message: "report built" },
      { ts: 4, tag: "vote", message: "report built", data: "{broken" },
    ])
    expect(voteTrail(lines)).toEqual({ reports: [], taps: 1, sealed: 1, overrides: 0 })
  })
  it("passes when every co-player is Person", () => {
    const t = voteTrail(built({ a: { verdict: "person" }, b: { verdict: "person" } }))
    expect(checkVotes("v", t, false).status).toBe("pass")
  })
  it("a NotPerson FAILS, and WARNs under diagnose, naming who", () => {
    const t = voteTrail(built({ aaaaaaaaaa: { verdict: "person" }, bbbbbbbbbb: { verdict: "notperson", source: "majority" } }))
    expect(checkVotes("v", t, false).status).toBe("fail")
    const w = checkVotes("v", t, true)
    expect(w.status).toBe("warn")
    expect(w.detail).toContain("bbbbbbbb=notperson")
  })
  it("no report built is a miss, never a pass", () => {
    const t = voteTrail([])
    expect(checkVotes("v", t, false).status).toBe("fail")
    expect(checkVotes("v", t, true).status).toBe("warn")
  })
  it("tabulates the last report per bot", () => {
    const t = voteTrail(built({
      aaaaaaaaaa: { verdict: "person", source: "unseen", unseenChoice: "flipped-person" },
    }))
    expect(voteTable([{ user: "u1", trail: t }, { user: "u2", trail: voteTrail([]) }])).toContain(
      "| u1 | auto-confirm | aaaaaaaa | person | unseen | flipped-person |",
    )
  })
})

// ── taps and per-turn verdicts, against a real bot's timeline ──────────────
// fixtures/tiles-1.jsonl: player 1 (5HBX…) in paseo game 164, trimmed
// (ghost tiles and text dropped, unchanged runs collapsed to their first and
// last tick). Every co-player was approved in every votable turn; the chain
// filed them all Person.

const G164 = parseRows(readFileSync(join(__dirname, "fixtures/tiles-1.jsonl"), "utf8"))
const SELF = "5GeMcLaWYVGjCfmShPqgA8axoAd6AJ5LAPzrP2cwJ7ujUYQv"
const A = "5G5ADeF3MbuvvfnEg2yJEEbkThgnFHU1T8WE5rkTDEpjkbpV"
const B = "5GRWWWXUzLEDoUKWX5xBgkHXG78XTGqLJwj2Fj2jcbgvHKeR"
const VP = { width: 390, height: 844 }

describe("parseRotY / isApproved", () => {
  it("keeps the sign: +180 approve, −180 reject, 0 undecided or changed", () => {
    expect(parseRotY("perspective(900px) rotateY(-180deg) scale(1)")).toBe(-180)
    expect(isApproved({ rotateY: 180, rotY: 180 })).toBe(true)
    expect(isApproved({ rotateY: 180, rotY: -180 })).toBe(false)
    expect(isApproved({ rotateY: 0, rotY: 0 })).toBe(false)
    // A reject at -180 followed by approve lands at rotation zero. Current
    // builds expose the controlled verdict so the bot does not toggle it back.
    expect(isApproved({ verdict: "approve", rotateY: 0, rotY: 0 })).toBe(true)
    expect(isApproved({ verdict: "reject", rotateY: 180, rotY: 180 })).toBe(false)
    // an old row with no rotY falls back to the absolute angle
    expect(isApproved({ rotateY: 180 })).toBe(true)
  })
})

describe("fullyInView / tapBlocker", () => {
  it("rejects a tile flying in from off-screen", () => {
    expect(fullyInView({ x: -232, y: 277, w: 183, h: 183 }, VP)).toBe(false)
    expect(fullyInView({ x: 439, y: 86, w: 183, h: 183 }, VP)).toBe(false)
    expect(fullyInView({ x: 8, y: 277, w: 183, h: 183 }, VP)).toBe(true)
    expect(fullyInView(null, VP)).toBe(false)
  })
  it("on the real rows: a fly-in is blocked, a settled undecided tile is tappable", () => {
    const flying = G164.find((r) => r.stage === "play" && r.tiles?.some((t) => t.cursorPointer && (t.box?.x ?? 0) < 0 && !isApproved(t)))!
    const t = flying.tiles!.find((x) => x.cursorPointer && (x.box?.x ?? 0) < 0)!
    expect(tapBlocker(t, { stage: "play", ducked: false }, VP)).toBe("outside the viewport")
    const settled = G164.find((r) => r.stage === "play" && !r.ducked && r.tiles?.some((x) => x.cursorPointer && !isApproved(x) && x.hit === "self" && fullyInView(x.box, VP)))!
    const s = settled.tiles!.find((x) => x.cursorPointer && !isApproved(x) && x.hit === "self")!
    expect(tapBlocker(s, { stage: "play", ducked: false }, VP)).toBeNull()
    expect(tapBlocker(s, { stage: "play", ducked: false }, VP, s.box)).toBeNull()
    expect(tapBlocker(s, { stage: "play", ducked: false }, VP, { ...s.box!, x: s.box!.x + 40 })).toBe("moving")
    expect(tapBlocker(s, { stage: "intro", ducked: true }, VP)).toBe("stage intro")
    expect(tapBlocker(s, { stage: "play", ducked: true }, VP)).toMatch(/ducked/)
    expect(tapBlocker({ ...s, cursorPointer: false }, { stage: "play", ducked: false }, VP)).toBe("not votable")
    expect(tapBlocker({ ...s, rotY: 180 }, { stage: "play", ducked: false }, VP)).toBe("approved")
  })

  it("defers a newly moved Host-to-Co-player behind two stable peers without dropping it from the final seven-second pass", () => {
    const frame = { stage: "play" as const, ducked: false }
    const stable = G164.find((r) => r.stage === "play" && !r.ducked && r.tiles?.some((x) => x.cursorPointer && !isApproved(x) && x.hit === "self" && fullyInView(x.box, VP)))!
    const tile = stable.tiles!.find((x) => x.cursorPointer && !isApproved(x) && x.hit === "self")!
    const first = { ...tile, id: "stable-first", box: { ...tile.box!, x: 8, y: 277 } }
    const second = { ...tile, id: "stable-second", box: { ...tile.box!, x: 199, y: 277 } }
    const transitioned = { ...tile, id: "host-to-coplayer", box: { ...tile.box!, x: 199, y: 468 } }
    const previous = new Map([
      [first.id, first.box],
      [second.id, second.box],
      [transitioned.id, { ...transitioned.box, y: 277 }],
    ])

    const pass = [transitioned, first, second]
      .map((candidate) => ({ candidate, priority: tapPassPriority(tapBlocker(candidate, frame, VP, previous.get(candidate.id))) }))
      .filter(({ priority }) => priority !== null)
      .sort((a, b) => a.priority! - b.priority!)
    expect(pass.map(({ candidate }) => candidate.id)).toEqual([first.id, second.id, transitioned.id])
    expect(tapBlocker(transitioned, frame, VP, transitioned.box)).toBeNull()
    expect(tapBlocker({ ...transitioned, box: { ...transitioned.box, y: 490 } }, frame, VP, transitioned.box)).toBe("moving")
  })

  it("rechecks deferred movement in tap-storm settlement without changing stable-peer settlement", () => {
    const frame = { stage: "play" as const, ducked: false }
    const stable = G164.find((r) => r.stage === "play" && !r.ducked && r.tiles?.some((x) => x.cursorPointer && !isApproved(x) && x.hit === "self" && fullyInView(x.box, VP)))!
    const source = stable.tiles!.find((x) => x.cursorPointer && !isApproved(x) && x.hit === "self")!
    const passBox = { ...source.box!, x: 199, y: 468 }
    const stillMoving = { ...source, id: "deferred", box: { ...passBox, y: 504 } }
    const settled = { ...stillMoving, box: passBox }

    expect(tapPassSettlementBlocker(1, stillMoving, frame, VP, passBox)).toBe("moving")
    expect(tapPassSettlementBlocker(1, settled, frame, VP, passBox)).toBeNull()
    expect(tapPassSettlementBlocker(1, { ...settled, role: "host" }, frame, VP, passBox)).toBe("role host")
    expect(tapPassSettlementBlocker(0, stillMoving, frame, VP, passBox)).toBeNull()
  })

  it("retains bounded post-pass attempts across a same-Page task stall but not across a turn or stage", () => {
    let state = nextPostPassRescan(null, 6, "play", 3, false)
    expect(state).toEqual({ turn: 6, remaining: POST_PASS_RESCAN_ATTEMPTS })

    // The browser can produce no actor snapshot for several seconds while a
    // screenshot/protocol task owns the same Page. No wall clock is consumed:
    // the first post-stall snapshot spends one attempt; a tile becoming ready
    // on the next snapshot is still routed through the normal guarded pass.
    state = nextPostPassRescan(state, 6, "play", 0, true)
    expect(state).toEqual({ turn: 6, remaining: POST_PASS_RESCAN_ATTEMPTS - 1 })
    state = nextPostPassRescan(state, 6, "play", 0, true)
    expect(state).toEqual({ turn: 6, remaining: POST_PASS_RESCAN_ATTEMPTS - 2 })

    expect(nextPostPassRescan(state, 7, "play", 0, true)).toBeNull()
    expect(nextPostPassRescan(state, 6, "confirm", 0, true)).toBeNull()
    expect(nextPostPassRescan(null, 6, "play", 1, true)).toBeNull()
  })
})

describe("tapResult", () => {
  const gameplay = { stage: "gameplay", turn: 5 }

  it("accepts only an observed approval in the same turn", () => {
    expect(tapResult(gameplay, gameplay, { rotateY: 180, rotY: 180 })).toBe("ok")
    expect(tapResult(gameplay, gameplay, { verdict: "approve", rotateY: 0, rotY: 0 })).toBe("ok")
  })

  it("retries a click swallowed by the tile's reset while the same turn can still take it", () => {
    expect(tapResult(gameplay, gameplay, { rotateY: 0, rotY: 0 })).toBe("retry: verdict unchanged")
    expect(tapResult(gameplay, gameplay, null)).toBe("retry: tile unavailable")
  })

  it("stays late when the turn or votable stage has closed", () => {
    expect(tapResult(gameplay, { stage: "ending", turn: 5 }, { rotateY: 0, rotY: 0 })).toBe("late: ending, turn 5")
    expect(tapResult(gameplay, { stage: "introduction", turn: 6 }, { rotateY: 0, rotY: 0 })).toBe("late: introduction, turn 6")
    expect(tapResult(gameplay, null, null)).toBe("late: unknown, turn unknown")
  })

  it("logs a transient retry as skipped, not successful or erroneous tap evidence", () => {
    expect(tapLogResult("retry: verdict unchanged")).toEqual({
      logged: "skipped: retry: verdict unchanged; retrying",
      retry: true,
    })
    expect(tapLogResult("ok")).toEqual({ logged: "ok", retry: false })
    expect(tapLogResult("late: ending, turn 5")).toEqual({ logged: "late: ending, turn 5", retry: false })
  })
})

describe("stable tile eligibility versus instantaneous tap readiness", () => {
  const resetting = {
    id: A,
    cursorPointer: false,
    votable: true,
    tapReady: false,
    rotateY: 0,
    rotY: 0,
    attrs: {},
    text: "",
    aria: [],
    box: { x: 8, y: 277, w: 183, h: 183 },
    visible: true,
    hit: "self",
    tapped: false,
    click: null,
  }

  it("blocks a reset-frame click without erasing the tile's vote eligibility", () => {
    expect(tileVotable(resetting)).toBe(true)
    expect(tileTapReady(resetting)).toBe(false)
    expect(tapBlocker(resetting, { stage: "play", ducked: false }, VP)).toBe("not ready")
  })

  it("keeps legacy false-ready evidence fail-closed as unknown", () => {
    const rows: TickRow[] = [{ t: "2026-10-07T00:00:00.000Z", stage: "play", turn: 5, ducked: false, tiles: [{ ...resetting }, { ...resetting, id: SELF, votable: false }] }]
    expect(verdictTable(rows, SELF).turns[0]?.verdicts[A]).toBe("unknown")
  })

  it("retains the product role and excludes Unseen without hiding a missed Co-player", () => {
    const unseen = { ...resetting, role: "unseen" as const, attrs: { "data-tile-role": "unseen" } }
    const coplayer = { ...resetting, role: "coplayer" as const, attrs: { "data-tile-role": "coplayer" } }
    expect(tileRole(unseen)).toBe("unseen")
    expect(tapBlocker(unseen, { stage: "play", ducked: false }, VP)).toBe("role unseen")
    const rows: TickRow[] = [{ t: "2026-10-07T00:00:00.000Z", stage: "play", turn: 5, ducked: false, tiles: [unseen, { ...coplayer, id: B }, { ...resetting, id: SELF, role: "you" }] }]
    const table = verdictTable(rows, SELF)
    expect(table.turns[0]?.roles[A]).toBe("unseen")
    expect(table.turns[0]?.verdicts).toEqual({ [A]: "unseen", [B]: "unknown" })
    expect(misses(table)).toEqual([])
  })

  const evidenceRow = (
    at: string,
    sessionStage: string,
    role: "unseen" | "coplayer" | "host",
    tapReady: boolean,
    over: Partial<TickRow> = {},
  ): TickRow => ({
    t: at,
    readStartedAt: at,
    snapshotAt: at,
    readCompletedAt: at,
    pageGeneration: 0,
    documentIdentity: "document-a",
    viewport: VP,
    stage: "play",
    turn: 5,
    sessionStage,
    sessionTurn: 5,
    ducked: false,
    tiles: [
      { ...resetting, role, votable: role === "coplayer", tapReady, cursorPointer: tapReady, attrs: { "data-tile-role": role } },
      { ...resetting, id: SELF, role: "you", votable: false, tapReady: false },
    ],
    ...over,
  })

  it("keeps one legal ready opportunity strict even when ending follows within 252 ms", () => {
    const rows = [
      evidenceRow("2026-10-06T23:59:59.900Z", "gameplay", "coplayer", false),
      evidenceRow("2026-10-07T00:00:00.000Z", "gameplay", "coplayer", true),
      evidenceRow("2026-10-07T00:00:00.252Z", "ending", "coplayer", false),
    ]
    expect(verdictTable(rows, SELF).turns[0]?.verdicts[A]).toBe("missed")
    expect(misses(verdictTable(rows, SELF))).toEqual([{ turn: 5, id: A }])
  })

  it("allows a two-tick readiness transition, then measures the 254 ms opportunity from the ready frame", () => {
    const rows = [
      evidenceRow("2026-10-06T23:59:58.700Z", "gameplay", "unseen", false),
      evidenceRow("2026-10-06T23:59:59.750Z", "gameplay", "coplayer", false),
      evidenceRow("2026-10-07T00:00:00.000Z", "gameplay", "coplayer", true),
      evidenceRow("2026-10-07T00:00:00.254Z", "ending", "coplayer", false),
    ]
    const table = verdictTable(rows, SELF)
    expect(table.turns[0]?.verdicts[A]).toBe("no-opportunity")
    expect(misses(table)).toEqual([])
  })

  it("flags a product that leaves a votable tile unready for 3 seconds before a 200 ms opportunity", () => {
    const rows = [
      evidenceRow("2026-10-06T23:59:59.900Z", "gameplay", "unseen", false),
      evidenceRow("2026-10-07T00:00:00.000Z", "gameplay", "coplayer", false),
      evidenceRow("2026-10-07T00:00:03.000Z", "gameplay", "coplayer", true),
      evidenceRow("2026-10-07T00:00:03.200Z", "ending", "coplayer", false),
    ]
    const table = verdictTable(rows, SELF)
    expect(table.turns[0]?.verdicts[A]).toBe("late-tap-ready")
    expect(misses(table)).toEqual([{ turn: 5, id: A }])
  })

  it("records no opportunity only for authoritative Unseen-through-cutoff followed by first Co-player", () => {
    const rows = [
      evidenceRow("2026-10-06T23:59:59.900Z", "introduction", "unseen", false, { stage: "intro", ducked: true }),
      evidenceRow("2026-10-07T00:00:00.000Z", "gameplay", "unseen", false),
      evidenceRow("2026-10-07T00:00:00.200Z", "ending", "unseen", false),
      evidenceRow("2026-10-07T00:00:00.300Z", "ending", "coplayer", false),
    ]
    const table = verdictTable(rows, SELF)
    expect(table.turns[0]?.roles[A]).toBe("coplayer")
    expect(table.turns[0]?.verdicts[A]).toBe("no-opportunity")
    expect(misses(table)).toEqual([])
  })

  it("accepts an introduction with no headline (stage play) in the Unseen-to-Co-player proof (#526)", () => {
    const rows = [
      evidenceRow("2026-10-06T23:59:59.900Z", "introduction", "unseen", false, { stage: "play" }),
      evidenceRow("2026-10-07T00:00:00.000Z", "gameplay", "unseen", false),
      evidenceRow("2026-10-07T00:00:00.200Z", "ending", "unseen", false),
      evidenceRow("2026-10-07T00:00:00.300Z", "ending", "coplayer", false),
    ]
    expect(verdictTable(rows, SELF).turns[0]?.verdicts[A]).toBe("no-opportunity")
  })

  it("anchors the proof after the last row of another turn, not on connect-phase rows (#526)", () => {
    const connect = { t: "2026-10-06T23:58:00.000Z", stage: "other" as const, tiles: [{ ...resetting, role: "unseen" as const, votable: false, tapReady: false }] } as TickRow
    const earlier = evidenceRow("2026-10-06T23:59:00.000Z", "gameplay", "unseen", false, { sessionTurn: 4, turn: 4 })
    const rows = [
      connect,
      earlier,
      evidenceRow("2026-10-06T23:59:59.900Z", "introduction", "unseen", false, { stage: "intro", ducked: true }),
      evidenceRow("2026-10-07T00:00:00.000Z", "gameplay", "unseen", false),
      evidenceRow("2026-10-07T00:00:00.200Z", "ending", "unseen", false),
      evidenceRow("2026-10-07T00:00:00.300Z", "ending", "coplayer", false),
    ]
    expect(verdictTable(rows, SELF).turns.find((t) => t.turn === 5)?.verdicts[A]).toBe("no-opportunity")
    // a non-authoritative row INSIDE the turn still blocks the proof
    const inside = [...rows.slice(0, 3), { ...connect, t: "2026-10-06T23:59:59.950Z" }, ...rows.slice(3)]
    expect(verdictTable(inside, SELF).turns.find((t) => t.turn === 5)?.verdicts[A]).toBe("unknown")
  })

  it("blocks ambiguous false-ready transitions instead of inventing no opportunity", () => {
    const noCutoff = [
      evidenceRow("2026-10-07T00:00:00.000Z", "gameplay", "unseen", false),
      evidenceRow("2026-10-07T00:00:00.300Z", "gameplay", "coplayer", false),
    ]
    const reloadAtCutoff = [
      evidenceRow("2026-10-07T00:00:00.000Z", "ending", "unseen", false),
      evidenceRow("2026-10-07T00:00:00.300Z", "ending", "coplayer", false, { documentIdentity: "document-after-reload" }),
    ]
    const atCutoffWithoutUnseen = [evidenceRow("2026-10-07T00:00:00.300Z", "ending", "coplayer", false)]
    const hostToCoPlayer = [
      evidenceRow("2026-10-07T00:00:00.000Z", "ending", "host", false),
      evidenceRow("2026-10-07T00:00:00.300Z", "ending", "coplayer", false),
    ]
    const observerGap = [
      evidenceRow("2026-10-07T00:00:00.000Z", "ending", "unseen", false),
      { t: "2026-10-07T00:00:00.100Z", error: "controlled read gap" },
      evidenceRow("2026-10-07T00:00:00.300Z", "ending", "coplayer", false),
    ] satisfies TickRow[]
    const coldClockCutoff = [
      evidenceRow("2026-10-07T00:00:00.000Z", "ending", "unseen", false),
      evidenceRow("2026-10-07T00:00:00.300Z", "ending", "coplayer", false, { snapshotAt: "2026-10-06T23:59:00.000Z" }),
    ]
    expect(verdictTable(noCutoff, SELF).turns[0]?.verdicts[A]).toBe("unknown")
    expect(verdictTable(reloadAtCutoff, SELF).turns[0]?.verdicts[A]).toBe("unknown")
    expect(verdictTable(atCutoffWithoutUnseen, SELF).turns[0]?.verdicts[A]).toBe("unknown")
    expect(verdictTable(hostToCoPlayer, SELF).turns[0]?.verdicts[A]).toBe("unknown")
    expect(verdictTable(observerGap, SELF).turns[0]?.verdicts[A]).toBe("unknown")
    expect(verdictTable(coldClockCutoff, SELF).turns[0]?.verdicts[A]).toBe("unknown")
  })

  it("audits every row in the Unseen-to-Co-player proof instead of filtering interruptions away", () => {
    const gameplay = evidenceRow("2026-10-07T00:00:00.000Z", "gameplay", "unseen", false)
    const cutoff = evidenceRow("2026-10-07T00:00:00.100Z", "ending", "unseen", false)
    const middle = evidenceRow("2026-10-07T00:00:00.200Z", "ending", "unseen", false)
    const arrival = evidenceRow("2026-10-07T00:00:00.300Z", "ending", "coplayer", false)
    const withoutTarget = { ...middle, tiles: middle.tiles?.filter((tile) => tile.id !== A) }
    const nonPlay = { ...middle, stage: "other" as const }
    const ducked = { ...middle, ducked: true }
    const phaseReversal = { ...middle, sessionStage: "gameplay" }
    const recorderError = { t: "2026-10-07T00:00:00.200Z", error: "controlled recorder error" } satisfies TickRow
    const wrongTurn = { ...middle, sessionTurn: 6 }
    const wrongDocument = { ...middle, documentIdentity: "document-b" }
    const wrongPage = { ...middle, pageGeneration: 1 }

    for (const interrupted of [withoutTarget, nonPlay, ducked, phaseReversal, recorderError, wrongTurn, wrongDocument, wrongPage])
      expect(verdictTable([gameplay, cutoff, interrupted, arrival], SELF).turns[0]?.verdicts[A]).toBe("unknown")
  })

  it("skips only an explicitly typed role-action annotation in authoritative continuity", () => {
    const gameplay = evidenceRow("2026-10-07T00:00:00.000Z", "gameplay", "unseen", false)
    const cutoff = evidenceRow("2026-10-07T00:00:00.100Z", "ending", "unseen", false)
    const arrival = evidenceRow("2026-10-07T00:00:00.300Z", "ending", "coplayer", false)
    const typed = {
      t: "2026-10-07T00:00:00.200Z",
      recordType: "role-action",
      roleAction: { id: "video-suppressed", detail: "0 outbound tracks" },
      role: "video-suppressed: 0 outbound tracks",
    } as TickRow
    const untyped = { t: typed.t, role: typed.role } as TickRow
    const malformed = { ...typed, roleAction: undefined } as TickRow

    expect(verdictTable([gameplay, cutoff, typed, arrival], SELF).turns[0]?.verdicts[A]).toBe("no-opportunity")
    const ambiguous = [
      untyped,
      malformed,
      { ...typed, t: undefined } as TickRow,
      { ...typed, t: "not-a-time" } as TickRow,
      { ...typed, pageGeneration: 1 } as TickRow,
      { ...typed, documentIdentity: "other-document" } as TickRow,
      { ...typed, stage: "waiting", turn: 6, sessionStage: "waiting", sessionTurn: 6, ducked: true } as TickRow,
      { ...typed, extra: "ambiguous" } as TickRow,
      { ...typed, role: "video-suppressed: different detail" } as TickRow,
      { ...typed, roleAction: { ...typed.roleAction!, extra: "ambiguous" } } as TickRow,
    ]
    for (const row of ambiguous)
      expect(verdictTable([gameplay, cutoff, row, arrival], SELF).turns[0]?.verdicts[A]).toBe("unknown")

    const ready1 = evidenceRow("2026-10-07T00:00:00.000Z", "gameplay", "coplayer", true)
    const ready2 = evidenceRow("2026-10-07T00:00:00.100Z", "gameplay", "coplayer", true)
    const ending = evidenceRow("2026-10-07T00:00:00.300Z", "ending", "coplayer", false)
    expect(verdictTable([ready1, typed, ready2, ending], SELF).turns[0]?.verdicts[A]).toBe("missed")
  })

  it("requires a fresh monotonic phase witness and rejects prior uncertain Co-player evidence", () => {
    const gameplay = evidenceRow("2026-10-07T00:00:00.000Z", "gameplay", "unseen", false)
    const cutoff = evidenceRow("2026-10-07T00:00:00.100Z", "ending", "unseen", false)
    const arrival = evidenceRow("2026-10-07T00:00:00.300Z", "ending", "coplayer", false)
    const longAfterCutoff = evidenceRow("2026-10-07T00:00:30.100Z", "ending", "coplayer", false)
    const legacyCoPlayer = {
      t: "2026-10-06T23:59:59.800Z",
      stage: "play" as const,
      turn: 5,
      ducked: false,
      tiles: [
        { ...resetting, role: "coplayer" as const, votable: true, attrs: { "data-tile-role": "coplayer" } },
        { ...resetting, id: SELF, role: "you" as const, votable: false },
      ],
    }
    const unreconciledCoPlayer = evidenceRow("2026-10-06T23:59:59.900Z", "gameplay", "coplayer", false, {
      snapshotAt: "2026-10-06T23:59:00.000Z",
    })
    const noPhaseTransition = [cutoff, arrival]
    const previousDocument = evidenceRow("2026-10-06T23:59:59.800Z", "gameplay", "unseen", false, {
      pageGeneration: 9,
      documentIdentity: "document-before-reload",
    })

    expect(verdictTable([gameplay, cutoff, longAfterCutoff], SELF).turns[0]?.verdicts[A]).toBe("unknown")
    expect(verdictTable([legacyCoPlayer, gameplay, cutoff, arrival], SELF).turns[0]?.verdicts[A]).toBe("unknown")
    expect(verdictTable([unreconciledCoPlayer, gameplay, cutoff, arrival], SELF).turns[0]?.verdicts[A]).toBe("unknown")
    expect(verdictTable([previousDocument, gameplay, cutoff, arrival], SELF).turns[0]?.verdicts[A]).toBe("unknown")
    expect(verdictTable(noPhaseTransition, SELF).turns[0]?.verdicts[A]).toBe("unknown")
  })

  it("bounds adjacent actual snapshots instead of adding separate read and idle budgets", () => {
    const gameplay = evidenceRow("2026-10-07T00:00:00.000Z", "gameplay", "unseen", false)
    const slowCutoff = evidenceRow("2026-10-07T00:00:00.100Z", "ending", "unseen", false, {
      readCompletedAt: "2026-10-07T00:00:02.100Z",
    })
    const slowArrival = evidenceRow("2026-10-07T00:00:06.100Z", "ending", "coplayer", false, {
      readStartedAt: "2026-10-07T00:00:04.100Z",
    })
    expect(verdictTable([gameplay, slowCutoff, slowArrival], SELF).turns[0]?.verdicts[A]).toBe("unknown")

    const cutoff = evidenceRow("2026-10-07T00:00:00.100Z", "ending", "unseen", false)
    const atBoundary = evidenceRow("2026-10-07T00:00:02.100Z", "ending", "coplayer", false)
    const justPastBoundary = evidenceRow("2026-10-07T00:00:02.101Z", "ending", "coplayer", false, {
      readStartedAt: "2026-10-07T00:00:02.100Z",
    })
    expect(verdictTable([gameplay, cutoff, atBoundary], SELF).turns[0]?.verdicts[A]).toBe("no-opportunity")
    expect(verdictTable([gameplay, cutoff, justPastBoundary], SELF).turns[0]?.verdicts[A]).toBe("unknown")
  })

  it("does not call moving or offscreen readiness a legal opportunity", () => {
    const prior = evidenceRow("2026-10-07T00:00:00.000Z", "gameplay", "coplayer", false)
    const ready = evidenceRow("2026-10-07T00:00:00.100Z", "gameplay", "coplayer", true)
    const moved = { ...ready, tiles: ready.tiles!.map((tile) => tile.id === A ? { ...tile, box: { ...tile.box!, y: tile.box!.y + 20 } } : tile) }
    const offscreen = { ...ready, tiles: ready.tiles!.map((tile) => tile.id === A ? { ...tile, box: { ...tile.box!, x: -300 } } : tile) }
    const ending = evidenceRow("2026-10-07T00:00:00.300Z", "ending", "coplayer", false)
    expect(verdictTable([prior, moved, ending], SELF).turns[0]?.verdicts[A]).toBe("unknown")
    expect(verdictTable([prior, offscreen, ending], SELF).turns[0]?.verdicts[A]).toBe("unknown")
  })
})

describe("journey tap-result wiring", () => {
  it("carries the explicit verdict through storm settling and normalizes every attempt once", () => {
    const source = readFileSync(join(process.cwd(), "scripts/e2e-live/journey.pw.ts"), "utf8")
    expect(source).toContain("const live = { verdict: cur.verdict, rotateY:")
    expect(source.match(/const result = tapLogResult\(await landed\(\)\)/g)).toHaveLength(1)
    expect(source.match(/note\(turn, t\.id, result\.logged, stamp\.stage\)/g)).toHaveLength(1)
    expect(source.indexOf("const result = tapLogResult(await landed())")).toBeLessThan(
      source.indexOf("if (t.id !== stormId && (o.stormFlips ?? 0) > 0)"),
    )
  })

  it("defers moving candidates but requires the fresh per-click box to have settled", () => {
    const source = readFileSync(join(process.cwd(), "scripts/e2e-live/journey.pw.ts"), "utf8")
    expect(source).toContain("tapPassPriority(tapBlocker(tile, { stage, ducked: p.ducked }, vp, prev))")
    expect(source).toContain("(tapPriorities.get(x.id) ?? 0) - (tapPriorities.get(y.id) ?? 0)")
    expect(source).toContain("tapBlocker(live, { stage: seen.stage, ducked: fresh.ducked }, vp, pass.box)")
    expect(source).toContain("tapPassSettlementBlocker(tapPriorities.get(w.id) ?? 0")
  })

  it("prioritizes a bounded same-turn rescan after a pass before role-driver work", () => {
    const source = readFileSync(join(process.cwd(), "scripts/e2e-live/journey.pw.ts"), "utf8")
    expect(source).toContain("POST_PASS_RESCAN_MS")
    expect(source).toContain("nextPostPassRescan")
    expect(source).toContain("verifiedThisPass")
    expect(source).toContain("postPassRescanTurns")
  })
})

describe("turnEnds / verdictTable (g164, player 1)", () => {
  const table = verdictTable(G164, SELF)
  it("finds all twelve turns and both co-players", () => {
    expect([...turnEnds(G164).keys()].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
    expect(table.coPlayers.sort()).toEqual([A, B].sort())
  })
  it("approves every votable co-player; the host of a turn is not votable", () => {
    expect(misses(table)).toEqual([])
    const at = (turn: number) => table.turns.find((t) => t.turn === turn)!.verdicts
    expect(at(1)).toEqual({ [A]: "not-votable", [B]: "approved" })
    expect(at(2)).toEqual({ [A]: "approved", [B]: "not-votable" })
    expect(at(3)).toEqual({ [A]: "approved", [B]: "approved" })
  })
  it("turn 6, the round's last: the round change (pill still 'Turn 6', tiles reset to 0°) is not its end", () => {
    const sixes = G164.filter((r) => r.turn === 6 && r.stage === "play")
    const last = sixes.at(-1)!
    // the recorded round change: ducked, every co-player tile at 0° and no longer votable
    expect(last.ducked).toBe(true)
    expect(last.tiles!.filter((t) => t.id !== SELF).every((t) => t.rotateY === 0)).toBe(true)
    expect(table.turns.find((t) => t.turn === 6)!.verdicts).toEqual({ [A]: "approved", [B]: "approved" })
  })
  it("a legacy reject without authoritative readiness evidence is unknown", () => {
    const rows: TickRow[] = G164.map((r) =>
      r.turn === 4 && r.stage === "play" && !r.ducked ? { ...r, tiles: r.tiles!.map((t) => (t.id === A ? { ...t, rotateY: 180, rotY: -180 } : t)) } : r,
    )
    const table = verdictTable(rows, SELF)
    expect(misses(table)).toEqual([])
    expect(table.turns.find((turn) => turn.turn === 4)?.verdicts[A]).toBe("unknown")
  })
  it("renders a markdown row per turn", () => {
    const md = verdictMarkdown(table, { [A]: "eec", [B]: "eeb" })
    expect(md.split("\n")).toHaveLength(14)
    expect(md).toContain("| 6 | approved | approved |")
  })
})

describe("inferSelf", () => {
  it("is the one tile never votable", () => {
    expect(inferSelf(G164)).toBe(SELF)
    expect(inferSelf([])).toBeNull()
  })
})

describe("parseExport (the page's own export, window.__jollityHarness.exportLogs)", () => {
  it("reads the lines with their data already parsed, and the meta", () => {
    const json = JSON.stringify({
      meta: { store: "memory", entryCount: 2 },
      entries: [
        { ts: 1, sessionId: "s", version: "dev", level: "info", tag: "vote", message: "report built", data: { filedBy: "auto-confirm", players: {} } },
        { ts: 2, sessionId: "s", version: "dev", level: "info", tag: "rtc", message: "plain" },
      ],
    })
    const got = parseExport(json)
    expect(got.meta).toEqual({ store: "memory", entryCount: 2 })
    expect(got.lines).toEqual([
      { ts: 1, sessionId: "s", level: "info", tag: "vote", message: "report built", data: { filedBy: "auto-confirm", players: {} } },
      { ts: 2, sessionId: "s", level: "info", tag: "rtc", message: "plain" },
    ])
    expect(voteTrail(got.lines).reports).toHaveLength(1)
  })

  it("is empty, never a throw, for something that is not an export", () => {
    expect(parseExport("not json")).toEqual({ meta: null, lines: [] })
    expect(parseExport('{"entries":7}')).toEqual({ meta: null, lines: [] })
  })
})

describe("a stale end frame is not a miss (game 194, bot 8: the settling taps landed after the turn's last frame)", () => {
  const A1 = "5G5ADeF3MbuvvfnEg2yJEEbkThgnFHU1T8WE5rkTDEpjkbpV"
  const tile = (id: string, rotY: number) => ({ id, cursorPointer: true, rotY, rotateY: Math.abs(rotY), box: { x: 0, y: 0, w: 1, h: 1 }, hit: "self" }) as unknown as NonNullable<TickRow["tiles"]>[number]
  const rows: TickRow[] = [
    { t: "2026-10-04T17:57:32.009Z", stage: "play", turn: 12, ducked: false, tiles: [tile("me", 0), tile(A1, 0)] },
    { t: "2026-10-04T17:57:35.237Z", stage: "play", turn: 12, ducked: false, tiles: [tile("me", 0), tile(A1, 0)] },
    { t: "2026-10-04T17:57:38.860Z", stage: "confirm", turn: null, ducked: false, tiles: [tile(A1, 180)] },
  ]
  it("without the tap log the legacy frame is unknown", () => {
    const table = verdictTable(rows, "me")
    expect(misses(table)).toEqual([])
    expect(table.turns[0]?.verdicts[A1]).toBe("unknown")
  })
  it("a tap after the last frame of its turn leaves the verdict unobserved, unless the confirm stage shows it approved", () => {
    const taps = [{ at: "2026-10-04T17:57:35.321Z", turn: 12, id: A1, result: "ok" }]
    const late = lateTaps(rows, taps)
    expect([...late]).toEqual([`12:${A1}`])
    const t = verdictTable(rows, "me", late)
    expect(misses(t)).toEqual([])
    // the confirm stage that follows the game's last turn reads approved: that is the evidence
    expect(t.turns.find((x) => x.turn === 12)!.verdicts[A1]).toBe("approved")
    const noConfirm = verdictTable(rows.slice(0, 2), "me", late)
    expect(noConfirm.turns[0].verdicts[A1]).toBe("late")
    expect(misses(noConfirm)).toEqual([])
  })
  it("a tap BEFORE the last frame does not excuse a miss, and a failed click is no tap", () => {
    expect([...lateTaps(rows, [{ at: "2026-10-04T17:57:33.000Z", turn: 12, id: A1, result: "ok" }])]).toEqual([])
    expect([...lateTaps(rows, [{ at: "2026-10-04T17:57:36.000Z", turn: 12, id: A1, result: "error: x" }])]).toEqual([])
  })
  it("says the misses by turn, one line a turn", () => {
    expect(describeMisses([{ turn: 12, id: "5G5ADeF3AAAA" }, { turn: 12, id: "5GeMcLaWBBBB" }, { turn: 3, id: "5HDGmVGvCCCC" }])).toBe("turn 3: 5HDGmVGv; turn 12: 5G5ADeF3, 5GeMcLaW")
  })
  it("settleRetappable: the verdict decides on current builds, the angle only on old ones (game 1601 bot 17)", () => {
    expect(settleRetappable({ verdict: "pending", rotateY: null })).toBe(true)
    expect(settleRetappable({ verdict: "pending", rotateY: 97 })).toBe(true)
    expect(settleRetappable({ rotateY: null })).toBe(false)
    expect(settleRetappable({ rotateY: 0, rotY: 0 })).toBe(true)
    expect(settleRetappable({ rotateY: 180, rotY: -180 })).toBe(true)
    expect(settleRetappable({ rotateY: 97, rotY: 97 })).toBe(false)
  })
})

describe("a co-player that arrives inside the bot's reaction window is no opportunity (game 272: bots 2, 26, 20)", () => {
  // fixtures/late-arrival.json: one turn of each bot's timeline and tap log, a live run. The co-player's first
  // decoded frame landed in the last gameplay tick (bots 2, 26) or with the ending flip (bot 20); the bot's next tap was
  // refused because the page already showed the ending.
  type Bot = { self: string; turn: number; ids: string[]; rows: TickRow[]; taps: TapRecord[] }
  const g272 = JSON.parse(readFileSync(join(__dirname, "fixtures/late-arrival.json"), "utf8")) as Record<"bot2" | "bot26" | "bot20", Bot>
  const verdicts = (b: Bot, taps: TapRecord[] = b.taps, rows: TickRow[] = b.rows) => verdictTable(rows, b.self, lateTaps(rows, taps), taps).turns.find((t) => t.turn === b.turn)!.verdicts
  // the ending read by another document (a reload): the page's own ending snapshot then bounds nothing, so only the tap log can
  const hideEnding = (b: Bot) => b.rows.map((r) => (r.sessionStage === "ending" ? { ...r, documentIdentity: "reloaded" } : r))
  const shift = (taps: TapRecord[], ms: number) => taps.map((t) => ({ ...t, at: new Date(Date.parse(t.at) + ms).toISOString() }))

  it("with no tap log and no readable ending they read as the run did: missed (bots 2, 26) and unknown (bot 20)", () => {
    const bare = (b: Bot) => b.ids.map((id) => verdicts(b, [], hideEnding(b))[id])
    expect(bare(g272.bot2)).toEqual(["missed"])
    expect(bare(g272.bot26)).toEqual(["missed", "missed", "missed"])
    expect(bare(g272.bot20)).toEqual(["unknown"])
  })
  it("uses actual readiness: gameplay-ready bots had a short window, while the ending-only bot crossed the cutoff inside one reaction window", () => {
    const bare = (b: Bot) => b.ids.map((id) => verdicts(b, [])[id])
    expect(bare(g272.bot2)).toEqual(["no-opportunity"])
    expect(bare(g272.bot26)).toEqual(["no-opportunity", "no-opportunity", "no-opportunity"])
    expect(bare(g272.bot20)).toEqual(["no-opportunity"])
  })
  it("a quick refusal bounds gameplay-ready bots and confirms the ending-only tile was already closed", () => {
    expect(g272.bot2.ids.map((id) => verdicts(g272.bot2)[id])).toEqual(["no-opportunity"])
    expect(g272.bot26.ids.map((id) => verdicts(g272.bot26)[id])).toEqual(["no-opportunity", "no-opportunity", "no-opportunity"])
    expect(g272.bot20.ids.map((id) => verdicts(g272.bot20)[id])).toEqual(["no-opportunity"])
  })
  it("the refusal speaks for the whole turn: bot 26's pass stopped at its first tile, the other two have no tap of their own", () => {
    expect(new Set(g272.bot26.taps.map((t) => t.id)).size).toBe(1)
    expect(g272.bot26.ids.filter((id) => !g272.bot26.taps.some((t) => t.id === id))).toHaveLength(2)
  })
  it("a refusal TAP_REACTION_MS or more after the last Unseen snapshot leaves the miss standing", () => {
    expect(verdicts(g272.bot2, shift(g272.bot2.taps, TAP_REACTION_MS), hideEnding(g272.bot2))[g272.bot2.ids[0]]).toBe("missed")
    expect(verdicts(g272.bot20, shift(g272.bot20.taps, TAP_REACTION_MS), hideEnding(g272.bot20))[g272.bot20.ids[0]]).toBe("unknown")
  })
  it("a refusal before the tile was last seen Unseen is no evidence about it", () => {
    // -4 s: bot 2's refusals span 1.9 s, so -2 s would leave the later ones after that snapshot, which do count
    expect(verdicts(g272.bot2, shift(g272.bot2.taps, -4_000), hideEnding(g272.bot2))[g272.bot2.ids[0]]).toBe("missed")
  })
  it("any other tap on the tile in that turn (a click error, a blocked tap) leaves the miss standing", () => {
    const id = g272.bot2.ids[0]
    const first = g272.bot2.taps[0]
    const other = { ...first, id, at: new Date(Date.parse(first.at) - 100).toISOString(), result: "error: click timed out", stage: "gameplay" }
    expect(verdicts(g272.bot2, [other, ...g272.bot2.taps])[id]).toBe("missed")
  })
  it("an unreconciled Unseen row (page clock outside the runner's read bracket) proves nothing", () => {
    const b = g272.bot2
    const id = b.ids[0]
    const arrival = b.rows.findIndex((r) => r.tiles?.find((t) => t.id === id)?.role === "coplayer")
    const rows = b.rows.map((r, i) => (i === arrival - 1 ? { ...r, snapshotAt: new Date(Date.parse(r.readCompletedAt!) + 5_000).toISOString() } : r))
    expect(verdictTable(rows, b.self, lateTaps(rows, b.taps), b.taps).turns.find((t) => t.turn === b.turn)!.verdicts[id]).toBe("missed")
  })
})

describe("an Unseen tile first becomes Co-player at the ending boundary (game 1368: bot 31)", () => {
  const g = JSON.parse(readFileSync(join(__dirname, "fixtures/bot31-ending-boundary.json"), "utf8")) as { self: string; turn: number; id: string; rows: TickRow[]; taps: TapRecord[] }
  const verdict = (rows: TickRow[]) => verdictTable(rows, g.self, lateTaps(rows, g.taps), g.taps).turns.find((t) => t.turn === g.turn)!.verdicts[g.id]
  const shift = (value: string | undefined, ms: number) => value ? new Date(Date.parse(value) + ms).toISOString() : value

  it("pins the retained run: 250 ms from last Unseen gameplay snapshot to first Co-player ending snapshot is no opportunity", () => {
    expect(verdict(g.rows)).toBe("no-opportunity")
  })

  it("keeps a full reaction window, a reload, or an ambiguous row fail-closed", () => {
    const delayed = g.rows.map((row, index) => index === 1 ? {
      ...row,
      t: shift(row.t, TAP_REACTION_MS),
      readStartedAt: shift(row.readStartedAt, TAP_REACTION_MS),
      snapshotAt: shift(row.snapshotAt, TAP_REACTION_MS),
      readCompletedAt: shift(row.readCompletedAt, TAP_REACTION_MS),
    } : row)
    const reloaded = g.rows.map((row, index) => index === 1 ? { ...row, documentIdentity: "reloaded" } : row)
    const gap = [g.rows[0], { t: "2026-10-25T08:00:22.100Z", error: "controlled recorder gap" } as TickRow, g.rows[1]]
    expect(verdict(delayed)).toBe("unknown")
    expect(verdict(reloaded)).toBe("unknown")
    expect(verdict(gap)).toBe("unknown")
  })

  it("keeps a non-ending click result ambiguous", () => {
    const attempted = [{ ...g.taps[0], result: "error: click timed out", stage: "gameplay" }]
    expect(verdictTable(g.rows, g.self, lateTaps(g.rows, attempted), attempted).turns.find((t) => t.turn === g.turn)!.verdicts[g.id]).toBe("unknown")
  })
})

describe("a Co-player that first decodes in the ending is sealed even when its tile never took a gesture (game 280: bot 16)", () => {
  // fixtures/bot16-unvotable-coplayer.json: turn 5 of bot 16's timeline, trimmed to 5D13u8h6. The tile reads Unseen
  // into the ending, then Co-player but not votable (the seat still showed no signal); the app sealed it NotPerson.
  const g = JSON.parse(readFileSync(join(__dirname, "fixtures/bot16-unvotable-coplayer.json"), "utf8")) as { self: string; turn: number; id: string; rows: TickRow[]; taps: TapRecord[] }
  const verdict = (rows: TickRow[]) => verdictTable(rows, g.self, lateTaps(rows, g.taps), g.taps).turns.find((t) => t.turn === g.turn)!.verdicts[g.id]
  it("the end frame shows a Co-player tile that takes no gesture", () => {
    const end = g.rows.filter((r) => r.sessionTurn === g.turn && r.stage === "play" && !r.ducked).at(-1)!
    const tile = end.tiles!.find((t) => t.id === g.id)!
    expect(tileRole(tile)).toBe("coplayer")
    expect(tile.votable).toBe(false)
  })
  it("is no-opportunity (the NotPerson the app seals), not not-votable (which the majority counted as Person)", () => {
    expect(verdict(g.rows)).toBe("no-opportunity")
  })
  it("without the Unseen ending row that anchors the arrival, the 1.8 s the recorder missed before the ending stay unproven", () => {
    // the first ending snapshot is the only bound the page gives, and it lies 1.78 s after the last Unseen read
    const rows = g.rows.filter((r) => !(r.sessionStage === "ending" && r.tiles?.find((t) => t.id === g.id)?.role === "unseen"))
    expect(verdict(rows)).toBe("not-votable")
  })
})

describe("the ending's own first snapshot bounds the late-arrival window when the bot never refused a tap (game 280: bot 26)", () => {
  // fixtures/bot26-ending-bound.json: turn 6 of bot 26's timeline and the round change after it, trimmed to
  // 5Fcrfviy. After a 1.3 s read stall the tile first reads Co-player in the ending; the bot's loop made no refused tap.
  const g = JSON.parse(readFileSync(join(__dirname, "fixtures/bot26-ending-bound.json"), "utf8")) as { self: string; turn: number; id: string; rows: TickRow[]; taps: TapRecord[] }
  const verdict = (rows: TickRow[]) => verdictTable(rows, g.self, lateTaps(rows, g.taps), g.taps).turns.find((t) => t.turn === g.turn)!.verdicts[g.id]
  const firstEnding = g.rows.findIndex((r) => r.sessionStage === "ending")
  it("the bot refused no tap in that turn", () => {
    expect(g.taps.some((t) => t.result.startsWith("skipped: page showed"))).toBe(false)
  })
  it("the first ending snapshot cannot bound a window that never reached a tap-ready frame", () => {
    expect(firstEnding).toBeGreaterThan(0)
    expect(verdict(g.rows)).toBe("unknown")
  })
  it("with the ending read by another document (a reload) there is no bound, and the evidence stays unknown", () => {
    expect(verdict(g.rows.map((r) => (r.sessionStage === "ending" ? { ...r, documentIdentity: "reloaded" } : r)))).toBe("unknown")
  })
  it("on a page that answered every read on time, an ending first seen TAP_REACTION_MS later leaves the window too wide", () => {
    // prompt reads: the stalled reads of this run are time the page could not take a tap (stalledWithin), so drop them
    const prompt = (r: TickRow): TickRow => (r.snapshotAt ? { ...r, readStartedAt: new Date(Date.parse(r.snapshotAt) - 5).toISOString() } : r)
    const late = (r: TickRow): TickRow => {
      const shift = (v?: string) => (v ? new Date(Date.parse(v) + TAP_REACTION_MS).toISOString() : v)
      return { ...r, readStartedAt: shift(r.readStartedAt), snapshotAt: shift(r.snapshotAt), readCompletedAt: shift(r.readCompletedAt) }
    }
    const rows = g.rows.map(prompt)
    expect(verdict(rows)).toBe("unknown")
    expect(verdict(rows.map((r, i) => (i >= firstEnding ? late(r) : r)))).toBe("unknown")
  })
})

describe("the window runs from the first tap-ready gameplay read to the earliest bound at or after it (game 397: bot 29)", () => {
  // Turn 3: the tile reads Unseen in the last gameplay snapshot (t0), Co-player at the gameplay/ending boundary. The old bound,
  // ending end - 2 s, fell 52 ms before t0 because the ending ran 1.95 s on the runner clock.
  const g280 = JSON.parse(readFileSync(join(__dirname, "fixtures/bot26-ending-bound.json"), "utf8")) as { self: string; id: string; rows: TickRow[] }
  const template = g280.rows[0]
  const t0 = Date.parse("2026-10-11T19:20:40.000Z")
  const iso = (ms: number) => new Date(t0 + ms).toISOString()
  const row = (ms: number, stage: string, role: "unseen" | "coplayer", votable = false, documentIdentity = template.documentIdentity): TickRow => ({
    ...template,
    t: iso(ms),
    readStartedAt: iso(ms - 5),
    snapshotAt: iso(ms),
    readCompletedAt: iso(ms + 5),
    documentIdentity,
    sessionStage: stage as TickRow["sessionStage"],
    sessionTurn: 3,
    turn: 3,
    tiles: [{ ...template.tiles![0], id: g280.id, role, votable, tapReady: votable }],
  })
  // the turn's last gameplay frame reads the tile votable and tap-ready, as bot 29's did, so the verdict rests on the window
  const timeline = (endingDocument = template.documentIdentity) => [
      row(0, "gameplay", "unseen"),
      row(100, "gameplay", "coplayer", true),
      row(152, "ending", "coplayer", false, endingDocument),
      row(1680, "ending", "coplayer", true, endingDocument),
    ]
  const refusalAt = (ms: number): TapRecord => ({ at: iso(ms), turn: 3, id: g280.id, result: "skipped: page showed ending, turn 3", stage: "ending" }) as TapRecord
  const verdict = (taps: TapRecord[], rows = timeline()) => verdictTable(rows, g280.self, lateTaps(rows, taps), taps).turns.find((t) => t.turn === 3)!.verdicts[g280.id]
  const noEnding = timeline("reloaded") // the ending read by another document: the page's own ending snapshot bounds nothing
  it("the first ending snapshot, 152 ms after the last Unseen read, is the proof with no refusal: no-opportunity", () => {
    expect(verdict([])).toBe("no-opportunity")
  })
  it("a refusal 100 ms after it proves the window alone", () => {
    expect(verdict([refusalAt(100)], noEnding)).toBe("no-opportunity")
  })
  it("with no refusal and no ending on the same page the observed ready opportunity remains missed", () => {
    expect(verdict([], noEnding)).toBe("missed")
  })
  it("a refusal before the last Unseen read is ignored: alone the opportunity stays missed, beside a later bound the later one decides", () => {
    expect(verdict([refusalAt(-300)], noEnding)).toBe("missed")
    expect(verdict([refusalAt(-300), refusalAt(100)], noEnding)).toBe("no-opportunity")
    expect(verdict([refusalAt(-300)])).toBe("no-opportunity")
  })
  it("a late refusal more than TAP_REACTION_MS after readiness does not shrink a window the ending did not close", () => {
    expect(verdict([refusalAt(TAP_REACTION_MS + 2_000)], noEnding)).toBe("missed")
  })
})

describe("a gameplay arrival is bounded by the ending's first snapshot too, minus the page's own stalls (game 287: bot 26)", () => {
  // fixtures/bot26-gameplay-arrival.json: both tiles turn Co-player in the last second of gameplay; the next
  // recorder read starts in gameplay and answers 1.45 s later in the ending; the bot's taps were refused there.
  const g = JSON.parse(readFileSync(join(__dirname, "fixtures/bot26-gameplay-arrival.json"), "utf8")) as { self: string; turn: number; ids: string[]; rows: TickRow[]; taps: TapRecord[] }
  const verdicts = (rows: TickRow[], taps = g.taps) => verdictTable(rows, g.self, lateTaps(rows, taps), taps).turns.find((t) => t.turn === g.turn)!.verdicts
  it("both arrivals were legal in gameplay, so they read missed without the ending bound (the ending read by another document)", () => {
    const rows = g.rows.map((r) => (r.sessionStage === "ending" ? { ...r, documentIdentity: "reloaded" } : r))
    expect(g.ids.map((id) => verdicts(rows, [])[id])).toEqual(["missed", "missed"])
  })
  it("with the page's first ending snapshot and the stalled read, neither had TAP_REACTION_MS of a responsive page: no-opportunity", () => {
    expect(g.ids.map((id) => verdicts(g.rows)[id])).toEqual(["no-opportunity", "no-opportunity"])
  })
  it("the same window on a page that answered every read on time stays missed for the earlier arrival", () => {
    const quick = g.rows.map((r) => (r.sessionStage === "ending" ? { ...r, readStartedAt: new Date(Date.parse(r.snapshotAt!) - 5).toISOString() } : r))
    const v = verdicts(quick)
    expect(Object.values(v).filter((x) => x === "missed").length).toBeGreaterThan(0)
  })
})

describe("a page that first shows a turn in its ending had no votable stage of it (game 399: bot 28)", () => {
  // fixtures/bot28-rejoin-in-ending.json: the page left the waiting room straight into turn 3's ending; the
  // peer reads Unseen through it and Co-player (votable) in the last ending row. The chain filed NotPerson.
  const g = JSON.parse(readFileSync(join(__dirname, "fixtures/bot28-rejoin-in-ending.json"), "utf8")) as { self: string; turn: number; id: string; rows: TickRow[]; taps: TapRecord[] }
  const verdict = (rows: TickRow[], taps: TapRecord[] = g.taps) => verdictTable(rows, g.self, lateTaps(rows, taps), taps).turns.find((t) => t.turn === g.turn)!.verdicts[g.id]
  const turn3 = g.rows.filter((r) => r.sessionTurn === g.turn)
  it("no row of the turn in a votable stage: no-opportunity", () => {
    expect(turn3.some((r) => r.sessionStage !== "ending")).toBe(false)
    expect(verdict(g.rows)).toBe("no-opportunity")
  })
  it("one gameplay row of the turn on the same page, the tile Unseen in it, keeps the old reading", () => {
    const first = turn3[0]
    const early = { ...first, sessionStage: "gameplay", t: "2026-10-11T20:00:30.000Z", snapshotAt: "2026-10-11T20:00:30.000Z", readStartedAt: "2026-10-11T20:00:30.000Z", readCompletedAt: "2026-10-11T20:00:30.000Z" } as TickRow
    expect(verdict([early, ...g.rows])).toBe("unknown")
  })
  it("a tap the bot made on the tile in that turn means it had its chance", () => {
    const tap: TapRecord = { at: "2026-10-11T20:00:42.900Z", turn: g.turn, id: g.id, result: "ok", stage: "ending" }
    expect(verdict(g.rows, [tap])).toBe("unknown")
  })
  it("a reload into the ending (the turn's first row on a document with no waiting row before it) stays unknown", () => {
    const rows = g.rows.map((r) => (r.sessionTurn === g.turn ? { ...r, documentIdentity: "reloaded" } : r))
    expect(verdict(rows)).toBe("unknown")
  })
  it("a 10 s gap between the waiting row and the first ending row may hide the stages the page played: unknown", () => {
    const rows = g.rows.map((r) => {
      if (r.sessionTurn === g.turn || r.stage !== "waiting") return r
      const shift = (v?: string) => (v ? new Date(Date.parse(v) - 10_000).toISOString() : v)
      return { ...r, t: shift(r.t), snapshotAt: shift(r.snapshotAt), readStartedAt: shift(r.readStartedAt), readCompletedAt: shift(r.readCompletedAt) }
    })
    expect(verdict(rows)).toBe("unknown")
  })
  it("a read that starts 100 ms after the waiting row but snapshots 12 s later in the ending may have hidden played stages: unknown", () => {
    const rows = g.rows.map((r) => {
      const first = r === g.rows.find((x) => x.sessionTurn === g.turn)
      return first ? { ...r, readStartedAt: new Date(Date.parse(g.rows.find((x) => x.stage === "waiting" && x.readCompletedAt)!.readCompletedAt!) + 100).toISOString(), snapshotAt: new Date(Date.parse(r.snapshotAt!) + 12_000).toISOString(), readCompletedAt: new Date(Date.parse(r.readCompletedAt!) + 12_000).toISOString() } : r
    })
    expect(verdict(rows)).toBe("unknown")
  })
  it("a waiting snapshot outside its own read bracket (clock skew) is no anchor: unknown", () => {
    const last = g.rows.findLast((x) => x.stage === "waiting")!
    const ending = g.rows.find((x) => x.sessionTurn === g.turn)!
    const rows = g.rows.map((r) => (r === last ? { ...r, snapshotAt: new Date(Date.parse(ending.snapshotAt!) - 100).toISOString() } : r))
    expect(verdict(rows)).toBe("unknown")
  })
  it("a waiting row on another document before the turn's first row stays unknown", () => {
    const rows = g.rows.map((r) => (r.stage === "waiting" ? { ...r, documentIdentity: "before-reload" } : r))
    expect(verdict(rows)).toBe("unknown")
  })
  it("an end row whose session turn differs from the pill turn is no proof", () => {
    const end = turnEnds(g.rows).get(g.turn)!
    const rows = g.rows.map((r) => (r === end ? { ...r, sessionTurn: g.turn + 1 } : r))
    expect(verdict(rows)).not.toBe("no-opportunity")
  })
  it("the same proof holds when the tile is still not votable in the last row (not-votable path)", () => {
    const rows = g.rows.map((r) => (r.sessionTurn === g.turn ? { ...r, tiles: r.tiles?.map((t) => (t.id === g.id ? { ...t, votable: false, attrs: { ...t.attrs, "data-tile-votable": "false" } } : t)) } : r))
    expect(verdict(rows)).toBe("no-opportunity")
  })
  it("a page that never showed the peer (tile absent from the turn's end row) stays not-votable", () => {
    const rows = g.rows.map((r) => (r.sessionTurn === g.turn ? { ...r, tiles: r.tiles?.filter((t) => t.id !== g.id) } : r))
    expect(verdict(rows)).toBe("not-votable")
  })
})

describe("stormVerdict (the tap-storm role's own intent: every votable co-player ended approved)", () => {
  const P = "5G5ADeF3MbuvvfnEg2yJEEbkThgnFHU1T8WE5rkTDEpjkbpV"
  const trail = (players: Record<string, { notPersonTurns: number; autoTurns: number }>): Pick<VoteTrail, "reports"> => ({ reports: [{ ts: 1, filedBy: "auto-confirm", players }] })
  it("a pair still undecided at its turn's end FAILS, by turn (it is a pair, not a turn)", () => {
    const v = stormVerdict([{ turn: 12, id: P }, { turn: 12, id: "5GeMcLaWBBBB" }], [], undefined)
    expect(v.status).toBe("fail")
    expect(v.detail).toContain("2 co-player tile(s) ended undecided or rejected after the storm: turn 12: 5G5ADeF3, 5GeMcLaW")
  })
  it("unobserved pairs pass when the app's own trail counted no NotPerson turn for them (game 194 bot 8)", () => {
    const v = stormVerdict([], [{ turn: 12, id: P }], trail({ [P]: { notPersonTurns: 0, autoTurns: 0 } }))
    expect(v.status).toBe("pass")
    expect(v.detail).toContain("1 tile(s) tapped after their turn's last frame")
  })
  it("unobserved pairs FAIL when the trail counted a NotPerson turn, and are unchecked with no trail", () => {
    expect(stormVerdict([], [{ turn: 12, id: P }], trail({ [P]: { notPersonTurns: 1, autoTurns: 1 } })).status).toBe("fail")
    expect(stormVerdict([], [{ turn: 12, id: P }], { reports: [] }).status).toBe("unchecked")
    expect(stormVerdict([], [{ turn: 12, id: P }], undefined).status).toBe("unchecked")
  })
  it("nothing missed, nothing unobserved: pass", () => {
    expect(stormVerdict([], [], undefined).status).toBe("pass")
  })
})

describe("the recorder's hold (no page read while the page is frozen)", () => {
  it("hold() waits for the read in flight, then no new read starts until release()", async () => {
    const { HoldGate } = await import("./recorder")
    const g = new HoldGate()
    let finish!: () => void
    const inFlight = g.run(() => new Promise<void>((r) => (finish = r)))
    let held = false
    const holding = g.hold().then(() => (held = true))
    await Promise.resolve()
    expect(held).toBe(false)
    finish()
    await inFlight
    await holding
    expect(held).toBe(true)
    expect(g.held).toBe(true)
    let ran = false
    expect(await g.run(async () => void (ran = true))).toBe(false)
    expect(ran).toBe(false)
    g.release()
    expect(await g.run(async () => void (ran = true))).toBe(true)
    expect(ran).toBe(true)
  })

  it("also drains page work registered by the read already in flight", async () => {
    const { HoldGate } = await import("./recorder")
    const g = new HoldGate()
    let finishRead!: () => void
    let finishScreenshot!: () => void
    const read = g.run(async () => {
      await new Promise<void>((resolve) => (finishRead = resolve))
      g.track(new Promise<void>((resolve) => (finishScreenshot = resolve)))
    })
    let held = false
    const holding = g.hold().then(() => (held = true))
    finishRead()
    await read
    await Promise.resolve()
    expect(held).toBe(false)
    finishScreenshot()
    await holding
    expect(held).toBe(true)
  })
})

describe("a Co-player whose tile sat on No signal for a whole shared turn is sealed NotPerson (#574)", () => {
  // The tile reads Co-player, so the app has the co-player seen, and its seal files an untapped turn NotPerson: only the
  // gesture waits for a live feed (seatTakesTap). The oracle cannot read the seat label, so a Co-player tile that never
  // became votable across a turn's gameplay reads (spanning the stage) counts as that turn's no-opportunity NotPerson.
  const T0 = Date.parse("2026-10-10T08:00:00.000Z")
  const tile = (id: string, role: "coplayer" | "host" | "you", votable: boolean, approved = false) => ({
    id,
    role,
    votable,
    tapReady: votable,
    cursorPointer: votable,
    verdict: approved ? "approve" : "pending",
    rotateY: approved ? 180 : 0,
    rotY: approved ? 180 : 0,
    attrs: { "data-tile-role": role },
    text: "",
    aria: [],
    box: { x: 8, y: 277, w: 183, h: 183 },
    visible: true,
    hit: "self",
    tapped: false,
    click: null,
  })
  type Seat = { host: boolean; votable: boolean; approved?: boolean }
  /** A turn's rows: the introduction, four gameplay reads two seconds apart, the ending. */
  const turnRows = (turn: number, seats: Record<string, Seat>): TickRow[] =>
    (["introduction", "gameplay", "gameplay", "gameplay", "gameplay", "ending"] as const).map((sessionStage, i) => {
      const at = new Date(T0 + (turn - 1) * 12_000 + i * 2_000).toISOString()
      const votableNow = sessionStage !== "introduction"
      return {
        t: at,
        readStartedAt: at,
        snapshotAt: at,
        readCompletedAt: at,
        pageGeneration: 0,
        documentIdentity: "document-a",
        viewport: VP,
        stage: sessionStage === "introduction" ? "intro" : "play",
        turn,
        sessionStage,
        sessionTurn: turn,
        ducked: sessionStage === "introduction",
        tiles: [
          tile(SELF, "you", false),
          ...Object.entries(seats).map(([id, s]) => tile(id, s.host ? "host" : "coplayer", s.votable && votableNow, !!s.approved && sessionStage !== "introduction")),
        ],
      } as TickRow
    })
  // one round of three: A (index 0), SELF (index 1, the reporter) and B (index 2); turn t is hosted by seat t-1
  const report = (verdicts: [string, string]): FiledReport => ({
    who: SELF,
    block: 1,
    extrinsic: 0,
    maxGroupSize: 3,
    rounds: [{ ownIndex: 1, members: [{ index: 0, player: A }, { index: 1, player: SELF }, { index: 2, player: B }] }],
    fullReport: [verdicts],
  })
  const check = (rows: TickRow[], verdicts: [string, string]) => {
    const table = verdictTable(rows, SELF)
    return { table, check: checkChainVotes("bot SELF", report(verdicts), [SELF, A, B], false, undefined, { turns: table.turns }) }
  }
  const live = (id: string) => ({ [id]: { host: false, votable: true, approved: true } })
  const dark = (id: string) => ({ [id]: { host: false, votable: false } })
  const hosting = (id: string) => ({ [id]: { host: true, votable: false } })
  // A decodes and is approved every turn it can be voted; B shows No signal for the whole of turns 1 and 2
  const noSignalB = [
    ...turnRows(1, { ...hosting(A), ...dark(B) }),
    ...turnRows(2, { ...live(A), ...dark(B) }),
    ...turnRows(3, { ...live(A), ...hosting(B) }),
  ]

  it("reads each dark turn as no-opportunity, keeps the Co-player role and reports the hit", () => {
    const table = verdictTable(noSignalB, SELF)
    for (const turn of [1, 2]) {
      const t = table.turns.find((x) => x.turn === turn)!
      expect(t.verdicts[B]).toBe("no-opportunity")
      expect(t.roles[B]).toBe("coplayer")
      expect(t.noSignal).toEqual([B])
    }
    expect(table.turns.find((t) => t.turn === 2)?.verdicts[A]).toBe("approved")
    expect(table.turns.find((t) => t.turn === 2)?.noSignal).toEqual([B])
    expect(misses(table)).toEqual([])
  })

  it("expects NotPerson for a co-player dark in every turn, and says how many turns it counted that way", () => {
    const r = check(noSignalB, ["Person", "NotPerson"])
    expect(r.check.status).toBe("pass")
    expect(r.check.detail).toContain("2 co-player turn(s) with a tile never votable (No signal)")
    expect(check(noSignalB, ["Person", "Person"]).check.status).toBe("fail")
  })

  it("mixed round: Person in the turn the tile decoded, No signal the next, ties to NotPerson (not dropped to Person)", () => {
    const mixed = [
      ...turnRows(1, { ...hosting(A), ...live(B) }),
      ...turnRows(2, { ...live(A), ...dark(B) }),
      ...turnRows(3, { ...live(A), ...hosting(B) }),
    ]
    expect(check(mixed, ["Person", "NotPerson"]).check.status).toBe("pass")
    expect(check(mixed, ["Person", "Person"]).check.status).toBe("fail")
  })

  it("control: a co-player decoded and approved during its turns still expects Person", () => {
    const decoded = [
      ...turnRows(1, { ...hosting(A), ...live(B) }),
      ...turnRows(2, { ...live(A), ...live(B) }),
      ...turnRows(3, { ...live(A), ...hosting(B) }),
    ]
    expect(check(decoded, ["Person", "Person"]).check.status).toBe("pass")
    expect(check(decoded, ["Person", "NotPerson"]).check.status).toBe("fail")
  })

  it("control: a tile that took a gesture at any point in the turn is not a No signal tile", () => {
    const rows = turnRows(2, { ...live(A), ...dark(B) })
    const blip = rows.map((r, i) => (i === 3 ? { ...r, tiles: r.tiles!.map((t) => (t.id === B ? { ...t, votable: true, tapReady: true, cursorPointer: true } : t)) } : r))
    expect(verdictTable(blip, SELF).turns[0]?.verdicts[B]).toBe("not-votable")
    expect(verdictTable(rows, SELF).turns[0]?.verdicts[B]).toBe("no-opportunity")
  })

  it("control: one gameplay read cannot show a whole turn on No signal", () => {
    const all = turnRows(2, { ...live(A), ...dark(B) })
    const rows = [all[0], all[1], all[5]]
    expect(verdictTable(rows, SELF).turns[0]?.verdicts[B]).toBe("not-votable")
  })
})

describe("a co-player first decoded in the ending, on a page whose clock runs 75 s ahead (game 317: bot 3)", () => {
  // fixtures/bot3-fastclock-ending-arrival.json: 5EE2TJKa (bot 25) reads Unseen through turn 2's gameplay (Connecting,
  // then Can't connect), Unseen in the ending, then Co-player in the ending; the bot's taps were refused there. The rows are as
  // that run's recorder wrote them, snapshotAt on the page's +75 s clock, so no row reconciled against its read bracket.
  const g = JSON.parse(readFileSync(join(__dirname, "fixtures/bot3-fastclock-ending-arrival.json"), "utf8")) as { self: string; turn: number; id: string; clockOffsetMs: number; rows: TickRow[]; taps: TapRecord[] }
  const verdict = (rows: TickRow[]) => verdictTable(rows, g.self, lateTaps(rows, g.taps), g.taps).turns.find((t) => t.turn === g.turn)!.verdicts[g.id]
  const onRunnerClock = g.rows.map((r) => (r.snapshotAt ? { ...r, snapshotAt: new Date(Date.parse(r.snapshotAt) - g.clockOffsetMs).toISOString() } : r))
  it("as recorded (snapshotAt on the page clock) every row is unreconciled and the arrival reads unknown: the red", () => {
    expect(verdict(g.rows)).toBe("unknown")
  })
  it("on the runner's clock (what readPage now stamps) it is the post-cutoff arrival the app seals NotPerson: no-opportunity", () => {
    expect(verdict(onRunnerClock)).toBe("no-opportunity")
  })
})

describe("a read stall in gameplay does not void the post-cutoff arrival proof (game 334: bot 6)", () => {
  // fixtures/bot6-gameplay-stall-ending-arrival.json: turn 4 of the late joiner's timeline, trimmed to its own tile and
  // 5CigJEmw (bot 4). One gameplay read took 3.5 s to snapshot; 5CigJEmw reads Unseen ("Connecting…") in every row through
  // the ending and Co-player in the ending's last row, already sealed reject. The app filed turn 4 NotPerson for it.
  const g = JSON.parse(readFileSync(join(__dirname, "fixtures/bot6-gameplay-stall-ending-arrival.json"), "utf8")) as { self: string; turn: number; id: string; rows: TickRow[]; taps: TapRecord[] }
  const verdict = (rows: TickRow[]) => verdictTable(rows, g.self, lateTaps(rows, g.taps), g.taps).turns.find((t) => t.turn === g.turn)!.verdicts[g.id]
  const ms = (iso: string, delta: number) => new Date(Date.parse(iso) + delta).toISOString()
  const at = (pick: (r: TickRow) => boolean) => g.rows.findIndex(pick)
  const stall = at((r) => Date.parse(r.snapshotAt!) - Date.parse(r.readStartedAt!) > 3000)
  const arrival = at((r) => r.tiles?.find((t) => t.id === g.id)?.role === "coplayer")
  const lastGameplay = g.rows.findLastIndex((r) => r.sessionTurn === g.turn && r.sessionStage === "gameplay")
  const edit = (i: number, f: (r: TickRow) => TickRow) => g.rows.map((r, j) => (j === i ? f(r) : r))

  it("the fixture is the run's: the stall is in gameplay and the arrival is the ending's last row", () => {
    expect(g.rows[stall].sessionStage).toBe("gameplay")
    expect(g.rows[arrival].sessionStage).toBe("ending")
    expect(g.rows[arrival + 1].sessionTurn).toBe(g.turn + 1)
    expect(g.taps.some((t) => t.id === g.id)).toBe(false)
  })
  it("Unseen on the same page through the ending, then Co-player after the cutoff: no-opportunity", () => {
    expect(verdict(g.rows)).toBe("no-opportunity")
  })
  it("a stall on the last gameplay row (the gameplay→ending witness) still proves nothing: unknown", () => {
    expect(verdict(edit(lastGameplay, (r) => ({ ...r, readStartedAt: ms(r.snapshotAt!, -3000) })))).toBe("unknown")
  })
  it("a stall between the last Unseen ending row and the arrival still proves nothing: unknown", () => {
    const shift = (iso: string) => ms(iso, 2500)
    expect(verdict(edit(arrival, (r) => ({ ...r, readStartedAt: shift(r.readStartedAt!), snapshotAt: shift(r.snapshotAt!), readCompletedAt: shift(r.readCompletedAt!) })))).toBe("unknown")
  })
  it("a Co-player read on the far side of the stall is a gameplay arrival, never laundered into no-opportunity: unknown", () => {
    const seen = edit(stall, (r) => ({ ...r, tiles: r.tiles?.map((t) => (t.id === g.id ? { ...t, role: "coplayer" as const } : t)) }))
    expect(verdict(seen)).toBe("unknown")
  })
  it("a reload inside the turn (another document) still proves nothing: unknown", () => {
    expect(verdict(edit(stall, (r) => ({ ...r, pageGeneration: (r.pageGeneration ?? 0) + 1 })))).toBe("unknown")
  })
})

describe("a co-player Unseen in a turn's last row whose first frame lands in the unrecorded tail is held open (game 323: bot 6)", () => {
  // fixtures/bot6-unseen-tail.json: turn 4's play rows through turn 6's first, trimmed to four tiles. 5CAgroLW
  // reads Unseen ("Connecting…") in every row of turn 4; the last one is a read stalled 888 ms that snapshotted 46 ms
  // before the app sealed the turn with 5CAgroLW auto-rejected. The next row is turn 5's intro, where it hosts, and it
  // reads Co-player in turn 6. 5CBLSmZy and 5EFZjF9i still read Unseen after the boundary.
  const g = JSON.parse(readFileSync(join(__dirname, "fixtures/bot6-unseen-tail.json"), "utf8")) as { self: string; rows: TickRow[]; taps: TapRecord[] }
  const [TAIL, STILL_A, STILL_B] = ["5CAgroLWQcLAHu1UHyBdaWmGJATLmMZg2ato8uN6wVwNEt2k", "5CBLSmZyQaF3J9fckgFxRnRHQ5iyhzskk1rj7LxBahqqkdv5", "5EFZjF9irYHN977NaK1dZ41xZQSPqW9fX2q2d8RBj2Krh1NT"]
  const turn4 = (rows: TickRow[], taps: TapRecord[] = g.taps) => verdictTable(rows, g.self, lateTaps(rows, taps), taps).turns.find((t) => t.turn === 4)!
  const roleIn = (row: TickRow, id: string) => row.tiles?.find((t) => t.id === id)?.role

  it("turn 4's last row reads all three Unseen, and only the tail co-player reads Co-player at the next row that tells", () => {
    const t = turn4(g.rows)
    expect([TAIL, STILL_A, STILL_B].map((id) => t.verdicts[id])).toEqual(["unseen", "unseen", "unseen"])
    expect(t.unseenTail).toEqual([TAIL])
  })
  it("a later row that still reads Unseen after the boundary closes the tail", () => {
    const rows = g.rows.map((r) => (r.sessionTurn === 6 && r.tiles ? { ...r, tiles: r.tiles.map((x) => (x.id === TAIL ? { ...x, role: "unseen" as const } : x)) } : r))
    expect(turn4(rows).unseenTail).toEqual([])
  })
  it("a row without the tile, or from another page, between the two proves nothing", () => {
    const end = g.rows.findLastIndex((r) => r.sessionTurn === 4)
    const gap = g.rows.map((r, i) => (i === end + 1 ? { ...r, tiles: r.tiles?.filter((x) => x.id !== TAIL) } : r))
    expect(turn4(gap).unseenTail).toEqual([])
    const reload = g.rows.map((r, i) => (i > end ? { ...r, pageGeneration: (r.pageGeneration ?? 0) + 1 } : r))
    expect(turn4(reload).unseenTail).toEqual([])
  })
  it("the bot's own landed tap on it in that turn means it was seen while the page still recorded: no tail", () => {
    const tap = { at: g.rows.findLast((r) => r.sessionTurn === 4)!.snapshotAt!, turn: 4, id: TAIL, result: "ok", stage: "gameplay" }
    expect(turn4(g.rows, [...g.taps, tap]).unseenTail).toEqual([])
  })
  it("the fixture is the run's: the Host rows in between are skipped, not read as Unseen", () => {
    const end = g.rows.findLastIndex((r) => r.sessionTurn === 4)
    expect(roleIn(g.rows[end], TAIL)).toBe("unseen")
    expect(roleIn(g.rows[end + 1], TAIL)).toBe("host")
    expect(roleIn(g.rows.find((r) => r.sessionTurn === 6 && !!r.tiles?.length)!, TAIL)).toBe("coplayer")
  })
})

type RealCase = { self: string; turn: number; id: string; rows: TickRow[]; taps: TapRecord[] }
const realCase = (name: string) => JSON.parse(readFileSync(join(__dirname, "fixtures", name), "utf8")) as RealCase

describe("a Co-player tile that first turns votable on the ending's own first row is the post-cutoff auto-reject (27 Oct: bots 31 and 1)", () => {
  // The app's sessionStage leads the DOM stage the turn's end row is picked by. Both pages come from the waiting room
  // (rows with no sessionStage), read the tile Unseen through gameplay and votable on the very row the ending starts;
  // every tap on it was skipped (page showed ending) and the app sealed the turn NotPerson.
  for (const name of ["ending-first-frame-bot31.json", "ending-first-frame-bot1.json"]) {
    const g = realCase(name)
    const verdict = (rows: TickRow[], taps: TapRecord[] = g.taps) => verdictTable(rows, g.self, lateTaps(rows, taps), taps).turns.find((t) => t.turn === g.turn)!.verdicts[g.id]
    const firstEnding = g.rows.findIndex((r) => r.sessionTurn === g.turn && r.sessionStage === "ending")
    describe(name, () => {
      it("is no-opportunity", () => {
        expect(verdict(g.rows)).toBe("no-opportunity")
        expect(misses(verdictTable(g.rows, g.self, lateTaps(g.rows, g.taps), g.taps))).toEqual([])
      })
      it("stays unknown on rows that carry no sessionStage (older artifacts)", () => {
        expect(verdict(g.rows.map((r) => ({ ...r, sessionStage: undefined, sessionTurn: undefined })))).toBe("unknown")
      })
      it("a gameplay row of the turn where the tile was votable keeps it out of no-opportunity", () => {
        const rows = g.rows.map((r, i) =>
          i === firstEnding - 1 ? { ...r, tiles: r.tiles?.map((x) => (x.id === g.id ? { ...x, role: "coplayer" as const, votable: true, attrs: { ...x.attrs, "data-tile-role": "coplayer", "data-tile-votable": "true" } } : x)) } : r,
        )
        expect(verdict(rows)).not.toBe("no-opportunity")
      })
      it("a ducked first ending row is no proof", () => {
        const rows = g.rows.map((r, i) => (i === firstEnding ? { ...r, ducked: true } : r))
        expect(verdict(rows)).not.toBe("no-opportunity")
      })
      it("a tap that reached the tile in that turn means it had its chance", () => {
        const tap: TapRecord = { ...g.taps[0], result: "error: click timed out", stage: "gameplay" }
        expect(verdict(g.rows, [tap])).toBe("unknown")
      })
    })
  }
})

describe("a co-player first seen after voting closed, with the waiting room's Unseen tile before the turn (game 1592: bots 4, 12)", () => {
  // fixtures/bot4-late-ending-arrival.json: bot 4's page draws bot 12's tile Unseen in the waiting room, the intro,
  // all of gameplay and the first four ending rows, then reads it Co-player, votable and ready at the fifth ending row,
  // after the app closed voting. The bot's taps were skipped (page showed ending) and the app sealed the turn NotPerson.
  const g = realCase("bot4-late-ending-arrival.json")
  const verdict = (rows: TickRow[], taps: TapRecord[] = g.taps) => verdictTable(rows, g.self, lateTaps(rows, taps), taps).turns.find((t) => t.turn === g.turn)!.verdicts[g.id]
  const arrival = g.rows.findIndex((r) => r.tiles?.find((t) => t.id === g.id)?.role === "coplayer")
  const ms = (iso: string, delta: number) => new Date(Date.parse(iso) + delta).toISOString()
  const edit = (i: number, f: (r: TickRow) => TickRow) => g.rows.map((r, j) => (j === i ? f(r) : r))
  const shifted = (r: TickRow, delta: number): TickRow => ({ ...r, readStartedAt: ms(r.readStartedAt!, delta), snapshotAt: ms(r.snapshotAt!, delta), readCompletedAt: ms(r.readCompletedAt!, delta) })
  const asVotable = (r: TickRow): TickRow => ({
    ...r,
    tiles: r.tiles?.map((x) => (x.id === g.id ? { ...x, role: "coplayer" as const, votable: true, tapReady: true, attrs: { ...x.attrs, "data-tile-role": "coplayer", "data-tile-votable": "true", "data-tile-tap-ready": "true" } } : x)),
  })

  it("the fixture is the run's: waiting rows (no session turn) with the tile Unseen, Unseen gameplay and ending rows, Co-player in the ending", () => {
    const waiting = g.rows.filter((r) => r.stage === "waiting")
    expect(waiting.length).toBeGreaterThan(0)
    for (const r of waiting) {
      expect(r.sessionTurn).toBeNull()
      expect(r.tiles?.find((t) => t.id === g.id)?.role).toBe("unseen")
    }
    expect(g.rows[arrival].sessionStage).toBe("ending")
    expect(g.rows[arrival - 1].sessionStage).toBe("ending")
    expect(g.taps.every((t) => t.result.startsWith("skipped: page showed"))).toBe(true)
  })
  it("is no-opportunity", () => {
    expect(verdict(g.rows)).toBe("no-opportunity")
    expect(misses(verdictTable(g.rows, g.self, lateTaps(g.rows, g.taps), g.taps))).toEqual([])
  })
  it("a recorder gap spanning the cutoff proves nothing: unknown", () => {
    const lastGameplay = g.rows.findLastIndex((r) => r.sessionStage === "gameplay")
    expect(verdict(g.rows.map((r, i) => (i > lastGameplay ? shifted(r, 2500) : r)))).toBe("unknown")
  })
  it("a gap between the last Unseen ending row and the arrival proves nothing: unknown", () => {
    expect(verdict(g.rows.map((r, i) => (i >= arrival ? shifted(r, 2500) : r)))).toBe("unknown")
  })
  it("a votable Co-player tile in gameplay is a miss, not an excuse", () => {
    const [a, b] = g.rows.map((r, i) => [r, i] as const).filter(([r]) => r.sessionStage === "gameplay").slice(10, 12).map(([, i]) => i)
    expect(verdict(g.rows.map((r, i) => (i === a || i === b ? asVotable(r) : r)))).toBe("missed")
  })
  it("a Co-player tile not yet votable in gameplay is not an Unseen turn: unknown", () => {
    const i = g.rows.findLastIndex((r) => r.sessionStage === "gameplay")
    const seen = edit(i, (r) => ({ ...r, tiles: r.tiles?.map((x) => (x.id === g.id ? { ...x, role: "coplayer" as const, attrs: { ...x.attrs, "data-tile-role": "coplayer" } } : x)) }))
    expect(verdict(seen)).toBe("unknown")
  })
  it("a waiting-room row from another page, an error row, or one after the turn began still audits: unknown", () => {
    expect(verdict(g.rows.map((r) => (r.stage === "waiting" ? { ...r, documentIdentity: "other-page" } : r)))).toBe("unknown")
    expect(verdict(edit(0, (r) => ({ ...r, error: "controlled read gap" })))).toBe("unknown")
    const firstTurnRow = g.rows.findIndex((r) => r.sessionTurn === g.turn)
    expect(verdict(edit(firstTurnRow + 3, (r) => ({ ...r, stage: "waiting" as const, sessionStage: "none", sessionTurn: null })))).toBe("unknown")
  })
  it("a reload inside the turn (rows before the arrival on another document) proves nothing: unknown", () => {
    const i = g.rows.findIndex((r) => r.sessionStage === "gameplay") + 5
    expect(verdict(g.rows.map((r, j) => (j >= i && j < arrival ? { ...r, pageGeneration: (r.pageGeneration ?? 0) + 1 } : r)))).toBe("unknown")
  })
  it("a waiting-room flicker with the tile in the middle of the turn, after turn rows without it, is not a leading row: unknown", () => {
    const flicker = g.rows.findIndex((r) => r.sessionStage === "gameplay") + 2
    const noTile = g.rows.map((r, j) => (r.sessionTurn === g.turn && j < flicker ? { ...r, tiles: r.tiles?.filter((x) => x.id !== g.id) } : r))
    expect(verdict(noTile)).toBe("no-opportunity")
    expect(verdict(noTile.map((r, j) => (j === flicker ? { ...r, stage: "waiting" as const, sessionStage: "none", sessionTurn: null } : r)))).toBe("unknown")
  })
  it("a leading waiting row that does not read the tile Unseen is not skipped: unknown", () => {
    expect(verdict(edit(0, (r) => ({ ...r, tiles: r.tiles?.map((x) => (x.id === g.id ? { ...x, role: "empty" as const, attrs: { ...x.attrs, "data-tile-role": "empty" } } : x)) })))).toBe("unknown")
  })
})

describe("a co-player whose first frame reached the page at the gameplay-to-ending cutoff is no opportunity (game 1587: bots 16, 31)", () => {
  const verdictOf = (g: RealCase, rows: TickRow[], taps: TapRecord[] = g.taps) => verdictTable(rows, g.self, lateTaps(rows, taps), taps).turns.find((t) => t.turn === g.turn)!.verdicts[g.id]
  const withTile = (g: RealCase, pick: (r: TickRow) => boolean, patch: Record<string, unknown>, attrs: Record<string, string> = {}) =>
    g.rows.map((r) => (pick(r) ? { ...r, tiles: r.tiles?.map((x) => (x.id === g.id ? { ...x, ...patch, attrs: { ...x.attrs, ...attrs } } : x)) } : r))
  const gameplay = (g: RealCase) => (r: TickRow) => r.sessionTurn === g.turn && r.sessionStage === "gameplay"
  const votable = { role: "coplayer", votable: true, tapReady: true }
  const votableAttrs = { "data-tile-role": "coplayer", "data-tile-votable": "true", "data-tile-tap-ready": "true" }

  describe("the page's waiting-room rows carry no tiles and sit inside the turn's lower bound (bot 31)", () => {
    const g = realCase("bot31-first-turn-cutoff-arrival.json")
    it("is no-opportunity", () => {
      expect(g.rows.some((r) => r.stage === "waiting" && !r.tiles?.length)).toBe(true)
      expect(verdictOf(g, g.rows)).toBe("no-opportunity")
      expect(misses(verdictTable(g.rows, g.self, lateTaps(g.rows, g.taps), g.taps))).toEqual([])
    })
    it("a waiting-room row from another page, or without a consistent snapshot time, is no proof", () => {
      expect(verdictOf(g, g.rows.map((r) => (r.stage === "waiting" ? { ...r, documentIdentity: "other-page" } : r)))).toBe("unknown")
      expect(verdictOf(g, g.rows.map((r) => (r.stage === "waiting" ? { ...r, snapshotAt: undefined } : r)))).toBe("unknown")
    })
    it("a waiting-room row after a play row, an error row, or a play row without the tile is still a gap", () => {
      const firstPlay = g.rows.findIndex((r) => r.stage === "play")
      const moved = [...g.rows.slice(0, 1), ...g.rows.slice(firstPlay, firstPlay + 1), ...g.rows.slice(1, firstPlay), ...g.rows.slice(firstPlay + 1)]
      expect(verdictOf(g, moved)).toBe("unknown")
      expect(verdictOf(g, g.rows.map((r, i) => (i === 1 ? { ...r, error: "controlled read gap" } : r)))).toBe("unknown")
      expect(verdictOf(g, g.rows.map((r, i) => (i === 1 ? { ...r, stage: "play" as const, tiles: [] } : r)))).toBe("unknown")
    })
    it("a tile the page read votable through the gameplay is a miss, not an excuse", () => {
      expect(verdictOf(g, withTile(g, gameplay(g), votable, votableAttrs))).toBe("missed")
    })
  })

  describe("the last gameplay rows show the tile Co-player but not votable (bot 16)", () => {
    const g = realCase("bot16-coplayer-unvotable-at-cutoff.json")
    const firstEnding = g.rows.findIndex((r) => r.sessionTurn === g.turn && r.sessionStage === "ending")
    const atEnding = (r: TickRow) => r === g.rows[firstEnding]
    const unvotable = { role: "coplayer", votable: false, tapReady: false }
    it("is no-opportunity", () => {
      expect(verdictOf(g, g.rows)).toBe("no-opportunity")
      expect(misses(verdictTable(g.rows, g.self, lateTaps(g.rows, g.taps), g.taps))).toEqual([])
    })
    it("accepts an ending's first row that is not votable yet, and refuses a contradictory one", () => {
      expect(verdictOf(g, withTile(g, atEnding, unvotable))).toBe("no-opportunity")
      expect(verdictOf(g, withTile(g, atEnding, { votable: true, tapReady: false }))).toBe("unknown")
      expect(verdictOf(g, withTile(g, atEnding, { votable: false, tapReady: true }))).toBe("unknown")
    })
    it("a Co-player tile that stayed unvotable for seconds of the gameplay is not an excuse (the stretch is bounded)", () => {
      const firstGameplay = g.rows.findIndex(gameplay(g))
      expect(verdictOf(g, withTile(g, (r) => gameplay(g)(r) && r !== g.rows[firstGameplay], unvotable, { "data-tile-role": "coplayer" }))).toBe("unknown")
    })
    it("a recorder gap between the last Unseen row and the Co-player rows hides a stretch that may have been votable", () => {
      const lastUnseen = g.rows.findLastIndex((r) => gameplay(g)(r) && r.tiles?.find((x) => x.id === g.id)?.role === "unseen")
      const gap = (v?: string) => (v ? new Date(Date.parse(v) - 5000).toISOString() : v)
      // rows up to the last Unseen one are read 5 s earlier: the Co-player rows keep their times, and the gap is the page's
      const rows = g.rows.map((r, i) => (i <= lastUnseen ? { ...r, t: gap(r.t)!, readStartedAt: gap(r.readStartedAt), snapshotAt: gap(r.snapshotAt), readCompletedAt: gap(r.readCompletedAt) } : r))
      expect(verdictOf(g, rows)).toBe("unknown")
    })
    it("a tile votable through the gameplay is a miss", () => {
      expect(verdictOf(g, withTile(g, gameplay(g), votable, votableAttrs))).toBe("missed")
    })
    it("a tap that reached the tile in that turn means it had its chance", () => {
      const tap: TapRecord = { at: g.rows[firstEnding - 1].snapshotAt!, turn: g.turn, id: g.id, result: "error: click timed out", stage: "gameplay" }
      expect(verdictOf(g, g.rows, [tap])).toBe("unknown")
    })
  })
})

describe("a late joiner's host, absent before its hosted turn, is held open as a hosted first frame (26 Oct: bot 31)", () => {
  // The page came from the waiting room (no tiles), saw the host only as Host in turn 6, then as Co-player in the
  // round-change row, and never again after the player left for another group.
  const g = realCase("hosted-first-frame-late-joiner.json")
  const hosted = (rows: TickRow[]) => verdictTable(rows, g.self, lateTaps(rows, g.taps), g.taps).turns.find((t) => t.turn === g.turn)!.hostedFirstFrame
  const setRole = (role: "unseen" | "coplayer" | "host", pick: (r: TickRow) => boolean) =>
    g.rows.map((r) => (pick(r) && r.tiles ? { ...r, tiles: r.tiles.map((x) => (x.id === g.id ? { ...x, role } : x)) } : r))
  it("is listed", () => {
    expect(hosted(g.rows)).toEqual([g.id])
  })
  it("an earlier row that already read the player Co-player is no arrival", () => {
    expect(hosted(setRole("coplayer", (r) => r.stage === "waiting" || r === g.rows[g.rows.findIndex((x) => x.sessionTurn === g.turn)]))).toEqual([])
  })
  it("is the absent-before kind, and a page that showed the host Unseen first is the other kind", () => {
    const table = (rows: TickRow[]) => verdictTable(rows, g.self, lateTaps(rows, g.taps), g.taps).turns.find((t) => t.turn === g.turn)!
    expect(table(g.rows).hostedAbsentBefore).toEqual([g.id])
    const firstTurn = g.rows.findIndex((r) => r.sessionTurn === g.turn)
    const unseenFirst = g.rows.map((r, i) => (i === firstTurn - 1 ? { ...r, stage: "play" as const, sessionStage: "ending", sessionTurn: g.turn - 1, ducked: false, tiles: [{ ...g.rows[firstTurn].tiles![0], id: g.id, role: "unseen" as const }] } : r))
    const t = table(unseenFirst)
    expect(t.hostedFirstFrame).toEqual([g.id])
    expect(t.hostedAbsentBefore).toEqual([])
  })
  it("play rows without the player before the turn (a recording gap) are not an absence", () => {
    const firstTurn = g.rows.findIndex((r) => r.sessionTurn === g.turn)
    const gap = g.rows.map((r, i) => (i === firstTurn - 1 ? { ...r, stage: "play" as const, tiles: r.tiles?.filter((x) => x.id !== g.id) } : r))
    expect(hosted(gap)).toEqual([])
  })
  it("an error row before the turn is not an absence", () => {
    const firstTurn = g.rows.findIndex((r) => r.sessionTurn === g.turn)
    const withError = [...g.rows.slice(0, firstTurn), { t: g.rows[firstTurn].t, error: "controlled read gap" } as TickRow, ...g.rows.slice(firstTurn)]
    expect(hosted(withError)).toEqual([])
  })
  it("a round-change row that still reads Unseen is no arrival", () => {
    expect(hosted(setRole("unseen", (r) => r.sessionStage === "none" && !!r.tiles?.some((x) => x.id === g.id && x.role === "coplayer")))).toEqual([])
  })
})

describe("a host whose first frame may have decoded inside the turn it hosts is held open (game 327: bot 27)", () => {
  // fixtures/bot27-hosted-first-frame.json: turn 5's ending through the round change after turn 6. 5EFNJJ8n reads
  // Unseen through turn 5, Host for the whole of turn 6 (its first frame decoded 1 s before the seal, hidden by the
  // Host tile) and Co-player in the round-change row 0.24 s after the turn's last row.
  const g = JSON.parse(readFileSync(join(__dirname, "fixtures/bot27-hosted-first-frame.json"), "utf8")) as { self: string; rows: TickRow[]; taps: TapRecord[] }
  const HOST = "5EFNJJ8nPaQP7D8REQctLx19LhyjQu2LeHAQHfw1pnMH8vKS"
  const turn6 = (rows: TickRow[]) => verdictTable(rows, g.self, lateTaps(rows, g.taps), g.taps).turns.find((t) => t.turn === 6)!
  const last = g.rows.findLastIndex((r) => r.sessionTurn === 6 && r.sessionStage === "ending" && !r.ducked)
  const setRole = (rows: TickRow[], from: number, role: "unseen" | "coplayer" | "host") =>
    rows.map((r, i) => (i >= from && r.tiles ? { ...r, tiles: r.tiles.map((x) => (x.id === HOST ? { ...x, role } : x)) } : r))

  it("the fixture's turn 6 ends on a Host tile, and the host is listed", () => {
    expect(g.rows[last].tiles?.find((t) => t.id === HOST)?.role).toBe("host")
    expect(g.rows[last + 1].tiles?.find((t) => t.id === HOST)?.role).toBe("coplayer")
    expect(turn6(g.rows).hostedFirstFrame).toEqual([HOST])
  })
  it("a row that still reads Unseen after the turn, or one that already read Co-player before it, is no arrival", () => {
    expect(turn6(setRole(g.rows, last + 1, "unseen")).hostedFirstFrame).toEqual([])
    const before = g.rows.map((r, i) => (i < g.rows.findIndex((x) => x.sessionTurn === 6) && r.tiles ? { ...r, tiles: r.tiles.map((x) => (x.id === HOST ? { ...x, role: "coplayer" as const } : x)) } : r))
    expect(turn6(before).hostedFirstFrame).toEqual([])
  })
  it("a row without the tile, or from another page, between the two proves nothing", () => {
    const gap = g.rows.map((r, i) => (i === last + 1 ? { ...r, tiles: r.tiles?.filter((x) => x.id !== HOST) } : r))
    expect(turn6(gap).hostedFirstFrame).toEqual([])
    const reload = g.rows.map((r, i) => (i > last ? { ...r, pageGeneration: (r.pageGeneration ?? 0) + 1 } : r))
    expect(turn6(reload).hostedFirstFrame).toEqual([])
  })
  it("a recorder hole of seconds before the Co-player row leaves room for a frame after the seal: no arrival", () => {
    const shift = (iso: string | undefined) => new Date(Date.parse(iso!) + 3000).toISOString()
    const holed = g.rows.map((r, i) => (i > last ? { ...r, readStartedAt: shift(r.readStartedAt), snapshotAt: shift(r.snapshotAt), readCompletedAt: shift(r.readCompletedAt) } : r))
    expect(turn6(holed).hostedFirstFrame).toEqual([])
  })
  it("a host that never reads Host in the turn's end row is not listed", () => {
    expect(turn6(setRole(g.rows, 0, "coplayer")).hostedFirstFrame).toEqual([])
  })
})
