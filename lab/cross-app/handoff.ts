// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/** A pool sighting is not account- or call-scoped. A confirmed hand-off must not
 * wait ten minutes merely because a background bind reached that same pool. */
export function handoffIsUnregistered(input: {
  tap: number; requestAt: number; now: number; includedBlock: number | null;
  poolSightings: number; confirmedByWriter: boolean;
}): boolean {
  return input.requestAt >= input.tap && input.now - input.requestAt > 15_000 &&
    input.includedBlock === null && (input.poolSightings === 0 || input.confirmedByWriter);
}

/** The writing app's own reason, independent of whatever else entered the pool. */
export const confirmsRegistrationHandoff = (text: string): boolean => /Jollity takes the sign-up/i.test(text);
