// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later
// @vitest-environment jsdom
//
// Live scratch-off screen: the claim submitted on opening, the retry CTA, surface routing, and
// claim-failure surfacing.

import { createElement } from "react";
import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { __resetAutoClaimForTests } from "@features/airdrops/hooks/use-auto-claim-draws.ts";
import { DailyPrizeClaimError } from "@features/prize/chain/claim-submission.ts";
import { LiveDailyScreen } from "@features/prize/components/LiveDailyScreen.tsx";
import type { LiveSurface } from "@features/prize/domain/live-prize-surface.ts";
import type {
  AirdropParticipation,
  AirdropStanding,
  DailyDollarRegistry,
  Hex32,
} from "@individuality/daily-dollar";
import {
  applyRegistrationSubmitted,
  emptyRegistry,
} from "@humanity/shared/airdrops/domain/daily-dollar-registry.ts";

import {
  EVENT_ID,
  FIXED_NOW_SECONDS,
  makeWin,
  standingFor,
  winSurface,
  type ClaimHook,
  type ClaimStatus,
} from "./live-daily-screen.fixtures.ts";

const mocks = vi.hoisted(() => ({
  logger: { error: vi.fn() },
  claimStatus: { pending: false, unknown: false, included: false } as ClaimStatus,
  claimCalls: [] as AirdropParticipation[],
  statusEventIds: [] as string[],
  screenClaim: null as
    | { pending: boolean; unknown: boolean; claimed: boolean; onClaim: () => void }
    | null,
  screenRevealed: false,
  screenOnRevealed: null as (() => void) | null,
  emptyStateMessage: null as string | null,
  dailyPrizeScreenRendered: false,
  scratch: false,
  settled: false,
  winnings: 0n,
  pendingClaim: false,
  recordDailyScratch: vi.fn(() => Promise.resolve()),
  updateDailyDollarRegistry: vi.fn(
    (
      _accountAddress: string,
      _update: (registry: DailyDollarRegistry) => DailyDollarRegistry,
    ) => Promise.resolve(),
  ),
}));

vi.mock("@features/airdrops/hooks/use-claim-airdrop-prize.ts", () => ({
  useClaimAirdropPrize: (): ClaimHook => ({
    claim: (participation: AirdropParticipation) => {
      mocks.claimCalls.push(participation);
    },
    statusFor: (eventId: string) => {
      mocks.statusEventIds.push(eventId);
      return mocks.claimStatus;
    },
  }),
}));
vi.mock("@features/prize/chain/pending-daily-claim.ts", () => ({
  hasPendingDailyClaim: () => mocks.pendingClaim,
}));
vi.mock("@features/prize/chain/daily-scratch-log.ts", () => ({
  recordDailyScratch: mocks.recordDailyScratch,
}));
vi.mock("@humanity/shared/airdrops/storage/daily-dollar-registry-store.ts", () => ({
  updateDailyDollarRegistry: mocks.updateDailyDollarRegistry,
}));
vi.mock("@features/prize/hooks/use-daily-scratch.ts", () => ({
  useDailyPrizeScratchState: () => ({ scratched: mocks.scratch, isPending: false }),
  useRefreshDailyScratch: () => vi.fn(),
}));
vi.mock("@features/prize/hooks/use-prize-winnings.ts", () => ({
  useDailyPrizeSettlementState: () => ({ settled: mocks.settled, isPending: false }),
  usePrizeWinnings: () => mocks.winnings,
}));
vi.mock("@features/prize/components/DailyPrizeScreen.tsx", () => ({
  DailyPrizeScreen: ({ claim, revealed, onRevealed }: { claim?: { pending: boolean; unknown: boolean; claimed: boolean; onClaim: () => void }; revealed?: boolean; onRevealed?: () => void }) => {
    mocks.screenClaim = claim ?? null;
    mocks.screenRevealed = revealed ?? false;
    mocks.screenOnRevealed = onRevealed ?? null;
    mocks.dailyPrizeScreenRendered = true;
    return null;
  },
}));
vi.mock("@features/prize/components/LivePrizeEmptyState.tsx", () => ({
  LivePrizeEmptyState: ({ message }: { message: string }) => {
    mocks.emptyStateMessage = message;
    return null;
  },
}));
vi.mock("@humanity/shared/logging/logger.ts", () => ({ loggerFor: () => mocks.logger }));
vi.mock("@humanity/shared/domain/prize-money.ts", () => ({ formatPrizeDollars: () => "$1" }));

beforeEach(() => {
  // Pin wall-clock to a moment inside the claim window of every fixture.
  vi.spyOn(Date, "now").mockReturnValue(FIXED_NOW_SECONDS * 1000);
});

afterEach(() => {
  __resetAutoClaimForTests();
  mocks.logger.error.mockClear();
  mocks.claimStatus = { pending: false, unknown: false, included: false };
  mocks.claimCalls = [];
  mocks.statusEventIds = [];
  mocks.screenClaim = null;
  mocks.screenRevealed = false;
  mocks.screenOnRevealed = null;
  mocks.emptyStateMessage = null;
  mocks.dailyPrizeScreenRendered = false;
  mocks.scratch = false;
  mocks.settled = false;
  mocks.winnings = 0n;
  mocks.pendingClaim = false;
  mocks.recordDailyScratch.mockClear();
  mocks.updateDailyDollarRegistry.mockClear();
  vi.restoreAllMocks();
});

interface RenderHandle {
  rerender: (next: { surface: LiveSurface; standing: AirdropStanding | undefined }) => void;
  unmount: () => void;
}

/** Render through a real DOM mount so the child claim callback can be read. */
function renderMounted(
  initial: { surface: LiveSurface; standing: AirdropStanding | undefined },
): RenderHandle {
  const handle = render(
    createElement(LiveDailyScreen, {
      standing: initial.standing,
      surface: initial.surface,
      accountAddress: "5HumanityId",
      onBack: vi.fn(),
    }),
  );
  return {
    rerender: (next) => {
      act(() => {
        handle.rerender(
          createElement(LiveDailyScreen, {
            standing: next.standing,
            surface: next.surface,
            accountAddress: "5HumanityId",
            onBack: vi.fn(),
          }),
        );
      });
    },
    unmount: () => handle.unmount(),
  };
}

describe("LiveDailyScreen empty surface", () => {
  const SENTINEL_MESSAGE = "No scratch available right now." as const;

  it("renders LivePrizeEmptyState with the surface message and does not render DailyPrizeScreen", () => {
    renderMounted({
      surface: { kind: "empty", message: SENTINEL_MESSAGE },
      standing: standingFor([]),
    });

    expect(mocks.emptyStateMessage).toBe(SENTINEL_MESSAGE);
    expect(mocks.dailyPrizeScreenRendered).toBe(false);
  });
});

describe("LiveDailyScreen claim failure surfacing", () => {
  it("never forwards a claim error to the rendered screen", () => {
    renderMounted({ surface: winSurface(), standing: standingFor([makeWin()]) });

    expect(mocks.screenClaim).not.toBeNull();
    expect(mocks.screenClaim).toMatchObject({
      pending: false,
      unknown: false,
      claimed: false,
    });
    expect(mocks.logger.error).not.toHaveBeenCalled();
  });

  it("keeps `DailyPrizeClaimError` importable through the chain layer (smoke)", () => {
    expect(new DailyPrizeClaimError("signing", "x")).toBeInstanceOf(DailyPrizeClaimError);
  });
});

describe("LiveDailyScreen claim CTA contract", () => {
  it("submits the claim when the screen opens on a won draw; the CTA only retries it", () => {
    renderMounted({
      surface: winSurface(),
      standing: standingFor([makeWin()]),
    });

    expect(mocks.claimCalls.length).toBe(1);
    expect(mocks.claimCalls[0]?.draw.eventId).toBe(EVENT_ID);
    mocks.screenClaim?.onClaim();
    expect(mocks.claimCalls.length).toBe(2);
    expect(mocks.claimCalls[1]?.draw.eventId).toBe(EVENT_ID);
  });

  it("does not resubmit when the same draw's screen is opened again", () => {
    renderMounted({ surface: winSurface(), standing: standingFor([makeWin()]) }).unmount();
    renderMounted({ surface: winSurface(), standing: standingFor([makeWin()]) });

    expect(mocks.claimCalls.length).toBe(1);
  });

  it("does not claim merely because standing refetches with a fresh object identity", () => {
    const handle = renderMounted({
      surface: winSurface(),
      standing: standingFor([makeWin()]),
    });
    // The standing query refetches every 12 s and yields a fresh array +
    // fresh participation object even when the payload is the same draw.
    // A submission whose effect depends on the standing object would
    // resubmit every refetch; the once-guard must be keyed by event id.
    handle.rerender({
      surface: winSurface(),
      standing: standingFor([makeWin()]),
    });

    expect(mocks.claimCalls.length).toBe(1);
  });

  it("keeps the ticket event id after a successful claim removes the winner entry", () => {
    mocks.claimStatus = { pending: false, unknown: false, included: true };
    const claimed: AirdropParticipation = {
      ...makeWin(),
      winner: false,
      claimed: true,
    };

    renderMounted({
      surface: winSurface(),
      standing: standingFor([claimed]),
    });

    expect(mocks.statusEventIds).toContain(EVENT_ID);
    expect(mocks.screenClaim).toMatchObject({ claimed: true });
    expect(mocks.claimCalls.length).toBe(0);
  });

  it("keeps the foil on a win the claim banked before the card was scratched", () => {
    mocks.settled = true;
    mocks.scratch = false;

    renderMounted({
      surface: winSurface(),
      standing: standingFor([{ ...makeWin(), winner: false, claimed: true }]),
    });

    expect(mocks.dailyPrizeScreenRendered).toBe(true);
    expect(mocks.screenRevealed).toBe(false);
    expect(mocks.screenClaim).toMatchObject({ claimed: true });
  });

  it("restores a scratched, settled win as already revealed after a reload", () => {
    mocks.settled = true;
    mocks.scratch = true;

    renderMounted({
      surface: winSurface(),
      standing: standingFor([{ ...makeWin(), winner: false, claimed: true }]),
    });

    expect(mocks.dailyPrizeScreenRendered).toBe(true);
    expect(mocks.screenRevealed).toBe(true);
    expect(mocks.screenClaim).toMatchObject({ claimed: true });
  });

  it("keeps the foil on a card opened unscratched even if the claim banks mid-scratch", () => {
    mocks.settled = false;
    mocks.scratch = false;
    const handle = renderMounted({
      surface: winSurface(),
      standing: standingFor([makeWin()]),
    });
    expect(mocks.screenRevealed).toBe(false);

    mocks.settled = true;
    handle.rerender({
      surface: winSurface(),
      standing: standingFor([{ ...makeWin(), winner: false, claimed: true }]),
    });

    expect(mocks.screenRevealed).toBe(false);
    expect(mocks.screenClaim).toMatchObject({ claimed: true });
  });

  it("does not fire a claim when the surface is a miss", () => {
    const miss: AirdropParticipation = { ...makeWin(), winner: false };
    renderMounted({
      surface: { ...winSurface(), outcome: "miss" },
      standing: standingFor([miss]),
    });

    expect(mocks.claimCalls.length).toBe(0);
  });

  it("does not fire a claim when the standing has no participations", () => {
    renderMounted({
      surface: winSurface(),
      standing: standingFor([]),
    });

    // No claim should be fired on mount, and any later reveal through the
    // rendered CTA must also be a no-op — there is no participation to
    // submit. The screen still mounts (the surface says "win") so the
    // user can see the result; only the claim side is dormant.
    expect(mocks.claimCalls.length).toBe(0);
    expect(mocks.screenClaim).not.toBeNull();
    mocks.screenClaim?.onClaim();
    expect(mocks.claimCalls.length).toBe(0);
  });

  it("does not fire a claim when the winner status is not determinable (winner === null)", () => {
    const unknown: AirdropParticipation = { ...makeWin(), winner: null };
    renderMounted({
      surface: winSurface(),
      standing: standingFor([unknown]),
    });

    expect(mocks.claimCalls.length).toBe(0);
  });

  it("does not fire a claim when the Claiming window has already elapsed", () => {
    const elapsed: AirdropParticipation = {
      ...makeWin(),
      draw: {
        ...makeWin().draw,
        endTimeSeconds: FIXED_NOW_SECONDS - 1,
      },
    };
    renderMounted({
      surface: winSurface(),
      standing: standingFor([elapsed]),
    });

    expect(mocks.claimCalls.length).toBe(0);
  });

  it("does not fire a claim when an earlier broadcast is already pending for the same draw", () => {
    mocks.pendingClaim = true;
    renderMounted({
      surface: winSurface(),
      standing: standingFor([makeWin()]),
    });

    expect(mocks.claimCalls.length).toBe(0);
  });

  it("claims a different draw when its screen opens — the guard is per-draw, not a permanent latch", () => {
    const SECOND_EVENT_ID: Hex32 = `0x${"2".repeat(64)}` as const;
    const secondWin: AirdropParticipation = {
      ...makeWin(),
      draw: { ...makeWin().draw, eventId: SECOND_EVENT_ID },
    };
    renderMounted({
      surface: winSurface(),
      standing: standingFor([makeWin()]),
    }).unmount();
    expect(mocks.claimCalls.length).toBe(1);
    expect(mocks.claimCalls[0]?.draw.eventId).toBe(EVENT_ID);

    renderMounted({
      surface: { ...winSurface(), eventId: SECOND_EVENT_ID },
      standing: standingFor([secondWin]),
    });

    expect(mocks.claimCalls.length).toBe(2);
    expect(mocks.claimCalls[1]?.draw.eventId).toBe(SECOND_EVENT_ID);
  });
});

describe("LiveDailyScreen scratch marker", () => {
  /** The airdrop subaccount the registry is keyed by — deliberately not the
   *  human identity account the screen takes as a prop. */
  const AIRDROP_ACCOUNT = "5AirdropSubaccount";

  const revealWith = (standing: AirdropStanding): void => {
    renderMounted({ surface: winSurface(), standing });
    act(() => {
      mocks.screenOnRevealed?.();
    });
  };

  it("marks the draw scratched in the registry of the airdrop subaccount", () => {
    revealWith({ ...standingFor([makeWin()]), accountAddress: AIRDROP_ACCOUNT });

    expect(mocks.recordDailyScratch).toHaveBeenCalledWith("5HumanityId", EVENT_ID);
    const call = mocks.updateDailyDollarRegistry.mock.calls[0];
    // The registry lives under the subaccount that signs the claim, not the
    // identity account the winnings ledger is keyed by.
    expect(call?.[0]).toBe(AIRDROP_ACCOUNT);

    const held = applyRegistrationSubmitted(
      emptyRegistry(AIRDROP_ACCOUNT),
      [EVENT_ID],
      "app",
      FIXED_NOW_SECONDS,
    );

    expect(call?.[1]?.(held).draws[EVENT_ID]?.scratchedAtSeconds).toBe(
      FIXED_NOW_SECONDS,
    );
  });

  it("writes nothing when the standing carries no airdrop account", () => {
    // No account means no registry to key the marker by; the local scratch
    // ledger still records the reveal, so the card stays consumed.
    revealWith(standingFor([makeWin()]));

    expect(mocks.recordDailyScratch).toHaveBeenCalledTimes(1);
    expect(mocks.updateDailyDollarRegistry).not.toHaveBeenCalled();
    expect(mocks.logger.error).not.toHaveBeenCalled();
  });
});
