// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Reject if `promise` has not settled within `ms`.
 *
 * Required for every chain read: `@polkadot-api/ws-provider` reconnects
 * indefinitely, so a read against an unreachable endpoint never settles on its
 * own and the UI would sit on its loading state forever instead of showing a
 * failure. The underlying promise is not cancelled — it is only ignored.
 *
 * `onTimeout` runs only when the deadline fired, after the timeout rejection
 * has settled, and its own failures never replace the timeout error.
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
  onTimeout?: () => void,
): Promise<T> {
  let didTimeout = false;
  const { promise: expiry, reject } = Promise.withResolvers<never>();
  const timer = setTimeout(() => {
    didTimeout = true;
    reject(new Error(message));
  }, ms);
  try {
    return await Promise.race([promise, expiry]);
  } catch (error) {
    if (didTimeout) {
      try {
        onTimeout?.();
      } catch {
        // Cleanup side effects must never mask the timeout error itself.
      }
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
