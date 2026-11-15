// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Host-side probe of the Resources contextual alias.
 *
 * `register_person` dispatches only when the signer holds an alias in
 * `People.AccountToAlias` carrying `resources_context()`. Three independent
 * things can be wrong, and on-chain state alone cannot tell them apart:
 *
 * 1. the context this app derives disagrees with the runtime's, or the host
 *    refuses to serve the `peopl` product context to this app, or
 * 2. the context is right and the alias simply was never bound on chain, or
 * 3. no key is registered for the people ring, so the host has no member key
 *    to derive any alias with. `listRingVrfKeys` settles this one.
 *
 * `getProductAccountAlias` answers (1): it returns the alias the user's person
 * key *would* produce for a context and ring, without needing any binding. It
 * deliberately cannot answer (2) — deriving an alias is not binding it, and
 * nothing exposed to JS can submit the `People.set_alias_account` that binds.
 */

import {
  findRingVrfKeyHandle,
  getAccountsProvider,
  toHex,
  type AccountsProvider,
  type ProductProofContext,
  type RingLocation,
  type RingVrfKeyHandle,
} from "@humanity/shared/chain/host-api.ts";
import { personhoodProductId } from "@humanity/shared/identity/product-domain.ts";
import { monotonicNow } from "@humanity/shared/utils/monotonic-now.ts";

import {
  PERSONHOOD_CONTEXT_INDEX,
  membershipRingLocation,
  personhoodContext,
} from "./individuality.ts";
import type { NetworkConfig } from "./networks.ts";

/** The personhood product owning every personhood context, per RFC-0022. */
const PERSONHOOD_PRODUCT_NAME = "peopl";

export function resourcesProofContext(
  network: NetworkConfig,
): ProductProofContext {
  return {
    productId: `${PERSONHOOD_PRODUCT_NAME}.${network.dotnsSuffix}`,
    suffix: { tag: "Index", value: PERSONHOOD_CONTEXT_INDEX.resources },
  };
}

export type ResourcesAliasOutcome =
  /** Host served an alias whose context matches what this app derives. */
  | "match"
  /** Host served an alias bound to a different context than we derive. */
  | "context-mismatch"
  /** Not `rejected`: the registration is ours to make, not the host's. */
  | "no-ring-key"
  /** Host refused: no such ring, not a member, or the context is not ours. */
  | "rejected"
  /**
   * The call threw rather than answering — the host adapter has no
   * `getAccountAlias`, or the bridge dropped the frame. Distinct from
   * `rejected`, which is the host declining on purpose.
   */
  | "threw"
  /**
   * Started and never settled. Recorded before the host call so a hung bridge
   * reads as a stuck probe rather than one that never ran.
   */
  | "pending"
  /** No host container, so nothing to ask. */
  | "unavailable";

export interface ResourcesAliasDiagnostics {
  readonly outcome: ResourcesAliasOutcome;
  /** Context this build derives for Resources. */
  readonly derivedContext: string;
  /** Context the host bound the alias to, when it served one. */
  readonly hostContext?: string;
  /** Alias the host derived, when it served one. */
  readonly alias?: string;
  /** Registry searched for the handle, once listing ran. */
  readonly keyOwner?: string;
  readonly elapsedMs: number;
  readonly error?: string;
}

let diagnostics: ResourcesAliasDiagnostics | undefined;

/** The outcome of the most recent Resources-alias host probe. */
export function getResourcesAliasDiagnostics():
  ResourcesAliasDiagnostics | undefined {
  return diagnostics;
}

/**
 * `call` is named because one `rejected` outcome covers two host calls. Only
 * truapi's `Unknown` carries a `reason`; a non-envelope error stringifies as-is.
 */
export function describeHostError(call: string, error: unknown): string {
  if (typeof error !== "object" || error == null || !("tag" in error)) {
    return `${call}: ${String(error)}`;
  }
  const tag = String(error.tag);
  const detail =
    "value" in error &&
    typeof error.value === "object" &&
    error.value != null &&
    "reason" in error.value
      ? String((error.value as { reason: unknown }).reason)
      : null;
  return detail == null ? `${call}: ${tag}` : `${call}: ${tag}, ${detail}`;
}

type RingKeyLookup =
  | { readonly tag: "found"; readonly handle: RingVrfKeyHandle }
  | { readonly tag: "absent" }
  | { readonly tag: "refused"; readonly error: string };

/**
 * Via the SDK helper: it matches the whole junction path, where a `chainId`-only
 * check would pick a key registered for a different ring on the same chain.
 */
async function resolveRingKeyHandle(
  provider: AccountsProvider,
  owner: string,
  ring: RingLocation,
): Promise<RingKeyLookup> {
  return provider.listRingVrfKeys(owner).match(
    (keys): RingKeyLookup => {
      const handle = findRingVrfKeyHandle(keys, ring);
      return handle == null ? { tag: "absent" } : { tag: "found", handle };
    },
    (error): RingKeyLookup => ({
      tag: "refused",
      error: describeHostError("listRingVrfKeys", error),
    }),
  );
}

/**
 * Ask the host for the Resources alias and record how its answer compares with
 * the locally derived context. Never throws: a probe that cannot run is a
 * diagnostic outcome, not a failure the caller has to handle.
 */
export async function probeResourcesAlias(
  network: NetworkConfig,
): Promise<ResourcesAliasDiagnostics> {
  const startedAt = monotonicNow();
  const derivedContext = personhoodContext(network.dotnsSuffix, "resources");
  const elapsed = () => Math.round(monotonicNow() - startedAt);
  // Above the try so the catch branch can report it. `peopl.<suffix>`, the
  // personhood product on this network — see `product-domain.ts` for why the
  // keys follow the network suffix.
  const keyOwner: string = personhoodProductId(network);

  // Claim the slot before touching the host, so a probe that hangs or throws
  // never reads back as "not run" — the state that told us nothing when the
  // Resources alias first came up empty.
  diagnostics = { outcome: "pending", derivedContext, elapsedMs: 0 };

  try {
    const provider = await getAccountsProvider();
    if (provider == null) {
      diagnostics = {
        outcome: "unavailable",
        derivedContext,
        elapsedMs: elapsed(),
      };
      return diagnostics;
    }

    const ring = membershipRingLocation(network);

    const lookup = await resolveRingKeyHandle(provider, keyOwner, ring);
    if (lookup.tag === "refused") {
      diagnostics = {
        outcome: "rejected",
        derivedContext,
        keyOwner,
        elapsedMs: elapsed(),
        error: lookup.error,
      };
      return diagnostics;
    }
    if (lookup.tag === "absent") {
      diagnostics = {
        outcome: "no-ring-key",
        derivedContext,
        keyOwner,
        elapsedMs: elapsed(),
      };
      return diagnostics;
    }

    const context: ProductProofContext = {
      productId: `${PERSONHOOD_PRODUCT_NAME}.${network.dotnsSuffix}`,
      suffix: { tag: "Index", value: PERSONHOOD_CONTEXT_INDEX.resources },
    };

    diagnostics = await provider
      .getProductAccountAlias(lookup.handle, context, ring)
      .match(
        (contextualAlias): ResourcesAliasDiagnostics => {
          const hostContext = toHex(contextualAlias.context);
          return {
            outcome:
              hostContext === derivedContext ? "match" : "context-mismatch",
            derivedContext,
            hostContext,
            alias: toHex(contextualAlias.alias),
            keyOwner,
            elapsedMs: elapsed(),
          };
        },
        (error): ResourcesAliasDiagnostics => ({
          outcome: "rejected",
          derivedContext,
          keyOwner,
          elapsedMs: elapsed(),
          error: describeHostError("getProductAccountAlias", error),
        }),
      );
  } catch (cause) {
    diagnostics = {
      outcome: "threw",
      derivedContext,
      keyOwner,
      elapsedMs: elapsed(),
      error:
        cause instanceof Error
          ? `${cause.name}: ${cause.message}`
          : String(cause),
    };
  }
  return diagnostics;
}
