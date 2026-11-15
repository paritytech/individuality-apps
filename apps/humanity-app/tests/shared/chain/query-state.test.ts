// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest";

import { blockingError } from "@shared/chain/query-state.ts";

describe("blockingError", () => {
  it("returns the error while the query has no data at all", () => {
    const error = new Error("chain read failed");
    expect(blockingError(error, undefined)).toBe(error);
  });

  it("returns null when there is no error, with or without data", () => {
    expect(blockingError(null, undefined)).toBeNull();
    expect(blockingError(null, null)).toBeNull();
    expect(blockingError(null, { kind: "no-game", gameIndex: 3 })).toBeNull();
  });

  it("suppresses a background error when cached object data is present", () => {
    const error = new Error("refetch failed");
    expect(blockingError(error, { kind: "card", participant: null })).toBeNull();
  });

  it("suppresses a background error when cached null data is present", () => {
    const error = new Error("refetch failed");
    expect(blockingError(error, null)).toBeNull();
  });
});
