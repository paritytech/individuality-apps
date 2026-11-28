// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// Every chain assertion the live journey makes, as pure functions over an
// injected reader or over values already read. No chain client in here: the
// I/O is scripts/e2e-live/chain-read.mts, which implements ChainReader over
// paseo at FINALIZED. That split is what lets vitest prove each check can
// FAIL (chain-checks.test.ts): the negative controls are an account that
// never registered and a UI account that does not match the oracle.
//
// No imports on purpose, so the Playwright spec can load this file without
// pulling polkadot-api into the test runner.
import { expectedVerdicts, tapEvidence, type DownInfo } from "./down-turns"
import type { TileRow } from "./record"

/** Game.Players' value, the fields the journey reads. A record outlives its
 *  game, so `registered` is the sign-up signal, not the record's presence. */
export interface PlayerRecord {
  first_game: number
  registered: boolean
  sent_report: boolean
}

export interface ChainReader {
  /** Game.Players[Account(account)] at finalized, undefined when absent. */
  player(account: string): Promise<PlayerRecord | undefined>
}

/** Game.ReportSubmitted's payload (`who` is Account | Person), and the
 *  finalized block it landed in when the watch saw it. */
export interface ReportEvent {
  who: { type: string; value: string }
  game_index: number
  block?: number
}

/** "inconclusive": the bot could not do what it was asked for a reason that is not its fault (a runner freeze, #341).
 *  Counted apart from pass and fail; it never fails a run on its own. */
export type Status = "pass" | "fail" | "unchecked" | "warn" | "inconclusive"
export interface Check {
  name: string
  status: Status
  detail: string
}

/** A fixed account no one holds the key to (32 zero bytes, SS58 prefix 42):
 *  the chain must report it absent, or the reader is lying. */
export const NEVER_REGISTERED = "5C4hrfjw9DjXZTzV3MwzrrAr9P1MJhSrvWGWqi1eSuyUpnhM"

const check = (name: string, ok: boolean, detail: string): Check => ({ name, status: ok ? "pass" : "fail", detail })

export async function checkSignedUp(reader: ChainReader, account: string): Promise<Check> {
  const rec = await reader.player(account)
  const name = `signed up: ${account}`
  if (!rec) return check(name, false, "no Game.Players record at finalized")
  return check(
    name,
    rec.registered,
    `Game.Players record: registered=${rec.registered} sent_report=${rec.sent_report} first_game=${rec.first_game}`,
  )
}

export async function checkAbsent(reader: ChainReader, account: string): Promise<Check> {
  const rec = await reader.player(account)
  return check(
    `absent (negative control): ${account}`,
    rec === undefined,
    rec ? `UNEXPECTED Game.Players record ${JSON.stringify(rec)}` : "no Game.Players record, as expected",
  )
}

/** The UI's account against the independently derived one. A UI that shows
 *  no account (main before the home test hooks) is UNCHECKED, never passed. */
export function compareAccounts(ui: string | null | undefined, oracle: string): Check {
  const name = "UI account matches the oracle"
  if (!oracle) return check(name, false, "the oracle derived no account")
  if (!ui) return { name, status: "unchecked", detail: `the UI exposes no data-account; oracle says ${oracle}` }
  return check(name, ui === oracle, ui === oracle ? `both ${oracle}` : `UI shows ${ui}, oracle derived ${oracle}`)
}

/** One check per account: a ReportSubmitted for it IN THIS GAME. */
export function checkReports(events: ReportEvent[], gameIndex: number, accounts: string[]): Check[] {
  return accounts.map((account) => {
    const hit = events.some((e) => e.game_index === gameIndex && e.who.type === "Account" && e.who.value === account)
    return check(`report submitted: ${account}`, hit, hit ? `Game.ReportSubmitted in game ${gameIndex}` : `no Game.ReportSubmitted in game ${gameIndex}`)
  })
}

/** The game is settled once a GameEnded names it, or the chain's game slot
 *  has moved on (empty, or a later index). */
export function checkSettled(
  game: { index: number; state: string } | undefined,
  gameIndex: number,
  endedIndices: number[],
): Check {
  const name = `game ${gameIndex} settled`
  if (endedIndices.includes(gameIndex)) return check(name, true, "Game.GameEnded seen")
  if (!game) return check(name, true, "Game.Game is empty")
  if (game.index !== gameIndex) return check(name, true, `Game.Game moved on to game ${game.index}`)
  return check(name, false, `game ${gameIndex} is still ${game.state}`)
}

/** How long settlement may take: report_ends plus a margin, chain seconds. */
export const settleDeadline = (reportEnds: number, marginS: number): number => reportEnds + marginS

// ── the filed votes, decoded from the chain ────────────────────────────────
// The oracle for "did the bots vote every co-player Person": the full_report
// argument of each bot's Game.report extrinsic (chain-read.mts `votes` finds
// it by the ReportSubmitted event's ApplyExtrinsic index and decodes it). The
// pallet keeps no vote storage, so the call itself is the record.

/** One round of the reporter's group, as the roster stood at the report:
 *  the OCCUPIED seats of its group, ascending by player index, its own seat
 *  included (Game.IndexToPlayer over the SDK's groupSeats). */
export interface ReportRound {
  ownIndex: number
  members: { index: number; player: string }[]
}
/** A filed report: who, where, the group per round and the raw full_report. */
export interface FiledReport {
  who: string
  block: number
  extrinsic: number
  /** Authoritative padded turn width from Game.Game at the report parent. */
  maxGroupSize?: number
  rounds: ReportRound[]
  /** Game.report's full_report: per round, one vote per co-player of that
   *  round's group, ascending by player index, the reporter excluded
   *  (lib/game-roster.ts buildReport) */
  fullReport: string[][]
}
export interface VerdictRow {
  round: number
  index: number
  attestee: string
  verdict: string
}

/** full_report's positions back to accounts. A length that does not match
 *  the group is an error, never a pass. */
export function reportVerdicts(r: FiledReport): { rows: VerdictRow[]; error: string | null } {
  if (r.fullReport.length !== r.rounds.length)
    return { rows: [], error: `full_report has ${r.fullReport.length} rounds, the roster ${r.rounds.length}` }
  const rows: VerdictRow[] = []
  for (const [round, { ownIndex, members }] of r.rounds.entries()) {
    const others = [...members].sort((a, b) => a.index - b.index).filter((m) => m.index !== ownIndex)
    const votes = r.fullReport[round]
    if (votes.length !== others.length)
      return { rows: [], error: `round ${round + 1}: ${votes.length} votes for ${others.length} co-players` }
    others.forEach((m, i) => rows.push({ round, index: m.index, attestee: m.player, verdict: votes[i] }))
  }
  return { rows, error: null }
}

/** One bot's filed report: every co-player Person, bot or human (a bot must
 *  never vote NotPerson on anyone), EXCEPT where the turns the bot missed while it was down decide otherwise (`down`,
 *  down-turns.ts: a missed turn is sealed NotPerson, the verdict is the majority). No report, or one that does not
 *  decode, is a miss too. `diagnose` turns a miss into a WARN. */
export interface VideoRoleEvidence {
  turns: readonly {
    turn: number
    roles: Record<string, TileRow["role"]>
    verdicts?: Record<string, "approved" | "missed" | "no-opportunity" | "late-tap-ready" | "unknown" | "not-votable" | "late" | "unseen">
    /** Co-players whose tile never became votable in this turn's gameplay (No signal): sealed NotPerson, reported in the detail */
    noSignal?: readonly string[]
    /** Co-players Unseen in this turn's last row whose first frame may have decoded in the turn's unrecorded tail
     *  (record.ts unseenTail): the turn counts either as Unseen or as a no-opportunity NotPerson, so a verdict only
     *  the second reading explains is open (inconclusive), never a failure */
    unseenTail?: readonly string[]
    /** Co-players that hosted this turn and read Unseen before it and Co-player right after (record.ts
     *  hostedFirstFrame): a Host tile hides the first frame, which the app may have seen in the turn, so a co-player
     *  with no other eligible turn is expected NotPerson (never seen) or Person (seen, never voted): open, never a failure */
    hostedFirstFrame?: readonly string[]
    /** The subset of hostedFirstFrame the page had not shown at all before the hosted turn. */
    hostedAbsentBefore?: readonly string[]
  }[]
}

/** The probe resolves every dispatched identity before jobs fan out. A live
 * runner sees only its own physical-runner slots, so use the probe's complete
 * account list for diagnostic bot/human labels. Desk and boot runs have no
 * probe output and retain their local slot list. */
export function runBotAccounts(value: string | undefined, local: readonly string[]): string[] {
  if (!value?.trim()) return [...local]
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new Error("E2E_RUN_BOT_ACCOUNTS is not valid JSON")
  }
  if (!Array.isArray(parsed) || !parsed.length || parsed.some((account) => typeof account !== "string" || !account.trim()))
    throw new Error("E2E_RUN_BOT_ACCOUNTS must be a non-empty JSON array of accounts")
  if (new Set(parsed).size !== parsed.length) throw new Error("E2E_RUN_BOT_ACCOUNTS contains a duplicate account")
  for (const account of local)
    if (account && !parsed.includes(account)) throw new Error("E2E_RUN_BOT_ACCOUNTS omits this runner's account")
  return parsed
}

export function checkChainVotes(
  name: string,
  report: FiledReport | undefined,
  bots: readonly string[],
  diagnose: boolean,
  down?: DownInfo,
  videoRoles?: VideoRoleEvidence,
): Check {
  const miss = diagnose ? "warn" : "fail"
  if (!report) return { name, status: miss, detail: "no Game.report extrinsic found for this account" }
  const { rows, error } = reportVerdicts(report)
  if (error) return { name, status: miss, detail: `report in #${report.block} does not decode against the roster: ${error}` }
  if (rows.length === 0) {
    const solo = report.rounds.length > 0 && report.rounds.every(({ ownIndex, members }) =>
      members.length === 1 && members[0].index === ownIndex && members[0].player === report.who,
    )
    return solo
      ? { name, status: "pass", detail: `report in #${report.block} has a solo roster; no co-player verdicts expected` }
      : { name, status: miss, detail: `report in #${report.block} names no co-player without a valid solo roster` }
  }
  const taps = down && tapEvidence(down.taps) === "stamped" ? down.taps : undefined
  const roleAt = (turn: number, player: string) => videoRoles?.turns.find((entry) => entry.turn === turn)?.roles[player]
  const roleAware = videoRoles && videoRoles.turns.some((entry) => Object.values(entry.roles).some((role) => role !== undefined))
  const firstObservedRole = new Map<string, number>()
  for (const entry of videoRoles?.turns ?? [])
    for (const [player, role] of Object.entries(entry.roles))
      if (role !== undefined && entry.turn < (firstObservedRole.get(player) ?? Number.POSITIVE_INFINITY)) firstObservedRole.set(player, entry.turn)
  const recovering = new Set(down?.downTurns ?? [])
  const firstPlayedTurn = Math.min(...(videoRoles?.turns.map((entry) => entry.turn) ?? []))
  const missedAll = videoRoles?.turns.flatMap((entry) =>
    Object.entries(entry.verdicts ?? {}).flatMap(([player, verdict]) =>
      (verdict === "missed" || verdict === "late-tap-ready") && entry.roles[player] === "coplayer" && !down?.missed.includes(entry.turn)
        ? [{ turn: entry.turn, player }]
        : [],
    ),
  ) ?? []
  // A kill or host crash in a turn's intro leaves a second or so of legal frames on a down or recovery turn: that is not
  // an independent miss (#526). The majority comparison against the filed report still judges the result.
  const missedEligible = missedAll.filter(({ turn }) => !recovering.has(turn))
  const recoveryMissed = missedAll.filter(({ turn }) => recovering.has(turn))
  const unknownAll = videoRoles?.turns.flatMap((entry) =>
    Object.entries(entry.verdicts ?? {}).flatMap(([player, verdict]) => (verdict === "unknown" ? [{ turn: entry.turn, player }] : [])),
  ) ?? []
  // A bot that was down (kill, host crash, freeze, hide) is not held to a decoded-video verdict on the turns of its
  // window or the one recovery turn after it: its page was loading or catching up, so the role evidence there is
  // unknown for a reason that says nothing about the app (#499). No window: any unknown fails, as before.
  const unknownOpportunity = unknownAll.filter(({ turn }) => !recovering.has(turn))
  const recoveryUnknown = [...unknownAll.filter(({ turn }) => recovering.has(turn)), ...recoveryMissed]
  if (unknownOpportunity.length)
    return {
      name,
      status: miss,
      detail: `eligible Co-player opportunity evidence unknown: ${unknownOpportunity.map(({ turn, player }) => `turn ${turn} ${player.slice(0, 8)}`).join(", ")}`,
    }
  if (missedEligible.length)
    return {
      name,
      status: miss,
      detail: `eligible Co-player missed independently of aggregate majority: ${missedEligible.map(({ turn, player }) => `turn ${turn} ${player.slice(0, 8)}`).join(", ")}`,
    }
  const eligible = (turn: number, player: string) => {
    if (!roleAware) return true
    const role = roleAt(turn, player)
    if (role !== undefined) return role !== "unseen"
    // A late-return page has no rows before its first authoritative role
    // observation. Those turns are initial absence, not synthetic Person
    // evidence. A peer with no row anywhere has no proven prefix and remains
    // eligible from the page's first played turn on. After observation a
    // row-less turn stays eligible too, so a recorder hole cannot silently
    // suppress a real mismatch, with ONE bounded exception (below).
    // Turns before the page played any turn at all are initial absence for
    // every peer (game 287, bot 6: a late join that entered at the round
    // change after turn 6 never had its round-1 co-players on screen, so they
    // are never-shared, below). A turn the bot's down window missed stays
    // eligible: the app seals it NotPerson (down-turns.ts).
    const first = firstObservedRole.get(player)
    if (first !== undefined) {
      if (turn < first) return false
      if (down?.missed.includes(turn)) return true
      // THE SINGLE GAP TURN (game 409, bot 6): a turn that lasted about a second on the page (intro-only rows, the bot's
      // own host turn) leaves no row for the player. It is NOT eligible when the rows of the adjacent turns, in the same
      // round, both exist and neither reads Co-player (the player was unseen or hosting around it, so never votable
      // here), and the tap log shows no tap on them in it. Every other gap (two or more turns, a round boundary, a
      // trailing gap, a tap, a Co-player beside it) keeps the fail-closed reading above. Only a turn with no role for
      // this player gets here: a turn with its own role was judged by it.
      const near = (t: number) => roleAt(t, player)
      const before = near(turn - 1)
      const after = near(turn + 1)
      const size = groupSize
      const sameRound = size > 0 && Math.floor((turn - 2) / size) === Math.floor((turn - 1) / size) && Math.floor(turn / size) === Math.floor((turn - 1) / size)
      const tapped = down?.taps?.some((t) => t.turn === turn && t.id === player) ?? false
      if (before !== undefined && after !== undefined && sameRound && !tapped && before !== "coplayer" && after !== "coplayer") return false
      return true
    }
    return turn >= firstPlayedTurn || (down?.missed.includes(turn) ?? false)
  }
  const autoRejected = (turn: number, player: string) =>
    videoRoles?.turns.find((entry) => entry.turn === turn)?.verdicts?.[player] === "no-opportunity"
  const needsExpected = Boolean((down && (down.missed.length > 0 || taps)) || roleAware)
  const groupSize = report.maxGroupSize ?? down?.maxGroupSize ?? report.rounds[0]?.members.length ?? 0
  const expected = needsExpected
    ? expectedVerdicts(report, groupSize, down?.missed ?? [], taps, eligible, autoRejected)
    : null
  // LATE JOIN WINS (#520). A co-player with no eligible turn was never seen, and the app files that
  // NotPerson (#445) when the bot shared a turn with them. When it never did, because every turn of every round they
  // were grouped in lies before the page's first played turn and outside the bot's down window, the late joiner files
  // the late-join Person (lib/late-join, on by default). The app keys it the same way: the first turn it answers for,
  // and membership of a round with a turn at or after it (lib/game-roster sharedTurnWith).
  const sharedTurn = (player: string) =>
    report.rounds.some(
      ({ ownIndex, members }, round) =>
        members.some((m) => m.index !== ownIndex && m.player === player) &&
        Array.from({ length: groupSize }, (_, i) => round * groupSize + i + 1).some(
          (turn) => turn >= firstPlayedTurn || (down?.missed.includes(turn) ?? false),
        ),
    )
  const neverShared = new Set<string>()
  if (expected && roleAware)
    for (const [player, e] of expected)
      if (e.person === 0 && e.notPerson === 0 && !sharedTurn(player)) {
        e.verdict = "Person"
        neverShared.add(player)
      }
  // THE UNRECORDED TAIL (game 323, bot 6). A co-player Unseen in a turn's last row may have shown its first frame
  // after it, before the turn ended: the app then binds the frame to that turn (#602, the ending included) and seals it
  // NotPerson. The timeline cannot tell, so the other reading is computed too: those turns eligible and auto-rejected.
  // A wrong verdict that reading explains is open, never a failure; any other mismatch still fails.
  const tail = new Set((videoRoles?.turns ?? []).flatMap((entry) => (entry.unseenTail ?? []).map((player) => `${entry.turn}:${player}`)))
  const tailPlayers = new Set([...tail].map((key) => key.slice(key.indexOf(":") + 1)))
  const inTail = (turn: number, player: string) => tail.has(`${turn}:${player}`)
  const tailExpected =
    expected && tail.size
      ? expectedVerdicts(report, groupSize, down?.missed ?? [], taps, (turn, player) => inTail(turn, player) || eligible(turn, player), (turn, player) => inTail(turn, player) || autoRejected(turn, player))
      : null
  // A HOSTED FIRST FRAME (game 327, bot 27). A co-player's tile reads Host in the turn it hosts, so its first decoded
  // frame there is invisible: the app has seen it in a shared open turn (#602) and, with no votable turn left, files the
  // default Person, where a co-player never seen is NotPerson (#445). Only a co-player the timeline gives no votable
  // eligible turn at all (0P/0N, not a late-join never-shared Person) is open; any tally, or a verdict the primary
  // reading already expects, is judged as before.
  const hostedPlayers = new Set((videoRoles?.turns ?? []).flatMap((entry) => entry.hostedFirstFrame ?? []))
  const hostedAbsent = (a: string, turn: number) => (videoRoles?.turns ?? []).some((entry) => entry.turn === turn && entry.hostedAbsentBefore?.includes(a))
  const hostedTurns = (a: string) => (videoRoles?.turns ?? []).filter((entry) => entry.hostedFirstFrame?.includes(a)).map((entry) => entry.turn)
  const hostedOpen = (a: string): boolean => {
    const e = expected?.get(a)
    return hostedPlayers.has(a) && !!e && e.verdict === "NotPerson" && e.person === 0 && e.notPerson === 0
  }
  const want = (a: string) => expected?.get(a)?.verdict ?? "Person"
  const turns = (a: string) => {
    const e = expected?.get(a)
    return [
      e?.missedTurns.length ? `missed turns ${e.missedTurns.join(", ")}` : "",
      e?.autoRejectedTurns?.length ? `post-cutoff auto-rejected in turn ${e.autoRejectedTurns.join(", ")}` : "",
      e?.untappedTurns?.length ? `untapped in turn ${e.untappedTurns.join(", ")}` : "",
    ].filter(Boolean).join("; ")
  }
  const bad = rows.filter((r) => r.verdict !== want(r.attestee))
  const tailIds = new Set(bad.filter((r) => tailPlayers.has(r.attestee) && tailExpected?.get(r.attestee)?.verdict === r.verdict).map((r) => r.attestee))
  const hostedIds = new Set(bad.filter((r) => hostedOpen(r.attestee) && r.verdict === "Person").map((r) => r.attestee))
  const tailTurns = (a: string) => [...tail].filter((key) => key.endsWith(`:${a}`)).map((key) => key.slice(0, key.indexOf(":")))
  const tailNote = tailIds.size
    ? `; ${[...tailIds].map((a) => `${a.slice(0, 8)} read Unseen in the last row of turn ${tailTurns(a).join(", ")} and Co-player at the next row that tells`).join("; ")}: a first frame in that unrecorded tail is sealed NotPerson, so the verdict is open, inconclusive not a failure`
    : ""
  const hostedNote = hostedIds.size
    ? `; ${[...hostedIds].map((a) => `${a.slice(0, 8)} ${hostedTurns(a).every((t) => hostedAbsent(a, t)) ? "not shown before" : "read Unseen before"} turn ${hostedTurns(a).join(", ")} and Co-player right after, with only a Host tile in it and no votable turn`).join("; ")}: a first frame decoded in the turn it hosted is seen, so the app files the default Person, and the verdict is open, inconclusive not a failure`
    : ""
  const kind = (a: string) => (bots.includes(a) ? "bot" : "human")
  const note = (r: VerdictRow) => (expected && want(r.attestee) !== "Person" ? `, expected ${want(r.attestee)} (${turns(r.attestee)})` : expected ? `, expected ${want(r.attestee)}` : "")
  const decided = expected ? [...expected].filter(([, e]) => e.verdict === "NotPerson") : []
  const summary = `#${report.block}-${report.extrinsic}: ${rows.length - bad.length}/${rows.length} round verdicts ${expected ? "as expected" : "Person"}`
  const wrong = bad.length ? `; ${bad.map((r) => `round ${r.round + 1} ${r.attestee.slice(0, 8)} (${kind(r.attestee)})=${r.verdict}${note(r)}`).join(", ")}` : ""
  const why = decided.length
    ? decided.map(([a, e]) => `${a.slice(0, 8)} (${kind(a)}) expected NotPerson, ${turns(a)} (${e.person}P/${e.notPerson}N)`).join("; ")
    : `${down?.missed.length ? `missed turns ${down.missed.join(", ")}` : "no missed turn"} decide no verdict, every co-player expected Person`
  const downNote = expected && down ? `; down (${down.windows}): ${why}` : ""
  const roleNote = roleAware
    ? `; video roles: Unseen turns excluded; proven post-cutoff no-opportunity seals NotPerson; never-seen expects NotPerson; never-shared (late join) expects Person${neverShared.size ? ` (${[...neverShared].map((p) => p.slice(0, 8)).join(", ")})` : ""}; unknown opportunity blocks`
    : ""
  // A bot that went down and came back, on a build that does not stamp its taps: the turn it rejoined cannot be judged
  // (its late clicks look like play), so a mismatch is not evidence against the app. Inconclusive, never a guess (#351).
  const unjudgeable = !!down && tapEvidence(down.taps) === "unstamped"
  // A click that returned after the page had left the gameplay stage of its turn may or may not have landed (the ending flip
  // refuses a gesture while a tile turns): that co-player's expectation is open, never Person, never NotPerson (#351)
  const late = (down?.taps ?? []).filter((t) => t.result.startsWith("late"))
  const lateIds = new Set(late.map((t) => t.id))
  const lateNote = late.map((t) => `; late tap on ${t.id.slice(0, 8)} in turn ${t.turn} (landed in ${/^late: ([^,]+)/.exec(t.result)?.[1] ?? "unknown"})`).join("")
  const skipped = down && tapEvidence(down.taps) === "unstamped" ? "; taps unstamped: build predates data-stage, tap check skipped" : ""
  const recoveryNote = recoveryUnknown.length
    ? `; decoded-video evidence unknown or missed on turn ${[...new Set(recoveryUnknown.map((u) => u.turn))].join(", ")}: down-window / recovery turn after the bot's down window (${down?.windows}), inconclusive not a failure`
    : ""
  const noSignalHits = (videoRoles?.turns ?? []).flatMap((entry) => (entry.noSignal ?? []).map((player) => `turn ${entry.turn} ${player.slice(0, 8)}`))
  const noSignalNote = noSignalHits.length ? `; ${noSignalHits.length} co-player turn(s) with a tile never votable (No signal) counted NotPerson: ${noSignalHits.join(", ")}` : ""
  const detail = summary + wrong + downNote + roleNote + noSignalNote + skipped + lateNote + tailNote + hostedNote + recoveryNote
  const firm = bad.filter((r) => !lateIds.has(r.attestee) && !tailIds.has(r.attestee) && !hostedIds.has(r.attestee))
  const status = !bad.length ? (recoveryUnknown.length ? "inconclusive" : "pass") : unjudgeable || firm.length === 0 ? "inconclusive" : miss
  return { name, status, detail }
}

/** Markdown: a row per reporter and co-player, a column per round ("·" where
 *  the two were not grouped that round). */
export function chainVoteTable(reports: readonly FiledReport[], names: Record<string, string> = {}): string {
  const name = (a: string) => names[a] ?? a.slice(0, 8)
  const rounds = Math.max(0, ...reports.map((r) => r.rounds.length))
  const cols = Array.from({ length: rounds }, (_, i) => `round ${i + 1}`)
  const out = [`| reporter | co-player | ${cols.join(" | ")} |`, `|---|---|${cols.map(() => "---").join("|")}|`]
  for (const r of reports) {
    const { rows, error } = reportVerdicts(r)
    if (error) {
      out.push(`| ${name(r.who)} | (does not decode: ${error}) |${cols.map(() => " |").join("")}`)
      continue
    }
    const attestees = [...new Set(rows.map((x) => x.attestee))]
    for (const a of attestees)
      out.push(`| ${name(r.who)} | ${name(a)} | ${cols.map((_, i) => rows.find((x) => x.round === i && x.attestee === a)?.verdict ?? "·").join(" | ")} |`)
  }
  return out.join("\n")
}

/** Is the boot identity safe to open the app with? It must be KNOWN not to be registered in a game: a missing seat read
 *  (the oracle failed to read the chain) is "unknown", never "free", so the guard fails closed. */
export function bootSeatVerdict(seat: { blockers: readonly string[] } | null | undefined): "free" | "registered" | "unknown" {
  if (!seat) return "unknown"
  return seat.blockers.includes("AlreadyRegistered") ? "registered" : "free"
}
