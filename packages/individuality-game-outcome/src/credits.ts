// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * THE CREDITS ONE GAME EARNED THE PLAYER, as they land: the People chain
 * awards a credit per `Person` vote at report time and backfills the rest at
 * the settle, and Asset Hub takes each award block's root a block or two later
 * (nft-credits, `send_credit_trees`). So a surface can say how many a game
 * earned, and how many still wait for their root, before the game settles.
 *
 * Which collectable each credit becomes, and its art, is a product's own read
 * (Jollity's collectables screen); this is the plain count every surface can show.
 *
 * Pure, over the credits `getClaims` of `@parity/product-sdk-nfts` returns
 * (./chain, credits.ts, reads them).
 */

/** Where one credit stands: awarded and waiting for its root (`earned`),
 *  claimable, spent, or gone with its block's awards (`unprovable`). */
export type CreditState = "earned" | "claimable" | "claimed" | "unprovable"

/** One credit, as far as the count reads it. `gameIndex` is null before its
 *  award block's root exists, which names the game. */
export interface Credit {
  gameIndex: number | null
  state: CreditState
}

export interface GameCredits {
  /** every credit the game earned that a claim can still prove */
  total: number
  /** of those, the ones whose award block has no root on Asset Hub yet */
  pending: number
  claimable: number
  claimed: number
}

/**
 * The credits of `gameIndex`: those its root names, and, while it is the
 * last game the player attended (`latestGame`), those still waiting for a
 * root, which can only be its own. Never an unprovable one.
 */
export function gameCredits(credits: readonly Credit[], gameIndex: number, latestGame: boolean): GameCredits {
  const ours = credits.filter(
    (credit) => (credit.gameIndex === gameIndex || (credit.gameIndex === null && latestGame)) && credit.state !== "unprovable",
  )
  return {
    total: ours.length,
    pending: ours.filter((credit) => credit.state === "earned").length,
    claimable: ours.filter((credit) => credit.state === "claimable").length,
    claimed: ours.filter((credit) => credit.state === "claimed").length,
  }
}
