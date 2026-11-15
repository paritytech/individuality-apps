// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { ProductAccountSigner } from "@humanity/shared/chain/host-api.ts";
import type { people } from "@polkadot-api/descriptors";
import { ss58Encode } from "@parity/product-sdk/address";
import { Binary } from "polkadot-api";
import type { TypedApi } from "polkadot-api";
import type {
  AccountsProvider,
  TruApi,
} from "@humanity/shared/chain/host-api.ts";
import { resolveNetwork } from "@humanity/shared/chain/networks.ts";
import { personhoodContext } from "@humanity/shared/chain/individuality.ts";
import {
  bindResourcesAlias,
  BindResourcesAliasError,
} from "@humanity/shared/chain/bind-resources-alias.ts";
import { ringIdentifier } from "@humanity/shared/chain/ring-membership.ts";
import { submissionDetail } from "@humanity/shared/chain/transaction-submission.ts";
import { loggerFor } from "@humanity/shared/logging/logger.ts";
import { productDomain } from "@humanity/shared/identity/product-domain.ts";
import { parseHumanityUserId } from "@humanity/shared/identity/humanity-user-id.ts";
import { envConfig } from "@humanity/shared/config/env.ts";
import { withTimeout } from "@humanity/shared/utils/with-timeout.ts";
import { UsernameUpgradeError } from "./username-upgrade-errors.ts";
import type { UsernameUpgradeMethod } from "./upgrade-lite-username.ts";
import { resolveLiteOwner } from "./resolve-lite-owner.ts";
import { signLiteIdentityProofUnwatermarked } from "./sign-lite-identity-proof.ts";

const logger = loggerFor("card", "username-upgrade");
const CHAIN_PHASE_TIMEOUT_MS = 15_000;
const SS58_PREFIX = 42;
const CHAIN_TIMEOUT_MESSAGE = "People Chain did not respond in time.";
const ACCOUNT_MISSING_MESSAGE =
  "We couldn't find your People Chain account. Try again shortly.";
const OWNER_MISMATCH_MESSAGE =
  "Your lite identity changed on People Chain. Refresh and try again.";
const SIGNER_ACCOUNT_MISSING_MESSAGE =
  "We couldn't find this app's People Chain account. Try again shortly.";
const LITE_OWNER_UNAVAILABLE_MESSAGE =
  "Your username is held by an account this app can't sign with. Upgrade it from the wallet that claimed it.";
const USERNAME_TAKEN_MESSAGE = "That username is already taken.";
const MISSING_ALIAS_MESSAGE =
  "This app can't act as your person yet: its People Chain account has no Resources alias.";
const ALIAS_BINDING_FAILED_MESSAGE =
  "We couldn't register this app as your person. Try again shortly.";
const ALIAS_CONTEXT_MISMATCH_MESSAGE =
  "This app's People Chain account is already bound to a different alias context.";
const CONTEXT_MISMATCH_MESSAGE =
  "This build doesn't match People Chain. Update the app and try again.";
const PENDING_MESSAGE =
  "We're still confirming your previous username upgrade. Refresh and check again shortly.";
const RING_UNAVAILABLE_MESSAGE =
  "The People ring your person is in is unavailable. Try again shortly.";
const DERIVATION_WITNESS = "peopleAirdrops" as const;
/** What the upgrade needs from the host wallet. */
interface UpgradeAccounts {
  readonly productAddress: string;
  readonly productSigner: ProductAccountSigner;
  /**
   * Sign the Resources alias as the lite username's on-chain owner, with no
   * `<Bytes>` watermark, straight through truAPI.
   * `Resources.register_person` verifies the raw alias.
   */
  readonly signLiteIdentityProof: (alias: Uint8Array) => Promise<Uint8Array>;
  readonly litePublicKey: Uint8Array;
}

/** On-chain state checked before either signer is used. */
interface ChainPreflight {
  readonly aliasBytes: Uint8Array;
  readonly nonce: number;
  /** `Reservation` iff the lite identity heads the name's reservation queue. */
  readonly usernameChoice: "Standalone" | "Reservation";
  /**
   * The people ring has been rebuilt since the alias was bound. The chain then
   * rejects `AliasWithAccount` as `BadSigner`, so the claim must ride
   * `AliasWithAccountRevised` with a fresh proof, which also re-pins the
   * binding to the current revision.
   */
  readonly aliasRevisionStale: boolean;
}

export async function resolveUpgradeAccounts(
  provider: AccountsProvider,
  truApi: TruApi,
  expectedLiteAddress: string,
): Promise<UpgradeAccounts> {
  const [identity, productAccount, liteOwner] = await Promise.all([
    provider.getUserId().match(
      ({ primaryUsername }) => parseHumanityUserId(primaryUsername) ?? null,
      () => null,
    ),
    provider.getProductAccount(productDomain(), 0).match(
      (account) => account,
      () => null,
    ),
    resolveLiteOwner(
      provider,
      resolveNetwork(envConfig.chain.network),
      expectedLiteAddress,
    ),
  ]);

  if (identity == null) {
    throw new UsernameUpgradeError("account-missing", ACCOUNT_MISSING_MESSAGE);
  }
  if (productAccount == null) {
    throw new UsernameUpgradeError(
      "signer-account-missing",
      SIGNER_ACCOUNT_MISSING_MESSAGE,
    );
  }
  // Never sign with an account the chain does not name as the owner: a
  // signature from anything else fails `verify` on-chain after the user has
  // already approved it. Checked here so the mismatch is a preflight error.
  if (
    liteOwner == null ||
    ss58Encode(liteOwner.account.publicKey, SS58_PREFIX) !== expectedLiteAddress
  ) {
    throw new UsernameUpgradeError(
      "lite-owner-unavailable",
      LITE_OWNER_UNAVAILABLE_MESSAGE,
    );
  }
  return {
    productAddress: ss58Encode(productAccount.publicKey, SS58_PREFIX),
    productSigner: provider.getProductAccountSigner(productAccount),
    litePublicKey: liteOwner.account.publicKey,
    signLiteIdentityProof: (alias) =>
      signLiteIdentityProofUnwatermarked(
        truApi,
        liteOwner.domain,
        liteOwner.account.publicKey,
        alias,
      ),
  };
}

const BEST = { at: "best" } as const;

export async function preflightUpgradeChain(
  api: TypedApi<typeof people>,
  currentLiteUsername: string,
  fullUsername: string,
  expectedLiteAddress: string,
  productAddress: string,
  method: UsernameUpgradeMethod,
): Promise<ChainPreflight> {
  const read = <T>(promise: Promise<T>) =>
    withTimeout(promise, CHAIN_PHASE_TIMEOUT_MS, CHAIN_TIMEOUT_MESSAGE);
  const owner = await read(
    api.query.Resources.UsernameOwnerOf.getValue(
      Binary.fromText(currentLiteUsername),
    ),
  );
  if (owner !== expectedLiteAddress) {
    throw new UsernameUpgradeError("owner-mismatch", OWNER_MISMATCH_MESSAGE);
  }

  const taken = await read(
    api.query.Resources.UsernameOwnerOf.getValue(Binary.fromText(fullUsername)),
  );
  if (taken != null) {
    throw new UsernameUpgradeError("username-taken", USERNAME_TAKEN_MESSAGE);
  }

  const reservations = await read(
    api.query.Resources.UsernameReservationQueue.getValue(
      Binary.fromText(fullUsername),
    ),
  );
  // Runtime: `Standalone` rejects any queue; `Reservation` needs the linked lite identity at the front.
  let usernameChoice: ChainPreflight["usernameChoice"] = "Standalone";
  if (reservations != null && reservations.length > 0) {
    if (reservations[0]?.account !== expectedLiteAddress) {
      throw new UsernameUpgradeError("username-taken", USERNAME_TAKEN_MESSAGE);
    }
    usernameChoice = "Reservation";
  }

  // The alias must carry `indiv_pallet_resources::Pallet::resources_context()`
  // or `register_person` dispatches as a bad origin. Derived from the network's
  // DotNS suffix rather than pinned as hex: `individuality` commit `0fec7071`
  // replaced the literal `pop:polkadot.network/resources  ` with a
  // product-scoped hash, and the pinned copy went on passing this preflight
  // while the chain disagreed.
  const { dotnsSuffix } = resolveNetwork(envConfig.chain.network);
  const witness = await read(
    api.constants.PeopleAirdrops.people_airdrops_context(),
  );
  if (
    witness.toLowerCase() !== personhoodContext(dotnsSuffix, DERIVATION_WITNESS)
  ) {
    throw new UsernameUpgradeError(
      "context-mismatch",
      CONTEXT_MISMATCH_MESSAGE,
    );
  }

  // The alias binding and this claim both settle on best-block inclusion, so
  // the alias and the nonce are read at best: a binding included moments ago
  // is not finalized yet.
  let alias = await read(
    api.query.People.AccountToAlias.getValue(productAddress, BEST),
  );
  if (alias == null && method === "truapi") {
    try {
      const binding = await bindResourcesAlias(
        resolveNetwork(envConfig.chain.network),
        productDomain(),
      );
      if (binding.outcome === "submitted-unconfirmed") {
        throw new UsernameUpgradeError("pending", PENDING_MESSAGE);
      }
    } catch (cause) {
      if (cause instanceof UsernameUpgradeError) throw cause;
      if (
        cause instanceof BindResourcesAliasError &&
        cause.stage === "pending"
      ) {
        throw new UsernameUpgradeError("pending", PENDING_MESSAGE, { cause });
      }
      logger.error("resources alias binding failed: {detail}", {
        detail: submissionDetail(cause),
      });
      throw new UsernameUpgradeError(
        "alias-binding-failed",
        ALIAS_BINDING_FAILED_MESSAGE,
        { cause },
      );
    }
    alias = await read(
      api.query.People.AccountToAlias.getValue(productAddress, BEST),
    );
  }
  if (alias == null) {
    throw new UsernameUpgradeError("missing-alias", MISSING_ALIAS_MESSAGE);
  }
  if (
    alias.ca.context.toLowerCase() !==
    personhoodContext(dotnsSuffix, "resources")
  ) {
    throw new UsernameUpgradeError(
      "alias-context-mismatch",
      ALIAS_CONTEXT_MISMATCH_MESSAGE,
    );
  }

  // `AliasWithAccount` is valid only while the binding's revision is the
  // ring's current root revision (same read as `readPeopleAirdropsSigning`
  // makes for the airdrops context). Read at best, with the alias.
  const [{ nonce }, root] = await Promise.all([
    read(api.query.System.Account.getValue(productAddress, BEST)),
    read(
      api.query.Members.Root.getValue(
        ringIdentifier("people"),
        alias.ring,
        BEST,
      ),
    ),
  ]);
  if (root == null) {
    throw new UsernameUpgradeError(
      "ring-unavailable",
      RING_UNAVAILABLE_MESSAGE,
    );
  }
  return {
    aliasBytes: Binary.fromHex(alias.ca.alias),
    nonce,
    usernameChoice,
    aliasRevisionStale: root.revision !== alias.revision,
  };
}
