// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, describe, expect, it } from "vitest";

import { pendingUpgradeLock } from "@features/card/hooks/use-pending-username-upgrade.ts";
import {
  clearPendingUsernameUpgrade,
  setPendingUsernameUpgrade,
} from "@features/card/chain/pending-username-upgrade.ts";

const ADDRESS = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
const OTHER_ADDRESS = "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty";
const TX_HASH = `0x${"ab".repeat(32)}`;
const EXPIRES_AT_BLOCK = 1_256;

afterEach(() => {
  clearPendingUsernameUpgrade(ADDRESS, TX_HASH);
  clearPendingUsernameUpgrade(OTHER_ADDRESS, TX_HASH);
});

describe("pendingUpgradeLock", () => {
  it("does not lock a card with no marker", () => {
    expect(pendingUpgradeLock(ADDRESS)).toBe(false);
    expect(pendingUpgradeLock(ADDRESS, EXPIRES_AT_BLOCK + 1)).toBe(false);
  });

  it("locks while the finalized head is unknown", () => {
    setPendingUsernameUpgrade(ADDRESS, "alicejones", TX_HASH, EXPIRES_AT_BLOCK);

    expect(pendingUpgradeLock(ADDRESS, undefined)).toBe(true);
  });

  it("keeps locking while the head is still inside the marker's era", () => {
    setPendingUsernameUpgrade(ADDRESS, "alicejones", TX_HASH, EXPIRES_AT_BLOCK);

    expect(pendingUpgradeLock(ADDRESS, EXPIRES_AT_BLOCK - 1)).toBe(true);
  });

  it("releases once the head reaches the marker's era checkpoint", () => {
    setPendingUsernameUpgrade(ADDRESS, "alicejones", TX_HASH, EXPIRES_AT_BLOCK);

    expect(pendingUpgradeLock(ADDRESS, EXPIRES_AT_BLOCK)).toBe(false);
  });

  it("stays released after expiry even without a head, the record being gone", () => {
    setPendingUsernameUpgrade(ADDRESS, "alicejones", TX_HASH, EXPIRES_AT_BLOCK);
    pendingUpgradeLock(ADDRESS, EXPIRES_AT_BLOCK + 100);

    expect(pendingUpgradeLock(ADDRESS)).toBe(false);
  });

  it("never lets one account's marker lock another", () => {
    setPendingUsernameUpgrade(ADDRESS, "alicejones", TX_HASH, EXPIRES_AT_BLOCK);

    expect(pendingUpgradeLock(OTHER_ADDRESS)).toBe(false);
    expect(pendingUpgradeLock(OTHER_ADDRESS, EXPIRES_AT_BLOCK - 1)).toBe(false);
  });

  it("never locks without an account to scope the marker to", () => {
    setPendingUsernameUpgrade(ADDRESS, "alicejones", TX_HASH, EXPIRES_AT_BLOCK);

    expect(pendingUpgradeLock("")).toBe(false);
  });
});
