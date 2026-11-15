// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * WHY THE PLAYER IS NOT IN THIS GAME'S DRAW — remembered from their own
 * sign-up, so the draw screen can say it while they watch the wheel.
 *
 * The draw screen shows the draw to everyone, in it or not (the spectator
 * wheel). A player who is not in it is told so, and — when this phone made
 * the sign-up and knows the reason — why. The reason is the sign-up's own
 * (`DrawSkipKind`, the same one the sign-up span reports), kept per
 * game in memory and mirrored to sessionStorage for a reload, like the
 * post-game game (lib/post-game.ts). A sign-up made elsewhere leaves nothing
 * here, and the screen says only that they were not in it.
 */
import type { DrawSkipKind } from "@individuality/sign-up"
import { prizeLabel } from "./prize-unit"
import type { PrizeDraw } from "./prize-draw"

const STORAGE_KEY = "jollity.drawMiss"

const misses = new Map<number, DrawSkipKind | null>()

function stored(): Record<string, DrawSkipKind | null> {
  try {
    return JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? "{}") as Record<string, DrawSkipKind | null>
  } catch {
    return {}
  }
}

/** the sign-up for this game went out without a draw ticket, for this reason
 *  (null: the reason is not one the player was asked about) */
export function rememberDrawMiss(gameIndex: number, kind: DrawSkipKind | null): void {
  misses.set(gameIndex, kind)
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ ...stored(), [gameIndex]: kind }))
  } catch {
    /* memory alone carries it to the draw screen */
  }
}

/** why this phone's sign-up missed the game's draw: the reason, null for a
 *  miss with no reason given, undefined when this phone does not know */
export function drawMissFor(gameIndex: number | undefined): DrawSkipKind | null | undefined {
  if (gameIndex === undefined) return undefined
  if (misses.has(gameIndex)) return misses.get(gameIndex)
  const saved = stored()
  return String(gameIndex) in saved ? saved[String(gameIndex)] : undefined
}

const WHY: Record<DrawSkipKind, string> = {
  "not-open": "The draw wasn't open yet when you signed up.",
  signature: "Your ticket wasn't signed when you signed up.",
  "read-failed": "We couldn't check the draw when you signed up.",
  closing: "You signed up as registration was closing, too late for a ticket.",
  closed: "The draw had already closed when you signed up.",
  "verified-person": "Your verified seat couldn't be proved for the draw when you signed up.",
  refused: "The chain wouldn't take a ticket from your account.",
  "not-member-yet": "Only members can claim prizes, and this game couldn't make you one yet. You'll be in the draw once a game can.",
}

/** why the player is not in the draw, in their words: for the words that
 *  stand in for the wheel (drawResultLine). Null when the reason is not known */
export function drawMissReason(kind: DrawSkipKind | null | undefined): string | null {
  return kind ? WHY[kind] : null
}

/** THE DRAW, EXPLAINED to a player who is not in it, on a screen of its own
 *  before the wheel: what is about to happen, how the wheel picks, and that
 *  draws are for members. One version for everyone not in it, whatever kept
 *  them out, and nothing says they are not in it: the draw itself shows. The
 *  prize goes on a chip of its own, as the draw's win screen has it; one line
 *  per beat: the screen fades them in one by one. */
export function drawIntro(draw: Pick<PrizeDraw, "prizeUsd" | "winningTickets">): {
  heading: string
  prize: string
  paragraphs: string[]
} {
  const winners = Math.max(1, draw.winningTickets.length)
  const one = winners === 1
  return {
    heading: one ? "Someone's about to win" : `${winners} people are about to win`,
    prize: prizeLabel(draw.prizeUsd),
    paragraphs: [
      one ? "The ticket that stops at the top wins." : `The ${winners} tickets that stop at the top win.`,
      "Draws are for members. Keep playing to join.",
    ],
  }
}

/** the chain's result in words: the heading and the body of the draw screen
 *  when the wheel does not tell the draw. `missReason`: why a player who was
 *  not in it was not (drawMissReason), when known. */
export function drawResultLine(draw: PrizeDraw, missReason: string | null): { heading: string; body: string | null } {
  const prize = prizeLabel(draw.prizeUsd)
  const [heading, body] = !draw.userTicket
    ? ["You weren't in this draw", missReason ?? "Your sign-up didn't enter this game's prize draw."]
    : draw.won
      ? ["You won", `${prize} is yours.`]
      : ["Not this time", `${draw.winningTickets.length === 1 ? "One ticket" : `${draw.winningTickets.length} tickets`} won ${prize}.`]
  return { heading, body }
}

/** tests only */
export function forgetDrawMisses(): void {
  misses.clear()
  try {
    sessionStorage.removeItem(STORAGE_KEY)
  } catch {
    /* nothing to clear */
  }
}
