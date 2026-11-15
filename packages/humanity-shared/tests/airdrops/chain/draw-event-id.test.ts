// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest";
import {
  GAME_AIRDROP_EVENT_ID_BASE,
  gameAirdropEventId,
  parsePeopleAirdropsEventId,
  ProductIndividualityError,
} from "@parity/product-sdk/individuality";

import { buildDrawEventId } from "@humanity/shared/airdrops/chain/draw-event-id.ts";

describe("buildDrawEventId", () => {
  it.each([
    [0n, "0x706f703a70656f706c652d61697264726f70733a202020200000000000000000"],
    [1n, "0x706f703a70656f706c652d61697264726f70733a202020200000000000000001"],
    [7n, "0x706f703a70656f706c652d61697264726f70733a202020200000000000000007"],
    [18446744073709551615n, "0x706f703a70656f706c652d61697264726f70733a20202020ffffffffffffffff"],
  ])("matches the runtime's u64 derivation at drawIndex=%s", (drawIndex, expected) => {
    expect(buildDrawEventId(drawIndex)).toBe(expected);
  });

  it("rejects a draw index outside u64", () => {
    expect(() => buildDrawEventId(-1n)).toThrow(ProductIndividualityError);
    expect(() => buildDrawEventId(1n << 64n)).toThrow(ProductIndividualityError);
  });
});

describe("draw ids decode back through the SDK", () => {
  it.each([0n, 1n, 7n, 2n ** 63n, (1n << 64n) - 1n])(
    "round-trips drawIndex=%s",
    (drawIndex) => {
      expect(parsePeopleAirdropsEventId(buildDrawEventId(drawIndex))).toBe(drawIndex);
    },
  );

  it("rejects a game airdrop id on its prefix, not its length", () => {
    const gameId = gameAirdropEventId({
      base: GAME_AIRDROP_EVENT_ID_BASE,
      gameIndex: 3,
      airdropIndex: 1,
    });
    expect(gameId).toHaveLength(buildDrawEventId(0n).length);
    expect(parsePeopleAirdropsEventId(gameId)).toBeNull();
  });
});
