// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/** Test fixtures for the live-prize surface tests — extracted so the test
 *  file can stay under the 200-line budget while still expressing a wide
 *  variety of standing shapes. Pure helpers, no side effects. */
import type {
  AirdropDraw,
  AirdropParticipation,
  AirdropStanding,
  Hex32,
} from "@individuality/daily-dollar";

export const NOW = 1_800_000_000;
export const EVENT_ID: Hex32 = `0x${"01".repeat(32)}`;
const ALIAS: Hex32 = `0x${"02".repeat(32)}`;
const CONTEXT: Hex32 = `0x${"03".repeat(32)}`;
const BLOCK_HASH: Hex32 = `0x${"04".repeat(32)}`;

function draw(
  status: AirdropDraw["status"],
  drawTimeSeconds: number,
  endTimeSeconds: number,
  options: { effectiveWinners?: number | null; totalParticipants?: number | null } = {},
): AirdropDraw {
  return {
    eventId: EVENT_ID,
    drawIndex: 1n,
    status,
    registrationStartsSeconds: drawTimeSeconds - 3600,
    drawTimeSeconds,
    endTimeSeconds,
    prizeAmount: 1_000_000n,
    assetId: { parents: 0, interior: "Here" },
    maxWinners: 10,
    totalParticipants: options.totalParticipants ?? null,
    effectiveWinners: options.effectiveWinners ?? null,
    claimed: null,
  };
}

export function participation(
  status: AirdropDraw["status"],
  options: {
    winner?: boolean | null;
    drawTimeSeconds?: number;
    endTimeSeconds?: number;
    effectiveWinners?: number | null;
    totalParticipants?: number | null;
  } = {},
): AirdropParticipation {
  return {
    draw: draw(
      status,
      options.drawTimeSeconds ?? NOW - 3600,
      options.endTimeSeconds ?? NOW + 3600,
      {
        effectiveWinners: options.effectiveWinners ?? null,
        totalParticipants: options.totalParticipants ?? null,
      },
    ),
    slot: ALIAS,
    registered: true,
    winner: options.winner ?? false,
    claimed: false,
  };
}

export function standing(participations: AirdropParticipation[]): AirdropStanding {
  return {
    participations,
    alias: ALIAS,
    airdropsContext: CONTEXT,
    aliasContext: CONTEXT,
    contextMatches: true,
    atBlockHash: BLOCK_HASH,
  };
}
