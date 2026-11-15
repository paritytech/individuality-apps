// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// @vitest-environment jsdom
// This suite mounts a React hook, so it needs a DOM; the project default is
// `environment: "node"` (see vite.config.ts). Do not remove.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";

import type {
  AirdropParticipation,
  AirdropStanding,
  Hex32,
} from "@individuality/daily-dollar";

const mocks = vi.hoisted(() => ({
  claim: vi.fn(),
  pendingClaim: false,
  settlement: { settled: false, isPending: false },
}));

vi.mock("@features/airdrops/hooks/use-claim-airdrop-prize.ts", () => ({
  useClaimAirdropPrize: () => ({ claim: mocks.claim }),
}));
vi.mock("@features/prize/chain/pending-daily-claim.ts", () => ({
  hasPendingDailyClaim: () => mocks.pendingClaim,
}));
vi.mock("@features/prize/hooks/use-prize-winnings.ts", () => ({
  useDailyPrizeSettlementState: () => mocks.settlement,
}));

import {
  __resetAutoClaimForTests,
  useAutoClaimDraws,
} from "@features/airdrops/hooks/use-auto-claim-draws.ts";

const NOW_SECONDS = 1_800_000_000;
const ACCOUNT = "5HumanityId";
const eventIdAt = (index: number): Hex32 =>
  `0x${"70".repeat(24)}${index.toString(16).padStart(16, "0")}` as Hex32;

function win(
  eventId: Hex32,
  overrides: Partial<AirdropParticipation> = {},
): AirdropParticipation {
  return {
    draw: {
      eventId,
      drawIndex: 0n,
      status: "Claiming",
      registrationStartsSeconds: NOW_SECONDS - 7200,
      drawTimeSeconds: NOW_SECONDS - 3600,
      endTimeSeconds: NOW_SECONDS + 3600,
      prizeAmount: 1_000n,
      assetId: null,
      maxWinners: 1,
      totalParticipants: 1,
      effectiveWinners: 1,
      claimed: 0,
    },
    slot: `0x${"cd".repeat(32)}` as Hex32,
    registered: true,
    winner: true,
    claimed: null,
    ...overrides,
  };
}

function standingOf(participations: AirdropParticipation[]): AirdropStanding {
  return {
    accountAddress: "5AirdropAccount",
    participations,
    alias: `0x${"aa".repeat(32)}` as Hex32,
    airdropsContext: `0x${"bb".repeat(32)}` as Hex32,
    aliasContext: `0x${"bb".repeat(32)}` as Hex32,
    contextMatches: true,
    atBlockHash: `0x${"04".repeat(32)}` as Hex32,
  };
}

beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(NOW_SECONDS * 1000);
});

afterEach(() => {
  __resetAutoClaimForTests();
  mocks.claim.mockReset();
  mocks.pendingClaim = false;
  mocks.settlement = { settled: false, isPending: false };
  vi.restoreAllMocks();
});

describe("useAutoClaimDraws", () => {
  it("claims a won Claiming draw as soon as the screen sees it, once per draw", () => {
    const first = standingOf([win(eventIdAt(1))]);
    const mounted = renderHook(
      ({ standing }) => useAutoClaimDraws(standing, ACCOUNT, true),
      { initialProps: { standing: first } },
    );

    expect(mocks.claim).toHaveBeenCalledTimes(1);
    expect(mocks.claim.mock.calls[0]?.[0].draw.eventId).toBe(eventIdAt(1));

    mounted.rerender({ standing: standingOf([win(eventIdAt(1))]) });
    expect(mocks.claim).toHaveBeenCalledTimes(1);

    mounted.unmount();
    renderHook(() => useAutoClaimDraws(standingOf([win(eventIdAt(1))]), ACCOUNT, true));
    expect(mocks.claim).toHaveBeenCalledTimes(1);
  });

  it("claims a second draw when it becomes claimable", () => {
    const mounted = renderHook(
      ({ standing }) => useAutoClaimDraws(standing, ACCOUNT, true),
      { initialProps: { standing: standingOf([win(eventIdAt(1))]) } },
    );
    mounted.rerender({
      standing: standingOf([
        win(eventIdAt(1), { winner: false, claimed: true }),
        win(eventIdAt(2)),
      ]),
    });

    expect(mocks.claim).toHaveBeenCalledTimes(2);
    expect(mocks.claim.mock.calls[1]?.[0].draw.eventId).toBe(eventIdAt(2));
  });

  it.each([
    ["a miss", win(eventIdAt(1), { winner: false })],
    ["an undeterminable winner", win(eventIdAt(1), { winner: null })],
    ["a draw still registering", win(eventIdAt(1), { draw: { ...win(eventIdAt(1)).draw, status: "Registering" } })],
    ["an elapsed claim window", win(eventIdAt(1), { draw: { ...win(eventIdAt(1)).draw, endTimeSeconds: NOW_SECONDS - 1 } })],
  ])("does not claim %s", (_label, participation) => {
    renderHook(() => useAutoClaimDraws(standingOf([participation]), ACCOUNT, true));

    expect(mocks.claim).not.toHaveBeenCalled();
  });

  it("does not claim while disabled, without an account, or without a standing", () => {
    renderHook(() => useAutoClaimDraws(standingOf([win(eventIdAt(1))]), ACCOUNT, false));
    renderHook(() => useAutoClaimDraws(standingOf([win(eventIdAt(1))]), "", true));
    renderHook(() => useAutoClaimDraws(undefined, ACCOUNT, true));

    expect(mocks.claim).not.toHaveBeenCalled();
  });

  it("does not resubmit a draw whose earlier broadcast is still unresolved", () => {
    mocks.pendingClaim = true;
    renderHook(() => useAutoClaimDraws(standingOf([win(eventIdAt(1))]), ACCOUNT, true));

    expect(mocks.claim).not.toHaveBeenCalled();
  });

  it("waits for the settlement ledger and never claims a settled draw", () => {
    mocks.settlement = { settled: true, isPending: true };
    const mounted = renderHook(
      ({ standing }) => useAutoClaimDraws(standing, ACCOUNT, true),
      { initialProps: { standing: standingOf([win(eventIdAt(1))]) } },
    );
    expect(mocks.claim).not.toHaveBeenCalled();

    mocks.settlement = { settled: true, isPending: false };
    mounted.rerender({ standing: standingOf([win(eventIdAt(1))]) });
    expect(mocks.claim).not.toHaveBeenCalled();

    mocks.settlement = { settled: false, isPending: false };
    mounted.rerender({ standing: standingOf([win(eventIdAt(1))]) });
    expect(mocks.claim).toHaveBeenCalledTimes(1);
  });
});
