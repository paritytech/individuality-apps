// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/** Pure resolution of the live prize surface from the people-airdrop
 *  standing query. No React, no chain reads — just the four states the
 *  surface can distinguish:
 *
 *  - empty: no draws at all
 *  - empty: draws open but not yet drawn
 *  - ticket with outcome: "miss" (a draw closed and this account did not win)
 *  - ticket with outcome: "win" (a draw closed and this account won)
 *
 *  The ticket's `eventId` is included so the screen can read scratch and
 *  settlement ledgers keyed by it. The beneficiary account is resolved
 *  separately by the screen — the surface itself never signs anything. */
import type {
  AirdropDraw,
  AirdropParticipation,
  AirdropStanding,
  Hex32,
} from "@individuality/daily-dollar";

export interface LiveTicketLabels {
  amountLabel: string;
  dateLabel: string;
  oddsLabel: string;
}

/** The one surface the live branch renders. */
export type LiveSurface =
  | { kind: "empty"; message: string }
  | {
      kind: "ticket";
      outcome: "win" | "miss";
      eventId: Hex32;
      labels: LiveTicketLabels;
    };

/**
 * The runtime removes a winner entry after a successful claim, so a fresh
 * standing read can look like a loss. The persisted winnings ledger is the
 * durable proof that this account won and claimed this exact event.
 */
export function restoreSettledWin(
  surface: LiveSurface,
  settlementPending: boolean,
  settled: boolean,
): LiveSurface {
  if (
    surface.kind !== "ticket" ||
    surface.outcome !== "miss" ||
    settlementPending ||
    !settled
  ) {
    return surface;
  }

  return { ...surface, outcome: "win" };
}

const DAYS = [
  "SUNDAY", "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY",
];
const MONTHS = [
  "JANUARY", "FEBRUARY", "MARCH", "APRIL", "MAY", "JUNE",
  "JULY", "AUGUST", "SEPTEMBER", "OCTOBER", "NOVEMBER", "DECEMBER",
];

/** Pure UTC weekday/day/month label, e.g. `"TUESDAY 25 AUGUST"`. */
export function formatDateLabel(date: Date): string {
  return `${DAYS[date.getUTCDay()] ?? ""} ${date.getUTCDate()} ${MONTHS[date.getUTCMonth()] ?? ""}`;
}

/** Truthful card labels for a live ticket, derived from the on-chain draw. */
export function liveTicketLabels(
  participation: AirdropParticipation,
): LiveTicketLabels {
  const draw = participation.draw;
  return {
    amountLabel: "$1",
    dateLabel: formatDateLabel(new Date(draw.drawTimeSeconds * 1000)),
    oddsLabel: oddsLabel(draw),
  };
}

function oddsLabel(draw: AirdropDraw): string {
  // `null` means *not determinable* per the domain contract, never a default
  // of zero or max-winners. A draw in `Scheduled`, `Registering` (no
  // `effective_winners` yet), or post-cleanup has no honest odds to state —
  // printing `1 in N` would invent a number. Guard `effectiveWinners === 0`
  // to keep the divisor safe.
  if (draw.effectiveWinners == null || draw.totalParticipants == null) {
    return "";
  }
  if (draw.effectiveWinners <= 0 || draw.totalParticipants <= 0) {
    return "";
  }
  const field = Math.max(1, Math.round(draw.totalParticipants / draw.effectiveWinners));
  return `Odds today: 1 in ${field}`;
}

function notReadyMessage(status: AirdropDraw["status"]): string {
  switch (status) {
    case "Registering":
      return "Registration is open for today's dollar. The draw hasn't happened yet.";
    case "DrawWinners":
    case "AwaitingEntropy":
      return "Today's dollar is being drawn. Check back in a moment.";
    case "Scheduled":
    default:
      return "Today's dollar isn't open yet. Come back when registration opens.";
  }
}

/**
 * Resolve the live surface from the standing. The standing is the only
 * input; the time is read from `nowSeconds` so the surface is deterministic
 * for tests and refetches.
 */
export function resolveLiveSurface(
  standing: AirdropStanding | undefined,
  nowSeconds: number,
): LiveSurface {
  // No loading state: a first read that has not landed renders the resting
  // copy and the 12 s refetch reconciles it silently. A standing already in
  // hand — hydrated from the last visit, or retained through a refetch that
  // timed out — keeps its ticket: the chain being slow is not a lost draw.
  if (standing == null) {
    return { kind: "empty", message: "Today's dollar isn't open yet." };
  }
  if (standing.participations.length === 0) {
    return {
      kind: "empty",
      message: "No draws are scheduled on People Chain yet.",
    };
  }
  // A ticket exists only for a draw this person was in. `winner` reads
  // `false` for every Claiming draw without a Winners entry — including
  // draws never registered for — so a miss needs `registered === true`;
  // `winner === null` (alias missing, slot unresolvable, salt reaped) is
  // not a loss either. A claimed win keeps its ticket after the runtime
  // removes the winner entry; `useAirdropStanding` marks that `claimed`.
  const inClaiming = standing.participations.find(
    (entry) =>
      entry.draw.status === "Claiming" &&
      nowSeconds < entry.draw.endTimeSeconds &&
      (entry.winner === true ||
        entry.claimed === true ||
        (entry.winner === false && entry.registered === true)),
  );
  if (inClaiming != null) {
    return {
      kind: "ticket",
      outcome:
        inClaiming.winner === true || inClaiming.claimed === true ? "win" : "miss",
      eventId: inClaiming.draw.eventId,
      labels: liveTicketLabels(inClaiming),
    };
  }
  // An `AwaitingEntropy` / `DrawWinners` draw is mid-flight: registration
  // closed, the winners haven't been materialised yet, and there is no
  // honest ticket to show. Surface the in-draw copy rather than letting it
  // fall through to the generic "no draws are open".
  const inDraw = standing.participations.find(
    (entry) =>
      (entry.draw.status === "AwaitingEntropy" ||
        entry.draw.status === "DrawWinners") &&
      nowSeconds < entry.draw.endTimeSeconds,
  );
  if (inDraw != null) {
    return {
      kind: "empty",
      message: notReadyMessage(inDraw.draw.status),
    };
  }
  const inRegistration = standing.participations.find(
    (entry) =>
      entry.draw.status === "Registering" &&
      nowSeconds < entry.draw.drawTimeSeconds,
  );
  if (inRegistration != null) {
    return {
      kind: "empty",
      message: notReadyMessage(inRegistration.draw.status),
    };
  }
  const scheduled = standing.participations.find(
    (entry) => entry.draw.status === "Scheduled",
  );
  if (scheduled != null) {
    return {
      kind: "empty",
      message: notReadyMessage(scheduled.draw.status),
    };
  }
  // Draws exist but none are currently surfaceable: a Claiming draw whose
  // window closed without a determinable winner, post-cleanup clears, or
  // statuses we never surface. Keep the truthful "no draws are open" copy
  // rather than dressing any one status as the headline.
  return {
    kind: "empty",
    message: "No draws are open on People Chain right now.",
  };
}
