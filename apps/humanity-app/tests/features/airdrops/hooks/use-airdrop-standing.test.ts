// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// @vitest-environment jsdom
// This suite mounts a React hook, so it needs a DOM; the project default is
// `environment: "node"` (see vite.config.ts). Do not remove.

import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

import { buildDrawEventId } from "@humanity/shared/airdrops/chain/draw-event-id.ts";
import type * as individualityModule from "@humanity/shared/chain/individuality.ts";
import {
  useAirdropStanding,
  AIRDROP_STANDING_QUERY_KEY,
} from "@features/airdrops/hooks/use-airdrop-standing.ts";

type AirdropQuery = {
  queryKey: readonly unknown[];
  enabled?: boolean;
  queryFn: (context: { signal: AbortSignal }) => Promise<unknown>;
};

const mocks = vi.hoisted(() => ({
  queries: [] as AirdropQuery[],
  getPeopleClient: vi.fn(),
  resolveAirdropAccount: vi.fn(),
  readPeopleAirdropsStanding: vi.fn(),
  invalidateQueries: vi.fn(),
}));

// React is deliberately NOT mocked. `useAirdropStanding` gates its query
// behind `usePrizeAccountAddress`, a real `useState` + `useEffect` pair; a
// stubbed `useState` with a no-op setter disables the very gate under test and
// would keep these assertions passing even if the gate were deleted.
vi.mock("@tanstack/react-query", () => ({
  useQuery: (query: AirdropQuery) => {
    mocks.queries.push(query);
    return { data: undefined, error: null, isPending: false };
  },
  useQueryClient: () => ({ invalidateQueries: mocks.invalidateQueries }),
}));

vi.mock("@humanity/shared/chain/bounded-read.ts", () => ({
  runBoundedChainRead: (
    _signal: AbortSignal,
    read: (signal: AbortSignal & { throwIfAborted: () => void }) => Promise<unknown>,
  ) =>
    read(
      Object.assign(new AbortController().signal, {
        throwIfAborted: () => undefined,
      }),
    ),
}));

vi.mock("@humanity/shared/chain/client.ts", () => ({ getPeopleClient: mocks.getPeopleClient }));
vi.mock("@humanity/shared/airdrops/chain/airdrop-account.ts", () => ({
  resolveAirdropAccount: mocks.resolveAirdropAccount,
}));

// The SDK's read has its own tests against a fake chain; here it is the seam,
// so these assert what the hook asks for and how the answer is folded.
vi.mock("@humanity/shared/chain/individuality.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof individualityModule>();
  return { ...actual, readPeopleAirdropsStanding: mocks.readPeopleAirdropsStanding };
});

const ALIAS = `0x${"aa".repeat(32)}` as `0x${string}`;
const AIRDROPS_CONTEXT = `0x${"bb".repeat(32)}` as `0x${string}`;
const OTHER_CONTEXT = `0x${"cc".repeat(32)}` as `0x${string}`;
const BLOCK_HASH = `0x${"04".repeat(32)}` as `0x${string}`;
const NEXT_BLOCK_HASH = `0x${"05".repeat(32)}` as `0x${string}`;
const ADDRESS = "5PrizeAccountAddress";

type HeadObserver = (blocks: { hash: string }[]) => void;

interface FakeChain {
  client: {
    getBestBlocks: Mock;
    bestBlocks$: { subscribe: Mock };
  };
  api: { marker: string };
  emitHead: (hash: string) => void;
  unsubscribe: Mock;
}

function makeChainClient(): FakeChain {
  let next: HeadObserver | undefined;
  const unsubscribe = vi.fn();
  return {
    client: {
      getBestBlocks: vi.fn().mockResolvedValue([{ hash: BLOCK_HASH }]),
      bestBlocks$: {
        subscribe: vi.fn((observer: HeadObserver) => {
          next = observer;
          return { unsubscribe };
        }),
      },
    },
    api: { marker: "people-api" },
    emitHead: (hash) => next?.([{ hash }]),
    unsubscribe,
  };
}

const latestQuery = (): AirdropQuery => {
  const query = mocks.queries.at(-1);
  if (query == null) throw new Error("airdrop standing query was not created");
  return query;
};

/**
 * Mount the hook and wait for `usePrizeAccountAddress` to land, so the query
 * that `latestQuery()` returns is the enabled one rather than the pre-account
 * placeholder from the first render.
 */
async function mountWithAccount(): Promise<void> {
  renderHook(() => useAirdropStanding(true));
  await waitFor(() => {
    expect(latestQuery().enabled).toBe(true);
  });
}

afterEach(() => {
  mocks.queries.length = 0;
  vi.resetAllMocks();
});

describe("useAirdropStanding", () => {
  it("exports the literal query-key prefix", () => {
    expect(AIRDROP_STANDING_QUERY_KEY).toEqual(["chain", "airdrop-standing"]);
  });

  it("disables the chain query until a product account resolves", async () => {
    mocks.resolveAirdropAccount.mockResolvedValue(null);
    mocks.getPeopleClient.mockResolvedValue(makeChainClient());

    renderHook(() => useAirdropStanding(true));

    await waitFor(() => {
      expect(mocks.resolveAirdropAccount).toHaveBeenCalled();
    });
    expect(latestQuery().enabled).toBe(false);
    expect(latestQuery().queryKey).toEqual([
      ...AIRDROP_STANDING_QUERY_KEY,
      "no-account",
    ]);
    expect(mocks.getPeopleClient).not.toHaveBeenCalled();
  });

  it("keys the query by the resolved account so a switch invalidates the cache", async () => {
    mocks.resolveAirdropAccount.mockResolvedValue({ address: ADDRESS });
    mocks.getPeopleClient.mockResolvedValue(makeChainClient());

    await mountWithAccount();

    expect(latestQuery().queryKey).toEqual([
      ...AIRDROP_STANDING_QUERY_KEY,
      ADDRESS,
    ]);
  });

  it("reads the SDK standing for the account and folds it into the app's shape", async () => {
    mocks.resolveAirdropAccount.mockResolvedValue({ address: ADDRESS });
    const chain = makeChainClient();
    mocks.getPeopleClient.mockResolvedValue(chain);

    const drawId = buildDrawEventId(0n);
    mocks.readPeopleAirdropsStanding.mockResolvedValue({
      ok: true,
      value: {
        at: { blockHash: BLOCK_HASH, blockNumber: 7 },
        account: ADDRESS,
        alias: {
          airdropsContext: AIRDROPS_CONTEXT,
          binding: { tag: "Bound", alias: ALIAS, ring: 0, revision: 3 },
        },
        draws: [
          {
            drawIndex: 0n,
            event: {
              eventId: drawId,
              status: "Claiming",
              phase: "Claiming",
              prize: { assetId: null, assetAmount: 1_000n, maxWinners: 1, winnerCapPermill: 0 },
              registrationStarts: 900,
              drawTime: 1_000,
              endTime: 2_000,
              totalParticipants: 3,
              effectiveWinners: 1,
              claimed: 0,
              source: null,
            },
            slot: drawId,
            registered: true,
            won: true,
          },
        ],
      },
    });

    await mountWithAccount();
    const result = await latestQuery().queryFn({
      signal: new AbortController().signal,
    });

    // One read, over the client and API the People connection holds, so the
    // SDK pins one block for the alias, the draws and the participation.
    expect(mocks.readPeopleAirdropsStanding).toHaveBeenCalledTimes(1);
    const [sdkChain, options] = mocks.readPeopleAirdropsStanding.mock.calls[0]!;
    expect(sdkChain).toMatchObject({ individuality: chain.api, raw: { individuality: chain.client } });
    // The hook bounds the read with its own signal, so only its presence is pinned.
    expect(options).toEqual({ account: ADDRESS, signal: expect.any(AbortSignal) });

    expect(result).toEqual({
      accountAddress: ADDRESS,
      alias: ALIAS,
      airdropsContext: AIRDROPS_CONTEXT,
      aliasContext: AIRDROPS_CONTEXT,
      contextMatches: true,
      atBlockHash: BLOCK_HASH,
      participations: [
        {
          draw: {
            eventId: drawId,
            drawIndex: 0n,
            status: "Claiming",
            registrationStartsSeconds: 900,
            drawTimeSeconds: 1_000,
            endTimeSeconds: 2_000,
            prizeAmount: 1_000n,
            assetId: null,
            maxWinners: 1,
            totalParticipants: 3,
            effectiveWinners: 1,
            claimed: 0,
          },
          slot: drawId,
          registered: true,
          winner: true,
          claimed: null,
        },
      ],
    });
  });

  it("preserves a context mismatch as no alias with the other context", async () => {
    mocks.resolveAirdropAccount.mockResolvedValue({ address: ADDRESS });
    mocks.getPeopleClient.mockResolvedValue(makeChainClient());
    // The account holds an alias, but in another pallet's context: every slot
    // derived from it would be wrong and the runtime would reject `register`
    // and `claim` with `BadOrigin`. That has to reach the caller as its own
    // condition, not as "no draws".
    mocks.readPeopleAirdropsStanding.mockResolvedValue({
      ok: true,
      value: {
        at: { blockHash: BLOCK_HASH, blockNumber: 7 },
        account: ADDRESS,
        alias: {
          airdropsContext: AIRDROPS_CONTEXT,
          binding: { tag: "OtherContext", context: OTHER_CONTEXT },
        },
        draws: [],
      },
    });

    await mountWithAccount();
    const result = await latestQuery().queryFn({
      signal: new AbortController().signal,
    });

    expect(result).toMatchObject({
      alias: null,
      aliasContext: OTHER_CONTEXT,
      airdropsContext: AIRDROPS_CONTEXT,
      contextMatches: false,
      participations: [],
    });
  });

  it("rejects when the SDK read fails, rather than reading as no draws", async () => {
    mocks.resolveAirdropAccount.mockResolvedValue({ address: ADDRESS });
    mocks.getPeopleClient.mockResolvedValue(makeChainClient());
    const error = new Error("rpc down");
    mocks.readPeopleAirdropsStanding.mockResolvedValue({ ok: false, error });

    await mountWithAccount();
    await expect(
      latestQuery().queryFn({ signal: new AbortController().signal }),
    ).rejects.toBe(error);
  });

  it("refetches when the best-block head changes and unsubscribes on unmount", async () => {
    mocks.resolveAirdropAccount.mockResolvedValue({ address: ADDRESS });
    const chain = makeChainClient();
    mocks.getPeopleClient.mockResolvedValue(chain);

    const mounted = renderHook(() => useAirdropStanding(true));
    await waitFor(() => {
      expect(chain.client.bestBlocks$.subscribe).toHaveBeenCalledTimes(1);
    });

    chain.emitHead(BLOCK_HASH);
    chain.emitHead(BLOCK_HASH);
    expect(mocks.invalidateQueries).toHaveBeenCalledTimes(1);
    chain.emitHead(NEXT_BLOCK_HASH);
    expect(mocks.invalidateQueries).toHaveBeenCalledTimes(2);
    expect(mocks.invalidateQueries).toHaveBeenLastCalledWith(
      { queryKey: [...AIRDROP_STANDING_QUERY_KEY, ADDRESS] },
      { cancelRefetch: false },
    );

    mounted.unmount();
    expect(chain.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("does not subscribe to best blocks without an account", async () => {
    mocks.resolveAirdropAccount.mockResolvedValue(null);
    const chain = makeChainClient();
    mocks.getPeopleClient.mockResolvedValue(chain);

    renderHook(() => useAirdropStanding(true));
    await waitFor(() => {
      expect(mocks.resolveAirdropAccount).toHaveBeenCalled();
    });

    expect(chain.client.bestBlocks$.subscribe).not.toHaveBeenCalled();
  });
});
