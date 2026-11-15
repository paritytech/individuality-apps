// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import type { Hex32 } from "@individuality/daily-dollar";
import { peopleAirdropsEventId } from "@humanity/shared/chain/individuality.ts";

/** @throws ProductIndividualityError when `drawIndex` is not a u64. */
export function buildDrawEventId(drawIndex: bigint): Hex32 {
  return peopleAirdropsEventId(drawIndex) as Hex32;
}
