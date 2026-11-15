// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * THE PAIR ID: one name for one link, the same on both phones, so a query can
 * put the two ends side by side. `rtc.peer` is the viewer's own seat number
 * for the other player, which the other end numbers differently, so it cannot
 * do that.
 *
 *   rtc.pair = g<game>:r<round>:<link>
 *
 * `<link>` is 12 hex characters: the first 6 bytes of blake2b over the game
 * index and the two players' accounts, sorted the way the room key sorts its
 * members. Both ends derive the same string without talking to each other, and
 * neither account is sent. It is a pseudonym, not a secret: anyone who knows a
 * game's roster (it is public on chain) can compute the ids of its links. The
 * round is 1-based, as the `round` attribute and the `round.N` step are, and
 * is outside the hash, so one link reads the same in every round of a game.
 * Pure: the game trace, which knows the game index and this device's account,
 * passes them.
 */
import { blake2b } from "@noble/hashes/blake2.js"

const LINK_BYTES = 6
const encoder = new TextEncoder()

/** the round-independent part: 12 hex characters for the two accounts in one game */
function linkHash(gameIndex: number | null, a: string, b: string): string {
  const [low, high] = a < b ? [a, b] : [b, a]
  const digest = blake2b(encoder.encode(`jollity.rtc.pair:${gameIndex ?? "?"}:${low}:${high}`), { dkLen: LINK_BYTES })
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")
}

/** the id of the link between two accounts in one round of one game (round is 1-based) */
export function formatPairId(gameIndex: number | null, round: number, a: string, b: string): string {
  return `g${gameIndex ?? "?"}:r${round}:${linkHash(gameIndex, a, b)}`
}

/** `{ "rtc.pair": … }` for the link between `self` and `peer`, or nothing while
 *  this device's own account is not known (null) */
export function pairAttrs(gameIndex: number | null, self: string | null, peer: string, round: number): Record<string, string> {
  return self === null ? {} : { "rtc.pair": formatPairId(gameIndex, round, self, peer) }
}
