// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest";

import { scopeUpgradeState } from "@features/card/username-upgrade-state.ts";

const ACCOUNT_A = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
const ACCOUNT_B = "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty";
const TX_HASH = "0x" + "ab".repeat(32);

const idle = {
  isPending: false,
  data: undefined,
  variables: undefined,
};

const forAccount = (address: string) => ({
  expectedLiteAddress: address,
  currentLiteUsername: "alice.42",
  fullUsername: "alicejones",
});

describe("scopeUpgradeState", () => {
  it("locks and confirms the account the upgrade was submitted for", () => {
    expect(
      scopeUpgradeState(
        {
          ...idle,
          data: { status: "included", txHash: TX_HASH },
          variables: forAccount(ACCOUNT_A),
        },
        ACCOUNT_A,
        false,
      ),
    ).toEqual({ pending: false, unknown: false, confirmed: true });
  });

  it("reads an included claim as confirmed while its marker awaits finality", () => {
    expect(
      scopeUpgradeState(
        {
          ...idle,
          data: { status: "included", txHash: TX_HASH },
          variables: forAccount(ACCOUNT_A),
        },
        ACCOUNT_A,
        true,
      ),
    ).toEqual({ pending: false, unknown: false, confirmed: true });
  });

  it("keeps an unknown result locking its own account", () => {
    expect(
      scopeUpgradeState(
        {
          ...idle,
          data: { status: "unknown", txHash: TX_HASH },
          variables: forAccount(ACCOUNT_A),
        },
        ACCOUNT_A,
        false,
      ),
    ).toEqual({ pending: false, unknown: true, confirmed: false });
  });

  it("never lets an included result for another account affect this one", () => {
    expect(
      scopeUpgradeState(
        {
          ...idle,
          data: { status: "included", txHash: TX_HASH },
          variables: forAccount(ACCOUNT_A),
        },
        ACCOUNT_B,
        false,
      ),
    ).toEqual({ pending: false, unknown: false, confirmed: false });
  });

  it("never lets an unknown result for another account lock this one", () => {
    expect(
      scopeUpgradeState(
        {
          ...idle,
          data: { status: "unknown", txHash: TX_HASH },
          variables: forAccount(ACCOUNT_A),
        },
        ACCOUNT_B,
        false,
      ).unknown,
    ).toBe(false);
  });

  it("never lets an in-flight upgrade of another account make this one inert", () => {
    expect(
      scopeUpgradeState(
        { ...idle, isPending: true, variables: forAccount(ACCOUNT_A) },
        ACCOUNT_B,
        false,
      ).pending,
    ).toBe(false);
  });

  it("keeps an in-flight upgrade of the current account inert", () => {
    expect(
      scopeUpgradeState(
        { ...idle, isPending: true, variables: forAccount(ACCOUNT_A) },
        ACCOUNT_A,
        false,
      ).pending,
    ).toBe(true);
  });


  it("still locks on the address-scoped persisted marker with no mutation state", () => {
    expect(scopeUpgradeState(idle, ACCOUNT_A, true)).toEqual({
      pending: false,
      unknown: true,
      confirmed: false,
    });
  });
});
