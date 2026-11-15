// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Persistence for the daily-dollar registry, in host key-value storage under
 * `daily-dollar:<accountAddress>`.
 *
 * Two independent writers share this key: the app (when a person registers or
 * claims from the UI) and the headless worker (on every tick). So every
 * mutation goes through `updateDailyDollarRegistry`, which serializes
 * read-modify-write per account — the host store has no compare-and-swap, and
 * an interleaved read/write pair would silently drop the other side's record.
 *
 * Nothing here throws. The registry is an optimization — it stops duplicate
 * registrations and duplicate notifications — and losing it must never take
 * down the tick or the UI that reads it; a lost read degrades to "nothing
 * known yet", which the next chain reconcile repairs.
 */
import type { DailyDollarRegistry } from "@individuality/daily-dollar";
import {
  emptyRegistry,
  sanitizeRegistry,
} from "@humanity/shared/airdrops/domain/daily-dollar-registry.ts";
import { loggerFor } from "@humanity/shared/logging/logger.ts";
import { getLocalKvStore } from "@humanity/shared/storage/local-kv.ts";

const logger = loggerFor("airdrops", "daily-dollar-registry");

/** Key namespace inside the product's `humanity` store prefix. */
export const DAILY_DOLLAR_REGISTRY_KEY_PREFIX = "daily-dollar:";

/**
 * Tail of the in-flight update chain per account. Dynamic keys with runtime
 * insertion and deletion, so a `Map` rather than a record.
 */
const updateChains = new Map<string, Promise<unknown>>();

/** Read and sanitize the registry. Never throws: a failed read is an empty registry. */
export async function readDailyDollarRegistry(
  accountAddress: string,
): Promise<DailyDollarRegistry> {
  try {
    const store = await getLocalKvStore();
    const raw = await store.getJSON(
      `${DAILY_DOLLAR_REGISTRY_KEY_PREFIX}${accountAddress}`,
    );
    return sanitizeRegistry(raw, accountAddress);
  } catch (error: unknown) {
    logger.warning("daily-dollar registry read failed: {error}", { error });
    return emptyRegistry(accountAddress);
  }
}

/** Persist the registry. Never throws: a failed write is logged and dropped. */
export async function writeDailyDollarRegistry(
  registry: DailyDollarRegistry,
): Promise<void> {
  try {
    const store = await getLocalKvStore();
    await store.setJSON(
      `${DAILY_DOLLAR_REGISTRY_KEY_PREFIX}${registry.accountAddress}`,
      registry,
    );
  } catch (error: unknown) {
    logger.warning("daily-dollar registry write failed: {error}", { error });
  }
}

/**
 * Read, apply `update`, write back — serialized against every other update
 * for the same account, so concurrent app and worker mutations compose
 * instead of clobbering. Resolves with the registry as written.
 */
export function updateDailyDollarRegistry(
  accountAddress: string,
  update: (current: DailyDollarRegistry) => DailyDollarRegistry,
): Promise<DailyDollarRegistry> {
  const previous = updateChains.get(accountAddress) ?? Promise.resolve();
  const next = previous.then(async (): Promise<DailyDollarRegistry> => {
    const current = await readDailyDollarRegistry(accountAddress);
    let updated: DailyDollarRegistry;
    try {
      updated = update(current);
    } catch (error: unknown) {
      logger.warning("daily-dollar registry update failed: {error}", { error });
      return current;
    }
    await writeDailyDollarRegistry(updated);
    return updated;
  });
  // The chain link must never reject, or every later update for this account
  // would inherit the rejection and skip its own read-modify-write.
  const link = next.then(
    () => undefined,
    () => undefined,
  );
  updateChains.set(accountAddress, link);
  void link.then(() => {
    if (updateChains.get(accountAddress) === link) {
      updateChains.delete(accountAddress);
    }
  });
  return next;
}

/** Exposed for tests so each case starts with no in-flight update chain. */
export function __resetDailyDollarRegistryStoreForTests(): void {
  updateChains.clear();
}
