// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import { Binary, Enum } from "polkadot-api";
import { ss58Decode } from "@polkadot-labs/hdkd-helpers";
import type { CliAttestedIdentity } from "@parity/product-lab/host-truapi-cli";
import type { BlockRef, ChainAccess } from "@parity/product-lab/ports/chain";

export function accountKey(address: string): string {
  return /^0x[0-9a-f]{64}$/i.test(address) ? address.toLowerCase() : `0x${Buffer.from(ss58Decode(address)[0]).toString("hex")}`;
}

/** Read both directions at exactly one independently acquired finalized People hash. */
export async function attestBinding(chain: Pick<ChainAccess, "finalizedHead" | "storage">, identity: Pick<CliAttestedIdentity, "identityAddress" | "liteUsername">, finalizedBlock?: BlockRef) {
  const at = finalizedBlock ?? await chain.finalizedHead();
  const owner = await chain.storage("Resources", "UsernameOwnerOf", [Binary.fromText(identity.liteUsername)], at.hash);
  if (!identity.identityAddress || typeof owner !== "string" || accountKey(owner) !== accountKey(identity.identityAddress))
    throw new Error("Finalized username owner differs from the attested wallet");
  const consumer = await chain.storage("Resources", "Consumers", [owner], at.hash);
  if (!consumer || typeof consumer !== "object" || !("lite_username" in consumer))
    throw new Error("Finalized username reverse binding is missing");
  const bytes = consumer.lite_username;
  const handle = bytes instanceof Uint8Array ? new TextDecoder().decode(bytes)
    : bytes && typeof bytes === "object" && "asText" in bytes && typeof bytes.asText === "function" ? bytes.asText() : undefined;
  if (handle !== identity.liteUsername)
    throw new Error("Finalized username reverse binding differs from the attested handle");
  // Consumers contains public chain state only. Preserve its read alongside the forward record.
  return { at, owner, username: identity.liteUsername, reverse: consumer };
}

/** Score's Player key is a variant, rather than an address. Keep admission at the identity proof's hash. */
export async function requireUnusedNavigationActor(chain: Pick<ChainAccess, "storage">, gameAccount: string, hash: string): Promise<void> {
  const participant = await chain.storage("Score", "Participants", [Enum("Account", gameAccount)], hash);
  if (participant !== undefined && participant !== null)
    throw new Error("Navigation admission requires actors with no membership/game progress; refusing automatic promotion");
}
