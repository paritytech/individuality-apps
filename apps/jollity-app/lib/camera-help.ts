// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

"use client"

/**
 * THE CAMERA OF THE WAITING ROOM: when it warms up, and what the player is
 * shown about it.
 *
 * THE WARM-UP is staggered. The waiting room opens when registration closes
 * (T−5:00 at the earliest), which is the same chain block for every player,
 * and a first open on a busy phone can be slow enough to time out. Each
 * player starts within `WARM_UP_SPREAD_S` of T−2:30, by a hash of their
 * account, so the camera is still warm well before the handover at T−1:04
 * (lib/joined.ts `handoverAt`).
 *
 * NO CAMERA, NO GAME, so a camera that will not start is not left as an
 * empty disc. lib/camera keeps trying by itself, and this says what the player
 * reads meanwhile. Nothing is offered to tap. A refusal is fixed in
 * Settings alone: the host keeps the answer to its own prompt and iOS keeps
 * its own, so asking again answers no without a prompt. lib/camera reopens
 * the camera when the app comes back to the front. A busy camera is retried
 * every 2 s and on that return too. "Open Settings" waits on a host
 * capability to open the settings page of the app.
 *
 * `starting` is the handover being due without a camera: the game is about
 * to start, and the player is told plainly that it will not wait. It decides
 * nothing about the game, and promises nothing past kickoff.
 */
import { useMemo } from "react"
import { useCamera, type CameraFailure, type CameraState } from "./camera"
import type { HomeView } from "./home-gate"
import { handoverAt } from "./joined"

export interface CameraTrouble {
  reason: CameraFailure
  starting: boolean
}

/** the help for a camera that could not be opened (`reason`), or null */
export function cameraHelp(reason: CameraFailure | null, starting: boolean): CameraTrouble | null {
  if (!reason) return null
  return { reason, starting }
}

/** the warm-up's earliest start before kickoff (registration closes then) */
export const WARM_UP_LEAD_S = 150
/** and how far after that a player's own start may fall */
export const WARM_UP_SPREAD_S = 20

/** the player's own warm-up start, in the seconds of `gameAt`: T−2:30 plus
 *  0 to 20 s from a hash of the account (FNV-1a), the same on every open;
 *  T−2:30 itself while the account is not known yet */
export function warmUpAt(gameAt: number, account: string | null | undefined): number {
  if (!account) return gameAt - WARM_UP_LEAD_S
  let hash = 0x811c9dc5
  for (const char of account) hash = Math.imul(hash ^ char.charCodeAt(0), 0x01000193)
  return gameAt - WARM_UP_LEAD_S + ((hash >>> 0) % (WARM_UP_SPREAD_S + 1))
}

/** /game is fetched while the camera is not opening, or anyway this close to
 *  the handover, so the handover lands inside the camera's grace */
const PREFETCH_BY_S = 20

/**
 * The waiting room's camera, as one value from home's view (lib/home-gate):
 * the camera (held from the player's warm-up start), its help, and whether
 * /game may be fetched now. `now` is the source's clock, like `gameAt`.
 */
export function useWaitingRoomCamera(
  view: HomeView,
  at: { now: number; account: string | null | undefined },
): { camera: CameraState; help: CameraTrouble | null; prefetch: boolean } {
  const gameAt = view.status.kind === "waiting" ? view.status.gameAt : undefined
  const warm = gameAt !== undefined && at.now >= warmUpAt(gameAt, at.account)
  const camera: CameraState = useCamera(warm)
  const joinAt = gameAt !== undefined ? handoverAt(gameAt) : undefined
  const starting = joinAt !== undefined && at.now >= joinAt
  const reason = camera.kind === "unavailable" ? camera.reason : null
  const help = useMemo(() => cameraHelp(reason, starting), [reason, starting])
  const prefetch =
    joinAt !== undefined && ((warm && camera.kind !== "opening") || joinAt - at.now < PREFETCH_BY_S)
  return { camera, help, prefetch }
}
