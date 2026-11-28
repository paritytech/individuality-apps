// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { chainOffsetAt, earlyCloseCheck, MAX_BUILT_TO_CLOSE_S, type EarlyCloseInput, type TrailLine } from "./early-close"

const fixture = JSON.parse(readFileSync(join(__dirname, "fixtures", "bot13-early-close.json"), "utf8")) as {
  ended: { block: number; atS: number }
  reportEnds: number
  playEndsS: number
  lines: TrailLine[]
}
const game327 = (over: Partial<EarlyCloseInput> = {}): EarlyCloseInput => ({
  slot: 13,
  reported: false,
  ended: fixture.ended,
  reportEnds: fixture.reportEnds,
  lines: fixture.lines,
  playEndsS: fixture.playEndsS,
  ...over,
})
const at = (message: string) => fixture.lines.find((l) => l.message === message)!.ts

describe("earlyCloseCheck (game 327, bot 13)", () => {
  it("a chain that ended the game before report_ends, and an app that built its report, filed nothing and went on to the chest, is inconclusive", () => {
    const c = earlyCloseCheck(game327())
    expect(c.status).toBe("inconclusive")
    expect(c.name).toBe("player 13 report closed early by the chain")
    expect(c.detail).toContain("GameEnded in #331602 (block time 20:02:48.000 UTC), 432 s before report_ends")
    expect(c.detail).toContain("On the page clock (UTC) the app built its report at 20:02:48.494 and filed nothing")
    expect(c.detail).toContain('left /game with "report unknown after the game" at 20:02:56.247')
  })

  it("a submit that failed while the window was open stays red: that report could have counted", () => {
    const failed = { ts: at("report built") + 2000, tag: "vote", message: "report attempt failed" }
    const c = earlyCloseCheck(game327({ lines: [...fixture.lines, failed].sort((a, b) => a.ts - b.ts) }))
    expect(c.status).toBe("fail")
    expect(c.detail).toContain('"report attempt failed" at 20:02:50.494 UTC')
  })

  it("a retry is the same failure", () => {
    const retry = { ts: at("report built") + 1500, tag: "vote", message: "report retry" }
    expect(earlyCloseCheck(game327({ lines: [...fixture.lines, retry] })).status).toBe("fail")
  })

  it("a game that ended at or after report_ends proves no early close: the window ran its length", () => {
    const c = earlyCloseCheck(game327({ ended: { block: 331675, atS: fixture.reportEnds } }))
    expect(c.status).toBe("fail")
    expect(c.detail).toContain("the window ran its whole length")
  })

  it("a forced end (testnet_force_end_reporting moved report_ends to its own block) is no early close", () => {
    const c = earlyCloseCheck(game327({ ended: { ...fixture.ended, reportEnds: fixture.ended.atS } }))
    expect(c.status).toBe("fail")
    expect(c.detail).toContain("the window ran its whole length")
  })

  it("the report_ends held just before the end wins over the one read before play", () => {
    expect(earlyCloseCheck(game327({ ended: { ...fixture.ended, reportEnds: fixture.reportEnds }, reportEnds: 0 })).status).toBe("inconclusive")
  })

  it("no GameEnded seen proves nothing", () => {
    expect(earlyCloseCheck(game327({ ended: null })).status).toBe("fail")
  })

  it("a GameEnded whose block time could not be read proves nothing either", () => {
    const c = earlyCloseCheck(game327({ ended: { block: 331602, atS: null } }))
    expect(c.status).toBe("fail")
    expect(c.detail).toContain("block time could not be read")
  })

  it("a trail that never says why the app left /game stays red", () => {
    const lines = fixture.lines.filter((l) => l.message !== "report unknown after the game")
    const c = earlyCloseCheck(game327({ lines }))
    expect(c.status).toBe("fail")
    expect(c.detail).toContain("never says why it left /game")
  })

  it("puts the build on the chain clock through the page's own offset (-10 s from 22:00:05 CEST)", () => {
    expect(chainOffsetAt(fixture.lines, at("report built"))).toBe(-10)
    expect(chainOffsetAt(fixture.lines, 0)).toBeNull()
  })

  it("starts at 0 on clock ready, takes the correction, corrected and jumped lines, and skips other clock lines", () => {
    const lines: TrailLine[] = [
      { ts: 1, tag: "clock", message: "clock ready", data: { gapMs: 400, late: false } },
      { ts: 2, tag: "clock", message: "clock correction", data: { via: "peer", fromMs: 0, toMs: -7_350, speed: 0.25 } },
      { ts: 3, tag: "clock", message: "handover offset", data: { game: 7, offsetMs: -9_000, method: "peer" } },
      { ts: 4, tag: "clock", message: "clock corrected", data: { offsetMs: -7_600 } },
      { ts: 5, tag: "clock", message: "clock jumped", data: { reason: "game", fromMs: -7_600, toMs: -6_000 } },
    ]
    expect(chainOffsetAt(lines, 1)).toBe(0)
    expect(chainOffsetAt(lines, 3)).toBe(-7.35)
    expect(chainOffsetAt(lines, 4)).toBe(-7.6)
    expect(chainOffsetAt(lines, 5)).toBe(-6)
  })

  it("a clock ready line after the first chain jump does not reset the offset", () => {
    const lines: TrailLine[] = [
      { ts: 1, tag: "clock", message: "clock correction", data: { via: "chain", fromMs: 0, toMs: -7_185_000, speed: "jump" } },
      { ts: 2, tag: "clock", message: "clock ready", data: { gapMs: 7_200_000, late: false } },
    ]
    expect(chainOffsetAt(lines, 2)).toBe(-7_185)
  })

  it("a report built minutes before the close had time to land: a hung or never-broadcast submit stays red", () => {
    // the same build, 3 minutes earlier: no trail line says the submit failed, only the gap does
    const early = at("report built") - 180_000
    const lines = fixture.lines.map((l) => (l.message === "report built" ? { ...l, ts: early } : l))
    const c = earlyCloseCheck(game327({ lines }))
    expect(c.status).toBe("fail")
    expect(c.detail).toContain(`more than ${MAX_BUILT_TO_CLOSE_S} s`)
  })

  it("bot 13's own build sat 9.5 s before the close on the chain clock, inside the bound", () => {
    const builtS = at("report built") / 1000 - 10
    expect(fixture.ended.atS - builtS).toBeCloseTo(9.506, 2)
    expect(earlyCloseCheck(game327()).status).toBe("inconclusive")
  })

  it("a page with no chain-clock line cannot place its build against the close, so it stays red", () => {
    const c = earlyCloseCheck(game327({ lines: fixture.lines.filter((l) => l.tag !== "clock") }))
    expect(c.status).toBe("fail")
    expect(c.detail).toContain("no chain-clock offset")
  })

  it("no report built while play was long over stays red; none built just before the close is still moot", () => {
    const lines = fixture.lines.filter((l) => l.message !== "report built")
    const late = earlyCloseCheck(game327({ lines, playEndsS: fixture.ended.atS - 120 }))
    expect(late.status).toBe("fail")
    expect(late.detail).toContain("built no report although play ended 120 s before GameEnded")
    const c = earlyCloseCheck(game327({ lines }))
    expect(c.status).toBe("inconclusive")
    expect(c.detail).toContain("the app built no report")
  })

  it("a missed report (#303) after the early close is the same chest handover", () => {
    const lines = fixture.lines.map((l) => (l.message === "report unknown after the game" ? { ...l, message: "report missed" } : l))
    expect(earlyCloseCheck(game327({ lines })).status).toBe("inconclusive")
  })

  it("a report that landed is a pass", () => {
    expect(earlyCloseCheck(game327({ reported: true })).status).toBe("pass")
  })
})
