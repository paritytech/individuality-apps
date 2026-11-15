// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Milliseconds for measuring an elapsed time: `performance.now()` where the
 * runtime has it, `Date.now()` where it does not.
 *
 * Shared code runs in the worker too, and Polkadot Desktop boots the
 * worker in a QuickJS sandbox that defines no `performance` global, so a bare
 * `performance.now()` throws a ReferenceError there. The host-call tracer
 * wraps every host entry point, which made that one missing global fail
 * every host call the worker made. Checked on every call, not once at module
 * load, so the answer follows the global the code actually runs against.
 */
export function monotonicNow(): number {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}
