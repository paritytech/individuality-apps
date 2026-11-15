// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Asks the host to top up the CASH purse from the game account, the account
 * a claimed prize is paid into (TrUAPI RFC-0006 `payment.topUp`).
 *
 * The host signs the transfer from that product account itself and needs no
 * permission, since a top-up is in the favour of the player. It shows nothing
 * unless the coins it loads fall short. An answer after the timeout reads as
 * "timeout" here, and the top-up may still land. Never throws.
 */
import type { PaymentTopUpSource } from "@parity/product-sdk-host"
import { signupAccountIndex } from "@jollity/protocol"
import { topUpErrorOutcome, type TopUpOutcome } from "@individuality/prize"
import { devLog } from "../debug/log-store"
import { withTimeout } from "../with-timeout"
import { describeError } from "./error-detail"

const TIMEOUT_MS = 10_000

export async function topUpPrize(amount: bigint, id: `0x${string}`): Promise<TopUpOutcome> {
  try {
    const sdk = await import("@parity/product-sdk-host")
    const payments = await sdk.getPaymentManager()
    if (!payments) return "no-host"
    const source: PaymentTopUpSource = {
      tag: "ProductAccount",
      value: { derivationIndex: { tag: "Index", value: signupAccountIndex() } },
    }
    const sent = await withTimeout(payments.topUp({ id, amount, source }).then(() => true), TIMEOUT_MS)
    return sent ? "sent" : "timeout"
  } catch (error) {
    const outcome = topUpErrorOutcome(error)
    if (outcome === "refused") devLog("claim", "prize top-up refused", { detail: describeError(error) }, "warn")
    return outcome
  }
}
