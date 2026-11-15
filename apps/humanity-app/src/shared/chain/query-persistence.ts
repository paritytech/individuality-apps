// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import type { DehydrateOptions, Query } from "@tanstack/react-query";
import type {
  PersistQueryClientOptions,
  PersistedClient,
  Persister,
} from "@tanstack/react-query-persist-client";
import { createSyncStoragePersister } from "@tanstack/query-sync-storage-persister";
import { Binary } from "polkadot-api";

import { envConfig } from "@humanity/shared/config/env.ts";
import { resolveNetwork } from "@humanity/shared/chain/networks.ts";

/**
 * Bump when the shape of a persisted query's data changes, so browsers drop
 * what an earlier build wrote instead of hydrating it. v2: the card state
 * `lite` was retired without a bump, and caches from before reached the card
 * face with a state it could not render. v3: member-family states gained
 * `attendanceHistory` and `window`; a v2 card would render a member with no
 * recent games to show. v4: the caution state gained `activeWeeks`, and
 * `attendanceHistory` became null for a card with no participant record; a
 * v3 caution card would render a streak it does not carry. v5: the airdrop
 * standing joined the persisted families and the cache gained bigint/Binary
 * encoding.
 */
const PERSIST_SCHEMA_VERSION = 5;

export const PERSIST_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

const PERSISTED_QUERY_PREFIXES = [
  ["chain", "humanity-user-id"],
  ["chain", "humanity-card"],
  ["chain", "current-game"],
  ["chain", "airdrop-standing"],
] as const;

/** JSON cannot carry a draw's bigints or the byte strings inside an XCM asset
 *  id; both are tagged on the way out and rebuilt on the way in. */
export function serializePersistedClient(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    typeof item === "bigint"
      ? { $bigint: item.toString() }
      : item instanceof Uint8Array
        ? { $bytes: Binary.toHex(item) }
        : item,
  );
}

export function deserializePersistedClient(text: string): unknown {
  return JSON.parse(text, (_key, item: unknown) => {
    if (typeof item !== "object" || item == null) return item;
    if ("$bigint" in item && typeof item.$bigint === "string") return BigInt(item.$bigint);
    if ("$bytes" in item && typeof item.$bytes === "string") return Binary.fromHex(item.$bytes);
    return item;
  });
}

function isPersistedQueryKey(queryKey: readonly unknown[]): boolean {
  return PERSISTED_QUERY_PREFIXES.some((prefix) =>
    prefix.every((part, index) => queryKey[index] === part),
  );
}

/**
 * Persist whenever data is present — including retained data after a
 * background refetch error — but only for the selected query families.
 */
const dehydrateOptions: DehydrateOptions = {
  shouldDehydrateQuery: (query: Query) =>
    query.state.data !== undefined && isPersistedQueryKey(query.queryKey),
};

/** Which chain this browser's records are about: the network and its People
 *  chain genesis, so a reset chain or another network starts clean. Per-device
 *  flags (tips shown, sheets answered) key on this alone; they carry their
 *  own record version and must not reset whenever the query cache's shape
 *  changes. */
export const NETWORK_SCOPE = (() => {
  const network = resolveNetwork(envConfig.chain.network);
  return `${network.key}-${network.peopleChain.genesisHash}`;
})();

export const PERSIST_CACHE_SCOPE = `v${PERSIST_SCHEMA_VERSION}-${NETWORK_SCOPE}`;

export const PERSIST_KEY = `humanity-prizes:query:${PERSIST_CACHE_SCOPE}`;
const PERSIST_BUSTER = PERSIST_KEY;

const RETIRED_SCOPE_KEY = /^humanity-prizes:(query|last-card|hints|caution-sheet):v(\d+)-/;
/** Keys that once carried the schema scope and now key on the network alone:
 *  every scoped copy of them is a leftover, whatever its version. */
const UNSCOPED_NOW = new Set(["hints", "caution-sheet"]);

/**
 * Removes what earlier schema versions left behind. The version is part of
 * the storage key, so a bump makes the persister *ignore* the old entry
 * rather than remove it — and the last-card snapshot shares the scope. Both
 * would otherwise sit in the browser for good.
 */
export function dropRetiredCacheScopes(storage: Storage | undefined = pickLocalStorage()): void {
  if (storage == null) return;
  try {
    const retired: string[] = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      const match = key == null ? null : RETIRED_SCOPE_KEY.exec(key);
      if (match != null && (UNSCOPED_NOW.has(match[1]!) || Number(match[2]) < PERSIST_SCHEMA_VERSION)) {
        retired.push(key!);
      }
    }
    for (const key of retired) storage.removeItem(key);
  } catch {
    // Storage that cannot be enumerated cannot hold anything worth dropping.
  }
}

function pickLocalStorage(): Storage | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

/**
 * localStorage-backed persister. Where storage is unavailable (Node, SSR,
 * blocked cookies) `createSyncStoragePersister` yields a no-op persister.
 */
export const queryPersister: Persister = createSyncStoragePersister({
  storage: pickLocalStorage(),
  key: PERSIST_KEY,
  serialize: serializePersistedClient,
  deserialize: (text) => deserializePersistedClient(text) as PersistedClient,
});

/**
 * Consumed by `<PersistQueryClientProvider persistOptions={persistOptions}>`.
 * `queryClient` is omitted; the provider injects its own client prop.
 */
export const persistOptions = {
  persister: queryPersister,
  buster: PERSIST_BUSTER,
  maxAge: PERSIST_MAX_AGE_MS,
  dehydrateOptions,
} as const satisfies Omit<PersistQueryClientOptions, "queryClient">;
