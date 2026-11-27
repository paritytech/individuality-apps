// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// The receipt observer and writer moved to lab/shared so both labs can use them; cross-app keeps its import path.
export { transactionEvidence, observedSubmitter, transactionWriter } from '../shared/transactions.ts';
