// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Keeps the player's votes for the game in progress, so an app restart in the
 * middle of it does not lose them.
 *
 * The verdicts the player gave (taps and the seals the app filed), the players
 * they banned and the changes they made on the confirm screen live in React
 * state, which a reload or a restart empties. Without this copy a rejoin in
 * the confirm window would file Person for everyone, a banned player
 * included.
 *
 * One key holds one game: the current one. An entry for another game or
 * another account is dropped when it is read, and the entry is cleared once
 * the report has landed. Host storage in a container, localStorage elsewhere
 * (lib/host/storage). A write is silent when it fails.
 */
import type { PlayerId } from "./game-source"
import type { AutoSeals, TurnVotes } from "./game-roster"
import type { Vote } from "./game-session"
import type { VideoRoleHistory } from "./video-role-history"
import { tryReadStoredString, writeStoredJSON } from "./host/storage"

const VOTES_KEY = "jollity.votes"

/** what is kept of one game */
export interface StoredVotes {
  gameIndex: number
  account: string
  turnVotes: TurnVotes
  banned: PlayerId[]
  overrides: Partial<Record<PlayerId, Vote>>
  /** Shared-turn No-video tiles changed at least once during confirm. */
  unseenFlipped?: PlayerId[]
  autoSeals: AutoSeals
  /** Rejects written by a ban, rather than by a tap or missed-turn seal.
   * Older records omit it and load with no attributable ban votes. */
  banVotes?: AutoSeals
  /** First turn this account actually displayed in this game. Older entries
   * omit it and fall back to their earliest sealed turn. */
  firstOpenedTurn?: number
  /** First trustworthy turn at/after each player's first decoded peer frame.
   * Older records omit it and load as an empty history. */
  videoRoleHistory?: VideoRoleHistory
  /** The page was hidden or frozen for at least ten seconds during the game
   *  (#201, #729): no auto-confirm.
   * Kept here so a page killed in the background and reopened still knows
   * (#599). Older records omit it. */
  away?: true
}

/** Writes the entry. */
export function saveVotes(votes: StoredVotes): Promise<void> {
  return writeStoredJSON(VOTES_KEY, votes)
}

/** Empties the entry: the report landed, or the game it held is over. */
export function clearVotes(): Promise<void> {
  return writeStoredJSON(VOTES_KEY, null)
}

/**
 * A typed read result for this game and account. An entry of another game or
 * account is cleared on the way, so at most the current game is kept. Failed
 * reads are distinct from absent data so a caller never overwrites unknown
 * host state.
 */
export async function loadVotes(
  gameIndex: number,
  account: string,
): Promise<{ ok: true; value: StoredVotes | null } | { ok: false }> {
  const read = await tryReadStoredString(VOTES_KEY)
  if (!read.ok) return read
  let stored: StoredVotes | null = null
  try {
    stored = read.value ? JSON.parse(read.value) as StoredVotes : null
  } catch {
    stored = null
  }
  if (!stored) return { ok: true, value: null }
  if (stored.gameIndex !== gameIndex || stored.account !== account) {
    void clearVotes()
    return { ok: true, value: null }
  }
  return { ok: true, value: stored }
}

/**
 * The game the stored books are for, when they are this account's, read
 * without clearing them. Once the chain has cleared Game.Game, a relaunch has
 * no other way to know which game it played; the books are cleared when the
 * report lands, so books still held are a game whose report never landed here
 * (#596).
 */
export async function storedVotesGame(account: string): Promise<number | undefined> {
  const read = await readStoredVotesGame(account)
  return read.ok ? read.gameIndex : undefined
}

/** The same, telling a storage read that FAILED (`ok: false`) apart from no
 *  books for this account (`gameIndex` undefined). */
export async function readStoredVotesGame(
  account: string,
): Promise<{ ok: true; gameIndex: number | undefined } | { ok: false }> {
  const read = await tryReadStoredString(VOTES_KEY)
  if (!read.ok) return { ok: false }
  if (!read.value) return { ok: true, gameIndex: undefined }
  try {
    const stored = JSON.parse(read.value) as Partial<StoredVotes> | null
    return { ok: true, gameIndex: stored?.account === account && typeof stored.gameIndex === "number" ? stored.gameIndex : undefined }
  } catch {
    return { ok: true, gameIndex: undefined }
  }
}
