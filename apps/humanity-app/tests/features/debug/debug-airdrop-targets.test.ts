// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/** The prefills exist so a debug submission is never a doomed extrinsic, and
 *  the block reasons exist because a greyed-out button teaches nothing. What is
 *  pinned here is that both track the same guards the prize page uses, and that
 *  a context mismatch — invisible in the draw list, fatal to both calls — is
 *  reported rather than offered. */
import { describe, expect, it } from "vitest";

import {
  airdropTarget,
  claimPrefill,
  findParticipation,
  openDraws,
  registerPrefill,
  topUpPrefill,
} from "@features/debug/debug-airdrop-targets.ts";
import { buildDrawEventId } from "@humanity/shared/airdrops/chain/draw-event-id.ts";
import type {
  AirdropParticipation,
  AirdropStanding,
} from "@individuality/daily-dollar";
import type { DebugPageInput } from "@features/debug/debug-view.ts";

const NOW = 1_800_000_000;
const CONTEXT = `0x${"cc".repeat(32)}` as const;

function participation(
  drawIndex: bigint,
  overrides: {
    status?: string;
    registered?: boolean | null;
    winner?: boolean | null;
    slot?: string | null;
    drawTimeSeconds?: number;
    endTimeSeconds?: number;
  } = {},
): AirdropParticipation {
  return {
    draw: {
      eventId: buildDrawEventId(drawIndex),
      drawIndex,
      status: overrides.status ?? "Registering",
      registrationStartsSeconds: NOW - 1000,
      drawTimeSeconds: overrides.drawTimeSeconds ?? NOW + 1000,
      endTimeSeconds: overrides.endTimeSeconds ?? NOW + 2000,
      prizeAmount: 1_000n,
      maxWinners: 10,
      totalParticipants: 1,
    },
    slot: overrides.slot === undefined ? `0x${"11".repeat(32)}` : overrides.slot,
    registered: overrides.registered ?? false,
    winner: overrides.winner ?? null,
    claimed: null,
  } as unknown as AirdropParticipation;
}

function standing(overrides: Partial<AirdropStanding> = {}): AirdropStanding {
  return {
    participations: [],
    alias: `0x${"aa".repeat(32)}`,
    airdropsContext: CONTEXT,
    aliasContext: CONTEXT,
    contextMatches: true,
    atBlockHash: `0x${"bb".repeat(32)}`,
    ...overrides,
  } as unknown as AirdropStanding;
}

function input(overrides: Partial<DebugPageInput> = {}): DebugPageInput {
  return {
    network: "previewnet",
    productDomain: "peopl.testnet",
    card: undefined,
    cardPending: false,
    cardError: null,
    game: undefined,
    gamePending: false,
    gameError: null,
    airdrops: standing(),
    airdropsPending: false,
    airdropsError: null,
    ...overrides,
  } as DebugPageInput;
}

describe("airdropTarget", () => {
  it("is ready when a standing was read and the alias context matches", () => {
    expect(airdropTarget(input())).toEqual({ kind: "ready", standing: standing() });
  });

  it("distinguishes loading, failed and never-read standing", () => {
    expect(airdropTarget(input({ airdrops: undefined, airdropsPending: true }))).toMatchObject(
      { reason: "standing still loading" },
    );
    expect(
      airdropTarget(input({ airdrops: undefined, airdropsError: new Error("boom") })),
    ).toMatchObject({ reason: "standing read failed" });
    expect(airdropTarget(input({ airdrops: undefined }))).toMatchObject({
      reason: "no standing read yet",
    });
  });

  // Every derived slot is wrong in this state, so both calls would come back
  // BadOrigin — the panel has to say so rather than offer a doomed button.
  it("blocks an alias already bound to another context", () => {
    const wrongContext = airdropTarget(
      input({
        airdrops: standing({ contextMatches: false, aliasContext: `0x${"dd".repeat(32)}` }),
      }),
    );
    expect(wrongContext).toMatchObject({
      kind: "blocked",
      reason: expect.stringContaining("another pallet's context"),
    });

  });

  it("allows registration to perform the first-time alias binding", () => {
    const unbound = standing({
      alias: null,
      contextMatches: false,
      aliasContext: null,
    });
    expect(airdropTarget(input({ airdrops: unbound }))).toEqual({
      kind: "ready",
      standing: unbound,
    });
  });
});

describe("topUpPrefill", () => {
  it("offers the newest won draw's prize in base units, or nothing", () => {
    expect(topUpPrefill(standing())).toBe("");
    expect(topUpPrefill(standing({ participations: [participation(4n, { winner: false })] }))).toBe("");
    const won = standing({
      participations: [
        participation(4n, { status: "Claiming", winner: true }),
        { ...participation(9n, { status: "Claiming", winner: false }), claimed: true },
      ],
    });
    expect(topUpPrefill(won)).toBe("1000");
  });
});

describe("openDraws", () => {
  it("offers every draw open now, in index order, marking the ones this account is in", () => {
    const view = standing({
      participations: [
        participation(5n, { registered: true }),
        participation(3n),
        participation(4n, { status: "Scheduled" }),
        participation(6n, { drawTimeSeconds: NOW }),
        participation(2n, { status: "Claiming" }),
      ],
    });

    expect(openDraws(view, NOW).map((d) => [d.drawIndex, d.registered])).toEqual([
      [3n, false],
      [5n, true],
    ]);
  });
});

describe("registerPrefill", () => {
  it("offers exactly the draws still open and unregistered", () => {
    const held = standing({
      participations: [
        participation(1n),
        participation(2n, { registered: true }),
        participation(3n, { status: "Claiming" }),
        participation(4n, { slot: null }),
        participation(5n, { drawTimeSeconds: NOW - 1 }),
        participation(6n),
      ],
    });
    expect(registerPrefill(held, NOW)).toBe("1 6");
  });

  it("is empty when nothing is pending", () => {
    expect(registerPrefill(standing(), NOW)).toBe("");
  });
});

describe("claimPrefill", () => {
  it("offers the claimable draw whose window closes first", () => {
    const held = standing({
      participations: [
        participation(8n, { winner: true, status: "Claiming", endTimeSeconds: NOW + 900 }),
        participation(9n, { winner: true, status: "Claiming", endTimeSeconds: NOW + 100 }),
      ],
    });
    expect(claimPrefill(held, NOW)).toBe("9");
  });

  it("offers nothing for a non-winner, a shut window, or the wrong status", () => {
    expect(
      claimPrefill(
        standing({ participations: [participation(1n, { winner: false, status: "Claiming" })] }),
        NOW,
      ),
    ).toBe("");
    expect(
      claimPrefill(
        standing({
          participations: [
            participation(2n, { winner: true, status: "Claiming", endTimeSeconds: NOW - 1 }),
          ],
        }),
        NOW,
      ),
    ).toBe("");
    expect(
      claimPrefill(
        standing({ participations: [participation(3n, { winner: true, status: "Registering" })] }),
        NOW,
      ),
    ).toBe("");
  });
});

describe("findParticipation", () => {
  it("matches on the draw's event id", () => {
    const held = standing({ participations: [participation(4n)] });
    expect(findParticipation(held, buildDrawEventId(4n))?.draw.drawIndex).toBe(4n);
  });

  // Claiming a draw the page never read would leave the winnings ledger
  // describing a prize this session never observed.
  it("returns null for a draw outside the standing", () => {
    expect(findParticipation(standing(), buildDrawEventId(4n))).toBeNull();
  });
});
