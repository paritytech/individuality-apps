// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// Both labs use the same owned Asset Hub funding and strict inner-dispatch validator.
// Cross-app names its own actor, journal and receipt log; the shared helper holds none of them.
import { join } from 'node:path';
import { fundNameLink as fundSharedNameLink } from '../shared/name-funding.ts';
export { nameLinkFunding, nameLinkFundingCall, nameFundingValidator } from '../shared/name-funding.ts';
const CROSS_APP_FUNDING_JOURNAL = 'cross-app Asset Hub funding';
export function fundNameLink(state: Parameters<typeof fundSharedNameLink>[0]) {
  const directory = process.env.CROSS_APP_TIMINGS_DIR;
  return fundSharedNameLink(state, { actor: 'Ada', journal: CROSS_APP_FUNDING_JOURNAL,
    ...(directory ? { transactions: join(directory, '..', 'transactions.jsonl') } : {}) });
}
