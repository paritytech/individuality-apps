// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/** Daily-dollar money math. The on-chain prize is a USD-stablecoin measured
 *  in base units; the UI always speaks in dollars. Pure and chain-free so the
 *  conversions are unit-testable. */

/** Decimal places of the daily-dollar prize asset (`Airdrop.Events`
 *  `prize.asset_amount`): a USD-stablecoin with 6 decimals. The runtime
 *  derives native amounts from it, and the app shows the dollar figure. */
export const AIRDROP_ASSET_DECIMALS = 6;

/** Base units per cent: 1e6 / 1e2. Formatting truncates to cents, never
 *  rounds — money shown is money actually won, never rounded up. */
const BASE_UNITS_PER_CENT = 10n ** BigInt(AIRDROP_ASSET_DECIMALS - 2);

/** Format a prize total in base units as dollars, up to two fraction digits
 *  with trailing zeros trimmed and thousands grouped: 214_000_000 → "$214",
 *  23_420_000 → "$23.42", 23_400_000 → "$23.4". The ledger never stores a
 *  negative amount, so a negative input is a programming error. */
export function formatPrizeDollars(baseUnits: bigint): string {
  if (baseUnits < 0n) {
    throw new RangeError(
      `formatPrizeDollars: expected non-negative base units, got ${baseUnits}`,
    );
  }
  const cents = baseUnits / BASE_UNITS_PER_CENT;
  const whole = cents / 100n;
  const fraction = cents % 100n;
  if (fraction === 0n) return `$${groupThousands(whole)}`;
  const digits =
    fraction % 10n === 0n
      ? `${fraction / 10n}`
      : `${fraction}`.padStart(2, "0");
  return `$${groupThousands(whole)}.${digits}`;
}

function groupThousands(whole: bigint): string {
  // 1234567 → "1,234,567": en-US grouping.
  return whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}
