// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later
// @vitest-environment jsdom

/** The home never opens the daily screen on its own: the person taps into
 *  it, and the claim is submitted by that screen and nowhere else. The real
 *  page, data assembly, router, session and auto-open run here; only the
 *  chain reads, the host ledgers and the presentation leaves are mocked. */
import { createElement, useSyncExternalStore } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render } from "@testing-library/react";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  AirdropParticipation,
  AirdropStanding,
} from "@individuality/daily-dollar";

import {
  EVENT_ID,
  FIXED_NOW_SECONDS,
  makeWin,
  standingFor,
} from "../components/live-daily-screen.fixtures.ts";

const ACCOUNT = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";

const mocks = vi.hoisted(() => {
  let standing: AirdropStanding | undefined;
  const listeners = new Set<() => void>();
  return {
    standingStore: {
      get: () => standing,
      set: (next: AirdropStanding | undefined) => {
        standing = next;
        for (const listener of listeners) listener();
      },
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    username: "marlow",
    promotion: null as { from: unknown; to: unknown } | null,
    claimCalls: [] as AirdropParticipation[],
    cardReady: true,
    dailyMounts: 0,
  };
});

vi.mock("@features/card/hooks/use-card-ready.ts", () => ({
  useCardReady: () => ({ sessionId: 1, ready: mocks.cardReady }),
}));
vi.mock("@features/card/hooks/use-humanity-card.ts", () => ({
  useHumanityCard: () => ({
    data: {
      kind: "card",
      accountAddress: ACCOUNT,
      primaryUsername: mocks.username,
      state: { kind: "member", activeWeeks: 3, lastAttendedGame: 42, attendanceHistory: 0xff, window: 8 },
      snapshot: { isUpgradedIdentity: false, participant: { recognition: "NotRecognized" } },
    },
    isPending: false,
    error: null,
  }),
}));
vi.mock("@features/debug/use-debug-card-override.ts", () => ({
  useDebugCardOverride: <T,>(query: T) => query,
}));
vi.mock("@features/debug/debug-store.ts", () => {
  const state = { prize: { outcome: null }, settlePrize: () => undefined };
  return {
    usePublishDebugInput: () => undefined,
    useDebugStore: <T,>(select: (current: typeof state) => T) => select(state),
  };
});
vi.mock("@features/card/hooks/use-current-game.ts", () => ({
  useCurrentGame: () => ({ data: undefined, isPending: false, error: null }),
}));
vi.mock("@features/airdrops/hooks/use-airdrop-standing.ts", () => ({
  AIRDROP_STANDING_QUERY_KEY: ["chain", "airdrop-standing"],
  useAirdropStanding: () => ({
    data: useSyncExternalStore(mocks.standingStore.subscribe, mocks.standingStore.get),
    isPending: false,
    error: null,
  }),
}));
vi.mock("@features/airdrops/hooks/use-auto-register-draws.ts", () => ({
  useAutoRegisterDraws: () => ({}),
}));
vi.mock("@features/prize/hooks/use-daily-scratch.ts", () => ({
  useDailyPrizeScratchState: () => ({ scratched: false, isPending: false }),
  useRefreshDailyScratch: () => () => undefined,
}));
vi.mock("@features/prize/hooks/use-prize-winnings.ts", () => ({
  useDailyPrizeSettlementState: () => ({ settled: false, isPending: false }),
}));
vi.mock("@features/airdrops/hooks/use-claim-airdrop-prize.ts", () => ({
  useClaimAirdropPrize: () => ({
    claim: (participation: AirdropParticipation) => {
      mocks.claimCalls.push(participation);
    },
    statusFor: () => ({ pending: false, included: false, unknown: false, error: null, txHash: null }),
  }),
}));
vi.mock("@features/prize/chain/pending-daily-claim.ts", () => ({
  hasPendingDailyClaim: () => false,
}));
vi.mock("@features/prize/chain/daily-scratch-log.ts", () => ({
  recordDailyScratch: () => Promise.resolve(),
}));
vi.mock("@humanity/shared/airdrops/storage/daily-dollar-registry-store.ts", () => ({
  updateDailyDollarRegistry: () => Promise.resolve(),
}));
vi.mock("@features/card/hooks/use-card-promotion.ts", () => ({
  useCardPromotion: () => ({ promotion: mocks.promotion, dismiss: () => undefined }),
}));
vi.mock("@features/prize/components/PrizeLiveHomeBlock.tsx", () => ({
  PrizeLiveHomeBlock: () => null,
}));
vi.mock("@features/prize/components/DailyPrizeScreen.tsx", async () => {
  const { useEffect } = await import("react");
  return {
    DailyPrizeScreen: () => {
      useEffect(() => {
        mocks.dailyMounts += 1;
      }, []);
      return null;
    },
  };
});

import { __resetAutoClaimForTests } from "@features/airdrops/hooks/use-auto-claim-draws.ts";
import { PrizePage } from "@features/prize/pages/PrizePage.tsx";
import { HumanityActionSessionProvider } from "@shared/navigation/humanity-action-session.tsx";
import { __resetOpenScratchIntentForTests } from "@shared/navigation/open-scratch-intent.ts";

/** A draw past registration whose winners are not drawn yet: no ticket. */
function drawing(): AirdropParticipation {
  const win = makeWin();
  return { ...win, winner: null, draw: { ...win.draw, status: "DrawWinners" } };
}

function mount() {
  const root = createRootRoute();
  const home = createRoute({
    getParentRoute: () => root,
    path: "/",
    component: () => createElement(PrizePage, { routeScreen: "home" }),
  });
  const scratch = createRoute({
    getParentRoute: () => root,
    path: "/scratch",
    component: () => createElement(PrizePage, { routeScreen: "daily" }),
  });
  const claim = createRoute({ getParentRoute: () => root, path: "/claim-username", component: () => null });
  const history = createMemoryHistory({ initialEntries: ["/"] });
  const router = createRouter({ routeTree: root.addChildren([home, scratch, claim]), history });
  render(
    createElement(
      QueryClientProvider,
      { client: new QueryClient() },
      createElement(HumanityActionSessionProvider, null, createElement(RouterProvider, { router })),
    ),
  );
  const tapDaily = async (): Promise<void> => {
    await act(async () => {
      await router.navigate({ to: "/scratch", search: { demo: undefined }, state: { fromHome: true } });
    });
  };
  return { router, tapDaily };
}

async function settle(): Promise<void> {
  await act(async () => {
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 50);
    await promise;
  });
}

beforeAll(() => {
  window.scrollTo = () => undefined;
});

beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(FIXED_NOW_SECONDS * 1000);
  const items = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => items.set(key, value),
  });
});

afterEach(() => {
  cleanup();
  __resetAutoClaimForTests();
  mocks.standingStore.set(undefined);
  mocks.username = "marlow";
  mocks.promotion = null;
  mocks.claimCalls = [];
  mocks.cardReady = true;
  mocks.dailyMounts = 0;
  window.history.replaceState(null, "", "/");
  __resetOpenScratchIntentForTests();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("PrizePage daily screen opening", () => {
  it("stays on the home when a ticket appears, and claims only once the screen is opened", async () => {
    mocks.standingStore.set(standingFor([drawing()]));
    const { router, tapDaily } = mount();
    await act(async () => {
      await router.load();
    });
    await settle();

    act(() => {
      mocks.standingStore.set(standingFor([makeWin()]));
    });
    await settle();
    expect(router.state.location.pathname).toBe("/");
    expect(mocks.claimCalls).toHaveLength(0);

    await tapDaily();
    await vi.waitFor(() => expect(mocks.claimCalls).toHaveLength(1));
    expect(mocks.claimCalls[0]?.draw.eventId).toBe(EVENT_ID);
  });

  it("stays on the home for a ticket waiting at launch or after a foreground refresh", async () => {
    mocks.standingStore.set(standingFor([makeWin()]));
    const { router } = mount();
    await act(async () => {
      await router.load();
    });
    await settle();
    expect(router.state.location.pathname).toBe("/");

    act(() => {
      window.dispatchEvent(new Event("pageshow"));
    });
    await settle();
    expect(router.state.location.pathname).toBe("/");
    expect(mocks.claimCalls).toHaveLength(0);
  });

  it("opens the username claim, not the daily screen, when both are on offer", async () => {
    mocks.username = "marlow.42";
    mocks.standingStore.set(standingFor([makeWin()]));
    const { router } = mount();
    await act(async () => {
      await router.load();
    });
    await vi.waitFor(() => expect(router.state.location.pathname).toBe("/claim-username"));
    expect(mocks.claimCalls).toHaveLength(0);
  });

  it("keeps the daily screen up when a new session starts, and holds only the home", async () => {
    mocks.standingStore.set(standingFor([makeWin()]));
    const { router, tapDaily } = mount();
    await act(async () => {
      await router.load();
    });
    await settle();
    await tapDaily();
    await vi.waitFor(() => expect(mocks.dailyMounts).toBe(1));

    // Coming back into view: this session's card read has not landed yet.
    act(() => {
      mocks.cardReady = false;
      mocks.standingStore.set(standingFor([makeWin()]));
    });
    await settle();
    expect(mocks.dailyMounts).toBe(1);
    expect(document.querySelector('[role="status"]')).toBeNull();

    await act(async () => {
      await router.navigate({ to: "/" });
    });
    await settle();
    expect(document.querySelector('[role="status"]')).not.toBeNull();
  });

  describe("from the scratch link (open=scratch)", () => {
    function loadFromScratchLink(): void {
      window.history.replaceState(null, "", "/?card=humanity&open=scratch");
      __resetOpenScratchIntentForTests();
    }

    it("opens the daily screen for a ticket waiting to be scratched", async () => {
      loadFromScratchLink();
      mocks.standingStore.set(standingFor([makeWin()]));
      const { router } = mount();
      await act(async () => {
        await router.load();
      });
      await vi.waitFor(() => expect(router.state.location.pathname).toBe("/scratch"));
      expect(window.location.search).toBe("?card=humanity");
    });

    it("stays on the home when there is no ticket to scratch", async () => {
      loadFromScratchLink();
      mocks.standingStore.set(standingFor([drawing()]));
      const { router } = mount();
      await act(async () => {
        await router.load();
      });
      await settle();
      expect(router.state.location.pathname).toBe("/");
    });

    it("opens the scratch first when the username claim is also on offer", async () => {
      loadFromScratchLink();
      mocks.username = "marlow.42";
      mocks.standingStore.set(standingFor([makeWin()]));
      const { router } = mount();
      await act(async () => {
        await router.load();
      });
      await vi.waitFor(() => expect(router.state.location.pathname).toBe("/scratch"));
    });
  });
});
