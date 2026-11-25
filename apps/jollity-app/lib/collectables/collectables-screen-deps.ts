// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The collectables screen's way out: the only module of the screen that reaches the
 * chain, the payoff's journey, storage, telemetry and the browser. The host
 * (./collectables-screen-host) takes these as `CollectablesScreenDeps`, so it and its tests
 * import none of it.
 */
import { armCollectablesRereads } from "@/lib/collectables-reread"
import { readCollectablesPicks, saveCollectablesPick } from "@/lib/collectables-picks"
import { devLog } from "@/lib/debug/log-store"
import { collectablesSeed, getGameSource } from "@/lib/game-source"
import { describeError } from "@/lib/host/error-detail"
import { readStashPicks } from "@/lib/host/stash-picks"
import { collectablesOpened, collectablesReadRecovered, collectablesShown, payoffHandedOff, payoffStalled } from "@/lib/journeys/game-trace"
import { openHumanity } from "@/lib/membership/humanity-target"
import { pageHidden, watchPageHidden } from "@/lib/page-lifecycle"
import { createPayoffScreenRunner } from "@/lib/payoff-screen-runner"
import { postGameIndex } from "@/lib/post-game"
import { devUrlParam } from "@/lib/debug/dev-url"
import { markSeen } from "@/lib/worker-bridge"
import { holdCollectablesFeed, runCollectablesFeed, type CollectablesFeedReads } from "./collectables-feed"
import type { CollectablesScreenDeps } from "./collectables-screen-host"

/**
 * A healthy picks read answers in well under a second.
 *
 * The picks only choose which collection art each claim shows, so a host that
 * never answers must not hold the collectables screen for the 120 seconds truapi waits.
 */
const PICKS_WAIT_MS = 5_000

/** how long the draw's early start of the claims feed waits for the collectables screen to take it over */
const PRELOAD_GRACE_MS = 180_000

/** the reads the claims feed makes, for this page's player and game */
function feedReads(): CollectablesFeedReads {
  return {
    game: postGameIndex(),
    // /collectables?player=<ss58>: another account's collectables screen, in a development build
    // only (lib/debug/dev-url.ts)
    player: devUrlParam("player"),
    read: (source, options) => source.collectablesView(options),
    // a source with no watch (the dev engine) goes straight to the settle's read
    watch: (source, options) => source.watchCollectables?.(options) ?? Promise.resolve(),
    picks: () =>
      Promise.all([
        readCollectablesPicks({ timeoutMs: PICKS_WAIT_MS }),
        readStashPicks({ timeoutMs: PICKS_WAIT_MS }).then((stash) => stash ?? new Map()),
      ]),
    wait: (ms, signal) =>
      new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer)
          signal.removeEventListener("abort", done)
          resolve()
        }
        const timer = setTimeout(done, ms)
        signal.addEventListener("abort", done, { once: true })
      }),
    log: (message, data, level) => devLog("chest", message, data, level),
  }
}

/** The prize draw, as it opens: start the collectables screen's claims feed, so the collectables screen finds them read. */
export function preloadCollectablesFeed(): void {
  void getGameSource()
    .then((source) => {
      if (source) holdCollectablesFeed(source, feedReads(), null, PRELOAD_GRACE_MS)()
    })
    .catch(() => {})
}

export function browserCollectablesScreenDeps(): CollectablesScreenDeps {
  const reads = feedReads()
  const { game, player: override } = reads
  return {
    game,
    override,
    source: getGameSource,
    seed: (source) => {
      const player = override ?? source.player
      return player ? collectablesSeed(player, game ?? null) : null
    },
    feed(source, { shared }, listener) {
      if (shared) return holdCollectablesFeed(source, reads, listener)
      const controller = new AbortController()
      void runCollectablesFeed(source, reads, listener, controller.signal)
      return () => controller.abort()
    },
    payoff: createPayoffScreenRunner(game ?? -1, "/collectables"),
    collectablesOpened,
    collectablesShown,
    collectablesReadRecovered,
    payoffStalled,
    payoffHandedOff,
    // out of the game, to the player's Humanity card. A host that would not
    // open it leaves the player here, with Continue to try again.
    leaveForHumanity: (refused) =>
      void openHumanity().catch((error: unknown) => {
        devLog("payoff", "the hand-off to Humanity failed", { detail: describeError(error) }, "warn")
        refused()
      }),
    markSeen: (game) => void markSeen(game, "chest"),
    savePick: (hash, collectionId) => void saveCollectablesPick(hash, collectionId),
    timer(ms, onElapsed) {
      const timer = setTimeout(onElapsed, ms)
      return () => clearTimeout(timer)
    },
    rereads: (reread) =>
      armCollectablesRereads({ reread, hidden: pageHidden, onShown: (listener) => watchPageHidden(() => {}, listener) }),
    now: Date.now,
    log: (message, data, level) => devLog("chest", message, data, level),
  }
}
