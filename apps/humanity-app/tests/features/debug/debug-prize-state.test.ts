// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest";

import {
  INITIAL_DEBUG_PRIZE_STATE,
  selectDebugPrize,
  settleDebugPrize,
} from "@features/debug/debug-prize-state.ts";

describe("INITIAL_DEBUG_PRIZE_STATE", () => {
  it("has no outcome by default", () => {
    expect(INITIAL_DEBUG_PRIZE_STATE.outcome).toBeNull();
  });

  it("is unrevealed by default", () => {
    expect(INITIAL_DEBUG_PRIZE_STATE.revealed).toBe(false);
  });

  it("starts with $214 in winnings", () => {
    expect(INITIAL_DEBUG_PRIZE_STATE.winningsDollars).toBe(214);
  });

  it("starts with ticket 0", () => {
    expect(INITIAL_DEBUG_PRIZE_STATE.ticket).toBe(0);
  });
});

describe("selectDebugPrize — ticket identity", () => {
  it("increments ticket on each call, including the same outcome", () => {
    const first = selectDebugPrize(INITIAL_DEBUG_PRIZE_STATE, "win");
    expect(first.ticket).toBe(1);

    const second = selectDebugPrize(first, "win");
    expect(second.ticket).toBe(2);
  });

  it("preserves winnings across ticket increments", () => {
    const state = { ...INITIAL_DEBUG_PRIZE_STATE, winningsDollars: 300 };
    const next = selectDebugPrize(state, "win");
    expect(next.winningsDollars).toBe(300);
  });

  it("resets revealed across ticket increments", () => {
    const revealed = { ...INITIAL_DEBUG_PRIZE_STATE, revealed: true, ticket: 5 };
    const next = selectDebugPrize(revealed, "win");
    expect(next.revealed).toBe(false);
  });
});

describe("selectDebugPrize", () => {
  it("sets the given win outcome", () => {
    const next = selectDebugPrize(INITIAL_DEBUG_PRIZE_STATE, "win");
    expect(next.outcome).toBe("win");
  });

  it("sets the given miss outcome", () => {
    const next = selectDebugPrize(INITIAL_DEBUG_PRIZE_STATE, "miss");
    expect(next.outcome).toBe("miss");
  });

  it("resets revealed to false when selecting win", () => {
    const revealed = { ...INITIAL_DEBUG_PRIZE_STATE, revealed: true };
    const next = selectDebugPrize(revealed, "win");
    expect(next.revealed).toBe(false);
  });

  it("resets revealed to false when selecting miss", () => {
    const revealed = { ...INITIAL_DEBUG_PRIZE_STATE, revealed: true };
    const next = selectDebugPrize(revealed, "miss");
    expect(next.revealed).toBe(false);
  });

  it("preserves winnings when selecting win", () => {
    const state = { ...INITIAL_DEBUG_PRIZE_STATE, winningsDollars: 300 };
    const next = selectDebugPrize(state, "win");
    expect(next.winningsDollars).toBe(300);
  });

  it("preserves winnings when selecting miss", () => {
    const state = { ...INITIAL_DEBUG_PRIZE_STATE, winningsDollars: 300 };
    const next = selectDebugPrize(state, "miss");
    expect(next.winningsDollars).toBe(300);
  });
});

describe("settleDebugPrize — win", () => {
  it("marks the state as revealed on first win settlement", () => {
    const selected = selectDebugPrize(INITIAL_DEBUG_PRIZE_STATE, "win");
    const settled = settleDebugPrize(selected);
    expect(settled.revealed).toBe(true);
  });

  it("increments winnings by $1 on first win settlement", () => {
    const selected = selectDebugPrize(INITIAL_DEBUG_PRIZE_STATE, "win");
    const settled = settleDebugPrize(selected);
    expect(settled.winningsDollars).toBe(215);
  });

  it("does not increment a second time when settle is called twice", () => {
    const selected = selectDebugPrize(INITIAL_DEBUG_PRIZE_STATE, "win");
    const first = settleDebugPrize(selected);
    const second = settleDebugPrize(first);
    expect(second.winningsDollars).toBe(215);
  });

  it("does not re-mark revealed as true when settle is called twice", () => {
    const selected = selectDebugPrize(INITIAL_DEBUG_PRIZE_STATE, "win");
    const first = settleDebugPrize(selected);
    const second = settleDebugPrize(first);
    expect(second.revealed).toBe(true);
  });
});

describe("settleDebugPrize — miss", () => {
  it("marks the state as revealed on first miss settlement", () => {
    const selected = selectDebugPrize(INITIAL_DEBUG_PRIZE_STATE, "miss");
    const settled = settleDebugPrize(selected);
    expect(settled.revealed).toBe(true);
  });

  it("does not increment winnings on miss settlement", () => {
    const selected = selectDebugPrize(INITIAL_DEBUG_PRIZE_STATE, "miss");
    const settled = settleDebugPrize(selected);
    expect(settled.winningsDollars).toBe(214);
  });

  it("is idempotent when settle is called twice", () => {
    const selected = selectDebugPrize(INITIAL_DEBUG_PRIZE_STATE, "miss");
    const first = settleDebugPrize(selected);
    const second = settleDebugPrize(first);
    expect(second.winningsDollars).toBe(214);
    expect(second.revealed).toBe(true);
  });
});
