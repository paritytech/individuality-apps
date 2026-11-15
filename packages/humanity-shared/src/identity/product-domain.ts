// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The app's own DotNS product name on the selected network.
 *
 * One accessor rather than the composition repeated at each call site: every
 * caller must derive the *same* name, because the host turns it into an
 * account (`//product//<name>/0`). Two callers composing it differently would
 * silently sign against two different accounts — the prize payout account and
 * the account claiming a username would drift apart — which is the failure this
 * whole indirection exists to prevent.
 *
 * The label is deploy-time configuration; the suffix is the network's. Neither
 * half is a literal here.
 */
import {
  dotnsName,
  resolveNetwork,
  type NetworkConfig,
} from "@humanity/shared/chain/networks.ts";
import { envConfig } from "@humanity/shared/config/env.ts";

export function productDomain(): string {
  const name = dotnsName(
    resolveNetwork(envConfig.chain.network),
    envConfig.host.productLabel,
  );
  const subname = envConfig.host.productSubname;
  return subname === "" ? name : `${subname}.${name}`;
}

/** The governance-reserved label of the personhood product: `peopl`. */
export const PERSONHOOD_LABEL = "peopl";

/**
 * The product id the person's **ring-VRF keys** are derived under on this
 * network: `peopl.<network suffix>` — `peopl.testnet` on previewnet,
 * `peopl.paseo` on paseo-next-v2.
 *
 * Per network, like every other product id, because that is what the host
 * people actually carry does. The iOS Polkadot app derives
 * `//peopl.<tld>//index_bytes(0|1)` with the TLD read from the DotNS protocol
 * registry on chain, and puts *those* keys into the rings when it makes a
 * person. Measured on paseo-next-v2: a phone-onboarded person's Devicehood key
 * is `//peopl.paseo//1`, and nothing of that person exists under `peopl.dot`.
 *
 * It also makes the keys *ours* on every host. A product owns the ring-VRF
 * handles whose id equals its own, and the app is opened as `peopl.<tld>`,
 * so `registerRingVrfKey` mints exactly these bytes and `ringVrfSign` accepts
 * them — the same arithmetic the iOS derivation and the RFC-0022 reference
 * implementation run, verified against truapi's own output for
 * `peopl.testnet`.
 *
 * truapi derives its *wallet-internal* reserved keys — the CLI's throwaway
 * people and the wallet's allowance proofs — under the same `peopl.<tld>` in
 * releases after `truapi-host` 0.13.1. Older hosts pinned the literal
 * `peopl.dot`, so a person they made is one the key read will not see; the
 * account walk still covers it. Nothing here depends on the reserved constant
 * either way.
 *
 * Not {@link productDomain}: a preview deploy under another label must still
 * *read* the personhood keys, while only a deploy whose label is
 * {@link PERSONHOOD_LABEL} may *mint* them.
 */
export function personhoodProductId(network: NetworkConfig): string {
  return dotnsName(network, PERSONHOOD_LABEL);
}

/**
 * Whether this deploy *is* the personhood product, and so may register the
 * person keys with the host rather than only read them. False for a preview
 * deploy under another label, for any other label, and for a dev subname
 * (`dev.peopl.<suffix>`): a subname inherits `peopl`'s grants on other
 * products, but the host would refuse to mint keys under an id that is not
 * its own.
 */
export function isPersonhoodProduct(): boolean {
  return (
    envConfig.host.productLabel === PERSONHOOD_LABEL &&
    envConfig.host.productSubname === ""
  );
}
