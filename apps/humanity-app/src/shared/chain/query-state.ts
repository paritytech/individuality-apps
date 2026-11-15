// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * A query error is blocking only while the query has no data at all.
 * Retained data — a cached object or even a cached `null` — keeps a
 * background fetch/refetch error non-blocking, so a restored screen
 * survives revalidation failures instead of being replaced by an
 * error state. Pass `undefined` for queries whose data cannot exist
 * yet (initial load): there the error is the only signal.
 */
export function blockingError<T>(
  error: Error | null,
  data: T | undefined,
): Error | null {
  return data === undefined ? error : null;
}
