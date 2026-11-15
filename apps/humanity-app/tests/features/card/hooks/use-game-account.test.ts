// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, describe, expect, it, vi } from "vitest";

const ALICE = "alice";
const BOB = "bob";
const GAME_ACCOUNT = "5GameAccount";

type GameAccountQuery = {
  enabled: boolean;
  queryKey: readonly unknown[];
  queryFn: () => Promise<string | null>;
};

type QueryState = {
  data: string | null | undefined;
  status: "error" | "pending" | "success";
};

type QueryResult = {
  data: string | null | undefined;
  isError: boolean;
  isPending: boolean;
};

const { queryClient, resolveGameAccountAddress, state } = vi.hoisted(() => {
  const state: {
    connectionStatus: ((status: "Connected" | "Disconnected") => void) | undefined;
    effectIndex: number;
    effectSlots: Array<{
      cleanup: (() => void) | void;
      dependencies: readonly unknown[] | undefined;
    } | undefined>;
    hookIndex: number;
    queries: GameAccountQuery[];
    queryResults: Map<string, QueryResult>;
    queryStates: Map<string, QueryState>;
    refs: Array<{ current: unknown }>;
  } = {
    connectionStatus: undefined,
    effectIndex: 0,
    effectSlots: [],
    hookIndex: 0,
    queries: [],
    queryResults: new Map(),
    queryStates: new Map(),
    refs: [],
  };
  const resolveGameAccountAddress = vi.fn<() => Promise<string | null>>();
  const key = (queryKey: readonly unknown[]) => JSON.stringify(queryKey);
  const queryClient = {
    getQueryState: vi.fn((queryKey: readonly unknown[]) =>
      state.queryStates.get(key(queryKey)),
    ),
    invalidateQueries: vi.fn(async ({ queryKey }: { queryKey: readonly unknown[] }) => {
      const query = state.queries.find(
        (candidate) => key(candidate.queryKey) === key(queryKey),
      );
      if (query == null) throw new Error("game account query was not created");
      const result = {
        data: await query.queryFn(),
        isError: false,
        isPending: false,
      };
      state.queryStates.set(key(queryKey), {
        data: result.data,
        status: "success",
      });
      state.queryResults.set(key(queryKey), result);
    }),
  };
  return { queryClient, resolveGameAccountAddress, state };
});

vi.mock("react", () => ({
  useEffect: (
    effect: () => void | (() => void),
    dependencies: readonly unknown[] | undefined,
  ) => {
    const index = state.effectIndex++;
    const previous = state.effectSlots[index];
    const changed =
      previous == null ||
      dependencies == null ||
      previous.dependencies == null ||
      dependencies.length !== previous.dependencies.length ||
      dependencies.some((value, i) => value !== previous.dependencies?.[i]);
    if (changed) {
      previous?.cleanup?.();
      state.effectSlots[index] = { cleanup: effect(), dependencies };
    }
  },
  useRef: <T,>(initial: T) => {
    const index = state.hookIndex++;
    const ref = state.refs[index];
    if (ref != null) return ref as { current: T };
    const created = { current: initial };
    state.refs[index] = created;
    return created;
  },
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: GameAccountQuery) => {
    state.queries.push(options);
    return (
      state.queryResults.get(JSON.stringify(options.queryKey)) ?? {
        data: undefined,
        isError: false,
        isPending: true,
      }
    );
  },
  useQueryClient: () => queryClient,
}));

vi.mock("@humanity/shared/chain/host-api.ts", () => ({
  getAccountsProvider: vi.fn(async () => ({
    subscribeAccountConnectionStatus: (
      listener: (status: "Connected" | "Disconnected") => void,
    ) => {
      state.connectionStatus = listener;
      return { unsubscribe: vi.fn(), onInterrupt: vi.fn(() => vi.fn()) };
    },
  })),
}));

vi.mock("@humanity/shared/identity/game-account.ts", () => ({ resolveGameAccountAddress }));

import { useGameAccount } from "@features/card/hooks/use-game-account.ts";

function renderGameAccount(username: string | undefined): void {
  state.effectIndex = 0;
  state.hookIndex = 0;
  useGameAccount(username, true);
}

function latestQuery(): GameAccountQuery {
  const query = state.queries.at(-1);
  if (query == null) throw new Error("game account query was not created");
  return query;
}

function key(username: string | null): string {
  return JSON.stringify(["host", "game-account", username]);
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(() => {
  state.connectionStatus = undefined;
  state.effectSlots.forEach((slot) => slot?.cleanup?.());
  state.effectIndex = 0;
  state.effectSlots = [];
  state.hookIndex = 0;
  state.queries.length = 0;
  state.queryResults.clear();
  state.queryStates.clear();
  state.refs = [];
  resolveGameAccountAddress.mockReset();
  queryClient.getQueryState.mockClear();
  queryClient.invalidateQueries.mockClear();
});

describe("useGameAccount", () => {
  it("defers lookup until the humanity identity has resolved", async () => {
    renderGameAccount(undefined);

    expect(latestQuery()).toMatchObject({
      enabled: false,
      queryKey: ["host", "game-account", null],
    });
    await flush();
    expect(state.connectionStatus).toBeUndefined();

    renderGameAccount(ALICE);
    await flush();

    expect(latestQuery()).toMatchObject({
      enabled: true,
      queryKey: ["host", "game-account", ALICE],
    });
    expect(state.connectionStatus).toBeTypeOf("function");
  });

  it("uses a separate cache key for each humanity identity", () => {
    renderGameAccount(ALICE);
    renderGameAccount(BOB);

    expect(state.queries.map((query) => query.queryKey)).toEqual([
      ["host", "game-account", ALICE],
      ["host", "game-account", BOB],
    ]);
  });

  it("retries an unresolved account on reconnect, then retains a resolved account", async () => {
    resolveGameAccountAddress
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(GAME_ACCOUNT);
    state.queryStates.set(key(ALICE), { data: null, status: "success" });

    renderGameAccount(ALICE);
    await flush();
    const query = latestQuery();
    if (state.connectionStatus == null) {
      throw new Error("game account lifecycle was not subscribed");
    }

    await query.queryFn();
    state.connectionStatus("Connected");
    await flush();

    expect(resolveGameAccountAddress).toHaveBeenCalledTimes(2);
    expect(state.queryStates.get(key(ALICE))).toEqual({
      data: GAME_ACCOUNT,
      status: "success",
    });

    state.connectionStatus("Disconnected");
    state.connectionStatus("Connected");
    await flush();

    expect(resolveGameAccountAddress).toHaveBeenCalledTimes(2);
  });
  it("recovers when host readiness arrives before the initial lookup settles", async () => {
    const initialLookup = Promise.withResolvers<string | null>();
    resolveGameAccountAddress
      .mockReturnValueOnce(initialLookup.promise)
      .mockResolvedValueOnce(GAME_ACCOUNT);
    state.queryStates.set(key(ALICE), { data: undefined, status: "pending" });
    state.queryResults.set(key(ALICE), {
      data: undefined,
      isError: false,
      isPending: true,
    });

    renderGameAccount(ALICE);
    await flush();
    const query = latestQuery();
    if (state.connectionStatus == null) {
      throw new Error("game account lifecycle was not subscribed");
    }
    const lookup = query.queryFn();
    state.connectionStatus("Connected");

    initialLookup.resolve(null);
    await lookup;
    state.queryStates.set(key(ALICE), { data: null, status: "success" });
    state.queryResults.set(key(ALICE), {
      data: null,
      isError: false,
      isPending: false,
    });
    renderGameAccount(ALICE);
    await flush();

    expect(resolveGameAccountAddress).toHaveBeenCalledTimes(2);
    expect(state.queryStates.get(key(ALICE))).toEqual({
      data: GAME_ACCOUNT,
      status: "success",
    });
  });
  it("retries each reconnect while the account remains unresolved", async () => {
    resolveGameAccountAddress
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(GAME_ACCOUNT);
    state.queryStates.set(key(ALICE), { data: null, status: "success" });

    renderGameAccount(ALICE);
    await flush();
    const query = latestQuery();
    if (state.connectionStatus == null) {
      throw new Error("game account lifecycle was not subscribed");
    }

    await query.queryFn();
    state.connectionStatus("Connected");
    await flush();
    expect(resolveGameAccountAddress).toHaveBeenCalledTimes(2);

    state.connectionStatus("Disconnected");
    state.connectionStatus("Connected");
    await flush();
    expect(resolveGameAccountAddress).toHaveBeenCalledTimes(3);
    expect(state.queryStates.get(key(ALICE))).toEqual({
      data: GAME_ACCOUNT,
      status: "success",
    });

    state.connectionStatus("Connected");
    await flush();
    expect(resolveGameAccountAddress).toHaveBeenCalledTimes(3);
  });
});
