// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// WHAT THE SHAPING REPORT SAYS, as rows a page can render: one line per persona,
// its intended fault next to what the app measured and the verdict.
//
// This is the S4 view of scripts/e2e-live/shaping-impact.mts: that script prints the
// whole evidence trail, which is right for a terminal and wrong for a page a person
// scans. Here the trail is reduced to the one question the brief asks — each persona's
// intended fault next to what was measured — so it can be read without watching videos.
//
// Pure: no I/O, no formatting of the underlying report. The caller passes the same
// rows the reader already built.

/** The verdict vocabulary, exactly as the reader emits it. */
export type ShapingVerdict = "impact seen" | "no impact" | "cannot tell"

/** One persona's line. `measured` is the ONE sentence that carries the reading — the
 *  first evidence line, which is the app's own measurement (rtt, loss, path, rung) —
 *  never the whole trail. */
export interface ShapingSummaryRow {
  persona: string
  bot: number
  /** which attempt produced this row; a re-run bot appears once per attempt */
  attempt: number
  /** a later attempt for the same slot supersedes this one: it is shown, never tallied */
  superseded: boolean
  intended: string
  measured: string
  verdict: ShapingVerdict
  /** why the reader could not judge, or what it wants a human to know */
  note: string | null
}

/** What the reader hands over per persona, narrowed to the fields this view uses. */
export interface ShapingSourceRow {
  persona: string
  bot: number
  attempt: number
  phase: string
  intended: string
  evidence: readonly string[]
  flags: readonly string[]
  verdict: ShapingVerdict
}

const SUMMARY_MAX = 180

/** The evidence lines that carry the READING, best first.
 *
 *  Not simply the first line: `assess` appends the REASON for a "cannot tell" or
 *  "no impact" last, so taking the first line showed "rtt p50 23ms | cannot tell" with no
 *  reason at all — the row said nothing about why. And the reader's first line is often
 *  "own inbound (not attributed to this persona's egress shaping)", which is explicitly
 *  NOT the measurement of the persona's own shaping.
 *
 *  So: for a verdict that needs explaining, the reason; otherwise the line the verdict
 *  rests on (what peers received, what the shaping predicted, what happened in the fault
 *  window). The plain inbound counters are the last resort, and a stated gap is better
 *  than a blank that reads as "fine". */
const READING = [/^the run declared this persona inconclusive/, /^role |: this persona is stressed/, /^predicted by this shaping/, /^window /, /^egress as peers received it/, /^rtt p50 /]
const NOT_A_READING = /^own inbound \(not attributed/

function measuredLine(evidence: readonly string[]): string {
  const lines = evidence.filter((line) => line.trim().length > 0)
  if (!lines.length) return "no app-side measurement recorded"
  const pick = READING.map((re) => lines.find((line) => re.test(line))).find((line) => line !== undefined) ?? lines.find((line) => !NOT_A_READING.test(line)) ?? lines[0]!
  return pick.length <= SUMMARY_MAX ? pick : `${pick.slice(0, SUMMARY_MAX - 1)}…`
}

/** One row per persona, in the reader's order (bots ascend, so a person can find the
 *  same bot in the video list). A `note` carries the reader's flags, because a verdict
 *  is only as good as the caveat under it. */
export function shapingSummary(rows: readonly ShapingSourceRow[]): ShapingSummaryRow[] {
  // A re-run bot produces one row per attempt. The LATEST attempt is the answer; an
  // earlier one is kept visible but marked superseded, so a slot is never tallied twice.
  const latest = new Map<number, number>()
  for (const row of rows) latest.set(row.bot, Math.max(latest.get(row.bot) ?? 0, row.attempt))
  return rows.map((row) => ({
    persona: row.persona,
    bot: row.bot,
    attempt: row.attempt,
    superseded: row.attempt < (latest.get(row.bot) ?? row.attempt),
    intended: row.intended,
    measured: measuredLine(row.evidence),
    verdict: row.verdict,
    note: row.flags.length ? row.flags.join("; ") : null,
  }))
}

/** The tally line, in the reader's own wording, so the page and the terminal agree.
 *  Superseded attempts are not counted: one slot, one verdict. */
export function shapingTally(rows: readonly ShapingSummaryRow[]): string {
  const counts = new Map<ShapingVerdict, number>()
  for (const row of rows) if (!row.superseded) counts.set(row.verdict, (counts.get(row.verdict) ?? 0) + 1)
  const order: ShapingVerdict[] = ["impact seen", "no impact", "cannot tell"]
  return order.filter((v) => counts.has(v)).map((v) => `${counts.get(v)} ${v}`).join(", ")
}
