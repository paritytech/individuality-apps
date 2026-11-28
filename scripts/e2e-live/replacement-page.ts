// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/** Keep every long-lived harness consumer on the same replacement page.
 * The page array feeds later play/confirm/evidence steps; rebindable consumers
 * own background reads and the final export. */
export function bindReplacementPage<T>(
  pages: T[],
  slot: number,
  replacement: T,
  consumers: readonly ({ rebind(page: T): void } | undefined)[],
): T {
  pages[slot] = replacement
  for (const consumer of consumers) consumer?.rebind(replacement)
  return replacement
}
