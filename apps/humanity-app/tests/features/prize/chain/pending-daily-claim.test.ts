// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearPendingDailyClaim,
  hasPendingDailyClaim,
  setPendingDailyClaim,
} from "@features/prize/chain/pending-daily-claim.ts";

import {
  ACCOUNT,
  DRAW_A,
  DRAW_B,
  DRAW_LATER,
  MemoryStorage,
  NEWER_TX_HASH,
  OTHER_ACCOUNT,
  TX_HASH,
  VALID_RECORD,
  WRONG_TX_HASH,
} from "./pending-daily-claim.fixtures.ts";

/** The malformed-records fixture: each entry MUST be ignored when the
 *  module reads it back from storage. Together with the "raw" cases in
 *  `it("ignores malformed persisted values …")` they cover every shape
 *  the persisted record can take without being a real claim. */
const INVALID_RECORDS: readonly Record<string, unknown>[] = [
  { eventId: DRAW_A, accountAddress: ACCOUNT }, // Missing txHash.
  { ...VALID_RECORD, eventId: 42 }, // Wrong-typed event id.
  { ...VALID_RECORD, accountAddress: 42 }, // Wrong-typed account.
  { ...VALID_RECORD, txHash: { hex: true } }, // Wrong-typed txHash.
  { ...VALID_RECORD, eventId: "not-a-hex-event" }, // Non-hex event id.
  { ...VALID_RECORD, eventId: "" }, // Empty event id.
  { ...VALID_RECORD, accountAddress: "" }, // Empty account.
  { ...VALID_RECORD, txHash: "not-a-hex-hash" }, // Non-hex txHash.
  { ...VALID_RECORD, txHash: "0xGG" }, // Bad hex chars.
  { ...VALID_RECORD, txHash: "" }, // Empty txHash.
];

let storage: MemoryStorage;

/** Keys the module persists claims under, discovered via standard length/key. */
function claimKeys(): string[] {
  setPendingDailyClaim(DRAW_A, ACCOUNT, TX_HASH);
  const keys = Array.from(
    { length: storage.length },
    (_, i) => storage.key(i) as string,
  );
  clearPendingDailyClaim(DRAW_A, ACCOUNT, TX_HASH);
  return keys;
}

describe("pending-daily-claim duplicate lock", () => {
  beforeEach(() => {
    storage = new MemoryStorage();
    vi.stubGlobal("localStorage", storage);
    for (const event of [DRAW_A, DRAW_B, DRAW_LATER]) {
      for (const account of [ACCOUNT, OTHER_ACCOUNT]) {
        for (const hash of [TX_HASH, NEWER_TX_HASH]) {
          clearPendingDailyClaim(event, account, hash);
        }
      }
    }
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("persists the record and matches the exact claim identity", () => {
    setPendingDailyClaim(DRAW_A, ACCOUNT, TX_HASH);

    expect(hasPendingDailyClaim(DRAW_A, ACCOUNT)).toBe(true);
    const persisted = storage
      .keys()
      .map((key) => JSON.parse(storage.getItem(key) as string));
    expect(persisted).toContainEqual(VALID_RECORD);
  });

  it("does not match on a different draw or account", () => {
    setPendingDailyClaim(DRAW_A, ACCOUNT, TX_HASH);

    expect(hasPendingDailyClaim(DRAW_LATER, ACCOUNT)).toBe(false);
    expect(hasPendingDailyClaim(DRAW_A, OTHER_ACCOUNT)).toBe(false);
  });

  it("an unresolved claim never locks another concurrent draw", () => {
    setPendingDailyClaim(DRAW_B, ACCOUNT, TX_HASH);

    expect(hasPendingDailyClaim(DRAW_B, ACCOUNT)).toBe(true);
    expect(hasPendingDailyClaim(DRAW_A, ACCOUNT)).toBe(false);
  });

  it("keeps per-account claims independent; any unresolved hash locks the identity", () => {
    setPendingDailyClaim(DRAW_A, ACCOUNT, TX_HASH);
    setPendingDailyClaim(DRAW_A, OTHER_ACCOUNT, TX_HASH);

    // A wrong hash cannot clear this identity's marker.
    clearPendingDailyClaim(DRAW_A, ACCOUNT, WRONG_TX_HASH);
    expect(hasPendingDailyClaim(DRAW_A, ACCOUNT)).toBe(true);

    // Two unresolved hashes coexist for one identity; clearing the newer
    // hash leaves the identity locked by the older one.
    setPendingDailyClaim(DRAW_A, ACCOUNT, NEWER_TX_HASH);
    clearPendingDailyClaim(DRAW_A, ACCOUNT, NEWER_TX_HASH);
    expect(hasPendingDailyClaim(DRAW_A, ACCOUNT)).toBe(true);

    clearPendingDailyClaim(DRAW_A, ACCOUNT, TX_HASH);
    expect(hasPendingDailyClaim(DRAW_A, ACCOUNT)).toBe(false);
    expect(hasPendingDailyClaim(DRAW_A, OTHER_ACCOUNT)).toBe(true);

    // Clearing again (even with the owning hash) is a no-op.
    clearPendingDailyClaim(DRAW_A, OTHER_ACCOUNT, TX_HASH);
    clearPendingDailyClaim(DRAW_A, OTHER_ACCOUNT, TX_HASH);
    expect(hasPendingDailyClaim(DRAW_A, OTHER_ACCOUNT)).toBe(false);
  });

  it("ignores malformed persisted values for the claim identity", () => {
    for (const key of claimKeys()) {
      for (const raw of ["{not json", "null", "42", "[1, 2]", '"text"']) {
        storage.setItem(key, raw);
        expect(hasPendingDailyClaim(DRAW_A, ACCOUNT)).toBe(false);
      }
    }
  });

  it("ignores persisted records with missing or wrong-typed fields", () => {
    for (const key of claimKeys()) {
      for (const record of INVALID_RECORDS) {
        storage.setItem(key, JSON.stringify(record));
        expect(hasPendingDailyClaim(DRAW_A, ACCOUNT)).toBe(false);
      }
    }
  });

  it("falls back to keyed module memory when storage throws", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("storage unavailable");
      },
      setItem: () => {
        throw new Error("storage unavailable");
      },
      removeItem: () => {
        throw new Error("storage unavailable");
      },
    });

    expect(() => setPendingDailyClaim(DRAW_A, ACCOUNT, TX_HASH)).not.toThrow();
    expect(() => setPendingDailyClaim(DRAW_A, OTHER_ACCOUNT, TX_HASH)).not.toThrow();
    expect(hasPendingDailyClaim(DRAW_A, ACCOUNT)).toBe(true);
    expect(hasPendingDailyClaim(DRAW_A, OTHER_ACCOUNT)).toBe(true);

    expect(() => clearPendingDailyClaim(DRAW_A, ACCOUNT, TX_HASH)).not.toThrow();
    expect(hasPendingDailyClaim(DRAW_A, ACCOUNT)).toBe(false);
    expect(hasPendingDailyClaim(DRAW_A, OTHER_ACCOUNT)).toBe(true);
  });

  it("falls back to keyed module memory when storage is absent", () => {
    vi.unstubAllGlobals();

    expect(() => setPendingDailyClaim(DRAW_A, ACCOUNT, TX_HASH)).not.toThrow();
    expect(hasPendingDailyClaim(DRAW_A, ACCOUNT)).toBe(true);
  });
});
