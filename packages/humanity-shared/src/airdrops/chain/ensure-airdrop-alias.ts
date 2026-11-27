// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import type { PeopleApi } from "@humanity/shared/chain/client.ts";
import type { ProductAccountSigner } from "@humanity/shared/chain/host-api.ts";
import type { PolkadotClient } from "polkadot-api";

import {
  getTruApi,
  toHex,
  type RingLocation,
  type RingVrfKeyHandle,
  type TruApi,
} from "@humanity/shared/chain/host-api.ts";
import {
  individualityChain,
  membershipRingLocation,
  readPeopleAirdropsSigning,
  withAsPerson,
} from "@humanity/shared/chain/individuality.ts";
import {
  TransactionSubmissionError,
  watchTransactionSubmission,
} from "@humanity/shared/chain/transaction-submission.ts";
import {
  RingVrfKeyError,
  resolveRingVrfKeyHandle,
  type ResolvedRingVrfKey,
} from "@humanity/shared/chain/ring-vrf-key.ts";
import { personhoodProductId } from "@humanity/shared/identity/product-domain.ts";
import type { NetworkConfig } from "@humanity/shared/chain/networks.ts";

import type { Hex32 } from "@individuality/daily-dollar";

import type { AirdropAccount } from "./airdrop-account.ts";
import { createAirdropProof } from "./create-airdrop-proof.ts";
import {
  clearPendingAliasBinding,
  hasPendingAliasBinding,
  setPendingAliasBinding,
} from "./pending-alias-binding.ts";

const SIGNING_TIMEOUT_MS = 60_000;
const FINALITY_TIMEOUT_MS = 120_000;

const SIGNING_FAILURE_MESSAGE =
  "We couldn't bind your Daily Dollar identity. Try again shortly.";
const FINALITY_FAILURE_MESSAGE =
  "We couldn't confirm your Daily Dollar identity. Try again shortly.";

export interface EnsureAirdropAliasArgs {
  api: PeopleApi;
  client: PolkadotClient;
  network: NetworkConfig;
  account: AirdropAccount;
}

export interface AirdropAliasAuthorization {
  readonly alias: Hex32;
  readonly signer: ProductAccountSigner;
}

interface AirdropProofAccess {
  readonly ringLocation: RingLocation;
  readonly keyHandle: RingVrfKeyHandle;
  /**
   * `peopl.<tld>` — both the owner of the ring key and the product the
   * PeopleAirdrops context is derived under, so the proof request names the
   * same product the key was registered by.
   */
  readonly productId: string;
  readonly truApi: TruApi;
}

/**
 * This host is not the device that attested the person, so it can never mint
 * the proof an alias binding needs. Typed so a caller can tell "not this
 * device" - a standing fact about the host, worth one check an hour - from a
 * chain or signing failure worth retrying on the next beat.
 */
export class NotAttestedDeviceError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "NotAttestedDeviceError";
  }
}

/**
 * Resolve the host handle the airdrop proof is minted with, and stop when this
 * host holds no full-person ring-VRF key for the personhood product.
 *
 * Same lookup as membership promotion (`readFullPersonhood`): list the
 * registry, and when it names no handle for the ring, register at the
 * personhood index and list again. On a host whose registry is fresh - first
 * open on a device, a reinstall - the attested key is in the keystore but the
 * registry has not named it for this ring yet, and `registerRingVrfKey` under
 * `peopl.<tld>` re-derives exactly that key. Listing alone used to lose that
 * race against the promotion flow by seconds, and `registerForDraws` then
 * remembered "not this device" for an hour.
 *
 * The owner has to be the reserved personhood product: registering under the
 * deploy's own product id derives a key no ring contains, and every proof
 * minted with it fails as `NotMember` far from its cause (af54520).
 *
 * Only `RingVrfKeyError("missing")` - the host accepted a registration and
 * still names no handle for the ring - means this device never attested the
 * person. A host that declines to list or register is a transient failure the
 * caller retries on the next beat.
 */
async function resolveAirdropProofAccess(
  network: NetworkConfig,
  account: AirdropAccount,
): Promise<AirdropProofAccess> {
  const ringLocation = membershipRingLocation(network);
  const keyOwner = personhoodProductId(network);
  let resolved: ResolvedRingVrfKey;
  try {
    resolved = await resolveRingVrfKeyHandle(account.provider, keyOwner, ringLocation);
  } catch (error) {
    if (error instanceof RingVrfKeyError && error.stage === "missing") {
      const ring = `${ringLocation.chainId} [${ringLocation.junctions
        .map((junction) => `${junction.tag}=${junction.value}`)
        .join("/")}]`;
      throw new NotAttestedDeviceError(
        `this host holds no full-personhood ring-VRF key under ${keyOwner} for ring ${ring}, ` +
          `so it was never the attested device for this person; only PeopleLite.attest ` +
          `enrols a key in that ring`,
        { cause: error },
      );
    }
    throw new Error("The host could not read your personhood key.", { cause: error });
  }

  const truApi = await getTruApi();
  if (truApi == null) {
    throw new Error("The host proof API is not available in this build.");
  }
  // The host's declared location, not ours: it proves for that one only.
  return { ringLocation: resolved.ring, keyHandle: resolved.handle, productId: keyOwner, truApi };
}

/**
 * Ensure the dedicated airdrop account is bound to the runtime's
 * PeopleAirdrops context. Binding is a one-time, proof-authorised transaction;
 * subsequent register and claim calls use the cheaper account-bound origin.
 */
export async function ensureAirdropAlias({
  api,
  client,
  network,
  account,
}: EnsureAirdropAliasArgs): Promise<AirdropAliasAuthorization> {
  const [head] = await client.getBestBlocks();
  if (head == null) throw new Error("People Chain reported no best block");
  // The binding and the ring root are read at the block `set_alias_account`
  // below is made valid at, so the decision and the call cannot disagree.
  const signing = await readPeopleAirdropsSigning(individualityChain(client, api), {
    account: account.address,
    at: { blockHash: head.hash, blockNumber: head.number },
  });
  if (!signing.ok) throw signing.error;
  const plan = signing.value;

  if (plan.tag === "Bound") {
    return {
      alias: plan.alias as Hex32,
      signer: withAsPerson(account.signer, { tag: "AliasWithAccount" }),
    };
  }
  if (plan.tag === "Revised") {
    const { ringLocation, keyHandle, productId, truApi } =
      await resolveAirdropProofAccess(network, account);
    return {
      alias: plan.alias as Hex32,
      signer: withAsPerson(account.signer, {
        tag: "AliasWithAccountRevised",
        createProof: (message) =>
          createAirdropProof({
            client: truApi,
            keyHandle,
            productId,
            expectedContext: plan.aliasContext as Hex32,
            ringLocation,
            message,
          }),
      }),
    };
  }
  if (plan.tag === "RingUnavailable") {
    throw new Error(
      "The People ring for your Daily Dollar identity is unavailable.",
    );
  }
  if (plan.tag === "OtherContext") {
    throw new Error(
      "Your Daily Dollar account is already bound to a different identity context.",
    );
  }
  if (hasPendingAliasBinding(account.address)) {
    throw new TransactionSubmissionError(
      "signing",
      "Your Daily Dollar identity is still being confirmed. Try again shortly.",
      `a set_alias_account broadcast for ${account.address} is still marked pending, so this attempt was refused before signing`,
    );
  }

  const { ringLocation, keyHandle, productId, truApi } =
    await resolveAirdropProofAccess(network, account);

  let createdAlias: Hex32 | null = null;
  const signer = withAsPerson(
    account.signer,
    {
      tag: "AliasWithProof",
      createProof: async (message) => {
        const proof = await createAirdropProof({
          client: truApi,
          keyHandle,
          productId,
          expectedContext: plan.airdropsContext as Hex32,
          ringLocation,
          message,
        });
        createdAlias = toHex(proof.contextualAlias.alias) as Hex32;
        return proof;
      },
    },
  );
  const tx = api.tx.People.set_alias_account({
    account: account.address,
    call_valid_at: head.number,
  });

  let broadcastTxHash: string | null = null;
  let outcome: Awaited<ReturnType<typeof watchTransactionSubmission>>;
  try {
    outcome = await watchTransactionSubmission(
      tx,
      signer,
      {},
      {
        signingTimeoutMs: SIGNING_TIMEOUT_MS,
        finalityTimeoutMs: FINALITY_TIMEOUT_MS,
        signingFailureMessage: SIGNING_FAILURE_MESSAGE,
        finalityFailureMessage: FINALITY_FAILURE_MESSAGE,
        onBroadcast: (txHash) => {
          broadcastTxHash = txHash;
          setPendingAliasBinding(account.address, txHash);
        },
      },
    );
  } catch (cause) {
    if (broadcastTxHash != null) {
      clearPendingAliasBinding(account.address, broadcastTxHash);
    }
    throw cause;
  }
  if (outcome.status === "unknown") {
    throw new TransactionSubmissionError(
      "signing",
      SIGNING_FAILURE_MESSAGE,
      `set_alias_account ${outcome.txHash} for ${account.address} was broadcast but never finalized: ${outcome.detail}`,
    );
  }
  if (broadcastTxHash != null) {
    clearPendingAliasBinding(account.address, broadcastTxHash);
  }
  if (createdAlias == null) {
    throw new Error("The host did not return the bound Daily Dollar alias.");
  }
  return {
    alias: createdAlias,
    signer: withAsPerson(account.signer, { tag: "AliasWithAccount" }),
  };
}
