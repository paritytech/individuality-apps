// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later
import { ss58Encode } from "@parity/product-sdk/address";
import type {
  AccountsProvider,
  ProductAccount,
} from "@humanity/shared/chain/host-api.ts";
import type { NetworkConfig } from "@humanity/shared/chain/networks.ts";
import { personhoodProductId } from "@humanity/shared/identity/product-domain.ts";

export interface LiteOwner {
  readonly account: ProductAccount;
  /** The product domain the account lives under: `peopl.<tld>`. */
  readonly domain: string;
}

/**
 * Find the host account that owns the person's usernames: `peopl.<tld>/0`,
 * the personhood product's account 0, which RFC-0028 makes the person's
 * identity account. It owns both the lite
 * (`name.NN`) and membership (`name`) usernames. There is no `uid` fallback:
 * that derivation never shipped to production.
 *
 * The domain comes from `personhoodProductId`, not `productDomain()`: the
 * latter can be a `dev.peopl.*` subname or a preview product, which have
 * different accounts.
 *
 * The account is accepted only if its public key matches the live username
 * owner exactly, so nothing else is ever signed with.
 */
export async function resolveLiteOwner(
  provider: AccountsProvider,
  network: NetworkConfig,
  expectedAddress: string,
): Promise<LiteOwner | null> {
  const domain = personhoodProductId(network);
  const account = await provider.getProductAccount(domain, 0).match(
    (value) => value,
    () => null,
  );
  if (
    account == null ||
    ss58Encode(account.publicKey, 42) !== expectedAddress
  ) {
    return null;
  }
  return { account, domain };
}
