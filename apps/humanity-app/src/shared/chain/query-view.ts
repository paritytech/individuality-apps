// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The minimal query surface every prize hook exposes: exactly the three
 * fields the pages read from a TanStack `useQuery` result. Hooks return this
 * (instead of the full `UseQueryResult`) so callers stay decoupled from the
 * query plumbing — a `UseQueryResult` is structurally assignable to it.
 */
export interface QueryView<T> {
  data: T | undefined;
  error: Error | null;
  isPending: boolean;
}
