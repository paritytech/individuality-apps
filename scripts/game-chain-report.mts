// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * What the chain says about ONE finished DIM2 game, as JSON, for the game report.
 *
 *   npx tsx scripts/game-chain-report.mts <game> [--ws <url>] --out <file>
 *
 * The node is --ws, else PEOPLE_WS, else paseo-next-v2's People RPC (NETWORKS in
 * scripts/lib/host-slot.mjs). For pruned Preview state, pass the staged kickoff
 * and last-live checkpoints captured by the live workflow. Run it from the repo
 * root after `npm ci`. It only reads.
 *
 * It uses the repo's typed papi client (createPeopleClient, as scripts/e2e-live/chain-read.mts does)
 * and reads storage at a block with getValue({ at: blockHash }).
 *
 * Why blocks and not "now": the Game pallet holds one game at a time. While a game is in its
 * Reporting state, every player's report, the votes they received (yes_person / no_not_person) and
 * their group seats (PlayerToIndex) are in storage. The pallet clears them when it settles
 * (PlayerProcess), so the votes can only be read before settlement. Scores change at settlement
 * too, so they are read twice: at kickoff (before) and at the block that emits GameEnded (after).
 *
 * Early settlement, why reports come from EVENTS: a report that completes the set (every registered
 * player has reported) makes the pallet leave Reporting in that SAME block, and GameEnded follows a
 * block or two later. Game 170 had all three reports in one block (#1319690) that was already
 * PlayerProcess, so Players at "the last Reporting block" (#1319689) showed no report at all and the
 * old reader printed sentReport=false, votes 0/0 for players who had reported and been attested.
 * So:
 *   - sentReport, reportBlock and reportTime come from Game.ReportSubmitted events in every block from
 *     the shuffle deadline through the GameEnded block INCLUSIVE, never from Players storage.
 *   - the votes are read from Players at the last block that still holds this game (the block before
 *     GameEnded), else at the last Reporting block (see pickVotes for why both). When neither shows every
 *     report the events prove, the tallies are reconstructed by decoding each ReportSubmitted's extrinsic
 *     (Game.report's full_report: one vote per co-player of each round's group, ascending by index, the
 *     reporter left out) against the roster in PlayerToIndex. That decode runs only then.
 *   - attended (Score after) is checked against the rule of the pallet, reported && yes - 1 >= no, the
 *     subtraction stopping at 0, and any disagreement is a warning, never a guess.
 *
 * What it does:
 *   1. Game.GameHistory[game] gives the kickoff time; a bisection on block timestamps finds the
 *      block at kickoff. A second bisection finds the block where Game.Game first is this game
 *      (registration opened).
 *   2. A third bisection finds the first block after Reporting (Game.Game null, a later game, or
 *      a state other than Reporting). The block before it is the last Reporting block.
 *   3. At that block: Game.Game (the record), every Game.Players entry with registered true (the
 *      count must equal the state's player_count), PlayerToIndex (one position per round, group =
 *      position mod numberOfGroups, from the SDK). The votes come from the later block above.
 *   4. A scan of the blocks from the shuffle deadline through the GameEnded block records, per
 *      account, the block and time its ReportSubmitted landed in, and the time of GameEnded.
 *   5. Score.Participants at kickoff and at GameEnded, and the airdrop winners of the game's draw.
 *
 * Anything it cannot establish goes into "warnings" instead of being guessed.
 */
import { attendanceStatus } from "@individuality/game-outcome"
import { createPeopleClient, type PeopleApi } from "@jollity/game-chain"
import { gameAirdropEventIds, groupSeats, numberOfGroups } from "@parity/product-sdk-individuality"
import { Enum } from "polkadot-api"
import { readFileSync, renameSync, writeFileSync } from "node:fs"
import { pathToFileURL } from "node:url"
import { NETWORKS, networkFromEnv } from "./lib/host-slot.mjs"

const POOL = 8

// ---------------------------------------------------------------- pure parts (tested without a network)

/** The optional game index is the first positional argument, never a numeric flag value. */
export function positionalGame(args: readonly string[]): number | null {
  const value = args[0]
  if (!value || !/^\d+$/.test(value)) return null
  const game = Number(value)
  return Number.isSafeInteger(game) ? game : null
}

type Query = PeopleApi["query"]
export type GameRec = NonNullable<Awaited<ReturnType<Query["Game"]["Game"]["getValue"]>>>
export type PlayerRec = Awaited<ReturnType<Query["Game"]["Players"]["getEntries"]>>[number]["value"]
export type ScoreRec = NonNullable<Awaited<ReturnType<Query["Score"]["Participants"]["getValue"]>>>

/** Where a block sits relative to one game: the Game singleton is null between games. */
export type Phase = "before" | "reporting" | "after"

/**
 * before: an earlier game. reporting: this game, state Reporting. after: no game, a later game,
 * or this game in any state past Reporting. Asked only of blocks at or after kickoff, where the
 * order before < reporting < after is monotonic, which is what the bisection needs.
 */
export function phaseOf(game: Pick<GameRec, "index" | "state"> | undefined | null, index: number): Phase {
  if (!game) return "after"
  if (game.index < index) return "before"
  if (game.index > index) return "after"
  return game.state.type === "Reporting" ? "reporting" : "after"
}

/** Smallest n in [lo, hi] with pred(n) true, for a pred that goes false then true. null if none. */
export async function firstTrue(lo: number, hi: number, pred: (n: number) => Promise<boolean>): Promise<number | null> {
  if (!(await pred(hi))) return null
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2)
    if (await pred(mid)) hi = mid
    else lo = mid + 1
  }
  return lo
}

/** Like firstTrue, but searches backwards from `hi` in growing steps first, for a target known to be near it. */
export async function firstTrueNear(hi: number, pred: (n: number) => Promise<boolean>, step = 64): Promise<number | null> {
  let lo = hi
  for (;;) {
    if (lo <= 1) return firstTrue(1, hi, pred)
    if (!(await pred(lo))) return firstTrue(lo, hi, pred)
    hi = lo
    lo = Math.max(1, lo - step)
    step *= 2
  }
}

/** Runs fn over items with at most `limit` in flight; results keep the items' order. */
export async function mapPool<T, R>(items: readonly T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i], i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

/** Group of a position: the pallet seats position i in group i % numberOfGroups. */
export function groupOf(position: number, playerCount: number, maxGroupSize: number): number {
  const groups = numberOfGroups(playerCount, maxGroupSize)
  return groups === 0 ? -1 : position % groups
}

/** The few Score.Participants fields the report uses. */
export function scoreRow(s: ScoreRec | undefined | null) {
  if (!s) return null
  return {
    score: s.score,
    streak: { type: s.streak.type, value: s.streak.value },
    reachedPersonhood: s.reached_personhood,
    lastAttendedGame: s.last_attended_game ?? null,
    attendanceHistory: s.attendance_history,
  }
}

export function recordRow(rec: GameRec) {
  const playerCount = rec.state.type === "Reporting" ? rec.state.value.player_count : null
  return {
    index: rec.index,
    registrationEnds: rec.registration_ends,
    shuffleDeadline: rec.shuffle_deadline,
    gameDate: rec.game_date,
    reportEnds: rec.report_ends,
    rounds: rec.rounds,
    maxGroupSize: rec.max_group_size,
    playerCount,
    airdropsScheduled: rec.airdrops_scheduled,
    pendingAttendance: rec.pending_attendance,
    groups: playerCount === null ? null : numberOfGroups(playerCount, rec.max_group_size),
  }
}

/** --interim-at: epoch seconds (or ms) or ISO, as epoch ms. null when it is not a time. */
export function interimAtMs(value: string | null | undefined): number | null {
  const iso = registrationOpensIso(value)
  return iso === null ? null : Date.parse(iso)
}

/** Accept the probe's epoch-seconds output as well as ISO, and always retain ISO. */
export function registrationOpensIso(value: string | null | undefined): string | null {
  if (!value) return null
  const numeric = Number(value)
  const ms = Number.isFinite(numeric) && /^\d+(?:\.\d+)?$/.test(value.trim())
    ? numeric * (numeric < 1e12 ? 1000 : 1)
    : Date.parse(value)
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null
}

/** One Game event the report cares about, flattened from System.Events. extrinsic is the ApplyExtrinsic index, null for hooks. */
export type ChainEvent = { block: number; name: "ReportSubmitted" | "GameEnded"; extrinsic: number | null; who?: string; game: number }

/**
 * The reports of one game, from its events: the first landing per account, whatever the block, so a
 * report that shares a block with the end of reporting (or with GameEnded) is not lost. ended is the
 * GameEnded block of the game, null when none was seen.
 */
export function reportsFromEvents(events: readonly ChainEvent[], game: number) {
  const reports = new Map<string, { block: number; extrinsic: number | null }>()
  let ended: number | null = null
  for (const e of events) {
    if (e.game !== game) continue
    if (e.name === "GameEnded") ended = e.block
    else if (e.who !== undefined) {
      const seen = reports.get(e.who)
      if (!seen || e.block < seen.block) reports.set(e.who, { block: e.block, extrinsic: e.extrinsic })
    }
  }
  return Object.assign(reports, { ended })
}

export type Verdict = "Person" | "NotPerson"
/** A decoded Game.report: who filed it and its full_report (one list of verdicts per round). */
export type ReportCall = { account: string; fullReport: readonly (readonly Verdict[])[] }
export type Roster = { playerCount: number; maxGroupSize: number; positions: ReadonlyMap<string, readonly number[]> }
export type Tally = { yes: number; no: number }

/**
 * Votes received, rebuilt from the report calls. Round r of a report holds one verdict per OCCUPIED seat of the
 * reporter's group in that round, ascending by index, the reporter's own seat left out (the pallet's rule, as
 * lib/game-roster.ts buildReport writes it). A report that does not fit the roster is named in problems and
 * counted for nobody, so the caller can fall back to storage instead of trusting half of it.
 */
export function tallyFromReports(calls: readonly ReportCall[], roster: Roster) {
  const tallies = new Map<string, Tally>([...roster.positions.keys()].map((a) => [a, { yes: 0, no: 0 }]))
  const problems: string[] = []
  const rounds = Math.max(0, ...[...roster.positions.values()].map((p) => p.length))
  const holder = Array.from({ length: rounds }, (_, r) => new Map([...roster.positions].filter(([, p]) => p[r] !== undefined).map(([a, p]) => [p[r], a] as const)))
  for (const call of calls) {
    const mine = roster.positions.get(call.account)
    if (!mine) {
      problems.push(`${call.account} filed a report but holds no seat in PlayerToIndex`)
      continue
    }
    const received: [string, Verdict][] = []
    let ok = call.fullReport.length === mine.length
    for (let r = 0; ok && r < mine.length; r++) {
      const seats = groupSeats(mine[r], roster.playerCount, roster.maxGroupSize).filter((s) => s.occupied && s.index !== mine[r])
      const votes = call.fullReport[r]
      if (votes.length !== seats.length) ok = false
      else
        seats.forEach((seat, k) => {
          const who = holder[r].get(seat.index)
          if (who) received.push([who, votes[k]])
        })
    }
    if (!ok) {
      problems.push(`${call.account}'s report does not fit its groups (${call.fullReport.map((v) => v.length).join("+")} votes)`)
      continue
    }
    for (const [who, v] of received) tallies.get(who)![v === "Person" ? "yes" : "no"]++
  }
  return { tallies, problems }
}

/** The verdict of the pallet at the close, from the votes alone: a reporter passes when its yes votes less 1, stopping at 0, reach its no votes. */
export function attestedByRule(sentReport: boolean, yes: number, no: number): boolean {
  return attendanceStatus({
    registered: true,
    sent_report: sentReport,
    yes_person: yes,
    no_not_person: no,
    expected_max_vote_weight: 0,
    early_attendance_enactment: null,
  }).atClose
}

/** A warning for every account where Score after disagrees with the rule. A null attended (no score after) is not judged. */
export function checkAttendance(rows: readonly { account: string; sentReport: boolean; yesPerson: number; noNotPerson: number; attended: boolean | null }[]): string[] {
  return rows
    .filter((r) => r.attended !== null && r.attended !== attestedByRule(r.sentReport, r.yesPerson, r.noNotPerson))
    .map((r) => `${r.account}: Score after says attended=${r.attended}, but the rule (reported ${r.sentReport}, yes ${r.yesPerson}, no ${r.noNotPerson}) says ${!r.attended}`)
}

export type PlayerIn = {
  account: string
  player: PlayerRec
  positions: readonly number[] | undefined
  scoreBefore: ScoreRec | undefined
  scoreAfter: ScoreRec | undefined
  report?: { block: number; time: string } | null
  /** votes received, when they did not come from the Players record (reconstructed from the report calls) */
  tally?: Tally
}

/** One account's row. sentReport: the ReportSubmitted event (else the record). attended: Score after says it attended this game, i.e. it was attested. */
export function accountRow(p: PlayerIn, game: number, playerCount: number, maxGroupSize: number) {
  const pl = p.player
  const positions = [...(p.positions ?? [])]
  const after = scoreRow(p.scoreAfter)
  return {
    account: p.account,
    firstGame: pl.first_game,
    sentReport: !!p.report || pl.sent_report,
    reportBlock: p.report?.block ?? null,
    reportTime: p.report?.time ?? null,
    positions,
    groups: positions.map((x) => groupOf(x, playerCount, maxGroupSize)),
    yesPerson: p.tally?.yes ?? pl.yes_person,
    noNotPerson: p.tally?.no ?? pl.no_not_person,
    expectedMaxVoteWeight: pl.expected_max_vote_weight,
    voteWeight: pl.vote_weight,
    credibility: pl.credibility.type,
    earlyAttendance: pl.early_attendance_enactment ?? null,
    attended: after ? after.lastAttendedGame === game : null,
    yesBeatsNo: (p.tally?.yes ?? pl.yes_person) > (p.tally?.no ?? pl.no_not_person),
    scoreBefore: scoreRow(p.scoreBefore),
    scoreAfter: after,
  }
}

// ---------------------------------------------------------------- chain access

/**
 * The Game.report calls inside one block, by extrinsic index, from the block's body (papi's getBlockBody) and the chain's
 * metadata. The extrinsic envelope is read with that metadata: a signed one (0x84) carries address, signature and the
 * extensions before the call, a general one (0x45, what the ScoreAsParticipant wrapper produces) an extension version byte and
 * the extensions, a bare one (0x04) just the call. Anything else, or a call that is not Game.report, comes back as a string
 * (the reason) instead of votes.
 *
 * The two codec packages are not declared in package.json: they come with polkadot-api (transitive), as in the older probe
 * scripts, and package-lock.json is shared state.
 */
export async function decodeReportCalls(body: readonly Uint8Array[], metadata: Uint8Array, indices: readonly number[]) {
  const { decAnyMetadata, unifyMetadata, compact } = await import("@polkadot-api/substrate-bindings")
  const { getDynamicBuilder, getLookupFn } = await import("@polkadot-api/metadata-builders")
  const meta = unifyMetadata(decAnyMetadata(metadata))
  const lookup = getLookupFn(meta)
  const builder = getDynamicBuilder(lookup)
  // the extrinsic block of the metadata, whichever version (v14 names the extrinsic type, v15 and later list address, signature and call)
  const ex = meta.extrinsic as unknown as { type: number; address?: number; signature?: number; call?: number; extensionsByVersion: Record<number, { type: number }[]> }
  const param = (name: string) => lookup.metadata.lookup[ex.type].params.find((x: { name: string }) => x.name === name)?.type
  const addrT = ex.address ?? param("Address")
  const sigT = ex.signature ?? param("Signature")
  const callT = ex.call ?? param("Call")
  const extensionsOf = (version: number) => {
    const exts = ex.extensionsByVersion[version]
    if (!exts) throw new Error(`unknown extension version ${version}`)
    return exts
  }
  const out = new Map<number, Verdict[][] | string>()
  for (const i of indices) {
    try {
      const tx = body[i]
      let at = compact.enc(compact.dec(tx)).length
      const version = tx[at++]
      const take = (t: number) => {
        const [enc, dec] = builder.buildDefinition(t)
        const v = dec(tx.slice(at))
        at += enc(v).length
        return v
      }
      if (version === 0x84) {
        take(addrT!)
        take(sigT!)
        for (const x of extensionsOf(0)) take(x.type)
      } else if (version === 0x45) {
        for (const x of extensionsOf(tx[at++])) take(x.type)
      } else if (version !== 0x04) throw new Error(`extrinsic version byte 0x${version.toString(16)}`)
      const call = take(callT!) as { type: string; value: { type: string; value: { full_report?: { type: Verdict }[][] } } }
      if (call.type !== "Game" || call.value.type !== "report" || !call.value.value.full_report) out.set(i, `extrinsic ${i} is ${call.type}.${call.value?.type}, not Game.report`)
      else out.set(i, call.value.value.full_report.map((round) => round.map((v) => v.type)))
    } catch (e) {
      out.set(i, `extrinsic ${i} could not be decoded: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  return out
}

/** One extrinsic of a block, decoded: its call and the value of every transaction extension it carries (by extension identifier). */
export type DecodedExtrinsic = { index: number; call: { pallet: string; name: string; args: Record<string, unknown> } | null; extensions: Record<string, unknown>; error?: string }

/**
 * Every extrinsic of a block, decoded the way decodeReportCalls reads one (same envelope rules: 0x84 signed, 0x45 general with an
 * extension version byte, 0x04 bare), but keeping the extension values by their identifier and the call's arguments, so the caller can
 * tell WHO sent a call and through WHICH origin extension. One that cannot be read comes back with `error` and no call.
 */
export async function decodeExtrinsics(body: readonly Uint8Array[], metadata: Uint8Array): Promise<DecodedExtrinsic[]> {
  const { decAnyMetadata, unifyMetadata, compact } = await import("@polkadot-api/substrate-bindings")
  const { getDynamicBuilder, getLookupFn } = await import("@polkadot-api/metadata-builders")
  const meta = unifyMetadata(decAnyMetadata(metadata))
  const lookup = getLookupFn(meta)
  const builder = getDynamicBuilder(lookup)
  const ex = meta.extrinsic as unknown as { type: number; address?: number; signature?: number; call?: number; extensionsByVersion: Record<number, { identifier: string; type: number }[]> }
  const param = (name: string) => lookup.metadata.lookup[ex.type].params.find((x: { name: string }) => x.name === name)?.type
  const addrT = ex.address ?? param("Address")
  const sigT = ex.signature ?? param("Signature")
  const callT = ex.call ?? param("Call")
  const extensionsOf = (version: number) => {
    const exts = ex.extensionsByVersion[version]
    if (!exts) throw new Error(`unknown extension version ${version}`)
    return exts
  }
  return body.map((tx, index): DecodedExtrinsic => {
    const extensions: Record<string, unknown> = {}
    try {
      let at = compact.enc(compact.dec(tx)).length
      const version = tx[at++]
      const take = (t: number) => {
        const [enc, dec] = builder.buildDefinition(t)
        const v = dec(tx.slice(at))
        at += enc(v).length
        return v
      }
      if (version === 0x84) {
        take(addrT!)
        take(sigT!)
        for (const x of extensionsOf(0)) extensions[x.identifier] = take(x.type)
      } else if (version === 0x45) {
        for (const x of extensionsOf(tx[at++])) extensions[x.identifier] = take(x.type)
      } else if (version !== 0x04) throw new Error(`extrinsic version byte 0x${version.toString(16)}`)
      const call = take(callT!) as { type: string; value: { type: string; value?: Record<string, unknown> } }
      return { index, call: { pallet: call.type, name: call.value.type, args: call.value.value ?? {} }, extensions }
    } catch (e) {
      return { index, call: null, extensions, error: e instanceof Error ? e.message : String(e) }
    }
  })
}

/** The extensions that authorise a call as somebody, i.e. the origin; a disabled one decodes to nothing. */
const ORIGIN_EXTENSIONS = ["PeopleLiteAuth", "GameAsInvited", "AsPerson", "AsMember", "ScoreAsParticipant", "AsProofOfInkParticipant", "HonourAuth"]

/** The account a Game sign-up extrinsic is for: the call's `account` argument, else the signer the VerifyMultiSignature extension names. */
function signUpAccount(e: DecodedExtrinsic): string | null {
  const arg = e.call?.args.account
  if (typeof arg === "string") return arg
  const v = e.extensions.VerifyMultiSignature as { type?: string; value?: { account?: unknown } } | undefined
  return v?.type === "Signed" && typeof v.value?.account === "string" ? v.value.account : null
}

/**
 * How one account signed up, from the extrinsics of the block it became registered in: the Game.sign_up_* call that is for it
 * and the origin extension that carried it (PeopleLiteAuth for the web app's lite route, GameAsInvited for an invite ticket).
 * null when no sign-up in the block is for the account (e.g. wrapped in a batch), so the caller can warn instead of guess.
 */
export function registrationOf(extrinsics: readonly DecodedExtrinsic[], account: string) {
  const e = extrinsics.find((x) => x.call?.pallet === "Game" && x.call.name.startsWith("sign_up") && signUpAccount(x) === account)
  if (!e?.call) return null
  return { call: `${e.call.pallet}.${e.call.name}`, origin: ORIGIN_EXTENSIONS.find((n) => e.extensions[n] !== undefined && e.extensions[n] !== null) ?? null }
}

type PlayersAt = { block: number; players: ReadonlyMap<string, PlayerRec> }

/**
 * Where the vote tallies come from, in three tiers. 1) Players at the last block that still holds the game (the one before
 * GameEnded): it carries reports that land in the block leaving Reporting. 2) Players at the last Reporting block: by tier 1's
 * block PlayerProcess has already cleared the players it early-enacted (game 166 lost all 23 reports' flags there), so this one
 * is still needed. A tier is used when its Players shows sent_report for every report the events prove. 3) Neither does: the
 * tallies are rebuilt from the report calls (decode runs only now, so a normal run costs no extra RPCs).
 */
export async function pickVotes(o: { reporters: readonly string[]; later: PlayersAt | null; last: PlayersAt; decode: () => Promise<{ tallies: ReadonlyMap<string, Tally>; problems: string[]; decoded: number }> }) {
  const complete = (t: PlayersAt) => o.reporters.every((a) => t.players.get(a)?.sent_report === true)
  const warnings: string[] = []
  for (const t of [o.later, o.last]) if (t && complete(t)) return { source: "storage" as const, voteBlock: t.block, players: t.players, tallies: undefined, warnings }
  const fallback = o.later ?? o.last
  const missing = o.reporters.filter((a) => fallback.players.get(a)?.sent_report !== true).length
  const r = await o.decode()
  if (r.problems.length === 0 && r.decoded === o.reporters.length) {
    warnings.push(`Game.Players misses ${missing} reports the events prove at block ${fallback.block} and at the last Reporting block; the vote tallies are reconstructed from the report calls`)
    return { source: "report-calls" as const, voteBlock: fallback.block, players: fallback.players, tallies: r.tallies, warnings }
  }
  warnings.push(`Game.Players misses ${missing} reports the events prove and the report calls could not all be decoded, so the vote tallies are incomplete: ${r.problems.join("; ")}`)
  return { source: "storage-incomplete" as const, voteBlock: fallback.block, players: fallback.players, tallies: undefined, warnings }
}

/** Where an interim read stops: the first block after it, and the block that leaves Reporting when the game left before the interim time. */
export function interimClamp(lastInReporting: number, wanted: number) {
  return { firstAfter: Math.min(lastInReporting, wanted) + 1, leavingBlock: lastInReporting < wanted ? lastInReporting + 1 : null }
}

/**
 * Where the report scan ends, and the block offered to pickVotes as later.
 *
 * The scan ends at GameEnded on a final read and at the block that leaves Reporting on a clamped interim read. The later block is
 * the one before GameEnded on a final read and the block that leaves Reporting on a clamped interim read.
 */
export function reportWindow(o: { settleBlock: number | null; leavingBlock: number | null; lastReporting: number }) {
  return { lastScanned: o.settleBlock ?? o.leavingBlock ?? o.lastReporting, laterCandidate: o.settleBlock === null ? o.leavingBlock : o.settleBlock - 1 }
}

function canonicalWs(value: string): string | null {
  try {
    const url = new URL(value)
    url.pathname = url.pathname.replace(/\/+$/, "")
    return url.toString().replace(/\/$/, "")
  } catch {
    return null
  }
}

export function networkForPeopleWs(ws: string): keyof typeof NETWORKS | "unknown" {
  const selected = canonicalWs(ws)
  if (!selected) return "unknown"
  for (const [network, config] of Object.entries(NETWORKS)) {
    if (canonicalWs(config.peopleWs) === selected) return network as keyof typeof NETWORKS
  }
  return "unknown"
}

export type CaptureStageName = "kickoff" | "last-live" | "settlement"
export type CapturedAccount = ReturnType<typeof accountRow> & {
  registeredAt: string | null
  registeredBlock: number | null
  registrationCall: string | null
  registrationOrigin: string | null
  registrationLookup: "found" | "block-found-call-unknown" | "not-found-after-complete-search" | "skipped-pruned-or-unavailable"
}
export type CapturedBlock = {
  block: number
  blockHash: string
  chainTime: string
  events: ChainEvent[]
  reportCalls: ReportCall[]
  decodeProblems: string[]
}
export type CaptureStage = {
  capturedAt: string
  block: number
  blockHash: string
  chainTime: string
  phase: Phase
  record?: ReturnType<typeof recordRow>
  accounts?: CapturedAccount[]
  scoresAfter?: Record<string, ReturnType<typeof scoreRow>>
  settlement?: { block: number; time: string }
  draws?: { eventId: string; tickets: number; winners: string[] }[]
}
export type StagedCapture = {
  format: 2
  game: number
  network: string
  ws: string
  registrationOpens: string | null
  registrationOpensBlock: number | null
  stages: Partial<Record<CaptureStageName, CaptureStage>>
  observations: { name: CaptureStageName; evidence: CaptureStage }[]
  blocks: CapturedBlock[]
  warnings: string[]
}

/** Retain the earliest kickoff, the latest live state, and the settlement.
 * The file is append-in-spirit but rewritten atomically so an interrupted poll
 * cannot destroy a previously captured point. */
export function mergeCaptureStage(current: StagedCapture | null, base: Omit<StagedCapture, "stages">, name: CaptureStageName, stage: CaptureStage): StagedCapture {
  if (current && current.game !== base.game) throw new Error(`staged capture is for game ${current.game}, not ${base.game}`)
  const stages = { ...(current?.stages ?? {}) }
  if (name !== "kickoff" || !stages.kickoff) stages[name] = stage
  const observations = [...(current?.observations ?? []), { name, evidence: stage }]
  return { ...(current ?? base), ...base, stages, observations }
}

/** Persist newly observed blocks without claiming that a stage completed. */
export function checkpointCapturedBlocks(current: StagedCapture | null, base: Omit<StagedCapture, "stages">): StagedCapture {
  return {
    ...current,
    ...base,
    stages: current?.stages ?? {},
    observations: current?.observations ?? base.observations,
  }
}

export function reportFieldAvailability(evidence: { record?: unknown; accounts?: readonly Record<string, unknown>[]; settlement?: unknown }) {
  const accounts = evidence.accounts ?? []
  const fields = ["registeredAt", "registeredBlock", "registrationCall", "registrationOrigin"] as const
  const present = accounts.filter((account) => fields.every((field) => account[field] !== null && account[field] !== undefined)).map((account) => String(account.account))
  const unavailable = accounts.filter((account) => !present.includes(String(account.account))).map((account) => String(account.account))
  return {
    required: { record: !!evidence.record, accounts: accounts.length > 0, settlement: !!evidence.settlement },
    perPlayerRegistration: { fields: [...fields], present, unavailable, optional: true },
  }
}

export function assembleStagedReport(staged: StagedCapture) {
  const kickoff = staged.stages.kickoff
  const settlement = staged.stages.settlement
  if (!kickoff?.record || !kickoff.accounts?.length || !settlement?.settlement || !settlement.scoresAfter) {
    throw new Error(`staged capture for game ${staged.game} is missing required kickoff/accounts/settlement values`)
  }
  const warnings = [...staged.warnings]
  const allEvents = staged.blocks.flatMap((block) => block.events)
  const landed = reportsFromEvents(allEvents, staged.game)
  const calls = staged.blocks.flatMap((block) => block.reportCalls)
  const positions = new Map(kickoff.accounts.map((account) => [account.account, account.positions] as const))
  const rebuilt = tallyFromReports(calls, {
    playerCount: kickoff.record.playerCount ?? kickoff.accounts.length,
    maxGroupSize: kickoff.record.maxGroupSize,
    positions,
  })
  const callsComplete = rebuilt.problems.length === 0 && calls.length === landed.size
  if (!callsComplete) warnings.push(`staged report-call evidence is incomplete: decoded ${calls.length}/${landed.size}; ${rebuilt.problems.join("; ") || "no decoded call for every event"}`)
  for (const block of staged.blocks) warnings.push(...block.decodeProblems.map((problem) => `block ${block.block}: ${problem}`))
  const blockTimes = new Map(staged.blocks.map((block) => [block.block, block.chainTime] as const))
  const latest = staged.stages["last-live"]?.accounts ?? kickoff.accounts
  const latestByAccount = new Map(latest.map((account) => [account.account, account] as const))
  const accounts = kickoff.accounts.map((base) => {
    const report = landed.get(base.account)
    const tally = callsComplete ? rebuilt.tallies.get(base.account) : null
    const live = latestByAccount.get(base.account) ?? base
    const scoreAfter = settlement.scoresAfter?.[base.account] ?? null
    const yesPerson = tally?.yes ?? live.yesPerson
    const noNotPerson = tally?.no ?? live.noNotPerson
    return {
      ...base,
      sentReport: !!report || live.sentReport,
      reportBlock: report?.block ?? null,
      reportTime: report ? (blockTimes.get(report.block) ?? null) : null,
      yesPerson,
      noNotPerson,
      attended: scoreAfter ? scoreAfter.lastAttendedGame === staged.game : null,
      yesBeatsNo: yesPerson > noNotPerson,
      scoreAfter,
    }
  }).sort((a, b) => a.account.localeCompare(b.account))
  warnings.push(...checkAttendance(accounts))
  const required = { record: kickoff.record, accounts, settlement: settlement.settlement }
  return {
    game: staged.game,
    network: staged.network,
    ws: staged.ws,
    read: {
      head: settlement.block,
      kickoffBlock: kickoff.block,
      lastReportingBlock: staged.stages["last-live"]?.block ?? kickoff.block,
      voteBlock: staged.stages["last-live"]?.block ?? kickoff.block,
      voteSource: callsComplete ? "report-calls" : "staged-storage-incomplete",
      settlementBlock: settlement.settlement.block,
    },
    record: kickoff.record,
    kickoff: new Date(kickoff.record.gameDate * 1000).toISOString(),
    registrationOpens: staged.registrationOpens,
    registrationOpensBlock: staged.registrationOpensBlock,
    settlement: settlement.settlement,
    accounts,
    draws: settlement.draws ?? [],
    captureStages: staged.stages,
    captureObservations: staged.observations,
    fieldAvailability: reportFieldAvailability(required),
    warnings,
  }
}

async function main() {
  const args = process.argv.slice(2)
  let game = positionalGame(args) ?? 0
  const flag = (n: string) => {
    const i = args.indexOf(n)
    return i >= 0 ? args[i + 1] : undefined
  }
  const out = flag("--out")
  const stagedPath = flag("--staged")
  const expectedGameAt = Number(flag("--game-at")) || null
  const captureStage = flag("--capture-stage") as CaptureStageName | undefined
  const rawRegistrationOpens = flag("--registration-opens") ?? null
  const interim = args.includes("--interim") || args.includes("--interim-at")
  const rawInterimAt = flag("--interim-at") ?? null
  const suppliedInterimAtMs = interimAtMs(rawInterimAt)
  if (rawInterimAt && suppliedInterimAtMs === null) throw new Error(`invalid --interim-at value ${rawInterimAt}`)
  const suppliedRegistrationOpens = registrationOpensIso(rawRegistrationOpens)
  if (rawRegistrationOpens && !suppliedRegistrationOpens) throw new Error(`invalid --registration-opens value ${rawRegistrationOpens}`)
  const explicitNetwork = process.env.E2E_NETWORK ? networkFromEnv() as keyof typeof NETWORKS : null
  const ws = flag("--ws") ?? process.env.PEOPLE_WS ?? NETWORKS[explicitNetwork ?? "paseo-next-v2"].peopleWs
  const network: keyof typeof NETWORKS | "unknown" = explicitNetwork ?? networkForPeopleWs(ws)
  let stagedBeforeConnect: StagedCapture | null = null
  if (stagedPath) {
    try {
      const parsed = JSON.parse(readFileSync(stagedPath, "utf8")) as { format?: unknown }
      if (parsed.format !== 2) throw new Error(`unsupported staged capture format ${String(parsed.format)} in ${stagedPath}`)
      stagedBeforeConnect = parsed as StagedCapture
      if (!game) game = stagedBeforeConnect.game
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      /* kickoff creates the file */
    }
  }
  if ((!game && !expectedGameAt) || (!out && !stagedPath) || (captureStage && !["kickoff", "last-live", "settlement"].includes(captureStage))) {
    console.error("usage: npx tsx scripts/game-chain-report.mts <game> [--ws <url>] [--staged <file> --capture-stage kickoff|last-live|settlement] [--registration-opens <iso>] [--interim [--interim-at <unix seconds|iso>]] --out <file>")
    process.exit(2)
  }
  if (!captureStage && out && stagedBeforeConnect) {
    if (stagedBeforeConnect.game !== game) throw new Error(`staged capture is for game ${stagedBeforeConnect.game}, not ${game}`)
    const result = assembleStagedReport(stagedBeforeConnect)
    writeFileSync(out, JSON.stringify(result, null, 1))
    console.log(`game ${game}: assembled retained staged values without historical RPC reads; wrote ${out}`)
    return
  }
  const warnings: string[] = []
  if (network === "unknown") warnings.push(`the selected People RPC ${ws} is not a configured network endpoint`)
  const { client, api } = createPeopleClient(ws)
  try {
    const head = (await client.getFinalizedBlock()).number
    const hashes = new Map<number, Promise<string>>()
    const hashAt = (n: number) => {
      let h = hashes.get(n)
      if (!h) hashes.set(n, (h = client._request<string>("chain_getBlockHash", [n])))
      return h
    }
    const tsCache = new Map<number, Promise<number>>()
    const tsMs = (n: number) => {
      let t = tsCache.get(n)
      if (!t) tsCache.set(n, (t = hashAt(n).then((at) => api.query.Timestamp.Now.getValue({ at }).then(Number))))
      return t
    }
    const iso = (ms: number) => new Date(ms).toISOString()

    if (!game) {
      const live = await api.query.Game.Game.getValue({ at: await hashAt(head) })
      if (!live || (expectedGameAt !== null && live.game_date !== expectedGameAt)) {
        throw new Error(`no live game at scheduled time ${expectedGameAt ?? "unknown"} at block ${head}`)
      }
      game = live.index
    }

    if (captureStage) {
      if (!stagedPath) throw new Error("--capture-stage requires --staged")
      const current: StagedCapture | null = stagedBeforeConnect
      const hash = await hashAt(head)
      const live = await api.query.Game.Game.getValue({ at: hash })
      const phase = phaseOf(live, game)
      if (captureStage !== "settlement" && phase !== "reporting") throw new Error(`game ${game} is ${phase} at block ${head}, not Reporting`)
      if (captureStage === "settlement" && phase !== "after") throw new Error(`game ${game} has not settled at block ${head}`)

      // Capture every unseen block while it is recent. This includes the event,
      // timestamp and decoded report call, so final assembly never reopens an
      // hours-old block body or state trie.
      const firstUnseen = current?.blocks.length ? current.blocks[current.blocks.length - 1].block + 1 : head
      const blockNumbers = Array.from({ length: Math.max(0, head - firstUnseen + 1) }, (_, i) => firstUnseen + i)
      let captureMetadata: Uint8Array | undefined
      const freshBlocks = await mapPool(blockNumbers, 4, async (block): Promise<CapturedBlock> => {
        const blockHash = await hashAt(block)
        const raw = await api.query.System.Events.getValue({ at: blockHash })
        const events: ChainEvent[] = []
        for (const event of raw) {
          if (event.event.type !== "Game") continue
          const value = event.event.value
          const extrinsic = event.phase.type === "ApplyExtrinsic" ? event.phase.value : null
          if (value.type === "ReportSubmitted") events.push({ block, name: "ReportSubmitted", extrinsic, who: String(value.value.who.value), game: value.value.game_index })
          if (value.type === "GameEnded") events.push({ block, name: "GameEnded", extrinsic, game: value.value.index })
        }
        const reports = events.filter((event): event is ChainEvent & { extrinsic: number; who: string } => event.name === "ReportSubmitted" && event.extrinsic !== null && event.who !== undefined)
        const reportCalls: ReportCall[] = []
        const decodeProblems: string[] = events
          .filter((event) => event.name === "ReportSubmitted" && event.extrinsic === null)
          .map((event) => `${event.who ?? "unknown reporter"}: ReportSubmitted was not emitted by an extrinsic`)
        if (reports.length) {
          captureMetadata ??= await client.getMetadata(blockHash)
          const decoded = await decodeReportCalls(await client.getBlockBody(blockHash), captureMetadata, reports.map((event) => event.extrinsic))
          for (const event of reports) {
            const call = decoded.get(event.extrinsic)
            if (Array.isArray(call)) reportCalls.push({ account: event.who, fullReport: call })
            else decodeProblems.push(`${event.who}: ${call ?? "no decoded report call"}`)
          }
        }
        return { block, blockHash, chainTime: iso(await tsMs(block)), events, reportCalls, decodeProblems }
      })
      const blocks = [...(current?.blocks ?? []), ...freshBlocks]
      const warnings = [...(current?.warnings ?? [])]
      let registrationOpens = current?.registrationOpens ?? suppliedRegistrationOpens
      let registrationOpensBlock = current?.registrationOpensBlock ?? null
      const captureBase = (): Omit<StagedCapture, "stages"> => ({
        format: 2, game, network, ws, registrationOpens, registrationOpensBlock,
        observations: current?.observations ?? [], blocks, warnings,
      })
      const persistStaged = (capture: StagedCapture) => {
        const temp = `${stagedPath}.tmp`
        writeFileSync(temp, JSON.stringify(capture, null, 1))
        renameSync(temp, stagedPath)
      }

      const baseAccount = (account: ReturnType<typeof accountRow>): CapturedAccount => ({
        ...account,
        registeredAt: null,
        registeredBlock: null,
        registrationCall: null,
        registrationOrigin: null,
        registrationLookup: "skipped-pruned-or-unavailable",
      })
      let stage: CaptureStage = { capturedAt: new Date().toISOString(), block: head, blockHash: hash, chainTime: iso(await tsMs(head)), phase }
      if (captureStage === "kickoff") {
        if (!live || live.state.type !== "Reporting") throw new Error(`game ${game} has no Reporting record at kickoff block ${head}`)
        const playerCount = live.state.value.player_count
        const entries = (await api.query.Game.Players.getEntries({ at: hash })).filter((entry) => entry.value.registered)
        const keys = entries.map((entry) => [entry.keyArgs[0]] as [(typeof entry.keyArgs)[0]])
        const [positions, before] = await Promise.all([
          api.query.Game.PlayerToIndex.getValues(keys, { at: hash }),
          api.query.Score.Participants.getValues(keys, { at: hash }),
        ])
        if (registrationOpens === null) warnings.push("registration-open time was not supplied; per-player registration lookup skipped")
        else {
          try {
            const targetMs = Date.parse(registrationOpens)
            registrationOpensBlock = await firstTrueNear(head, async (block) => (await tsMs(block)) >= targetMs)
            if (registrationOpensBlock !== null) registrationOpens = iso(await tsMs(registrationOpensBlock))
          } catch (error) {
            registrationOpensBlock = null
            warnings.push(`registration-open block lookup was pruned or unavailable: ${error instanceof Error ? error.message : String(error)}`)
          }
        }
        const bodyCache = new Map<number, Promise<DecodedExtrinsic[]>>()
        let metadata: Promise<Uint8Array> | undefined
        const extrinsicsAt = (block: number) => {
          let body = bodyCache.get(block)
          if (!body) {
            body = hashAt(block).then(async (blockHash) => {
              metadata ??= client.getMetadata(blockHash)
              return decodeExtrinsics(await client.getBlockBody(blockHash), await metadata)
            })
            bodyCache.set(block, body)
          }
          return body
        }
        const accountRows = entries.map((entry, i) => baseAccount(accountRow({
          account: String(entry.keyArgs[0].value), player: entry.value, positions: positions[i],
          scoreBefore: before[i], scoreAfter: undefined,
        }, game, playerCount, live.max_group_size)))
        const accounts = await mapPool(accountRows, 4, async (account): Promise<CapturedAccount> => {
          if (registrationOpensBlock === null) return account
          const key = Enum("Account", account.account)
          try {
            const block = await firstTrue(registrationOpensBlock, head, async (candidate) =>
              (await api.query.Game.Players.getValue(key, { at: await hashAt(candidate) }))?.registered === true)
            if (block === null) return { ...account, registrationLookup: "not-found-after-complete-search" }
            const registration = registrationOf(await extrinsicsAt(block), account.account)
            return {
              ...account,
              registeredAt: iso(await tsMs(block)),
              registeredBlock: block,
              registrationCall: registration?.call ?? null,
              registrationOrigin: registration?.origin ?? null,
              registrationLookup: registration ? "found" : "block-found-call-unknown",
            }
          } catch (error) {
            warnings.push(`${account.account}: registration lookup skipped because recent state was pruned or unavailable: ${error instanceof Error ? error.message : String(error)}`)
            return account
          }
        })
        for (const account of accounts) {
          if (account.registrationLookup === "not-found-after-complete-search") warnings.push(`${account.account}: no registration was found after a complete recent-state search`)
          if (account.registrationLookup === "block-found-call-unknown") warnings.push(`${account.account}: registration block ${account.registeredBlock} was found but its sign-up call could not be identified`)
        }
        stage = { ...stage, record: recordRow(live), accounts }
      } else if (captureStage === "last-live") {
        if (!live || live.state.type !== "Reporting") throw new Error(`game ${game} has no Reporting record at live block ${head}`)
        const playerCount = live.state.value.player_count
        const entries = (await api.query.Game.Players.getEntries({ at: hash })).filter((entry) => entry.value.registered)
        const keys = entries.map((entry) => [entry.keyArgs[0]] as [(typeof entry.keyArgs)[0]])
        const positions = await api.query.Game.PlayerToIndex.getValues(keys, { at: hash })
        const kickoffByAccount = new Map((current?.stages.kickoff?.accounts ?? []).map((account) => [account.account, account] as const))
        const accounts = entries.map((entry, i) => {
          const account = String(entry.keyArgs[0].value)
          return {
            ...baseAccount(accountRow({ account, player: entry.value, positions: positions[i], scoreBefore: undefined, scoreAfter: undefined }, game, playerCount, live.max_group_size)),
            ...(kickoffByAccount.get(account) ? {
              registeredAt: kickoffByAccount.get(account)!.registeredAt,
              registeredBlock: kickoffByAccount.get(account)!.registeredBlock,
              registrationCall: kickoffByAccount.get(account)!.registrationCall,
              registrationOrigin: kickoffByAccount.get(account)!.registrationOrigin,
              registrationLookup: kickoffByAccount.get(account)!.registrationLookup,
            } : {}),
          }
        })
        stage = { ...stage, record: recordRow(live), accounts }
      } else {
        // Settlement can remain pending across retries. Checkpoint every fresh
        // block before requiring GameEnded so none can age out between polls.
        persistStaged(checkpointCapturedBlocks(current, captureBase()))
        const ended = blocks.flatMap((block) => block.events).find((event) => event.name === "GameEnded" && event.game === game)
        if (!ended) throw new Error(`game ${game} is after Reporting but no captured GameEnded event is available through block ${head}`)
        const kickoffAccounts = current?.stages.kickoff?.accounts ?? []
        if (!kickoffAccounts.length) throw new Error(`game ${game} has no retained kickoff roster`)
        const scores = await Promise.all(kickoffAccounts.map((account) =>
          api.query.Score.Participants.getValue(Enum("Account", account.account), { at: hash })))
        const scoresAfter = Object.fromEntries(kickoffAccounts.map((account, i) => [account.account, scoreRow(scores[i])]))
        const record = current?.stages.kickoff?.record
        if (!record) throw new Error(`game ${game} has no retained kickoff record`)
        const baseId = await api.constants.Game.airdrop_event_id_base()
        const draws = await Promise.all(gameAirdropEventIds({ base: baseId, gameIndex: game, airdropsScheduled: record.airdropsScheduled }).map(async (eventId) => {
          const id = typeof eventId === "string" ? eventId : "0x" + Buffer.from(eventId).toString("hex")
          const [wins, registrations] = await Promise.all([api.query.Airdrop.Winners.getEntries(id, { at: hash }), api.query.Airdrop.Registrations.getEntries(id, { at: hash })])
          return { eventId: id, tickets: registrations.length, winners: wins.map((winner) => ("account_id" in winner.keyArgs[1].value ? winner.keyArgs[1].value.account_id : `alias:${winner.keyArgs[1].value.alias}`)) }
        }))
        stage = { ...stage, settlement: { block: ended.block, time: blocks.find((block) => block.block === ended.block)!.chainTime }, scoresAfter, draws }
      }
      const base = captureBase()
      const merged = mergeCaptureStage(current, base, captureStage, stage)
      persistStaged(merged)
      console.log(`game ${game}: captured ${captureStage} values at block ${head} (${phase}); wrote ${stagedPath}`)
      return
    }
    if (!out) throw new Error("--out is required when assembling the report")
    let staged: StagedCapture | null = stagedBeforeConnect
    if (stagedPath && !staged) staged = JSON.parse(readFileSync(stagedPath, "utf8")) as StagedCapture
    if (staged && staged.game !== game) throw new Error(`staged capture is for game ${staged.game}, not ${game}`)

    // 1. kickoff, from the history the pallet keeps per game
    const gameDate = await api.query.Game.GameHistory.getValue(game)
    if (gameDate === undefined) throw new Error(`Game.GameHistory has no entry for game ${game} on ${ws}`)
    const kickoffBlock = staged?.stages.kickoff?.block ?? await firstTrue(1, head, async (n) => (await tsMs(n)) >= Number(gameDate) * 1000)
    if (kickoffBlock === null) throw new Error(`no block at or after kickoff ${iso(Number(gameDate) * 1000)}`)

    // 1b. when registration opened: the first block where Game.Game is this game. The singleton is null between games, so that is
    // after the previous game settled (searched from the previous game's kickoff).
    let openedBlock: number | null = staged?.registrationOpensBlock ?? null
    if (openedBlock === null) {
      try {
        const hinted = suppliedRegistrationOpens ?? staged?.registrationOpens
        if (hinted) openedBlock = await firstTrueNear(kickoffBlock, async (n) => (await tsMs(n)) >= Date.parse(hinted))
        else {
          const prevDate = await api.query.Game.GameHistory.getValue(game - 1)
          const searchFrom = prevDate === undefined ? 1 : ((await firstTrue(1, kickoffBlock, async (n) => (await tsMs(n)) >= Number(prevDate) * 1000)) ?? 1)
          openedBlock = await firstTrue(searchFrom, kickoffBlock, async (n) => {
            const g = await api.query.Game.Game.getValue({ at: await hashAt(n) })
            return !!g && g.index >= game
          })
        }
      } catch (error) {
        warnings.push(`registration-open block is no longer available: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    const registrationOpens = openedBlock === null ? (suppliedRegistrationOpens ?? staged?.registrationOpens ?? null) : iso(await tsMs(openedBlock))
    if (registrationOpens === null) warnings.push("could not establish when registration opened; registrationOpens is null")

    // 2. the last block still in Reporting
    const gameAt = async (n: number) => api.query.Game.Game.getValue({ at: await hashAt(n) })
    const first = await gameAt(kickoffBlock)
    if (phaseOf(first, game) !== "reporting") {
      throw new Error(`block ${kickoffBlock} (kickoff) is not in Reporting for game ${game}: ${JSON.stringify(first)?.slice(0, 200)}`)
    }
    const lastLiveBlock = staged?.stages["last-live"]?.block ?? kickoffBlock
    let firstAfter = await firstTrue(lastLiveBlock, head, async (n) => phaseOf(await gameAt(n), game) === "after")
    // interim: read the votes at the last block at or before interimAt (default kickoff + 180 s), still in Reporting, whether or not the game has settled
    let interimAt: string | null = null
    let leavingBlock: number | null = null
    if (interim) {
      const atMs = suppliedInterimAtMs ?? (Number(gameDate) + 180) * 1000
      interimAt = iso(atMs)
      const past = await firstTrue(kickoffBlock, head, async (n) => (await tsMs(n)) > atMs)
      const wanted = past === null ? head : past - 1
      if (wanted < kickoffBlock) throw new Error(`--interim-at ${interimAt} is before kickoff`)
      const lastInReporting = firstAfter === null ? head : firstAfter - 1
      const clamp = interimClamp(lastInReporting, wanted)
      if (clamp.leavingBlock !== null) warnings.push(`the game left Reporting at block ${clamp.leavingBlock}, before the interim time ${interimAt}, so the interim read runs through that block`)
      leavingBlock = clamp.leavingBlock
      firstAfter = clamp.firstAfter
    } else if (firstAfter === null) throw new Error(`game ${game} is still in Reporting at head ${head}`)
    const lastReporting = firstAfter - 1
    const atVotes = await hashAt(lastReporting)
    const rec = await api.query.Game.Game.getValue({ at: atVotes })
    if (!rec || rec.state.type !== "Reporting") throw new Error(`block ${lastReporting} is not in Reporting`)
    const playerCount = rec.state.value.player_count
    const maxGroupSize = rec.max_group_size

    // 3. registered accounts and their seats, at the last Reporting block; positions, votes and both scores are one batched read each
    const entries = (await api.query.Game.Players.getEntries({ at: atVotes })).filter((e) => e.value.registered)
    if (entries.length !== playerCount) {
      warnings.push(`Game.Players holds ${entries.length} registered accounts but the game's player_count is ${playerCount}`)
    }
    const keys = entries.map((e) => [e.keyArgs[0]] as [(typeof e.keyArgs)[0]])
    const atKickoff = await hashAt(kickoffBlock)

    // 4. settlement block (a pool over the 30 blocks after Reporting)
    const candidates = interim ? [] : Array.from({ length: Math.min(30, Math.max(0, head - firstAfter + 1)) }, (_, i) => firstAfter + i)
    const ended = await mapPool(candidates, POOL, async (n) => {
      const ev = await api.query.System.Events.getValue({ at: await hashAt(n) })
      return ev.some((e) => e.event.type === "Game" && e.event.value.type === "GameEnded" && e.event.value.value.index === game) ? n : null
    })
    const settleBlock = ended.find((n) => n !== null) ?? null
    if (interim) warnings.push(`interim read as of ${interimAt} (block ${lastReporting}): settlement, attendance and scores after are not read`)
    else if (settleBlock === null) warnings.push("no GameEnded event for this game within 30 blocks of the end of Reporting; scores after are read at the first block after Reporting")
    if (staged && settleBlock === null) throw new Error(`game ${game} left Reporting but no GameEnded event is available yet`)
    const atEnd = await hashAt(settleBlock ?? firstAfter)  // unused in interim

    // an early settlement lands the last reports in the block that leaves Reporting, so the scan runs through it on both a final and a clamped interim read
    const { lastScanned, laterCandidate } = reportWindow({ settleBlock, leavingBlock, lastReporting })
    const startScan = (await firstTrueNear(kickoffBlock, async (n) => (await tsMs(n)) >= rec.shuffle_deadline * 1000)) ?? kickoffBlock
    const scan = Array.from({ length: lastScanned - startScan + 1 }, (_, i) => startScan + i)
    const found = await mapPool(scan, POOL, async (n): Promise<ChainEvent[]> => {
      const ev = await api.query.System.Events.getValue({ at: await hashAt(n) })
      const here: ChainEvent[] = []
      for (const e of ev) {
        if (e.event.type !== "Game") continue
        const v = e.event.value
        const extrinsic = e.phase.type === "ApplyExtrinsic" ? e.phase.value : null
        if (v.type === "ReportSubmitted") here.push({ block: n, name: "ReportSubmitted", extrinsic, who: String(v.value.who.value), game: v.value.game_index })
        else if (v.type === "GameEnded") here.push({ block: n, name: "GameEnded", extrinsic, game: v.value.index })
      }
      return here
    })
    const landed = reportsFromEvents(found.flat(), game)
    const reports = new Map<string, { block: number; time: string }>()
    const reportBlocks = [...new Set([...landed.values()].map((r) => r.block))]
    const times = new Map(await mapPool(reportBlocks, POOL, async (n) => [n, iso(await tsMs(n))] as const))
    for (const [account, r] of landed) reports.set(account, { block: r.block, time: times.get(r.block)! })

    const asPlayers = (rows: typeof entries) => new Map(rows.map((e) => [String(e.keyArgs[0].value), e.value]))
    const laterBlock = laterCandidate !== null && laterCandidate > lastReporting && (await gameAt(laterCandidate))?.index === game ? laterCandidate : null
    const later = laterBlock === null ? null : { block: laterBlock, players: asPlayers((await api.query.Game.Players.getEntries({ at: await hashAt(laterBlock) })).filter((e) => e.value.registered)) }

    const [pti, before, after] = await Promise.all([
      api.query.Game.PlayerToIndex.getValues(keys, { at: atVotes }),
      api.query.Score.Participants.getValues(keys, { at: atKickoff }),
      interim ? Promise.resolve(keys.map(() => undefined)) : api.query.Score.Participants.getValues(keys, { at: atEnd }),
    ])
    const positions = new Map(entries.map((e, i) => [String(e.keyArgs[0].value), pti[i] ?? []] as const))

    // the report calls are decoded only when storage misses a report: each report's extrinsic, in the block it landed in
    const decode = async () => {
      const calls: ReportCall[] = []
      const problems: string[] = []
      const byBlock = new Map<number, { account: string; extrinsic: number | null }[]>()
      for (const [account, r] of landed) byBlock.set(r.block, [...(byBlock.get(r.block) ?? []), { account, extrinsic: r.extrinsic }])
      let metadata: Uint8Array | undefined
      for (const [block, list] of byBlock) {
        const usable = list.filter((x): x is { account: string; extrinsic: number } => x.extrinsic !== null)
        for (const x of list) if (x.extrinsic === null) problems.push(`${x.account}'s ReportSubmitted in block ${block} was not emitted by an extrinsic`)
        const hash = await hashAt(block)
        metadata ??= await client.getMetadata(hash)
        const decoded = await decodeReportCalls(await client.getBlockBody(hash), metadata, usable.map((x) => x.extrinsic))
        for (const x of usable) {
          const d = decoded.get(x.extrinsic)
          if (typeof d === "string" || d === undefined) problems.push(`${x.account} (block ${block}): ${d ?? "no decode"}`)
          else calls.push({ account: x.account, fullReport: d })
        }
      }
      const rebuilt = tallyFromReports(calls, { playerCount, maxGroupSize, positions })
      return { tallies: rebuilt.tallies, problems: [...problems, ...rebuilt.problems], decoded: calls.length }
    }
    const votes = await pickVotes({ reporters: [...reports.keys()], later, last: { block: lastReporting, players: asPlayers(entries) }, decode })
    const { source: voteSource, voteBlock, players: playerAt } = votes
    warnings.push(...votes.warnings)

    const accounts = entries
      .map((e, i) => {
        const account = String(e.keyArgs[0].value)
        const tally = votes.tallies?.get(account)
        return accountRow({ account, player: voteSource === "report-calls" ? e.value : (playerAt.get(account) ?? e.value), positions: pti[i], scoreBefore: before[i], scoreAfter: after[i], report: reports.get(account) ?? null, tally }, game, playerCount, maxGroupSize)
      })
      .sort((a, b) => a.account.localeCompare(b.account))
    for (const a of accounts) {
      const stored = playerAt.get(a.account)?.sent_report
      if (a.sentReport && !a.reportBlock) warnings.push(`${a.account} has sent_report but no ReportSubmitted event was found in the scan`)
      if (stored !== undefined && a.reportBlock && !stored && voteSource === "storage") warnings.push(`${a.account} has a ReportSubmitted event but Game.Players says sent_report=false`)
    }
    warnings.push(...checkAttendance(accounts))

    // 4b. how each account registered (#363): the first block where Game.Players holds it as registered, then that block's sign-up
    // extrinsic and the origin extension on it. Native clients use other routes than the web app's (lite invite), which the report needs.
    const bodies = new Map<number, Promise<DecodedExtrinsic[]>>()
    let metadata: Promise<Uint8Array> | undefined
    const extrinsicsAt = (n: number) => {
      let b = bodies.get(n)
      if (!b) {
        b = hashAt(n).then(async (hash) => {
          metadata ??= client.getMetadata(hash)
          return decodeExtrinsics(await client.getBlockBody(hash), await metadata)
        })
        bodies.set(n, b)
      }
      return b
    }
    const registrations = await mapPool(accounts, 4, async (a) => {
      if (openedBlock === null) return { status: "skipped-pruned-or-unavailable" as const, block: null, at: null, call: null, origin: null }
      const key = Enum("Account", a.account)
      try {
        const block = await firstTrue(openedBlock, kickoffBlock, async (n) => (await api.query.Game.Players.getValue(key, { at: await hashAt(n) }))?.registered === true)
        if (block === null) return { status: "not-found-after-complete-search" as const, block: null, at: null, call: null, origin: null }
        const reg = registrationOf(await extrinsicsAt(block), a.account)
        return { status: reg ? "found" as const : "block-found-call-unknown" as const, block, at: iso(await tsMs(block)), call: reg?.call ?? null, origin: reg?.origin ?? null }
      } catch (error) {
        warnings.push(`${a.account}: registration block is no longer available: ${error instanceof Error ? error.message : String(error)}`)
        return { status: "skipped-pruned-or-unavailable" as const, block: null, at: null, call: null, origin: null }
      }
    })
    const registered = accounts.map((a, i) => ({ ...a, registeredAt: registrations[i].at, registeredBlock: registrations[i].block, registrationCall: registrations[i].call, registrationOrigin: registrations[i].origin, registrationLookup: registrations[i].status }))
    for (const a of registered) {
      if (a.registrationLookup === "not-found-after-complete-search") warnings.push(`${a.account}: no Game sign-up extrinsic was found after a complete search from registration opening through kickoff`)
      if (a.registrationLookup === "block-found-call-unknown") warnings.push(`${a.account}: registration block ${a.registeredBlock} was found but its Game sign-up extrinsic could not be identified`)
      if (a.registrationLookup === "skipped-pruned-or-unavailable") warnings.push(`${a.account}: registration lookup was skipped because the opening block or historical state was unavailable`)
    }

    // 5. prize draw winners, one draw per id in parallel (papi has no keys-only read, so tickets are counted from entries)
    const airdrops = rec.airdrops_scheduled
    const base = await api.constants.Game.airdrop_event_id_base()
    const draws = interim ? [] : await Promise.all(
      gameAirdropEventIds({ base, gameIndex: game, airdropsScheduled: airdrops }).map(async (eventId) => {
        const id = typeof eventId === "string" ? eventId : "0x" + Buffer.from(eventId).toString("hex")
        const [wins, regs] = await Promise.all([api.query.Airdrop.Winners.getEntries(id, { at: atEnd }), api.query.Airdrop.Registrations.getEntries(id, { at: atEnd })])
        return { eventId: id, tickets: regs.length, winners: wins.map((w) => ("account_id" in w.keyArgs[1].value ? w.keyArgs[1].value.account_id : `alias:${w.keyArgs[1].value.alias}`)) }
      }),
    )
    if (airdrops === 0 && !interim) warnings.push("the game scheduled no prize draw")

    const result = {
      game,
      network,
      ws,
      interim,
      interimAt,
      read: { head, kickoffBlock, lastReportingBlock: lastReporting, voteBlock, voteSource, settlementBlock: settleBlock },
      record: {
        index: rec.index,
        registrationEnds: rec.registration_ends,
        shuffleDeadline: rec.shuffle_deadline,
        gameDate: Number(gameDate),
        reportEnds: rec.report_ends,
        rounds: rec.rounds,
        maxGroupSize,
        playerCount,
        airdropsScheduled: airdrops,
        pendingAttendance: rec.pending_attendance,
        groups: numberOfGroups(playerCount, maxGroupSize),
      },
      kickoff: iso(Number(gameDate) * 1000),
      registrationOpens,
      registrationOpensBlock: openedBlock,
      settlement: settleBlock === null ? null : { block: settleBlock, time: iso(await tsMs(settleBlock)) },
      accounts: registered,
      draws,
      captureStages: staged?.stages ?? null,
      captureObservations: staged?.observations ?? [],
      fieldAvailability: reportFieldAvailability({ record: rec, accounts: registered, settlement: settleBlock === null ? null : { block: settleBlock } }),
      warnings,
    }
    writeFileSync(out, JSON.stringify(result, null, 1))
    console.log(`game ${game}: ${accounts.length} registered, ${accounts.filter((a) => a.sentReport).length} reported, ${accounts.filter((a) => a.attended).length} attended; blocks ${kickoffBlock} (kickoff), ${lastReporting} (last Reporting), ${voteBlock} (votes, ${voteSource}), ${settleBlock} (GameEnded); wrote ${out}`)
    for (const w of warnings) console.log("warning:", w)
  } finally {
    client.destroy()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // other players' accounts in a warning are masked before the line reaches a public run log (player-privacy.ts)
  const { guardConsole, runPrivacy } = await import("./e2e-live/player-privacy")
  const bots = (name: string): unknown => JSON.parse(readFileSync(new URL(`./e2e-live/${name}`, import.meta.url), "utf8"))
  guardConsole(runPrivacy(bots("profiles.json"), bots("persona-bootstrap.json")))
  main().then(
    () => process.exit(0),
    (e) => {
      console.error(e instanceof Error ? e.message : String(e))
      process.exit(1)
    },
  )
}
