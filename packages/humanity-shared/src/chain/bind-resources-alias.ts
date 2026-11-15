// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { ss58Encode } from "@parity/product-sdk/address";
import { withAsPerson } from "@parity/product-sdk/individuality";

import { getPeopleClient } from "./client.ts";
import {
  getAccountsProvider,
  getTruApi,
  type AccountsProvider,
  type RingVRFProof,
  type TruApi,
} from "./host-api.ts";
import {
  membershipRingLocation,
  PERSONHOOD_CONTEXT_INDEX,
  personhoodContext,
} from "./individuality.ts";
import { createRingVrfProof } from "./ring-vrf-proof.ts";
import { personhoodProductId } from "@humanity/shared/identity/product-domain.ts";
import { resolveRingVrfKeyHandle } from "./ring-vrf-key.ts";
import { watchTransactionSubmission } from "./transaction-submission.ts";
import { withTimeout } from "@humanity/shared/utils/with-timeout.ts";
import type { NetworkConfig } from "./networks.ts";

const TIMEOUT_MS = 20_000;
const pending = new Map<string, Promise<BindResourcesAliasResult>>();
const broadcasts = new Set<string>();

export type BindResourcesAliasOutcome =
  "already-bound" | "bound" | "submitted-unconfirmed";

export interface BindResourcesAliasResult {
  readonly outcome: BindResourcesAliasOutcome;
  readonly address: string;
  readonly txHash?: string;
}

export class BindResourcesAliasError extends Error {
  constructor(
    readonly stage: "host" | "account" | "chain" | "pending" | "submit",
    detail: string,
  ) {
    super(`Binding the Resources alias failed at ${stage}: ${detail}`);
    this.name = "BindResourcesAliasError";
  }
}

/** Mints a Resources-context personhood proof over a signing payload. */
export type CreateResourcesAliasProof = (
  message: Uint8Array,
) => Promise<RingVRFProof>;

/**
 * Proof factory for the Resources context, minted with this host's key in the
 * full people ring. Authorizes both the first `set_alias_account` binding
 * (`AliasWithProof`) and an `AliasWithAccountRevised` origin once the ring has
 * been rebuilt past the binding's revision.
 *
 * The key is resolved up front, so a host holding none fails here, before any
 * signer is asked for anything. Proofs name the ring location the host
 * declared the key under ({@link resolveRingVrfKeyHandle}), not ours.
 */
export async function resourcesAliasProof(
  provider: AccountsProvider,
  truApi: TruApi,
  network: NetworkConfig,
  productDomain: string,
): Promise<CreateResourcesAliasProof> {
  const { handle: keyHandle, ring: ringLocation } = await resolveRingVrfKeyHandle(
    provider,
    productDomain,
    membershipRingLocation(network),
  );
  const productId = personhoodProductId(network);
  const expectedContext = personhoodContext(network.dotnsSuffix, "resources");
  return (message) =>
    createRingVrfProof({
      client: truApi,
      keyHandle,
      productId,
      contextIndex: PERSONHOOD_CONTEXT_INDEX.resources,
      expectedContext,
      ringLocation,
      message,
      failureMessage: "Host could not create the personhood proof",
      contextMismatchMessage:
        "Host returned a personhood proof for a different context.",
    });
}

/** Product account zero belongs to Resources; Daily Dollar uses a separate
 * derivation. Only the explicit username action may submit this binding. */
export async function bindResourcesAlias(
  network: NetworkConfig,
  productDomain: string,
): Promise<BindResourcesAliasResult> {
  const [provider, truApi, { api, client }] = await withTimeout(
    Promise.all([getAccountsProvider(), getTruApi(), getPeopleClient()]),
    TIMEOUT_MS,
    "The host or People Chain did not respond in time.",
  );
  if (provider == null || truApi == null) {
    throw new BindResourcesAliasError("host", "not running inside a host");
  }
  const account = await withTimeout(
    provider.getProductAccount(productDomain, 0).match(
      (value) => value,
      () => {
        throw new BindResourcesAliasError("account", "account unavailable");
      },
    ),
    TIMEOUT_MS,
    "The host did not return the product account.",
  );
  const address = ss58Encode(account.publicKey, 42);
  const scope = `${network.peopleChain.genesisHash}:${address}`;
  const active = pending.get(scope);
  if (active != null) return active;

  const bind = async (): Promise<BindResourcesAliasResult> => {
    const block = await withTimeout(
      client.getFinalizedBlock(),
      TIMEOUT_MS,
      "People Chain did not respond.",
    );
    const expected = personhoodContext(network.dotnsSuffix, "resources");
    const witness =
      await api.constants.PeopleAirdrops.people_airdrops_context();
    if (
      witness.toLowerCase() !==
      personhoodContext(network.dotnsSuffix, "peopleAirdrops")
    ) {
      throw new BindResourcesAliasError(
        "chain",
        "runtime context does not match this build",
      );
    }
    // Best, not finalized: the binding settles on best-block inclusion, so a
    // retry before finality must see it rather than bind a second time.
    const existing = await withTimeout(
      api.query.People.AccountToAlias.getValue(address, { at: "best" }),
      TIMEOUT_MS,
      "Reading the Resources alias timed out.",
    );
    const storageKey = `humanity:pending-resources-alias:${scope}`;
    if (existing != null) {
      if (existing.ca.context.toLowerCase() !== expected) {
        throw new BindResourcesAliasError(
          "chain",
          "account belongs to another alias context",
        );
      }
      broadcasts.delete(scope);
      try {
        localStorage.removeItem(storageKey);
      } catch {
        /* Storage unavailable. */
      }
      return { outcome: "already-bound", address };
    }

    if (broadcasts.has(scope)) {
      throw new BindResourcesAliasError(
        "pending",
        "a previous binding is still unconfirmed",
      );
    }
    try {
      if (localStorage.getItem(storageKey) != null) {
        throw new BindResourcesAliasError(
          "pending",
          "a previous binding is still unconfirmed",
        );
      }
    } catch (cause) {
      if (cause instanceof BindResourcesAliasError) throw cause;
    }
    const signer = withAsPerson(provider.getProductAccountSigner(account), {
      tag: "AliasWithProof",
      createProof: await resourcesAliasProof(
        provider,
        truApi,
        network,
        productDomain,
      ),
    });
    let broadcast = false;
    try {
      const result = await watchTransactionSubmission(
        api.tx.People.set_alias_account({
          account: address,
          call_valid_at: block.number,
        }),
        signer,
        {},
        {
          signingTimeoutMs: 90_000,
          finalityTimeoutMs: 120_000,
          signingFailureMessage:
            "The Resources alias binding could not be signed.",
          finalityFailureMessage:
            "The Resources alias binding was not confirmed.",
          // The claim that follows is validated against the best block, so
          // waiting for finality here only stacks latency onto the claim.
          settleOn: "bestBlock",
          onBroadcast: (txHash) => {
            broadcast = true;
            broadcasts.add(scope);
            try {
              localStorage.setItem(storageKey, txHash);
            } catch {
              /* Memory lock remains. */
            }
          },
        },
      );
      if (result.status !== "included") {
        return {
          outcome: "submitted-unconfirmed",
          address,
          txHash: result.txHash,
        };
      }
      try {
        localStorage.removeItem(storageKey);
      } catch {
        /* Storage unavailable. */
      }
      broadcasts.delete(scope);
      return { outcome: "bound", address, txHash: result.txHash };
    } catch (cause) {
      // A finalized failure is safe to retry; a transport/signing failure after
      // broadcast may still land. Keep its lock until chain state confirms it.
      if (
        !broadcast ||
        (cause instanceof Error &&
          "code" in cause &&
          cause.code === "finalized-error")
      ) {
        broadcasts.delete(scope);
        try {
          localStorage.removeItem(storageKey);
        } catch {
          /* Storage unavailable. */
        }
      }
      throw cause;
    }
  };
  const operation = bind();
  pending.set(scope, operation);
  try {
    const result = await operation;
    pending.delete(scope);
    return result;
  } catch (cause) {
    pending.delete(scope);
    throw cause;
  }
}
