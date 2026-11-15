// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The Daily Dollar's words: the lines the registry planner attaches to the
 * reminders it schedules, and the lines the worker posts in the product's
 * chat room.
 *
 * Shared by the worker and the app, because both run the same sweep and a
 * reminder scheduled by one is cancelled by the other - two wordings would
 * read as two different products on the same phone. The chat half is posted
 * only by the worker, but it says the same things in the same voice, so it
 * lives here rather than next to the socket that sends it.
 *
 * Plain ASCII, without exception. The host loads a worker bundle as Latin-1,
 * so a curly quote, an en-dash or an emoji is delivered to the phone as
 * mojibake. The worker's own `vite.config.ts` escapes non-ASCII source, but
 * escaped or not, the text the person reads is the text written here.
 * {@link assertAscii} is the guard the tests hold this file to.
 */
import {
  type ChatCopy,
  type DrawRecord,
  OPEN_CARD_ACTION_ID,
  type RegistryCopy,
} from "./registry";

/** Decimals of the airdrop prize asset. */
const AIRDROP_ASSET_DECIMALS = 6;

const BASE_UNITS_PER_CENT = 10n ** BigInt(AIRDROP_ASSET_DECIMALS - 2);

/** Base units as dollars: `$1`, `$1.5`, `$1,000.25`, cents truncated. */
function formatPrizeDollars(baseUnits: bigint): string {
  if (baseUnits < 0n) {
    throw new RangeError(
      `formatPrizeDollars: expected non-negative base units, got ${baseUnits}`,
    );
  }
  const cents = baseUnits / BASE_UNITS_PER_CENT;
  const whole = (cents / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const fraction = cents % 100n;
  if (fraction === 0n) return `$${whole}`;
  const digits =
    fraction % 10n === 0n
      ? `${fraction / 10n}`
      : `${fraction}`.padStart(2, "0");
  return `$${whole}.${digits}`;
}

/** Space through tilde: the printable ASCII range the host can render. */
const PRINTABLE_ASCII = /^[ -~]*$/;

/**
 * Pass `text` through, or throw when it is not printable ASCII. Exported for
 * the tests, which hold every string this module can produce to it; the copy
 * itself is ASCII by construction and does not need the runtime check.
 */
export function assertAscii(text: string): string {
  if (!PRINTABLE_ASCII.test(text)) {
    throw new Error(
      `daily dollar copy must be printable ASCII: ${JSON.stringify(text)}`,
    );
  }
  return text;
}

/** Said when the prize amount is missing or unreadable - the product's name
 *  is the amount, so there is always something true to say. */
const FALLBACK_PRIZE = "a dollar";

/** `prizeAmount` is an untrusted decimal string off the registry; a record
 *  written by an older build, or a zero-prize draw, must not sink the copy. */
function prizeText(record: DrawRecord): string {
  if (!/^\d+$/.test(record.prizeAmount)) return FALLBACK_PRIZE;
  const baseUnits = BigInt(record.prizeAmount);
  if (baseUnits === 0n) return FALLBACK_PRIZE;
  return formatPrizeDollars(baseUnits);
}

/** The one line every Daily Dollar push and chat invitation says. It must
 *  not name the outcome: the scratch is the reveal. */
const SCRATCH_INVITE = "Scratch now, you may have won a dollar today.";

/** One day, the daily schedule's claim window (`end_time = draw + 24 h`). */
const DAY_SECONDS = 86_400;

/** The missed push fires at `end_time`, a whole claim window after the draw.
 *  On the daily schedule that is the next draw's own time, so "today's"
 *  would read as the draw that just opened. A day-long window always puts
 *  the draw on the previous calendar day, in any time zone; any other
 *  window names no day at all. */
function missedText(record: DrawRecord): string {
  const window = record.endTimeSeconds - record.drawTimeSeconds;
  return Math.abs(window - DAY_SECONDS) <= 3_600
    ? "You missed yesterday's chance to win a dollar."
    : "Your Daily Dollar ticket expired before you scratched it.";
}

export const DAILY_DOLLAR_COPY: RegistryCopy = {
  claimWindow: () => SCRATCH_INVITE,
  // Only sent when no reminder was ever placed, so it says exactly what the
  // reminder would have: a winner's push must read like everyone else's.
  won: () => SCRATCH_INVITE,
  // Fires when the claim window shuts on an unopened card, winner or not;
  // it never says which.
  missed: missedText,
};

/**
 * The chat room's lines: one invitation per resolved draw and one result per
 * scratched ticket.
 */
export const DAILY_DOLLAR_CHAT_COPY: ChatCopy = {
  // Word for word the push, so both routes read as one piece of news; the button is chat-only.
  scratchable: (record) => ({
    text: SCRATCH_INVITE,
    buttons: [{ actionId: OPEN_CARD_ACTION_ID, title: "Scratch" }],
    card: { kind: "ticket", eventId: record.eventId, drawTimeSeconds: record.drawTimeSeconds },
  }),

  // No deadline and no balance: the line goes out around the moment the app
  // claims, so anything it says about the claim can be stale when it is read.
  wonResult: (record) => ({
    text: `You scratched a winner: ${prizeText(record)}!`,
    card: { kind: "won", eventId: record.eventId, drawTimeSeconds: record.drawTimeSeconds, prize: prizeText(record) },
  }),

  missResult: (record) => ({
    text: "No dollar this time. The next draw is coming.",
    card: { kind: "miss", eventId: record.eventId, drawTimeSeconds: record.drawTimeSeconds },
  }),
};
