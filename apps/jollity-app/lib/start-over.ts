// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * STARTING OVER after the player leaves for another product (#465).
 *
 * After the game the chest hands the player to their Humanity card.
 * A product cannot close itself (the host offers no call for it), and the
 * Android host brings the tab back as it was, so a player who came back for
 * the next game would find the finished game's after-game screen, still
 * running.
 * So the hand-off is marked as it goes, and the first return to the page after
 * it starts the app over at the home on a fresh load: the source, every module
 * cache and the remembered post-game index go with it.
 *
 * ON RETURN, not at the hand-off: a navigateTo that did nothing must not take
 * the chest away, and a reload while the host is switching products
 * buys nothing. The mark lives in memory only. A page the host tore down comes
 * back as a fresh load anyway, and a stored mark would outlive the visit it
 * was for (iOS reloads the root on most reopens) and restart the next game.
 */
import { asset } from "./asset"
import { forgetPostGame } from "./post-game"
import { requestSelfReload } from "./self-reload"
import { watchForegroundReturn, type ForegroundReturn } from "./telemetry/foreground"

let leftAt: number | null = null

/** Mark the player leaving for another product. Called before navigating:
 *  the host can tear the page down before its navigation settles. */
export function leavingForProduct(): void {
  leftAt = Date.now()
}

/** The navigation was refused: the player is still here. */
export function stayedInProduct(): void {
  leftAt = null
}

function startOver(value: ForegroundReturn): void {
  if (leftAt === null) return
  leftAt = null
  forgetPostGame()
  requestSelfReload(
    "left-product",
    {
      ...(value.awayMs !== null ? { awayMs: value.awayMs } : {}),
      screen: value.returned.screen,
      stage: value.returned.stage,
    },
    // the reload loads the home, not the screen the player left from
    () => window.history.replaceState(null, "", asset("/")),
  )
}

/** Installed once per load (components/debug/debug-boot), beside the long
 *  suspension reload: both read the one foreground tracker. */
export function watchStartOver(): () => void {
  return watchForegroundReturn(startOver)
}
