// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

export const purseStep = "{actor}'s Coinage purse grows by the prize within 60 seconds";
export const purseReason = 'host coinage purse unsupported';
/** Cucumber supports pending via its step return value. The pinned custom-step adapter discards
 * that value, so only this named definition gets the return restored at the Cucumber boundary. */
export function pendingPurseWrapper<T extends (...args: never[]) => unknown>(fn: T, options: { 'product-lab:custom'?: string } = {}) {
  if (options['product-lab:custom'] !== purseStep) return fn;
  return async function (this: unknown, ...args: Parameters<T>) { await fn.apply(this, args); return 'pending'; };
}
