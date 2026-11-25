// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * THE PRIZE, CLAIMED BY ITSELF — a won prize draw is claimed from the draw
 * screen, with no button, as soon as the chain would pay it. The wait and the
 * read before the claim are @individuality/prize's `claimWhenPayable`;
 * this file starts it once per draw and logs how it ended.
 *
 * `Game.claim_airdrop` pays a winner who is recognized or has reached
 * personhood, and whose last attended game is this one. The chain writes both
 * to `Score.Participants` when it applies the player's attendance: early, once
 * the votes still to come can no longer change it (#1096), or at the settle.
 * So the claim waits for that (`attendanceApplied`), reads the draw again, and
 * sends only when the read says the chain would pay: a refused claim costs a
 * fee.
 *
 * The draw screen starts it once the player has seen the result, and it
 * carries on when they move on to the collectables screen: one claim per draw for the life
 * of the page, whichever screen is up. Whatever it could not do is left to the
 * chat, which claims the same prize by itself only once the game has settled,
 * so the two meet only on a draw held after that
 * (apps/jollity-worker/src/index.ts `autoClaimFor`). The screen says nothing
 * of it; every way it ends goes to the debug sheet.
 *
 * Framework-free (architecture rule 6).
 */
import { claimWhenPayable } from "@individuality/prize"
import type { GameSource } from "../game-source"
import { devLog } from "../debug/log-store"
import { describeError } from "../host/error-detail"
import type { PrizeDrawView } from "./prize-draw"
import { claimFailureOf, claimRefusalOf } from "./prize-claim"

export type AutoClaimSource = Pick<GameSource, "prizeDrawView" | "claimPrize" | "attendanceApplied">

/** the draws a claim was started for, for the life of the page */
const started = new Set<string>()

/**
 * Claim `draw` for the player, once. A draw they did not win, or one already
 * claimed, starts nothing; a second call for the same draw is a no-op.
 */
export function startAutoClaim(source: AutoClaimSource, draw: PrizeDrawView): void {
  const key = `${draw.gameIndex}:${draw.airdropIndex}`
  if (!draw.won || draw.claimed || started.has(key)) return
  started.add(key)
  const where = { game: draw.gameIndex, draw: draw.airdropIndex }
  if (draw.phase !== "drawn") return devLog("claim", "the claim window has closed", where)
  void run(source, draw, where)
}

async function run(source: AutoClaimSource, won: PrizeDrawView, where: { game: number; draw: number }): Promise<void> {
  const { gameIndex, airdropIndex } = won
  if (!source.attendanceApplied || !source.claimPrize) {
    return devLog("claim", "no signer here: the automatic claim is left to the chat", where, "warn")
  }
  const { attendanceApplied, claimPrize, prizeDrawView } = source
  const outcome = await claimWhenPayable({
    attendanceApplied: () => attendanceApplied(gameIndex),
    readDraw: async () => (await prizeDrawView({ gameIndex }))?.find((d) => d.airdropIndex === airdropIndex),
    claim: () => claimPrize(gameIndex, airdropIndex),
  })
  switch (outcome.kind) {
    case "no-attendance":
      return devLog("claim", "the automatic claim gave up waiting for the game", { ...where, detail: describeError(outcome.error) }, "warn")
    case "unreadable":
      return devLog("claim", "the automatic claim could not read the draw", { ...where, detail: describeError(outcome.error) }, "warn")
    case "no-draw":
      return devLog("claim", "the draw is no longer on the chain", where, "warn")
    case "claimed":
      return devLog("claim", outcome.now ? "claimed" : "already claimed", where)
    case "not-payable":
      return devLog("claim", "the chain would not pay the claim", { ...where, reason: outcome.draw.claimBlockedReason })
    case "not-claimed": {
      const { error } = outcome
      const why = { ...where, failure: claimFailureOf(error), refusal: claimRefusalOf(error), detail: describeError(error) }
      return devLog("claim", "the automatic claim did not land: the chat has it", why, "warn")
    }
  }
}

/** Test boundary equivalent to a fresh document load. */
export function resetAutoClaimsForTest(): void {
  started.clear()
}
