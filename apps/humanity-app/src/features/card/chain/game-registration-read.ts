// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The weekly-game sign-up on its way, or just ended, read from the two stores
 * it is kept in: Jollity's host
 * storage, which its chat and app write, and this product's own, which this
 * home's sign-up writes (`game-sign-up.ts`).
 *
 * Tapping Register signs the shared game account up. Signing, proving and
 * entering the draws take up to half a minute before the transaction is in a
 * block, and the chain shows nothing until then, so a home would offer
 * Register for a sign-up already under way. Each product keeps a record of
 * every step of its own sign-ups in its own storage: a product reads another's
 * through a `trustedProducts` storage grant (Jollity's manifest grants peopl
 * storage) but never writes it. So this reads both and keeps the latest.
 *
 * The key, the shape, the lifetimes and the store are the contract between
 * the two products, `@individuality/shared-records`; what is this product's
 * is the storage handles: truapi's cross-product read of Jollity's storage,
 * which answers hex, and this product's raw host storage.
 */
import {
  decodeStoredJSON,
  gameRegistrationStore,
  latestGameRegistration,
  type GameRegistration,
  type GameRegistrationStore,
  type JSONStorage,
} from "@individuality/shared-records";

import { asProductId, getHostLocalStorage, getTruApi } from "@humanity/shared/chain/host-api.ts";
import { GAME_STORAGE_PRODUCT_DOMAIN } from "@humanity/shared/identity/game-account.ts";
import { loggerFor } from "@humanity/shared/logging/logger.ts";
import { withTimeout } from "@humanity/shared/utils/with-timeout.ts";

const logger = loggerFor("card", "game-registration");

/** A local storage read answers in milliseconds; anything slower is a stuck host. */
const READ_TIMEOUT_MS = 5_000;

/** The host refused the read: `AccessNotGranted` when Jollity's manifest grants this product no storage. */
class ReadRefused extends Error {
  constructor(readonly reason: string) {
    super(`Jollity's storage refused the read: ${reason}`);
  }
}

/** Jollity's storage as this product may read it, or null outside a host. */
async function jollityStorage(): Promise<JSONStorage | null> {
  const truApi = await getTruApi();
  if (truApi == null) return null;
  return {
    async readJSON(key) {
      const result = await truApi.localStorage.read({ product: asProductId(GAME_STORAGE_PRODUCT_DOMAIN), key });
      if (!result.isOk()) {
        const error = result.error;
        throw new ReadRefused(error.tag === "Domain" ? error.value.value.tag : error.tag);
      }
      return result.value.value == null ? null : decodeStoredJSON(result.value.value);
    },
  };
}

const jollity = gameRegistrationStore(jollityStorage);

/** This product's record of its own sign-ups, in its own host storage: read here, written by `game-sign-up.ts`. */
export const ownGameRegistration: GameRegistrationStore = gameRegistrationStore(getHostLocalStorage);

type Source = "jollity" | "humanity";

/** The last outcome logged per store, so a refused read polled every few seconds logs once. */
const lastOutcome: Record<Source, string | null> = { jollity: null, humanity: null };
function note(source: Source, outcome: string, detail?: string): void {
  if (outcome === lastOutcome[source]) return;
  lastOutcome[source] = outcome;
  logger.info("game registration read {outcome} from={source} {detail}", {
    outcome,
    source: source === "jollity" ? GAME_STORAGE_PRODUCT_DOMAIN : "own storage",
    detail: detail ?? "",
  });
}

async function readOne(
  source: Source,
  store: GameRegistrationStore,
  now: number,
): Promise<GameRegistration | null> {
  try {
    const record = await withTimeout(
      store.read(now),
      READ_TIMEOUT_MS,
      `Timed out reading the game registration from ${source}.`,
    );
    note(
      source,
      record == null
        ? "none"
        : `live game=${record.gameIndex} phase=${record.phase} surface=${record.surface}`,
    );
    return record;
  } catch (error) {
    if (error instanceof ReadRefused) note(source, "refused", error.reason);
    else note(source, "failed", error instanceof Error ? error.message : String(error));
    return null;
  }
}

/**
 * The latest record of a sign-up, Jollity's or this home's, or null: none,
 * outside a host, refused by a manifest that grants no storage, malformed,
 * stale or timed out. One store failing never hides the other. Never throws;
 * the chain read stays the answer whenever this has none.
 */
export async function readGameRegistration(
  now: number = Date.now(),
): Promise<GameRegistration | null> {
  return latestGameRegistration(
    await Promise.all([
      readOne("jollity", jollity, now),
      readOne("humanity", ownGameRegistration, now),
    ]),
  );
}
