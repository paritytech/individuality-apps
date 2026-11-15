// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { createSyncStoragePersister } from "@tanstack/query-sync-storage-persister";
import {
  persistQueryClientRestore,
  persistQueryClientSave,
  type PersistedClient,
  type Persister,
} from "@tanstack/react-query-persist-client";

import { envConfig } from "@humanity/shared/config/env.ts";
import { resolveNetwork } from "@humanity/shared/chain/networks.ts";
import {
  PERSIST_KEY,
  PERSIST_MAX_AGE_MS,
  deserializePersistedClient,
  dropRetiredCacheScopes,
  persistOptions,
  serializePersistedClient,
} from "@shared/chain/query-persistence.ts";

class FakeStorage implements Storage {
  readonly map = new Map<string, string>();
  get length() {
    return this.map.size;
  }
  clear() {
    this.map.clear();
  }
  getItem(key: string) {
    return this.map.get(key) ?? null;
  }
  key(index: number) {
    return [...this.map.keys()][index] ?? null;
  }
  removeItem(key: string) {
    this.map.delete(key);
  }
  setItem(key: string, value: string) {
    this.map.set(key, value);
  }
}

const IDENTITY_KEY = ["chain", "humanity-user-id"] as const;
const CARD_KEY = ["chain", "humanity-card", "alice"] as const;
const GAME_KEY = ["chain", "current-game", "alice", "alice.paseo"] as const;
const STANDING_KEY = ["chain", "airdrop-standing", "5Airdrop"] as const;
const STATUS_KEY = ["chain", "status"] as const;
const DAILY_KEY = ["chain", "daily-prize", "game-135"] as const;
const TICKET_KEY = ["chain", "prize-ticket", 135, "evt-1", "alice"] as const;

const identityData = { username: "alice", address: "5FakeAddress" };
const cardData = { state: "idle", heat: 3 };
const gameData = { gameIndex: 135, phase: "registration" };
const standingData = {
  participations: [
    {
      draw: {
        drawIndex: 45n,
        prizeAmount: 1_000_000n,
        assetId: { parents: 1, interior: { type: "X1", value: { type: "GeneralKey", value: new Uint8Array([1, 2, 255]) } } },
      },
      winner: true,
    },
  ],
};
const statusData = { connected: true };
const dailyData = { dollar: 100 };
const ticketData = { ticketId: "t-1" };

async function seedClient(client: QueryClient) {
  const seed = (queryKey: readonly unknown[], data: unknown) =>
    client.fetchQuery({
      queryKey,
      queryFn: async () => data,
      retry: false,
    });
  await seed(IDENTITY_KEY, identityData);
  await seed(CARD_KEY, cardData);
  await seed(GAME_KEY, gameData);
  await seed(STANDING_KEY, standingData);
  await seed(STATUS_KEY, statusData);
  await seed(DAILY_KEY, dailyData);
  await seed(TICKET_KEY, ticketData);
}

function makePersister(storage: FakeStorage): Persister {
  return createSyncStoragePersister({
    storage,
    key: PERSIST_KEY,
    throttleTime: 0,
    serialize: serializePersistedClient,
    deserialize: (text) => deserializePersistedClient(text) as PersistedClient,
  });
}

async function saveClient(client: QueryClient, persister: Persister) {
  await persistQueryClientSave({
    queryClient: client,
    persister,
    buster: persistOptions.buster,
    dehydrateOptions: persistOptions.dehydrateOptions,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function restoreInto(persister: Persister): Promise<QueryClient> {
  const restored = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  await persistQueryClientRestore({
    queryClient: restored,
    persister,
    buster: persistOptions.buster,
    maxAge: persistOptions.maxAge,
  });
  return restored;
}

function persistedKeys(storage: FakeStorage): unknown[][] {
  const persisted = JSON.parse(storage.map.get(PERSIST_KEY)!) as {
    buster: string;
    clientState: { queries: { queryKey: unknown[] }[] };
  };
  expect(persisted.buster).toBe(persistOptions.buster);
  return persisted.clientState.queries.map((q) => q.queryKey);
}

describe("query persistence", () => {
  it("persists and restores only the four selected query families", async () => {
    const storage = new FakeStorage();
    const persister = makePersister(storage);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    await seedClient(client);

    await saveClient(client, persister);

    const keys = persistedKeys(storage);
    expect(keys).toHaveLength(4);
    expect(keys).toContainEqual([...IDENTITY_KEY]);
    expect(keys).toContainEqual([...CARD_KEY]);
    expect(keys).toContainEqual([...GAME_KEY]);
    expect(keys).toContainEqual([...STANDING_KEY]);

    const restored = await restoreInto(persister);
    expect(restored.getQueryData(IDENTITY_KEY)).toEqual(identityData);
    expect(restored.getQueryData(CARD_KEY)).toEqual(cardData);
    expect(restored.getQueryData(GAME_KEY)).toEqual(gameData);
    expect(restored.getQueryData(STANDING_KEY)).toEqual(standingData);
    expect(restored.getQueryData(STATUS_KEY)).toBeUndefined();
    expect(restored.getQueryData(DAILY_KEY)).toBeUndefined();
    expect(restored.getQueryData(TICKET_KEY)).toBeUndefined();
  });

  it("carries a draw's bigints and byte strings through JSON and back", () => {
    const text = serializePersistedClient(standingData);
    expect(text).toContain('"$bigint":"45"');
    expect(text).toContain('"$bytes":"0x0102ff"');
    const back = deserializePersistedClient(text) as typeof standingData;
    expect(back).toEqual(standingData);
    expect(back.participations[0]?.draw.drawIndex).toBe(45n);
    expect(back.participations[0]?.draw.assetId.interior.value.value).toBeInstanceOf(Uint8Array);
  });

  it("keeps retained data after a background error and restores it", async () => {
    const storage = new FakeStorage();
    const persister = makePersister(storage);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    await seedClient(client);

    const cardQuery = client.getQueryCache().find({ queryKey: CARD_KEY })!;
    cardQuery.setState({
      status: "error",
      error: new Error("host revalidation failed"),
    });
    expect(cardQuery.state.status).toBe("error");
    expect(cardQuery.state.data).toEqual(cardData);

    await saveClient(client, persister);

    const keys = persistedKeys(storage);
    expect(keys).toHaveLength(4);
    expect(keys).toContainEqual([...CARD_KEY]);

    const restored = await restoreInto(persister);
    expect(restored.getQueryData(CARD_KEY)).toEqual(cardData);
    expect(restored.getQueryData(IDENTITY_KEY)).toEqual(identityData);
    expect(restored.getQueryData(GAME_KEY)).toEqual(gameData);
  });

  it("scopes the cache key and buster to schema, network, and genesis hash", () => {
    const network = resolveNetwork(envConfig.chain.network);
    expect(PERSIST_KEY).toBe(
      `humanity-prizes:query:v5-${network.key}-${network.peopleChain.genesisHash}`,
    );
    expect(persistOptions.buster).toBe(PERSIST_KEY);
    expect(persistOptions.maxAge).toBe(PERSIST_MAX_AGE_MS);
    expect(PERSIST_MAX_AGE_MS).toBe(30 * 24 * 60 * 60 * 1000);
  });

  it("falls back to a no-op persister when storage is unavailable", () => {
    expect(persistOptions.persister.persistClient).toBeTypeOf("function");
    expect(persistOptions.persister.restoreClient()).toBeUndefined();
  });
});

describe("dropRetiredCacheScopes", () => {
  it("removes what earlier schema versions wrote and nothing else", () => {
    const storage = new FakeStorage();
    const network = resolveNetwork(envConfig.chain.network);
    const scope = `${network.key}-${network.peopleChain.genesisHash}`;
    storage.setItem(`humanity-prizes:query:v1-${scope}`, "{}");
    storage.setItem(`humanity-prizes:last-card:v1-${scope}`, "{}");
    storage.setItem(`humanity-prizes:query:v1-previewnet-0xother`, "{}");
    storage.setItem(`humanity-prizes:query:v2-${scope}`, "{}");
    storage.setItem(`humanity-prizes:last-card:v2-${scope}`, "{}");
    storage.setItem(`humanity-prizes:query:v3-${scope}`, "{}");
    storage.setItem(`humanity-prizes:last-card:v3-${scope}`, "{}");
    storage.setItem(`humanity-prizes:query:v4-${scope}`, "{}");
    storage.setItem(`humanity-prizes:last-card:v4-${scope}`, "{}");
    storage.setItem(`humanity-prizes:query:v5-${scope}`, "{}");
    storage.setItem(`humanity-prizes:last-card:v5-${scope}`, "{}");
    storage.setItem("humanity-prizes:debug", "{}");
    storage.setItem("humanity-prizes:network", "{}");
    // Per-device flags once keyed on the schema scope; they key on the
    // network alone now, so every scoped copy is left over.
    storage.setItem(`humanity-prizes:hints:v3-${scope}`, "{}");
    storage.setItem(`humanity-prizes:caution-sheet:v3-${scope}`, "{}");
    storage.setItem(`humanity-prizes:hints:${scope}`, "{}");
    storage.setItem(`humanity-prizes:caution-sheet:${scope}`, "{}");

    dropRetiredCacheScopes(storage);

    expect([...storage.map.keys()].sort()).toEqual(
      [
        `humanity-prizes:query:v5-${scope}`,
        `humanity-prizes:last-card:v5-${scope}`,
        "humanity-prizes:debug",
        "humanity-prizes:network",
        `humanity-prizes:hints:${scope}`,
        `humanity-prizes:caution-sheet:${scope}`,
      ].sort(),
    );
  });

  it("is a no-op without storage", () => {
    expect(() => dropRetiredCacheScopes(undefined)).not.toThrow();
  });
});
