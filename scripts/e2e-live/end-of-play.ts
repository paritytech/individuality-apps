// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// Where a bot's play (stage c) may validly end. A game with a prize draw ends on /prize-draw; a game with NO draw (the chain's
// airdropsScheduled is 0, the app reads "draws: 0" and takes its draw-bypass path, lib/draw/payoff-runner.ts) goes to
// /collectables?game=<index>. The collectables route is accepted only for THIS game's index, so a stray visit mid-game, or to
// another game's collectables, is still a failure. Plain functions: journey.pw.ts is the only caller that needs a page.

/** True for the collectables page of exactly game `gameIndex` (the no-draw end of a game). */
export function isNoDrawCollectables(url: string, gameIndex: number | null | undefined): boolean {
  if (gameIndex === null || gameIndex === undefined) return false
  try {
    const u = new URL(url, "http://localhost")
    return u.pathname === "/collectables" && u.searchParams.get("game") === String(gameIndex)
  } catch {
    return false
  }
}

/** True when the page is on /prize-draw. */
export const isPrizeDraw = (url: string): boolean => url.includes("/prize-draw")

/** True when the page ended its play on a valid payoff route of this game: /prize-draw, or this game's no-draw /collectables. */
export const reachedEndOfPlay = (url: string, gameIndex: number | null | undefined): boolean => isPrizeDraw(url) || isNoDrawCollectables(url, gameIndex)

/** The final URL (c) accepts: /prize-draw, /chest, or this game's no-draw /collectables. */
export const endOfPlayAccepted = (url: string, gameIndex: number | null | undefined): boolean => reachedEndOfPlay(url, gameIndex) || url.includes("/chest")
