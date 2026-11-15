// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The chest screen's way out: the only module of the screen that reaches the
 * chain, the payoff's journey, storage, telemetry and the browser. The host
 * (./chest-screen-host) takes these as `ChestScreenDeps`, so it and its tests
 * import none of it.
 */
import { armChestRereads } from "@/lib/chest-reread"
import { readChestPicks, saveChestPick } from "@/lib/chest-picks"
import { devLog } from "@/lib/debug/log-store"
import { chestSeed, getGameSource } from "@/lib/game-source"
import { describeError } from "@/lib/host/error-detail"
import { readStashPicks } from "@/lib/host/stash-picks"
import { chestOpened, chestReadRecovered, chestShown, payoffHandedOff, payoffStalled } from "@/lib/journeys/game-trace"
import { openHumanity } from "@/lib/membership/humanity-target"
import { pageHidden, watchPageHidden } from "@/lib/page-lifecycle"
import { createPayoffScreenRunner } from "@/lib/payoff-screen-runner"
import { postGameIndex } from "@/lib/post-game"
import { devUrlParam } from "@/lib/debug/dev-url"
import { markSeen } from "@/lib/worker-bridge"
import { holdChestFeed, runChestFeed, type ChestFeedReads } from "./chest-feed"
import type { ChestScreenDeps } from "./chest-screen-host"

/**
 * A healthy picks read answers in well under a second.
 *
 * The picks only choose which collection art each claim shows, so a host that
 * never answers must not hold the chest for the 120 seconds truapi waits.
 */
const PICKS_WAIT_MS = 5_000

/** how long the draw's early start of the claims feed waits for the chest to take it over */
const PRELOAD_GRACE_MS = 180_000

/** the reads the claims feed makes, for this page's player and game */
function feedReads(): ChestFeedReads {
  return {
    game: postGameIndex(),
    // /chest?player=<ss58>: another account's chest, in a development build
    // only (lib/debug/dev-url.ts)
    player: devUrlParam("player"),
    read: (source, options) => source.chestView(options),
    // a source with no watch (the dev engine) goes straight to the settle's read
    watch: (source, options) => source.watchChest?.(options) ?? Promise.resolve(),
    picks: () =>
      Promise.all([
        readChestPicks({ timeoutMs: PICKS_WAIT_MS }),
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

/** The prize draw, as it opens: start the chest's claims feed, so the chest finds them read. */
export function preloadChestFeed(): void {
  void getGameSource()
    .then((source) => {
      if (source) holdChestFeed(source, feedReads(), null, PRELOAD_GRACE_MS)()
    })
    .catch(() => {})
}

export function browserChestScreenDeps(): ChestScreenDeps {
  const reads = feedReads()
  const { game, player: override } = reads
  return {
    game,
    override,
    source: getGameSource,
    seed: (source) => {
      const player = override ?? source.player
      return player ? chestSeed(player, game ?? null) : null
    },
    feed(source, { shared }, listener) {
      if (shared) return holdChestFeed(source, reads, listener)
      const controller = new AbortController()
      void runChestFeed(source, reads, listener, controller.signal)
      return () => controller.abort()
    },
    payoff: createPayoffScreenRunner(game ?? -1, "/chest"),
    chestOpened,
    chestShown,
    chestReadRecovered,
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
    savePick: (hash, collectionId) => void saveChestPick(hash, collectionId),
    timer(ms, onElapsed) {
      const timer = setTimeout(onElapsed, ms)
      return () => clearTimeout(timer)
    },
    rereads: (reread) =>
      armChestRereads({ reread, hidden: pageHidden, onShown: (listener) => watchPageHidden(() => {}, listener) }),
    now: Date.now,
    log: (message, data, level) => devLog("chest", message, data, level),
  }
}
