// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Host-backed key-value storage, created once and shared.
 *
 * `createLocalKvStore` only resolves inside a Polkadot host container and
 * throws otherwise, so outside one (plain-browser dev, tests) this degrades to
 * an in-memory store with the same interface rather than taking the app down.
 * The fallback is deliberately per-session: it keeps the UI coherent for the
 * current session without pretending a value was persisted somewhere the host
 * can read back.
 */
import {
  createLocalKvStore,
  type HostLocalStorage,
  type LocalKvStore,
} from "@humanity/shared/chain/host-api.ts";
import { loggerFor } from "@humanity/shared/logging/logger.ts";

const logger = loggerFor("storage", "local-kv");

/** Namespaces every key this product writes into host storage. */
const STORE_PREFIX = "humanity";

/** Same contract as the host store, backed by module memory. */
function inMemoryStore(): LocalKvStore {
  const entries = new Map<string, string>();
  return {
    get(key) {
      return Promise.resolve(entries.get(key) ?? null);
    },
    set(key, value) {
      entries.set(key, value);
      return Promise.resolve();
    },
    remove(key) {
      entries.delete(key);
      return Promise.resolve();
    },
    getJSON<T>(key: string): Promise<T | null> {
      const raw = entries.get(key);
      if (raw == null) return Promise.resolve(null);
      try {
        return Promise.resolve(JSON.parse(raw) as T);
      } catch {
        return Promise.resolve(null);
      }
    },
    setJSON(key, value) {
      entries.set(key, JSON.stringify(value));
      return Promise.resolve();
    },
  };
}

let storePromise: Promise<LocalKvStore> | null = null;

/**
 * The shared store. Memoized on the promise, so concurrent callers await one
 * host handshake instead of racing several.
 *
 * `hostLocalStorage` overrides host auto-detection — the SDK's own documented
 * escape hatch, which is how a caller can supply a host handle directly.
 */
export function getLocalKvStore(
  hostLocalStorage?: HostLocalStorage,
): Promise<LocalKvStore> {
  storePromise ??= createLocalKvStore({
    prefix: STORE_PREFIX,
    ...(hostLocalStorage == null ? {} : { hostLocalStorage }),
  }).catch((error: unknown) => {
    logger.warning(
      "host storage unavailable, falling back to in-memory store; " +
        "values will not survive a reload: {error}",
      { error },
    );
    return inMemoryStore();
  });
  return storePromise;
}

/** Drop the memoized store so the next call re-resolves it. */
export function resetLocalKvStore(): void {
  storePromise = null;
}
