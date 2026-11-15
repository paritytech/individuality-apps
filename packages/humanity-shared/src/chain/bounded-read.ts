// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { withTimeout } from "@humanity/shared/utils/with-timeout.ts";


/** Fixed copy surfaced when a chain read misses its deadline. */
const READ_TIMEOUT_MESSAGE = "People Chain did not respond in time.";

/**
 * Backstop for a read that never returns, not a UX budget: the host RPC bridge
 * adds latency on top of a cold client's connect and 406KB metadata fetch, and
 * the stored card snapshot covers the wait.
 */
export const CHAIN_READ_TIMEOUT_MS = 30_000;

/**
 * Run one chain read under a hard deadline.
 *
 * `operation` receives a child signal that aborts when `parentSignal` aborts
 * (the query unmounted) or when the deadline fires, and must be forwarded into
 * every PAPI pull through `PullOptions.signal` so the in-flight subscription
 * is unsubscribed instead of left reconnecting forever. The shared client stays
 * cached: aborting or timing out a read never recycles it.
 *
 * Upstream rejections from `operation` propagate unchanged; only a missed
 * deadline rejects with the fixed copy above.
 */
export function runBoundedChainRead<T>(
  parentSignal: AbortSignal,
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs = CHAIN_READ_TIMEOUT_MS,
): Promise<T> {
  const child = new AbortController();

  const abortChild = () => {
    child.abort();
  };

  if (parentSignal.aborted) {
    abortChild();
    const error = new Error("Chain read aborted");
    error.name = "AbortError";
    return Promise.reject(error);
  }
  parentSignal.addEventListener("abort", abortChild, {
    once: true,
  });

  return withTimeout(
    operation(child.signal),
    timeoutMs,
    READ_TIMEOUT_MESSAGE,
    abortChild,
  ).finally(() => {
    parentSignal.removeEventListener("abort", abortChild);
  });
}
