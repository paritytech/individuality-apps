// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { getPeopleClient } from "./client.ts";
import {
  findRingVrfKeyHandle,
  getAccountsProvider,
  toHex,
} from "./host-api.ts";
import { membershipRingLocation } from "./individuality.ts";
import { resolveRingVrfKeyHandle } from "./ring-vrf-key.ts";
import { withTimeout } from "@humanity/shared/utils/with-timeout.ts";
import type { NetworkConfig } from "./networks.ts";

/** Read actual ring inclusion, not game score or host key registration alone.
 * Registering a key only makes it addressable by the host; it does not confer
 * personhood or submit a transaction. Public-key disclosure can be refused. */
export async function readFullPersonhood(
  network: NetworkConfig,
  domain: string,
  signal: AbortSignal,
): Promise<boolean> {
  const provider = await getAccountsProvider();
  if (provider == null) return false;
  const ring = membershipRingLocation(network);
  const resolved = await resolveRingVrfKeyHandle(provider, domain, ring);
  signal.throwIfAborted();
  const keys = await withTimeout(
    provider.listRingVrfKeys(domain, "PublicKey").match(
      (value) => value,
      () => {
        throw new Error("The host could not check your personhood key.");
      },
    ),
    15_000,
    "The host did not answer the personhood check.",
  );
  signal.throwIfAborted();
  const key = keys.find((entry) => findRingVrfKeyHandle([entry], resolved.ring) != null);
  if (key?.publicKey == null) {
    throw new Error("The host did not disclose the personhood key.");
  }
  const collection = ring.junctions.find(
    (junction) => junction.tag === "CollectionId",
  );
  if (collection?.tag !== "CollectionId")
    throw new Error("Missing people collection.");
  const { api, client } = await getPeopleClient();
  const block = await client.getFinalizedBlock();
  signal.throwIfAborted();
  const member = await api.query.Members.Members.getValue(
    collection.value,
    toHex(key.publicKey),
    { at: block.hash, signal },
  );
  return member?.type === "Included";
}
