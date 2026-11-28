// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// A TURN THE PLAYER MISSED BECAUSE THEY WERE DOWN is sealed as a reject (NotPerson), and that stays (product decision,
// game 194): it keeps people from gaming the report. It is NOT late join, which gives the benefit of the doubt to
// players you never shared a turn with. So a role that goes down (kill-relaunch, host-crash) must not be held to
// "every co-player Person": its expectation is what the app's own rule gives.
//
// The rule is lib/game-roster.ts: one verdict per co-player for the WHOLE game, the strict majority of the taps that
// player collected across every turn (a tie is a reject); a turn the player sat out is sealed NotPerson for everyone
// who was not hosting it, and so is every votable tile left undecided at a turn's end (sealTurn auto-rejects it).
// The harness re-implements it here on purpose (an independent oracle, never the devLog's own counts). The check is per
// bot and reads only the report THAT bot filed (chain-checks.ts checkChainVotes): a co-player that froze, hid or
// reloaded is charged by others' verdicts on it, never by this bot's check, so a disrupted co-player cannot fail a
// healthy bot (down-turns.test.ts). Pure; vitest pins it (down-turns.test.ts) against game 194's real bot 5 and bot 10
// and game 57's bot 5.
//
// WHAT THE BOT TAPPED (#351, #399). A turn the timeline shows is not thereby a turn the bot voted in: game 57's bot 5
// rejoined turn 11 four seconds before it sealed, its first click stalled on the cold page and three more went out in the
// ending stage, where the auto-reject flash is turning the tiles and a tap is ignored. The harness's own log said "ok"
// for all four. So every turn the bot did not miss is judged on its tap log (taps-N.log, which journey.pw.ts writes, never
// the app's devLog): a co-player counts as tapped only by an ok click whose STAMP says the page was in the session's
// introduction or gameplay stage of that turn when the click was decided (VOTABLE_STAGES, record.ts: the app records a
// tap in both) (the page's data-stage / data-turn, read again before each
// click). Anything else votable in that turn is NotPerson, as the app seals it. A log without stamps (a build that
// predates data-stage) is not guessed at: the tap check is skipped and the check says so.
import type { FiledReport } from "./chain-checks"
import { VOTABLE_STAGES, type TapRecord, type TickRow } from "./record"
import type { RoleAction } from "./role-proof"

/** an interval the role's own acts say it was down: ISO times, `to` null when it never came back */
export interface DownWindow {
  from: string
  to: string | null
  what: string
  /** the page stayed alive and kept drawing turns, but the bot could not tap (hidden, frozen): a frame inside the
   *  window is no proof the turn was played */
  blind?: true
}

/** The acts that open and close a window, and whether the page kept drawing turns the bot could not play. A reload
 *  draws nothing while it loads; a hidden page draws every turn and takes no tap; a frozen page draws nothing, and the
 *  frames read as it thaws are stamped inside the window. */
const WINDOW_ACTS = [
  ["killed", "relaunched", false],
  ["host-killed", "host-restarted", false],
  ["reloading", "reloaded", false],
  ["hidden", "visible", true],
  ["frozen", "thawed", true],
] as const

/** The role's recorded acts as down windows: killed -> relaunched, host-killed -> host-restarted, reloading -> reloaded,
 *  hidden -> visible, frozen -> thawed. */
export function downWindows(acts: readonly RoleAction[]): DownWindow[] {
  const out: DownWindow[] = []
  for (const [down, up, blind] of WINDOW_ACTS) {
    for (const d of acts.filter((a) => a.id === down)) {
      const back = acts.filter((a) => a.id === up && a.at >= d.at).sort((x, y) => (x.at < y.at ? -1 : 1))[0]
      out.push({ from: d.at, to: back?.at ?? null, what: `${down}, ${up}`, ...(blind && { blind: true as const }) })
    }
  }
  return out.sort((x, y) => (x.from < y.from ? -1 : 1))
}

/** The last timeline frame that names a turn at or before `iso`: the turn the bot was in at that moment. */
const lastFrameAtOrBefore = (rows: readonly TickRow[], iso: string): TickRow | undefined =>
  [...rows].reverse().find((r) => r.turn != null && (r.t ?? "") <= iso)

/**
 * The turns the bot MISSED: turns from the one it was in when it went down up to (not including) the first turn its
 * page showed playing after it came back, that no play-stage frame of its timeline shows. The timeline's own turns,
 * never a clock: a relaunched page runs behind the chain's clock (game 194: turn 11 on screen while the wall clock was
 * in turn 12), and the app counts the turn it shows. A host that crashed under an open page keeps showing every turn,
 * so it misses none.
 */
export function missedTurns(rows: readonly TickRow[], windows: readonly DownWindow[], totalTurns: number): number[] {
  // a BLIND window's frames show turns the bot could not tap: they do not count as played
  const inBlind = (r: TickRow) => windows.some((w) => w.blind && (r.t ?? "") >= w.from && (w.to === null || (r.t ?? "") <= w.to))
  const played = new Set<number>()
  for (const r of rows) if (r.stage === "play" && r.turn != null && !inBlind(r)) played.add(r.turn)
  const missed = new Set<number>()
  for (const w of windows) {
    const before = lastFrameAtOrBefore(rows, w.from)
    // a blind window: the first turn played is the first one shown AFTER it closed
    const backAt = w.blind ? (w.to ?? "\uffff") : w.from
    const after = rows.find((r) => r.stage === "play" && r.turn != null && (r.t ?? "") > backAt)
    const first = before?.turn ?? after?.turn
    if (first == null) continue
    const end = w.to === null ? totalTurns + 1 : (after?.turn ?? totalTurns + 1)
    for (let t = first; t < end; t++) if (!played.has(t)) missed.add(t)
  }
  return [...missed].sort((a, b) => a - b)
}

/**
 * The turns a recovering bot cannot be held to a decoded-video verdict on (#499): the turns of each down window and the
 * one turn after it. A window runs from the turn the bot was in when it went down (the last frame at or before `from`;
 * the first play frame after it when there is none) to the recovery turn, `max(first turn shown after `to`, last turn
 * shown at or before `to` + 1)`: a page that comes back mid-turn recovers on the next one (game 190 bot 14: thawed in turn
 * 9, flagged turn 10), a page reopened after a host restart shows a turn it was not watching (bot 12: window in turns 8-9,
 * first frame turn 10) and a relaunch lands on the turn it loads in (bot 2: killed in turn 8, first frame turn 9). Unlike
 * `missedTurns` this covers a window that missed nothing (a host crash under an open page, a freeze). A window that never
 * closed runs to the last turn. Pure, no clock: the timeline's own turns.
 */
export function downTurns(rows: readonly TickRow[], windows: readonly DownWindow[], totalTurns: number): number[] {
  const turns = new Set<number>()
  const stamped = rows.filter((r) => r.turn != null)
  // a window that opens after the last play frame (the confirm-stage hide) touches no turn: every turn was played in full
  const lastPlay = [...rows].reverse().find((r) => r.stage === "play" && r.turn != null)?.t ?? ""
  for (const w of windows) {
    if (w.from > lastPlay) continue
    const before = lastFrameAtOrBefore(rows, w.from)
    const first = before?.turn ?? stamped.find((r) => (r.t ?? "") > w.from)?.turn
    if (first == null) continue
    let last = totalTurns
    if (w.to !== null) {
      const to = w.to
      const atEnd = lastFrameAtOrBefore(rows, to)?.turn ?? first
      const after = stamped.find((r) => (r.t ?? "") > to)?.turn ?? 0
      last = Math.min(totalTurns, Math.max(after, atEnd + 1))
    }
    for (let t = first as number; t <= last; t++) turns.add(t)
  }
  return [...turns].sort((a, b) => a - b)
}

export interface Expected {
  verdict: "Person" | "NotPerson"
  person: number
  notPerson: number
  missedTurns: number[]
  /** turns first observed only after the gesture cutoff, which the product
   * still seals NotPerson even though the harness waives a manual tap */
  autoRejectedTurns?: number[]
  /** turns the bot played but did not tap this co-player in (sealed NotPerson); absent when there were none */
  untappedTurns?: number[]
}

/** Who the bot could vote on in `turn` (1-based): its round's group but itself and the turn's host. Turn t of round r is
 *  hosted by seat t - 1 - r * maxGroupSize of that round's group: the occupied seats ascending by player index, the
 *  vacant ones at the tail (a vacant host seat excludes nobody). */
export function votableIn(report: FiledReport, maxGroupSize: number, turn: number): string[] {
  const group = report.rounds[Math.floor((turn - 1) / maxGroupSize)]
  if (!group) return []
  const seats = [...group.members].sort((a, b) => a.index - b.index)
  const host = seats[(turn - 1) % maxGroupSize]
  return seats.filter((m) => m.index !== group.ownIndex && m !== host).map((m) => m.player)
}

/** What the tap log can say: usable, or why not. */
export function tapEvidence(taps: readonly TapRecord[] | undefined): "stamped" | "unstamped" | "none" {
  if (!taps || taps.length === 0) return "none"
  return taps.some((t) => t.stage !== undefined && t.stage !== "unknown") ? "stamped" : "unstamped"
}

/** The co-players the bot tapped Person on inside a votable stage (introduction, gameplay) of `turn`. */
const tappedIn = (taps: readonly TapRecord[], turn: number): Set<string> =>
  new Set(taps.filter((t) => t.turn === turn && t.result === "ok" && t.stage !== undefined && VOTABLE_STAGES.has(t.stage)).map((t) => t.id))

/**
 * Per co-player, the verdict the app files over the whole game: a Person for each turn the bot tapped them in (every votable
 * co-player when `taps` is absent), a NotPerson for each turn it sat out (`missed`) or, with `taps`, left them undecided.
 * A co-player is votable in every turn of every round they share with the bot except the one they host (the bot's own
 * hosting turn included: it still votes).
 */
export function expectedVerdicts(
  report: FiledReport,
  maxGroupSize: number,
  missed: readonly number[],
  taps?: readonly TapRecord[],
  eligible: (turn: number, player: string) => boolean = () => true,
  autoRejected: (turn: number, player: string) => boolean = () => false,
): Map<string, Expected> {
  const sat = new Set(missed)
  const tally = new Map<string, Expected>()
  for (const { ownIndex, members } of report.rounds)
    for (const m of members) if (m.index !== ownIndex && !tally.has(m.player)) tally.set(m.player, { verdict: "Person", person: 0, notPerson: 0, missedTurns: [] })
  for (let turn = 1; turn <= report.rounds.length * maxGroupSize; turn++) {
    const tapped = taps && !sat.has(turn) ? tappedIn(taps, turn) : null
    for (const player of votableIn(report, maxGroupSize, turn)) {
      if (!eligible(turn, player)) continue
      const e = tally.get(player) as Expected
      if (sat.has(turn)) {
        e.notPerson++
        e.missedTurns.push(turn)
      } else if (autoRejected(turn, player)) {
        e.notPerson++
        e.autoRejectedTurns = [...(e.autoRejectedTurns ?? []), turn]
      } else if (tapped && !tapped.has(player)) {
        e.notPerson++
        e.untappedTurns = [...(e.untappedTurns ?? []), turn]
      } else e.person++
    }
  }
  for (const e of tally.values()) e.verdict = e.person > e.notPerson ? "Person" : "NotPerson"
  return tally
}

/** What checkChainVotes needs to hold a role that was down to the right expectation. */
export interface DownInfo {
  missed: readonly number[]
  /** every turn of a down window plus the recovery turn after it (downTurns); absent when the caller did not derive it.
   *  Unknown decoded-video evidence on these turns is inconclusive, not a failure (#499). */
  downTurns?: readonly number[]
  /** the bot's own tap log, for the turns it played */
  taps?: readonly TapRecord[]
  maxGroupSize: number
  /** the windows in words, for the check's detail */
  windows: string
}
