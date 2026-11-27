// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Put PGAS into the identity account before it writes.
 *
 * The write's fee and the record's storage deposit are paid in PGAS by the
 * signer, the identity account `peopl.<tld>/0` (owner.ts). That is this
 * product's own account 0, so the host's `SmartContractAllowance` for index 0
 * lands exactly where it is spent. A first publish costs one approval; later
 * publishes cost none while the balance lasts.
 *
 * `Allocated` only means the host submitted the claim, so the balance is
 * polled until it lands. Bulletin rides along in the same review, so the
 * avatar upload asks for nothing more. Amounts and the asset-id fallback are
 * the reference Seity app's (`~/seity/app/src/chain/fees.ts`, `dotns.ts`).
 */
import { requestResourceAllocation } from "@parity/product-sdk/host";

import { chains, type AssetHubApi } from "../chain.ts";
import type { ProfileOwner } from "./owner.ts";

/** Ask for an allowance when the identity account holds less than this. */
const PGAS_FLOOR = 10_000_000_000n;
/** `Pgas.PgasAssetId` on Paseo Asset Hub Next, if the constant cannot be read. */
const FALLBACK_PGAS_ASSET_ID = 2_000_000_000;
/** The identity account's derivation index under `peopl.<tld>`. */
const IDENTITY_INDEX = 0;
const LANDED_TIMEOUT_MS = 90_000;
const POLL_MS = 3_000;

export async function ensureIdentityFunded(owner: ProfileOwner, onStage?: (stage: string) => void): Promise<void> {
  const { assetHub } = await chains();
  const assetId = await pgasAssetId(assetHub);
  const balance = () => pgasBalance(assetHub, assetId, owner.address);

  if ((await balance()) >= PGAS_FLOOR) return;

  onStage?.("Asking the host for a PGAS allowance (and Bulletin with it)");
  const outcome = await requestResourceAllocation([
    { tag: "SmartContractAllowance", value: { tag: "Index", value: IDENTITY_INDEX } },
    { tag: "BulletinAllowance" },
  ]);
  if (!outcome.ok) throw new Error(`The allowance request failed: ${outcome.error.message}`);
  if (outcome.value[0] === "Rejected") throw new Error("The PGAS allowance was declined; approve it to publish.");

  const deadline = Date.now() + LANDED_TIMEOUT_MS;
  let held = await balance();
  while (held < PGAS_FLOOR && Date.now() < deadline) {
    onStage?.(`Waiting for the allowance to land (${Math.round((deadline - Date.now()) / 1000)}s left)`);
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    held = await balance();
  }
  if (held < PGAS_FLOOR) {
    throw new Error(
      `After the allowance ("${outcome.value[0]}"), the identity account holds ${held} PGAS units; it needs ${PGAS_FLOOR}.`,
    );
  }
}

async function pgasAssetId(api: AssetHubApi): Promise<number> {
  try {
    return Number(await api.constants.Pgas.PgasAssetId());
  } catch {
    return FALLBACK_PGAS_ASSET_ID;
  }
}

async function pgasBalance(api: AssetHubApi, assetId: number, who: string): Promise<bigint> {
  // At the best block: a grant shows the block it lands in.
  const account = await api.query.Assets.Account.getValue(assetId, who, { at: "best" });
  return BigInt(account?.balance ?? 0);
}
