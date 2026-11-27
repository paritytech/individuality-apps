// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Who the profile belongs to, and the account that writes it.
 *
 * The writer is the identity account, `peopl.<tld>/0`: it holds the person's
 * usernames (RFC-0028). Seity runs as `peopl.<tld>`, as Humanity does, so it is
 * this product's own account 0 and the host hands over its signer. Nothing is
 * checked here: `prepareSetProfile` refuses an account the registry does not
 * authorise as `Unauthorised`, before anything is signed.
 */
import { ss58Encode } from "@parity/product-sdk/address";
import { stripSuffix } from "@parity/product-sdk/identity";

import { network, PRODUCT_ID } from "../config.ts";
import { getAccountsProvider, type AccountsProvider } from "../host.ts";

export interface ProfileOwner {
  /** The DotNS label without its TLD, `alice` or `alice.01`. */
  readonly label: string;
  /** SS58 of the identity account: the origin `prepareSetProfile` dry-runs as. */
  readonly address: string;
  /** Signs on pipeline 1, so Asset Hub takes the fee in PGAS. */
  readonly signer: ReturnType<AccountsProvider["getProductAccountSigner"]>;
}

export type OwnerLookup =
  | { readonly ok: true; readonly owner: ProfileOwner }
  | { readonly ok: false; readonly message: string };

export async function resolveOwner(): Promise<OwnerLookup> {
  const provider = await getAccountsProvider();
  if (provider == null) return { ok: false, message: "Not running inside a host: open Seity through `npm run dev:host`." };

  const username = await provider.getUserId().match((value) => value.primaryUsername, () => null);
  if (!username) return { ok: false, message: "The host has no username for this person, so there is no name to hang a profile on." };

  const account = await provider.getProductAccount(PRODUCT_ID, 0).match((value) => value, () => null);
  if (account == null) return { ok: false, message: `The host did not hand over ${PRODUCT_ID}/0, the identity account.` };

  return {
    ok: true,
    owner: {
      label: stripSuffix(username.trim().toLowerCase(), `.${network.dotnsSuffix}`),
      address: ss58Encode(account.publicKey, 42),
      signer: provider.getProductAccountSigner(account, { txExtVersion: 1 }),
    },
  };
}
