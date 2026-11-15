// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/** Pure presentation resolution for the live weekly game block, so the
 *  deadline/cancellation/unknown cases are unit-testable without a DOM. */
import type { GamePhaseLabel } from "@humanity/shared/chain/game-phase.ts";
import type { CurrentGameResult, NextGame } from "./current-game.ts";
import { formatCountdown, formatGameDate, formatRegisteredCountdown } from "./game-schedule.ts";

/** What the weekly block should render; `value` is the locale-aware game
 *  date, `chip` the countdown or phase chip. */
export type WeeklyGameView =
  | { mode: "loading" }
  | { mode: "unavailable" }
  | { mode: "no-game" }
  | {
      /** The next scheduled game, once the running one (if any) is behind
       *  the player: "Next game" never points back in time. */
      mode: "upcoming";
      value: string;
      chip: string;
      note: string;
    }
  | { mode: "confirmed"; value: string; chip: string }
  | {
      mode: "registration-open";
      value: string;
      chip: string;
      /** Header label above the date — "Next game", or a first-timer's own. */
      eyebrow: string;
      /** Call-to-action label; the action signs up here (`useRegisterForGame`). */
      cta: string;
    }
  | {
      mode: "play-now";
      value: string;
      chip: string;
      /** Call-to-action label; the action hands off to DIM2 to play. */
      cta: string;
    }
  | {
      /** The player's game is over and the chain has not scored it yet: the
       *  chat's "Game Results Pending", with nothing to tap. */
      mode: "results-pending";
      value: string;
      chip: string;
      cta: string;
      note: string;
    }
  | { mode: "closed"; value: string; chip: string; note: string; warn: true }
  | { mode: "unknown"; value: string; chip: string }
  | { mode: "cancelled"; value: string; chip: string; note: string; warn: true };

/** Sub-copy for the game's current phase. Registration-open and play-now
 *  carry no note at all — the action speaks for itself — so every case here
 *  is closed. */
function phaseNote(label: GamePhaseLabel): string {
  switch (label) {
    case "registration":
      return "Registration has just closed for this game.";
    case "shuffle":
    case "reporting":
      return "This game is under way, and registration has closed.";
    case "processing":
      return "This game is being wrapped up.";
    case "cancelling":
      return "This game was called off.";
    default:
      return "Registration has closed for this game.";
  }
}

function phaseChip(label: GamePhaseLabel): string {
  switch (label) {
    case "shuffle":
    case "reporting":
      return "under way";
    case "processing":
      return "wrapping up";
    case "cancelling":
      return "called off";
    default:
      return "closed";
  }
}

/** Registration-open header/action copy. A first game is worth naming as
 *  one; everyone else has been here before. */
const FIRST_GAME_COPY = { eyebrow: "Your first game", cta: "Register" };
const RETURNING_COPY = { eyebrow: "Next game", cta: "Register" };

/** Live handoff copy for a registered account once registration closes. */
const PLAY_NOW_CTA = "Play now";

/** Once the player's game is over, in the words of the chat card (apps/jollity-worker/src/card/copy.ts). */
const RESULTS_PENDING = { chip: "results pending", cta: "Game results pending", note: "It may take a little while to process." };

/** The next scheduled game, with when its registration opens. The chain
 *  creates the game (and opens registration) only when the running one ends,
 *  so a projected opening already past reads as "soon". */
function upcomingView(next: NextGame, nowSeconds: number): WeeklyGameView {
  const opens = next.registrationStartsSeconds;
  return {
    mode: "upcoming",
    value: formatGameDate(next.gameDateSeconds, nowSeconds),
    chip: formatCountdown(next.gameDateSeconds, nowSeconds),
    note:
      opens > nowSeconds
        ? `Registration opens ${formatGameDate(opens, nowSeconds)}.`
        : "Registration opens soon.",
  };
}

/**
 * Resolve what the weekly game block shows from the chain result and the
 * home's wall clock. Order matters:
 *  - a called-off game wins over every claim, including a stale registered flag;
 *  - a registered account is confirmed ("Registered") exactly while
 *    registration is still open; once the wall clock crosses
 *    `registrationEndsSeconds` the confirmed seat becomes the live "Play now"
 *    handoff and stays that way while the game is still played —
 *    registration just closed, shuffle, or reporting up to the end of the
 *    last turn (`playEndsSeconds`). From then until the chain has scored the
 *    game (the rest of reporting, and processing) it is "results pending",
 *    the chat card's verdict, with nothing to tap: the game is over for the
 *    player, whatever the phase still says;
 *  - registration is open exactly while the phase is registration AND the
 *    wall clock still precedes `registrationEndsSeconds` (the query-time
 *    secondsRemaining is a snapshot, not a deadline);
 *  - an unknown registration preserves the known game details without making
 *    an unregistered or confirmed claim;
 *  - "Next game" points forward: once the running game's play time has
 *    passed, every state except "Play now" (still the live game) shows the
 *    next scheduled game instead, "results pending" included: scoring runs in
 *    the background, so the player only sees what to register for next.
 *    Between games, the schedule's first game.
 *
 * `firstGame` is true when this account has never played — it only changes
 * the registration-open header and action copy, never the rules above.
 *
 * Registration-open offers "Register" without a seat verdict of its own: the
 * sign-up (`useRegisterForGame`, on Jollity's flow) prepares the seat in the
 * background — the bind and the name link — reads it again before it signs,
 * and says under the button what it waits on or why it stopped.
 */
export function resolveWeeklyGameView(
  game: CurrentGameResult | null,
  pending: boolean,
  unavailable: boolean,
  nowSeconds: number,
  firstGame = false,
): WeeklyGameView {
  if (pending) return { mode: "loading" };
  if (unavailable || game == null || game.kind === "account-unavailable") {
    return { mode: "unavailable" };
  }
  if (game.kind === "no-game") {
    return game.nextGame ? upcomingView(game.nextGame, nowSeconds) : { mode: "no-game" };
  }

  const { gameDateSeconds, phase, registrationEndsSeconds, registered, nextGame } = game;
  const value = formatGameDate(gameDateSeconds, nowSeconds);
  const countdown = formatCountdown(gameDateSeconds, nowSeconds);
  // the running game's time is behind us: what comes next is the next game
  const behind = gameDateSeconds <= nowSeconds ? nextGame : null;

  if (phase.label === "cancelling") {
    if (behind) return upcomingView(behind, nowSeconds);
    return {
      mode: "cancelled",
      value,
      chip: "called off",
      note: phaseNote("cancelling"),
      warn: true,
    };
  }

  const registrationOpen =
    phase.label === "registration" && registrationEndsSeconds > nowSeconds;

  if (registered === null) {
    if (behind) return upcomingView(behind, nowSeconds);
    return { mode: "unknown", value, chip: countdown };
  }

  if (registered === true) {
    const chip = formatRegisteredCountdown(gameDateSeconds, nowSeconds);
    if (registrationOpen) {
      return { mode: "confirmed", value, chip };
    }
    const over = phase.label === "processing" || (phase.label === "reporting" && nowSeconds >= game.playEndsSeconds);
    if (over) {
      // scoring happens in the background: with a game ahead, point straight at it
      if (behind) return upcomingView(behind, nowSeconds);
      return { mode: "results-pending", value, ...RESULTS_PENDING };
    }
    return { mode: "play-now", value, chip, cta: PLAY_NOW_CTA };
  } else if (registrationOpen) {
    const copy = firstGame ? FIRST_GAME_COPY : RETURNING_COPY;
    return {
      mode: "registration-open",
      value,
      chip: countdown,
      eyebrow: copy.eyebrow,
      cta: copy.cta,
    };
  }

  if (behind) return upcomingView(behind, nowSeconds);
  return {
    mode: "closed",
    value,
    chip: phaseChip(phase.label),
    note: phaseNote(phase.label),
    warn: true,
  };
}
