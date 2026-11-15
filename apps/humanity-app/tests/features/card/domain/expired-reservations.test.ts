// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/** Humanity only removes reservations the runtime itself would let anyone
 *  remove (`now > joined_at + duration`) that have also stood 30 days, only
 *  ahead of the person's own entry, and never that entry or anything behind
 *  it. */
import { describe, expect, it } from "vitest";

import { expiredEntriesAhead, RESERVATION_FLOOR_SECS } from "@features/card/domain/expired-reservations.ts";

const DAY = 86_400n;
const entry = (account: string, joined_at: bigint) => ({ account, joined_at });

describe("expiredEntriesAhead", () => {
  // A synthetic queue: six lite identities queued for `carol`, carol.06
  // last, the reservation duration unset (0).
  const now = 1_800_000_000n;
  const carol = [
    entry("carol.01", now - 70n * DAY),
    entry("carol.02", now - 62n * DAY),
    entry("carol.03", now - 55n * DAY),
    entry("carol.04", now - 50n * DAY),
    entry("carol.05", now - 35n * DAY),
    entry("carol.06", now - 10n * DAY),
  ];

  it("picks every entry ahead of carol.06, in queue order, and not carol.06", () => {
    expect(expiredEntriesAhead(carol, "carol.06", now, 0n)).toEqual([
      "carol.01",
      "carol.02",
      "carol.03",
      "carol.04",
      "carol.05",
    ]);
  });

  it("keeps entries still inside the duration", () => {
    // 30 days: .01–.04 lapsed weeks ago, .05 (35 days in) five days ago.
    expect(expiredEntriesAhead(carol, "carol.06", now, 30n * DAY)).toEqual([
      "carol.01",
      "carol.02",
      "carol.03",
      "carol.04",
      "carol.05",
    ]);
    // 40 days: .05 still holds its place.
    expect(expiredEntriesAhead(carol, "carol.06", now, 40n * DAY)).toEqual([
      "carol.01",
      "carol.02",
      "carol.03",
      "carol.04",
    ]);
  });

  it("treats the exact expiry second as not yet expired, as the runtime does", () => {
    const queue = [entry("a", 100n), entry("me", 200n)];
    const duration = 40n * DAY;
    expect(expiredEntriesAhead(queue, "me", 100n + duration, duration)).toEqual([]);
    expect(expiredEntriesAhead(queue, "me", 101n + duration, duration)).toEqual(["a"]);
  });

  it("never removes a reservation younger than 30 days, even when People sets no duration", () => {
    const anHourAgo = now - 3_600n;
    const queue = [entry("first", anHourAgo), entry("me", now)];
    expect(expiredEntriesAhead(queue, "me", now, 0n)).toEqual([]);
    expect(expiredEntriesAhead(queue, "me", anHourAgo + RESERVATION_FLOOR_SECS, 0n)).toEqual([]);
    expect(expiredEntriesAhead(queue, "me", anHourAgo + RESERVATION_FLOOR_SECS + 1n, 0n)).toEqual(["first"]);
  });

  it("picks nothing for the front of the queue or someone not in it", () => {
    expect(expiredEntriesAhead(carol, "carol.01", now, 0n)).toEqual([]);
    expect(expiredEntriesAhead(carol, "stranger", now, 0n)).toEqual([]);
    expect(expiredEntriesAhead([], "carol.06", now, 0n)).toEqual([]);
  });

  it("never picks entries behind the person", () => {
    expect(expiredEntriesAhead(carol, "carol.03", now, 0n)).toEqual(["carol.01", "carol.02"]);
  });
});
