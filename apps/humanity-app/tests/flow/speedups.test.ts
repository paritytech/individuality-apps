// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import { test } from "vitest";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { unifyMetadata, decAnyMetadata } from "@polkadot-api/substrate-bindings";
import { getLookupFn, getDynamicBuilder } from "@polkadot-api/metadata-builders";
import { planForkCleanup, planForkSetup, assertSetupReceipt, visiblePhases, type SetupState } from "../../../../lab/shared/upstream/lab/steps/games/fork-setup-plan.ts";
import { earliestPlay, retimedGame, shiftedDraw } from "../../../../lab/shared/upstream/lab/steps/games/game-retime.ts";
import { requireOwnedGameFork } from "../../../../lab/shared/upstream/lab/steps/humanity/bootstrap/imported-games.ts";
const alice = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
const source = "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty";
const imported: SetupState = { game: { index: 290, state: { type: "Registration", value: { next_player_index: 0 } }, pending_attendance: 0 },
  schedules: [1793444400,1793455200,1793466000,1793530800,1793541600,1793552400,1793613600].map(game_play_time => ({ game_play_time })),
  enabled: false, ownerBalance: 0n, sourceBalance: 0n };
const m = unifyMetadata(decAnyMetadata(gunzipSync(readFileSync(new URL("./fixtures/people-3004000.metadata16.scale.gz", import.meta.url)))));
const sudo: any = m.lookup.find(t => t.id === m.pallets.find(p => p.name === "Sudo")!.calls!.type);
const codec = getDynamicBuilder(getLookupFn(m)).buildDefinition(sudo.def.value.find((v: any) => v.name === "sudo").fields[0].type);
const clean = (v: unknown) => JSON.parse(JSON.stringify(v, (_, x) => typeof x === "bigint" ? x.toString() : x));

test("same 14 ordered People calls encode in cleanup and provisioning batches, with fallible signed mints", () => {
  const cleanup = planForkCleanup(imported);
  const setup = planForkSetup({ ...imported, game: undefined, schedules: [] }, alice, source, 1793370269);
  for (const part of [cleanup, setup]) assert.deepEqual(clean(codec.dec(codec.enc(part.call))), clean(part.call));
  // Flatten only to compare call ordering; runtime processing is required between the two batches.
  const plan = { ...setup, calls: [...cleanup.calls, ...setup.calls], call: { ...setup.call, value: { ...setup.call.value, value: { call: { type: "Utility", value: { type: "batch_all", value: { calls: [...cleanup.calls, ...setup.calls] } } } } } } };
  const decoded: any = codec.dec(codec.enc(plan.call));
  assert.equal(decoded.type, "Sudo"); assert.equal(decoded.value.type, "sudo");
  const batch = decoded.value.value.call;
  assert.equal(batch.type, "Utility"); assert.equal(batch.value.type, "batch_all");
  assert.equal(batch.value.value.calls.length, 14);
  assert.deepEqual(clean(decoded), clean(plan.call));
  const inner = batch.value.value.calls.map((c: any) => c.type === "Utility" ? c.value.value.call : c);
  assert.deepEqual(inner.map((c: any) => c.type + "." + c.value.type), [
    ...Array(7).fill("Game.remove_scheduled_game"), "Game.cancel_game", "Game.set_game_phases", "Assets.force_create", "Assets.mint", "Airdrop.enable_asset", "Assets.mint", "Game.schedule_games",
  ]);
  assert.deepEqual(inner.slice(0, 7).map((c: any) => c.value.value.game_play_time), imported.schedules.map(s => s.game_play_time));
  assert.deepEqual(inner[8].value.value.phases, visiblePhases);
  assert.equal(inner[10].value.value.amount, 1n); assert.equal(inner[12].value.value.amount, 3n);
  for (const i of [10, 12]) {
    assert.equal(batch.value.value.calls[i].value.type, "dispatch_as_fallible");
    assert.deepEqual(batch.value.value.calls[i].value.value.as_origin, { type: "system", value: { type: "Signed", value: alice } });
  }
  assert.equal(inner[13].value.value.games_schedules[0].game_play_time, 1793371169);
  // Call bytes stay unchanged; cleanup and provisioning require separate finalized waits.
  const before = inner.map((c: any, i: number) => [10, 12].includes(i) ? c : { type: "Sudo", value: { type: "sudo", value: { call: c } } });
  for (const c of before) assert.deepEqual(clean(codec.dec(codec.enc(c))), clean(c));
  assert.equal(before.length, 14);
});
test("prepared fixture skips provisioning calls and keeps the initial 15 minute lead", () => {
  const plan = planForkSetup({ schedules: [], phases: visiblePhases, asset: { owner: alice, min_balance: 1n }, enabled: true, ownerBalance: 0n, sourceBalance: 3n }, alice, source, 1000);
  assert.equal(plan.calls.length, 1); assert.equal(plan.schedule.game_play_time, 1900);
});
test("@negative-control: populated or asynchronous cancellation is refused before submission", () => {
  for (const state of ["Shuffle", "Cancelling", "Reporting"]) assert.throws(() => planForkSetup({ ...imported, game: { ...imported.game!, state: { type: state } } }, alice, source, 1000), /empty imported/);
  assert.throws(() => planForkSetup({ ...imported, game: { ...imported.game!, state: { type: "Registration", value: { next_player_index: 1 } } } }, alice, source, 1000), /empty imported/);
  assert.throws(() => planForkSetup(imported, alice, source, NaN), /Invalid schedule/);
});
test("receipt requires inner success and exactly all batch item completions", () => {
  const event = (type: string, name: string, value?: unknown) => ({ type, value: { type: name, value } });
  const good = { ok: true, events: [...Array.from({ length: 14 }, () => event("Utility", "ItemCompleted")), event("Utility", "BatchCompleted"), event("Sudo", "Sudid", { sudo_result: { success: true } })] };
  assert.doesNotThrow(() => assertSetupReceipt(good, 14));
  assert.throws(() => assertSetupReceipt({ ...good, ok: false }, 14), /failed/);
  assert.throws(() => assertSetupReceipt({ ...good, events: good.events.slice(1) }, 14), /evidence/);
  assert.throws(() => assertSetupReceipt({ ok: true, events: [...good.events.slice(0, -1), event("Sudo", "Sudid", { sudo_result: { success: false } })] }, 14), /failed/);
  assert.throws(() => assertSetupReceipt({ ...good, events: [...good.events, event("Utility", "BatchInterrupted")] }, 14), /failed/);
});
test("registration closes at now+60; shuffle/report and both prize time units retain their intervals", () => {
  const now = 1793370539;
  const game = { index: 291, state: { type: "Registration" }, registration_ends: 1793371080, shuffle_deadline: 1793371170, game_date: 1793371170, report_ends: 1793371470 };
  const old = retimedGame(game, 291, now, 180, visiblePhases);
  const next = retimedGame(game, 291, now, earliestPlay(visiblePhases), visiblePhases);
  assert.equal(old.game.registration_ends - now, 90);
  assert.equal(next.game.registration_ends - now, 60);
  assert.equal(next.game.game_date - now, 150);
  assert.equal(next.game.report_ends - next.game.game_date, 300);
  for (const unit of [1n, 1000n] as const) {
    const draw = { registration_starts: BigInt(game.registration_ends - 360) * unit, draw_time: BigInt(game.game_date + 30) * unit, end_time: BigInt(game.game_date + 3630) * unit };
    const moved = shiftedDraw(draw, next.shiftSeconds, unit);
    assert.equal(moved.draw_time, BigInt(next.game.game_date + 30) * unit);
    assert.equal(moved.end_time - moved.draw_time, 3600n * unit);
  }
  assert.throws(() => retimedGame(game, 291, now, 149, visiblePhases), /earliest/);
  assert.throws(() => retimedGame({ ...game, state: { type: "Shuffle" } }, 291, now, 150, visiblePhases), /only a game still registering/);
});
test("@negative-control: attached, missing and public targets cannot authorize setup or retiming", () => {
  for (const target of [{}, { offer: { local: true } }, { endpoints: { people: "wss://public.invalid" } }]) assert.throws(() => requireOwnedGameFork(target as never), /own local fork/);
});

test("idle atomic executor submits once and checks finalized state; corrupt end states fail", async () => {
  const { prepareOwnedGameBatch } = await import("../../../../lab/shared/upstream/lab/steps/games/fork-setup.ts");
  const endpoint = "ws://127.0.0.1:48010";
  const target = { offer: { local: true }, endpoints: { people: endpoint }, humanity: { network: { kind: "owned", session: { schemaVersion: 1, mode: "fork", ownership: "owned", chains: { people: { ws: endpoint } } } } } };
  async function run(corrupt?: string) {
    let submissions = 0, after = false, chosen: any;
    const event = (type: string, name: string, value?: unknown) => ({ type, value: { type: name, value } });
    const storage = async (pallet: string, item: string) => {
      if (pallet === "Sudo") return corrupt === "authority" ? source : alice;
      if (item === "Now") return BigInt(Date.now());
      if (item === "StoredPhaseDurations") return after ? { ...visiblePhases, shuffle: corrupt === "phases" ? 91 : 90 } : undefined;
      if (item === "Game") return undefined;
      if (item === "GameSchedules") return after ? corrupt === "schedule" ? imported.schedules : [chosen] : imported.schedules;
      if (item === "Asset") return after ? { owner: alice, min_balance: 1n, supply: corrupt === "funding" ? 3n : 4n } : undefined;
      if (item === "SupportedAssets") return after && corrupt !== "enable" ? { enabled: true } : undefined;
      if (item === "Account") return undefined;
      assert.fail(pallet + "." + item);
    };
    const chain = { signal: new AbortController().signal, api: { constants: { Game: { AirdropSource: async () => source } } }, access: { url: endpoint,
      historicalStorage: storage, finalizedHead: async () => ({ hash: after ? "after" : "before", number: after ? 2 : 1 }),
      client: { getUnsafeApi: () => ({ tx: { Sudo: { sudo: (value: any) => ({ decodedCall: value }) } } }) },
    } };
    const transactions = { mode: "finalized", submit: async (_label: string, transaction: any) => {
      submissions++;
      const calls = transaction.decodedCall.call.value.value.calls;
      assert.equal(calls.length, 13);
      chosen = calls.at(-1).value.value.games_schedules[0]; after = true;
      return { ok: true, events: [...calls.map(() => event("Utility", "ItemCompleted")), event("Utility", "BatchCompleted"), event("Sudo", "Sudid", { sudo_result: { success: true } })] };
    } };
    const invoke = () => prepareOwnedGameBatch(chain as never, transactions as never, { address: alice, signer: {} } as never, target as never);
    if (corrupt) await assert.rejects(invoke, /authority mismatch|state does not match|supply does not match/);
    else { const proof = await invoke(); assert.equal(proof.calls.length, 13); assert.equal(proof.after.hash, "after"); }
    assert.equal(submissions, corrupt === "authority" ? 0 : 1);
  }
  await run();
  for (const broken of ["authority", "phases", "schedule", "funding", "enable"]) await run(broken);
});
