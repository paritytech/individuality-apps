// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/** The pinned custom-step adapter discards return values. Restore Cucumber's pending
 * result only after the named step has recorded its exact missing capability. */
const pending = new Set<string>();
export function resetPending() { pending.clear(); }
export function markPending(pattern: string) { pending.add(pattern); }
export function pendingWrapper<T extends (...args: never[]) => unknown>(fn: T, options: { 'product-lab:custom'?: string } = {}) {
  return async function (this: unknown, ...args: Parameters<T>) {
    const result = await fn.apply(this, args);
    return pending.has(options['product-lab:custom'] ?? '') ? 'pending' : result;
  };
}
export const permissionRefusalReason = 'The qualified truapi-cli 0.27.0 host uses one approval policy per process. Refusing one request then allowing recovery needs the request-decisions host patch; this job must not patch the host';

export const playReason = 'Transaction enrollment uses a synthetic communication key. Existing real-play helpers require UI registration to persist the matching private key in each Jollity host; a transaction-only enrollment helper using those persisted app keys is missing';
export const prizeReason = 'Existing finalized prize helpers prove PeopleAirdrops.claim, not Game.claim_airdrop. A game-ticket winner fixture and a finalized Game.claim_airdrop proof are missing; the host PaymentManager purse path is also unqualified';
