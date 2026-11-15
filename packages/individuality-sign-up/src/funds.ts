// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Amounts a person reads: planck → "2.5 PAS". The chain's token comes with
 * the status (`decimals`, `symbol`), never assumed — a dev node and previewnet
 * disagree on both.
 */
export interface Funds {
  /** the player's spendable balance */
  free: bigint
  /** the play deposit the account route holds */
  deposit: bigint
  /** deposit plus fee headroom — what the account must hold to register */
  required: bigint
  decimals: number
  symbol: string
}

/** `formatAmount(25_000_000_000n, 10, "PAS")` → `"2.5 PAS"`; trims trailing
 *  zeros, keeps at most `maxFraction` fractional digits. */
export function formatAmount(
  planck: bigint,
  decimals: number,
  symbol: string,
  maxFraction = 4,
): string {
  const unit = 10n ** BigInt(decimals)
  const whole = planck / unit
  const fraction = planck % unit
  let text = whole.toString()
  if (fraction > 0n && maxFraction > 0) {
    const digits = fraction.toString().padStart(decimals, "0").slice(0, maxFraction).replace(/0+$/, "")
    if (digits) text += `.${digits}`
  }
  return `${text} ${symbol}`
}

/** what is missing to take the deposit route; zero when funded */
export function shortfall(funds: Funds): bigint {
  return funds.required > funds.free ? funds.required - funds.free : 0n
}
