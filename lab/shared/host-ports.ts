// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import type { PortRange } from '@parity/product-lab/ports/system';
import type { TruapiCliHostConfig } from '@parity/product-lab/host-truapi-cli';

// The host's strict ports schema accepts only these bounds, not range provenance.
export function hostPortRange(range: PortRange): NonNullable<TruapiCliHostConfig['ports']> {
  return { from: range.from, to: range.to };
}
