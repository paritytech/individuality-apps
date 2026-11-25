// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * THE DRAW SCREEN'S WORLD — what lib/draw/draw-screen-host runs its commands
 * against, for real: the chain (the source, the draw's read, the claim), the
 * journey (the payoff, the seen-mark, the draw's facts), the browser (the
 * idle watch, the collectables screen's claims read early, the page's visibility, the stage) and the
 * debug log. The screen's one module that imports them.
 */
import { getGameSource } from "@/lib/game-source"
import { loadDraw, peekDraw } from "@/lib/draw/draw-load"
import { drawMissFor } from "@/lib/draw/draw-miss"
import { startAutoClaim } from "@/lib/draw/auto-claim"
import { readDrawName } from "@/lib/draw/draw-name-lookup"
import { createPrizeDrawPayoffRunner } from "@/lib/draw/payoff-runner"
import { createBrowserDrawIdle, touchOnPointerDown } from "@/lib/draw/draw-idle"
import { createDrawCeremony } from "@/lib/draw/wheel/ceremony"
import { startStage } from "@/lib/draw/wheel/stage-runner"
import { markSeen } from "@/lib/worker-bridge"
import { drawShown } from "@/lib/journeys/game-trace"
import { reportDrawCeremony } from "@/lib/telemetry"
import { devLog } from "@/lib/debug/log-store"
import { describeError } from "@/lib/host/error-detail"
import { contactUsernames } from "@/lib/host/contacts"
import { postGameIndex } from "@/lib/post-game"
import { devUrlParam } from "@/lib/debug/dev-url"
import { collectablesHref } from "@/lib/draw/collectables-href"
import type { DrawScreenDeps } from "@/lib/draw/draw-screen-host"

export function browserDrawScreenDeps(router: { replace(href: string): void }): DrawScreenDeps {
  // the game this page is for, read once: the URL's ?game=, or the game the
  // session remembered when a host dropped it. ?player= (another account's
  // draw, never claimed) is read in a development build only (lib/debug/dev-url.ts).
  const browser = typeof window !== "undefined"
  const game = browser ? postGameIndex() : undefined
  const override = browser ? devUrlParam("player") : undefined
  const log = (message: string, data?: unknown, level?: "info" | "warn") => devLog("draw", message, data, level)
  // the player's contacts, asked for as the screen opens: the host answers
  // long before the wheel mounts, and a draw that mounts first marks no friends
  let friends: readonly string[] = []
  if (browser) void contactUsernames().then((names) => (friends = names))
  return {
    game,
    override,
    peek: () => peekDraw(game, override),
    miss: () => drawMissFor(game),
    source: getGameSource,
    // the same read the game session started on the confirm screen, or a fresh one
    load: (source) => loadDraw(source, game, override),
    claim: startAutoClaim,
    payoff: createPrizeDrawPayoffRunner(game ?? -1),
    drawShown,
    markSeen: (index) => void markSeen(index, "draw"),
    // the draw plays FIRST, while the chain is still tallying what the collectables screen will hold
    toCollectables: () => router.replace(collectablesHref()),
    // the collectables screen comes next: its claims are read while the wheel plays
    preloadCollectables: () => {
      void import("@/lib/collectables/collectables-screen-deps").then(({ preloadCollectablesFeed }) => preloadCollectablesFeed()).catch(() => {})
    },
    idle: createBrowserDrawIdle,
    touch: touchOnPointerDown,
    stage: startStage,
    names: readDrawName,
    friends: () => friends,
    ceremony: () => createDrawCeremony({ devLog: log, report: reportDrawCeremony }),
    hidden: () => document.visibilityState === "hidden",
    log,
    describe: describeError,
  }
}
