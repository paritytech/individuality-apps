// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest";

import { dailyPrizeEntryAvailable } from "@features/prize/domain/daily-prize-entry.ts";

describe("dailyPrizeEntryAvailable", () => {
  it("offers an unscratched ticket, win or miss", () => {
    expect(dailyPrizeEntryAvailable({ scratched: false, outcome: "win" })).toBe(true);
    expect(dailyPrizeEntryAvailable({ scratched: false, outcome: "miss" })).toBe(true);
  });

  it("hides a scratched ticket regardless of outcome — the claim runs on its own", () => {
    expect(dailyPrizeEntryAvailable({ scratched: true, outcome: "win" })).toBe(false);
    expect(dailyPrizeEntryAvailable({ scratched: true, outcome: "miss" })).toBe(false);
  });

  it("hides when no ticket exists", () => {
    expect(dailyPrizeEntryAvailable({ scratched: false, outcome: null })).toBe(false);
  });
});
