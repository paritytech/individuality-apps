// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * `PeopleAirdrops.claim` pays into product account zero, which no purse UI
 * reads; the prize is only spendable once it sits in the host's coinage purse.
 * This is the one hop between the two, kept out of the claim extrinsic so a
 * top-up failure can never fail an already-included claim.
 *
 * Two callers use that hop. `sweepPrizeIntoCoinage` is the post-claim leg, for
 * an amount the claim just banked. `sweepStrandedPrizes` is the boot-time
 * recovery leg: a claim whose sweep never fired (the app closed first) or was
 * rejected leaves the prize sitting on product account zero forever, so at
 * start-up the account's balance in every draw-paying asset is read and
 * whatever is still there is topped up again.
 */
import {
  PRIZE_ACCOUNT_INDEX,
  resolvePrizeAccount,
} from "@features/prize/chain/prize-account.ts";
import { getPeopleClient } from "@humanity/shared/chain/client.ts";
import {
  individualityChain,
  readPeopleAirdropsStanding,
} from "@humanity/shared/chain/individuality.ts";
import { topUpCoinageFromProductAccount } from "@humanity/shared/chain/coinage-top-up.ts";

export interface PrizeCoinageSweep {
  status: "sent";
  amount: bigint;
}

/**
 * Move a claimed prize from product account zero into the host coinage purse.
 *
 * Every failure propagates: no host container, a non-positive amount
 * (`RangeError`), or the host rejecting `topUp`. The caller decides what a
 * failed sweep means; the prize stays on the product account either way.
 */
export async function sweepPrizeIntoCoinage(
  amount: bigint,
): Promise<PrizeCoinageSweep> {
  await topUpCoinageFromProductAccount({
    amount,
    derivationIndex: PRIZE_ACCOUNT_INDEX,
  });
  return { status: "sent", amount };
}

export interface StrandedPrize {
  /** XCM asset location of the draw-paying asset, as `AirdropDraw` carries it. */
  assetId: unknown;
  /** Balance still sitting on product account zero, in base units. */
  amount: bigint;
}

export type StrandedPrizeSweep =
  | { status: "skipped"; reason: "no-account" | "nothing-stranded" }
  | {
      status: "swept";
      sent: StrandedPrize[];
      failed: { prize: StrandedPrize; error: unknown }[];
    };

/** Draw asset ids are opaque XCM locations; compare them structurally, with
 *  bigints stringified, the way the debug panel keys its balance watch. */
function assetKey(assetId: unknown): string {
  return JSON.stringify(assetId ?? null, (_, value: unknown) =>
    typeof value === "bigint" ? `${value}n` : value,
  );
}

/**
 * Draw-paying assets that still hold a positive balance on product account
 * zero at the best block — a prize that was claimed but never made it into
 * the coinage purse.
 *
 * `null` outside a host container, where there is no product account to read.
 * Every asset any draw has ever paid in is checked, not just the latest
 * draw's, because the leftover can be from any past draw. A failing chain read
 * rejects: the caller must not read silence as "nothing left behind".
 */
export async function readStrandedPrizes(
  signal: AbortSignal,
): Promise<StrandedPrize[] | null> {
  const account = await resolvePrizeAccount();
  if (account == null) return null;

  const { client, api } = await getPeopleClient();
  signal.throwIfAborted();

  // Every draw on chain at one best block; the balances below are read at the
  // same block, so the draw list and the balances cannot disagree.
  const standing = await readPeopleAirdropsStanding(individualityChain(client, api), {
    account: account.address,
    signal,
  });
  if (!standing.ok) throw standing.error;
  const at = standing.value.at.blockHash;

  const assetIds: unknown[] = [];
  const seen = new Set<string>();
  for (const { event } of standing.value.draws) {
    const key = assetKey(event.prize.assetId);
    if (seen.has(key)) continue;
    seen.add(key);
    assetIds.push(event.prize.assetId);
  }
  if (assetIds.length === 0) return [];

  const accounts = await Promise.all(
    assetIds.map((assetId) =>
      api.query.Assets.Account.getValue(
        assetId as Parameters<typeof api.query.Assets.Account.getValue>[0],
        account.address,
        { at, signal },
      ),
    ),
  );

  const stranded: StrandedPrize[] = [];
  for (let index = 0; index < assetIds.length; index += 1) {
    // No account entry for the asset means the account never held it.
    const balance = accounts[index]?.balance ?? 0n;
    if (balance > 0n) stranded.push({ assetId: assetIds[index], amount: balance });
  }
  return stranded;
}

/**
 * Recover every prize left on product account zero into the coinage purse.
 *
 * One top-up per stranded asset, sequentially in the order read, because the
 * host allows only one live top-up per source and answers a second with
 * `SourceBusy`. A rejection is collected in `failed` and never stops the
 * remaining assets — the prize simply stays put until the next start-up. Only
 * a failing balance read rejects.
 */
export async function sweepStrandedPrizes(
  signal: AbortSignal,
): Promise<StrandedPrizeSweep> {
  const stranded = await readStrandedPrizes(signal);
  if (stranded == null) return { status: "skipped", reason: "no-account" };
  if (stranded.length === 0) {
    return { status: "skipped", reason: "nothing-stranded" };
  }

  const sent: StrandedPrize[] = [];
  const failed: { prize: StrandedPrize; error: unknown }[] = [];
  for (const prize of stranded) {
    try {
      await sweepPrizeIntoCoinage(prize.amount);
      sent.push(prize);
    } catch (error) {
      failed.push({ prize, error });
    }
  }
  return { status: "swept", sent, failed };
}
