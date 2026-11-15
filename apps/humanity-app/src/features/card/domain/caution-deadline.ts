// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/** The Caution window's deadline. Everything is timed from the real next
 *  game: no game the player can still act on means no deadline. */
import type { CurrentGameResult } from "./current-game.ts";
import { formatRemaining } from "./game-schedule.ts";
import { resolveWeeklyGameView } from "./weekly-game-view.ts";

/** What the player can still do about the next game, in the weekly block's
 *  own terms: register, keep the registration they have, or play it now. */
export type CautionAction = "registration-open" | "confirmed" | "play-now";

export interface CautionDeadline {
  gameIndex: number;
  gameDateSeconds: number;
  /** Local calendar days until the game: 0 on the day itself. */
  daysLeft: number;
  /** The game is today — the cue for the last-day sheet. */
  urgent: boolean;
  action: CautionAction;
  /** Time left to register, for a player who has not; `null` otherwise. */
  registrationCloses: string | null;
}

const DAY_MS = 86_400_000;

/** Whole local calendar days from `now` to `then`. Rounded, so a daylight
 *  saving change inside the span still counts as one day. */
function calendarDaysBetween(nowSeconds: number, thenSeconds: number): number {
  const startOfDay = (seconds: number) => new Date(seconds * 1000).setHours(0, 0, 0, 0);
  return Math.round((startOfDay(thenSeconds) - startOfDay(nowSeconds)) / DAY_MS);
}

/** Only advertise an action while the real game still accepts it. */
export function cautionDeadline(
  game: CurrentGameResult | null,
  pending: boolean,
  unavailable: boolean,
  nowSeconds: number,
): CautionDeadline | null {
  if (game?.kind !== "game") return null;
  const view = resolveWeeklyGameView(game, pending, unavailable, nowSeconds, false);
  const action: CautionAction | null =
    view.mode === "registration-open" || view.mode === "confirmed" || view.mode === "play-now"
      ? view.mode
      : null;
  if (action == null) return null;
  const daysLeft = Math.max(0, calendarDaysBetween(nowSeconds, game.gameDateSeconds));
  return {
    gameIndex: game.gameIndex,
    gameDateSeconds: game.gameDateSeconds,
    daysLeft,
    urgent: daysLeft === 0,
    action,
    registrationCloses:
      action === "registration-open"
        ? formatRemaining(game.registrationEndsSeconds - nowSeconds)
        : null,
  };
}

/** The grace-window chip on the game block: "today", "tomorrow", or the
 *  whole calendar days left. Calendar days, so a game tomorrow evening never
 *  reads "today" the night before, and the sheet and the chip always agree. */
export function cautionChip(deadline: CautionDeadline): string {
  if (deadline.daysLeft === 0) return "today";
  if (deadline.daysLeft === 1) return "tomorrow";
  return `${deadline.daysLeft} days left`;
}
