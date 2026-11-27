// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { expect, it } from "vitest";
import fc from "fast-check";
import recorded from "./fixtures/schedule-invalid-game-setup.json";
import { assertSudoReceipt, openingGamePhases, openingGameSchedule } from "../../lab/opening/fixture.ts";

// Independent scheduling precondition from the pallet, not from our planner:
// https://github.com/paritytech/individuality-community/blob/9c6f1faa4b3f3a14ee092793b7d19b66ceb2f898/pallets/game/src/types.rs#L532
// https://github.com/paritytech/individuality-community/blob/9c6f1faa4b3f3a14ee092793b7d19b66ceb2f898/pallets/game/src/lib.rs#L1564
function runtimeSchedulingError(play: number, now: number) {
  const registrationStart = Math.max(0, play - 90 - 0 - 3600);
  return now > registrationStart ? "Game.InvalidGameSetup" : null;
}
it("reproduces the observed Game.InvalidGameSetup receipt with the old 30-minute schedule", () => {
  expect(recorded.receipt.label).toBe("Game.schedule_games");
  expect(recorded.receipt.ok).toBe(true);
  expect(recorded.receipt.sudoEvents[0]?.sudoResult).toEqual({ success: false, value: { type: "Module", value: { type: "Game", value: { type: "InvalidGameSetup" } } } });
  // Recreate a native PAPI receipt from the retained public receipt summary.
  const receipt = { ...recorded.receipt, events: recorded.receipt.sudoEvents.map((event) => ({ type: "Sudo", value: { type: event.type, value: { sudo_result: event.sudoResult } } })) };
  expect(() => assertSudoReceipt(receipt, recorded.receipt.label)).toThrow(/Game.schedule_games:.*InvalidGameSetup/);
  const now = 1_793_750_000;
  const oldPlay = now + 1800;
  expect(oldPlay - 90 - 3600 - now).toBe(-1890);
  expect(runtimeSchedulingError(oldPlay, now)).toBe("Game.InvalidGameSetup");
  expect(runtimeSchedulingError(openingGameSchedule(now, now).game_play_time, now)).toBeNull();
});
it("reserves the full phase window plus inclusion slack after the later clock", () => {
  fc.assert(fc.property(fc.integer({ min: 1_700_000_000, max: 2_000_000_000 }), fc.integer({ min: -600, max: 600 }), (chainNow, offset) => {
    const wallNow = chainNow + offset + 0.5;
    const plan = openingGameSchedule(chainNow, wallNow);
    const latest = Math.max(chainNow, wallNow);
    expect(runtimeSchedulingError(plan.game_play_time, latest)).toBeNull();
    expect(plan.game_play_time - openingGamePhases.registration - openingGamePhases.shuffle - openingGamePhases.post_shuffle_margin).toBeGreaterThanOrEqual(latest + 120);
    expect(plan.rounds).toBe(1); expect(plan.max_group_size).toBe(4); expect(plan.airdrops).toEqual([]);
  }));
});
it("rejects invalid or overflowing times before a transaction is built", () => {
  for (const now of [NaN, Infinity, -1, 0xffff_ffff]) expect(() => openingGameSchedule(now, now)).toThrow();
});
