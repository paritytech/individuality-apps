// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// One empty registration game on the owned fork, or on the owned network started from genesis; no player is funded or
// registered.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { SessionContext } from "@parity/product-lab";
import { getTxCreator } from "polkadot-api/tx-creator";
import { publicKeyHex } from "../../../../lab/shared/upstream/lab/chain/sudo.ts";

/** The owned networks the opening may change: the local Paseo fork and Previewnet from genesis (product-lab 0.3.0). */
export const OPENING_ENVIRONMENTS = ["paseo-copy", "previewnet-genesis"] as const;
export type OpeningEnvironment = typeof OPENING_ENVIRONMENTS[number];
/**
 * The wrapper's `--environment <id>`: the Paseo copy unless named, accepted only for prepare and run. Returns the
 * environment and the other arguments, without the flag and its value, for the wrapper's own argument checks.
 */
export function openingEnvironment(mode: string | undefined, argv: readonly string[]): { environment: OpeningEnvironment; args: string[] } {
  const args = [...argv];
  const at = args.indexOf("--environment");
  if (at < 0) return { environment: "paseo-copy", args };
  if (mode !== "prepare" && mode !== "run") throw new Error("--environment applies to prepare and run only");
  const [, value] = args.splice(at, 2);
  if (!(OPENING_ENVIRONMENTS as readonly (string | undefined)[]).includes(value)) throw new Error(`Use --environment ${OPENING_ENVIRONMENTS.join(" or ")}`);
  if (args.includes("--environment")) throw new Error("Name --environment once");
  return { environment: value as OpeningEnvironment, args };
}
type Owned = Pick<SessionContext, "environmentId" | "offer">;
const owned = (context: Owned) => context.offer.local === true && !context.offer.public;
export function requireOwnedFork(context: Owned) {
  if (!(OPENING_ENVIRONMENTS as readonly string[]).includes(context.environmentId) || !owned(context)) throw new Error("Game setup requires the owned local Paseo fork or Previewnet from genesis");
}
/** Setup that only a network started from genesis needs (it lacks what a copy imports). */
export function requireOwnedGenesis(context: Owned) {
  if (context.environmentId !== "previewnet-genesis" || !owned(context)) throw new Error("Genesis setup requires the owned Previewnet from genesis");
}
interface FixtureReceipt {
  ok: boolean;
  events: readonly { type: string; value: unknown }[];
  dispatchError?: unknown;
  txHash?: string;
  block?: { hash: string; number: number; index: number };
}
/** Public chain receipt fields only, never signer, wallet or host state. */
export function sudoReceiptEvidence(label: string, result: FixtureReceipt) {
  const sudoEvents = result.events.filter((event) => event.type === "Sudo").map((event) => {
    const value = event.value as { type?: string; value?: { sudo_result?: unknown } };
    return { type: value.type, sudoResult: value.value?.sudo_result };
  });
  return { label, ok: result.ok, txHash: result.txHash, block: result.block,
    dispatchError: result.dispatchError, sudoEvents,
    eventNames: result.events.map((event) => `${event.type}.${(event.value as { type?: string }).type ?? "unknown"}`) };
}
const json = (value: unknown) => JSON.stringify(value, (_key, field) => typeof field === "bigint" ? field.toString() : field);
export function assertSudoReceipt(result: FixtureReceipt, label = "Fork fixture", record?: (evidence: ReturnType<typeof sudoReceiptEvidence>) => void) {
  const evidence = sudoReceiptEvidence(label, result);
  // Persist before asserting: cleanup discards the fork and its original transaction evidence.
  record?.(evidence);
  const events = result.events.filter((event) => event.type === "Sudo") as Array<{ value: { type?: string; value?: { sudo_result?: { success?: boolean } } } }>;
  if (!result.ok || events.length !== 1 || events[0]?.value.type !== "Sudid" || events[0].value.value?.sudo_result?.success !== true) {
    throw new Error(`${label}: Fork fixture lacks a successful inner Sudo result; receipt=${json(evidence)}`);
  }
}
/** The chain's Sudo.Key must be the setup account. By public key: a genesis People need not print addresses in the
 * copy's SS58 prefix. An absent key or an address that does not decode is refused. */
export function assertSudoKey(key: string | undefined, address: string) {
  let same = false;
  try { same = !!key && publicKeyHex(key) === publicKeyHex(address); } catch { same = false; }
  if (!same) throw new Error("Fork sudo authority mismatch");
}
/** The part of People's API one sudo call uses (a stand-in in tests); `Call` is the runtime's call type. */
export interface SudoApi<Call = unknown> {
  query: { Sudo: { Key: { getValue(options: { at: "finalized" }): Promise<string | undefined> } } };
  tx: { Sudo: { sudo(args: { call: Call }): { createAndSubmit(signer: unknown, options: unknown): Promise<FixtureReceipt> } } };
}
/**
 * One labelled sudo call: the owned-network guard, then the finalized Sudo.Key checked against the signer, before
 * anything is signed; then the receipt, recorded before it is asserted.
 */
export function sudoCall<Call>(api: SudoApi<Call>, settings: { address: string; signer: unknown; options: unknown; guard: () => void;
  record?: (evidence: ReturnType<typeof sudoReceiptEvidence>) => void }) {
  return async (label: string, call: Call) => {
    settings.guard();
    assertSudoKey(await api.query.Sudo.Key.getValue({ at: "finalized" }), settings.address);
    console.log(`Fork fixture: ${label}`);
    const receipt = await api.tx.Sudo.sudo({ call }).createAndSubmit(settings.signer, settings.options);
    assertSudoReceipt(receipt, label, settings.record);
  };
}
export const openingGamePhases = { registration: 3600, shuffle: 90, post_shuffle_margin: 0, reporting: 300, player_process: 90 } as const;
/** Reserve inclusion slack after the entire registration/shuffle/margin window.
 * Runtime rule: individuality-community 9c6f1faa, pallets/game/src/types.rs
 * registration_start; pallets/game/src/lib.rs schedule_games.
 */
export function openingGameSchedule(chainNowSeconds: number, wallNowSeconds: number) {
  const now = Math.ceil(Math.max(chainNowSeconds, wallNowSeconds));
  const beforePlay = openingGamePhases.registration + openingGamePhases.shuffle + openingGamePhases.post_shuffle_margin;
  const game_play_time = now + Math.max(1800, beforePlay + 120);
  if (!Number.isSafeInteger(now) || now < 0 || game_play_time > 0xffff_ffff) throw new Error("Opening game time is outside the runtime's u32 range");
  return { game_play_time, rounds: 1, max_group_size: 4, airdrops: [] };
}
export async function prepareGame(context: SessionContext) {
  requireOwnedFork(context);
  const ws = context.environment.routes?.chains.people?.ws;
  if (!ws || !["127.0.0.1", "[::1]"].includes(new URL(ws).hostname)) throw new Error("Fixture needs the fork's loopback People endpoint");
  // Public development derivation, accepted only on the owned fork and after the Sudo.Key check.
  const { sr25519CreateDerive } = await import("@polkadot-labs/hdkd");
  const { DEV_MINI_SECRET, ss58Address } = await import("@polkadot-labs/hdkd-helpers");
  const root = sr25519CreateDerive(DEV_MINI_SECRET)("//Alice");
  const address = ss58Address(root.publicKey, 42);
  const signer = getTxCreator(root.publicKey, "Sr25519", root.sign);
  const { createPeopleClient, withCustomExtensions } = await import("@jollity/game-chain");
  const options = withCustomExtensions({});
  const evidenceDir = join(context.root, ".product-lab", "opening-reports", "sanitized");
  mkdirSync(evidenceDir, { recursive: true });
  const evidenceFile = join(evidenceDir, `fixture-${Date.now()}.json`);
  const receipts: ReturnType<typeof sudoReceiptEvidence>[] = [];
  const record = (evidence: ReturnType<typeof sudoReceiptEvidence>) => {
    receipts.push(evidence);
    writeFileSync(evidenceFile, json({ kind: "owned-fork-fixture-receipts", receipts }) + "\n", { mode: 0o600 });
  };
  const { client, api } = createPeopleClient(ws);
  try {
    // The cast narrows People's API to the part used; the call keeps the runtime's type, so tsc checks every call.
    const sudo = sudoCall(api as unknown as SudoApi<Parameters<typeof api.tx.Sudo.sudo>[0]["call"]>, { address, signer, options, record, guard: () => requireOwnedFork(context) });
    const schedules = await api.query.Game.GameSchedules.getValue({ at: "finalized" });
    for (const schedule of schedules) await sudo(`Game.remove_scheduled_game(${schedule.game_play_time})`, api.tx.Game.remove_scheduled_game({ game_play_time: schedule.game_play_time }).decodedCall);
    const game = await api.query.Game.Game.getValue({ at: "finalized" });
    if (game) {
      if (!["Registration", "Shuffle"].includes(game.state.type)) throw new Error("Opening cannot cancel this imported game phase");
      await sudo("Game.cancel_game", api.tx.Game.cancel_game().decodedCall);
      const deadline = Date.now() + 240_000;
      while (await api.query.Game.Game.getValue({ at: "finalized" })) {
        if (Date.now() > deadline) throw new Error("Imported game cancellation did not finalize");
        await delay(1000, undefined, { signal: context.signal });
      }
    }
    await sudo("Game.set_game_phases", api.tx.Game.set_game_phases({ phases: openingGamePhases }).decodedCall);
    // Read time after the phase update finalizes, so that transaction cannot consume the schedule's slack.
    const now = Number(await api.query.Timestamp.Now.getValue({ at: "finalized" })) / 1000;
    const schedule = openingGameSchedule(now, Date.now() / 1000);
    const gameAt = schedule.game_play_time;
    await sudo("Game.schedule_games", api.tx.Game.schedule_games({ games_schedules: [schedule] }).decodedCall);
    const until = Date.now() + 120_000;
    while (Date.now() < until) {
      const actual = await api.query.Game.Game.getValue({ at: "finalized" });
      if (actual?.game_date === gameAt && actual.state.type === "Registration" && actual.state.value.next_player_index === 0) return;
      await delay(1000, undefined, { signal: context.signal });
    }
    throw new Error("Empty fork game did not reach finalized Registration");
  } finally { client.destroy(); }
}
