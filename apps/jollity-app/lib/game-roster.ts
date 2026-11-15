// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * WHO THE GAME PUT YOU WITH, and what you decided about them.
 *
 * The chain deals a fresh permutation of player indices every round, so the
 * same chair holds a different person in round 1 and round 2. Everything here
 * is keyed by `PlayerId` for that reason. A seat number stays inside one
 * round: it picks the chair, it never names the player in it.
 *
 * A round holds one chair per seat of the group cap, and a chair the shuffle
 * never reached holds nobody. Such a chair gets no tile on screen (#1347), and
 * its turns wrap around to the players (game-chain `hostSeat`). It is not a
 * person, so the roster and the report both pass it by.
 *
 * Pure: no React, no chain client, no clock.
 */
import { playerIdOf, type LiveSeat, type PlayerId } from "./game-source"
import type { ReportVote } from "@jollity/protocol"
import type { Vote } from "./game-session"

/** every turn's taps, under the session's turn key, keyed by player */
export type TurnVotes = Record<number, Partial<Record<PlayerId, Vote>>>

/**
 * Everyone the game grouped you with, once each — the confirm screen's roster.
 *
 * The last round comes first, in its seat order, and players met only in an
 * earlier round follow.
 */
export function coPlayers(rounds: LiveSeat[][], mySeat: number[]): PlayerId[] {
  const ids: PlayerId[] = []
  const seen = new Set<PlayerId>()
  for (let round = rounds.length - 1; round >= 0; round--) {
    rounds[round].forEach((seat, position) => {
      if (position === mySeat[round] || seat.player === null) return
      const id = playerIdOf(seat.player)
      if (seen.has(id)) return
      seen.add(id)
      ids.push(id)
    })
  }
  return ids
}

/**
 * One verdict per player for the WHOLE game: the majority of the taps that
 * player collected across every turn.
 *
 * A person needs a majority. A tie is a reject, and so is a player no turn
 * ever filed a verdict for — the game asks you to confirm a human, so an
 * unconfirmed player is not one.
 */
export function predictVerdict(turnVotes: TurnVotes, id: PlayerId, unseen: Vote = "notperson"): Vote {
  let person = 0
  let notperson = 0
  for (const turn of Object.values(turnVotes)) {
    if (turn[id] === "person") person++
    if (turn[id] === "notperson") notperson++
  }
  // NEVER SEEN — no turn of yours had them in it (you joined late, after the
  // rounds they were in). The report still needs a verdict and the pallet has
  // no abstain, so the caller says which: with late join on (lib/late-join)
  // the benefit of the doubt goes to them, since a NotPerson would cancel a
  // yes they may have earned from the people who did see them.
  if (person === 0 && notperson === 0) return unseen
  return person > notperson ? "person" : "notperson"
}

/**
 * Did you share a turn with `id`: sat in one group with them in a round that
 * had a turn at or after `firstTurn`, the first turn you answer for (the
 * session's first opened or sealed turn). A round's turns are keys
 * `round * stride` to `round * stride + stride - 1`, and a turn they host
 * counts: their tile was on screen (the #603 "seen" gate takes a host's frame
 * too).
 *
 * LATE JOIN (#520): a co-player you never shared a turn with
 * gets the late-join default, while one you shared a turn with but never saw
 * stays NotPerson (#445).
 */
export function sharedTurnWith(
  rounds: LiveSeat[][],
  mySeat: number[],
  id: PlayerId,
  firstTurn: number,
  stride: number,
): boolean {
  return rounds.some(
    (seats, round) =>
      (round + 1) * stride - 1 >= firstTurn &&
      seats.some((seat, position) => position !== mySeat[round] && seat.player !== null && playerIdOf(seat.player) === id),
  )
}

/**
 * The report the pallet takes: one entry per round, and inside it one vote per
 * co-player of THAT round's group, ascending by player index, you excluded.
 * A wrong length is `InvalidReport`, so a chair with no player files nothing.
 * The seats already stand in ascending index order.
 *
 * A player gets the same verdict in every round they appear in, at that
 * round's own position. `verdictOf` is the caller's one answer per player.
 */
export function buildReport(
  rounds: LiveSeat[][],
  mySeat: number[],
  verdictOf: (id: PlayerId) => Vote | undefined,
): ReportVote[][] {
  return rounds.map((seats, round) =>
    seats.flatMap((seat, position): ReportVote[] => {
      if (position === mySeat[round] || seat.player === null) return []
      return [verdictOf(playerIdOf(seat.player)) === "person" ? "Person" : "NotPerson"]
    }),
  )
}

/** The verdict each co-player was filed under, read back from the report that
 *  was built (one entry per non-own seat, per round, as `buildReport` lays it out). */
export function filedVerdicts(rounds: LiveSeat[][], mySeat: number[], report: ReportVote[][]): Record<PlayerId, Vote> {
  const out: Record<PlayerId, Vote> = {}
  rounds.forEach((seats, round) => {
    let next = 0
    seats.forEach((seat, position) => {
      if (position === mySeat[round] || seat.player === null) return
      out[playerIdOf(seat.player)] = report[round][next++] === "Person" ? "person" : "notperson"
    })
  })
  return out
}

// ── the vote trail ──────────────────────────────────────────────────────────
// Observation only: what the player tapped versus what the app decided for
// them. Nothing here changes a verdict; `predictVerdict` stays the one answer.

/** the turns a seal filled in without a tap, by turn key: who got the default
 *  NotPerson at that turn's end */
export type AutoSeals = Record<number, readonly PlayerId[]>

/** where a co-player's filed verdict came from. `unseen`: no video decoded in
 *  a turn you shared (NotPerson, #445); `never-shared`: never seen because no
 *  turn of yours had them in it (the late-join default, #520). */
type VerdictSource = "majority" | "tie" | "override" | "unseen" | "never-shared"

export interface VoteSummary {
  /** the verdict the report FILES (the session's `voteShown` at build time) */
  verdict: Vote
  /** what the turn votes alone predict (the majority, or the late-join default
   *  for a co-player nobody voted on). Differs from `verdict` when the player
   *  shared a turn with you but was never seen on video, which the report
   *  files NotPerson (#445, #520). */
  predicted: Vote
  personTurns: number
  notPersonTurns: number
  /** how many of the NotPerson turns were default seals, not taps */
  autoTurns: number
  source: VerdictSource
  /** The confirm-stage choice for a co-player whose video never decoded in a
   * shared turn. Absent for seen players and late-join never-shared players. */
  unseenChoice?: "default-notperson" | "flipped-person"
  /** Whether the player changed this No-video tile at least once, even if
   * they later returned it to the default NotPerson choice. */
  unseenEverFlipped?: true
}

/**
 * A turn closed: file the default NotPerson for every sealable player the
 * player left undecided, and say what was tapped and what was defaulted.
 * `cast` is not mutated.
 */
export function sealTurnVotes(
  cast: Partial<Record<PlayerId, Vote>>,
  players: readonly PlayerId[],
): { votes: Partial<Record<PlayerId, Vote>>; auto: PlayerId[]; tapped: { person: PlayerId[]; notperson: PlayerId[] } } {
  const votes = { ...cast }
  const auto: PlayerId[] = []
  for (const id of players) {
    if (votes[id] === undefined) {
      votes[id] = "notperson"
      auto.push(id)
    }
  }
  const tapped: { person: PlayerId[]; notperson: PlayerId[] } = { person: [], notperson: [] }
  for (const [id, vote] of Object.entries(cast)) {
    if (vote === "person") tapped.person.push(id)
    else if (vote === "notperson") tapped.notperson.push(id)
  }
  return { votes, auto, tapped }
}

/** One co-player's trail: the verdict the report files and how it got there.
 *  `filed` is what the report filed for this co-player, whether their video
 *  was ever decoded, and whether you shared a turn with them (absent: you
 *  did); the trail's `verdict` is that filed value and the turn-vote
 *  prediction moves to `predicted`. */
export function summarizeVotes(
  turnVotes: TurnVotes,
  autoSeals: AutoSeals,
  id: PlayerId,
  override: Vote | undefined,
  unseen: Vote,
  filed: { verdict: Vote; seen: boolean; shared?: boolean },
  unseenEverFlipped = false,
): VoteSummary {
  let personTurns = 0
  let notPersonTurns = 0
  for (const turn of Object.values(turnVotes)) {
    if (turn[id] === "person") personTurns++
    if (turn[id] === "notperson") notPersonTurns++
  }
  let autoTurns = 0
  for (const ids of Object.values(autoSeals)) if (ids.includes(id)) autoTurns++
  const predicted = override ?? predictVerdict(turnVotes, id, unseen)
  const source: VerdictSource = !filed.seen
    ? filed.shared === false
      ? "never-shared"
      : "unseen"
    : override !== undefined
      ? "override"
      : personTurns === 0 && notPersonTurns === 0
        ? "unseen"
        : personTurns === notPersonTurns
          ? "tie"
          : "majority"
  const unseenChoice =
    !filed.seen && filed.shared !== false
      ? filed.verdict === "person"
        ? "flipped-person"
        : "default-notperson"
      : undefined
  return {
    verdict: filed.verdict,
    predicted,
    personTurns,
    notPersonTurns,
    autoTurns,
    source,
    ...(unseenChoice ? { unseenChoice } : {}),
    ...(unseenChoice && unseenEverFlipped ? { unseenEverFlipped: true as const } : {}),
  }
}

/** The counts the game journey carries: how the report split. `autoOnly` is a
 *  NotPerson whose every NotPerson turn was a default seal (no reject was ever
 *  tapped, and the player did not override it). */
export function countReport(summaries: readonly VoteSummary[]) {
  const counts = {
    person: 0,
    notperson: 0,
    autoOnly: 0,
    ties: 0,
    unseen: 0,
    unseenDefault: 0,
    unseenFlipped: 0,
  }
  for (const s of summaries) {
    if (s.verdict === "person") counts.person++
    else {
      counts.notperson++
      if (s.source !== "override" && s.notPersonTurns > 0 && s.autoTurns === s.notPersonTurns) counts.autoOnly++
    }
    if (s.source === "tie") counts.ties++
    // never seen on video, whichever the reason
    if (s.source === "unseen" || s.source === "never-shared") counts.unseen++
    if (s.unseenChoice === "default-notperson") counts.unseenDefault++
    if (s.unseenChoice === "flipped-person") counts.unseenFlipped++
  }
  return counts
}
