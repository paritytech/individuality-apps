// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Obtain the RFC-0024 ring-VRF key handle the host needs for alias and proof
 * requests.
 *
 * `@parity/truapi` 0.9.0 made the member key explicit: the caller names which
 * registered key the host must use, rather than the host picking one. A handle
 * is opaque and cannot be constructed from a derivation index — it only comes
 * back from `listRingVrfKeys`, so a product that has never registered a key for
 * a ring has to register first and list again.
 */

import { declaresRing } from "@humanity/shared/identity/personhood-ring-key.ts";
import { loggerFor } from "@humanity/shared/logging/logger.ts";
import { withTimeout } from "@humanity/shared/utils/with-timeout.ts";

import {
  findRingVrfKeyHandle,
  type AccountsProvider,
  type RegisteredRingVrfKey,
  type RingLocation,
  type RingVrfKeyHandle,
} from "./host-api.ts";

const logger = loggerFor("chain", "ring-vrf-key");

/**
 * Deadline per RFC-0024 host call. Short because an unimplemented method on
 * this bridge is silently dropped rather than refused, and a capture taken
 * before the deadline fires shows an unresolved call with no explanation.
 */
const HOST_TIMEOUT_MS = 10_000;

/**
 * Ring-VRF domain index this product registers its full-People member key at.
 *
 * Zero mirrors the Android wallet, whose `FULL_PERSONHOOD_INDEX` is `0` for the
 * full people ring and `1` for people-lite. The index is product-relative, so it
 * only has to stay stable for us; keeping it aligned makes the two clients
 * comparable when a proof is rejected.
 */
const FULL_PEOPLE_KEY_INDEX = 0;

export class RingVrfKeyError extends Error {
  readonly stage: "list" | "register" | "missing";

  constructor(stage: "list" | "register" | "missing", detail: string) {
    super(`resolving the ring VRF key failed at ${stage}: ${detail}`);
    this.name = "RingVrfKeyError";
    this.stage = stage;
  }
}

function describe(error: unknown): string {
  if (typeof error === "object" && error != null && "tag" in error) {
    return String(error.tag);
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * The handle of the key declared for `ring`: an exact `RingLocation` match
 * first, then any key declaring the same chain and collection id.
 *
 * The fallback is what {@link declaresRing} documents: live hosts declare one
 * ring with different junction lists (`[CollectionId]` vs this app's
 * `[PalletInstance, CollectionId]`). Without it a key the wallet registered is
 * never found, registering at the same index hands back that same key, and the
 * second listing still misses it (Sentry 157020769).
 */
export function findDeclaredRingVrfKey(
  keys: RegisteredRingVrfKey[],
  ring: RingLocation,
): ResolvedRingVrfKey | undefined {
  const exact = findRingVrfKeyHandle(keys, ring);
  if (exact != null) return { handle: exact, ring };
  const collection = ring.junctions.find((junction) => junction.tag === "CollectionId");
  if (collection == null) return undefined;
  const key = keys.find((entry) => declaresRing(entry, ring, collection.value));
  if (key == null) return undefined;
  // The host proves only for a ring location it declared, compared exactly
  // (in truapi and in the Android app alike): asking with our `[CollectionId]` for a key it declared
  // as `[PalletInstance, CollectionId]` answers `KeyNotInRing`. So the proof
  // must name the host's own location for the ring we matched.
  const declared = key.rings.find((location) =>
    declaresRing({ ...key, rings: [location] }, ring, collection.value),
  );
  return declared == null ? undefined : { handle: key.handle, ring: declared };
}

/** A member key the host holds, and the ring location the host declared it under. */
export interface ResolvedRingVrfKey {
  readonly handle: RingVrfKeyHandle;
  /** Pass this, not the caller's own location, to every proof for the key. */
  readonly ring: RingLocation;
}

/**
 * The handle for this product's member key in `ring`, registering it when the
 * registry has none.
 *
 * @param owner the registry to read. This is the CALLER's own product, not the
 *   product that owns the proof context. `registerRingVrfKey` "only ever
 *   touches the caller's own domain" (the Android host's rule), so the
 *   key we register lands in our registry; asking for another product's
 *   registry is a foreign read the host governs by its permission model.
 * @throws RingVrfKeyError when the host declines, or still reports no handle
 *   after a registration it accepted.
 */
export async function resolveRingVrfKeyHandle(
  provider: AccountsProvider,
  owner: string,
  ring: RingLocation,
): Promise<ResolvedRingVrfKey> {
  const list = async (): Promise<ResolvedRingVrfKey | undefined> => {
    // Logged before the call: this is the first RFC-0024 method the host sees,
    // so if it never answers, this line is the last thing recorded.
    logger.info("listing registry; owner={owner} chain={chain}", {
      owner,
      chain: ring.chainId,
    });
    const keys = await withTimeout(
      provider.listRingVrfKeys(owner).match(
        (value) => value,
        (error) => {
          throw new RingVrfKeyError("list", describe(error));
        },
      ),
      HOST_TIMEOUT_MS,
      "the host never answered listRingVrfKeys",
    );
    logger.info("registry listed; owner={owner} keys={keys}", {
      owner,
      keys: keys.length,
    });
    return findDeclaredRingVrfKey(keys, ring);
  };

  const existing = await list();
  if (existing != null) {
    logger.info("using an already registered key");
    return existing;
  }

  logger.info("no key for this ring; registering at index={index}", {
    index: FULL_PEOPLE_KEY_INDEX,
  });
  const publicKey = await withTimeout(
    provider.registerRingVrfKey(FULL_PEOPLE_KEY_INDEX, ring).match(
      (value) => value,
      (error) => {
        throw new RingVrfKeyError("register", describe(error));
      },
    ),
    HOST_TIMEOUT_MS,
    "the host did not register a ring VRF key in time",
  );
  logger.info("registered; publicKeyBytes={bytes}", {
    bytes: publicKey.length,
  });

  const registered = await list();
  if (registered == null) {
    // Registration succeeded but the registry still does not name a key for
    // this ring, which means the ring we registered against is not the ring we
    // are asking about. Almost certainly a `RingLocation` mismatch.
    throw new RingVrfKeyError(
      "missing",
      "registration succeeded but no handle matches this ring location",
    );
  }
  return registered;
}
