// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearPendingRegistration,
  hasPendingRegistration,
  setPendingRegistration,
} from "@humanity/shared/airdrops/chain/pending-registration.ts";

const EVENT_A = `0x${"11".repeat(32)}`;
const EVENT_B = `0x${"22".repeat(32)}`;
const ACCOUNT = "5Alice";
const OTHER_ACCOUNT = "5Bob";
const TX_HASH = `0x${"ab".repeat(32)}`;
const NEWER_TX_HASH = `0x${"ef".repeat(32)}`;

const VALID_RECORD = {
  eventId: EVENT_A,
  accountAddress: ACCOUNT,
  txHash: TX_HASH,
};

class FakeHostLocalStorage {
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

let storage: FakeHostLocalStorage;

function pendingKeys(): string[] {
  setPendingRegistration([EVENT_A], ACCOUNT, TX_HASH);
  const keys = Array.from(
    { length: storage.length },
    (_, i) => storage.key(i) as string,
  );
  clearPendingRegistration([EVENT_A], ACCOUNT, TX_HASH);
  return keys;
}

describe("pending-registration duplicate lock", () => {
  beforeEach(() => {
    storage = new FakeHostLocalStorage();
    vi.stubGlobal("localStorage", storage);
    for (const event of [EVENT_A, EVENT_B]) {
      for (const account of [ACCOUNT, OTHER_ACCOUNT]) {
        for (const hash of [TX_HASH, NEWER_TX_HASH]) {
          clearPendingRegistration([event], account, hash);
        }
      }
    }
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("persists one record per event id and matches the exact identity", () => {
    setPendingRegistration([EVENT_A], ACCOUNT, TX_HASH);

    expect(hasPendingRegistration(EVENT_A, ACCOUNT)).toBe(true);
    const persisted = storage
      .keys()
      .map((key) => JSON.parse(storage.getItem(key) as string));
    expect(persisted).toContainEqual(VALID_RECORD);
  });

  it("persists distinct records for distinct event ids in one batch", () => {
    setPendingRegistration([EVENT_A, EVENT_B], ACCOUNT, TX_HASH);

    expect(hasPendingRegistration(EVENT_A, ACCOUNT)).toBe(true);
    expect(hasPendingRegistration(EVENT_B, ACCOUNT)).toBe(true);
  });

  it("does not match on a different event or account", () => {
    setPendingRegistration([EVENT_A], ACCOUNT, TX_HASH);

    expect(hasPendingRegistration(EVENT_B, ACCOUNT)).toBe(false);
    expect(hasPendingRegistration(EVENT_A, OTHER_ACCOUNT)).toBe(false);
  });

  it("clearing one event id leaves a sibling id pending", () => {
    setPendingRegistration([EVENT_A, EVENT_B], ACCOUNT, TX_HASH);

    clearPendingRegistration([EVENT_A], ACCOUNT, TX_HASH);

    expect(hasPendingRegistration(EVENT_A, ACCOUNT)).toBe(false);
    expect(hasPendingRegistration(EVENT_B, ACCOUNT)).toBe(true);

    clearPendingRegistration([EVENT_B], ACCOUNT, TX_HASH);
    expect(hasPendingRegistration(EVENT_B, ACCOUNT)).toBe(false);
  });

  it("clears only this attempt's hash; a wrong hash never unlocks the identity", () => {
    setPendingRegistration([EVENT_A], ACCOUNT, TX_HASH);
    setPendingRegistration([EVENT_A], OTHER_ACCOUNT, TX_HASH);

    clearPendingRegistration([EVENT_A], ACCOUNT, NEWER_TX_HASH);
    expect(hasPendingRegistration(EVENT_A, ACCOUNT)).toBe(true);

    clearPendingRegistration([EVENT_A], ACCOUNT, TX_HASH);
    expect(hasPendingRegistration(EVENT_A, ACCOUNT)).toBe(false);
    expect(hasPendingRegistration(EVENT_A, OTHER_ACCOUNT)).toBe(true);

    clearPendingRegistration([EVENT_A], OTHER_ACCOUNT, TX_HASH);
    clearPendingRegistration([EVENT_A], OTHER_ACCOUNT, TX_HASH);
    expect(hasPendingRegistration(EVENT_A, OTHER_ACCOUNT)).toBe(false);
  });

  it("ignores malformed persisted values for the identity", () => {
    for (const key of pendingKeys()) {
      for (const raw of ["{not json", "null", "42", "[1, 2]", '"text"']) {
        storage.setItem(key, raw);
        expect(hasPendingRegistration(EVENT_A, ACCOUNT)).toBe(false);
      }
    }
  });

  it("ignores persisted records with missing or wrong-typed fields", () => {
    const invalid: Record<string, unknown>[] = [
      { eventId: EVENT_A, accountAddress: ACCOUNT },
      { ...VALID_RECORD, eventId: 42 },
      { ...VALID_RECORD, accountAddress: 42 },
      { ...VALID_RECORD, txHash: { hex: true } },
      { ...VALID_RECORD, eventId: "not-a-hex-event" },
      { ...VALID_RECORD, eventId: "" },
      { ...VALID_RECORD, accountAddress: "" },
      { ...VALID_RECORD, txHash: "not-a-hex-hash" },
      { ...VALID_RECORD, txHash: "0xGG" },
      { ...VALID_RECORD, txHash: "" },
    ];
    for (const key of pendingKeys()) {
      for (const record of invalid) {
        storage.setItem(key, JSON.stringify(record));
        expect(hasPendingRegistration(EVENT_A, ACCOUNT)).toBe(false);
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

    expect(() => setPendingRegistration([EVENT_A], ACCOUNT, TX_HASH)).not.toThrow();
    expect(hasPendingRegistration(EVENT_A, ACCOUNT)).toBe(true);

    expect(() => clearPendingRegistration([EVENT_A], ACCOUNT, TX_HASH)).not.toThrow();
    expect(hasPendingRegistration(EVENT_A, ACCOUNT)).toBe(false);
  });

  it("falls back to keyed module memory when storage is absent", () => {
    vi.unstubAllGlobals();

    expect(() => setPendingRegistration([EVENT_A], ACCOUNT, TX_HASH)).not.toThrow();
    expect(hasPendingRegistration(EVENT_A, ACCOUNT)).toBe(true);
  });
});