// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { beforeEach, describe, expect, it } from "vitest";

import {
  clearPrizeWin,
  hasSettledDailyPrize,
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
const EVENT_A = `0x${"aa".repeat(32)}`;
const EVENT_B = `0x${"bb".repeat(32)}`;
const ONE_DOLLAR = 1_000_000n;
const TWO_DOLLARS = 2_000_000n;

/** Stand-in for the container's storage; keys are the host's, prefix included. */
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
    // Mirrors a host that hands back whatever was stored: malformed content
    // throws here and the SDK backend is the one that has to absorb it.
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

describe("prize-winnings ledger", () => {
  beforeEach(async () => {
    resetLocalKvStore();
    host = new FakeHostLocalStorage();
    // Prime the shared store, so the ledger's own no-arg calls reuse it.
    await getLocalKvStore(host);
  });

  it("records a win and sums it into the account total", async () => {
    await recordPrizeWin({ accountAddress: ACCOUNT, eventId: EVENT_A, amount: ONE_DOLLAR });
    await recordPrizeWin({ accountAddress: ACCOUNT, eventId: EVENT_B, amount: TWO_DOLLARS });

    expect(await totalPrizeWinnings(ACCOUNT)).toBe(3_000_000n);
  });

  it("persists the tally through host storage, under the product prefix", async () => {
    await recordPrizeWin({ accountAddress: ACCOUNT, eventId: EVENT_A, amount: ONE_DOLLAR });

    expect([...host.entries.keys()]).toEqual([
      `humanity:prize-winnings:${ACCOUNT}`,
    ]);
  });

  it("survives a reload: a fresh store reads the host's persisted tally", async () => {
    await recordPrizeWin({ accountAddress: ACCOUNT, eventId: EVENT_A, amount: ONE_DOLLAR });

    // Same host handle, brand new store — the value came back from storage,
    // not from a module-memory cache.
    resetLocalKvStore();
    await getLocalKvStore(host);

    expect(await totalPrizeWinnings(ACCOUNT)).toBe(ONE_DOLLAR);
  });

  it("is idempotent per (account, event): re-recording never double-counts", async () => {
    await recordPrizeWin({ accountAddress: ACCOUNT, eventId: EVENT_A, amount: ONE_DOLLAR });
    await recordPrizeWin({ accountAddress: ACCOUNT, eventId: EVENT_A, amount: ONE_DOLLAR });

    expect(await totalPrizeWinnings(ACCOUNT)).toBe(ONE_DOLLAR);
  });

  it("keeps the first amount when an event is re-recorded for more", async () => {
    await recordPrizeWin({ accountAddress: ACCOUNT, eventId: EVENT_A, amount: ONE_DOLLAR });
    await recordPrizeWin({ accountAddress: ACCOUNT, eventId: EVENT_A, amount: TWO_DOLLARS });

    expect(await totalPrizeWinnings(ACCOUNT)).toBe(ONE_DOLLAR);
  });

  it("keeps per-account totals independent", async () => {
    await recordPrizeWin({ accountAddress: ACCOUNT, eventId: EVENT_A, amount: ONE_DOLLAR });
    await recordPrizeWin({ accountAddress: OTHER_ACCOUNT, eventId: EVENT_A, amount: TWO_DOLLARS });

    expect(await totalPrizeWinnings(ACCOUNT)).toBe(ONE_DOLLAR);
    expect(await totalPrizeWinnings(OTHER_ACCOUNT)).toBe(TWO_DOLLARS);
  });

  it("clearing a recorded win removes it from the total", async () => {
    await recordPrizeWin({ accountAddress: ACCOUNT, eventId: EVENT_A, amount: ONE_DOLLAR });
    await recordPrizeWin({ accountAddress: ACCOUNT, eventId: EVENT_B, amount: TWO_DOLLARS });

    await clearPrizeWin(ACCOUNT, EVENT_A);

    expect(await totalPrizeWinnings(ACCOUNT)).toBe(TWO_DOLLARS);
  });

  it("reports zero for an account with nothing recorded", async () => {
    expect(await totalPrizeWinnings(ACCOUNT)).toBe(0n);
  });

  it("ignores a persisted value that is not a ledger object", async () => {
    const key = `humanity:prize-winnings:${ACCOUNT}`;
    for (const raw of ["{not json", "null", "42", "[1, 2]", '"text"']) {
      host.entries.set(key, raw);
      expect(await totalPrizeWinnings(ACCOUNT)).toBe(0n);
    }
  });

  it("drops malformed entries but still counts the well-formed ones", async () => {
    const key = `humanity:prize-winnings:${ACCOUNT}`;
    host.entries.set(
      key,
      JSON.stringify({
        [EVENT_A]: "1000000",
        // Non-hex event id, and amounts that are not plain digit strings.
        "event-b": "2000000",
        [EVENT_B]: "1e6",
        "0xcc": "-1",
        "0xdd": 1_000_000,
      }),
    );

    expect(await totalPrizeWinnings(ACCOUNT)).toBe(ONE_DOLLAR);
  });

  it("refuses to record a malformed event id or a negative amount", async () => {
    await recordPrizeWin({ accountAddress: ACCOUNT, eventId: "event-a", amount: ONE_DOLLAR });
    await recordPrizeWin({ accountAddress: ACCOUNT, eventId: EVENT_A, amount: -1n });
    await recordPrizeWin({ accountAddress: "", eventId: EVENT_A, amount: ONE_DOLLAR });

    expect(await totalPrizeWinnings(ACCOUNT)).toBe(0n);
  });

  it("a claimed win is banked and marked settled", async () => {
    await recordPrizeWin({ accountAddress: ACCOUNT, eventId: EVENT_A, amount: ONE_DOLLAR });

    expect(await hasSettledDailyPrize(ACCOUNT, EVENT_A)).toBe(true);
    expect(await totalPrizeWinnings(ACCOUNT)).toBe(ONE_DOLLAR);
  });

  it("settling one airdrop leaves the next day's event unsettled", async () => {
    // The whole point of keying by event id: tomorrow's card must still show.
    await recordPrizeWin({ accountAddress: ACCOUNT, eventId: EVENT_A, amount: ONE_DOLLAR });

    expect(await hasSettledDailyPrize(ACCOUNT, EVENT_B)).toBe(false);
  });

  it("settlement is per account", async () => {
    await recordPrizeWin({ accountAddress: ACCOUNT, eventId: EVENT_A, amount: ONE_DOLLAR });

    expect(await hasSettledDailyPrize(OTHER_ACCOUNT, EVENT_A)).toBe(false);
  });
});
