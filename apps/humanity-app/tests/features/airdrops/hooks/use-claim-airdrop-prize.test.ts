// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// @vitest-environment jsdom
// This suite mounts a React hook, so it needs a DOM; the project default is
// `environment: "node"` (see vite.config.ts). Do not remove.

/**
 * The claim is the only moment the prize is known to be on product account
 * zero, so the coinage sweep has to be fired from here — and it has to be
 * fired with the amount the chain actually paid. It is deliberately not
 * awaited: the scratch UI settles on the claim, never on a second host
 * transaction, and a failed sweep must never unbank a recorded win.
 */

import { createElement, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  renderHook,
  waitFor,
  type RenderHookResult,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  AirdropParticipation,
  Hex32,
} from "@individuality/daily-dollar";
import type { ClaimAirdropPrizeResult } from "@features/airdrops/chain/claim-draw-prize.ts";
import type { PrizeCoinageSweep } from "@features/prize/chain/prize-coinage.ts";

const mocks = vi.hoisted(() => ({
  claimAirdropPrize: vi.fn(),
  recordPrizeWin: vi.fn(),
  refreshWinnings: vi.fn(),
  sweepPrizeIntoCoinage: vi.fn(),
}));

vi.mock("@features/airdrops/chain/claim-draw-prize.ts", () => ({
  claimAirdropPrize: mocks.claimAirdropPrize,
}));
vi.mock("@features/prize/chain/prize-winnings.ts", () => ({
  recordPrizeWin: mocks.recordPrizeWin,
}));
vi.mock("@features/prize/hooks/use-prize-winnings.ts", () => ({
  useRefreshPrizeWinnings: () => mocks.refreshWinnings,
}));
vi.mock("@features/prize/chain/prize-coinage.ts", () => ({
  sweepPrizeIntoCoinage: mocks.sweepPrizeIntoCoinage,
}));
// `DailyPrizeClaimError` stays the real class: the hook branches on
// `instanceof`, so replacing the module would make the failure test vacuous.

import {
  useClaimAirdropPrize,
  type ClaimAirdropPrize,
} from "@features/airdrops/hooks/use-claim-airdrop-prize.ts";
import { DailyPrizeClaimError } from "@features/prize/chain/claim-submission.ts";

const ACCOUNT = "5HumanityId";
const TX_HASH = `0x${"ab".repeat(32)}`;
const EVENT_ID = `0x${"70".repeat(24)}${"1".padStart(16, "0")}` as Hex32;
const SCHEDULED_PRIZE = 1_000_000n;
const AWARDED_PRIZE = 750_000n;
const NOW_SECONDS = 1_800_000_000;

function participation(
  overrides: Partial<AirdropParticipation["draw"]> = {},
): AirdropParticipation {
  return {
    draw: {
      eventId: EVENT_ID,
      drawIndex: 0n,
      status: "Claiming",
      registrationStartsSeconds: NOW_SECONDS - 7200,
      drawTimeSeconds: NOW_SECONDS - 3600,
      endTimeSeconds: NOW_SECONDS + 3600,
      prizeAmount: SCHEDULED_PRIZE,
      assetId: null,
      maxWinners: 1,
      totalParticipants: 1,
      effectiveWinners: 1,
      claimed: 0,
      ...overrides,
    },
    slot: `0x${"cd".repeat(32)}` as Hex32,
    registered: true,
    winner: true,
    claimed: null,
  };
}

type MountedClaim = RenderHookResult<ClaimAirdropPrize, unknown>;

function mountClaim(): MountedClaim {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children);
  return renderHook(() => useClaimAirdropPrize(ACCOUNT), { wrapper });
}

/** Submits the claim and waits for the mutation to leave `pending`. */
async function claimAndSettle(
  mounted: MountedClaim,
  draw: AirdropParticipation = participation(),
): Promise<void> {
  act(() => {
    mounted.result.current.claim(draw);
  });
  await waitFor(() => {
    expect(mounted.result.current.statusFor(draw.draw.eventId).pending).toBe(
      false,
    );
  });
}

const included = (awarded: bigint | null): ClaimAirdropPrizeResult => ({
  status: "included",
  txHash: TX_HASH,
  awarded,
});

beforeEach(() => {
  mocks.recordPrizeWin.mockResolvedValue(undefined);
  mocks.sweepPrizeIntoCoinage.mockResolvedValue({
    status: "sent",
    amount: AWARDED_PRIZE,
  } satisfies PrizeCoinageSweep);
});

afterEach(() => {
  mocks.claimAirdropPrize.mockReset();
  mocks.recordPrizeWin.mockReset();
  mocks.refreshWinnings.mockReset();
  mocks.sweepPrizeIntoCoinage.mockReset();
});

describe("useClaimAirdropPrize", () => {
  it("banks and sweeps the amount the chain actually awarded", async () => {
    mocks.claimAirdropPrize.mockResolvedValue(included(AWARDED_PRIZE));
    const mounted = mountClaim();

    await claimAndSettle(mounted);

    expect(mounted.result.current.statusFor(EVENT_ID).included).toBe(true);
    expect(mocks.recordPrizeWin).toHaveBeenCalledWith({
      accountAddress: ACCOUNT,
      eventId: EVENT_ID,
      amount: AWARDED_PRIZE,
    });
    await waitFor(() => {
      expect(mocks.sweepPrizeIntoCoinage).toHaveBeenCalledTimes(1);
    });
    // The authoritative `PrizeClaimed` amount, not the scheduled prize.
    expect(mocks.sweepPrizeIntoCoinage).toHaveBeenCalledWith(AWARDED_PRIZE);
  });

  it("sweeps the scheduled prize when no PrizeClaimed event was parsed", async () => {
    mocks.claimAirdropPrize.mockResolvedValue(included(null));
    const mounted = mountClaim();

    await claimAndSettle(mounted);

    expect(mocks.recordPrizeWin).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(mocks.sweepPrizeIntoCoinage).toHaveBeenCalledWith(
        SCHEDULED_PRIZE,
      );
    });
  });

  it("keeps the claim successful when the sweep fails", async () => {
    mocks.claimAirdropPrize.mockResolvedValue(included(AWARDED_PRIZE));
    mocks.sweepPrizeIntoCoinage.mockRejectedValue(new Error("no host"));
    const mounted = mountClaim();

    await claimAndSettle(mounted);

    const status = mounted.result.current.statusFor(EVENT_ID);
    expect(status.included).toBe(true);
    expect(status.error).toBeNull();
    expect(mocks.recordPrizeWin).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(mocks.sweepPrizeIntoCoinage).toHaveBeenCalledTimes(1);
    });
  });

  it("does not sweep a prize the claim never won", async () => {
    mocks.claimAirdropPrize.mockRejectedValue(
      new DailyPrizeClaimError("signing", "declined"),
    );
    const mounted = mountClaim();

    await claimAndSettle(mounted);

    expect(mounted.result.current.statusFor(EVENT_ID).error).toBeInstanceOf(
      DailyPrizeClaimError,
    );
    expect(mocks.recordPrizeWin).not.toHaveBeenCalled();
    expect(mocks.sweepPrizeIntoCoinage).not.toHaveBeenCalled();
  });

  it("does not sweep while inclusion is unknown", async () => {
    mocks.claimAirdropPrize.mockResolvedValue({
      status: "unknown",
      txHash: TX_HASH,
    } satisfies ClaimAirdropPrizeResult);
    const mounted = mountClaim();

    await claimAndSettle(mounted);

    expect(mounted.result.current.statusFor(EVENT_ID).unknown).toBe(true);
    expect(mocks.sweepPrizeIntoCoinage).not.toHaveBeenCalled();
  });

  it("skips the sweep when there is nothing to move", async () => {
    mocks.claimAirdropPrize.mockResolvedValue(included(0n));
    const mounted = mountClaim();

    await claimAndSettle(mounted);

    expect(mounted.result.current.statusFor(EVENT_ID).included).toBe(true);
    expect(mocks.sweepPrizeIntoCoinage).not.toHaveBeenCalled();
  });
});
