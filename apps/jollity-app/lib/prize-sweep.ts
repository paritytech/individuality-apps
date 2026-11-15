// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Moves what the game account holds in prize assets into the CASH purse of
 * the host, right after one claim of the player lands.
 *
 * It runs after a landed claim and nowhere else, so an older prize left in
 * the game account moves only with the next claim. The sweep itself is shared
 * with the chat, in @individuality/prize. Never throws.
 */
import { productAccount, type PalletPrizeBalance } from "@jollity/protocol"
import { sweepPrizes, type PrizeTopUp } from "@individuality/prize"
import { devLog } from "./debug/log-store"
import { describeError } from "./host/error-detail"
import { topUpPrize } from "./host/prize-topup"
import { blake2b256 } from "./host/turn-proof"
import { reportFailure } from "./telemetry"

export async function sweepClaimedPrizes(
  address: string,
  balances: (address: string) => Promise<PalletPrizeBalance[]>,
  claim: { gameIndex: number; airdropIndex: number },
): Promise<PrizeTopUp[]> {
  try {
    const topUps = await sweepPrizes({
      balances: () => balances(address),
      topUp: topUpPrize,
      hash: blake2b256,
      account: { namespace: "jollity", product: productAccount(), address },
      claim,
    })
    for (const { assetKey, amount, outcome } of topUps) {
      const context = { "asset.key": assetKey, "prize.amount": amount.toString() }
      if (outcome === "refused" || outcome === "timeout") reportFailure("prize-topup-failed", { reason: outcome, context })
      else devLog("claim", `prize top-up ${outcome}`, context)
    }
    return topUps
  } catch (error) {
    devLog("claim", "prize balances unread, nothing topped up", { detail: describeError(error) }, "warn")
    return []
  }
}
