// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * THE PHONE LEAVING (#229). The page turning hidden, or going (pagehide), tells
 * every peer "away"; visible again (or a pageshow) tells them "back". iOS lets a
 * page send only before it suspends, so this fires on the event itself, never on
 * a timer. The page events come from lib/page-lifecycle.ts, the one place that
 * watches them.
 *
 * Back, it passes the mesh how long the page was hidden. After more than
 * KICK_AFTER_HIDDEN_MS the mesh sweeps every link at once (Mesh.setSelfAway).
 *
 * Takes the mesh as a getter because the mesh is made and torn down inside an
 * effect, and the page can change state with none.
 */
import { watchPageHidden } from "../page-lifecycle"


export function watchPageAway(
  getMesh: () => { setSelfAway: (away: boolean, hiddenForMs?: number) => void } | null | undefined,
): () => void {
  // when the page went to the background, on the monotonic clock; null = in front
  let hiddenAt: number | null = null
  return watchPageHidden(
    () => {
      hiddenAt ??= performance.now()
      getMesh()?.setSelfAway(true)
    },
    () => {
      const hiddenForMs = hiddenAt === null ? undefined : performance.now() - hiddenAt
      getMesh()?.setSelfAway(false, hiddenForMs)
      hiddenAt = null
    },
  )
}
