// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import type { HostAccountCreateProofRequest } from "@parity/truapi";

import { hostError } from "@humanity/shared/chain/error-detail.ts";
import {
  fromHex,
  toHex,
  type HexString,
  type ProductProofContext,
  type RingLocation,
  type RingVRFProof,
  type RingVrfKeyHandle,
  type TruApi,
} from "@humanity/shared/chain/host-api.ts";

export interface CreateRingVrfProofArgs {
  client: TruApi;
  keyHandle: RingVrfKeyHandle;
  /**
   * The dotNS product the context is namespaced under — `peopl.<tld>` for
   * every personhood context. A stock host only mints a context it can derive
   * itself, as `product/<productId>/` hashed with {@link contextIndex}; it has
   * no way to accept the 32 bytes directly.
   */
  productId: string;
  /**
   * Which context inside that product, as the host's `Index(n)` selector.
   * `PERSONHOOD_CONTEXT_INDEX.<name>` is the source of truth for the
   * personhood contexts; never a literal.
   */
  contextIndex: number;
  /**
   * The 32 bytes the chain verifies this proof against — read from the runtime
   * or derived locally, not sent to the host. Compared with the alias the host
   * returns, so a host that derived some *other* context fails here instead of
   * producing a proof the chain silently rejects.
   */
  expectedContext: HexString;
  ringLocation: RingLocation;
  message: Uint8Array;
  failureMessage: string;
  contextMismatchMessage: string;
}

/** Mint a host-held ring-VRF proof for the exact context the chain verifies. */
export async function createRingVrfProof({
  client,
  keyHandle,
  productId,
  contextIndex,
  expectedContext,
  ringLocation,
  message,
  failureMessage,
  contextMismatchMessage,
}: CreateRingVrfProofArgs): Promise<RingVRFProof> {
  const context: ProductProofContext = {
    productId,
    suffix: { tag: "Index", value: contextIndex },
  };
  const request: HostAccountCreateProofRequest = {
    // The SDK's handle is the host's `ProductAccountId` behind an opaque
    // compile-time brand; only the brand needs stripping, not the shape.
    keyHandle: keyHandle as unknown as HostAccountCreateProofRequest["keyHandle"],
    context,
    ringLocation,
    message: toHex(message),
  };
  const response = await client.account.createAccountProof(request).match(
    (value) => value,
    (error) => {
      throw new Error(`${failureMessage} (${hostError(error)}).`);
    },
  );

  if (
    response.contextualAlias.context.toLowerCase() !== expectedContext.toLowerCase()
  ) {
    throw new Error(contextMismatchMessage);
  }

  return {
    proof: fromHex(response.proof),
    contextualAlias: {
      context: fromHex(response.contextualAlias.context),
      alias: fromHex(response.contextualAlias.alias),
    },
    ringIndex: response.ringIndex,
    ringRevision: response.ringRevision,
  };
}
