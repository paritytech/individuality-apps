// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * A promise with a deadline: its value, or null once `ms` have passed. A
 * rejection passes through (the callers catch). The timer is cleared either
 * way. Neutral on purpose: lib/host and lib/telemetry both use it, and
 * lib/host must not import lib/telemetry.
 */
export async function withTimeout<T>(promise: PromiseLike<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    clearTimeout(timer)
  }
}
