// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * THE GAME THE POST-GAME SCREENS ARE ABOUT — remembered by the app, not only
 * carried in the URL.
 *
 * The draw, the collectables screen and the recap are all about the game the player just
 * played, and the game session knows exactly which one that is. The links the
 * app builds carry it as `?game=N`, but a host can drop the query on the way:
 * on iOS the draw screen can open with no `?game=` at all, fall back to "the
 * last attended game" (an older one, while the chain has not settled the new
 * one yet) and miss the draw the confirm screen already loaded.
 *
 * So the session REMEMBERS the game here the moment it knows it, and every
 * post-game screen asks this module. An explicit `?game=` still wins (the
 * app's own links, a reload of a full URL, a hand-made link), in every build;
 * the remembered game fills in when the URL arrives without one; only with
 * neither is it unknown, and the screen falls back to the player's last
 * attended game.
 *
 * Kept in memory, which is what survives the in-app navigations that lost
 * the query, and mirrored to sessionStorage for a reload, where the host
 * allows it. A remembered game goes stale after a few hours, so a player who
 * leaves the app open overnight is not shown yesterday's draw.
 */
import { devLog } from "./debug/log-store"

const STORAGE_KEY = "jollity.postGame"
/** longer than any game and its post-game screens, shorter than a day */
const MAX_AGE_MS = 3 * 60 * 60 * 1000

interface Remembered {
  index: number
  at: number
}

let remembered: Remembered | null = null

function stored(): Remembered | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const value = JSON.parse(raw) as Partial<Remembered>
    return typeof value.index === "number" && typeof value.at === "number" ? { index: value.index, at: value.at } : null
  } catch {
    return null // no sessionStorage in this host, or not ours to read
  }
}

/** the game session names the game it is playing; the screens after it ask */
export function rememberPostGame(index: number): void {
  if (!Number.isInteger(index) || index < 0) return
  if (remembered?.index === index) return
  remembered = { index, at: Date.now() }
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(remembered))
  } catch {
    /* memory alone still carries it through the in-app navigations */
  }
}

/**
 * The game a post-game screen is about: `?game=` when the URL has it, else
 * the game the session remembered, else undefined (the caller then falls back
 * to the player's last attended game).
 */
export function postGameIndex(search?: string): number | undefined {
  const query = search ?? (typeof window === "undefined" ? "" : window.location.search)
  const fromUrl = new URLSearchParams(query).get("game")
  if (fromUrl !== null && fromUrl !== "" && Number.isInteger(Number(fromUrl))) return Number(fromUrl)
  const memory = remembered ?? stored()
  if (memory && Date.now() - memory.at < MAX_AGE_MS) {
    devLog("post-game", "the URL came without ?game — using the game the session remembered", { game: memory.index })
    return memory.index
  }
  return undefined
}

/** a post-game route, carrying the game on in the URL as well */
export function postGameHref(path: string): string {
  const game = postGameIndex()
  return game === undefined ? path : `${path}?game=${game}`
}

/** forget the remembered game: the player left the finished game behind
 *  (lib/start-over), and tests */
export function forgetPostGame(): void {
  remembered = null
  try {
    sessionStorage.removeItem(STORAGE_KEY)
  } catch {
    /* nothing to clear */
  }
}
