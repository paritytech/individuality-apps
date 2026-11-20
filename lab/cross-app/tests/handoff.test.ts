// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from 'vitest';
import { confirmsRegistrationHandoff, handoffIsUnregistered } from '../handoff.ts';

// Public marks/message from cause-order. No wallet or host storage is used.
const tap = 1794010274383, requestAt = 1794010274402;
const reason = `the name can't be linked from here ("unfunded"): Jollity takes the sign-up`;
const observed = { tap, requestAt, now: requestAt + 15_001, includedBlock: null,
  poolSightings: 45, confirmedByWriter: confirmsRegistrationHandoff(reason) };

describe('confirmed hand-off with an unregistered account', () => {
  it('does not mistake the observed pool traffic for a registration', () => {
    expect(handoffIsUnregistered(observed)).toBe(true);
  });
  it('still catches a hand-off whose pool stayed empty without a console reason', () => {
    expect(handoffIsUnregistered({ ...observed, poolSightings: 0, confirmedByWriter: false })).toBe(true);
  });
  it('negative control: gives an unconfirmed navigation with pool activity the ordinary cap', () => {
    expect(handoffIsUnregistered({ ...observed, confirmedByWriter: false })).toBe(false);
  });
  it('negative control: never fails an account already registered on chain', () => {
    expect(handoffIsUnregistered({ ...observed, includedBlock: 2390559 })).toBe(false);
  });
  it('negative control: ignores a navigation before the tap', () => {
    expect(handoffIsUnregistered({ ...observed, requestAt: tap - 1 })).toBe(false);
  });
  it('negative control: keeps the full 15-second grace', () => {
    expect(handoffIsUnregistered({ ...observed, now: requestAt + 15_000 })).toBe(false);
  });
  it('negative control: a pending name or ordinary sign-up is no confirmation', () => {
    expect(confirmsRegistrationHandoff('sign-up goes again: name-pending')).toBe(false);
    expect(confirmsRegistrationHandoff('free sign-up broadcast')).toBe(false);
  });
});
