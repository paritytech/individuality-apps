// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// The live E2E's one decision, as a pure function: given what the chain says
// right now, is there a game worth preparing for, or nothing? No chain client,
// no clock, no I/O in here, so the edges are unit-tested (decide.test.ts) and
// probe.mts only has to fetch the inputs.
//
// PREPARE EARLY. paseo's sign-up window is 180 s and booting three hosted
// players takes minutes, so "start when registration opens" is too late. The
// probe says `play` as soon as a registration opens within LEAD_S; the play
// job boots everything first and then sleeps until `registrationStart`.
//
// All times are chain seconds (Timestamp.Now / 1000), never the wall clock.
// `wallMsFor` is the one bridge, through an offset measured once.
// Humans schedule paseo games; this module only ever reads their schedule.

export interface Phases {
  /** Seconds the sign-up window stays open. */
  registration: number
  shuffle: number
  postShuffleMargin: number
}

export interface CurrentGame {
  index: number
  /** The pallet's state tag: Registration, Shuffle, Reporting, … */
  state: string
  /** Game.registration_ends: when the sign-up window closes, chain seconds. */
  registrationEnds: number
  /** Game.game_date: when play starts, chain seconds. */
  gameAt: number
}

export interface DecideInput {
  chainNow: number
  game?: CurrentGame
  /** GameSchedules[].game_play_time, chain seconds. */
  schedulePlayTimes: number[]
  phases: Phases
  /** A registration must stay open at least this long to be worth joining. */
  minLeftS: number
  /** Optional dispatch-specific floor for every candidate. A cold suite uses
   *  this to include setup time without changing ordinary run semantics. */
  candidateMinLeftS?: number
  /** Prepare for a registration that opens at most this far ahead. */
  leadS: number
  /** the chain read (host-slot.mjs NETWORKS key): part of the dedupe key */
  network: string
}

export type Decision = "play" | "skip"

export interface Verdict {
  decision: Decision
  reason: string
  gameIndex: number | null
  state: string | null
  chainNow: number
  registrationStart: number | null
  registrationEnds: number | null
  gameAt: number | null
  /** Once-per-game cache key; null when there is nothing to play. */
  dedupeKey: string | null
}

/** Registration opens this long before the game plays:
 *  registration_start = gameAt − (registration + shuffle + margin), the
 *  relation scripts/e2e-game.mts relies on when it schedules a game. */
export const registrationStartFor = (gameAt: number, p: Phases): number =>
  gameAt - (p.registration + p.shuffle + p.postShuffleMargin)

/** The once-per-game key. It is the game's PLAY TIME, not its index: the
 *  pallet copies GameSchedules[].game_play_time into Game.game_date, so the
 *  key is known while the game is still only a schedule with no index.
 *  It carries the NETWORK: previewnet and paseo both play on :00 / :30 chain
 *  boundaries, and a bare time would let one network's run shadow the other's. */
export const dedupeKey = (gameAt: number, network: string): string => `e2e-live-played-${network}-${gameAt}`

/** Chain second `chainS` on the wall clock (ms), given one simultaneous
 *  reading of both clocks. The chain clock can sit well off the wall. */
export const wallMsFor = (chainS: number, at: { chainNowS: number; wallNowMs: number }): number =>
  at.wallNowMs + (chainS - at.chainNowS) * 1000

/**
 * A wall-clock trigger sampled on its deadline is due, not missed. Allow only
 * scheduler jitter that still rounds to zero seconds late in the live log;
 * anything materially late remains a failed proof rather than moving the
 * requested fault window.
 */
export const TRIGGER_LATE_TOLERANCE_MS = 499
export const scheduledTriggerWaitMs = (targetWallMs: number, nowWallMs: number, toleranceMs = TRIGGER_LATE_TOLERANCE_MS): number | null => {
  const waitMs = targetWallMs - nowWallMs
  return waitMs < -toleranceMs ? null : Math.max(0, waitMs)
}

/** How long the play job may sleep before the journey, in wall ms: until the
 *  registration opens (+3 s), but never past `registrationEnds - minLeftS`,
 *  so a window that is already open, or closing soon, is not slept through. */
export const sleepMsFor = (
  regStart: number,
  regEnds: number,
  at: { chainNowS: number; wallNowMs: number },
  minLeftS: number,
): number => {
  const untilStart = wallMsFor(regStart, at) - at.wallNowMs + 3000
  const untilCutoff = Number.isFinite(regEnds) ? (regEnds - minLeftS - at.chainNowS) * 1000 : Infinity
  return Math.max(0, Math.min(untilStart, untilCutoff))
}

const fmt = (s: number): string => {
  if (Math.abs(s) < 120) return `${Math.round(s)} s`
  const m = Math.round(s / 60)
  return m >= 120 ? `${(m / 60).toFixed(1)} h` : `${m} min`
}

export function decide(input: DecideInput): Verdict {
  const { chainNow, game, schedulePlayTimes, phases, minLeftS, leadS } = input
  const candidateMinLeftS = Math.max(minLeftS, input.candidateMinLeftS ?? minLeftS)
  const base: Verdict = {
    decision: "skip",
    reason: "",
    gameIndex: null,
    state: null,
    chainNow,
    registrationStart: null,
    registrationEnds: null,
    gameAt: null,
    dedupeKey: null,
  }

  let lateNote = ""
  if (game) {
    if (game.state === "Registration") {
      const left = game.registrationEnds - chainNow
      if (left >= candidateMinLeftS) {
        return {
          ...base,
          decision: "play",
          reason: `game ${game.index} is in Registration with ${fmt(left)} left`,
          gameIndex: game.index,
          state: game.state,
          // open NOW: a game scheduled into an already-open window opened
          // earlier than registrationEnds - phases.registration, never later
          registrationStart: Math.min(chainNow, game.registrationEnds - phases.registration),
          registrationEnds: game.registrationEnds,
          gameAt: game.gameAt,
          dedupeKey: dedupeKey(game.gameAt, input.network),
        }
      }
      lateNote = `game ${game.index} registration closes in ${Math.max(0, Math.round(left))} s (need ${candidateMinLeftS} s); `
    } else {
      lateNote = `game ${game.index} is already ${game.state}; `
    }
  }

  if (phases.registration < minLeftS) {
    return {
      ...base,
      reason: `${lateNote}registration window (${phases.registration} s) is shorter than MIN_LEFT_S (${minLeftS} s), no game can be joined in time`,
    }
  }

  // A schedule counts while its window can still give this dispatch enough
  // time, which also covers one whose registration opened a moment ago.
  const upcoming = schedulePlayTimes
    .map((t) => ({ gameAt: t, start: registrationStartFor(t, phases) }))
    .filter((s) => s.start + phases.registration - chainNow >= candidateMinLeftS && s.gameAt !== game?.gameAt)
    .sort((a, b) => a.start - b.start)[0]
  if (!upcoming) {
    return { ...base, reason: `${lateNote}no scheduled game has a registration still to join` }
  }
  const until = upcoming.start - chainNow
  const next: Verdict = {
    ...base,
    registrationStart: upcoming.start,
    registrationEnds: upcoming.start + phases.registration,
    gameAt: upcoming.gameAt,
  }
  if (until > leadS) {
    return { ...next, reason: `${lateNote}next registration opens in ${fmt(until)}, beyond LEAD_S (${leadS} s)` }
  }
  return {
    ...next,
    decision: "play",
    dedupeKey: dedupeKey(upcoming.gameAt, input.network),
    reason:
      until > 0
        ? `${lateNote}next registration opens in ${fmt(until)}: prepare now`
        : `${lateNote}a scheduled registration opened ${fmt(-until)} ago`,
  }
}
