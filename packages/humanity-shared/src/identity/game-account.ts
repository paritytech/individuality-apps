// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The account that actually plays the weekly game.
 *
 * It is NOT the DotNS username owner. That account is only the person's
 * identity (it owns the username and holds the PeopleLite ring-VRF key); it
 * has no `Score.Participants` or `Game.Players` record at all. The game is
 * played by an RFC-0022 product account so play is not linkable to the
 * identity, and pallet-score keys the participant by that account.
 *
 * Derivation (RFC-0022), as the Polkadot app derives `MetaAccount.Purpose
 * .CANDIDATE` from `ReservedProductIds.GAME`:
 *
 *   //product//<network's candidate product name>/<index>
 *   index = LE_u32(GAME_ACCOUNT_INDEX) ++ blake2b256("product-account-index")[0..28]
 *
 * The host owns the key material, so the address is resolved through
 * `getProductAccount(domain, GAME_ACCOUNT_INDEX)` rather than derived here.
 */
import type { ProductAccountSigner } from "@humanity/shared/chain/host-api.ts";
import { ss58Encode, type SS58String } from "@parity/product-sdk/address";

import { candidateProductDomain, dotnsName, resolveNetwork } from "@humanity/shared/chain/networks.ts";
import { envConfig } from "@humanity/shared/config/env.ts";

import {
  getAccountsProvider,
  type ProductAccount,
} from "@humanity/shared/chain/host-api.ts";
import { loggerFor } from "@humanity/shared/logging/logger.ts";
import { monotonicNow } from "@humanity/shared/utils/monotonic-now.ts";
import { withTimeout } from "@humanity/shared/utils/with-timeout.ts";

const logger = loggerFor("identity", "game-account");

/** Same SS58 prefix the prize account is re-encoded with. */
const SS58_PREFIX = 42;

/** RFC-0022 candidate product domain for Android's Score candidate account. */
export const CANDIDATE_PRODUCT_DOMAIN = candidateProductDomain(
  resolveNetwork(envConfig.chain.network),
);
/** The product whose host storage holds Jollity's game registration record:
 *  the game's own, or the one `VITE_GAME_STORAGE_LABEL` names (a preview's
 *  Jollity sandbox, which plays on the game's account but stores as itself). */
export const GAME_STORAGE_PRODUCT_DOMAIN =
  envConfig.chain.gameStorageLabel === ""
    ? CANDIDATE_PRODUCT_DOMAIN
    : dotnsName(resolveNetwork(envConfig.chain.network), envConfig.chain.gameStorageLabel);
/** The candidate product-account index the game is played on, from config
 *  (`envConfig.chain.gameAccountIndex`). Every read and write that means
 *  "this person's game account" uses this one index. */
export const GAME_ACCOUNT_INDEX = envConfig.chain.gameAccountIndex;

/**
 * A paired Polkadot Mobile host answers this over a remote round trip and can
 * legitimately take ~29s, so the window stays wide; Polkadot Desktop never
 * settles it at all. Neither delays first paint any more — the card's chain
 * read no longer waits on this, and the account only refines the result.
 */
const RESOLVE_TIMEOUT_MS = 30_000;
let resolveAttempt = 0;

export type GameAccountOutcome = "resolved" | "null-answer" | "timeout" | "threw";

export interface GameAccountDiagnostics {
  readonly productDomain: string;
  readonly index: number;
  readonly outcome: GameAccountOutcome;
  readonly elapsedMs: number;
  readonly address?: string;
}

let gameAccountDiagnostics: GameAccountDiagnostics | undefined;

function recordGameAccountDiagnostics(
  outcome: GameAccountOutcome,
  startedAt: number,
  address?: string,
): void {
  gameAccountDiagnostics = {
    productDomain: CANDIDATE_PRODUCT_DOMAIN,
    index: GAME_ACCOUNT_INDEX,
    outcome,
    elapsedMs: Math.round(monotonicNow() - startedAt),
    ...(address == null ? {} : { address }),
  };
}

/** The outcome of the most recent candidate product-account host call. */
export function getGameAccountDiagnostics(): GameAccountDiagnostics | undefined {
  return gameAccountDiagnostics;
}

function errorFields(error: unknown) {
  return error instanceof Error
    ? {
        errorName: error.name,
        errorMessage: error.message,
        errorStack: error.stack ?? "unavailable",
      }
    : {
        errorName: typeof error,
        errorMessage: String(error),
        errorStack: "unavailable",
      };
}
export interface GameAccount {
  readonly account: ProductAccount;
  readonly address: SS58String;
  readonly signer: ProductAccountSigner;
}

/**
 * Resolve the game player account together with the host-owned signer. The
 * deadline is shared with address-only reads so hosts without product-account
 * support cannot stall either registration or the home card.
 */
export async function resolveGameAccount(): Promise<GameAccount | null> {
  const attempt = ++resolveAttempt;
  const startedAt = monotonicNow();
  logger.debug(
    "candidate account resolution started; attempt={attempt} domain={domain} " +
      "index={index} timeoutMs={timeoutMs}",
    {
      attempt,
      domain: CANDIDATE_PRODUCT_DOMAIN,
      index: GAME_ACCOUNT_INDEX,
      timeoutMs: RESOLVE_TIMEOUT_MS,
    },
  );

  const provider = await getAccountsProvider();
  if (provider == null) {
    logger.warning(
      "candidate account resolution stopped before host request; " +
        "attempt={attempt} reason=no-accounts-provider elapsedMs={elapsedMs}",
      { attempt, elapsedMs: Math.round(monotonicNow() - startedAt) },
    );
    return null;
  }

  logger.debug(
    "candidate account host request started; attempt={attempt} elapsedMs={elapsedMs}",
    { attempt, elapsedMs: Math.round(monotonicNow() - startedAt) },
  );
  let account: ProductAccount | null = null;
  let hostRejected = false;
  let timedOut = false;
  try {
    account = await withTimeout(
      provider
        .getProductAccount(
          CANDIDATE_PRODUCT_DOMAIN,
          GAME_ACCOUNT_INDEX,
        )
        .match(
          (value) => {
            if (value == null) return null;
            logger.debug(
              "candidate account host request resolved; attempt={attempt} " +
                "publicKeyBytes={publicKeyBytes} elapsedMs={elapsedMs}",
              {
                attempt,
                publicKeyBytes: value.publicKey.length,
                elapsedMs: Math.round(monotonicNow() - startedAt),
              },
            );
            return value;
          },
          (error) => {
            hostRejected = true;
            logger.warning(
              "candidate account host request rejected; attempt={attempt} " +
                "errorName={errorName} errorMessage={errorMessage} " +
                "errorStack={errorStack} elapsedMs={elapsedMs}",
              {
                attempt,
                ...errorFields(error),
                elapsedMs: Math.round(monotonicNow() - startedAt),
              },
            );
            return null;
          },
        ),
      RESOLVE_TIMEOUT_MS,
      "Host did not answer the game product account request.",
      () => {
        timedOut = true;
      },
    );
  } catch (error) {
    recordGameAccountDiagnostics(timedOut ? "timeout" : "threw", startedAt);
    logger.warning(
      "candidate account host request failed; attempt={attempt} " +
        "errorName={errorName} errorMessage={errorMessage} " +
        "errorStack={errorStack} elapsedMs={elapsedMs}",
      {
        attempt,
        ...errorFields(error),
        elapsedMs: Math.round(monotonicNow() - startedAt),
      },
    );
    return null;
  }
  if (account == null) {
    recordGameAccountDiagnostics("null-answer", startedAt);
    logger.warning(
      "candidate account unavailable after host response; attempt={attempt} " +
        "hostRejected={hostRejected} elapsedMs={elapsedMs}",
      {
        attempt,
        hostRejected,
        elapsedMs: Math.round(monotonicNow() - startedAt),
      },
    );
    return null;
  }

  const address = ss58Encode(account.publicKey, SS58_PREFIX);
  recordGameAccountDiagnostics("resolved", startedAt, address);
  logger.debug(
    "candidate account resolution completed; attempt={attempt} domain={domain} " +
      "index={index} address={address} elapsedMs={elapsedMs}",
    {
      attempt,
      domain: CANDIDATE_PRODUCT_DOMAIN,
      index: GAME_ACCOUNT_INDEX,
      address,
      elapsedMs: Math.round(monotonicNow() - startedAt),
    },
  );
  return {
    account,
    address,
    signer: provider.getProductAccountSigner(account),
  };
}


/**
 * Resolve the game player account, SS58-42 encoded. Null outside a host
 * container or when the host declines — never a placeholder, and never any
 * private-key material.
 */
export async function resolveGameAccountAddress(): Promise<string | null> {
  return (await resolveGameAccount())?.address ?? null;
}
