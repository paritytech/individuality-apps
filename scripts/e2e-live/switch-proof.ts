// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// THE MID-GAME NETWORK SWITCH, PROVEN (profile switcher-pixel6a-wifi-to-cell, #541). Until now the proof was "the step's
// calls ran" (verifyRoleActs: fired === planned). dueSteps fires on `turn >= atTurn` off the page's turn, so a swap at turn 8
// of a turn-6 plan passed too, and nothing said the blackout lasted or that the app came back. This judges four things, each
// of which can fail on its own:
//
//   1 ran        the swap call ran and finished ok, netem active (an inactive or failed or inconclusive one is never a pass)
//   2 in turn    the swap STARTED inside its planned turn on the app's exact GameSource clock and calculateSnapshot state
//                machine. This is also the clock that schedules the action. A separate BEST-block watch is retained only as
//                a diagnostic because block arrival can lag authored pallet time by more than one action window.
//   3 blackout   the blackout call finished ok and ran at least blackoutS (its call sleeps the cut and then probes the link,
//                so it runs longer, never shorter)
//   4 recovered  the bot's own tile timeline (tiles-N.jsonl), PER PEER: each peer that was clear just before the cut shows a
//                connection status (Connecting, Can't connect, No signal) during it and is clear again before the game ends;
//                a peer already degraded going in is not judged
//
// A ROUND CHANGE ENDS THE DROP'S EVIDENCE. At the round's end the mesh closes and the next group's tiles open on "Connecting"
// whatever the link does, so a status after it proves nothing about the cut (game 301 "passed" on exactly that: one peer sat
// in both groups and its round-start Connecting was read as the drop). A face only turns to Connecting after TILE_DROP_LAG_MS
// without video (lib/webrtc/seat-state.ts: 7 s stale, then a 3 s hold), so a cut that meets the round change sooner can
// not show its drop on a tile at all: game 311's turn-6 cut (6 seats, the round's last turn) met it 11.6 s in, after the app
// had logged every link's ICE disconnected and connection_stalled. Then the check is NOT PROVABLE (unchecked), never a fail,
// and still fails if the next group's peers never come clear before the game ends.
//
// Each diagnostic anchor pairs the best block's timestamp with the END of the successful read (readingAnchor), so latency can
// only make the estimate stale. Timestamp.Now can repeat across best blocks, so journey.pw.ts retains the freshest repeated
// arrival for useful logging. It never schedules an action or determines a verdict.
import type { Check } from "./chain-checks"
import type { NetworkCallRun } from "./network"
import { TURN_S, turnStartS } from "./roles"
import { appClockSecondAt, appGameMoment, type AppClockReading } from "./game-clock"

/** a blackout call may be a little short of its nominal cut (the sleep starts after the rule is in) */
export const BLACKOUT_TOLERANCE_S = 1
/** from the blackout CALL's start until a clear tile can show a status: netem.sh waits 1 s and probes before the rule goes in
 *  (up to ~4 s), then the face needs 7 s without video and a 3 s hold before it turns to Connecting (seat-state.ts SEAT_TIMES) */
export const TILE_DROP_LAG_MS = 14_000

export interface ChainAnchor {
  chainNowS: number
  wallNowMs: number
  source?: "seed" | "watch"
  readSpanMs?: number
  sampleCount?: number
}
export interface SwitchGame {
  gameAt: number
  rounds: number
  maxGroupSize: number
}

/** Long reads are retained in watch evidence but cannot anchor a turn: retry stalls otherwise create a sticky outlier. */
export const MAX_CHAIN_CLOCK_SAMPLE_SPAN_MS = 2000

/** The best block's timestamp anchored at query completion. This deliberately biases only stale: the block existed no later
 *  than its response. Null without a best-block time, with invalid bounds, or when the successful attempt took too long. */
export function readingAnchor(readStartMs: number, readEndMs: number, chainBestNowS: number | undefined, source?: ChainAnchor["source"]): ChainAnchor | null {
  const span = readEndMs - readStartMs
  if (chainBestNowS === undefined || ![readStartMs, readEndMs, chainBestNowS].every(Number.isFinite) || span < 0 || span > MAX_CHAIN_CLOCK_SAMPLE_SPAN_MS) return null
  return { chainNowS: chainBestNowS, wallNowMs: readEndMs, ...(source ? { source, readSpanMs: span } : {}) }
}

/** Keep the best (least stale) observed chain-to-wall offset, as the page does. A repeated Timestamp.Now value can only make
 *  an anchor older, so the greatest offset is the freshest safe sample even when a later read repeats an old block value. */
export function freshestAnchor(anchors: readonly (ChainAnchor | null)[]): ChainAnchor | null {
  let freshest: ChainAnchor | null = null
  for (const anchor of anchors) {
    if (!anchor) continue
    if (!freshest || anchor.chainNowS - anchor.wallNowMs / 1000 > freshest.chainNowS - freshest.wallNowMs / 1000) freshest = anchor
  }
  return freshest
}

/** The first valid watch sample replaces the subprocess seed outright. Afterwards the watch's stale-only maximum is sticky. */
export function selectWatchedAnchor(current: ChainAnchor | null, sample: ChainAnchor, sampleCount: number): ChainAnchor {
  const selected = freshestAnchor(sampleCount === 1 ? [sample] : [current, sample]) ?? sample
  return { ...selected, sampleCount }
}

/** Decode one clock sample streamed by chain-read.mts's watch. Event diagnostics share stderr, so unrelated or malformed
 *  lines are ignored and can never poison the last valid anchor. */
export function watchedClockAnchor(line: string): ChainAnchor | null {
  if (!line.startsWith("CLOCK ")) return null
  try {
    const sample = JSON.parse(line.slice(6)) as { readStartMs?: unknown; readEndMs?: unknown; chainBestNow?: unknown }
    if (typeof sample.readStartMs !== "number" || typeof sample.readEndMs !== "number" || typeof sample.chainBestNow !== "number") return null
    return readingAnchor(sample.readStartMs, sample.readEndMs, sample.chainBestNow, "watch")
  } catch {
    return null
  }
}

export interface WatchedClockChunks {
  tail: string
  anchors: ChainAnchor[]
}

/** Parse complete stderr lines while retaining a trailing partial for the next chunk. A child that exits mid-line loses only
 *  that incomplete sample; event diagnostics and malformed CLOCK lines never enter the anchor set. */
export function accumulateWatchedClock(tail: string, chunk: string): WatchedClockChunks {
  const lines = `${tail}${chunk}`.split("\n")
  const nextTail = lines.pop() ?? ""
  return { tail: nextTail, anchors: lines.map(watchedClockAnchor).filter((anchor): anchor is ChainAnchor => anchor !== null) }
}

/** The plan of the switcher's step, from its profile's network (networkPlan pushes the switchAtTurn sugar FIRST, so it is step 1);
 *  null for a profile with no switch. */
export const switchPlanOf = (n: { switchAtTurn?: number; switchTo?: string; blackoutS?: number }): SwitchPlan | null =>
  n.switchAtTurn !== undefined && n.switchTo !== undefined ? { step: 1, atTurn: n.switchAtTurn, blackoutS: n.blackoutS ?? 0 } : null

/** The chain second at wall ms `wallMs`, from one simultaneous reading. */
export const chainSecondAt = (wallMs: number, anchor: ChainAnchor): number => anchor.chainNowS + (wallMs - anchor.wallNowMs) / 1000

/** Where a chain second falls in the game: the 1-based turn it is in and the seconds into it, or turn 0 before the game and
 *  `inGap` in the pause between rounds (the turn reported is the one that just ended). */
export function turnAtChainSecond(g: SwitchGame, chainS: number): { turn: number; intoS: number; inGap: boolean } {
  const since = chainS - g.gameAt
  const total = Math.max(1, g.rounds * g.maxGroupSize)
  let turn = 0
  for (let t = 1; t <= total; t++) if (turnStartS(g, t) <= since) turn = t
  if (turn === 0) return { turn: 0, intoS: since, inGap: false }
  const into = since - turnStartS(g, turn)
  return { turn, intoS: into, inGap: into >= TURN_S }
}

/** The wall ms the mesh regroups after `fromMs`: the end of the round the cut is in, when the next round's group opens on
 *  Connecting. Null without a best-block anchor, or when the cut is in the last round (no regroup before the game ends). */
export function regroupWallMs(g: SwitchGame, anchor: ChainAnchor | null, fromMs: number): number | null {
  if (!anchor) return null
  const seats = Math.max(1, g.maxGroupSize)
  for (let k = 1; k < g.rounds; k++) {
    const wallMs = anchor.wallNowMs + (g.gameAt + turnStartS(g, k * seats) + TURN_S - anchor.chainNowS) * 1000
    if (wallMs > fromMs) return wallMs
  }
  return null
}

export interface SwitchRow {
  snapshotAt?: string
  t?: string
  /** the page's stage: the next group is read off the round's own frames, never the confirm stage's review grid */
  stage?: string
  tiles?: { id?: string; role?: string; text?: string }[]
}
const rowMs = (r: SwitchRow): number => Date.parse(r.snapshotAt ?? r.t ?? "")
/** A peer tile showing a connection status instead of a face. Never the "unseen" role: its "Can't connect" is permanent. */
const STATUS = /connecting|can'?t connect|no signal|reconnecting/i
type Peer = { id?: string; role?: string; text?: string }
const isPeer = (t: Peer): boolean => (t.role === "coplayer" || t.role === "host") && !!t.id
/** any other player's tile, an unseen one too (a next group's peer is unseen until its face first arrives) */
const isOther = (t: Peer): boolean => (isPeer(t) || t.role === "unseen") && !!t.id && !t.id.startsWith("ghost:")
const degraded = (t: Peer): boolean => STATUS.test(t.text ?? "")
/** how far before the cut a frame may be and still say which peers were clear going in */
const BEFORE_CUT_MS = 20_000

export interface LinkRecovery {
  dropped: string[]
  recovered: string[]
  /** dropped, then gone from the grid (the round changed) before a frame could show them clear */
  left: string[]
  ignored: string[]
  droppedAtMs: number | null
  recoveredAtMs: number | null
  framedBefore: boolean
  /** the peers clear in that frame: the only ones judged */
  clearIn: number
  /** the recorder wrote at least one frame from BEFORE_CUT_MS before the cut to `toMs` */
  framed: boolean
  /** when the mesh regrouped inside the window (the earlier of the schedule and the frame that swapped players), or null:
   *  the drop was looked for only before it */
  regroupMs: number | null
  /** the next group's players (the grid after the regroup), and those shown clear before `toMs` */
  next: { peers: string[]; clear: string[]; firstClearMs: number | null; lastClearMs: number | null }
}

const others = (r: SwitchRow): Set<string> => new Set((r.tiles ?? []).filter(isOther).map((t) => t.id as string))
/** The first frame in [fromMs, toMs] whose grid SWAPS players against the frame before it (one leaves and another arrives): the
 *  next round's group. A late joiner filling an empty seat only adds one, so it is not a regroup. */
function observedRegroup(rows: readonly SwitchRow[], fromMs: number, toMs: number): number | null {
  let prev: Set<string> | null = null
  for (const r of rows) {
    if (!r.tiles?.length) continue
    const ids = others(r)
    if (prev && rowMs(r) >= fromMs && rowMs(r) <= toMs && [...ids].some((id) => !prev?.has(id)) && [...prev].some((id) => !ids.has(id))) return rowMs(r)
    prev = ids
  }
  return null
}

/** Did the link drop during the cut and come back, judged PER PEER? A peer counts only if it was clear in the last frame just
 *  before the cut and showed a status during the cut, BEFORE THE REGROUP (after it every tile opens on Connecting anyway); it
 *  recovered when a later frame shows it clear again. The regroup is the earlier of `scheduledRegroupMs` (the round's end on
 *  the app clock) and the first frame that swaps players. A peer that was already degraded going in (a never-connecting lite
 *  peer, a video-return bot with video off, a dark seat) is not judged either way and is listed in `ignored`. */
export function linkRecovery(rows: readonly SwitchRow[], fromMs: number, toMs: number, scheduledRegroupMs: number | null = null): LinkRecovery {
  const before = [...rows].reverse().find((r) => rowMs(r) < fromMs && rowMs(r) >= fromMs - BEFORE_CUT_MS && r.tiles?.some(isPeer))
  const scheduled = scheduledRegroupMs !== null && scheduledRegroupMs > fromMs && scheduledRegroupMs <= toMs ? scheduledRegroupMs : null
  const observed = observedRegroup(rows, fromMs, toMs)
  const regroupMs = scheduled === null ? observed : observed === null ? scheduled : Math.min(scheduled, observed)
  const none = { dropped: [], recovered: [], left: [], ignored: [], droppedAtMs: null, recoveredAtMs: null, regroupMs, next: { peers: [], clear: [], firstClearMs: null, lastClearMs: null } }
  const framed = rows.some((r) => rowMs(r) >= fromMs - BEFORE_CUT_MS && rowMs(r) <= toMs)
  if (!before) return { ...none, framedBefore: false, clearIn: 0, framed }
  const peers = (before.tiles ?? []).filter(isPeer)
  const ignored = peers.filter(degraded).map((t) => t.id as string)
  const clearIn = new Set(peers.filter((t) => !degraded(t)).map((t) => t.id as string))
  const inRange = rows.filter((r) => rowMs(r) >= fromMs && rowMs(r) <= toMs)
  const dropEnd = regroupMs ?? Infinity
  const dropped: string[] = []
  const recovered: string[] = []
  const left: string[] = []
  let droppedAtMs: number | null = null
  let recoveredAtMs: number | null = null
  for (const id of clearIn) {
    const downIn = (r: SwitchRow) => !!r.tiles?.some((t) => isPeer(t) && t.id === id && degraded(t))
    const down = inRange.findIndex((r) => rowMs(r) < dropEnd && downIn(r))
    if (down < 0) continue
    dropped.push(id)
    droppedAtMs = Math.min(droppedAtMs ?? Infinity, rowMs(inRange[down]))
    // the drop's own end: the last status frame BEFORE the regroup. A later status is not this cut (game 317: bot 24's own
    // reload put its tile on Connecting in turn 12, and the cut read "clear again by 137.0 s" for a heal that took 28 s).
    const lastDown = inRange.findLastIndex((r) => rowMs(r) < dropEnd && downIn(r))
    const back = inRange.slice(lastDown + 1).find((r) => r.tiles?.some((t) => isPeer(t) && t.id === id && !degraded(t)))
    if (back) {
      recovered.push(id)
      recoveredAtMs = Math.max(recoveredAtMs ?? 0, rowMs(back))
    } else if (!inRange.slice(lastDown + 1).some((r) => others(r).has(id))) left.push(id)
  }
  // the next group: every other player on the round's own grid from the frame that swapped players (else the schedule), and
  // when each was first shown clear; the confirm stage's review grid holds both rounds and is not a round
  const nextFrom = observed ?? scheduled
  const after = nextFrom === null ? [] : inRange.filter((r) => rowMs(r) >= nextFrom && (r.stage === undefined || r.stage === "play" || r.stage === "intro"))
  const nextPeers = [...new Set(after.flatMap((r) => [...others(r)]))]
  const firstClear = new Map<string, number>()
  for (const r of after) for (const t of r.tiles ?? []) if (isPeer(t) && !degraded(t) && !firstClear.has(t.id as string)) firstClear.set(t.id as string, rowMs(r))
  const clear = nextPeers.filter((id) => firstClear.has(id))
  const times = clear.map((id) => firstClear.get(id) as number)
  const next = { peers: nextPeers, clear, firstClearMs: times.length ? Math.min(...times) : null, lastClearMs: times.length ? Math.max(...times) : null }
  return { dropped, recovered, left, ignored, droppedAtMs, recoveredAtMs, framedBefore: true, clearIn: clearIn.size, framed: true, regroupMs, next }
}

export interface SwitchPlan {
  /** 1-based index of the step in the plan's timeline */
  step: number
  atTurn: number
  blackoutS: number
}

export interface SwitchEvidence {
  plan: SwitchPlan
  /** netem was shaping this runner (a desk or E2E_NETEM=0 run only logs the step) */
  live: boolean
  runs: readonly NetworkCallRun[]
  /** canonical app-clock turn observed when the step fired */
  pageTurn: number | null
  /** app GameSource clock observed when the step became due */
  appClock: AppClockReading | null
  /** independent best-block reading, retained only in diagnostic detail */
  anchor: ChainAnchor | null
  game: SwitchGame
  /** the bot's tile rows */
  rows: readonly SwitchRow[]
  /** wall ms the game's last turn ends (the recovery's deadline) */
  gameEndMs: number
}

const sec = (ms: number): string => `${(ms / 1000).toFixed(1)} s`

/** The checks of one switcher bot. Each is its own check so a failure names the half that did not happen. */
export function verifySwitch(n: number, e: SwitchEvidence): Check[] {
  const name = (what: string) => `player ${n} network switch (turn ${e.plan.atTurn}): ${what}`
  const mine = e.runs.filter((r) => r.step === e.plan.step)
  const swap = mine.find((r) => r.call[0] === "swap")
  const cut = mine.find((r) => r.call[0] === "blackout")
  if (!e.live) return [{ name: name("ran"), status: "unchecked", detail: "netem was not active on this runner (a desk run, or E2E_NETEM=0): the step is only logged, nothing was proven" }]
  const out: Check[] = []
  const bad = (r: NetworkCallRun | undefined, what: string): string | null => (!r ? `the ${what} call never ran` : !r.ok ? `the ${what} call failed` : r.inconclusive ? `the ${what} call came back INCONCLUSIVE (netem acted but could not show every side)` : null)
  const ranBad = bad(swap, "swap") ?? (e.plan.blackoutS > 0 ? bad(cut, "blackout") : null)
  out.push({ name: name("ran"), status: ranBad ? "fail" : "pass", detail: ranBad ?? `swap and blackout finished ok (${mine.length} call(s))` })

  // 2: inside its planned turn, on the exact clock/state-machine pair used by the app
  if (!swap) out.push({ name: name("landed in its turn"), status: "fail", detail: "no swap call to place" })
  else if (!e.appClock) out.push({ name: name("landed in its turn"), status: "fail", detail: "the page supplied no app clock when the step fired" })
  else {
    const appS = appClockSecondAt(e.appClock, swap.startMs)
    const start = e.game.gameAt + turnStartS(e.game, e.plan.atTurn)
    const at = appGameMoment(
      { ...e.appClock, nowMs: appS * 1000, nowSeconds: Math.floor(appS), readAtMs: swap.startMs },
      { gameDate: e.game.gameAt, reportEnds: Number.MAX_SAFE_INTEGER, rounds: e.game.rounds, maxGroupSize: e.game.maxGroupSize },
    )
    const rel = appS - start
    const inTurn = at.turn === e.plan.atTurn
    const diagnostic = e.anchor
      ? `; independent best-block diagnostic ${(e.anchor.chainNowS - e.anchor.wallNowMs / 1000).toFixed(1)} s off runner wall`
      : "; no independent best-block diagnostic"
    out.push({
      name: name("landed in its turn"),
      status: inTurn ? "pass" : "fail",
      detail: `the swap started ${rel >= 0 ? "+" : ""}${rel.toFixed(1)} s from turn ${e.plan.atTurn}'s start on the app clock; landed-in-turn is by app-clock construction; calculateSnapshot says turn ${at.turn ?? "none"} (${at.stage}); the firing observation said turn ${e.pageTurn ?? "?"}${diagnostic}`,
    })
  }

  // 3: the blackout's length
  if (e.plan.blackoutS > 0) {
    if (!cut || !cut.ok) out.push({ name: name("blackout"), status: "fail", detail: cut ? "the blackout call failed" : "the blackout call never ran" })
    else {
      const ran = cut.endMs - cut.startMs
      const ok = ran >= (e.plan.blackoutS - BLACKOUT_TOLERANCE_S) * 1000
      out.push({ name: name("blackout"), status: ok ? "pass" : "fail", detail: `the cut ran ${sec(ran)} for a planned ${e.plan.blackoutS} s (it also probes the link, so it may run longer, never shorter)` })
    }
  }

  // 4: the link dropped and came back
  const from = (cut ?? swap)?.startMs
  if (from === undefined) out.push({ name: name("link recovered"), status: "fail", detail: "no step ran, so there was no cut to recover from" })
  else {
    const appAnchor = e.appClock ? { chainNowS: e.appClock.nowSeconds, wallNowMs: e.appClock.readAtMs } : null
    const r = linkRecovery(e.rows, from, e.gameEndMs, regroupWallMs(e.game, appAnchor, from))
    const regroupMs = r.regroupMs
    const skipped = r.ignored.length ? ` (${r.ignored.length} peer(s) already on a status before the cut were not judged)` : ""
    const lost = r.dropped.filter((id) => !r.recovered.includes(id) && !r.left.includes(id))
    const nextLine = `the next group's ${r.next.peers.length} peer(s): ${r.next.clear.length ? `${r.next.clear.length} shown clear, the first ${sec((r.next.firstClearMs as number) - from)} and the last ${sec((r.next.lastClearMs as number) - from)} after the cut began` : "none ever clear before the game ended"}`
    // the round changed before a tile could show the drop: neither a pass nor a "did not reach"
    const tooSoon = regroupMs !== null && regroupMs - from < TILE_DROP_LAG_MS
    const lefts = r.left.length ? `; ${r.left.length} left the grid at the round change before a frame could show them clear` : ""
    const seats = Math.max(1, e.game.maxGroupSize)
    const verdict: { status: Check["status"]; detail: string } = !r.framed
        ? { status: "fail", detail: "the recorder wrote no tile frame around the cut (from 20 s before it to the game's end): the recorder was silent" }
      : !r.framedBefore
      ? { status: "unchecked", detail: "no tile frame just before the cut says which peers were clear going in: not provable" }
      : r.clearIn === 0
        ? { status: "unchecked", detail: `no peer was clear going in (every peer in the frame before the cut was on a status or unseen): not provable${skipped}` }
      : lost.length
        ? { status: "fail", detail: `${r.dropped.length} peer(s) dropped (first ${sec((r.droppedAtMs as number) - from)} after the cut began) and ${lost.length} never showed clear again before the game ended${skipped}` }
        : r.recovered.length
          ? { status: "pass", detail: `${r.dropped.length} peer(s) showed a connection status (first ${sec((r.droppedAtMs as number) - from)} after the cut began) and ${r.recovered.length} were clear again by ${sec((r.recoveredAtMs as number) - from)}${lefts}${skipped}` }
          : r.dropped.length
            ? { status: "unchecked", detail: `${r.dropped.length} peer(s) showed a connection status (first ${sec((r.droppedAtMs as number) - from)} after the cut began)${lefts}: their recovery is not provable; ${nextLine}${skipped}` }
            : tooSoon && r.next.peers.length > 0 && !r.next.clear.length
              ? { status: "fail", detail: `the round changed ${sec((regroupMs as number) - from)} after the cut began, and ${nextLine}${skipped}` }
              : tooSoon
                ? { status: "unchecked", detail: `the round changed ${sec((regroupMs as number) - from)} after the cut began, before a clear tile can show a dropped link (${sec(TILE_DROP_LAG_MS)}), and the next group opens on Connecting anyway: not provable from the tiles; ${nextLine}${skipped}` }
                : e.plan.atTurn % seats === 0
                  ? { status: "unchecked", detail: `turn ${e.plan.atTurn} is the last turn of a round in this ${seats}-seat game: the round change meets the cut before a tile can show it, not provable (plan the switch mid-round)${skipped}` }
                  : { status: "fail", detail: `no peer that was clear before the cut showed a connection status after it began${regroupMs !== null ? ` (looked for until the round changed, ${sec((regroupMs as number) - from)} in)` : ""}: the blackout did not reach the link${skipped}` }
    out.push({ name: name("link recovered"), ...verdict })
  }
  return out
}
