// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/** Test fixtures for `live-daily-screen.test.tsx`. Extracted to keep the
 *  test file under the 200-line budget while still expressing the
 *  claim-hook, status and standing shapes the screen consumes. Pure
 *  helpers and constants — no React, no vi mocks. */
import type {
  AirdropParticipation,
  AirdropStanding,
  Hex32,
} from "@individuality/daily-dollar";
import type { LiveSurface } from "@features/prize/domain/live-prize-surface.ts";

export const EVENT_ID: Hex32 = `0x${"1".repeat(64)}` as const;
const ALIAS: Hex32 = `0x${"02".repeat(32)}` as const;
const CONTEXT: Hex32 = `0x${"03".repeat(32)}` as const;
const BLOCK_HASH: Hex32 = `0x${"04".repeat(32)}` as const;

/** The screen reads `Date.now()` to compute `nowSeconds`. The pin below
 *  lands inside the claim window of every fixture made by `makeWin`, so
 *  the test runs deterministically regardless of wall-clock drift. */
export const FIXED_NOW_SECONDS = 1_780_000_000;

export function makeWin(): AirdropParticipation {
  return {
    draw: {
      eventId: EVENT_ID,
      drawIndex: 1n,
      status: "Claiming",
      registrationStartsSeconds: FIXED_NOW_SECONDS - 3600,
      drawTimeSeconds: FIXED_NOW_SECONDS - 60,
      endTimeSeconds: FIXED_NOW_SECONDS + 3600,
      prizeAmount: 1_000_000n,
      assetId: null,
      maxWinners: 1,
      totalParticipants: 1,
      effectiveWinners: 1,
      claimed: 0,
    },
    slot: ALIAS,
    registered: true,
    winner: true,
    claimed: false,
  };
}

export function standingFor(
  participations: AirdropParticipation[],
): AirdropStanding {
  return {
    participations,
    alias: ALIAS,
    airdropsContext: CONTEXT,
    aliasContext: CONTEXT,
    contextMatches: true,
    atBlockHash: BLOCK_HASH,
  };
}

export function winSurface(): LiveSurface {
  return {
    kind: "ticket",
    outcome: "win",
    eventId: EVENT_ID,
    labels: { amountLabel: "$1", dateLabel: "TUESDAY 26 AUGUST", oddsLabel: "" },
  };
}

export interface ClaimStatus {
  pending: boolean;
  unknown: boolean;
  included: boolean;
}

export interface ClaimHook {
  claim: (participation: AirdropParticipation) => void;
  statusFor: (eventId: string) => ClaimStatus;
}
