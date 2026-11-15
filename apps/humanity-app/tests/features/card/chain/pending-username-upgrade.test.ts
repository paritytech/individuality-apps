// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ADDRESS = "5AliceLiteAddress";
const OTHER_ADDRESS = "5BobLiteAddress";
const FULL_USERNAME = "aliceperson";
const TX_HASH = `0x${"ab".repeat(32)}`;
const WRONG_TX_HASH = `0x${"cd".repeat(32)}`;
const NEWER_TX_HASH = `0x${"ef".repeat(32)}`;
const EXPIRY_BLOCK = 12_601;

const VALID_RECORD = {
  address: ADDRESS,
  fullUsername: FULL_USERNAME,
  txHash: TX_HASH,
  expiresAtBlock: EXPIRY_BLOCK,
};

/** In-memory Storage stand-in; keys are implementation details, discovered behaviorally. */
class MemoryStorage {
  private readonly entries: Record<string, string> = {};

  get length(): number {
    return Object.keys(this.entries).length;
  }

  key(index: number): string | null {
    return Object.keys(this.entries)[index] ?? null;
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

let storage: MemoryStorage;

/** Keys the module persists markers under, discovered via standard length/key. */
function markerKeys(): string[] {
  return Array.from({ length: storage.length }, (_, i) => storage.key(i) as string);
}

async function importModule() {
  return import("@features/card/chain/pending-username-upgrade.ts");
}

describe("pending-username-upgrade marker", () => {
  beforeEach(() => {
    storage = new MemoryStorage();
    vi.stubGlobal("localStorage", storage);
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("persists the record with its era checkpoint and matches the exact address", async () => {
    const { setPendingUsernameUpgrade, hasPendingUsernameUpgrade } =
      await importModule();
    setPendingUsernameUpgrade(ADDRESS, FULL_USERNAME, TX_HASH, EXPIRY_BLOCK);

    expect(hasPendingUsernameUpgrade(ADDRESS)).toBe(true);
    const persisted = markerKeys().map((key) =>
      JSON.parse(storage.getItem(key) as string),
    );
    expect(persisted).toContainEqual({
      ...VALID_RECORD,
      phase: "broadcast",
      broadcastAt: expect.any(Number),
    });
  });

  it("does not match a different address", async () => {
    const { setPendingUsernameUpgrade, hasPendingUsernameUpgrade } =
      await importModule();
    setPendingUsernameUpgrade(ADDRESS, FULL_USERNAME, TX_HASH, EXPIRY_BLOCK);

    expect(hasPendingUsernameUpgrade(OTHER_ADDRESS)).toBe(false);
  });

  it("a reload sees a marker persisted before it", async () => {
    const first = await importModule();
    first.setPendingUsernameUpgrade(ADDRESS, FULL_USERNAME, TX_HASH, EXPIRY_BLOCK);

    vi.resetModules();
    const reloaded = await importModule();
    expect(reloaded.hasPendingUsernameUpgrade(ADDRESS)).toBe(true);
  });

  it("keeps per-address markers independent; a wrong hash cannot unlock", async () => {
    const { setPendingUsernameUpgrade, clearPendingUsernameUpgrade, hasPendingUsernameUpgrade } =
      await importModule();
    setPendingUsernameUpgrade(ADDRESS, FULL_USERNAME, TX_HASH, EXPIRY_BLOCK);
    setPendingUsernameUpgrade(OTHER_ADDRESS, FULL_USERNAME, TX_HASH, EXPIRY_BLOCK);

    clearPendingUsernameUpgrade(ADDRESS, WRONG_TX_HASH);
    expect(hasPendingUsernameUpgrade(ADDRESS)).toBe(true);

    setPendingUsernameUpgrade(ADDRESS, FULL_USERNAME, NEWER_TX_HASH, EXPIRY_BLOCK);
    clearPendingUsernameUpgrade(ADDRESS, NEWER_TX_HASH);
    expect(hasPendingUsernameUpgrade(ADDRESS)).toBe(true);

    clearPendingUsernameUpgrade(ADDRESS, TX_HASH);
    expect(hasPendingUsernameUpgrade(ADDRESS)).toBe(false);
    expect(hasPendingUsernameUpgrade(OTHER_ADDRESS)).toBe(true);

    clearPendingUsernameUpgrade(OTHER_ADDRESS, TX_HASH);
    clearPendingUsernameUpgrade(OTHER_ADDRESS, TX_HASH);
    expect(hasPendingUsernameUpgrade(OTHER_ADDRESS)).toBe(false);
  });

  it("clears the persisted record on the owning hash", async () => {
    const { setPendingUsernameUpgrade, clearPendingUsernameUpgrade, hasPendingUsernameUpgrade } =
      await importModule();
    setPendingUsernameUpgrade(ADDRESS, FULL_USERNAME, TX_HASH, EXPIRY_BLOCK);
    clearPendingUsernameUpgrade(ADDRESS, TX_HASH);

    expect(hasPendingUsernameUpgrade(ADDRESS)).toBe(false);
    expect(markerKeys()).toHaveLength(0);
  });

  it("ignores malformed persisted values for the address", async () => {
    const {
      setPendingUsernameUpgrade,
      clearPendingUsernameUpgrade,
      hasPendingUsernameUpgrade,
    } = await importModule();
    setPendingUsernameUpgrade(ADDRESS, FULL_USERNAME, TX_HASH, EXPIRY_BLOCK);
    const keys = markerKeys();
    clearPendingUsernameUpgrade(ADDRESS, TX_HASH);

    for (const key of keys) {
      for (const raw of ["{not json", "null", "42", "[1, 2]", '"text"']) {
        storage.setItem(key, raw);
        expect(hasPendingUsernameUpgrade(ADDRESS)).toBe(false);
      }
    }
  });

  it("ignores persisted records with missing or wrong-typed fields", async () => {
    const {
      setPendingUsernameUpgrade,
      clearPendingUsernameUpgrade,
      hasPendingUsernameUpgrade,
    } = await importModule();
    setPendingUsernameUpgrade(ADDRESS, FULL_USERNAME, TX_HASH, EXPIRY_BLOCK);
    const keys = markerKeys();
    clearPendingUsernameUpgrade(ADDRESS, TX_HASH);

    const invalid: Record<string, unknown>[] = [
      // Missing txHash.
      { address: ADDRESS, fullUsername: FULL_USERNAME, expiresAtBlock: EXPIRY_BLOCK },
      // Missing expiresAtBlock.
      { address: ADDRESS, fullUsername: FULL_USERNAME, txHash: TX_HASH },
      // Wrong-typed fields.
      { ...VALID_RECORD, address: 42 },
      { ...VALID_RECORD, fullUsername: 42 },
      { ...VALID_RECORD, txHash: { hex: true } },
      // Wrong-typed or invalid expiresAtBlock.
      { ...VALID_RECORD, expiresAtBlock: "12601" },
      { ...VALID_RECORD, expiresAtBlock: {} },
      { ...VALID_RECORD, expiresAtBlock: null },
      { ...VALID_RECORD, expiresAtBlock: 12_600.5 },
      { ...VALID_RECORD, expiresAtBlock: 0 },
      { ...VALID_RECORD, expiresAtBlock: -1 },
      // Non-username fullUsername.
      { ...VALID_RECORD, fullUsername: "Alice" },
      { ...VALID_RECORD, fullUsername: "alice123" },
      { ...VALID_RECORD, fullUsername: "" },
      // Unknown phase or invalid broadcast time; JSON turns NaN into null.
      { ...VALID_RECORD, phase: "finalized" },
      { ...VALID_RECORD, phase: null },
      { ...VALID_RECORD, broadcastAt: "1700000000000" },
      { ...VALID_RECORD, broadcastAt: -1 },
      { ...VALID_RECORD, broadcastAt: Number.NaN },
      // Empty address and non-hex txHash.
      { ...VALID_RECORD, address: "" },
      { ...VALID_RECORD, txHash: "not-a-hex-hash" },
      { ...VALID_RECORD, txHash: "0xGG" },
      { ...VALID_RECORD, txHash: "" },
    ];
    for (const key of keys) {
      for (const record of invalid) {
        storage.setItem(key, JSON.stringify(record));
        expect(hasPendingUsernameUpgrade(ADDRESS)).toBe(false);
      }
    }
  });

  it("falls back to keyed module memory when storage throws", async () => {
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

    const { setPendingUsernameUpgrade, clearPendingUsernameUpgrade, hasPendingUsernameUpgrade } =
      await importModule();
    expect(() =>
      setPendingUsernameUpgrade(ADDRESS, FULL_USERNAME, TX_HASH, EXPIRY_BLOCK),
    ).not.toThrow();
    expect(() =>
      setPendingUsernameUpgrade(OTHER_ADDRESS, FULL_USERNAME, TX_HASH, EXPIRY_BLOCK),
    ).not.toThrow();
    expect(hasPendingUsernameUpgrade(ADDRESS)).toBe(true);
    expect(hasPendingUsernameUpgrade(OTHER_ADDRESS)).toBe(true);

    expect(() =>
      clearPendingUsernameUpgrade(ADDRESS, TX_HASH),
    ).not.toThrow();
    expect(hasPendingUsernameUpgrade(ADDRESS)).toBe(false);
    expect(hasPendingUsernameUpgrade(OTHER_ADDRESS)).toBe(true);
  });

  it("falls back to keyed module memory when storage is absent", async () => {
    vi.unstubAllGlobals();

    const { setPendingUsernameUpgrade, hasPendingUsernameUpgrade } =
      await importModule();
    expect(() =>
      setPendingUsernameUpgrade(ADDRESS, FULL_USERNAME, TX_HASH, EXPIRY_BLOCK),
    ).not.toThrow();
    expect(hasPendingUsernameUpgrade(ADDRESS)).toBe(true);
  });

  it("stays locked without a finalized block, even past its checkpoint", async () => {
    const { setPendingUsernameUpgrade, hasPendingUsernameUpgrade } =
      await importModule();
    setPendingUsernameUpgrade(ADDRESS, FULL_USERNAME, TX_HASH, EXPIRY_BLOCK);

    expect(hasPendingUsernameUpgrade(ADDRESS, EXPIRY_BLOCK - 1)).toBe(true);
    expect(hasPendingUsernameUpgrade(ADDRESS)).toBe(true);
  });

  it("treats an invalid finalized block as unknown and never unlocks or removes", async () => {
    const { setPendingUsernameUpgrade, hasPendingUsernameUpgrade } =
      await importModule();
    setPendingUsernameUpgrade(ADDRESS, FULL_USERNAME, TX_HASH, EXPIRY_BLOCK);

    expect(hasPendingUsernameUpgrade(ADDRESS, Number.NaN)).toBe(true);
    expect(hasPendingUsernameUpgrade(ADDRESS, -1)).toBe(true);
    expect(hasPendingUsernameUpgrade(ADDRESS, Number.POSITIVE_INFINITY)).toBe(true);
    expect(hasPendingUsernameUpgrade(ADDRESS, Number.NEGATIVE_INFINITY)).toBe(true);
    expect(markerKeys()).toHaveLength(1);
  });

  it("a marker whose checkpoint lies far ahead stays valid until reached", async () => {
    const { setPendingUsernameUpgrade, hasPendingUsernameUpgrade } =
      await importModule();
    setPendingUsernameUpgrade(
      ADDRESS,
      FULL_USERNAME,
      TX_HASH,
      EXPIRY_BLOCK + 1_000_000,
    );

    expect(hasPendingUsernameUpgrade(ADDRESS, EXPIRY_BLOCK)).toBe(true);
    expect(markerKeys()).toHaveLength(1);

    expect(hasPendingUsernameUpgrade(ADDRESS, EXPIRY_BLOCK + 1_000_000)).toBe(false);
    expect(markerKeys()).toHaveLength(0);
  });

  it("unlocks and removes the marker once the finalized block reaches its checkpoint", async () => {
    const { setPendingUsernameUpgrade, hasPendingUsernameUpgrade } =
      await importModule();
    setPendingUsernameUpgrade(ADDRESS, FULL_USERNAME, TX_HASH, EXPIRY_BLOCK);

    expect(hasPendingUsernameUpgrade(ADDRESS, EXPIRY_BLOCK)).toBe(false);
    expect(markerKeys()).toHaveLength(0);

    vi.resetModules();
    const reloaded = await importModule();
    expect(reloaded.hasPendingUsernameUpgrade(ADDRESS, EXPIRY_BLOCK)).toBe(false);
    expect(markerKeys()).toHaveLength(0);
  });

  it("expires module-memory markers as well when storage is absent", async () => {
    vi.unstubAllGlobals();

    const { setPendingUsernameUpgrade, hasPendingUsernameUpgrade } =
      await importModule();
    setPendingUsernameUpgrade(ADDRESS, FULL_USERNAME, TX_HASH, EXPIRY_BLOCK);
    expect(hasPendingUsernameUpgrade(ADDRESS)).toBe(true);

    expect(hasPendingUsernameUpgrade(ADDRESS, EXPIRY_BLOCK)).toBe(false);
    expect(hasPendingUsernameUpgrade(ADDRESS)).toBe(false);
  });
});

describe("pending-username-upgrade phases", () => {
  beforeEach(() => {
    storage = new MemoryStorage();
    vi.stubGlobal("localStorage", storage);
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("starts in broadcast with its broadcast time and persists the included phase", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    const {
      setPendingUsernameUpgrade,
      markPendingUsernameUpgradeIncluded,
      readPendingUsernameUpgrade,
    } = await importModule();
    setPendingUsernameUpgrade(ADDRESS, FULL_USERNAME, TX_HASH, EXPIRY_BLOCK);
    expect(readPendingUsernameUpgrade(ADDRESS)).toEqual({
      ...VALID_RECORD,
      phase: "broadcast",
      broadcastAt: 1_700_000_000_000,
    });

    markPendingUsernameUpgradeIncluded(ADDRESS, TX_HASH);
    vi.resetModules();
    const reloaded = await importModule();
    expect(reloaded.readPendingUsernameUpgrade(ADDRESS)).toEqual({
      ...VALID_RECORD,
      phase: "included",
      broadcastAt: 1_700_000_000_000,
    });
  });

  it("never creates a marker when marking an unknown hash included", async () => {
    const {
      setPendingUsernameUpgrade,
      markPendingUsernameUpgradeIncluded,
      readPendingUsernameUpgrade,
    } = await importModule();
    markPendingUsernameUpgradeIncluded(ADDRESS, TX_HASH);
    expect(readPendingUsernameUpgrade(ADDRESS)).toBeNull();
    expect(markerKeys()).toHaveLength(0);

    setPendingUsernameUpgrade(ADDRESS, FULL_USERNAME, TX_HASH, EXPIRY_BLOCK);
    markPendingUsernameUpgradeIncluded(ADDRESS, WRONG_TX_HASH);
    markPendingUsernameUpgradeIncluded(OTHER_ADDRESS, TX_HASH);
    expect(readPendingUsernameUpgrade(ADDRESS)?.phase).toBe("broadcast");
    expect(readPendingUsernameUpgrade(OTHER_ADDRESS)).toBeNull();
    expect(markerKeys()).toHaveLength(1);
  });

  it("parses a legacy record without phase or broadcast time as broadcast at 0", async () => {
    const first = await importModule();
    first.setPendingUsernameUpgrade(ADDRESS, FULL_USERNAME, TX_HASH, EXPIRY_BLOCK);
    const [key] = markerKeys();
    storage.setItem(key as string, JSON.stringify(VALID_RECORD));

    vi.resetModules();
    const reloaded = await importModule();
    expect(reloaded.readPendingUsernameUpgrade(ADDRESS)).toEqual({
      ...VALID_RECORD,
      phase: "broadcast",
      broadcastAt: 0,
    });
    expect(reloaded.hasPendingUsernameUpgrade(ADDRESS)).toBe(true);

    reloaded.markPendingUsernameUpgradeIncluded(ADDRESS, TX_HASH);
    expect(reloaded.readPendingUsernameUpgrade(ADDRESS)?.phase).toBe("included");
  });

  it("reads the newest unexpired marker and removes expired ones", async () => {
    const now = vi.spyOn(Date, "now");
    const {
      setPendingUsernameUpgrade,
      readPendingUsernameUpgrade,
    } = await importModule();
    now.mockReturnValue(1_000);
    setPendingUsernameUpgrade(ADDRESS, FULL_USERNAME, TX_HASH, EXPIRY_BLOCK + 100);
    now.mockReturnValue(2_000);
    setPendingUsernameUpgrade(ADDRESS, "alicenewer", NEWER_TX_HASH, EXPIRY_BLOCK);
    setPendingUsernameUpgrade(OTHER_ADDRESS, "bobbyperson", WRONG_TX_HASH, EXPIRY_BLOCK);

    expect(readPendingUsernameUpgrade(ADDRESS)).toMatchObject({
      txHash: NEWER_TX_HASH,
      fullUsername: "alicenewer",
    });

    expect(readPendingUsernameUpgrade(ADDRESS, EXPIRY_BLOCK)).toMatchObject({
      txHash: TX_HASH,
      fullUsername: FULL_USERNAME,
    });
    expect(markerKeys()).toHaveLength(2);

    vi.resetModules();
    const reloaded = await importModule();
    expect(reloaded.readPendingUsernameUpgrade(ADDRESS)?.txHash).toBe(TX_HASH);
    expect(reloaded.readPendingUsernameUpgrade(ADDRESS, EXPIRY_BLOCK + 100)).toBeNull();
    expect(reloaded.readPendingUsernameUpgrade(OTHER_ADDRESS)?.txHash).toBe(
      WRONG_TX_HASH,
    );
  });

  it("advances the phase in module memory when storage throws", async () => {
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
    const {
      setPendingUsernameUpgrade,
      markPendingUsernameUpgradeIncluded,
      readPendingUsernameUpgrade,
    } = await importModule();
    setPendingUsernameUpgrade(ADDRESS, FULL_USERNAME, TX_HASH, EXPIRY_BLOCK);
    markPendingUsernameUpgradeIncluded(ADDRESS, TX_HASH);
    expect(readPendingUsernameUpgrade(ADDRESS)?.phase).toBe("included");
  });
});

describe("failed username upgrade record", () => {
  beforeEach(() => {
    storage = new MemoryStorage();
    vi.stubGlobal("localStorage", storage);
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("records, survives a reload, and clears per address", async () => {
    const first = await importModule();
    first.recordFailedUsernameUpgrade(ADDRESS, FULL_USERNAME);
    first.recordFailedUsernameUpgrade(OTHER_ADDRESS, "bobbyperson");
    expect(storage.getItem(`humanity:failed-username-upgrade:${ADDRESS}`)).not.toBeNull();

    vi.resetModules();
    const reloaded = await importModule();
    expect(reloaded.readFailedUsernameUpgrade(ADDRESS)).toEqual({
      address: ADDRESS,
      fullUsername: FULL_USERNAME,
    });

    reloaded.clearFailedUsernameUpgrade(ADDRESS);
    expect(reloaded.readFailedUsernameUpgrade(ADDRESS)).toBeNull();
    expect(reloaded.readFailedUsernameUpgrade(OTHER_ADDRESS)).toEqual({
      address: OTHER_ADDRESS,
      fullUsername: "bobbyperson",
    });
  });

  it("ignores invalid usernames and malformed persisted values", async () => {
    const { recordFailedUsernameUpgrade, readFailedUsernameUpgrade } =
      await importModule();
    recordFailedUsernameUpgrade(ADDRESS, "Alice");
    recordFailedUsernameUpgrade("", FULL_USERNAME);
    expect(readFailedUsernameUpgrade(ADDRESS)).toBeNull();
    expect(markerKeys()).toHaveLength(0);

    const key = `humanity:failed-username-upgrade:${ADDRESS}`;
    for (const raw of [
      "{not json",
      "null",
      JSON.stringify({ address: ADDRESS, fullUsername: "alice123" }),
      JSON.stringify({ address: OTHER_ADDRESS, fullUsername: FULL_USERNAME }),
    ]) {
      storage.setItem(key, raw);
      expect(readFailedUsernameUpgrade(ADDRESS)).toBeNull();
    }
  });

  it("a new broadcast replaces the failed record for that address only", async () => {
    const {
      setPendingUsernameUpgrade,
      recordFailedUsernameUpgrade,
      readFailedUsernameUpgrade,
    } = await importModule();
    recordFailedUsernameUpgrade(ADDRESS, FULL_USERNAME);
    recordFailedUsernameUpgrade(OTHER_ADDRESS, "bobbyperson");

    setPendingUsernameUpgrade(ADDRESS, FULL_USERNAME, TX_HASH, EXPIRY_BLOCK);
    expect(readFailedUsernameUpgrade(ADDRESS)).toBeNull();
    expect(readFailedUsernameUpgrade(OTHER_ADDRESS)).not.toBeNull();
  });

  it("falls back to module memory when storage throws", async () => {
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
    const {
      recordFailedUsernameUpgrade,
      readFailedUsernameUpgrade,
      clearFailedUsernameUpgrade,
    } = await importModule();
    expect(() => recordFailedUsernameUpgrade(ADDRESS, FULL_USERNAME)).not.toThrow();
    expect(readFailedUsernameUpgrade(ADDRESS)?.fullUsername).toBe(FULL_USERNAME);

    expect(() => clearFailedUsernameUpgrade(ADDRESS)).not.toThrow();
    expect(readFailedUsernameUpgrade(ADDRESS)).toBeNull();
  });
});

describe("username upgrade state notifications", () => {
  beforeEach(() => {
    storage = new MemoryStorage();
    vi.stubGlobal("localStorage", storage);
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("notifies synchronously and bumps the version on every mutation", async () => {
    const store = await importModule();
    const listener = vi.fn();
    store.subscribeUsernameUpgradeState(listener);
    const versions: number[] = [store.getUsernameUpgradeStateVersion()];
    const expectNotified = (times: number) => {
      expect(listener).toHaveBeenCalledTimes(times);
      const version = store.getUsernameUpgradeStateVersion();
      expect(version).toBeGreaterThan(versions.at(-1) as number);
      versions.push(version);
    };

    store.setPendingUsernameUpgrade(ADDRESS, FULL_USERNAME, TX_HASH, EXPIRY_BLOCK);
    expectNotified(1);
    store.markPendingUsernameUpgradeIncluded(ADDRESS, TX_HASH);
    expectNotified(2);
    store.clearPendingUsernameUpgrade(ADDRESS, TX_HASH);
    expectNotified(3);
    store.recordFailedUsernameUpgrade(ADDRESS, FULL_USERNAME);
    expectNotified(4);
    store.clearFailedUsernameUpgrade(ADDRESS);
    expectNotified(5);
    store.setPendingUsernameUpgrade(ADDRESS, FULL_USERNAME, TX_HASH, EXPIRY_BLOCK);
    expectNotified(6);
    expect(store.hasPendingUsernameUpgrade(ADDRESS, EXPIRY_BLOCK)).toBe(false);
    expectNotified(7);
  });

  it("stays quiet for no-op mutations and plain reads", async () => {
    const store = await importModule();
    store.setPendingUsernameUpgrade(ADDRESS, FULL_USERNAME, TX_HASH, EXPIRY_BLOCK);
    store.markPendingUsernameUpgradeIncluded(ADDRESS, TX_HASH);
    const listener = vi.fn();
    store.subscribeUsernameUpgradeState(listener);
    const version = store.getUsernameUpgradeStateVersion();

    store.markPendingUsernameUpgradeIncluded(ADDRESS, TX_HASH);
    store.markPendingUsernameUpgradeIncluded(ADDRESS, WRONG_TX_HASH);
    store.clearPendingUsernameUpgrade(ADDRESS, WRONG_TX_HASH);
    store.clearFailedUsernameUpgrade(ADDRESS);
    store.readPendingUsernameUpgrade(ADDRESS, EXPIRY_BLOCK - 1);
    store.readFailedUsernameUpgrade(ADDRESS);

    expect(listener).not.toHaveBeenCalled();
    expect(store.getUsernameUpgradeStateVersion()).toBe(version);
  });

  it("stops notifying after unsubscribe", async () => {
    const store = await importModule();
    const listener = vi.fn();
    const unsubscribe = store.subscribeUsernameUpgradeState(listener);
    unsubscribe();

    store.setPendingUsernameUpgrade(ADDRESS, FULL_USERNAME, TX_HASH, EXPIRY_BLOCK);
    expect(listener).not.toHaveBeenCalled();
  });
});
