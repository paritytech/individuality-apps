// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// WHAT DID THE MESH DO IN THIS GAME, LINK BY LINK? One downloaded run of a SIX-BOT
// wave in, one signature per bot and per peer link out; two runs in, a verdict on
// whether the second is as good as the first. Built for Step 4.3 (legacy mesh vs the
// peer actor); the design is briefings/2026-10-27-jollity-game-signature-design.md.
//
//   npx tsx scripts/e2e-live/game-signature.mts <runDir> [--wave <phase>] [--json <file>]
//   npx tsx scripts/e2e-live/game-signature.mts --compare <runDirA> <runDirB> [--wave <phase>]
//        [--floor connect=1000 --floor firstVideo=250 ...] [--json <file>] [--all]
//
// <runDir> is a `gh run download <id> -R paritytech/individuality-apps -D <runDir>` tree, the
// same layout shaping-impact.mts reads: bot-N artifacts hold devlog-N.json, bot-N-result
// artifacts hold result-N.json. shaping-impact.mts is a top-level script and exports
// nothing, so the artifact walk is repeated here in its smallest form. pc-timeline.ts is not
// used: it re-sorts the devLog by page-clock stamp and knows only `peer away <p> said`, and this
// reader walks the log in the order it was recorded. Read-only: no network, no chain.
//
// THE PASS RULE IS OUTCOME-BASED. Outcomes are what a player or the harness could
// notice: the game completed, the votes filed, every link connected before turn 0, the
// connect time, the first video, the recovery from a fault, the away time, the turns with
// decoded video. A regression beyond the noise floor, or a hard failure, blocks. An
// improvement is a WIN. The decision sequence (which heal the mesh chose) is DIAGNOSTIC:
// it explains a difference and never decides one.
//
// ELAPSED TIMES, NEVER WALL STAMPS. Every figure is the difference of two stamps of the
// SAME bot's page clock, so a constant clock offset cancels. The log is walked in RECORDED
// order (a clock persona's stamps can step backwards, so sorting by stamp would reorder it).
// A page reload restarts `timing.monotonicMs`, which starts a new SESSION; an interval whose
// two ends are in different sessions spans a reload and is dropped. Within a session, the
// page clock's wall origin (`timing.wallMs - timing.monotonicMs`, read from the records that
// sit BETWEEN the two ends) moving by more than a quarter second is a jump and drops the
// interval too. `first video after <ms>` is the mesh's own monotonic figure and is used as is.
//
// COVERAGE COMES FROM result-N.json `adaptiveUpload.page.peers[].decodedSamples`, never
// from `receiver-quality`: those records are written on change, so a "windows with frames"
// share over them is biased to 100% and measures the cadence, not the video.
//
// NOT MEASURED: decoded-but-not-presented tiles. `presented: true` is hard-coded in
// lib/game-session.ts, so no artifact can say a decoded tile showed black.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

// ── what the artifacts hold ──────────────────────────────────────────────────

export interface LogLine {
  ts: number
  tag: string
  message: string
  data?: unknown
  sessionId?: string
}

interface TrailPlayer {
  verdict?: string
  personTurns?: number
  notPersonTurns?: number
  source?: string
}

export interface DevLog {
  lines: LogLine[]
  trail?: { reports?: Array<{ players?: Record<string, TrailPlayer> }> }
}

/** The slice of result-N.json this reader needs. */
export interface ResultLike {
  profile?: string
  account?: string
  game?: { index?: number }
  signedUp?: boolean
  reportSeen?: boolean
  settled?: boolean
  reachedPrizeDraw?: boolean
  confirmedBy?: string
  provenance?: { commit?: string }
  groups?: Array<{ members?: unknown[] }>
  adaptiveUpload?: {
    page?: { peers?: Array<{ account: string; decodedSamples?: Array<{ firstFramesDecoded: number; lastFramesDecoded: number }> }> }
  }
}

// ── the signature ────────────────────────────────────────────────────────────

export interface Vote {
  verdict: string
  personTurns: number
  notPersonTurns: number
  source: string
}

export interface LinkSignature {
  self: string
  peer: string
  /** mesh open to `pc <peer> connected`, ms. Infinity = never connected, null = not measurable (jumped / no mesh open) */
  connectMs: number | null
  /** the link was connected before the turn-0 introduction snapshot; null when either end is missing */
  connectedBeforeTurn0: boolean | null
  /** `first video after <ms>` (the mesh's own monotonic figure, mesh open to first video, faulted links included);
   *  Infinity when the link never showed video, null when it did but the line is missing */
  firstVideoMs: number | null
  /** one figure per fault or heal episode on this link, in order: the time from its anchor (the injected
   *  fault line, or the first heal decision) to the next video line on the link. Infinity = the link never
   *  showed video again and never had any; null = not observable (a heal on a link that had video and no
   *  later video line, or an interval that spans a reload or a jump). Benign negotiation (glare,
   *  first-contact) is never an anchor. */
  recoveries: Array<number | null>
  /** total time the peer was away, ms (0 when never); null when jumped */
  awayMs: number | null
  /** rounds in which `round-link stage=first-video` was reached */
  videoRounds: number
  /** seat-turns with decoded frames / seat-turns sampled (result adaptiveUpload); null without a result */
  coveredTurns: number | null
  turns: number | null
  path: string | null
  vote: Vote | null
  /** diagnostic: the canonical decision sequence on this link, in order */
  decisions: string[]
  /** diagnostic: the heal budget actually spent */
  maxAttempt: number
  maxHeal: number
  /** reached the "last heal ... until this peer leaves" line: the heal budget is spent */
  lastHeal: boolean
  flags: string[]
}

export interface BotSignature {
  slot: number
  account: string
  persona: string
  game: number | null
  commit: string | null
  signedUp: boolean
  reportSeen: boolean
  settled: boolean
  reachedPrizeDraw: boolean
  confirmedBy: string | null
  /** signedUp && reportSeen && settled && reachedPrizeDraw */
  complete: boolean
  groupSizes: number[]
  /** the slowest link's connect time; Infinity when a link never connected */
  allConnectedMs: number | null
  generations: number
  links: LinkSignature[]
  flags: string[]
}

const PEER = "(\\S+)"
const RTC = "\\[jollity-rtc\\] "
const ROUND_LINK = new RegExp(`^${RTC}round-link stage=(\\S+) round=(\\d+)(?: fault=(\\S+))? peer=${PEER}$`)
const FIRST_VIDEO = new RegExp(`^${RTC}first video after (\\d+)ms ${PEER}$`)
const PATH = new RegExp(`^${RTC}path ${PEER} (.+)$`)
const FAULT_LINE = /^\[e2e-data-channel-fault\] dropped /

/** One decision the mesh took on a link, in the words every build must keep emitting
 *  (PARSER_VISIBLE_RTC_LOG_CONTRACT, lib/webrtc/legacy-decision-capture.ts), reduced to
 *  `cause → action (budget counter)`. The counter IS the budget, so it is kept. */
const DECISIONS: Array<[RegExp, (m: RegExpExecArray) => { peer: string; text: string }]> = [
  [new RegExp(`^${RTC}self-heal: (ICE restart|rebuild(?: responder-only)?) ${PEER} \\(attempt (\\d+)\\)`), (m) => ({ peer: m[2]!, text: `self-heal → ${m[1]} (attempt ${m[3]})` })],
  [new RegExp(`^${RTC}media-stall: no-video-rebuild peer=${PEER}`), (m) => ({ peer: m[1]!, text: "media-stall → rebuild" })],
  [new RegExp(`^${RTC}(.+?) → (rebuild|ICE restart) \\(heal (\\d+)\\) ${PEER}$`), (m) => ({ peer: m[4]!, text: `${/media-stall/.test(m[1]!) ? "media-stall" : m[1]!.split(":")[0]} → ${m[2]} (heal ${m[3]})` })],
  [new RegExp(`^${RTC}unseen: .*→ ICE restart \\(heal (\\d+)\\) ${PEER}$`), (m) => ({ peer: m[2]!, text: `unseen → ICE restart (heal ${m[1]})` })],
  [new RegExp(`^${RTC}unseen: .*→ ICE restart, the last until this peer leaves ${PEER}$`), (m) => ({ peer: m[1]!, text: "unseen → ICE restart (last heal)" })],
  [new RegExp(`^${RTC}new remote session from ${PEER} → rebuild`), (m) => ({ peer: m[1]!, text: "new-remote-session → rebuild" })],
  [new RegExp(`^${RTC}new signalling session from ${PEER} → rebuild`), (m) => ({ peer: m[1]!, text: "new-signalling-session → rebuild" })],
  [new RegExp(`^${RTC}glare on lane: ignoring offer from ${PEER}`), (m) => ({ peer: m[1]!, text: "glare → ignore" })],
  [new RegExp(`^${RTC}glare: ignoring offer from ${PEER}`), (m) => ({ peer: m[1]!, text: "glare → ignore" })],
  [new RegExp(`^${RTC}glare on lane with video negotiated: rebuild instead of rolling back ${PEER}`), (m) => ({ peer: m[1]!, text: "glare → rebuild" })],
  [new RegExp(`^${RTC}glare on lane with video negotiated: rebuild already spent this round, rolling back ${PEER}`), (m) => ({ peer: m[1]!, text: "glare → rollback" })],
  [new RegExp(`^${RTC}channel-stall: never-open peer=${PEER}`), (m) => ({ peer: m[1]!, text: "channel-stall → rebuild" })],
  [new RegExp(`^${RTC}network changed: (ICE restart|rebuild) ${PEER}`), (m) => ({ peer: m[2]!, text: `network-changed → ${m[1]}` })],
  [new RegExp(`^${RTC}offer refused by the connection → ${PEER} rebuild`), (m) => ({ peer: m[1]!, text: "offer-refused → rebuild" })],
  [new RegExp(`^${RTC}first-contact offer not applied → initiate ${PEER}`), (m) => ({ peer: m[1]!, text: "first-contact → initiate" })],
  [new RegExp(`^${RTC}hard lane negotiation error → \\S+ rebuild ${PEER}`), (m) => ({ peer: m[1]!, text: "lane-error → rebuild" })],
]

interface Decision {
  idx: number
  ts: number
  peer: string
  text: string
}

/** Decisions that are negotiation, not repair: they never anchor a recovery. */
const BENIGN = /^(glare|first-contact) /

/** Two stamps of one code path inside this many ms are the same decision. */
const DUPLICATE_MS = 100

function readDecisions(lines: readonly LogLine[]): Decision[] {
  const out: Decision[] = []
  lines.forEach((line, idx) => {
    if (line.tag !== "rtc" || !line.message.startsWith("[jollity-rtc] ")) return
    for (const [pattern, read] of DECISIONS) {
      const m = pattern.exec(line.message)
      if (!m) continue
      const d = read(m)
      const twin = out.find((o) => o.peer === d.peer && o.text === d.text && Math.abs(o.ts - line.ts) <= DUPLICATE_MS)
      if (!twin) out.push({ idx, ts: line.ts, ...d })
      return
    }
  })
  return out
}

// ── one bot's page clock ─────────────────────────────────────────────────────

/** A runner-vs-page offset is 1-8 ms in the wave; a quarter of a second is a jump, not drift. */
const JUMP_MS = 250
/** Records are written close together but not strictly in monotonic order; a drop larger than this is a reload. */
const RELOAD_SLACK_MS = 1000

interface Clock {
  /** the session (page document) every line belongs to, by index */
  session: number[]
  /** the records that carry a wall and a monotonic reading of one instant */
  marks: Array<{ idx: number; session: number; origin: number }>
}

/** Model the page clock ONCE per bot: sessions (a reload restarts `monotonicMs`, or the recorder's
 *  sessionId changes) and the wall origin of every timing record. */
function buildClock(lines: readonly LogLine[]): Clock {
  const session: number[] = []
  const marks: Clock["marks"] = []
  let current = 0
  let previousMono: number | null = null
  let previousId: string | undefined
  lines.forEach((l, idx) => {
    if (l.sessionId && previousId && l.sessionId !== previousId) {
      current++
      previousMono = null
    }
    if (l.sessionId) previousId = l.sessionId
    const t = (l.data as { timing?: { wallMs?: number; monotonicMs?: number } } | undefined)?.timing
    if (typeof t?.wallMs === "number" && typeof t.monotonicMs === "number") {
      if (previousMono !== null && t.monotonicMs < previousMono - RELOAD_SLACK_MS) current++
      previousMono = t.monotonicMs
      marks.push({ idx, session: current, origin: t.wallMs - t.monotonicMs })
    }
    session.push(current)
  })
  return { session, marks }
}

/** Can the interval between two log positions be read as an elapsed time? Only the records INSIDE it
 *  speak for it: a jump before or after the interval does not make the interval dirty. */
function span(clock: Clock, from: number, to: number): "ok" | "reload" | "jump" {
  if (clock.session[from] !== clock.session[to]) return "reload"
  const origins = clock.marks.filter((m) => m.idx >= from && m.idx <= to).map((m) => m.origin)
  return origins.length > 1 && Math.max(...origins) - Math.min(...origins) > JUMP_MS ? "jump" : "ok"
}

const HEAL_ANCHOR = (text: string): boolean => !BENIGN.test(text)

export function signBot(input: { slot: number; log: DevLog; result: ResultLike | null; profile?: string }): BotSignature {
  const { slot, log, result } = input
  const lines = log.lines
  const clock = buildClock(lines)
  const flags: string[] = []
  const elapsed = (from: number, to: number, what: string, into: string[]): number | null => {
    const s = span(clock, from, to)
    if (s === "ok") return lines[to]!.ts - lines[from]!.ts
    into.push(`${what} spans a ${s === "reload" ? "page reload" : "page-clock jump"}`)
    return null
  }

  const openIdx = lines.findIndex((l) => l.tag === "rtc" && l.message === "mesh open")
  const opens = lines.filter((l) => l.tag === "rtc" && l.message === "mesh open")
  const open0 = openIdx >= 0 ? lines[openIdx]! : null
  const meshSelf = (open0?.data as { self?: string; peers?: string[] } | undefined)?.self
  const account = meshSelf ?? result?.account ?? "?"
  if (!open0) flags.push("no `mesh open` line: connect times are not measurable")
  if (result && meshSelf && result.account && meshSelf !== result.account) flags.push("result account differs from the mesh's own")

  const turn0Idx = lines.findIndex((l) => {
    if (l.message !== "game.snapshot") return false
    const c = (l.data as { observation?: { current?: { kind?: string; globalTurn?: number | null; stage?: string | null } } } | undefined)?.observation?.current
    return c?.kind === "round" && c.globalTurn === 0 && c.stage === "introduction"
  })
  const lastIdx = lines.length - 1

  const decisions = readDecisions(lines)
  type Event = { idx: number; kind: "anchor" | "video" }
  const events = new Map<string, Event[]>()
  const push = (peer: string, e: Event) => events.set(peer, [...(events.get(peer) ?? []), e])
  const connectedIdx = new Map<string, number>()
  const firstVideo = new Map<string, number>()
  const videoRounds = new Map<string, Set<number>>()
  const path = new Map<string, string>()
  const awayEvents = new Map<string, Array<{ idx: number; away: boolean }>>()
  const faultIdxs: number[] = []
  const usedFaults = new Set<number>()

  for (const d of decisions) if (HEAL_ANCHOR(d.text)) push(d.peer, { idx: d.idx, kind: "anchor" })
  lines.forEach((l, idx) => {
    if (l.tag !== "rtc") return
    if (FAULT_LINE.test(l.message)) faultIdxs.push(idx)
    const connected = /^\[jollity-rtc\] pc (\S+) connected$/.exec(l.message)
    if (connected && idx > openIdx && !connectedIdx.has(connected[1]!)) connectedIdx.set(connected[1]!, idx)
    const fv = FIRST_VIDEO.exec(l.message)
    if (fv) {
      if (!firstVideo.has(fv[2]!)) firstVideo.set(fv[2]!, Number(fv[1]))
      push(fv[2]!, { idx, kind: "video" })
    }
    const rl = ROUND_LINK.exec(l.message)
    if (rl && rl[1] === "first-video") {
      const peer = rl[4]!
      videoRounds.set(peer, (videoRounds.get(peer) ?? new Set()).add(Number(rl[2])))
      push(peer, { idx, kind: "video" })
      if (rl[3]) {
        // the injector's own line carries no peer; the first video that names the fault says whose link it was
        const fault = [...faultIdxs].reverse().find((f) => f < idx && !usedFaults.has(f))
        if (fault !== undefined) {
          usedFaults.add(fault)
          push(peer, { idx: fault, kind: "anchor" })
        }
      }
    }
    const p = PATH.exec(l.message)
    if (p) path.set(p[1]!, p[2]!.trim())
    const away = /^\[jollity-rtc\] peer away (\S+) \S+/.exec(l.message)
    if (away) awayEvents.set(away[1]!, [...(awayEvents.get(away[1]!) ?? []), { idx, away: true }])
    const back = /^\[jollity-rtc\] peer back (\S+)$/.exec(l.message)
    if (back) awayEvents.set(back[1]!, [...(awayEvents.get(back[1]!) ?? []), { idx, away: false }])
  })
  // connect times are read from the first pc connected after mesh open; without a mesh open line any first one will do
  if (openIdx < 0) lines.forEach((l, idx) => {
    const c = /^\[jollity-rtc\] pc (\S+) connected$/.exec(l.message)
    if (c && !connectedIdx.has(c[1]!)) connectedIdx.set(c[1]!, idx)
  })

  const peers = new Set<string>([...((open0?.data as { peers?: string[] } | undefined)?.peers ?? []), ...connectedIdx.keys(), ...videoRounds.keys()])
  peers.delete(account)

  const report = log.trail?.reports?.[log.trail.reports.length - 1]
  const decoded = new Map((result?.adaptiveUpload?.page?.peers ?? []).map((p) => [p.account, p.decodedSamples ?? []]))

  const links: LinkSignature[] = [...peers].sort().map((peer): LinkSignature => {
    const lf: string[] = []
    const ds = decisions.filter((d) => d.peer === peer)
    const connected = connectedIdx.get(peer)

    let connectMs: number | null = null
    if (open0) connectMs = connected === undefined ? Infinity : elapsed(openIdx, connected, "connect interval", lf)

    const recoveries: Array<number | null> = []
    let pending: number | null = null
    let sawVideo = false
    for (const e of [...(events.get(peer) ?? [])].sort((x, y) => x.idx - y.idx)) {
      if (e.kind === "anchor") pending ??= e.idx
      else {
        if (pending !== null) recoveries.push(elapsed(pending, e.idx, "recovery interval", lf))
        pending = null
        sawVideo = true
      }
    }
    if (pending !== null) {
      if (sawVideo) lf.push("a heal on this link has no later video line: its recovery is not observable")
      recoveries.push(sawVideo ? null : Infinity)
    }

    let awayMs: number | null = 0
    let awaySince: number | null = null
    const closeAway = (until: number) => {
      const ms = elapsed(awaySince!, until, "away interval", lf)
      awayMs = awayMs === null || ms === null ? null : awayMs + ms
      awaySince = null
    }
    for (const e of awayEvents.get(peer) ?? []) {
      if (e.away && awaySince === null) awaySince = e.idx
      else if (!e.away && awaySince !== null) closeAway(e.idx)
    }
    if (awaySince !== null) closeAway(lastIdx)

    const rounds = videoRounds.get(peer)?.size ?? 0
    const samples = decoded.get(peer)
    const vote = report?.players?.[peer]
    return {
      self: account,
      peer,
      connectMs,
      connectedBeforeTurn0: turn0Idx < 0 ? null : connected !== undefined ? connected < turn0Idx : open0 ? false : null,
      firstVideoMs: firstVideo.get(peer) ?? (rounds > 0 ? null : Infinity),
      recoveries,
      awayMs,
      videoRounds: rounds,
      coveredTurns: samples ? samples.filter((s) => s.lastFramesDecoded > s.firstFramesDecoded).length : null,
      turns: samples ? samples.length : null,
      path: path.get(peer) ?? null,
      vote: vote ? { verdict: String(vote.verdict), personTurns: vote.personTurns ?? 0, notPersonTurns: vote.notPersonTurns ?? 0, source: String(vote.source) } : null,
      decisions: ds.map((d) => d.text),
      maxAttempt: Math.max(0, ...ds.map((d) => Number(/\(attempt (\d+)\)/.exec(d.text)?.[1] ?? 0))),
      maxHeal: Math.max(0, ...ds.map((d) => Number(/\(heal (\d+)\)/.exec(d.text)?.[1] ?? 0))),
      lastHeal: ds.some((d) => d.text.includes("(last heal)")),
      flags: lf,
    }
  })

  const connects = links.map((l) => l.connectMs).filter((n): n is number => n !== null)
  const complete = !!(result?.signedUp && result.reportSeen && result.settled && result.reachedPrizeDraw)
  return {
    slot,
    account,
    persona: result?.profile ?? input.profile ?? "?",
    game: result?.game?.index ?? null,
    commit: result?.provenance?.commit ?? null,
    signedUp: !!result?.signedUp,
    reportSeen: !!result?.reportSeen,
    settled: !!result?.settled,
    reachedPrizeDraw: !!result?.reachedPrizeDraw,
    confirmedBy: result?.confirmedBy ?? null,
    complete,
    groupSizes: (result?.groups ?? []).map((g) => g.members?.length ?? 0),
    allConnectedMs: links.length > 0 && connects.length === links.length ? Math.max(...connects) : null,
    generations: opens.length,
    links,
    flags: [...flags, ...(result ? [] : ["no result-N.json: completion and coverage are unknown"])],
  }
}

// ── a downloaded run ─────────────────────────────────────────────────────────

export interface RunSignature {
  runId: string
  wave: string
  bots: BotSignature[]
}

const ARTIFACT = /^e2e-live-(\d+)-attempt-(\d+)-(.+?)-bot(\d+)(-result)?$/

/** One wave of a downloaded run, signed. A run holds several waves (specialist-02, -03, ...),
 *  and a bot's account can recur between them, so the wave must be unambiguous: pass `wave`,
 *  or download a run that holds one. The latest attempt of each bot wins. */
export function readRun(root: string, options: { wave?: string }): RunSignature {
  interface Found {
    attempt: number
    dir: string | null
    resultDir: string | null
  }
  const found = new Map<string, Map<number, Found>>()
  let runId = ""
  for (const name of readdirSync(root)) {
    const m = ARTIFACT.exec(name)
    if (!m || !statSync(join(root, name)).isDirectory()) continue
    runId = m[1]!
    const attempt = Number(m[2])
    const slots = found.get(m[3]!) ?? new Map<number, Found>()
    const entry = slots.get(Number(m[4]))
    if (entry && entry.attempt > attempt) continue
    const next: Found = entry && entry.attempt === attempt ? entry : { attempt, dir: null, resultDir: null }
    if (m[5]) next.resultDir = join(root, name)
    else next.dir = join(root, name)
    slots.set(Number(m[4]), next)
    found.set(m[3]!, slots)
  }
  if (found.size === 0) throw new Error(`no e2e-live artifacts under ${root}`)
  const waves = [...found.keys()].sort()
  const wave = options.wave ?? (waves.length === 1 ? waves[0]! : null)
  if (wave === null) throw new Error(`more than one wave under ${root}: ${waves.join(", ")}; pass --wave <name>`)
  const slots = found.get(wave)
  if (!slots) throw new Error(`no wave ${wave} under ${root}; it holds: ${waves.join(", ")}`)
  const bots = [...slots].sort(([a], [b]) => a - b).flatMap(([slot, f]): BotSignature[] => {
    const logFile = f.dir ? join(f.dir, `devlog-${slot}.json`) : null
    if (!logFile || !existsSync(logFile)) return []
    const log = JSON.parse(readFileSync(logFile, "utf8")) as DevLog
    const resultFile = f.resultDir ? join(f.resultDir, `result-${slot}.json`) : null
    const result = resultFile && existsSync(resultFile) ? (JSON.parse(readFileSync(resultFile, "utf8")) as ResultLike) : null
    return [signBot({ slot, log: { lines: log.lines ?? [], trail: log.trail }, result })]
  })
  return { runId, wave, bots }
}

// ── two runs side by side ────────────────────────────────────────────────────

/** The noise floors, in the metric's own unit. These are MINIMUMS from the design: the measured
 *  spread of the matched legacy pair, rounded up (connect ~900 ms, first video 91 ms, recovery
 *  63 ms), so a difference inside a floor is noise and never a finding. `--floor <metric>=<n>` overrides. */
export const DEFAULT_FLOORS = { connect: 1000, firstVideo: 250, recovery: 1000, away: 2000, coverage: 1 }
export type FloorName = keyof typeof DEFAULT_FLOORS
export type Floors = Record<FloorName, number>

/** same        inside the floor
 *  better      beyond the floor, the good way (a WIN)
 *  worse       beyond the floor, the bad way, by up to twice the floor
 *  beyond-floor worse than twice the floor, or a hard failure no floor can excuse (a link that stopped
 *              connecting, a game that stopped completing, a vote that changed, a bot that vanished) */
export type Verdict = "same" | "better" | "worse" | "beyond-floor"

export interface MetricRow {
  metric: string
  /** persona (→ peer persona) the figure belongs to */
  key: string
  a: number | string | boolean | null
  b: number | string | boolean | null
  /** b - a for numbers */
  delta: number | null
  verdict: Verdict
}

export interface DecisionDiff {
  key: string
  a: string[]
  b: string[]
}

export interface Comparison {
  rows: MetricRow[]
  blocking: MetricRow[]
  wins: MetricRow[]
  decisionDiffs: DecisionDiff[]
  warnings: string[]
  floors: Floors
}

type Direction = "lower" | "higher"

/** Grade a number the way the design grades a soft metric. `regression` is how much worse B is. */
function gradeNumber(a: number, b: number, floor: number, direction: Direction): Verdict {
  if (a === b) return "same"
  const regression = direction === "lower" ? b - a : a - b
  if (Number.isNaN(regression)) return "same"
  if (regression <= floor && regression >= -floor) return "same"
  if (regression < -floor) return "better"
  return regression <= 2 * floor ? "worse" : "beyond-floor"
}

const label = (bot: BotSignature): string => bot.persona
const nameOf = (names: Map<string, string>, account: string): string => names.get(account) ?? `${account.slice(0, 6)}…`

/** The two runs are not the same experiment, so grading one against the other would be noise. The CLI
 *  turns this into exit 2 with the reasons; it is neither a PASS nor a BLOCK. */
export class NotComparable extends Error {
  constructor(readonly reasons: readonly string[]) {
    super(`not comparable: ${reasons.join("; ")}`)
  }
}

/** Same wave, the same players, and in each run ONE group of the whole wave in every round (a seventh
 *  player, a split group or a mixed game changes who is linked to whom). */
function comparabilityReasons(a: RunSignature, b: RunSignature): string[] {
  const reasons: string[] = []
  if (a.wave !== b.wave) reasons.push(`different waves (A ${a.wave}, B ${b.wave}); pass --wave to pick the same one`)
  const accountsB = new Set(b.bots.map((bot) => bot.account))
  const accountsA = new Set(a.bots.map((bot) => bot.account))
  for (const bot of a.bots) if (!accountsB.has(bot.account)) reasons.push(`${bot.persona} (${bot.account.slice(0, 6)}…) is only in A`)
  for (const bot of b.bots) if (!accountsA.has(bot.account)) reasons.push(`${bot.persona} (${bot.account.slice(0, 6)}…) is only in B`)
  for (const [name, r] of [["A", a], ["B", b]] as const) {
    const bad = r.bots.filter((bot) => bot.groupSizes.length === 0 || bot.groupSizes.some((n) => n !== r.bots.length))
    if (bad.length > 0) reasons.push(`${name}: not one group of ${r.bots.length} in every round (group sizes ${[...new Set(bad.map((bot) => bot.groupSizes.join("/") || "unknown"))].join(", ")}); a split or mixed game is not comparable`)
  }
  return reasons
}

export function compareRuns(a: RunSignature, b: RunSignature, overrides: Partial<Floors> = {}): Comparison {
  const reasons = comparabilityReasons(a, b)
  if (reasons.length > 0) throw new NotComparable(reasons)
  const floors: Floors = { ...DEFAULT_FLOORS, ...overrides }
  const rows: MetricRow[] = []
  const decisionDiffs: DecisionDiff[] = []
  const warnings: string[] = []
  const names = new Map([...a.bots, ...b.bots].map((bot) => [bot.account, bot.persona]))

  const number = (metric: string, key: string, va: number, vb: number, floor: number, direction: Direction) =>
    rows.push({ metric, key, a: va, b: vb, delta: Number.isFinite(vb - va) ? vb - va : null, verdict: gradeNumber(va, vb, floor, direction) })
  /** a hard property: it held in A and no longer holds in B is beyond any floor; the reverse is a win */
  const flag = (metric: string, key: string, va: boolean, vb: boolean) =>
    rows.push({ metric, key, a: va, b: vb, delta: null, verdict: va === vb ? "same" : vb ? "better" : "beyond-floor" })

  const inB = new Map(b.bots.map((bot) => [bot.account, bot]))
  for (const botA of a.bots) {
    const botB = inB.get(botA.account)!
    flag("complete", label(botA), botA.complete, botB.complete)
    if (botA.allConnectedMs !== null && botB.allConnectedMs !== null) number("allConnected", label(botA), botA.allConnectedMs, botB.allConnectedMs, floors.connect, "lower")

    const linksB = new Map(botB.links.map((l) => [l.peer, l]))
    for (const la of botA.links) {
      const lb = linksB.get(la.peer)
      const key = `${label(botA)} → ${nameOf(names, la.peer)}`
      if (!lb) {
        rows.push({ metric: "present", key, a: true, b: false, delta: null, verdict: "beyond-floor" })
        continue
      }
      if (la.connectMs !== null && lb.connectMs !== null) number("connect", key, la.connectMs, lb.connectMs, floors.connect, "lower")
      if (la.connectedBeforeTurn0 !== null && lb.connectedBeforeTurn0 !== null) flag("connectedBeforeTurn0", key, la.connectedBeforeTurn0, lb.connectedBeforeTurn0)
      if (la.firstVideoMs !== null && lb.firstVideoMs !== null) number("firstVideo", key, la.firstVideoMs, lb.firstVideoMs, floors.firstVideo, "lower")
      // every fault or heal episode is graded, paired in order; an episode only one side had counts as 0 ms on the other
      for (let k = 0; k < Math.max(la.recoveries.length, lb.recoveries.length); k++) {
        const ra = la.recoveries[k]
        const rb = lb.recoveries[k]
        if (ra === null || rb === null) continue
        number("recovery", k === 0 ? key : `${key} #${k + 1}`, ra ?? 0, rb ?? 0, floors.recovery, "lower")
      }
      if (la.awayMs !== null && lb.awayMs !== null && (la.awayMs > 0 || lb.awayMs > 0)) number("away", key, la.awayMs, lb.awayMs, floors.away, "lower")
      number("videoRounds", key, la.videoRounds, lb.videoRounds, 0, "higher")
      if (la.coveredTurns !== null && lb.coveredTurns !== null) number("coverage", key, la.coveredTurns, lb.coveredTurns, floors.coverage, "higher")
      // H3, the heal budget: spending more of it than A did for the link is a hard regression; A's sequence is not
      number("attempt", key, la.maxAttempt, lb.maxAttempt, 0, "lower")
      number("heal", key, la.maxHeal, lb.maxHeal, 0, "lower")
      flag("healHeadroom", key, !la.lastHeal, !lb.lastHeal)
      if (la.vote && lb.vote) {
        rows.push({ metric: "vote", key, a: la.vote.verdict, b: lb.vote.verdict, delta: null, verdict: la.vote.verdict === lb.vote.verdict ? "same" : lb.vote.verdict === "person" ? "better" : "beyond-floor" })
      }
      if (la.decisions.join("|") !== lb.decisions.join("|") || la.maxAttempt !== lb.maxAttempt || la.maxHeal !== lb.maxHeal) {
        decisionDiffs.push({ key, a: la.decisions, b: lb.decisions })
      }
    }
  }
  const commits = (r: RunSignature) => [...new Set(r.bots.map((bot) => bot.commit?.slice(0, 8)).filter(Boolean))]
  if (commits(a).join() !== commits(b).join()) warnings.push(`harness commit differs (A ${commits(a).join("/") || "?"}, B ${commits(b).join("/") || "?"}): the builds are not identical, read the verdicts as an upper bound on noise`)

  return {
    rows,
    blocking: rows.filter((r) => r.verdict === "worse" || r.verdict === "beyond-floor"),
    wins: rows.filter((r) => r.verdict === "better"),
    decisionDiffs,
    warnings,
    floors,
  }
}

// ── the command line ─────────────────────────────────────────────────────────

const USAGE = "usage: game-signature.mts <runDir> [--wave <phase>] [--json <file>]\n       game-signature.mts --compare <runDirA> <runDirB> [--wave <phase>] [--floor <metric>=<ms> ...] [--json <file>] [--all]"

export type Args =
  | { kind: "sign"; dir: string; json: string | undefined; wave: string | undefined }
  | { kind: "compare"; dirA: string; dirB: string; floors: Partial<Floors>; json: string | undefined; wave: string | undefined; all: boolean }

export function parseArgs(argv: readonly string[]): Args {
  const positional: string[] = []
  const floors: Partial<Floors> = {}
  let json: string | undefined
  let wave: string | undefined
  let compare = false
  let all = false
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === "--compare") compare = true
    else if (arg === "--all") all = true
    else if (arg === "--json") json = argv[++i]
    else if (arg === "--wave") wave = argv[++i]
    else if (arg === "--floor") {
      const m = /^([A-Za-z]+)=(\d+(?:\.\d+)?)$/.exec(argv[++i] ?? "")
      if (!m) throw new Error("--floor takes <metric>=<ms>, e.g. --floor connect=500")
      if (!(m[1]! in DEFAULT_FLOORS)) throw new Error(`unknown floor metric ${m[1]}; known: ${Object.keys(DEFAULT_FLOORS).join(", ")}`)
      floors[m[1] as FloorName] = Number(m[2])
    } else positional.push(arg)
  }
  if (compare) {
    if (positional.length !== 2) throw new Error(USAGE)
    return { kind: "compare", dirA: positional[0]!, dirB: positional[1]!, floors, json, wave, all }
  }
  if (positional.length !== 1) throw new Error(USAGE)
  return { kind: "sign", dir: positional[0]!, json, wave }
}

const cell = (n: number | null): string => (n === null ? "-" : n === Infinity ? "never" : String(Math.round(n)))
const noInfinity = (_key: string, value: unknown): unknown => (typeof value === "number" && !Number.isFinite(value) ? null : value)

function table(header: readonly string[], body: readonly string[][]): string[] {
  const widths = header.map((h, i) => Math.max(h.length, ...body.map((r) => r[i]!.length)))
  const line = (r: readonly string[]) => `| ${r.map((c, i) => c.padEnd(widths[i]!)).join(" | ")} |`
  return [line(header), `| ${widths.map((w) => "-".repeat(w)).join(" | ")} |`, ...body.map(line)]
}

export function renderSignature(run: RunSignature, json = false): string {
  if (json) return JSON.stringify(run, noInfinity, 2)
  const names = new Map(run.bots.map((b) => [b.account, b.persona]))
  const out = [`# Game signature: run ${run.runId}, wave ${run.wave}`, ""]
  for (const bot of run.bots) {
    out.push(`## bot ${bot.slot} ${bot.persona} (${bot.account.slice(0, 6)}…) game ${bot.game ?? "?"}`)
    out.push(`complete ${bot.complete} (signedUp ${bot.signedUp}, reportSeen ${bot.reportSeen}, settled ${bot.settled}, prizeDraw ${bot.reachedPrizeDraw}, confirmedBy ${bot.confirmedBy ?? "-"}); groups ${bot.groupSizes.join("/") || "?"}; all connected ${cell(bot.allConnectedMs)} ms; mesh generations ${bot.generations}`)
    for (const f of bot.flags) out.push(`flag: ${f}`)
    out.push("")
    out.push(...table(
      ["bot", "peer", "connect ms", "<turn0", "1st video ms", "recovery ms", "away ms", "rounds", "covered", "path", "vote", "decisions (diagnostic)"],
      bot.links.map((l) => [
        bot.persona,
        names.get(l.peer) ?? `${l.peer.slice(0, 6)}…`,
        cell(l.connectMs),
        l.connectedBeforeTurn0 === null ? "-" : l.connectedBeforeTurn0 ? "yes" : "NO",
        cell(l.firstVideoMs),
        l.recoveries.length ? l.recoveries.map(cell).join("/") : "-",
        cell(l.awayMs),
        String(l.videoRounds),
        l.turns === null ? "-" : `${l.coveredTurns}/${l.turns}`,
        l.path ?? "-",
        l.vote ? `${l.vote.verdict} ${l.vote.personTurns}/${l.vote.notPersonTurns}` : "-",
        l.decisions.join("; ") || "-",
      ]),
    ))
    out.push("")
  }
  out.push("recovery ms: one figure per fault or heal episode on the link (anchor to the next video line); never = no video came.")
  return out.join("\n")
}

export function renderComparison(a: RunSignature, b: RunSignature, c: Comparison, all = false): string {
  const out = [`# Game signature compare: A run ${a.runId} vs B run ${b.runId}, wave ${a.wave}`, ""]
  out.push(`VERDICT: ${c.blocking.length === 0 ? "PASSES" : "BLOCKS"} (${c.blocking.length} blocking, ${c.wins.length} win(s), ${c.decisionDiffs.length} decision-sequence difference(s), diagnostic only)`)
  out.push(`floors (ms; coverage in seat-turns): ${Object.entries(c.floors).map(([k, v]) => `${k}=${v}`).join(", ")}`)
  for (const w of c.warnings) out.push(`warning: ${w}`)
  out.push("")
  out.push("## Outcome metrics")
  const metrics = [...new Set(c.rows.map((r) => r.metric))]
  const count = (rows: readonly MetricRow[], v: Verdict) => String(rows.filter((r) => r.verdict === v).length)
  out.push(...table(["metric", "n", "same", "better", "worse", "beyond-floor"], metrics.map((m) => {
    const rows = c.rows.filter((r) => r.metric === m)
    return [m, String(rows.length), count(rows, "same"), count(rows, "better"), count(rows, "worse"), count(rows, "beyond-floor")]
  })))
  out.push("")
  const shown = c.rows.filter((r) => all || r.verdict !== "same")
  out.push(all ? "Every paired figure (A, B, B-A):" : "Every figure that is not `same` (A, B, B-A); pass --all for the rest:")
  if (shown.length === 0) out.push("(none)")
  else {
    const show = (v: MetricRow["a"]) => String(v === Infinity ? "never" : v)
    out.push(...table(["metric", "key", "A", "B", "delta", "verdict"], shown.map((r) => [r.metric, r.key, show(r.a), show(r.b), r.delta === null ? "-" : String(Math.round(r.delta)), r.verdict])))
  }
  out.push("")
  out.push("## Decision sequence (diagnostic: explains a difference, never decides one)")
  if (c.decisionDiffs.length === 0) out.push("identical on every paired link")
  for (const d of c.decisionDiffs) out.push(`${d.key}: A [${d.a.join("; ")}] vs B [${d.b.join("; ")}]`)
  return out.join("\n")
}

export interface Io {
  out: (text: string) => void
  err: (text: string) => void
}

const stdio: Io = { out: (t) => process.stdout.write(t), err: (t) => console.error(t) }

export function main(argv: readonly string[], io: Io = stdio): number {
  let args: Args
  try {
    args = parseArgs(argv)
  } catch (err) {
    io.err((err as Error).message)
    return 2
  }
  try {
    if (args.kind === "sign") {
      const run = readRun(args.dir, { wave: args.wave })
      io.out(`${renderSignature(run)}\n`)
      if (args.json) writeFileSync(args.json, renderSignature(run, true))
      return 0
    }
    const a = readRun(args.dirA, { wave: args.wave })
    const b = readRun(args.dirB, { wave: args.wave })
    const comparison = compareRuns(a, b, args.floors)
    io.out(`${renderComparison(a, b, comparison, args.all)}\n`)
    if (args.json) writeFileSync(args.json, JSON.stringify({ a, b, comparison }, noInfinity, 2))
    return comparison.blocking.length === 0 ? 0 : 1
  } catch (err) {
    io.err((err as Error).message)
    return 2
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main(process.argv.slice(2)))
