// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import type { ProductAccountSigner } from "@humanity/shared/chain/host-api.ts";
import { ss58Encode, type SS58String } from "@parity/product-sdk/address";

import { productDomain } from "@humanity/shared/identity/product-domain.ts";
import {
  getAccountsProvider,
  type ProductAccount,
} from "@humanity/shared/chain/host-api.ts";

/** Product account zero: prize beneficiary and Resources/username actor. */
export interface PrizeAccount {
  readonly account: ProductAccount;
  /** The product account public key re-encoded with SS58 prefix 42. */
  readonly address: SS58String;
  /** Host signer for the product account (signing never happens implicitly). */
  readonly signer: ProductAccountSigner;
}

const SS58_PREFIX = 42;

/** Derivation index of the prize beneficiary: `PeopleAirdrops.claim`'s
 *  `destination`, and the account a coinage top-up moves a claimed prize from. */
export const PRIZE_ACCOUNT_INDEX = 0;

/**
 * Resolve the host wallet's app-scoped product account
 * (`getProductAccount(env host domain, 0)`), re-encode its public key as
 * SS58 prefix 42, and retain its `ProductAccountSigner`. Returns null outside the
 * Polkadot Desktop host container or when no product account is available —
 * never a placeholder account and never any private-key material.
 */
export async function resolvePrizeAccount(): Promise<PrizeAccount | null> {
  const provider = await getAccountsProvider();
  if (provider == null) {
    return null;
  }
  const account = await provider
    .getProductAccount(productDomain(), PRIZE_ACCOUNT_INDEX)
    .match(
      (acc) => acc,
      () => null,
    );
  if (account == null) {
    return null;
  }
  return {
    account,
    address: ss58Encode(account.publicKey, SS58_PREFIX),
    signer: provider.getProductAccountSigner(account),
  };
}
