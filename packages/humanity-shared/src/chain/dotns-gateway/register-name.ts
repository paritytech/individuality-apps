// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * `DotnsGateway.register_name` on Asset Hub: mint the person's full dotNS
 * username and link it to their lite one.
 *
 * The People chain's `Resources.register_person` records the full username
 * too, but dotNS is the source of truth for names (the gateway pallet says so
 * for its own map, and People's copy is being removed), and every host
 * verifies a username it finds against dotNS. A full username that only
 * exists on People is one nobody can find.
 *
 * The transaction is a General (v5) extrinsic (`withAsDotnsGateway`):
 * - `who`: the username owner (`peopl.<tld>/0`, RFC-0028), which must be
 *   `DotnsGateway.LiteLabelOwner[lite label]` and must not already hold a
 *   `DotnsGateway.AccountAlias`;
 * - `label`: the full label, `link`: `LiteUsername(lite label)`;
 * - the ring-VRF proof of full personhood, context `dotnsGateway`, over
 *   `registerNameProofMessage(who, label, link)`, built against a People
 *   ring root revision Asset Hub's `MembersSubscriber` must already hold
 *   (`awaitRingRevision`);
 * - `who`'s raw sr25519 signature over the implication digest.
 *
 * The alias the proof derives can register once, and so can `who`; a second
 * attempt after a successful one answers `already-registered` from the
 * preflight rather than failing on chain.
 */
import { Binary, Enum } from "polkadot-api";
import { fromHex } from "polkadot-api/utils";

import { getAssetHubClient } from "@humanity/shared/chain/asset-hub-client.ts";
import { hostError } from "@humanity/shared/chain/error-detail.ts";
import type { AccountsProvider, TruApi } from "@humanity/shared/chain/host-api.ts";
import {
  membershipRingLocation,
  PERSONHOOD_CONTEXT_INDEX,
  personhoodContext,
} from "@humanity/shared/chain/individuality.ts";
import { createRingVrfProof } from "@humanity/shared/chain/ring-vrf-proof.ts";
import { findDeclaredRingVrfKey, resolveRingVrfKeyHandle } from "@humanity/shared/chain/ring-vrf-key.ts";
import {
  submissionDetail,
  TransactionSubmissionError,
  watchTransactionSubmission,
} from "@humanity/shared/chain/transaction-submission.ts";
import { isPersonhoodProduct, personhoodProductId } from "@humanity/shared/identity/product-domain.ts";
import { loggerFor } from "@humanity/shared/logging/logger.ts";
import { withTimeout } from "@humanity/shared/utils/with-timeout.ts";
import { withAsDotnsGateway } from "./as-dotns-gateway-signer.ts";
import { registerNameProofMessage, type RegisterNameLink } from "./proof-message.ts";
import {
  awaitRingRevision,
  readDotnsGatewayNames,
  readLiteLabelOwner,
  RingRevisionError,
} from "./read-names.ts";

const logger = loggerFor("chain", "dotns-register-name");

const SETUP_TIMEOUT_MS = 15_000;
const CHAIN_PHASE_TIMEOUT_MS = 15_000;
const PROOF_TIMEOUT_MS = 90_000;
/** Mortality era of the registration, in blocks. */
export const DOTNS_REGISTER_NAME_MORTALITY_PERIOD = 256;
const FULL_LABEL_PATTERN = /^[a-z]{6,32}$/;
const LITE_LABEL_PATTERN = /^[a-z0-9-]+\.\d{2,}$/;

export type DotnsNameErrorCode =
  | "invalid-label"
  | "host-missing"
  | "not-lite-owner"
  | "account-already-registered"
  | "ring-not-synced"
  | "proof"
  | "signing"
  | "timeout"
  | "finalized-error";

export class DotnsNameError extends Error {
  readonly code: DotnsNameErrorCode;

  constructor(code: DotnsNameErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "DotnsNameError";
    this.code = code;
  }
}

export interface RegisterDotnsNameArgs {
  /** SS58 of the account owning the lite label (`peopl.<tld>/0`, RFC-0028); `who` on chain. */
  readonly who: string;
  /** The lite username as dotNS holds it, e.g. `alice.42`. */
  readonly liteUsername: string;
  /** The full label to mint: 6–32 lowercase ASCII letters. */
  readonly label: string;
  readonly provider: AccountsProvider;
  readonly truApi: TruApi;
  /** The app's own product name; the ring-VRF key handle is listed under it. */
  readonly productDomain: string;
  /** `who`'s raw sr25519 signature over a 32-byte digest, no `<Bytes>` wrapping. */
  readonly signImplication: (digest: Uint8Array) => Promise<Uint8Array>;
  /** Progress, for the flow's stages and the debug journal. */
  readonly onStage?: (stage: RegisterDotnsNameStage) => void;
}

export type RegisterDotnsNameStage =
  | "setup"
  | "preflight"
  | "proof"
  | "revision"
  | "submit";

export type RegisterDotnsNameResult =
  | { readonly status: "included"; readonly txHash: string }
  | { readonly status: "unknown"; readonly txHash: string }
  | { readonly status: "already-registered" };

export interface RegisterDotnsNameHooks {
  onBroadcast?: (txHash: string, mortalityEnd: number) => void;
  onFinalized?: (outcome: { txHash: string; ok: boolean }) => void;
}

const SIGNING_FAILURE_MESSAGE = "We couldn't submit your dotNS username. Try again shortly.";
const FINALITY_FAILURE_MESSAGE = "We couldn't confirm your dotNS username. Try again shortly.";
const CHAIN_TIMEOUT_MESSAGE = "Asset Hub did not respond in time.";

export async function registerDotnsName(
  args: RegisterDotnsNameArgs,
  hooks: RegisterDotnsNameHooks = {},
): Promise<RegisterDotnsNameResult> {
  const { who, liteUsername, label, provider, truApi, productDomain, signImplication, onStage } = args;
  if (!FULL_LABEL_PATTERN.test(label)) {
    throw new DotnsNameError("invalid-label", `"${label}" is not a full-person label.`);
  }
  if (!LITE_LABEL_PATTERN.test(liteUsername)) {
    throw new DotnsNameError("invalid-label", `"${liteUsername}" is not a lite-person label.`);
  }
  const link: RegisterNameLink = { tag: "LiteUsername", label: liteUsername };

  try {
    onStage?.("setup");
    const { api, client, network } = await withTimeout(
      getAssetHubClient(),
      SETUP_TIMEOUT_MS,
      CHAIN_TIMEOUT_MESSAGE,
    );
    const productAccount = await withTimeout(
      provider.getProductAccount(productDomain, 0).match(
        (value) => value,
        () => null,
      ),
      SETUP_TIMEOUT_MS,
      "The host did not return the product account.",
    );
    if (productAccount == null) {
      throw new DotnsNameError("host-missing", "The host has no product account to submit with.");
    }

    onStage?.("preflight");
    const [names, owner] = await withTimeout(
      Promise.all([readDotnsGatewayNames(who), readLiteLabelOwner(liteUsername)]),
      CHAIN_PHASE_TIMEOUT_MS,
      CHAIN_TIMEOUT_MESSAGE,
    );
    if (names.full === label) {
      logger.info("{who} already holds {label} on the gateway", { who, label });
      return { status: "already-registered" };
    }
    if (names.aliasRegistered || names.full != null) {
      throw new DotnsNameError(
        "account-already-registered",
        `${who} already registered a full name${names.full ? ` (${names.full})` : ""}.`,
      );
    }
    if (owner !== who) {
      throw new DotnsNameError(
        "not-lite-owner",
        `${liteUsername} is owned by ${owner ?? "nobody"} on the gateway, not ${who}.`,
      );
    }

    onStage?.("proof");
    // The key the wallet or this product registered for the People ring,
    // matched by chain and collection, with the location the host declared it
    // under (the only one it proves for). Only the personhood product itself
    // may mint one when none is listed; a deploy under another label must not.
    const listed = await provider.listRingVrfKeys(personhoodProductId(network)).match(
      (keys) => keys,
      () => [],
    );
    const resolved =
      findDeclaredRingVrfKey(listed, membershipRingLocation(network)) ??
      (isPersonhoodProduct()
        ? await resolveRingVrfKeyHandle(provider, productDomain, membershipRingLocation(network))
        : null);
    if (resolved == null) {
      throw new DotnsNameError("proof", "The host lists no Membership ring key for this person.");
    }
    const { handle: keyHandle, ring: ringLocation } = resolved;
    const message = registerNameProofMessage(who, label, link);
    let proof;
    try {
      proof = await withTimeout(
        createRingVrfProof({
          client: truApi,
          keyHandle,
          productId: personhoodProductId(network),
          contextIndex: PERSONHOOD_CONTEXT_INDEX.dotnsGateway,
          expectedContext: personhoodContext(network.dotnsSuffix, "dotnsGateway"),
          ringLocation,
          message,
          failureMessage: "Host could not create the dotNS gateway proof",
          contextMismatchMessage: "Host returned a proof for a different context.",
        }),
        PROOF_TIMEOUT_MS,
        "The host did not produce the personhood proof in time.",
      );
    } catch (cause) {
      throw new DotnsNameError("proof", hostError(cause), { cause });
    }
    logger.info("proof built in ring {ringIndex} at revision {revision}", {
      ringIndex: proof.ringIndex,
      revision: proof.ringRevision,
    });

    onStage?.("revision");
    const collectionJunction = ringLocation.junctions.find((j) => j.tag === "CollectionId");
    if (collectionJunction == null) {
      throw new DotnsNameError("proof", "The People ring location names no collection.");
    }
    try {
      await awaitRingRevision(api, fromHex(collectionJunction.value), proof.ringIndex, proof.ringRevision);
    } catch (cause) {
      if (cause instanceof RingRevisionError) {
        throw new DotnsNameError("ring-not-synced", cause.message, { cause });
      }
      throw cause;
    }

    onStage?.("submit");
    const tx = api.tx.DotnsGateway.register_name({
      who,
      label: Binary.fromText(label),
      link: Enum("LiteUsername", Binary.fromText(liteUsername)),
    });
    const signer = withAsDotnsGateway(provider.getProductAccountSigner(productAccount), {
      proof: proof.proof,
      ringIndex: proof.ringIndex,
      ringRevision: proof.ringRevision,
      signImplication,
    });
    const mortalityStart = await withTimeout(
      client.getFinalizedBlock(),
      CHAIN_PHASE_TIMEOUT_MS,
      CHAIN_TIMEOUT_MESSAGE,
    );
    const result = await watchTransactionSubmission(
      tx,
      signer,
      {
        at: mortalityStart.hash,
        mortality: { mortal: true, period: DOTNS_REGISTER_NAME_MORTALITY_PERIOD },
      },
      {
        signingFailureMessage: SIGNING_FAILURE_MESSAGE,
        finalityFailureMessage: FINALITY_FAILURE_MESSAGE,
        settleOn: "bestBlock",
        onBroadcast: (txHash) =>
          hooks.onBroadcast?.(txHash, mortalityStart.number + DOTNS_REGISTER_NAME_MORTALITY_PERIOD),
        onFinalized: hooks.onFinalized,
      },
    );
    if (result.status === "unknown") {
      logger.error("register_name unconfirmed, tx {txHash}: {detail}", {
        txHash: result.txHash,
        detail: result.detail,
      });
      return { status: "unknown", txHash: result.txHash };
    }
    logger.info("register_name {txHash} included for {who}: {label}", {
      txHash: result.txHash,
      who,
      label,
    });
    return { status: "included", txHash: result.txHash };
  } catch (err) {
    if (err instanceof DotnsNameError) throw err;
    // Every path below rethrows as a `DotnsNameError` carrying `err`, and the
    // claim that called this reports it at error with the decoded cause: a
    // second error here filed each failed attempt to Sentry twice.
    logger.warning("register_name failed: {detail}", { detail: submissionDetail(err) });
    if (err instanceof TransactionSubmissionError) {
      throw new DotnsNameError(
        err.code === "finalized-error" ? "finalized-error" : "signing",
        err.code === "finalized-error" ? FINALITY_FAILURE_MESSAGE : SIGNING_FAILURE_MESSAGE,
        { cause: err },
      );
    }
    if (err instanceof Error && err.message === CHAIN_TIMEOUT_MESSAGE) {
      throw new DotnsNameError("timeout", CHAIN_TIMEOUT_MESSAGE, { cause: err });
    }
    throw new DotnsNameError("signing", SIGNING_FAILURE_MESSAGE, { cause: err });
  }
}
