// @vitest-environment jsdom
// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/** A claim included at best shows on the card before finality; the finalized
 *  card retires the marker; and best-block reconciliation advances, fails or
 *  leaves alone a marker depending on what best holds and how old it is. */
import { createElement, type ReactNode } from "react";
import { QueryClient, QueryClientProvider, useMutation } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ResolvedHumanityCard } from "@humanity/shared/card/humanity-card-data.ts";
import type { HumanityUserId } from "@humanity/shared/identity/humanity-user-id.ts";

const mocks = vi.hoisted(() => ({
  consumers: vi.fn(),
}));

vi.mock("@humanity/shared/chain/client.ts", () => ({
  getPeopleClient: () =>
    Promise.resolve({
      api: { query: { Resources: { Consumers: { getValue: mocks.consumers } } } },
    }),
}));
vi.mock("@features/card/hooks/use-lite-username-upgrade.ts", () => ({
  USERNAME_UPGRADE_MUTATION_KEY: ["card", "username-upgrade"],
}));

import {
  BROADCAST_GRACE_MS,
  reconcileUsernameUpgradeAtBest,
  useFailedUsernameUpgrade,
  usePendingUsernameUpgradeRecord,
  useUsernameUpgradeOverlay,
} from "@features/card/hooks/use-username-upgrade-marker.ts";
import {
  clearFailedUsernameUpgrade,
  clearPendingUsernameUpgrade,
  markPendingUsernameUpgradeIncluded,
  readFailedUsernameUpgrade,
  readPendingUsernameUpgrade,
  recordFailedUsernameUpgrade,
  setPendingUsernameUpgrade,
} from "@features/card/chain/pending-username-upgrade.ts";

const ADDRESS = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
const TX_HASH = `0x${"ab".repeat(32)}`;
const FULL_USERNAME = "alicejones";

const HOST: HumanityUserId = {
  primaryUsername: "alice.42.paseo",
  username: "alice.42",
  isUpgraded: false,
};

const LITE_CARD: ResolvedHumanityCard = {
  kind: "card",
  participantKey: null,
  primaryUsername: "alice.42.paseo",
  accountAddress: ADDRESS,
  ownerAccount: ADDRESS,
  participant: null,
  devicehood: null,
  membershipStanding: null,
  devicehoodRing: null,
  deviceKeyCheck: null,
  state: { kind: "member", activeWeeks: 3, lastAttendedGame: 7, attendanceHistory: 0, window: 8 },
  playerIdentities: { accountAddress: "5AliceGame" },
  snapshot: {
    isLitePerson: true,
    isUpgradedIdentity: false,
    participant: null,
    personhoodThreshold: 7,
    policy: { allowedMisses: 1, window: 2 },
    membershipRing: null,
    devicehoodRing: null,
  },
};

const UPGRADED_CARD: ResolvedHumanityCard = {
  ...LITE_CARD,
  primaryUsername: "alicejones.paseo",
  snapshot: { ...LITE_CARD.snapshot, isUpgradedIdentity: true },
};

const consumerFor = (name: string) => ({ full_username: new TextEncoder().encode(name) });

let client: QueryClient;
const wrapper = ({ children }: { children: ReactNode }) =>
  createElement(QueryClientProvider, { client }, children);

const mountOverlay = (card: ResolvedHumanityCard) =>
  renderHook(
    (props: { card: ResolvedHumanityCard }) => useUsernameUpgradeOverlay(props.card, HOST),
    { wrapper, initialProps: { card } },
  );

/** A claim submitted from this tab that resolved `included`, as the mutation
 *  cache remembers it; the marker it would have written is left out. */
async function claimIncludedInThisTab(expectedLiteAddress = ADDRESS): Promise<void> {
  const submission = renderHook(
    () =>
      useMutation({
        mutationKey: ["card", "username-upgrade"],
        mutationFn: (_args: { expectedLiteAddress: string; fullUsername: string }) =>
          Promise.resolve({ status: "included" as const, txHash: TX_HASH }),
      }),
    { wrapper },
  );
  act(() => submission.result.current.mutate({ expectedLiteAddress, fullUsername: FULL_USERNAME }));
  await waitFor(() => expect(submission.result.current.isSuccess).toBe(true));
}

function setMarker(phase: "broadcast" | "included", broadcastAt = Date.now()): void {
  const now = vi.spyOn(Date, "now").mockReturnValue(broadcastAt);
  setPendingUsernameUpgrade(ADDRESS, FULL_USERNAME, TX_HASH, 10_000);
  now.mockRestore();
  if (phase === "included") markPendingUsernameUpgradeIncluded(ADDRESS, TX_HASH);
}

beforeEach(() => {
  client = new QueryClient();
  mocks.consumers.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  client.clear();
  clearPendingUsernameUpgrade(ADDRESS, TX_HASH);
  clearFailedUsernameUpgrade(ADDRESS);
});

describe("marker hooks", () => {
  it("follow the marker store as it changes", () => {
    const view = renderHook(
      () => ({
        pending: usePendingUsernameUpgradeRecord(ADDRESS),
        failed: useFailedUsernameUpgrade(ADDRESS),
      }),
      { wrapper },
    );
    expect(view.result.current).toEqual({ pending: null, failed: null });

    act(() => setMarker("broadcast"));
    const pending = view.result.current.pending;
    expect(pending).toMatchObject({ txHash: TX_HASH, phase: "broadcast" });
    view.rerender();
    expect(view.result.current.pending).toBe(pending);

    act(() => {
      clearPendingUsernameUpgrade(ADDRESS, TX_HASH);
      recordFailedUsernameUpgrade(ADDRESS, FULL_USERNAME);
    });
    expect(view.result.current).toEqual({
      pending: null,
      failed: { address: ADDRESS, fullUsername: FULL_USERNAME },
    });
  });
});

describe("useUsernameUpgradeOverlay", () => {
  it("shows the full name for a claim included at best, as one stable object", () => {
    setMarker("included");
    mocks.consumers.mockResolvedValue(consumerFor(FULL_USERNAME));

    const view = mountOverlay(LITE_CARD);
    const overlaid = view.result.current;

    expect(overlaid).toMatchObject({
      primaryUsername: "alicejones.paseo",
      snapshot: { isUpgradedIdentity: true },
    });
    expect(LITE_CARD.snapshot.isUpgradedIdentity).toBe(false);
    view.rerender({ card: LITE_CARD });
    expect(view.result.current).toBe(overlaid);
  });

  it("leaves the card alone while the claim is only broadcast", () => {
    setMarker("broadcast");

    expect(mountOverlay(LITE_CARD).result.current).toBe(LITE_CARD);
  });

  it("starts showing the name the moment the marker is marked included", () => {
    setMarker("broadcast");
    const view = mountOverlay(LITE_CARD);

    act(() => markPendingUsernameUpgradeIncluded(ADDRESS, TX_HASH));

    expect(view.result.current).toMatchObject({ primaryUsername: "alicejones.paseo" });
  });

  it("retires the marker and the failed notice once the finalized card is upgraded", async () => {
    setMarker("included");
    recordFailedUsernameUpgrade(ADDRESS, "otherclaim");

    const view = mountOverlay(UPGRADED_CARD);

    expect(view.result.current).toBe(UPGRADED_CARD);
    await waitFor(() => expect(readPendingUsernameUpgrade(ADDRESS)).toBeNull());
    expect(readFailedUsernameUpgrade(ADDRESS)).toBeNull();
    expect(mocks.consumers).not.toHaveBeenCalled();
  });

  it("marks a broadcast claim included once best holds it", async () => {
    setMarker("broadcast");
    mocks.consumers.mockResolvedValue(consumerFor(FULL_USERNAME));

    const view = mountOverlay(LITE_CARD);

    await waitFor(() =>
      expect(view.result.current).toMatchObject({ primaryUsername: "alicejones.paseo" }),
    );
    expect(mocks.consumers).toHaveBeenCalledWith(ADDRESS, { at: "best" });
    expect(readPendingUsernameUpgrade(ADDRESS)?.phase).toBe("included");
  });

  it("does not reconcile while a claim is still being submitted", async () => {
    setMarker("included");
    const submission = renderHook(
      () =>
        useMutation({
          mutationKey: ["card", "username-upgrade"],
          mutationFn: () => Promise.withResolvers<never>().promise,
        }),
      { wrapper },
    );
    act(() => submission.result.current.mutate());
    await waitFor(() => expect(submission.result.current.isPending).toBe(true));

    mountOverlay(LITE_CARD);
    const { promise: settled, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 20);
    await settled;

    expect(mocks.consumers).not.toHaveBeenCalled();
    expect(readPendingUsernameUpgrade(ADDRESS)?.phase).toBe("included");
  });

  it("wears the name this tab's own claim saw included, with no marker left", async () => {
    await claimIncludedInThisTab();

    const view = mountOverlay(LITE_CARD);
    await waitFor(() => {
      const card = view.result.current;
      expect(card?.kind === "card" && card.primaryUsername).toBe("alicejones.paseo");
    });
    const card = view.result.current;
    expect(card?.kind === "card" && card.snapshot.isUpgradedIdentity).toBe(true);
  });

  it("ignores this tab's included claim for another account", async () => {
    await claimIncludedInThisTab("5OtherAccount");

    const view = mountOverlay(LITE_CARD);
    expect(view.result.current).toBe(LITE_CARD);
  });

  it("gives the name back once the claim is recorded failed", async () => {
    await claimIncludedInThisTab();
    const view = mountOverlay(LITE_CARD);
    await waitFor(() => {
      const card = view.result.current;
      expect(card?.kind === "card" && card.primaryUsername).toBe("alicejones.paseo");
    });

    act(() => recordFailedUsernameUpgrade(ADDRESS, FULL_USERNAME));

    expect(view.result.current).toBe(LITE_CARD);
  });

  it("hands over to the finalized card once it reports the upgrade", async () => {
    await claimIncludedInThisTab();
    const view = mountOverlay(LITE_CARD);

    view.rerender({ card: UPGRADED_CARD });

    expect(view.result.current).toBe(UPGRADED_CARD);
  });
});

describe("reconcileUsernameUpgradeAtBest", () => {
  it("keeps an included claim that best momentarily lacks", async () => {
    setMarker("included", Date.now() - BROADCAST_GRACE_MS - 1);

    await expect(
      reconcileUsernameUpgradeAtBest(ADDRESS, TX_HASH, FULL_USERNAME, HOST),
    ).resolves.toBe("absent");

    expect(readPendingUsernameUpgrade(ADDRESS)?.phase).toBe("included");
    expect(readFailedUsernameUpgrade(ADDRESS)).toBeNull();
  });

  it("gives a young broadcast time to land", async () => {
    setMarker("broadcast");

    await expect(
      reconcileUsernameUpgradeAtBest(ADDRESS, TX_HASH, FULL_USERNAME, HOST),
    ).resolves.toBe("absent");

    expect(readPendingUsernameUpgrade(ADDRESS)?.phase).toBe("broadcast");
    expect(readFailedUsernameUpgrade(ADDRESS)).toBeNull();
  });

  it("fails a broadcast that best still lacks after the grace period", async () => {
    setMarker("broadcast", Date.now() - BROADCAST_GRACE_MS - 1);

    await reconcileUsernameUpgradeAtBest(ADDRESS, TX_HASH, FULL_USERNAME, HOST);

    expect(readPendingUsernameUpgrade(ADDRESS)).toBeNull();
    expect(readFailedUsernameUpgrade(ADDRESS)?.fullUsername).toBe(FULL_USERNAME);
  });

  it("fails even an included claim when the account carries another full name", async () => {
    setMarker("included");
    mocks.consumers.mockResolvedValue(consumerFor("someoneelse"));

    await expect(
      reconcileUsernameUpgradeAtBest(ADDRESS, TX_HASH, FULL_USERNAME, HOST),
    ).resolves.toBe("absent");
    expect(readPendingUsernameUpgrade(ADDRESS)).toBeNull();
    expect(readFailedUsernameUpgrade(ADDRESS)?.fullUsername).toBe(FULL_USERNAME);
  });

  it("never acts on a marker replaced while the read was in flight", async () => {
    setMarker("included");
    mocks.consumers.mockImplementation(() => {
      clearPendingUsernameUpgrade(ADDRESS, TX_HASH);
      return Promise.resolve(undefined);
    });

    await reconcileUsernameUpgradeAtBest(ADDRESS, TX_HASH, FULL_USERNAME, HOST);

    expect(readFailedUsernameUpgrade(ADDRESS)).toBeNull();
  });
});
