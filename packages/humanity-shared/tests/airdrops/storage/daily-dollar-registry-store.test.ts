// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  DAILY_DOLLAR_REGISTRY_VERSION,
  type DailyDollarRegistry,
  type Hex32,
} from "@individuality/daily-dollar";
import {
  applyRegistrationSubmitted,
  emptyRegistry,
} from "@humanity/shared/airdrops/domain/daily-dollar-registry.ts";
import {
  DAILY_DOLLAR_REGISTRY_KEY_PREFIX,
  __resetDailyDollarRegistryStoreForTests,
  readDailyDollarRegistry,
  updateDailyDollarRegistry,
  writeDailyDollarRegistry,
} from "@humanity/shared/airdrops/storage/daily-dollar-registry-store.ts";

const ACCOUNT = "5Alice";
const EVENT_A = `0x${"1".padStart(64, "0")}` as Hex32;
const EVENT_B = `0x${"2".padStart(64, "0")}` as Hex32;

/**
 * In-memory stand-in for the host store, with a deliberate await between read
 * and write so an unserialized read-modify-write would interleave and lose an
 * update.
 */
const host = vi.hoisted(() => {
  const entries = new Map<string, string>();
  const failures = { get: false, set: false };
  return {
    entries,
    failures,
    store: {
      async getJSON(key: string): Promise<unknown> {
        await Promise.resolve();
        if (failures.get) throw new Error("host storage unavailable");
        const raw = entries.get(key);
        return raw == null ? null : (JSON.parse(raw) as unknown);
      },
      async setJSON(key: string, value: unknown): Promise<void> {
        await Promise.resolve();
        if (failures.set) throw new Error("host storage read-only");
        entries.set(key, JSON.stringify(value));
      },
    },
  };
});

vi.mock("@humanity/shared/storage/local-kv.ts", () => ({
  getLocalKvStore: () => Promise.resolve(host.store),
}));

beforeEach(() => {
  host.entries.clear();
  host.failures.get = false;
  host.failures.set = false;
  __resetDailyDollarRegistryStoreForTests();
});

describe("daily dollar registry store", () => {
  it("writes under the per-account key and reads it back", async () => {
    const registry: DailyDollarRegistry = {
      ...emptyRegistry(ACCOUNT),
      lastTick: { atSeconds: 10, result: "ok", error: null },
    };

    await writeDailyDollarRegistry(registry);

    expect([...host.entries.keys()]).toEqual([
      `${DAILY_DOLLAR_REGISTRY_KEY_PREFIX}${ACCOUNT}`,
    ]);
    await expect(readDailyDollarRegistry(ACCOUNT)).resolves.toEqual(registry);
  });

  it("keeps accounts apart", async () => {
    await writeDailyDollarRegistry(emptyRegistry(ACCOUNT));
    await writeDailyDollarRegistry(emptyRegistry("5Bob"));

    expect([...host.entries.keys()]).toEqual([
      `${DAILY_DOLLAR_REGISTRY_KEY_PREFIX}${ACCOUNT}`,
      `${DAILY_DOLLAR_REGISTRY_KEY_PREFIX}5Bob`,
    ]);
  });

  it("sanitizes what it reads back", async () => {
    const stored = applyRegistrationSubmitted(
      emptyRegistry(ACCOUNT),
      [EVENT_A, EVENT_B],
      "worker",
      5,
    );
    const corrupted = JSON.parse(JSON.stringify(stored)) as {
      draws: Record<string, { status: string }>;
    };
    const record = corrupted.draws[EVENT_B];
    if (record == null) throw new Error("fixture lost a record");
    record.status = "NotAStatus";
    host.entries.set(
      `${DAILY_DOLLAR_REGISTRY_KEY_PREFIX}${ACCOUNT}`,
      JSON.stringify(corrupted),
    );

    const parsed = await readDailyDollarRegistry(ACCOUNT);

    expect(Object.keys(parsed.draws)).toEqual([EVENT_A]);
    expect(parsed.version).toBe(DAILY_DOLLAR_REGISTRY_VERSION);
  });

  it("returns an empty registry for a key that holds junk", async () => {
    host.entries.set(`${DAILY_DOLLAR_REGISTRY_KEY_PREFIX}${ACCOUNT}`, '"nope"');

    await expect(readDailyDollarRegistry(ACCOUNT)).resolves.toEqual(
      emptyRegistry(ACCOUNT),
    );
  });

  it("degrades to an empty registry when the host read fails", async () => {
    host.failures.get = true;

    await expect(readDailyDollarRegistry(ACCOUNT)).resolves.toEqual(
      emptyRegistry(ACCOUNT),
    );
  });

  it("swallows a failing host write", async () => {
    host.failures.set = true;

    await expect(
      writeDailyDollarRegistry(emptyRegistry(ACCOUNT)),
    ).resolves.toBeUndefined();
  });

  it("applies concurrent updates one after the other", async () => {
    const [first, second] = await Promise.all([
      updateDailyDollarRegistry(ACCOUNT, (current) =>
        applyRegistrationSubmitted(current, [EVENT_A], "worker", 1),
      ),
      updateDailyDollarRegistry(ACCOUNT, (current) =>
        applyRegistrationSubmitted(current, [EVENT_B], "app", 2),
      ),
    ]);

    expect(Object.keys(first.draws)).toEqual([EVENT_A]);
    expect(Object.keys(second.draws)).toEqual([EVENT_A, EVENT_B]);
    const persisted = await readDailyDollarRegistry(ACCOUNT);
    expect(Object.keys(persisted.draws)).toEqual([EVENT_A, EVENT_B]);
    expect(persisted.draws[EVENT_A]?.registration.source).toBe("worker");
    expect(persisted.draws[EVENT_B]?.registration.source).toBe("app");
  });

  it("does not let one account's updates block another's", async () => {
    const [mine, theirs] = await Promise.all([
      updateDailyDollarRegistry(ACCOUNT, (current) =>
        applyRegistrationSubmitted(current, [EVENT_A], "worker", 1),
      ),
      updateDailyDollarRegistry("5Bob", (current) =>
        applyRegistrationSubmitted(current, [EVENT_B], "worker", 1),
      ),
    ]);

    expect(mine.accountAddress).toBe(ACCOUNT);
    expect(Object.keys(mine.draws)).toEqual([EVENT_A]);
    expect(theirs.accountAddress).toBe("5Bob");
    expect(Object.keys(theirs.draws)).toEqual([EVENT_B]);
  });

  it("keeps the chain usable after an update callback throws", async () => {
    const thrown = await updateDailyDollarRegistry(
      ACCOUNT,
      (): DailyDollarRegistry => {
        throw new Error("reducer blew up");
      },
    );
    expect(thrown).toEqual(emptyRegistry(ACCOUNT));

    const next = await updateDailyDollarRegistry(ACCOUNT, (current) =>
      applyRegistrationSubmitted(current, [EVENT_A], "worker", 3),
    );
    expect(Object.keys(next.draws)).toEqual([EVENT_A]);
  });
});
