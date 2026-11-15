// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/** Presentation helpers for the live weekly game block.
 *  Every value here is derived from chain-provided Unix seconds — the module
 *  invents no dates, no durations, and no schedule. */
import { hostPillUp, JOIN_LEAD_S } from "@individuality/sign-up/reminder";

const MINUTE = 60;
const HOUR = 3600;
const DAY = 86_400;

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const twoDigits = (n: number) => String(n).padStart(2, "0");

/** The game date, in the viewer's own locale. Weekday and time always; the
 *  calendar date joins in once "Saturday" alone would be ambiguous. */
export function formatGameDate(gameDateSeconds: number, nowSeconds: number): string {
  const date = new Date(gameDateSeconds * 1000);
  const farOut = gameDateSeconds - nowSeconds > 6 * DAY;
  return date.toLocaleString(undefined, {
    weekday: farOut ? "short" : "long",
    ...(farOut ? { month: "short" as const, day: "numeric" as const } : {}),
    hour: "numeric",
    minute: "2-digit",
  });
}

/** The game's weekday alone, in the viewer's locale: the word copy leans on
 *  ("Play this Saturday", "Wake it up Saturday"). Games are weekly, so the
 *  next one is never more than a week out and the weekday never ambiguous. */
export function formatGameWeekday(gameDateSeconds: number): string {
  return new Date(gameDateSeconds * 1000).toLocaleString(undefined, { weekday: "long" });
}

/** The game's day with its date, in the viewer's locale: "Thursday, Oct 1".
 *  For copy naming a game a week or more out, where the weekday alone would
 *  read as this week's. */
export function formatGameDay(gameDateSeconds: number): string {
  return new Date(gameDateSeconds * 1000).toLocaleDateString(undefined, {
    weekday: "long",
    month: "short",
    day: "numeric",
  });
}

/** The game's clock time alone, in the viewer's locale: "18:00" in the UK,
 *  "6:00 PM" in the US. */
export function formatGameTime(gameDateSeconds: number): string {
  return new Date(gameDateSeconds * 1000).toLocaleString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

/** Coarse remaining span: "2 days 4 hrs", "4 hrs 10 min", "8 min".
 *  Returns null once the instant has passed, so callers say something else. */
export function formatRemaining(secondsRemaining: number): string | null {
  if (secondsRemaining <= 0) return null;
  const days = Math.floor(secondsRemaining / DAY);
  const hours = Math.floor((secondsRemaining % DAY) / HOUR);
  const minutes = Math.floor((secondsRemaining % HOUR) / MINUTE);
  if (days > 0) {
    return hours > 0
      ? `${plural(days, "day", "days")} ${plural(hours, "hr", "hrs")}`
      : plural(days, "day", "days");
  }
  if (hours > 0) {
    return minutes > 0
      ? `${plural(hours, "hr", "hrs")} ${plural(minutes, "min", "min")}`
      : plural(hours, "hr", "hrs");
  }
  return plural(Math.max(1, minutes), "min", "min");
}

/** Countdown chip copy for the next game. Coarse ("in 2 days 4 hrs") an hour
 *  or more out; minute/second precision as the deadline approaches. Seconds
 *  are always two digits ("in 1 min 05 sec"), so the chip keeps its width as
 *  it ticks. The precise countdown runs to the join, a minute ahead of the
 *  start, which is where the pill of the host and the chat card count to. */
export function formatCountdown(gameDateSeconds: number, nowSeconds: number): string {
  const untilStart = gameDateSeconds - nowSeconds;
  if (untilStart < HOUR) {
    const remaining = untilStart - JOIN_LEAD_S;
    if (remaining <= 0) return "under way";
    const minutes = Math.floor(remaining / MINUTE);
    const seconds = Math.floor(remaining % MINUTE);
    return minutes > 0
      ? `in ${minutes} min ${twoDigits(seconds)} sec`
      : `in ${twoDigits(Math.max(1, seconds))} sec`;
  }
  return `in ${formatRemaining(untilStart)}`;
}

/** The chip of a registered player's game while the pill of the host counts
 *  down the last five minutes to the join. */
const STARTING_SOON = "game starting soon";

/** The chip of a game the player is registered for: the countdown, except
 *  under the pill of the host, which is then the only countdown on screen. */
export function formatRegisteredCountdown(gameDateSeconds: number, nowSeconds: number): string {
  return hostPillUp(gameDateSeconds, nowSeconds)
    ? STARTING_SOON
    : formatCountdown(gameDateSeconds, nowSeconds);
}
