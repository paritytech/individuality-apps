// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest";

import { buildDrawEventId } from "@humanity/shared/airdrops/chain/draw-event-id.ts";
import {
  awardedFromClaimEvents,
  type ClaimChainEvent,
} from "@features/prize/chain/prize-claimed-event.ts";

const EVENT_ID = buildDrawEventId(42n);
const OTHER_EVENT_ID = buildDrawEventId(43n);
const BENEFICIARY = "5FLSigC9HGRKVhB9FiEo4Y3koPsNmBmLJbpXg2mp1hXcS59Y";
const OTHER_BENEFICIARY = "5DAAnrj7VHTznn2AWBemMuyBwZWs6FNFjdyVXUeYum3PTXFy";
const ONE_DOLLAR = 1_000_000n;

function prizeClaimed(
  overrides: Partial<{
    event_id: unknown;
    beneficiary: unknown;
    amount: unknown;
  }> = {},
): ClaimChainEvent {
  return {
    type: "Airdrop",
    value: {
      type: "PrizeClaimed",
      value: {
        event_id: EVENT_ID,
        slot: `0x${"11".repeat(32)}`,
        beneficiary: BENEFICIARY,
        asset_id: { type: "Native", value: undefined },
        amount: ONE_DOLLAR,
        ...overrides,
      },
    },
  };
}

describe("awardedFromClaimEvents", () => {
  it("reads the awarded amount from the matching PrizeClaimed", () => {
    expect(
      awardedFromClaimEvents([prizeClaimed()], EVENT_ID, BENEFICIARY),
    ).toBe(ONE_DOLLAR);
  });

  it("ignores unrelated runtime events", () => {
    const events: ClaimChainEvent[] = [
      { type: "System", value: { type: "ExtrinsicSuccess", value: {} } },
      { type: "Balances", value: { type: "Transfer", value: {} } },
      prizeClaimed(),
    ];

    expect(awardedFromClaimEvents(events, EVENT_ID, BENEFICIARY)).toBe(ONE_DOLLAR);
  });

  it("returns null when the claim emitted no PrizeClaimed", () => {
    // Distinct from a zero award: the caller must not bank a predicted amount.
    const events: ClaimChainEvent[] = [
      { type: "System", value: { type: "ExtrinsicSuccess", value: {} } },
    ];

    expect(awardedFromClaimEvents(events, EVENT_ID, BENEFICIARY)).toBeNull();
  });

  it("does not credit another draw's payout", () => {
    expect(
      awardedFromClaimEvents(
        [prizeClaimed({ event_id: OTHER_EVENT_ID })],
        EVENT_ID,
        BENEFICIARY,
      ),
    ).toBeNull();
  });

  it("does not credit another beneficiary's payout", () => {
    expect(
      awardedFromClaimEvents(
        [prizeClaimed({ beneficiary: OTHER_BENEFICIARY })],
        EVENT_ID,
        BENEFICIARY,
      ),
    ).toBeNull();
  });

  it("matches the event id case-insensitively", () => {
    expect(
      awardedFromClaimEvents(
        [prizeClaimed({ event_id: EVENT_ID.toUpperCase().replace("0X", "0x") })],
        EVENT_ID,
        BENEFICIARY,
      ),
    ).toBe(ONE_DOLLAR);
  });

  it("sums multiple payouts for the same claim", () => {
    expect(
      awardedFromClaimEvents(
        [prizeClaimed(), prizeClaimed({ amount: 500_000n })],
        EVENT_ID,
        BENEFICIARY,
      ),
    ).toBe(1_500_000n);
  });

  it("reports a genuine zero award as zero, not as missing", () => {
    expect(
      awardedFromClaimEvents([prizeClaimed({ amount: 0n })], EVENT_ID, BENEFICIARY),
    ).toBe(0n);
  });

  it("skips malformed payloads", () => {
    const malformed: ClaimChainEvent[] = [
      { type: "Airdrop", value: undefined },
      { type: "Airdrop", value: { type: "PrizeClaimed", value: null } },
      prizeClaimed({ amount: "1000000" }),
      prizeClaimed({ amount: -1n }),
      prizeClaimed({ event_id: 42 }),
    ];

    expect(awardedFromClaimEvents(malformed, EVENT_ID, BENEFICIARY)).toBeNull();
  });

  it("returns null when the event list is absent", () => {
    expect(awardedFromClaimEvents(undefined, EVENT_ID, BENEFICIARY)).toBeNull();
  });
});
