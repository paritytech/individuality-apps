// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { beforeEach, describe, expect, it } from "vitest";

import { buildDrawEventId } from "@humanity/shared/airdrops/chain/draw-event-id.ts";
import {
  clearDailyScratch,
  hasScratchedDailyPrize,
  recordDailyScratch,
} from "@features/prize/chain/daily-scratch-log.ts";
import {
  recordPrizeWin,
  totalPrizeWinnings,
} from "@features/prize/chain/prize-winnings.ts";
import type { HostLocalStorage } from "@humanity/shared/chain/host-api.ts";
import {
  getLocalKvStore,
  resetLocalKvStore,
} from "@humanity/shared/storage/local-kv.ts";

const ACCOUNT = "5Alice";
const OTHER_ACCOUNT = "5Bob";
/** Two concurrent draws (draw indices 2 and 3) and the next-draw counter. */
const DRAW_A = buildDrawEventId(2n);
const DRAW_B = buildDrawEventId(3n);
const DRAW_NEXT = buildDrawEventId(4n);
const ONE_DOLLAR = 1_000_000n;

class FakeHostLocalStorage implements HostLocalStorage {
  readonly entries = new Map<string, string>();

  readString(key: string): Promise<string> {
    return Promise.resolve(this.entries.get(key) ?? "");
  }
  writeString(key: string, value: string): Promise<void> {
    this.entries.set(key, value);
    return Promise.resolve();
  }
  readJSON(key: string): Promise<unknown> {
    const raw = this.entries.get(key);
    return Promise.resolve(raw == null ? null : JSON.parse(raw));
  }
  writeJSON(key: string, value: unknown): Promise<void> {
    this.entries.set(key, JSON.stringify(value));
    return Promise.resolve();
  }
  readBytes(): Promise<Uint8Array | undefined> {
    return Promise.resolve(undefined);
  }
  writeBytes(): Promise<void> {
    return Promise.resolve();
  }
  clear(key: string): Promise<void> {
    this.entries.delete(key);
    return Promise.resolve();
  }
}

let host: FakeHostLocalStorage;

describe("daily scratch log", () => {
  beforeEach(async () => {
    resetLocalKvStore();
    host = new FakeHostLocalStorage();
    await getLocalKvStore(host);
  });

  it("an unscratched card reports unscratched", async () => {
    expect(await hasScratchedDailyPrize(ACCOUNT, DRAW_A)).toBe(false);
  });

  it("scratching consumes that event", async () => {
    await recordDailyScratch(ACCOUNT, DRAW_A);

    expect(await hasScratchedDailyPrize(ACCOUNT, DRAW_A)).toBe(true);
  });

  it("the next draw index is a fresh card", async () => {
    await recordDailyScratch(ACCOUNT, DRAW_A);

    expect(await hasScratchedDailyPrize(ACCOUNT, DRAW_B)).toBe(false);
  });

  it("a much later draw index is a fresh card", async () => {
    await recordDailyScratch(ACCOUNT, DRAW_A);

    expect(await hasScratchedDailyPrize(ACCOUNT, DRAW_NEXT)).toBe(false);
  });

  it("is per account", async () => {
    await recordDailyScratch(ACCOUNT, DRAW_A);

    expect(await hasScratchedDailyPrize(OTHER_ACCOUNT, DRAW_A)).toBe(false);
  });

  it("survives a reload", async () => {
    await recordDailyScratch(ACCOUNT, DRAW_A);

    resetLocalKvStore();
    await getLocalKvStore(host);

    expect(await hasScratchedDailyPrize(ACCOUNT, DRAW_A)).toBe(true);
  });

  it("scratching never blocks banking the win for the same event", async () => {
    // The two ledgers are separate precisely so a scratch cannot make the
    // later win record a no-op and drop the prize from the tally.
    await recordDailyScratch(ACCOUNT, DRAW_A);
    await recordPrizeWin({ accountAddress: ACCOUNT, eventId: DRAW_A, amount: ONE_DOLLAR });

    expect(await totalPrizeWinnings(ACCOUNT)).toBe(ONE_DOLLAR);
  });

  it("is idempotent and clearable", async () => {
    await recordDailyScratch(ACCOUNT, DRAW_A);
    await recordDailyScratch(ACCOUNT, DRAW_A);
    expect(await hasScratchedDailyPrize(ACCOUNT, DRAW_A)).toBe(true);

    await clearDailyScratch(ACCOUNT, DRAW_A);
    expect(await hasScratchedDailyPrize(ACCOUNT, DRAW_A)).toBe(false);
  });

  it("refuses a malformed event id or empty account", async () => {
    await recordDailyScratch(ACCOUNT, "not-an-event");
    await recordDailyScratch("", DRAW_A);

    expect(await hasScratchedDailyPrize(ACCOUNT, DRAW_A)).toBe(false);
  });

  it("ignores a persisted value that is not a log object", async () => {
    for (const raw of ["{not json", "null", "42", "[1, 2]", '"text"']) {
      host.entries.set(`humanity:daily-scratch:${ACCOUNT}`, raw);
      expect(await hasScratchedDailyPrize(ACCOUNT, DRAW_A)).toBe(false);
    }
  });
});
