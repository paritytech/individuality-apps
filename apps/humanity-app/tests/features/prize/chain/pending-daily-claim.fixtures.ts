// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/** Test fixtures for the pending-daily-claim tests — extracted so the test
 *  file can stay under the 200-line budget. The `MemoryStorage` shim and
 *  the standard set of draw/account/hash fixtures are reused across every
 *  describe in the file. */
import { buildDrawEventId } from "@humanity/shared/airdrops/chain/draw-event-id.ts";

/** Two draws that overlap on registration; a settled marker must never
 *  lock the next draw's ticket. */
export const DRAW_A = buildDrawEventId(1n);
export const DRAW_B = buildDrawEventId(2n);
/** A later draw, separated from `DRAW_A` by a gap of two indices. */
export const DRAW_LATER = buildDrawEventId(4n);

export const ACCOUNT = "5Alice";
export const OTHER_ACCOUNT = "5Bob";
export const TX_HASH = `0x${"ab".repeat(32)}`;
export const WRONG_TX_HASH = `0x${"cd".repeat(32)}`;
export const NEWER_TX_HASH = `0x${"ef".repeat(32)}`;

export const VALID_RECORD = {
  eventId: DRAW_A,
  accountAddress: ACCOUNT,
  txHash: TX_HASH,
};

/** In-memory Storage stand-in; keys are implementation details, discovered behaviorally. */
export class MemoryStorage {
  private readonly entries: Record<string, string> = {};

  get length(): number {
    return Object.keys(this.entries).length;
  }

  key(index: number): string | null {
    return Object.keys(this.entries)[index] ?? null;
  }

  keys(): string[] {
    return Object.keys(this.entries);
  }

  getItem(key: string): string | null {
    return this.entries[key] ?? null;
  }

  setItem(key: string, value: string): void {
    this.entries[key] = value;
  }

  removeItem(key: string): void {
    delete this.entries[key];
  }
}
