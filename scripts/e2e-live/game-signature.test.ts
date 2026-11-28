// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { compareRuns, main, NotComparable, parseArgs, readRun, renderComparison, renderSignature, signBot, type BotSignature, type DevLog, type RunSignature } from "./game-signature.mts"

// Every fixture is an excerpt of a REAL record from the six-bot wave specialist-03: game 1357
// (a live run) and game 1431 (a live run). Bot 1 is game259-dropped-lane-rebuild (the
// faulted link's initiator), bot 3 is locale-la-enus (the other end of that link).
const fixture = <T,>(name: string): T => JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", name), "utf8")) as T
/** the fixture set of each game, in fixtures/ */
const FIXTURE_RUN = { 1357: "run-o", 1431: "run-r" } as const
const sign = (game: 1357 | 1431, slot: 1 | 3) =>
  signBot({ slot, log: fixture<DevLog>(`${FIXTURE_RUN[game]}-signature-bot${slot}-devlog.json`), result: fixture(`${FIXTURE_RUN[game]}-signature-bot${slot}-result.json`) })

const BOT1 = "5ENU9kDJncCMuK64pTy4cPTvAePChT22bf5tjhLLYUfD7Ku7"
const BOT2 = "5GNCrXDAVfKkLK6hXAATYjEAsevK3fbYmuAGqRdBMdWx2Z9R"
const BOT3 = "5HjBMBesAzNXXGxLDFyu8zA4ybHuPnakRN5etiES4vxzWRSW"

describe("signBot: one bot's links", () => {
  it("reads the account and one link per co-player", () => {
    const s = sign(1357, 1)
    expect(s.account).toBe(BOT1)
    expect(s.links).toHaveLength(5)
    expect(s.links.map((l) => l.peer)).toContain(BOT3)
  })

  it("measures connect time as mesh open to pc connected on the same page clock", () => {
    const link = sign(1357, 1).links.find((l) => l.peer === BOT2)!
    // mesh open 951177, pc connected 951647 (devlog ts, one bot's clock)
    expect(link.connectMs).toBe(470)
  })

  it("takes first-video from the mesh's own monotonic figure on a clean link", () => {
    const link = sign(1357, 1).links.find((l) => l.peer === BOT2)!
    expect(link.firstVideoMs).toBe(2864)
    expect(link.recoveries).toEqual([])
  })

  it("anchors the faulted link at the injector line and measures fault to recovery", () => {
    const link = sign(1357, 1).links.find((l) => l.peer === BOT3)!
    // [e2e-data-channel-fault] dropped renegotiation offer at 951595, round-link first-video fault=offer-1 at 971182
    expect(link.recoveries).toEqual([19587])
    expect(link.decisions).toEqual(["new-remote-session → rebuild"])
  })

  it("anchors the other end at its first decision and canonicalises the sequence", () => {
    const link = sign(1357, 3).links.find((l) => l.peer === BOT1)!
    expect(link.decisions).toEqual(["media-stall → rebuild", "self-heal → rebuild (attempt 1)"])
    expect(link.recoveries).toEqual([920])
    expect(link.maxAttempt).toBe(1)
  })

  it("counts the rounds that reached first video", () => {
    expect(sign(1357, 1).links.every((l) => l.videoRounds === 2)).toBe(true)
  })
})

describe("signBot: the bot and its outcomes", () => {
  it("reads completion, persona, group size and commit from the result", () => {
    const s = sign(1357, 1)
    expect(s.persona).toBe("game259-dropped-lane-rebuild")
    expect(s.complete).toBe(true)
    expect(s.game).toBe(1357)
    expect(s.groupSizes).toEqual([6, 6])
    expect(s.commit).toBe("fb725693a0453f06b84fd3a3432d0305d4917224")
  })

  it("is not complete when the report was never seen", () => {
    const result = { ...fixture<Record<string, unknown>>("run-o-signature-bot1-result.json"), reportSeen: false }
    const s = signBot({ slot: 1, log: fixture<DevLog>("run-o-signature-bot1-devlog.json"), result })
    expect(s.complete).toBe(false)
  })

  it("files the vote for every co-player from the trail's report", () => {
    const link = sign(1357, 1).links.find((l) => l.peer === BOT2)!
    expect(link.vote).toEqual({ verdict: "person", personTurns: 10, notPersonTurns: 0, source: "majority" })
  })

  it("covers a seat-turn when frames were decoded across it", () => {
    const link = sign(1357, 1).links.find((l) => l.peer === BOT2)!
    expect(link.turns).toBe(4)
    expect(link.coveredTurns).toBe(4)
  })

  it("says every link was connected before the turn-0 introduction", () => {
    const s = sign(1357, 1)
    expect(s.links.every((l) => l.connectedBeforeTurn0 === true)).toBe(true)
    // the slowest link of this bot: 1792901952285 - 951177 mesh open
    expect(s.allConnectedMs).toBe(1108)
  })

  it("marks a link that never connected as Infinity and not connected before turn 0", () => {
    const log = fixture<DevLog>("run-o-signature-bot1-devlog.json")
    const gone = { ...log, lines: log.lines.filter((l) => !(l.message.startsWith("[jollity-rtc] pc " + BOT2) )) }
    const link = signBot({ slot: 1, log: gone, result: null }).links.find((l) => l.peer === BOT2)!
    expect(link.connectMs).toBe(Infinity)
    expect(link.connectedBeforeTurn0).toBe(false)
  })
})

describe("readRun: a downloaded run", () => {
  const dirs: string[] = []
  const download = (game: 1357 | 1431, run: string, waves: Record<string, number[]>): string => {
    const root = mkdtempSync(join(tmpdir(), "game-signature-"))
    dirs.push(root)
    for (const [wave, slots] of Object.entries(waves)) {
      for (const slot of slots) {
        const bot = join(root, `e2e-live-${run}-attempt-1-${wave}-bot${slot}`)
        const res = join(root, `e2e-live-${run}-attempt-1-${wave}-bot${slot}-result`)
        mkdirSync(bot)
        mkdirSync(res)
        const from = slot === 1 || slot === 3 ? slot : 1
        const log = fixture<DevLog>(`${FIXTURE_RUN[game]}-signature-bot${from}-devlog.json`)
        writeFileSync(join(bot, `devlog-${slot}.json`), JSON.stringify(log))
        writeFileSync(join(res, `result-${slot}.json`), JSON.stringify(fixture(`${FIXTURE_RUN[game]}-signature-bot${from}-result.json`)))
      }
    }
    return root
  }
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  it("reads one signature per bot of the wave", () => {
    const run = readRun(download(1357, "40154978844", { "specialist-03": [1, 3] }), {})
    expect(run.runId).toBe("40154978844")
    expect(run.wave).toBe("specialist-03")
    expect(run.bots.map((b) => b.slot)).toEqual([1, 3])
    expect(run.bots[0]!.account).toBe(BOT1)
  })

  it("refuses an ambiguous run and names the waves", () => {
    const root = download(1357, "40154978844", { "specialist-02": [1], "specialist-03": [3] })
    expect(() => readRun(root, {})).toThrow(/specialist-02.*specialist-03.*--wave/)
    expect(readRun(root, { wave: "specialist-02" }).bots.map((b) => b.slot)).toEqual([1])
  })

  it("fails closed on a run with no e2e-live artifacts", () => {
    const root = mkdtempSync(join(tmpdir(), "game-signature-"))
    dirs.push(root)
    expect(() => readRun(root, {})).toThrow(/no e2e-live artifacts/)
  })
})

describe("compareRuns", () => {
  const run = (game: 1357 | 1431, slots: Array<1 | 3> = [1, 3]): RunSignature => ({
    runId: String(game),
    wave: "specialist-03",
    // a two-bot excerpt of a six-bot wave: its "group" is the excerpt, or the one-group guard would refuse it
    bots: slots.map((slot) => ({ ...sign(game, slot), groupSizes: [slots.length, slots.length] })),
  })
  /** the same run with one link edited, to put a known difference through the verdicts */
  const edited = (base: RunSignature, slot: number, peer: string, change: (link: BotSignature["links"][number]) => void): RunSignature => {
    const copy = structuredClone(base)
    change(copy.bots.find((b) => b.slot === slot)!.links.find((l) => l.peer === peer)!)
    return copy
  }
  const EDITED = "game259-dropped-lane-rebuild → 5GNCrX…"
  const FAULTED = "game259-dropped-lane-rebuild → locale-la-enus"
  const row = (c: ReturnType<typeof compareRuns>, metric: string, key = EDITED) => c.rows.find((r) => r.metric === metric && r.key.includes(key))!

  it("reads a run against itself as all same", () => {
    const c = compareRuns(run(1357), run(1357))
    expect(c.rows.length).toBeGreaterThan(0)
    expect(c.rows.every((r) => r.verdict === "same")).toBe(true)
    expect(c.blocking).toEqual([])
  })

  it("reads the matched legacy pair 1357 vs 1431 as no regression and the same decision sequence", () => {
    const c = compareRuns(run(1357), run(1431))
    expect(c.blocking).toEqual([])
    expect(c.decisionDiffs).toEqual([])
  })

  it("keeps a connect delta inside the 1000 ms floor as same, and grades the ones beyond it", () => {
    const base = run(1357)
    const slow = (ms: number) => compareRuns(base, edited(base, 1, BOT2, (l) => { l.connectMs! += ms })).rows.filter((r) => r.metric === "connect").map((r) => r.verdict)
    expect(slow(900)).not.toContain("worse")
    expect(slow(1500)).toContain("worse")
    expect(slow(2500)).toContain("beyond-floor")
    expect(slow(-1500)).toContain("better")
  })

  it("lets --floor override the default tolerance", () => {
    const base = run(1357)
    const slower = edited(base, 1, BOT2, (l) => { l.connectMs! += 900 })
    expect(compareRuns(base, slower).blocking).toEqual([])
    expect(compareRuns(base, slower, { connect: 500 }).blocking.map((r) => r.metric)).toContain("connect")
  })

  it("compares first video with the 250 ms floor, on every link", () => {
    const base = run(1357)
    expect(compareRuns(base, edited(base, 1, BOT2, (l) => { l.firstVideoMs! += 200 })).blocking).toEqual([])
    expect(compareRuns(base, edited(base, 1, BOT2, (l) => { l.firstVideoMs! += 300 })).blocking.map((r) => r.metric)).toContain("firstVideo")
    // the faulted link is graded for first video too, and separately for its recovery
    const c = compareRuns(base, base)
    expect(c.rows.some((r) => r.metric === "firstVideo" && r.key === FAULTED)).toBe(true)
  })

  it("grades fault-to-recovery with its own 1000 ms floor and a new fault as worse", () => {
    const base = run(1357)
    expect(row(compareRuns(base, edited(base, 1, BOT3, (l) => { l.recoveries[0]! += 900 })), "recovery", FAULTED).verdict).toBe("same")
    expect(row(compareRuns(base, edited(base, 1, BOT3, (l) => { l.recoveries[0]! += 1500 })), "recovery", FAULTED).verdict).toBe("worse")
    const clean = edited(base, 1, BOT3, (l) => { l.recoveries = [] })
    expect(row(compareRuns(clean, base), "recovery", FAULTED).verdict).toBe("beyond-floor")
    expect(row(compareRuns(base, clean), "recovery", FAULTED).verdict).toBe("better")
  })

  it("treats a link that stopped connecting, a lost round of video or a changed vote as a hard regression", () => {
    const base = run(1357)
    expect(row(compareRuns(base, edited(base, 1, BOT2, (l) => { l.connectMs = Infinity })), "connect").verdict).toBe("beyond-floor")
    expect(row(compareRuns(base, edited(base, 1, BOT2, (l) => { l.connectedBeforeTurn0 = false })), "connectedBeforeTurn0").verdict).toBe("beyond-floor")
    expect(row(compareRuns(base, edited(base, 1, BOT2, (l) => { l.videoRounds = 1 })), "videoRounds").verdict).toBe("beyond-floor")
    expect(row(compareRuns(base, edited(base, 1, BOT2, (l) => { l.vote = { ...l.vote!, verdict: "not-person" } })), "vote").verdict).toBe("beyond-floor")
  })

  it("calls a better everyone-connected or coverage a win, not a diff to explain", () => {
    const base = run(1357)
    const worse = edited(base, 1, BOT2, (l) => { l.connectedBeforeTurn0 = false; l.coveredTurns = 1 })
    const c = compareRuns(worse, base)
    expect(row(c, "connectedBeforeTurn0").verdict).toBe("better")
    expect(row(c, "coverage").verdict).toBe("better")
    expect(c.blocking).toEqual([])
    expect(c.wins.map((r) => r.metric)).toEqual(expect.arrayContaining(["connectedBeforeTurn0", "coverage"]))
  })

  it("blocks a bot that no longer completes", () => {
    const base = run(1357)
    const broken = structuredClone(base)
    broken.bots[0]!.complete = false
    expect(row(compareRuns(base, broken), "complete", "game259").verdict).toBe("beyond-floor")
  })

  it("lists a different decision sequence as a diagnostic that never blocks", () => {
    const base = run(1357)
    const other = edited(base, 3, BOT1, (l) => { l.decisions = ["self-heal → ICE restart (attempt 1)"] })
    const c = compareRuns(base, other)
    expect(c.blocking).toEqual([])
    expect(c.decisionDiffs).toEqual([
      { key: expect.stringContaining("locale-la-enus"), a: ["media-stall → rebuild", "self-heal → rebuild (attempt 1)"], b: ["self-heal → ICE restart (attempt 1)"] },
    ])
  })

  it("refuses a pair whose players differ instead of grading it", () => {
    expect(() => compareRuns(run(1357), run(1431, [1]))).toThrow(NotComparable)
    expect(() => compareRuns(run(1357), run(1431, [1]))).toThrow(/only in A/)
  })

  it("warns, without blocking, when the harness commits differ", () => {
    const c = compareRuns(run(1357), run(1431))
    expect(c.warnings.join()).toMatch(/commit/)
  })
})

describe("parseArgs", () => {
  it("reads a single run with an optional json file and wave", () => {
    expect(parseArgs(["/runs/a", "--json", "out.json", "--wave", "specialist-03"])).toEqual({ kind: "sign", dir: "/runs/a", json: "out.json", wave: "specialist-03" })
  })

  it("reads --compare with two dirs and repeated --floor overrides", () => {
    expect(parseArgs(["--compare", "/a", "/b", "--floor", "connect=500", "--floor", "away=3000", "--all"])).toEqual({
      kind: "compare", dirA: "/a", dirB: "/b", floors: { connect: 500, away: 3000 }, json: undefined, wave: undefined, all: true,
    })
  })

  it("rejects an unknown floor metric, a non-number and a missing run dir", () => {
    expect(() => parseArgs(["--compare", "/a", "/b", "--floor", "speed=5"])).toThrow(/unknown floor metric speed/)
    expect(() => parseArgs(["--compare", "/a", "/b", "--floor", "connect=fast"])).toThrow(/<metric>=<ms>/)
    expect(() => parseArgs([])).toThrow(/usage/)
    expect(() => parseArgs(["--compare", "/a"])).toThrow(/usage/)
  })
})

describe("render", () => {
  // a two-bot excerpt: its group is the excerpt
  const run: RunSignature = { runId: "1357", wave: "specialist-03", bots: [sign(1357, 1), sign(1357, 3)].map((b) => ({ ...b, groupSizes: [2, 2] })) }

  it("prints a per-bot, per-link table with elapsed times and the fault anchor", () => {
    const text = renderSignature(run)
    expect(text).toContain("game259-dropped-lane-rebuild")
    expect(text).toMatch(/locale-la-enus\s+\|\s+402/)
    expect(text).toContain("19587")
    expect(text).toContain("media-stall → rebuild; self-heal → rebuild (attempt 1)")
  })

  it("prints the verdict, the evidence lines and the blocking list for a comparison", () => {
    const slow = structuredClone(run)
    slow.bots[0]!.links[0]!.connectMs! += 2500
    const text = renderComparison(run, slow, compareRuns(run, slow))
    expect(text).toContain("BLOCKS")
    expect(text).toMatch(/connect .*beyond-floor/)
    const clean = renderComparison(run, run, compareRuns(run, run))
    expect(clean).toContain("PASSES")
  })

  it("serialises Infinity as null so the JSON file stays valid", () => {
    const never = structuredClone(run)
    never.bots[0]!.links[0]!.connectMs = Infinity
    expect(() => JSON.parse(renderSignature(never, true))).not.toThrow()
    expect(JSON.parse(renderSignature(never, true)).bots[0].links[0].connectMs).toBeNull()
  })
})

describe("review round 1", () => {
  type Line = DevLog["lines"][number]
  /** a plain rtc line; no sessionId, so it belongs to whatever session the log is in */
  const rtc = (ts: number, message: string): Line => ({ ts, tag: "rtc", message })
  /** a record carrying the page's wall and monotonic reading of one instant (what receiver-quality and the snapshots carry) */
  /** `jump` moves the page clock's wall reading ahead by that many ms without moving its monotonic clock */
  const timing = (ts: number, mono: number, jump = 0): Line => ({ ts, tag: "replay", message: "receiver-quality", data: { timing: { wallMs: ts + jump, monotonicMs: mono } } })
  const bot1 = (): DevLog => fixture<DevLog>("run-o-signature-bot1-devlog.json")
  const bot3 = (): DevLog => fixture<DevLog>("run-o-signature-bot3-devlog.json")
  const insertAfter = (log: DevLog, match: (l: Line) => boolean, ...add: Line[]): DevLog => {
    const i = log.lines.findIndex(match)
    expect(i).toBeGreaterThanOrEqual(0)
    return { ...log, lines: [...log.lines.slice(0, i + 1), ...add, ...log.lines.slice(i + 1)] }
  }
  const meshOpen = (l: Line) => l.message === "mesh open"
  const link = (log: DevLog, peer: string, slot = 1) => signBot({ slot, log, result: null }).links.find((l) => l.peer === peer)!
  const END = 1792902300000

  describe("1: only heal decisions anchor a recovery", () => {
    it("leaves a link unanchored by glare and first-contact negotiation", () => {
      const log = insertAfter(bot1(), (l) => l.message === `[jollity-rtc] pc ${BOT2} connected`,
        rtc(1792901951650, `[jollity-rtc] glare on lane: ignoring offer from ${BOT2}`),
        rtc(1792901951651, `[jollity-rtc] first-contact offer not applied → initiate ${BOT2} stale`))
      const l = link(log, BOT2)
      expect(l.decisions).toEqual(["glare → ignore", "first-contact → initiate"])
      expect(l.recoveries).toEqual([])
    })
  })

  describe("3: every fault or heal is graded, not only the first", () => {
    it("measures a mid-game heal to the next video line on that link", () => {
      const withHeal = { ...bot1(), lines: [...bot1().lines,
        rtc(END, `[jollity-rtc] media-stall: no-video-rebuild peer=${BOT2} fault=none signalingState=stable round=2 connected channel open but no inbound video → rebuild`),
        rtc(END + 900, `[jollity-rtc] first video after 1800ms ${BOT2}`)] }
      expect(link(withHeal, BOT2).recoveries).toEqual([900])
    })

    it("calls a heal that no later video line answers unobserved when the link had video, and never when it had none", () => {
      const heal = rtc(END, `[jollity-rtc] self-heal: ICE restart ${BOT2} (attempt 1)`)
      const had = { ...bot1(), lines: [...bot1().lines, heal] }
      expect(link(had, BOT2).recoveries).toEqual([null])
      const noVideo = { ...bot1(), lines: [...bot1().lines.filter((l) => !(l.message.includes(BOT2) && /first video|first-video/.test(l.message))), heal] }
      expect(link(noVideo, BOT2).recoveries).toEqual([Infinity])
    })

    it("pairs the k-th recovery of a link and calls a new unrecovered one a hard failure", () => {
      const base = { runId: "1", wave: "w", bots: [sign(1357, 1), sign(1357, 3)].map((b) => ({ ...b, groupSizes: [2, 2] })) }
      const worse = structuredClone(base)
      worse.bots[0]!.links.find((l) => l.peer === BOT2)!.recoveries = [Infinity]
      expect(compareRuns(base, worse).rows.find((r) => r.metric === "recovery" && r.key.endsWith("5GNCrX…"))!.verdict).toBe("beyond-floor")
      const later = structuredClone(base)
      later.bots[0]!.links.find((l) => l.peer === BOT3)!.recoveries.push(Infinity)
      expect(compareRuns(base, later).rows.find((r) => r.metric === "recovery" && r.key.endsWith("#2"))!.verdict).toBe("beyond-floor")
    })
  })

  describe("2: first video is always graded", () => {
    it("grades a slower first video on the faulted link", () => {
      const base = { runId: "1", wave: "w", bots: [sign(1357, 1), sign(1357, 3)].map((b) => ({ ...b, groupSizes: [2, 2] })) }
      const slow = structuredClone(base)
      slow.bots[0]!.links.find((l) => l.peer === BOT3)!.firstVideoMs! += 3000
      const c = compareRuns(base, slow)
      expect(c.blocking.map((r) => r.metric)).toContain("firstVideo")
    })
  })

  describe("4: the heal budget is a hard rule", () => {
    const pair = () => {
      const base = { runId: "1", wave: "w", bots: [sign(1357, 1), sign(1357, 3)].map((b) => ({ ...b, groupSizes: [2, 2] })) }
      return { base, other: structuredClone(base) }
    }
    it("reads the last-heal line off the decision", () => {
      const log = insertAfter(bot1(), (l) => l.message === `[jollity-rtc] pc ${BOT2} connected`,
        rtc(1792901960000, `[jollity-rtc] unseen: signalingState=stable the peer says it decodes none of our video → ICE restart, the last until this peer leaves ${BOT2}`))
      const l = link(log, BOT2)
      expect(l.lastHeal).toBe(true)
      expect(l.decisions).toEqual(["unseen → ICE restart (last heal)"])
    })
    it("blocks more attempts, more heals or reaching the last heal; a different sequence alone stays diagnostic", () => {
      const { base, other } = pair()
      other.bots[1]!.links.find((l) => l.peer === BOT1)!.maxAttempt = 2
      expect(compareRuns(base, other).blocking.map((r) => r.metric)).toContain("attempt")
      const heals = pair()
      heals.other.bots[1]!.links[0]!.maxHeal = 1
      expect(compareRuns(heals.base, heals.other).blocking.map((r) => r.metric)).toContain("heal")
      const last = pair()
      last.other.bots[1]!.links[0]!.lastHeal = true
      expect(compareRuns(last.base, last.other).blocking.map((r) => r.metric)).toContain("healHeadroom")
      const seq = pair()
      seq.other.bots[1]!.links.find((l) => l.peer === BOT1)!.decisions = ["self-heal → ICE restart (attempt 1)"]
      expect(compareRuns(seq.base, seq.other).blocking).toEqual([])
    })
    it("reads fewer heals as a win", () => {
      const { base, other } = pair()
      other.bots[1]!.links.find((l) => l.peer === BOT1)!.maxAttempt = 0
      expect(compareRuns(base, other).wins.map((r) => r.metric)).toContain("attempt")
    })
  })

  describe("5: away counts both reasons", () => {
    it("measures a peer away timeout until its peer back", () => {
      const log = insertAfter(bot1(), (l) => l.message === `[jollity-rtc] pc ${BOT2} connected`,
        rtc(1792901960000, `[jollity-rtc] peer away ${BOT2} timeout`), rtc(1792901963000, `[jollity-rtc] peer back ${BOT2}`))
      expect(link(log, BOT2).awayMs).toBe(3000)
    })
    it("still measures a peer that said it was away", () => {
      const log = insertAfter(bot1(), (l) => l.message === `[jollity-rtc] pc ${BOT2} connected`,
        rtc(1792901960000, `[jollity-rtc] peer away ${BOT2} said`), rtc(1792901961500, `[jollity-rtc] peer back ${BOT2}`))
      expect(link(log, BOT2).awayMs).toBe(1500)
    })
  })

  describe("6: a reload is a new session, not a clock jump", () => {
    it("keeps an interval that ends before a later reload", () => {
      let log = insertAfter(bot1(), meshOpen, timing(1792901951200, 300_000))
      log = insertAfter(log, (l) => l.message.startsWith("[jollity-rtc] round-link stage=first-video round=1 fault="), timing(1792901971200, 320_000))
      log = { ...log, lines: [...log.lines, timing(END, 400)] }
      expect(link(log, BOT3).recoveries).toEqual([19587])
      expect(link(log, BOT2).connectMs).toBe(470)
    })
    it("does not read a jump outside the interval as a jump inside it", () => {
      let log = insertAfter(bot1(), (l) => l.message === "mesh opening", timing(1792901950970, 295_000))
      log = insertAfter(log, meshOpen, timing(1792901951200, 295_230, 30_000))
      // the origin moved by 30 s between the first two records, both before the interval's end; later records are steady
      log = insertAfter(log, (l) => l.message.startsWith("[jollity-rtc] round-link stage=first-video round=1 fault="), timing(1792901971200, 315_230, 30_000))
      expect(link(log, BOT3).recoveries).toEqual([19587])
    })
    it("drops an interval that spans a reload and says so", () => {
      let log = insertAfter(bot1(), meshOpen, timing(1792901951200, 300_000))
      log = insertAfter(log, (l) => l.ts === 1792901951200 && l.tag === "replay", timing(1792901951400, 200))
      const l = link(log, BOT2)
      expect(l.connectMs).toBeNull()
      expect(l.flags.join()).toMatch(/reload/)
    })
    it("still drops an interval with a real jump inside it", () => {
      let log = insertAfter(bot1(), meshOpen, timing(1792901951200, 300_000))
      log = insertAfter(log, (l) => l.ts === 1792901951200 && l.tag === "replay", timing(1792901951300, 300_100, 30_000))
      expect(link(log, BOT2).connectMs).toBeNull()
      expect(link(log, BOT2).flags.join()).toMatch(/page-clock jump/)
    })
  })

  describe("8: the devlog is walked in its recorded order", () => {
    it("keeps decisions in recorded order when the page clock stepped back", () => {
      const log = bot3()
      const lines = log.lines.map((l) => (l.message.startsWith("[jollity-rtc] media-stall: no-video-rebuild") ? { ...l, ts: l.ts + 50 } : l))
      expect(link({ ...log, lines }, BOT1, 3).decisions).toEqual(["media-stall → rebuild", "self-heal → rebuild (attempt 1)"])
    })
  })

  describe("9: no mesh open line means cannot tell", () => {
    it("nulls the connect figures and does not block", () => {
      const log = bot1()
      const lines = log.lines.filter((l) => !meshOpen(l))
      const s = signBot({ slot: 1, log: { ...log, lines }, result: fixture("run-o-signature-bot1-result.json") })
      expect(s.links.every((l) => l.connectMs === null)).toBe(true)
      expect(s.links.every((l) => l.connectedBeforeTurn0 === true)).toBe(true)
      expect(s.allConnectedMs).toBeNull()
      const base = { runId: "1", wave: "w", bots: [sign(1357, 1)].map((b) => ({ ...b, groupSizes: [1, 1] })) }
      const missing = { ...base, bots: [{ ...s, groupSizes: [1, 1], persona: base.bots[0]!.persona }] }
      expect(compareRuns(base, missing).blocking).toEqual([])
    })
  })

  describe("7: a pair that is not comparable is refused, not graded", () => {
    const bots = (): BotSignature[] => [sign(1357, 1), sign(1357, 3)].map((b) => ({ ...b, groupSizes: [2, 2] }))
    const a = (): RunSignature => ({ runId: "1", wave: "specialist-03", bots: bots() })
    it("refuses different waves", () => {
      expect(() => compareRuns(a(), { ...a(), wave: "specialist-02" })).toThrow(/wave/)
    })
    it("refuses a game with an extra player", () => {
      const extra = a()
      extra.bots.push({ ...structuredClone(extra.bots[0]!), slot: 7, account: "5Extra" + "x".repeat(40) })
      expect(() => compareRuns(a(), extra)).toThrow(/only in B/)
    })
    it("refuses a game that is not one group of the whole wave", () => {
      const split = a()
      for (const b of split.bots) b.groupSizes = [1, 1]
      expect(() => compareRuns(a(), split)).toThrow(/one group/)
      const none = a()
      for (const b of none.bots) b.groupSizes = []
      expect(() => compareRuns(a(), none)).toThrow(/one group/)
    })
    it("exits 2 with the reason from the command line", () => {
      const out: string[] = []
      const err: string[] = []
      const dirA = mkdtempSync(join(tmpdir(), "game-signature-"))
      const dirB = mkdtempSync(join(tmpdir(), "game-signature-"))
      try {
        for (const [dir, wave] of [[dirA, "specialist-03"], [dirB, "specialist-02"]] as const) {
          mkdirSync(join(dir, `e2e-live-1-attempt-1-${wave}-bot1`))
          writeFileSync(join(dir, `e2e-live-1-attempt-1-${wave}-bot1`, "devlog-1.json"), JSON.stringify(bot1()))
        }
        const code = main(["--compare", dirA, dirB], { out: (t) => out.push(t), err: (t) => err.push(t) })
        expect(code).toBe(2)
        expect(err.join()).toMatch(/not comparable.*wave/)
        expect(out.join()).not.toMatch(/PASSES|BLOCKS/)
      } finally {
        rmSync(dirA, { recursive: true, force: true })
        rmSync(dirB, { recursive: true, force: true })
      }
    })
  })
})
