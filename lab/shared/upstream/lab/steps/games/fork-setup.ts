// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import { DispatchFailedError, type TransactionExecutor, type Receipt } from "@parity/product-lab/chain";
import type { GamesPeopleConnection } from "./chain.ts";
import type { GameAuthority } from "./participant.ts";
import { publicKeyHex, SudoDispatchValidator } from "../../chain/sudo.ts";
import { requireOwnedGameFork, type ImportedGamesTarget } from "../humanity/bootstrap/imported-games.ts";
import { planForkCleanup, planForkSetup, assertSetupReceipt, demoPrizeAsset, visiblePhases, type SetupState, type Call } from "./fork-setup-plan.ts";

// Keep only decoded variant names, never arbitrary error payloads, paths or signed bytes.
function dispatchName(error: unknown): string {
  const variant = (value: unknown): { type: string; value?: unknown } | undefined => {
    if (!value || typeof value !== "object" || !("type" in value) || typeof value.type !== "string" || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(value.type)) return;
    return value as { type: string; value?: unknown };
  };
  const outer = variant(error), pallet = variant(outer?.value), inner = variant(pallet?.value);
  return outer?.type === "Module" && pallet ? `${pallet.type}.${inner?.type ?? "Unknown"}` : outer?.type ?? "Unavailable";
}

/** Atomic cleanup, finalized drain, then one provisioning batch. No fallback after any failed batch. */
export async function prepareOwnedGameBatch(chain: GamesPeopleConnection, transactions: TransactionExecutor,
  authority: GameAuthority, target: ImportedGamesTarget, startsInSeconds = 900,
  recordFailure?: (proof: unknown) => Promise<void>) {
  requireOwnedGameFork(target);
  if (chain.access.url !== target.endpoints?.people || transactions.mode !== "finalized") throw Error("Atomic setup requires the owned People connection and finalized transactions");
  const source = await chain.api.constants.Game.AirdropSource();
  const snapshot = async () => {
    requireOwnedGameFork(target);
    const head = await chain.access.finalizedHead();
    const key = await chain.access.historicalStorage("Sudo", "Key", [], head.hash);
    if (typeof key !== "string" || publicKeyHex(key) !== publicKeyHex(authority.address)) throw Error("Owned-fork People sudo authority mismatch");
    const read = (pallet: string, item: string, keys: unknown[] = []) => chain.access.historicalStorage(pallet, item, keys, head.hash, { orDefault: true });
    const [game, schedules, phases, asset, enabled, owner, funds, now] = await Promise.all([
      read("Game", "Game"), read("Game", "GameSchedules"), read("Game", "StoredPhaseDurations"),
      read("Assets", "Asset", [demoPrizeAsset]), read("Airdrop", "SupportedAssets", [demoPrizeAsset]),
      read("Assets", "Account", [demoPrizeAsset, authority.address]), read("Assets", "Account", [demoPrizeAsset, source]), read("Timestamp", "Now"),
    ]) as any[];
    if (asset && publicKeyHex(asset.owner) !== publicKeyHex(authority.address)) throw Error("Local prize asset has another owner");
    const state: SetupState = { game, schedules, phases, asset, enabled: !!enabled, ownerBalance: owner?.balance ?? 0n, sourceBalance: funds?.balance ?? 0n };
    return { head, state, asset, now };
  };
  const api = chain.access.client.getUnsafeApi();
  const sudo = api.tx.Sudo?.sudo;
  if (!sudo) throw Error("Runtime has no Sudo.sudo");
  const submit = async (label: string, batch: { calls: Call[]; call: Call }) => {
    let failure: { dispatchError: string } | undefined;
    const retain = async (receipt: Receipt, error: unknown) => {
      if (failure) return;
      failure = { dispatchError: dispatchName(error) };
      await recordFailure?.({ ...failure, label, block: { number: receipt.block.number },
        calls: batch.calls.map(call => `${call.type}.${call.value.type}`),
        evidence: "decoded receipt validation; finality is not inferred from an inner failure" });
    };
    const validator = new SudoDispatchValidator();
    try {
      const receipt = await transactions.submit(label, sudo(batch.call.value.value), authority.signer, {
        async validate(receipt) {
          const verdict = await validator.validate(receipt);
          if (!verdict.ok) {
            const sudid = receipt.events.find(e => e.type === "Sudo" && e.value.type === "Sudid");
            const result = sudid?.value.value as { sudo_result?: { value?: unknown } } | undefined;
            await retain(receipt, result?.sudo_result?.value);
            return { ok: false, reason: `inner dispatch failed: ${failure!.dispatchError}` };
          }
          return verdict;
        },
      });
      assertSetupReceipt(receipt, batch.calls.length);
      return receipt;
    } catch (error) {
      const outer = DispatchFailedError.in(error);
      if (outer) await retain(outer.receipt, outer.receipt.dispatchError);
      // The framework's original cause stays private; never cite a deleted journal in the public message.
      if (failure) throw new Error(`${label}: dispatch failed: ${failure.dispatchError}`, { cause: error });
      await recordFailure?.({ label, dispatchError: "Unavailable", reason: "No decoded failing receipt was available" });
      throw new Error(`${label}: failed without a decoded dispatch error; see atomicSetupFailure attachment`, { cause: error });
    }
  };
  let before = await snapshot();
  let cleanup: { before: typeof before.head; after: typeof before.head; elapsedMs: number; calls: Call[]; receipt: Receipt } | undefined;
  if (before.state.game) {
    const imported = before.state.game.index, plan = planForkCleanup(before.state);
    const receipt = await submit("Atomic imported DIM2 cleanup", plan);
    const started = chain.clock.now(), deadline = started + 180_000;
    let after = await chain.access.finalizedHead();
    while (true) {
      chain.signal.throwIfAborted();
      const [game, schedules] = await Promise.all([
        chain.access.historicalStorage("Game", "Game", [], after.hash, { orDefault: true }),
        chain.access.historicalStorage("Game", "GameSchedules", [], after.hash, { orDefault: true }),
      ]) as [SetupState["game"], SetupState["schedules"]];
      if (schedules.length) throw Error("Atomic imported DIM2 cleanup left schedules; provisioning refused");
      if (!game) break;
      if (game.index !== imported || game.state.type !== "Cancelling") throw Error("Atomic imported DIM2 cleanup observed an unexpected game; provisioning refused");
      if (chain.clock.now() >= deadline) throw Error(`Imported DIM2 cancellation #${imported} did not finish within 180000ms; provisioning refused`);
      await chain.clock.sleep(Math.min(1_000, deadline - chain.clock.now()), chain.signal);
      after = await chain.access.finalizedHead();
    }
    cleanup = { before: before.head, after, elapsedMs: chain.clock.now() - started, calls: plan.calls, receipt };
    before = await snapshot();
  }
  const { head, state, asset, now } = before;
  const plan = planForkSetup(state, authority.address, source, Math.ceil(Math.max(Number(now), Date.now()) / 1000), startsInSeconds);
  const receipt = await submit("Atomic owned-fork game setup", plan);
  const after = await chain.access.finalizedHead();
  const storage = (pallet: string, item: string, keys: unknown[] = []) => chain.access.historicalStorage(pallet, item, keys, after.hash, { orDefault: true });
  const [actualPhases, actualAsset, supported, actualGame, remaining] = await Promise.all([
    storage("Game", "StoredPhaseDurations"), storage("Assets", "Asset", [demoPrizeAsset]), storage("Airdrop", "SupportedAssets", [demoPrizeAsset]), storage("Game", "Game"), storage("Game", "GameSchedules"),
  ]) as any[];
  const minted = plan.calls.filter(c => c.type === "Utility").reduce((sum, c) => sum + c.value.value.call.value.value.amount, 0n);
  if (BigInt(actualAsset?.supply ?? -1) !== BigInt(asset?.supply ?? 0) + minted) throw Error("Finalized prize supply does not match the planned funding");
  if (Object.entries(visiblePhases).some(([key, value]) => actualPhases?.[key] !== value) || !actualAsset || !supported ||
      publicKeyHex(actualAsset.owner) !== publicKeyHex(authority.address) || BigInt(actualAsset.min_balance) !== (asset?.min_balance ?? 1n) ||
      remaining.some((s: any) => s.game_play_time !== plan.schedule.game_play_time || s.rounds !== 1 || s.max_group_size !== 4 || s.airdrops?.length !== 1) ||
      !(remaining.some((s: any) => s.game_play_time === plan.schedule.game_play_time) ||
        (actualGame?.game_date === plan.schedule.game_play_time && actualGame.state.type === "Registration" && actualGame.state.value.next_player_index === 0 && actualGame.rounds === 1 && actualGame.max_group_size === 4 && actualGame.airdrops_scheduled === 1)))
    throw Error("Finalized fork setup state does not match the atomic plan");
  return { before: head, after, cleanup, calls: plan.calls, schedule: plan.schedule, receipt, state: { phases: actualPhases, asset: actualAsset, supported, game: actualGame, schedules: remaining } };
}
