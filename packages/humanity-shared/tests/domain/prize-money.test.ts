// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest";

import {
  AIRDROP_ASSET_DECIMALS,
  formatPrizeDollars,
} from "@humanity/shared/domain/prize-money.ts";

describe("formatPrizeDollars", () => {
  it("renders whole dollars without a fraction", () => {
    expect(formatPrizeDollars(214_000_000n)).toBe("$214");
    expect(formatPrizeDollars(1_000_000n)).toBe("$1");
  });

  it("keeps up to two fraction digits and trims trailing zeros", () => {
    expect(formatPrizeDollars(23_420_000n)).toBe("$23.42");
    expect(formatPrizeDollars(23_400_000n)).toBe("$23.4");
    expect(formatPrizeDollars(1_500_000n)).toBe("$1.5");
  });

  it("handles totals below one dollar", () => {
    expect(formatPrizeDollars(420_000n)).toBe("$0.42");
    expect(formatPrizeDollars(500_000n)).toBe("$0.5");
  });

  it("truncates, never rounds, sub-cent base units", () => {
    expect(formatPrizeDollars(23_429_999n)).toBe("$23.42");
  });

  it("groups thousands with commas, en-US style", () => {
    expect(formatPrizeDollars(2_150_000_000n)).toBe("$2,150");
  });

  it("renders an empty ledger as zero dollars", () => {
    expect(formatPrizeDollars(0n)).toBe("$0");
  });

  it("rejects a negative total as a programming error", () => {
    expect(() => formatPrizeDollars(-1n)).toThrow(RangeError);
  });
});

describe("AIRDROP_ASSET_DECIMALS", () => {
  it("is the USD-stablecoin 6-decimal prize asset", () => {
    expect(AIRDROP_ASSET_DECIMALS).toBe(6);
  });
});
