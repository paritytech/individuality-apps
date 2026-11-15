// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import type { PlayerId } from "./game-source"
import { turnBooks, type TurnBooks, type TurnBooksStep, type TurnWorld } from "./turn-books"

export type RoundVote = "person" | "notperson"

/** The round-vote command boundary. Sealed turns may still accept a
 * deliberate replay vote before confirm (#569); the first confirm closes
 * every later round vote (#1223). */
export function voteForRound(
  books: TurnBooks,
  evidenceFrozen: boolean,
  event: { turn: number; round: number; id: PlayerId; verdict: RoundVote; source?: "player" | "ban" },
  world: TurnWorld,
): { accepted: boolean; books: TurnBooks; trail: TurnBooksStep[] } {
  if (evidenceFrozen) return { accepted: false, books, trail: [] }
  return { accepted: true, ...turnBooks(books, { kind: "tap", ...event }, world) }
}
