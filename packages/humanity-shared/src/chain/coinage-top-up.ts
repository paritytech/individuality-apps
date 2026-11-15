// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Move funds from one of the scoped accounts of this product into the coinage
 * purse of the host (RFC-0006 `truApi.payment.topUp`). The host signs from the
 * product account itself. The app only names the account by derivation index.
 *
 * Since truapi 0.26, hosts require a 32-byte top-up `id`. The product mints a
 * fresh one per call, so a retry is a new top-up. The host answers once it has
 * accepted the top-up, not when the funds land.
 */
import { runFlow } from "@humanity/shared/telemetry/flow.ts";

import { getPaymentManager, newPaymentId } from "./host-api.ts";

export interface TopUpCoinageArgs {
  /** Amount in the purse's base units. */
  amount: bigint;
  /** Product account (`//product//<domain>/<index>`) the funds leave. */
  derivationIndex: number;
}

export async function topUpCoinageFromProductAccount({
  amount,
  derivationIndex,
}: TopUpCoinageArgs): Promise<void> {
  if (amount <= 0n) throw new RangeError("top-up amount must be positive");
  await runFlow(
    "coinage.top-up",
    async (flow) => {
      const payments = await getPaymentManager();
      if (payments == null) throw new Error("no host payment manager: not inside a host container");
      const id = newPaymentId();
      flow.set({ "top_up.id": id });
      await payments.topUp({
        id,
        amount,
        source: {
          tag: "ProductAccount",
          value: { derivationIndex: { tag: "Index", value: derivationIndex } },
        },
      });
    },
    { attributes: { "account.index": derivationIndex, amount: amount.toString() } },
  );
}
