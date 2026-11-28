// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import type { Check } from "./chain-checks"

/** One devLog line, as devlog-N.json holds it. */
export interface TrailLine {
  ts: number
  tag: string
  message: string
  data?: unknown
}

export interface EarlyCloseInput {
  slot: number
  /** a Game.ReportSubmitted for this account in this game */
  reported: boolean
  /** the game's Game.GameEnded: its block, that block's Timestamp.Now (chain seconds), and the report_ends the game held
   *  in the block before it (null: unread); null = not seen */
  ended: { block: number; atS: number | null; reportEnds?: number | null } | null
  /** Game.report_ends as read before play, chain seconds: the fallback when the block before the end was not read */
  reportEnds: number
  /** the app's own devLog lines (devlog-N.json): its vote trail and its clock lines */
  lines: readonly TrailLine[]
  /** when play ended (the last turn's end), chain seconds */
  playEndsS: number
}

/** The longest a report built while the window was open may sit before the chain's early close and still count as
 *  overtaken by it: two 12 s blocks. A report built longer before the close had time to land, so its absence means a
 *  submit that hung or never broadcast, which leaves no trail line (Previewnet-Claude's review of #650). */
export const MAX_BUILT_TO_CLOSE_S = 24
/** The app's auto-confirm files this long after play ends (lib/game-session.ts AUTO_CONFIRM_SEC): a page that built no
 *  report by then, and longer than MAX_BUILT_TO_CLOSE_S before the close, sat on an open window without filing. */
const AUTO_CONFIRM_S = 7

/** The clock lines (lib/game-source.ts) that carry the page's target offset, and its field. */
const OFFSET_FIELDS: Record<string, string> = { "clock correction": "toMs", "clock jumped": "toMs", "clock corrected": "offsetMs" }

/** The page's game-clock target offset (game s − device s) at `ts`: the offset of the last clock line at or before it.
 *  The clock starts at the device time, so after "clock ready" and before any move it is 0. null when the page logged
 *  neither, so the page clock cannot be put on the chain's. */
export function chainOffsetAt(lines: readonly TrailLine[], ts: number): number | null {
  let offset: number | null = null
  for (const l of lines) {
    if (l.ts > ts) break
    if (l.tag !== "clock") continue
    if (l.message === "clock ready" && offset === null) offset = 0
    const field = OFFSET_FIELDS[l.message]
    const ms = field && l.data && typeof l.data === "object" ? (l.data as Record<string, unknown>)[field] : undefined
    if (typeof ms === "number" && Number.isFinite(ms)) offset = ms / 1000
  }
  return offset
}

/** The trail lines with which the app leaves /game for the chest once the chain shut the window (game-session.ts). */
const CHEST_HANDOVERS = ["report unknown after the game", "report missed"]
/** The trail lines of a submit that failed while the window was still open: such a report could have counted. */
const OPEN_WINDOW_FAILURES = ["report attempt failed", "report retry"]

const utc = (ms: number) => new Date(ms).toISOString().slice(11, 23)

/**
 * THE CHAIN CLOSED REPORTING EARLY (game 327, bot 13). The pallet leaves Reporting before report_ends as soon as no
 * attendance is pending (pallet-game process_reporting: `pending_attendance == 0`). A player who has not reported
 * can only be decided NotAttended (determine_attendance: Attended needs `sent_report`), so when the game ends early a
 * missing report belongs to a player its co-players had already voted out, and the report could change nothing. The
 * app reads the closed window, files nothing and hands the player to the chest (#601 "gone", #303 "missed").
 *
 * That is INCONCLUSIVE for the bot, never a pass: it did not file, but nothing it could file would have counted. It is
 * a FAIL whenever the chain does not prove the early close (no GameEnded seen, or one at or after report_ends: the
 * window ran its whole length and the report never landed) or the app's trail shows a submit that failed while the
 * window was open, or the trail never says why the app left /game.
 */
export function earlyCloseCheck(input: EarlyCloseInput): Check {
  const name = `player ${input.slot} report closed early by the chain`
  if (input.reported) return { name, status: "pass", detail: "the report landed" }
  const fail = (detail: string): Check => ({ name, status: "fail", detail: `ended on /chest with no report: ${detail}` })
  const { ended } = input
  if (!ended) return fail("no Game.GameEnded seen for the game, so nothing proves the chain shut the window")
  // the value the game held just before it ended: testnet_force_end_reporting moves report_ends to its own block's time
  const reportEnds = ended.reportEnds ?? input.reportEnds
  if (ended.atS === null) return fail(`GameEnded in #${ended.block}, but its block time could not be read, so nothing proves it came before report_ends`)
  if (ended.atS >= reportEnds) return fail(`GameEnded in #${ended.block} at or after report_ends (${ended.atS} >= ${reportEnds}): the window ran its whole length`)
  const vote = input.lines.filter((l) => l.tag === "vote")
  const failure = vote.find((l) => OPEN_WINDOW_FAILURES.includes(l.message))
  if (failure) return fail(`the app logged "${failure.message}" at ${utc(failure.ts)} UTC: a submit failed while the window was open`)
  const handover = vote.filter((l) => CHEST_HANDOVERS.includes(l.message)).at(-1)
  if (!handover) return fail(`the app's trail never says why it left /game (no ${CHEST_HANDOVERS.map((m) => `"${m}"`).join(" or ")})`)
  const built = vote.filter((l) => l.message === "report built").at(-1)
  if (built) {
    // the build on the CHAIN's clock, through the page's own offset: a block time and a page time are never compared raw
    const offset = chainOffsetAt(input.lines, built.ts)
    if (offset === null) return fail(`the page logged no chain-clock offset, so its report built at ${utc(built.ts)} (page clock) cannot be placed against the close`)
    const builtS = built.ts / 1000 + offset
    const gap = ended.atS - builtS
    if (gap > MAX_BUILT_TO_CLOSE_S)
      return fail(`the report was built ${Math.round(gap)} s before GameEnded (chain clock, page offset ${offset} s), more than ${MAX_BUILT_TO_CLOSE_S} s: it had time to land, so a submit hung or never broadcast`)
  } else if (ended.atS - (input.playEndsS + AUTO_CONFIRM_S) > MAX_BUILT_TO_CLOSE_S)
    return fail(`the app built no report although play ended ${ended.atS - input.playEndsS} s before GameEnded: the window stood open with nothing filed`)
  const app = built ? `built its report at ${utc(built.ts)} and filed nothing` : "built no report"
  // two clocks: the block's Timestamp.Now and the page's own; they are never compared with each other here
  return {
    name,
    status: "inconclusive",
    detail:
      `GameEnded in #${ended.block} (block time ${utc(ended.atS * 1000)} UTC), ${reportEnds - ended.atS} s before report_ends, with no report from this account: ` +
      `the pallet ends Reporting early only once no attendance is pending, and a player with no report can only be decided NotAttended, ` +
      `so its co-players had already voted it out and its report could change nothing. On the page clock (UTC) the app ${app}, then left /game with "${handover.message}" at ${utc(handover.ts)}`,
  }
}
