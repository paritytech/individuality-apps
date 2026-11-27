// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import type { EnvironmentOffer, SecretSigner } from "@parity/product-lab";
import type { TransactionExecutor } from "@parity/product-lab/chain";
import type { NetworkSession } from "../../../network-session.ts";
import type { PeopleConnection } from "../chain/people.ts";
import { SudoDispatchValidator, verifySudoKey } from "../../../chain/sudo.ts";

/** Missing ownership information is a refusal, including a loopback proxy to a public chain. */
export interface ImportedGamesTarget {
  readonly offer?: EnvironmentOffer;
  readonly endpoints?: Readonly<Record<string, string>>;
  readonly humanity?: { readonly network:
    | { readonly kind: "workspace"; readonly workspace: { readonly network: { readonly owned: boolean; readonly session: NetworkSession } } }
    | { readonly kind: "owned"; readonly session: NetworkSession }
    | { readonly kind: "attached"; readonly session: NetworkSession };
  };
}

export function requireOwnedGameFork(target: ImportedGamesTarget): void {
  const network = target.humanity?.network;
  const session = network?.kind === "workspace" && network.workspace.network.owned === true
    ? network.workspace.network.session : network?.kind === "owned" ? network.session : undefined;
  if (target.offer?.local !== true || !session)
    throw new Error("Clearing imported DIM2 games requires the lab's own local fork; attached, public and unowned targets are refused");
  const endpoint = target.endpoints?.people;
  if (session.schemaVersion !== 1 || session.mode !== "fork" || session.ownership !== "owned" || !endpoint || endpoint !== session.chains.people.ws)
    throw new Error("Clearing imported DIM2 games refuses a People endpoint outside the owned fork");
  const url = new URL(endpoint);
  if (!["ws:", "wss:"].includes(url.protocol) || !["127.0.0.1", "[::1]"].includes(url.hostname))
    throw new Error("Clearing imported DIM2 games refuses a live or public People endpoint");
}

const CANCELLATION_WAIT_MS = 180_000;
// Reporting can start before game_date. Cover the one-hour live reporting window,
// its pre-play lead and bounded block processing/finality slack. Never extend on progress.
export const IMPORTED_GAME_WAIT_MS = 65 * 60_000;
// Optional flow policy: invalid or excessive bounds fail closed; unset preserves local behavior.
export function importedGameWaitMs(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const ms = Number(value);
  if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(ms) || ms > IMPORTED_GAME_WAIT_MS)
    throw new Error("Invalid HUMANITY_FLOW_IMPORTED_GAME_WAIT_MS");
  return ms;
}
const PROCESSING_WAIT_MS = 180_000;
// Judge finality near the deadline, including a chain that advanced earlier then froze.
export const IMPORTED_GAME_FINALITY_STALL_MS = 60_000;
const WAITABLE_STATES = ["Reporting", "PlayerProcess", "Cancelling"];
type ImportedGame = { index: number; game_date: number; report_ends: number; pending_attendance: number;
  state: { type: string; value?: { next_player_index?: number } } };

/** Runtime calls only, each finalized before the next fresh read. Never relax the game setup's idle check. */
export async function clearImportedGames(options: {
  target: ImportedGamesTarget;
  chain: PeopleConnection;
  root: SecretSigner;
  transactions: Pick<TransactionExecutor, "submit">;
  record(event: unknown): void;
  waitMs?: number;
}) {
  const { target, chain, root, transactions, record } = options;
  requireOwnedGameFork(target);
  if (options.waitMs !== undefined && (!Number.isSafeInteger(options.waitMs) || options.waitMs <= 0 || options.waitMs > IMPORTED_GAME_WAIT_MS))
    throw new Error("Invalid imported game wait bound");
  if (chain.access.url !== target.endpoints?.people)
    throw new Error("Clearing imported DIM2 games refuses a signing connection outside the owned fork's People endpoint");
  let recordedHead: string | undefined;
  let lastHeadAdvanceAt = chain.clock.now();
  const observe = async () => {
    chain.signal.throwIfAborted();
    const head = await chain.access.finalizedHead();
    const [game, schedules] = await Promise.all([
      chain.access.storage("Game", "Game", [], head.hash) as Promise<ImportedGame | undefined>,
      chain.access.storage("Game", "GameSchedules", [], head.hash) as Promise<{ game_play_time: number }[]>,
    ]);
    if (head.hash !== recordedHead) {
      record({ kind: "imported-games-state", head, game, schedules });
      recordedHead = head.hash;
      lastHeadAdvanceAt = chain.clock.now();
    }
    return { head, game, schedules };
  };
  // Snapshot before waiting: only this import and a proven runtime promotion may be handled.
  const imported = await observe();
  let waitDeadline: number | undefined;
  const read = async (cancelledGame?: number, observed?: Awaited<ReturnType<typeof observe>>) => {
    let current = observed ?? await observe();
    const requireImported = () => {
      const game = current.game;
      if (!game || game.index === imported.game?.index) return;
      const reason = imported.game && !WAITABLE_STATES.includes(imported.game.state.type)
        ? "only an import past Shuffle may hand off a runtime promotion"
        : imported.game && game.index !== imported.game.index + 1 ? `expected next index #${imported.game.index + 1}`
        : game.state.type !== "Registration" ? `state ${game.state.type} is not Registration`
        : game.state.value?.next_player_index !== 0 ? "Registration next_player_index must be 0 (no players)"
        : game.pending_attendance !== 0 ? "pending_attendance must be 0 (no players)"
        : !imported.schedules.some(schedule => schedule.game_play_time === game.game_date)
          ? `game_date ${game.game_date} is not a snapshotted schedule` : undefined;
      if (reason) throw new Error(`Imported DIM2 cleanup refused replacement game #${game.index}: ${reason}; no replacement cancellation or storage edits are allowed`);
    };
    requireImported();
    if (cancelledGame === undefined && current.game && WAITABLE_STATES.includes(current.game.state.type)) {
      const startedAt = chain.clock.now(), from = current.head, index = current.game.index;
      let chainNow = Number(await chain.access.storage("Timestamp", "Now", [], current.head.hash));
      if (!Number.isSafeInteger(chainNow) || chainNow < 0 || !Number.isSafeInteger(current.game.report_ends) || current.game.report_ends < 0)
        throw new Error(`Imported DIM2 game #${index} has invalid finalized chain time or report_ends; cannot bound the completion wait`);
      const remainingReporting = current.game.state.type === "Reporting" ? Math.max(0, current.game.report_ends * 1000 - chainNow) : 0;
      const limitMs = Math.min(options.waitMs ?? IMPORTED_GAME_WAIT_MS, remainingReporting + PROCESSING_WAIT_MS);
      waitDeadline ??= startedAt + limitMs;
      let outcome = "refused";
      try {
        while (current.game && WAITABLE_STATES.includes(current.game.state.type)) {
          chain.signal.throwIfAborted();
          if (chain.clock.now() >= waitDeadline) {
            outcome = "timeout";
            const stalled = current.head.hash === from.hash || chain.clock.now() - lastHeadAdvanceAt >= IMPORTED_GAME_FINALITY_STALL_MS;
            if (options.waitMs !== undefined && !stalled && current.game.state.type === "Reporting")
              throw new Error("not run: imported game in Reporting");
            const reason = stalled ? `finalized People head did not advance for ${chain.clock.now() - lastHeadAdvanceAt}ms`
              : current.game.state.type === "Reporting" && chainNow < current.game.report_ends * 1000
                ? "finalized chain time has not reached report_ends"
                : "runtime block processing has not removed the imported game";
            throw new Error(`Imported DIM2 game #${index} completion timed out after ${chain.clock.now() - startedAt}ms: ${reason}; state ${current.game.state.type} at finalized #${current.head.number}, chain time ${chainNow}ms, report_ends ${current.game.report_ends}s. cancel_game only permits Registration or Shuffle; no storage edits are allowed`);
          }
          await chain.clock.sleep(Math.min(1_000, waitDeadline - chain.clock.now()), chain.signal);
          current = await observe();
          requireImported();
          chainNow = Number(await chain.access.storage("Timestamp", "Now", [], current.head.hash));
          if (!Number.isSafeInteger(chainNow) || chainNow < 0)
            throw new Error("Imported DIM2 completion wait received invalid finalized chain time");
        }
        outcome = "completed";
      } finally {
        record({ kind: "imported-games-completion-wait", game: index, from, to: current.head,
          elapsedMs: chain.clock.now() - startedAt, limitMs, deadline: waitDeadline,
          state: current.game?.state.type ?? "absent", chainNow,
          outcome: chain.signal.aborted ? "aborted" : outcome });
      }
    }
    const { head, game, schedules } = current;
    // Only our own finalized cancellation may enter this transient runtime state.
    const completingCancellation = cancelledGame !== undefined && game?.state.type === "Cancelling" && game.index === cancelledGame;
    if (game && !["Registration", "Shuffle"].includes(game.state.type) && !completingCancellation)
      throw new Error(`Imported DIM2 game #${game.index} is in ${game.state.type} at finalized #${head.number}; cancel_game only permits Registration or Shuffle. Stop for a decision; no storage edits are allowed`);
    return { head, game, schedules };
  };
  const submit = async (label: string, call: Parameters<typeof chain.api.tx.Sudo.sudo>[0]["call"], validator?: SudoDispatchValidator) => {
    requireOwnedGameFork(target);
    const authority = await verifySudoKey(chain.api, root.address, { label: "fork root People Sudo.Key" });
    if (authority !== true) throw new Error(`Clearing imported DIM2 games refused: ${authority}`);
    await transactions.submit(label, chain.api.tx.Sudo.sudo({ call }), root.signer, validator);
  };
  const isPromoted = (current: Awaited<ReturnType<typeof read>>) =>
    current.game !== undefined && current.game.index !== imported.game?.index;
  const handOff = (current: Awaited<ReturnType<typeof read>>, removed: number, cancelled: number | null = null) => {
    const outcome = { removed, cancelled, promoted: current.game!.index, finalized: current.head };
    record({ kind: "imported-games-handoff", ...outcome, game: current.game, schedules: current.schedules });
    return outcome;
  };
  // Wait before any schedule removal. The runtime may promote a snapshotted schedule;
  // leave that validated empty Registration game and all remaining schedules to step 3.
  const initial = await read(undefined, imported);
  if (isPromoted(initial)) return handOff(initial, 0);
  let removed = 0;
  // If no game was promoted, remove only the snapshotted schedules as before.
  for (const schedule of imported.schedules) {
    const current = await read();
    if (isPromoted(current)) return handOff(current, removed);
    if (!current.schedules.some((entry) => entry.game_play_time === schedule.game_play_time)) continue;
    await submit(`Remove imported DIM2 schedule ${schedule.game_play_time}`,
      chain.api.tx.Game.remove_scheduled_game({ game_play_time: schedule.game_play_time }).decodedCall,
      new SudoDispatchValidator(async (error, receipt) => {
        // on_poll consumes a schedule as soon as Game is absent, even before its play date.
        // A finalized snapshot can therefore name a schedule already consumed at dispatch.
        const module = error as { type?: string; value?: { type?: string; value?: { type?: string } } };
        if (module?.type !== "Module" || module.value?.type !== "Game" || module.value.value?.type !== "NoSuchGameScheduled") return false;
        const remaining = await chain.access.storage("Game", "GameSchedules", [], receipt.block.hash) as { game_play_time: number }[];
        if (!Array.isArray(remaining) || remaining.some(s => s.game_play_time === schedule.game_play_time)) return false;
        record({ kind: "imported-schedule-runtime-consumed", schedule: schedule.game_play_time, at: receipt.block, error });
        return true;
      }));
    removed++;
  }
  const current = await read();
  if (isPromoted(current)) return handOff(current, removed);
  if (current.game) await submit(`Cancel imported DIM2 game #${current.game.index} (${current.game.state.type})`,
    chain.api.tx.Game.cancel_game().decodedCall);
  const cancelledGame = current.game?.index;
  let final = await read(cancelledGame);
  if (final.game?.state.type === "Cancelling" && final.game.index === cancelledGame) {
    const startedAt = chain.clock.now(), from = final.head;
    const deadline = startedAt + CANCELLATION_WAIT_MS;
    let outcome = "refused";
    try {
      while (final.game?.state.type === "Cancelling" && final.game.index === cancelledGame && chain.clock.now() < deadline) {
        await chain.clock.sleep(1_000, chain.signal);
        final = await read(cancelledGame);
      }
      outcome = final.game?.state.type === "Cancelling" ? "timeout" : "completed";
    } finally {
      record({ kind: "imported-games-cancellation-wait", game: cancelledGame, from, to: final.head,
        elapsedMs: chain.clock.now() - startedAt, limitMs: CANCELLATION_WAIT_MS,
        outcome: chain.signal.aborted ? "aborted" : outcome });
    }
  }
  if (isPromoted(final)) return handOff(final, removed, cancelledGame ?? null);
  if (final.game || final.schedules.length)
    throw new Error(`Imported DIM2 cleanup is incomplete at finalized #${final.head.number}: Game.Game must be absent and GameSchedules empty` +
      (final.game?.state.type === "Cancelling" ? ` (cancellation #${cancelledGame} did not finish within ${CANCELLATION_WAIT_MS}ms)` : ""));
  const outcome = { removed, cancelled: current.game?.index ?? null, finalized: final.head };
  record({ kind: "imported-games-cleared", ...outcome });
  return outcome;
}
