// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * ONE FRONT DOOR (#1137): in every page load, the game's pages open only
 * after home.
 *
 * Home runs the entry gates, the update check (lib/release) among them. The
 * game's pages (/game, /prize-draw, /chest) are reached from home by
 * client-side moves, which keep home's verdict. A FRESH LOAD on one of them
 * skipped home: the host reopening the last page it showed, a reload, the
 * app's own self-reload. A host can reopen a results page on a build many
 * hours old that way, and its player would never be asked to update.
 *
 * So until home has been on screen in this page load, those pages are not
 * drawn: <FrontDoor> (components/front-door.tsx, in the root layout) sends the
 * load home and holds the URL it was going to. Home runs its gates, then
 * sends the player on to that URL (`arrivalStep`), so a reopened chest is
 * still the chest. A stale build is held on the update screen instead, and a
 * device already in the running game goes straight back in, unchecked, as
 * the game is never interrupted.
 *
 * The door is a small store in memory, which is what a page load is:
 * client-side moves keep it, and every fresh load starts it closed.
 */
import type { GameStatus } from "./game-source"
import { homeSituation } from "./home-screen"
import type { BuildAnswer } from "./release/stale-build"

/** the pages a page load opens only after home */
const BEHIND_HOME: readonly string[] = ["/game", "/prize-draw", "/chest"]

/** undefined until the load's first look (`frontDoorOpen`) */
let open: boolean | undefined
let held: string | null = null
const listeners = new Set<() => void>()
const changed = () => {
  for (const listener of listeners) listener()
}

/** `pathname` without the base path (next/navigation usePathname) */
export function behindHome(pathname: string): boolean {
  return BEHIND_HOME.includes(pathname.replace(/\/$/, "") || "/")
}

/** for useSyncExternalStore: the door opening, a load held or let go */
export function watchFrontDoor(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Is the door open? Closed at the load's first look, open once home is on
 *  screen. */
export function frontDoorOpen(): boolean {
  open ??= false
  return open
}

/** Home is on screen: every page opens from here on in this page load. */
export function openFrontDoor(): void {
  if (open === true) return
  open = true
  changed()
}

/** Does <FrontDoor> keep this page off the screen? */
export function frontDoorHolds(pathname: string, isOpen: boolean): boolean {
  return behindHome(pathname) && !isOpen
}

/** home's root (app/page.tsx): its test hooks, a stable contract */
const HOME_ROOT = '[data-testid="home"]'

/**
 * A held load can arrive carrying HOME's markup. A host that finds no file of
 * its own for a game URL answers with the root index.html: the Android host's
 * archive resolver tries `chest` and `chest/index.html`, never the export's
 * `chest.html`, then falls back to the root page. That document is home's
 * prerender, and the hydration render of a held game page draws nothing, so
 * React claims none of it and leaves it where it is, directly under <body>.
 * Home's loading screen (its bare "Jollity" title) would stay above the page
 * for the whole load, and the page itself below the screen, under its own
 * fixed layers. At the door nothing of home's is React's yet, so any home
 * root in the document is that leftover. Returns how many were taken out.
 */
export function dropStrayHome(root: ParentNode): number {
  const stray = root.querySelectorAll(HOME_ROOT)
  for (const node of stray) node.remove()
  return stray.length
}

/** <FrontDoor> holds the URL a page load was going to (path and query, no
 *  base path) and sends it home. */
export function holdArrival(href: string): void {
  held = href
  changed()
}

/** the URL home sends the held load on to. It outlives home (the permission
 *  gate's detour comes back to it), until a game page is reached or home's
 *  own handover takes the player in. */
export function heldArrival(): string | null {
  return held
}

export function dropArrival(): void {
  if (held === null) return
  held = null
  changed()
}

/**
 * What home does with a held load now.
 *  - "wait": the status is not in yet, or the gates are not done
 *  - "go": send it on to its URL
 *  - "hold": the build is stale; the update screen shows (lib/home-gate)
 *  - "drop": home's own handover takes the player into the game instead
 *
 * `joined` is whether this device is already in the status's game
 * (lib/joined). `gateDone` is home's permission check
 * (lib/use-permission-gate).
 */
export function arrivalStep({
  href,
  status,
  now,
  hostOnly,
  joined,
  gateDone,
  build,
}: {
  href: string
  status: GameStatus
  now: number
  hostOnly: boolean
  joined: boolean
  gateDone: boolean
  build: BuildAnswer
}): "wait" | "go" | "hold" | "drop" {
  // with no host the status never loads: nothing to tell from it
  if (status.kind === "loading" && !hostOnly) return "wait"
  // back into the game this device is in, also in its report window, at once and never checked
  const path = href.split("?")[0]?.replace(/\/$/, "")
  const inGame =
    status.kind === "waiting" ||
    status.kind === "live" ||
    ((status.kind === "none" || status.kind === "scheduled") && status.reportingGameAt !== undefined)
  if (path === "/game" && joined && inGame) return "go"
  // a game to go into: home's handover does it, with its own check
  const { inWaiting, goesIn } = homeSituation(status, now)
  if (inWaiting || goesIn) return "drop"
  if (!gateDone || build.last === undefined) return "wait"
  return build.state === "stale" ? "hold" : "go"
}

/** tests: a fresh page load */
export function resetFrontDoor(): void {
  open = undefined
  held = null
  listeners.clear()
}
