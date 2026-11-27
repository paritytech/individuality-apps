// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { Binary, Enum } from "polkadot-api";
import { withAsPerson } from "@parity/product-sdk/individuality";

import {
  resourcesAliasProof,
  type CreateResourcesAliasProof,
} from "@humanity/shared/chain/bind-resources-alias.ts";
import { resetClientCache } from "@humanity/shared/chain/connection.ts";
import { usernameSigningContext } from "@humanity/shared/chain/username-signing-context.ts";
import { getPeopleClient } from "@humanity/shared/chain/client.ts";
import { getAccountsProvider, getTruApi } from "@humanity/shared/chain/host-api.ts";
import { resolveNetwork } from "@humanity/shared/chain/networks.ts";
import { envConfig } from "@humanity/shared/config/env.ts";
import { productDomain } from "@humanity/shared/identity/product-domain.ts";
import {
  submissionDetail,
  TransactionSubmissionError,
  watchTransactionSubmission,
} from "@humanity/shared/chain/transaction-submission.ts";
import { loggerFor } from "@humanity/shared/logging/logger.ts";
import { runFlow, type FlowRun } from "@humanity/shared/telemetry/flow.ts";
import {
  clearPendingUsernameUpgrade,
  hasPendingUsernameUpgrade,
  markPendingUsernameUpgradeIncluded,
  recordFailedUsernameUpgrade,
  setPendingUsernameUpgrade,
} from "./pending-username-upgrade.ts";
import { withTimeout } from "@humanity/shared/utils/with-timeout.ts";
import {
  resolveUpgradeAccounts,
  preflightUpgradeChain,
} from "./username-upgrade-preflight.ts";
import { UsernameUpgradeError } from "./username-upgrade-errors.ts";
import { verifyLiteIdentityProof } from "./verify-lite-identity-proof.ts";
import { registerPersonProofMessage } from "./register-person-proof.ts";
export { UsernameUpgradeError } from "./username-upgrade-errors.ts";

/**
 * Which authorization route the upgrade takes.
 *
 * `register_person` itself is identical either way — a signed origin carrying
 * `AsPersonalAliasWithAccount`. They differ only in whether the run first
 * creates the `People.AccountToAlias` row that origin resolves from:
 *
 * - `product-sdk` submits `register_person` alone. It succeeds only if the
 *   alias was already bound by something else (today, the mobile wallet).
 * - `truapi` first submits `People.set_alias_account`, authorized by a ring-VRF
 *   proof supplied to the SDK's V5 signer, then submits the same call.
 */
export type UsernameUpgradeMethod = "product-sdk" | "truapi";

export interface UpgradeLiteUsernameArgs {
  /** SS58-42 account owning the current lite username; must still hold it on-chain. */
  expectedLiteAddress: string;
  /** Normalized current lite username (e.g. `alice.42`), as `UsernameOwnerOf` keys it. */
  currentLiteUsername: string;
  /** Requested full person username: 6–32 lowercase ASCII letters. */
  fullUsername: string;
  /** Defaults to binding the Resources alias; product-sdk is a debug-only prebound path. */
  method?: UsernameUpgradeMethod;
}

export type UpgradeLiteUsernameResult =
  | { status: "included"; txHash: string }
  | { status: "unknown"; txHash: string };

export interface UpgradeLiteUsernameHooks {
  /** Called once the included claim is finalized, either outcome. A failed
   *  outcome has already retired the marker and recorded the failure; a
   *  successful one leaves the marker for the finalized card read. */
  onFinalized?: () => void;
}

const logger = loggerFor("card", "username-upgrade");
/** Parallel account + client setup deadline in milliseconds. */
const SETUP_TIMEOUT_MS = 15_000;
/** Deadline for account resolution and each chain preflight read. */
const CHAIN_PHASE_TIMEOUT_MS = 15_000;
/** Deadline for the lite identity account's raw proof signature. */
const SIGNING_TIMEOUT_MS = 60_000;
/** Mortality era of the upgrade transaction, in blocks. */
export const USERNAME_UPGRADE_MORTALITY_PERIOD = 256;

const CHAIN_TIMEOUT_MESSAGE = "People Chain did not respond in time.";
const ACCOUNT_MISSING_MESSAGE =
  "We couldn't find your People Chain account. Try again shortly.";

const INVALID_USERNAME_MESSAGE = "Usernames must be 6–32 lowercase letters.";
const SETUP_FAILURE_MESSAGE =
  "We couldn't refresh People Chain. Try again shortly.";
const SIGNING_FAILURE_MESSAGE =
  "We couldn't submit your username upgrade. Try again shortly.";
const FINALITY_FAILURE_MESSAGE =
  "We couldn't confirm your username upgrade. Try again shortly.";
const PENDING_MESSAGE =
  "We're still confirming your previous username upgrade. Refresh and check again shortly.";
const SIGNING_TIMEOUT_MESSAGE = "The wallet did not respond in time.";
const ALIAS_REVISION_FAILED_MESSAGE =
  "We couldn't refresh this app's link to your person. Try again shortly.";

const FULL_USERNAME_PATTERN = /^[a-z]{6,32}$/;

/**
 * Upgrade the connected lite identity to a full person with a fresh
 * username. The current username owner (lite identity account) signs the
 * product account's alias bytes for `lite_identity_proof`; the app product
 * account signs and submits `Resources.register_person` with
 * `VerifyMultiSignature: Disabled` and
 * `AsPerson.AsPersonalAliasWithAccount(product nonce)`. All host and chain
 * ownership and name availability are checked before binding, and the upgrade
 * permanently links the lite and full identities on-chain.
 *
 * - The username must be 6–32 lowercase ASCII letters before any host access.
 * - A pending marker from an earlier broadcast (an `unknown` result or a
 *   reload mid-flight) rejects the attempt with `pending` before any host
 *   access.
 * - The host identity must resolve, the lite identity account must hold
 *   `expectedLiteAddress`, the on-chain `UsernameOwnerOf` of the current lite
 *   username must be unchanged, and the requested username must be unowned
 *   with an empty `UsernameReservationQueue` (claimed `Standalone`) or with
 *   `expectedLiteAddress` at the queue front (claimed `Reservation`); the
 *   product account must hold a `People.AccountToAlias` mapping in the
 *   Resources context.
 * - Setup, account resolution, chain preflight, the era-checkpoint read, and
 *   lite-owner signing each have their own deadline; the client cache is reset
 *   only when the setup deadline fires.
 * - The claim resolves `included` as soon as it is in a best block, so the UI
 *   can move on without waiting for finality. The pending marker is persisted
 *   in phase `broadcast` on first broadcast (replacing any earlier failed
 *   record) and advanced to `included` before that result is returned, so
 *   the card can show the full username optimistically. A successful
 *   finalization does not retire it: the finalized card read does once it
 *   sees the full identity, or the best-block reconciliation does if the
 *   claim is gone. A reload before finality, or a reorg that drops the
 *   claim, therefore still disables resubmission until one of those or the
 *   marker's era expiry. An `unknown` result keeps the `broadcast` marker.
 * - A claim that fails dispatch — in the best block (`finalized-error`) or
 *   at finality — clears its marker and records a failed upgrade for
 *   `expectedLiteAddress`, so the claim page can offer the name again.
 *
 * @throws UsernameUpgradeError on invalid username, a pending earlier
 *   broadcast, account unavailability, chain preflight failure, phase timeout,
 *   signing failure, or an included `!ok`.
 */
export function upgradeLiteUsername(
  args: UpgradeLiteUsernameArgs,
  hooks: UpgradeLiteUsernameHooks = {},
): Promise<UpgradeLiteUsernameResult> {
  return runFlow("username.claim", (flow) => runUpgrade(args, hooks, flow), {
    attributes: { method: args.method ?? "truapi" },
    // `unknown` is a broadcast nobody confirmed: the person sees a failure
    // and the marker holds the name, so it is one for us to look at.
    outcome: ({ status }) => ({ kind: status, ok: status === "included" }),
  });
}

async function runUpgrade(
  {
    expectedLiteAddress,
    currentLiteUsername,
    fullUsername,
    method = "truapi",
  }: UpgradeLiteUsernameArgs,
  { onFinalized }: UpgradeLiteUsernameHooks,
  flow: FlowRun,
): Promise<UpgradeLiteUsernameResult> {
  if (!FULL_USERNAME_PATTERN.test(fullUsername)) {
    throw new UsernameUpgradeError(
      "invalid-username",
      INVALID_USERNAME_MESSAGE,
    );
  }
  if (hasPendingUsernameUpgrade(expectedLiteAddress)) {
    throw new UsernameUpgradeError("pending", PENDING_MESSAGE);
  }

  let broadcastTxHash = "";

  try {
    flow.stage("setup");
    const [provider, truApi, { client, api }] = await withTimeout(
      Promise.all([getAccountsProvider(), getTruApi(), getPeopleClient()]),
      SETUP_TIMEOUT_MS,
      CHAIN_TIMEOUT_MESSAGE,
      () => {
        void resetClientCache();
      },
    );

    // Both host handles are required before any chain read: the product
    // account signs and submits, and the lite owner's proof is signed on the
    // truAPI client directly.
    if (provider == null || truApi == null) {
      throw new UsernameUpgradeError(
        "account-missing",
        ACCOUNT_MISSING_MESSAGE,
      );
    }

    const signingContext = await withTimeout(
      usernameSigningContext(client),
      CHAIN_PHASE_TIMEOUT_MS,
      CHAIN_TIMEOUT_MESSAGE,
    );
    if (signingContext == null) {
      throw new UsernameUpgradeError("upgrade-unavailable", "Username upgrades aren't available here yet.");
    }

    flow.stage("accounts");
    const accounts = await withTimeout(
      resolveUpgradeAccounts(provider, truApi, expectedLiteAddress),
      CHAIN_PHASE_TIMEOUT_MS,
      CHAIN_TIMEOUT_MESSAGE,
    );

    // Check ownership/name availability before any binding transaction. The
    // binding manages its own signing/finality deadlines (longer than a read).
    flow.stage("preflight");
    const { aliasBytes, nonce, usernameChoice, aliasRevisionStale } =
      await preflightUpgradeChain(
        api,
        currentLiteUsername,
        fullUsername,
        expectedLiteAddress,
        accounts.productAddress,
        method,
      );
    flow.set({ "alias.revision_stale": aliasRevisionStale });

    // A ring rebuilt since the binding makes `AliasWithAccount` invalid
    // (`BadSigner`); a fresh proof revises the binding inside the claim, as
    // `ensureAirdropAlias` does for the airdrops context. The key is resolved
    // before the lite owner signs, so a host without one fails here.
    let createRevisionProof: CreateResourcesAliasProof | null = null;
    if (aliasRevisionStale) {
      try {
        createRevisionProof = await resourcesAliasProof(
          provider,
          truApi,
          resolveNetwork(envConfig.chain.network),
          productDomain(),
        );
      } catch (cause) {
        logger.error("resources alias revision proof unavailable: {detail}", {
          detail: submissionDetail(cause),
        });
        throw new UsernameUpgradeError(
          "alias-binding-failed",
          ALIAS_REVISION_FAILED_MESSAGE,
          { cause },
        );
      }
    }

    flow.stage("sign");
    flow.set({ "username.choice": usernameChoice });
    const proofMessage = registerPersonProofMessage(
      Binary.fromHex(signingContext),
      aliasBytes,
    );
    let signature: Uint8Array;
    try {
      signature = await withTimeout(
        accounts.signLiteIdentityProof(proofMessage),
        SIGNING_TIMEOUT_MS,
        SIGNING_TIMEOUT_MESSAGE,
      );
    } catch (cause) {
      throw new UsernameUpgradeError("signing", SIGNING_FAILURE_MESSAGE, {
        cause,
      });
    }
    flow.stage("verify");
    await verifyLiteIdentityProof(
      proofMessage,
      signature,
      accounts.litePublicKey,
    );
    flow.stage("submit");
    const tx = api.tx.Resources.register_person({
      linked_lite_identity: expectedLiteAddress,
      lite_identity_proof: Enum("Sr25519", Binary.toHex(signature)),
      username_choice: Enum(usernameChoice, Binary.fromText(fullUsername)),
    });

    // The SDK sets both AsPerson and RestrictOrigins. Setting AsPerson alone
    // leaves RestrictOrigins disabled and the runtime rejects Invalid::Call.
    const signer = withAsPerson(
      accounts.productSigner,
      createRevisionProof == null
        ? { tag: "AliasWithAccount" }
        : { tag: "AliasWithAccountRevised", createProof: createRevisionProof },
    );

    const mortalityStart = await withTimeout(
      client.getFinalizedBlock(),
      CHAIN_PHASE_TIMEOUT_MS,
      CHAIN_TIMEOUT_MESSAGE,
    );

    const result = await watchTransactionSubmission(
      tx,
      signer,
      {
        nonce,
        at: mortalityStart.hash,
        // The persisted expiry is bound to this era checkpoint: the tx cannot
        // be included beyond start + period, so a stale marker cannot outlive
        // the signed tx.
        mortality: { mortal: true, period: USERNAME_UPGRADE_MORTALITY_PERIOD },
      },
      {
        signingFailureMessage: SIGNING_FAILURE_MESSAGE,
        finalityFailureMessage: FINALITY_FAILURE_MESSAGE,
        onBroadcast: (txHash) => {
          broadcastTxHash = txHash;
          setPendingUsernameUpgrade(
            expectedLiteAddress,
            fullUsername,
            txHash,
            mortalityStart.number + USERNAME_UPGRADE_MORTALITY_PERIOD,
          );
        },
        settleOn: "bestBlock",
        onFinalized: ({ txHash, ok }) => {
          if (!ok) {
            logger.error(
              "username upgrade {txHash} failed at finality after inclusion",
              { txHash },
            );
            clearPendingUsernameUpgrade(expectedLiteAddress, txHash);
            recordFailedUsernameUpgrade(expectedLiteAddress, fullUsername);
          }
          onFinalized?.();
        },
      },
    );

    if (result.status === "unknown") {
      logger.error("username upgrade unconfirmed, tx {txHash}: {detail}", {
        txHash: result.txHash,
        detail: result.detail,
      });
    } else {
      markPendingUsernameUpgradeIncluded(expectedLiteAddress, result.txHash);
    }
    return { status: result.status, txHash: result.txHash };
  } catch (err) {
    if (err instanceof UsernameUpgradeError) throw err;
    // The hook that surfaces this logs the classified code only, so the
    // decoded reason has to be recorded here or it is lost with `err`.
    logger.error("username upgrade failed: {detail}", {
      detail: submissionDetail(err),
    });
    if (err instanceof TransactionSubmissionError) {
      if (err.code === "finalized-error") {
        clearPendingUsernameUpgrade(expectedLiteAddress, broadcastTxHash);
        recordFailedUsernameUpgrade(expectedLiteAddress, fullUsername);
        throw new UsernameUpgradeError(
          "finalized-error",
          FINALITY_FAILURE_MESSAGE,
          { cause: err },
        );
      }
      throw new UsernameUpgradeError("signing", SIGNING_FAILURE_MESSAGE, {
        cause: err,
      });
    }
    if (err instanceof Error && err.message === CHAIN_TIMEOUT_MESSAGE) {
      throw new UsernameUpgradeError("timeout", CHAIN_TIMEOUT_MESSAGE, {
        cause: err,
      });
    }
    throw new UsernameUpgradeError("signing", SETUP_FAILURE_MESSAGE, {
      cause: err,
    });
  }
}
