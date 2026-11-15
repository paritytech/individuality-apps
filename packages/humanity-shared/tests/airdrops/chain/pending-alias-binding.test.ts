// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearPendingAliasBinding,
  hasPendingAliasBinding,
  setPendingAliasBinding,
} from "@humanity/shared/airdrops/chain/pending-alias-binding.ts";

const ACCOUNT = "5AirdropAccount";
const OTHER_ACCOUNT = "5OtherAccount";
const TX_HASH = `0x${"aa".repeat(32)}`;

class FakeStorage {
  private readonly entries = new Map<string, string>();
  get length(): number {
    return this.entries.size;
  }
  key(index: number): string | null {
    return [...this.entries.keys()][index] ?? null;
  }
  getItem(key: string): string | null {
    return this.entries.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.entries.set(key, value);
  }
  removeItem(key: string): void {
    this.entries.delete(key);
  }
}

beforeEach(() => {
  vi.stubGlobal("localStorage", new FakeStorage());
});

afterEach(() => {
  clearPendingAliasBinding(ACCOUNT, TX_HASH);
  clearPendingAliasBinding(OTHER_ACCOUNT, TX_HASH);
  vi.unstubAllGlobals();
});

describe("pending alias binding", () => {
  it("keeps a broadcast locked until that exact hash is cleared", () => {
    setPendingAliasBinding(ACCOUNT, TX_HASH);
    expect(hasPendingAliasBinding(ACCOUNT)).toBe(true);
    expect(hasPendingAliasBinding(OTHER_ACCOUNT)).toBe(false);

    clearPendingAliasBinding(ACCOUNT, `0x${"bb".repeat(32)}`);
    expect(hasPendingAliasBinding(ACCOUNT)).toBe(true);

    clearPendingAliasBinding(ACCOUNT, TX_HASH);
    expect(hasPendingAliasBinding(ACCOUNT)).toBe(false);
  });

  it("ignores malformed records", () => {
    setPendingAliasBinding("", "not-a-hash");
    expect(hasPendingAliasBinding("")).toBe(false);
  });
});
