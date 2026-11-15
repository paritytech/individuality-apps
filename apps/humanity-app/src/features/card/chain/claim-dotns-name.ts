// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { isRetryableDotnsNameCode, type DotnsNameClaimRecord } from "@features/card/domain/dotns-name-claim.ts";
import { readDotnsNameClaim, writeDotnsNameClaim } from "@features/card/storage/dotns-name-claim-store.ts";
import { recordMutation } from "@features/debug/debug-mutation-journal.ts";
import {
  DotnsNameError,
  registerDotnsName,
  type RegisterDotnsNameResult,
} from "@humanity/shared/chain/dotns-gateway/register-name.ts";
import { readDotnsGatewayNames } from "@humanity/shared/chain/dotns-gateway/read-names.ts";
import { describeError } from "@humanity/shared/chain/error-detail.ts";
import { getAccountsProvider, getTruApi } from "@humanity/shared/chain/host-api.ts";
import { resolveNetwork } from "@humanity/shared/chain/networks.ts";
import { submissionDetail } from "@humanity/shared/chain/transaction-submission.ts";
import { envConfig } from "@humanity/shared/config/env.ts";
import { parseHumanityUserId } from "@humanity/shared/identity/humanity-user-id.ts";
import { productDomain } from "@humanity/shared/identity/product-domain.ts";
import { loggerFor } from "@humanity/shared/logging/logger.ts";
import { runFlow, type FlowRun } from "@humanity/shared/telemetry/flow.ts";
import { sendsIdentity } from "@humanity/shared/telemetry/redact.ts";
import { withTimeout } from "@humanity/shared/utils/with-timeout.ts";
import { resolveLiteOwner } from "./resolve-lite-owner.ts";
import { signLiteIdentityProofUnwatermarked } from "./sign-lite-identity-proof.ts";

const logger = loggerFor("card", "dotns-name");
const REGISTER_NAME = "DotnsGateway.register_name";
const HOST_TIMEOUT_MS = 15_000;

export interface DotnsNameClaimArgs {
  readonly owner: string;
  /** The full username People holds for `owner`, which dotNS must hold too. */
  readonly label: string;
  readonly source: "auto" | "manual";
}

export type DotnsNameClaimOutcome =
  | RegisterDotnsNameResult
  | { readonly status: "failed"; readonly code: DotnsNameError["code"]; readonly detail: string }
  | { readonly status: "threw"; readonly detail: string };

export function claimDotnsName(args: DotnsNameClaimArgs): Promise<DotnsNameClaimOutcome> {
  return runFlow("username.dotns", (flow) => runClaim(args, flow), {
    attributes: { source: args.source },
    outcome: (outcome) => ({
      kind: outcome.status,
      ok: outcome.status === "included" || outcome.status === "already-registered",
    }),
  });
}

async function runClaim(
  { owner, label, source }: DotnsNameClaimArgs,
  flow: FlowRun,
): Promise<DotnsNameClaimOutcome> {
  const previous = readDotnsNameClaim(owner);
  const attempts = previous?.status === "sent" ? 1 : (previous?.attempts ?? 0) + 1;
  writeDotnsNameClaim(owner, { status: "sending", label, at: Date.now(), attempts });
  logger.info("{source} attempt {attempts} registers {label} for {owner} in dotNS", {
    source,
    attempts,
    label,
    owner,
  });
  // `cause` is the decoded failure behind a `DotnsNameError`: this is the one
  // place a stopped claim reaches Sentry, so it carries what went wrong.
  const stop = (code: DotnsNameError["code"], detail: string, cause?: unknown): DotnsNameClaimOutcome => {
    writeDotnsNameClaim(owner, { status: "stopped", label, at: Date.now(), attempts, code, detail });
    recordMutation(REGISTER_NAME, isRetryableDotnsNameCode(code) ? "failed" : "rejected", `${code}: ${detail}`);
    logger.error("dotNS claim of {label} stopped: {code} — {detail}", {
      label,
      code,
      detail,
      cause: cause === undefined ? undefined : submissionDetail(cause),
    });
    return { status: "failed", code, detail };
  };

  try {
    flow.stage("accounts");
    const [provider, truApi] = await withTimeout(
      Promise.all([getAccountsProvider(), getTruApi()]),
      HOST_TIMEOUT_MS,
      "The host did not respond in time.",
    );
    if (provider == null || truApi == null) {
      return stop("host-missing", "not running inside a host");
    }
    const network = resolveNetwork(envConfig.chain.network);
    const [liteOwner, hostIdentity, gateway] = await withTimeout(
      Promise.all([
        resolveLiteOwner(provider, network, owner),
        provider.getUserId().match(
          ({ primaryUsername }) => parseHumanityUserId(primaryUsername),
          () => null,
        ),
        readDotnsGatewayNames(owner),
      ]),
      HOST_TIMEOUT_MS,
      "The host or Asset Hub did not respond in time.",
    );
    if (liteOwner == null) {
      return stop("host-missing", `no host account for ${owner} under peopl`);
    }
    // The gateway's lite record is the label `register_name` checks the
    // owner of; the host's user id is only right while it still says the
    // lite name (it never does after the host learns the full one).
    const liteUsername =
      gateway.lite ?? (hostIdentity != null && !hostIdentity.isUpgraded ? hostIdentity.username : null);
    if (liteUsername == null) {
      return stop("not-lite-owner", `no lite label known for ${owner}`);
    }
    // Names on the transaction only when the deployer opted in to identity.
    if (sendsIdentity()) flow.set({ "dotns.lite": liteUsername, "dotns.label": label });
    logger.info("linking {label} to lite {lite} (from {liteSource})", {
      label,
      lite: liteUsername,
      liteSource: gateway.lite != null ? "gateway" : "host user id",
    });

    const result = await registerDotnsName(
      {
        who: owner,
        liteUsername,
        label,
        provider,
        truApi,
        productDomain: productDomain(),
        signImplication: (digest) =>
          signLiteIdentityProofUnwatermarked(truApi, liteOwner.domain, liteOwner.account.publicKey, digest),
        onStage: (stage) => flow.stage(stage),
      },
      {
        onBroadcast: (txHash, expiresAtBlock) => {
          writeDotnsNameClaim(owner, {
            status: "sent",
            label,
            at: Date.now(),
            txHash,
            expiresAtBlock,
            confirmed: false,
          });
          recordMutation(REGISTER_NAME, "submitted", `${source} ${owner} ${label} ${txHash}`);
        },
        onFinalized: ({ txHash, ok }) => {
          recordMutation(REGISTER_NAME, ok ? "finalized" : "failed", `${txHash} ${ok ? "finalized" : "failed at finality"}`);
          if (!ok) {
            writeDotnsNameClaim(owner, {
              status: "stopped",
              label,
              at: Date.now(),
              attempts,
              code: "finalized-error",
              detail: `${txHash} failed at finality`,
            });
          }
        },
      },
    );
    switch (result.status) {
      case "already-registered":
        writeDotnsNameClaim(owner, {
          status: "sent",
          label,
          at: Date.now(),
          txHash: previous?.status === "sent" ? previous.txHash : "0x",
          expiresAtBlock: previous?.status === "sent" ? previous.expiresAtBlock : 0,
          confirmed: true,
        });
        recordMutation(REGISTER_NAME, "finalized", `${owner} already holds ${label}`);
        break;
      case "included": {
        const broadcast = readDotnsNameClaim(owner);
        const record: DotnsNameClaimRecord = {
          status: "sent",
          label,
          at: Date.now(),
          txHash: result.txHash,
          expiresAtBlock: broadcast?.status === "sent" ? broadcast.expiresAtBlock : 0,
          confirmed: true,
        };
        writeDotnsNameClaim(owner, record);
        flow.set({ "tx.hash": result.txHash });
        break;
      }
      case "unknown":
        recordMutation(REGISTER_NAME, "unknown", `${result.txHash} broadcast, unconfirmed`);
        break;
    }
    logger.info("{source} dotNS claim of {label} settled as {status}", {
      source,
      label,
      status: result.status,
    });
    return result;
  } catch (error) {
    if (error instanceof DotnsNameError) {
      return stop(error.code, error.message, error.cause);
    }
    const detail = describeError(error);
    writeDotnsNameClaim(owner, { status: "stopped", label, at: Date.now(), attempts, code: "signing", detail });
    recordMutation(REGISTER_NAME, "failed", detail);
    logger.error("{source} dotNS claim threw: {detail}", { source, detail });
    return { status: "threw", detail };
  }
}
