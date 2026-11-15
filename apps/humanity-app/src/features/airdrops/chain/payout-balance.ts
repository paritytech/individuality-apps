// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Balances of the two product accounts the daily dollar moves through, as
 * the debug panel shows them: the payout account (`PeopleAirdrops.claim`'s
 * `destination`, product account 0) and the airdrop account that signs the
 * claim (product account 1). Read from the best block on People Chain, in the
 * prize asset named by the latest draw plus the native token. Module-level
 * like the other diagnostics, so the rendered panel and the copied JSON agree.
 */
import { getPeopleClient } from "@humanity/shared/chain/client.ts";
import { resolveAirdropAccount } from "@humanity/shared/airdrops/chain/airdrop-account.ts";
import { resolvePrizeAccount } from "@features/prize/chain/prize-account.ts";

export interface AccountBalances {
  address: string;
  /** Prize-asset balance in base units; `null` when the account holds none
   *  or no draw has named the asset yet. */
  prize: bigint | null;
  /** Native free balance in plancks. */
  native: bigint;
}

export type PayoutBalanceDiagnostics =
  | { status: "pending" }
  | { status: "unavailable" }
  | { status: "error"; reason: string }
  | {
      status: "ok";
      payout: AccountBalances;
      airdrop: AccountBalances;
      atBlockHash: string;
      updatedAtMs: number;
    };

const REFRESH_MS = 12_000;

let diagnostics: PayoutBalanceDiagnostics | undefined;

export function getPayoutBalanceDiagnostics(): PayoutBalanceDiagnostics | undefined {
  return diagnostics;
}

async function readBalances(
  address: string,
  assetId: unknown,
  at: string,
): Promise<AccountBalances> {
  const { api } = await getPeopleClient();
  const [system, asset] = await Promise.all([
    api.query.System.Account.getValue(address, { at }),
    assetId == null
      ? Promise.resolve(undefined)
      : api.query.Assets.Account.getValue(
          assetId as Parameters<typeof api.query.Assets.Account.getValue>[0],
          address,
          { at },
        ),
  ]);
  return { address, prize: asset?.balance ?? null, native: system.data.free };
}

async function readPayoutBalances(assetId: unknown): Promise<PayoutBalanceDiagnostics> {
  const [payout, airdrop] = await Promise.all([
    resolvePrizeAccount(),
    resolveAirdropAccount(),
  ]);
  if (payout == null || airdrop == null) return { status: "unavailable" };
  const { client } = await getPeopleClient();
  const [head] = await client.getBestBlocks();
  if (head == null) throw new Error("People Chain reported no best block");
  const [payoutBalances, airdropBalances] = await Promise.all([
    readBalances(payout.address, assetId, head.hash),
    readBalances(airdrop.address, assetId, head.hash),
  ]);
  return {
    status: "ok",
    payout: payoutBalances,
    airdrop: airdropBalances,
    atBlockHash: head.hash,
    updatedAtMs: Date.now(),
  };
}

/**
 * Poll both balances every 12 s until the returned function is called.
 * `onChange` fires after every diagnostics update so a caller can repaint.
 * Outside a host container the status settles on `unavailable`.
 */
export function watchPayoutBalances(assetId: unknown, onChange: () => void): () => void {
  let live = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const update = (next: PayoutBalanceDiagnostics) => {
    if (!live) return;
    diagnostics = next;
    onChange();
  };
  const tick = () => {
    void readPayoutBalances(assetId)
      .then(update)
      .catch((reason: unknown) =>
        update({
          status: "error",
          reason: reason instanceof Error ? reason.message : String(reason),
        }),
      )
      .finally(() => {
        if (live) timer = setTimeout(tick, REFRESH_MS);
      });
  };

  update({ status: "pending" });
  tick();

  return () => {
    live = false;
    clearTimeout(timer);
  };
}
