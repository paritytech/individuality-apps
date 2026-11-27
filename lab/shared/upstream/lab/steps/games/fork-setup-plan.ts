// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
// Pure setup plan. Root owns the batch; signed mint calls forward errors to batch_all.
import type { GamesPeopleApi } from "./chain.ts";
export const localPhases = { registration: 180, shuffle: 90, post_shuffle_margin: 0, reporting: 300, player_process: 90 };
export const visiblePhases = { ...localPhases, registration: 360 };
export const demoPrizeAsset: Parameters<GamesPeopleApi["query"]["Assets"]["Asset"]["getValue"]>[0] = { parents: 1, interior: { type: "X3", value: [
  { type: "Parachain", value: 1000 }, { type: "PalletInstance", value: 50 }, { type: "GeneralIndex", value: 50_000_413n },
] } };
export const demoPrize = { draw_offset: 30, claim_window: 3600,
  prize: { asset_id: demoPrizeAsset, asset_amount: 1n, max_winners: 3, winner_cap: 1_000_000 } };
export type Call = { type: string; value: { type: string; value: any } };
const call = (pallet: string, name: string, args: unknown = undefined): Call => ({ type: pallet, value: { type: name, value: args } });
export interface SetupState {
  game?: { index: number; state: { type: string; value?: { next_player_index?: number } }; pending_attendance: number };
  schedules: { game_play_time: number }[];
  phases?: typeof visiblePhases;
  asset?: { owner: string; min_balance: bigint };
  enabled: boolean;
  ownerBalance: bigint;
  sourceBalance: bigint;
}
function requireEmptyImportedGame(state: SetupState) {
  if (state.game && (state.game.state.type !== "Registration" || state.game.state.value?.next_player_index !== 0 || state.game.pending_attendance !== 0))
    throw Error("Atomic setup requires an empty imported Registration game; populated or transitional games need separate cleanup");
  if (state.asset && state.game) throw Error("Existing prize asset with an imported game needs separate cleanup before batching");
}
/** Cancellation always enters Cancelling, even with no players. Drain it between batches. */
export function planForkCleanup(state: SetupState) {
  requireEmptyImportedGame(state);
  if (!state.game) throw Error("Imported game cleanup requires a game");
  const calls = state.schedules.map(s => call("Game", "remove_scheduled_game", { game_play_time: s.game_play_time }));
  calls.push(call("Game", "cancel_game"));
  return { calls, call: call("Sudo", "sudo", { call: call("Utility", "batch_all", { calls }) }) };
}
export function planForkSetup(state: SetupState, authority: string, source: string, now: number, startsInSeconds = 900) {
  if (!Number.isSafeInteger(now) || !Number.isSafeInteger(startsInSeconds) || startsInSeconds < 0) throw Error("Invalid schedule time");
  requireEmptyImportedGame(state);
  if (state.game) throw Error("Atomic setup requires finalized imported-game cancellation to finish before provisioning");
  const calls = state.schedules.map(s => call("Game", "remove_scheduled_game", { game_play_time: s.game_play_time }));
  if (Object.entries(visiblePhases).some(([key, value]) => state.phases?.[key as keyof typeof visiblePhases] !== value)) calls.push(call("Game", "set_game_phases", { phases: visiblePhases }));
  const minimum = state.asset?.min_balance ?? 1n;
  if (minimum < 1n || (!state.asset && (state.enabled || state.ownerBalance || state.sourceBalance))) throw Error("Inconsistent prize state");
  if (!state.asset) calls.push(call("Assets", "force_create", { id: demoPrizeAsset, owner: { type: "Id", value: authority }, is_sufficient: true, min_balance: 1n }));
  const mint = (beneficiary: string, amount: bigint) => call("Utility", "dispatch_as_fallible", {
    as_origin: { type: "system", value: { type: "Signed", value: authority } },
    call: call("Assets", "mint", { id: demoPrizeAsset, beneficiary: { type: "Id", value: beneficiary }, amount }),
  });
  if (!state.enabled) {
    if (state.ownerBalance < minimum) calls.push(mint(authority, minimum - state.ownerBalance));
    calls.push(call("Airdrop", "enable_asset", { asset_id: demoPrizeAsset, source: authority }));
  }
  const needed = minimum > 3n ? minimum : 3n;
  if (state.sourceBalance < needed) calls.push(mint(source, needed - state.sourceBalance));
  const schedule = { game_play_time: now + Math.max(visiblePhases.registration + visiblePhases.shuffle + 120, startsInSeconds), rounds: 1, max_group_size: 4, airdrops: [demoPrize] };
  calls.push(call("Game", "schedule_games", { games_schedules: [schedule] }));
  return { calls, schedule, call: call("Sudo", "sudo", { call: call("Utility", "batch_all", { calls }) }) };
}

/** Reject swallowed failures and missing batch evidence even when the outer extrinsic succeeded. */
export function assertSetupReceipt(receipt: { ok: boolean; events: readonly any[] }, count: number) {
  const events = receipt.events.map(e => e.event ?? e);
  const sudo = events.filter(e => e.type === "Sudo" && e.value.type === "Sudid");
  if (!receipt.ok || sudo.length !== 1 || sudo[0].value.value.sudo_result.success !== true ||
      events.some(e => e.type === "Utility" && ["BatchInterrupted", "ItemFailed"].includes(e.value.type)) ||
      events.filter(e => e.type === "Utility" && e.value.type === "BatchCompleted").length !== 1 ||
      events.filter(e => e.type === "Utility" && e.value.type === "ItemCompleted").length !== count)
    throw Error("Atomic fork setup failed or lacks complete inner dispatch evidence");
}
