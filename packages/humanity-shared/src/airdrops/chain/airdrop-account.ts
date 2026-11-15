// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import type { ProductAccountSigner } from "@humanity/shared/chain/host-api.ts";
import { ss58Encode, type SS58String } from "@parity/product-sdk/address";

import {
  getAccountsProvider,
  type AccountsProvider,
  type ProductAccount,
} from "@humanity/shared/chain/host-api.ts";
import { productDomain } from "@humanity/shared/identity/product-domain.ts";

/**
 * Account zero receives prizes and owns the Resources alias used by username
 * registration. `People.AccountToAlias` permits only one contextual alias per
 * account, so Daily Dollar must use a different account for its airdrops alias.
 */
export const AIRDROP_ACCOUNT_INDEX = 1;

const SS58_PREFIX = 42;

export interface AirdropAccount {
  readonly account: ProductAccount;
  readonly address: SS58String;
  readonly signer: ProductAccountSigner;
  readonly provider: AccountsProvider;
}

/** Resolve the Humanity product subaccount reserved for PeopleAirdrops. */
export async function resolveAirdropAccount(): Promise<AirdropAccount | null> {
  const provider = await getAccountsProvider();
  if (provider == null) return null;

  const account = await provider
    .getProductAccount(productDomain(), AIRDROP_ACCOUNT_INDEX)
    .match(
      (value) => value,
      () => null,
    );
  if (account == null) return null;

  return {
    account,
    address: ss58Encode(account.publicKey, SS58_PREFIX),
    signer: provider.getProductAccountSigner(account),
    provider,
  };
}
