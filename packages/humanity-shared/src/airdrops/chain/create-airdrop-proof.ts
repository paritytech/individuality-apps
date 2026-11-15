// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import type {
  HexString,
  RingLocation,
  RingVRFProof,
  RingVrfKeyHandle,
  TruApi,
} from "@humanity/shared/chain/host-api.ts";
import { PERSONHOOD_CONTEXT_INDEX } from "@humanity/shared/chain/individuality.ts";
import { createRingVrfProof } from "@humanity/shared/chain/ring-vrf-proof.ts";

export interface CreateAirdropProofArgs {
  client: TruApi;
  keyHandle: RingVrfKeyHandle;
  /** The personhood product the airdrop context is derived under: `peopl.<tld>`. */
  productId: string;
  /**
   * `PeopleAirdrops.people_airdrops_context` as the runtime publishes it — the
   * bytes the chain verifies against, checked against what the host derives.
   */
  expectedContext: HexString;
  ringLocation: RingLocation;
  message: Uint8Array;
}
const FAILURE_MESSAGE = "Host could not create the airdrop proof";
const CONTEXT_MISMATCH_MESSAGE =
  "Host returned an airdrop proof for a different context.";

/**
 * Ask the host to mint the proof over the PeopleAirdrops context.
 *
 * The runtime's context is the personhood product's `peopleAirdrops`
 * derivation, so a stock host can mint it from `{ productId, Index(n) }` —
 * which is the only form it accepts. The published bytes still gate the
 * result, so a host deriving anything else fails before signing.
 */
export async function createAirdropProof({
  client,
  keyHandle,
  productId,
  expectedContext,
  ringLocation,
  message,
}: CreateAirdropProofArgs): Promise<RingVRFProof> {
  return createRingVrfProof({
    client,
    keyHandle,
    productId,
    contextIndex: PERSONHOOD_CONTEXT_INDEX.peopleAirdrops,
    expectedContext,
    ringLocation,
    message,
    failureMessage: FAILURE_MESSAGE,
    contextMismatchMessage: CONTEXT_MISMATCH_MESSAGE,
  });
}
