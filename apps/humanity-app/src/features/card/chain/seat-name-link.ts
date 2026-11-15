// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The game account's name link (#456), run from here: the person's username
 * linked to the `dim2.<tld>` game account, so the prize draw's wheel can name
 * the tickets that account holds. Jollity's sign-up never goes without it, and
 * neither does this one: the shared flow waits on it (`game-sign-up.ts`).
 *
 * The steps are `linkName`'s (`@individuality/name-link`); this file hands in
 * what this product reaches:
 *  - the username the host gives (`resolveHumanityUserId`);
 *  - the root's signature, through the product SDK's
 *    `wallet.signMessageWithDotNsIdentity`, which finds the root that owns
 *    the username on the People chain and has the host sign as it;
 *  - this product's People and Asset Hub clients;
 *  - the game account's signer on transaction pipeline 1 (PGAS fees), which
 *    the host gives under DIM2's `context` grant to this product.
 *
 * There is no PGAS allowance to ask for: the host allocates one only for the
 * asking product's own accounts (RFC 0010), and the game account is DIM2's. A
 * game account without PGAS ends `unfunded`, and Register hands the sign-up to
 * Jollity, which asks for the allowance as itself (`use-register-for-game.ts`).
 *
 * One link at a time; it never throws.
 */
import type { App } from "@parity/product-sdk";
import { fromHex } from "polkadot-api/utils";
import { linkName, type NameLinkResult, type NameLinkTrigger } from "@individuality/name-link";

import { getAssetHubClient } from "@humanity/shared/chain/asset-hub-client.ts";
import { getPeopleClient } from "@humanity/shared/chain/client.ts";
import { describeError } from "@humanity/shared/chain/error-detail.ts";
import { getAccountsProvider } from "@humanity/shared/chain/host-api.ts";
import { CANDIDATE_PRODUCT_DOMAIN, resolveGameAccount } from "@humanity/shared/identity/game-account.ts";
import { resolveHumanityUserId } from "@humanity/shared/identity/humanity-user-id.ts";
import { loggerFor } from "@humanity/shared/logging/logger.ts";

const logger = loggerFor("card", "name-link");

let running: Promise<NameLinkResult> | null = null;
let app: Promise<App> | null = null;

/** `message`, signed by the root account that owns `username`, as the product SDK has the host sign it. */
async function signWithRoot(username: string, message: Uint8Array) {
  const { createApp } = await import("@parity/product-sdk");
  // Nothing of the SDK app is used but the wallet: no Bulletin cloud storage.
  app ??= createApp({ cloudStorage: false });
  const { network } = await getPeopleClient();
  const base =
    network.key === "paseo-next-v2"
      ? (await import("@parity/product-sdk-descriptors/paseo-individuality")).paseo_individuality
      : (await import("@parity/product-sdk-descriptors/previewnet-individuality")).previewnet_individuality;
  // The SDK selects the host chain by descriptor.genesis, not our client.
  const peopleChain = network.key === "local"
    ? { ...base, genesis: network.peopleChain.genesisHash }
    : base;
  const signed = await (await app).wallet.signMessageWithDotNsIdentity({ peopleChain, username, message });
  return { root: fromHex(signed.accountId), signature: signed.signature };
}

/**
 * Link the person's username to the game account, unless it already is, and
 * say how it ended. One at a time: a call while a link runs gets that link's
 * answer. `signal` stops the link before its next step (the name gate's
 * deadline). Never throws: a link that threw is `failed`.
 */
export function linkSeatName(trigger: NameLinkTrigger, signal?: AbortSignal): Promise<NameLinkResult> {
  running ??= link(trigger, signal)
    .catch((error: unknown): NameLinkResult => {
      logger.warning("linking the name failed: {detail}", { detail: describeError(error) });
      return "failed";
    })
    .finally(() => {
      running = null;
    });
  return running;
}

async function link(trigger: NameLinkTrigger, signal?: AbortSignal): Promise<NameLinkResult> {
  const accounts = await getAccountsProvider();
  const game = accounts == null ? null : await resolveGameAccount();
  if (accounts == null || game == null) {
    logger.info("no name link ({trigger}): no host game account", { trigger });
    return "skipped";
  }
  const user = await resolveHumanityUserId();
  if (user == null) {
    logger.info("no name link ({trigger}): the host gave no username", { trigger });
    return "skipped";
  }
  const [people, assetHub] = await Promise.all([getPeopleClient(), getAssetHubClient()]);
  const outcome = await linkName({
    product: CANDIDATE_PRODUCT_DOMAIN,
    account: game.account.publicKey,
    username: user.username,
    assetHub: assetHub.client,
    people: people.client,
    // Asset Hub (runtime 3004000 on) takes fees in PGAS only on
    // transaction-extension pipeline 1; the default, 0, charges the native coin.
    signer: accounts.getProductAccountSigner(game.account, { txExtVersion: 1 }),
    signAsRoot: signWithRoot,
    log: (message, data, level) => {
      if (level === "warn") logger.warning("{message} {data}", { message, data: JSON.stringify(data ?? {}) });
      else logger.info("{message} {data}", { message, data: JSON.stringify(data ?? {}) });
    },
    signal,
  });
  logger.info("name link ({trigger}): {outcome}", { trigger, outcome });
  return outcome;
}
