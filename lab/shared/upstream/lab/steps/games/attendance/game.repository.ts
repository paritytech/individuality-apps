// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import { prepareOwnedGameBatch } from "../fork-setup.ts";
import type { ImportedGamesTarget } from "../../humanity/bootstrap/imported-games.ts";
import { Enum } from "polkadot-api";
import { addressesEqual } from "@parity/product-sdk/address";
import { submitBatch, type TransactionExecutor } from "@parity/product-lab/chain";
import { SudoDispatchValidator } from "../../../chain/sudo.ts";
import type { GameAuthority, GameParticipant } from "../participant.ts";
import type { GamesPeopleApi, GamesPeopleConnection } from "../chain.ts";
import { reportingAlreadyCompleted } from "../reporting/reporting-completion.ts";
import type { GameOperations, GameRetime } from "../operations.ts";
import { getTypedCodecs } from "polkadot-api";
import { fromHex, toHex } from "polkadot-api/utils";
import { people } from "../../../chain/descriptors.ts";
import { drawUnit, retimedGame, scheduleKey, scheduleOrder, scheduleTime, shiftedDraw } from "../game-retime.ts";

/** `Game::airdrop_event_id(game_index, airdrop_index)`: the 27-byte base, the draw's index (u8), the game's index (u32 big-endian). */
export function airdropEventId(base: string, gameIndex: number, airdropIndex: number): string {
  const bytes = fromHex(base);
  if (bytes.length !== 27) throw new Error(`airdrop_event_id_base must be 27 bytes, got ${bytes.length}`);
  const id = new Uint8Array(32);
  id.set(bytes, 0);
  id[27] = airdropIndex & 0xff;
  new DataView(id.buffer).setUint32(28, gameIndex, false);
  return toHex(id);
}

import { localPhases as phases, visiblePhases, demoPrizeAsset, demoPrize } from "../fork-setup-plan.ts";
type RootCall = {
  decodedCall: Parameters<GamesPeopleApi["tx"]["Sudo"]["sudo"]>[0]["call"];
};

/** Low-level Game calls. No desired membership state or expected scores.
 * Root calls are signed by the injected authority: the games administrator,
 * whose signer comes from lab secrets and has passed its Sudo.Key check.
 * Internal to games: other integrations get it as `GameOperations`. */
/**
 * "Now" for a new or moved schedule, in unix seconds: the later of a block's timestamp and the machine's clock. A
 * fork restored from a saved state keeps the saved block as its best one until it makes a new block, and its
 * finalized block longer still, so that block's timestamp is the time of the save. Seen 30 September 2026: a
 * schedule counted from it lands in the past once the save is older than the registration phase, and the runtime
 * refuses it ("inner dispatch failed" 17 and 25 minutes after the save); a game re-timed "to play in 3 minutes"
 * from a finalized block four minutes old was given a play date already past, and the runtime dropped the game at
 * the next block (the players' homes said "No game scheduled"). The local chains run on the wall clock, so the
 * call executes at the machine's time or later.
 */
export function scheduleNow(blockTimestampMs: number, machineMs: number): number {
  return Math.ceil(Math.max(blockTimestampMs, machineMs) / 1000);
}

export class GameRepository implements GameOperations {
  constructor(
    private readonly chain: GamesPeopleConnection,
    private readonly transactions: TransactionExecutor,
    private readonly authority: GameAuthority,
  ) {}

  private get head() {
    return this.transactions.mode === "checkpoint" ? "best" : "finalized";
  }

  private waitFor<T>(
    label: string,
    read: (at: { at: string }) => Promise<T | undefined>,
  ) {
    return this.chain.waitFor(
      label,
      (at) => {
        this.transactions.assertHealthy();
        return read(at);
      },
      180_000,
      this.head,
    );
  }

  private root(label: string, call: RootCall, intermediate = true) {
    const submit = intermediate
      ? this.transactions.submitIntermediate.bind(this.transactions)
      : this.transactions.submit.bind(this.transactions);
    return submit(
      label,
      this.chain.api.tx.Sudo.sudo({ call: call.decodedCall }),
      this.authority.signer,
    );
  }

  /** The Sudo.Key comparison is the administrator's verifyAuthority; only the phase set-up stays here. */
  async prepareLocalGames(options: { visibleRegistration?: boolean } = {}): Promise<void> {
    const api = this.chain.api;
    await this.requireIdleGame();
    const configured = options.visibleRegistration ? visiblePhases : phases;
    const previous = await api.query.Game.StoredPhaseDurations.getValue();
    if (JSON.stringify(previous) !== JSON.stringify(configured)) {
      await this.root(
        "Configure accelerated local game phases",
        api.tx.Game.set_game_phases({ phases: configured }),
        false,
      );
    }
  }

  async fundLocalGameAccounts(accounts: readonly { name: string; address: string }[]): Promise<void> {
    if (accounts.length !== 3 || new Set(accounts.map((account) => account.address)).size !== 3)
      throw new Error("The visible DIM2 game requires exactly three distinct host product accounts");
    const api = this.chain.api;
    const deposit = await api.query.Game.PlayDepositAmount.getValue();
    // A new account needs the play deposit and fee headroom before DIM2 offers
    // its deposit-route Register button. The local authority funds only the
    // scenario's three real product accounts, and only up to this minimum.
    const minimum = deposit + 10_000_000_000n;
    const head = await this.chain.access.finalizedHead();
    const balances = await Promise.all(accounts.map(async (account) => ({
      account,
      free: (await api.query.System.Account.getValue(account.address, { at: head.hash })).data.free,
    })));
    const short = balances.filter(({ free }) => free < minimum);
    // One atomic batch of the authority's transfers (29 September 2026, fixtures lane: it was one finalized
    // transaction per account); the chain's Utility events give each transfer's own result.
    if (short.length) await submitBatch(this.transactions, {
      label: "Fund the DIM2 game accounts",
      calls: short.map(({ account, free }) => ({
        label: `Fund ${account.name}'s DIM2 game account`,
        call: api.tx.Balances.transfer_keep_alive({ dest: Enum("Id", account.address), value: minimum - free }),
      })),
      signer: this.authority.signer,
      build: (calls, mode) => api.tx.Utility[mode === "all" ? "batch_all" : "batch"]({ calls: calls.map((call) => (call as { decodedCall: never }).decodedCall) }),
    });
    const verified = await this.chain.access.finalizedHead();
    for (const account of accounts) {
      const funded = (await api.query.System.Account.getValue(account.address, { at: verified.hash })).data.free;
      if (funded < minimum)
        throw new Error(`${account.name}'s DIM2 game account holds ${funded}, below the local minimum ${minimum} at finalized #${verified.number}`);
    }
  }

  private async requireIdleGame(): Promise<void> {
    const api = this.chain.api;
    if (
      (await api.query.Game.Game.getValue()) ||
      (await api.query.Game.GameSchedules.getValue()).length
    ) {
      throw new Error(
        "Another game or schedule exists; refusing to overwrite it",
      );
    }
  }

  /** Idempotent local draw setup; production schedulers provision and fund these assets separately. */
  async prepareLocalPrize(): Promise<void> {
    const api = this.chain.api;
    const asset = await api.query.Assets.Asset.getValue(demoPrizeAsset);
    if (!asset) {
      await this.root("Create local DIM2 prize asset", api.tx.Assets.force_create({
        id: demoPrizeAsset,
        owner: Enum("Id", this.authority.address),
        is_sufficient: true,
        min_balance: 1n,
      }), false);
    }
    const minimum = asset?.min_balance ?? 1n;
    const enabled = await api.query.Airdrop.SupportedAssets.getValue(demoPrizeAsset);
    if (!enabled) {
      const ownerBalance = (await api.query.Assets.Account.getValue(demoPrizeAsset, this.authority.address))?.balance ?? 0n;
      if (ownerBalance < minimum)
        await this.transactions.submit("Fund local DIM2 prize gate", api.tx.Assets.mint({
          id: demoPrizeAsset, beneficiary: Enum("Id", this.authority.address), amount: minimum - ownerBalance,
        }), this.authority.signer);
      await this.root("Enable local DIM2 prize asset", api.tx.Airdrop.enable_asset({
        asset_id: demoPrizeAsset, source: this.authority.address,
      }), false);
    }
    const source = await api.constants.Game.AirdropSource();
    const available = (await api.query.Assets.Account.getValue(demoPrizeAsset, source))?.balance ?? 0n;
    const prizeAllocation = demoPrize.prize.asset_amount * BigInt(demoPrize.prize.max_winners);
    const needed = prizeAllocation > minimum ? prizeAllocation : minimum;
    if (available < needed)
      await this.transactions.submit("Fund local DIM2 prize source", api.tx.Assets.mint({
        id: demoPrizeAsset, beneficiary: Enum("Id", source), amount: needed - available,
      }), this.authority.signer);
  }

  async schedule(options: { withPrize?: boolean; startsInSeconds?: number; ownedBatch?: ImportedGamesTarget; recordSetup?: (proof: unknown) => void; recordSetupFailure?: (proof: unknown) => Promise<void> } = {}): Promise<number> {
    const api = this.chain.api;
    if (options.ownedBatch) {
      if (!options.withPrize) throw Error("Atomic fork setup requires a prize game");
      const proof = await prepareOwnedGameBatch(this.chain, this.transactions, this.authority, options.ownedBatch, options.startsInSeconds, options.recordSetupFailure);
      options.recordSetup?.(proof);
    } else {
      await this.requireIdleGame();
      if (options.withPrize) await this.prepareLocalPrize();
      const configured = options.withPrize ? visiblePhases : phases;
      const now = scheduleNow(Number(await api.query.Timestamp.Now.getValue({ at: "best" })), Date.now());
      await this.root(
        "Schedule one real game",
        api.tx.Game.schedule_games({
          games_schedules: [
            {
              game_play_time:
                now + Math.max(configured.registration + configured.shuffle + 120, options.startsInSeconds ?? 0),
              rounds: 1,
              max_group_size: 4,
              airdrops: options.withPrize ? [demoPrize] : [],
              // Runtime 3_005_000: the lab claims no tenure credits, so the window is empty.
              tenure_claim_window: 0,
            },
          ],
        }),
      );
    }
    return this.waitFor("Game registration", async (at) => {
      // The connection's finalized hash comes from plain RPC and is not
      // necessarily pinned by polkadot-api's chainHead subscription.
      const game = await this.chain.access.historicalStorage("Game", "Game", [], at.at) as
        { index: number; state: { type: string }; airdrops_scheduled: number } | undefined;
      const schedules = game ? undefined : await this.chain.access.historicalStorage("Game", "GameSchedules", [], at.at) as unknown[] | undefined;
      if (!game && !schedules?.length) {
        throw new Error(
          "Runtime consumed the schedule without creating a game",
        );
      }
      if (options.withPrize && game?.state.type === "Registration" && game.airdrops_scheduled < 1)
        throw new Error("The local DIM2 prize draw was not scheduled; Humanity cannot reserve a game seat");
      return game?.state.type === "Registration" ? game.index : undefined;
    });
  }

  async retime(gameIndex: number, playsInSeconds: number): Promise<GameRetime> {
    const api = this.chain.api;
    const head = await this.chain.access.finalizedHead();
    const at = { at: head.hash };
    const [game, phases, now] = await Promise.all([
      api.query.Game.Game.getValue(at),
      api.query.Game.StoredPhaseDurations.getValue(at),
      api.query.Timestamp.Now.getValue(at),
    ]);
    if (!game) throw new Error(`No DIM2 game is on the chain at finalized #${head.number}; nothing re-timed`);
    if (!phases) throw new Error("The chain stores no game phase durations; nothing re-timed");
    // The finalized block's time can be minutes old right after a restore (finality resumes slowly); the move counts
    // from the machine's time then, as a new schedule does.
    const moved = retimedGame(game, gameIndex, scheduleNow(Number(now), Date.now()), playsInSeconds, phases);
    const codecs = await getTypedCodecs(people);
    const items: [Uint8Array, Uint8Array][] = [[fromHex(await api.query.Game.Game.getKey()), codecs.query.Game.Game.value.enc(moved.game)]];
    const kill: Uint8Array[] = [];
    const base = await api.constants.Game.airdrop_event_id_base();
    const schedule = await api.query.Airdrop.ActionSchedule.getEntries(at);
    const draws: { id: string; drawTime: { from: string; to: string }; schedule: string[] }[] = [];
    for (let index = 0; index < game.airdrops_scheduled; index++) {
      const id = airdropEventId(base, gameIndex, index);
      const draw = await api.query.Airdrop.Events.getValue(id, at);
      if (!draw) throw new Error(`Prize draw ${index} of game #${gameIndex} (${id}) is not on the chain; nothing re-timed`);
      const unit = drawUnit(draw.info, game.game_date);
      const info = shiftedDraw(draw.info, moved.shiftSeconds, unit);
      items.push([fromHex(await api.query.Airdrop.Events.getKey(id)), codecs.query.Airdrop.Events.value.enc({ ...draw, info })]);
      const keys: string[] = [];
      for (const { keyArgs } of schedule.filter((entry) => entry.keyArgs[1].toLowerCase() === id.toLowerCase())) {
        const order = scheduleOrder(keyArgs[0], draw.info);
        const time = scheduleKey(scheduleTime(keyArgs[0], order) - BigInt(moved.shiftSeconds) * unit, order);
        kill.push(fromHex(await api.query.Airdrop.ActionSchedule.getKey(keyArgs[0], keyArgs[1])));
        items.push([fromHex(await api.query.Airdrop.ActionSchedule.getKey(time, keyArgs[1])), new Uint8Array()]);
        keys.push(`${keyArgs[0]} -> ${time}`);
      }
      draws.push({ id, drawTime: { from: String(draw.info.draw_time), to: String(info.draw_time) }, schedule: keys });
    }
    // One root call, all or nothing: the old schedule entries go, then every new date is written.
    const calls = [
      ...(kill.length ? [api.tx.System.kill_storage({ keys: kill }).decodedCall] : []),
      api.tx.System.set_storage({ items }).decodedCall,
    ];
    await this.root(`Re-time DIM2 game #${gameIndex} to play in ${playsInSeconds} s (its schedule, not the chain's time)`, api.tx.Utility.batch_all({ calls }), false);
    const verified = await this.chain.access.finalizedHead();
    const written = await api.query.Game.Game.getValue({ at: verified.hash });
    if (!written || written.index !== gameIndex || written.game_date !== moved.game.game_date)
      throw new Error(`After the re-time, finalized #${verified.number} shows game ${written ? `#${written.index} playing at ${written.game_date}` : "none"}, not #${gameIndex} at ${moved.game.game_date}`);
    return { gameIndex, from: game.game_date, to: moved.game.game_date, shiftSeconds: moved.shiftSeconds, draws, verifiedAt: { number: verified.number, hash: verified.hash } };
  }

  async enroll(actors: readonly GameParticipant[]): Promise<void> {
    // Separate accounts have independent nonces; never parallelize one actor's calls.
    await Promise.all(
      actors.map((actor) =>
        this.transactions.submitIntermediate(
          `Enroll ${actor.name}`,
          this.chain.api.tx.Game.sign_up_with_account({
            identifier_key: actor.identifier,
            airdrops: undefined,
          }),
          actor.signer,
        ),
      ),
    );
  }

  async startReporting(gameIndex: number): Promise<void> {
    await this.root(
      "Start real shuffle",
      this.chain.api.tx.Game.testnet_force_start_shuffle(),
    );
    await this.waitFor("Game reporting", async (at) => {
      const game = await this.chain.api.query.Game.Game.getValue(at);
      if (!game || game.state.type === "Cancelling")
        throw new Error("Runtime cancelled the game");
      return game.index === gameIndex && game.state.type === "Reporting"
        ? true
        : undefined;
    });
  }

  /** Addresses of the shuffled group (group 0), checked against `actors`. */
  async shuffledGroup(actors: readonly GameParticipant[]): Promise<string[]> {
    const api = this.chain.api;
    const at = {
      at:
        this.head === "best"
          ? (await this.chain.access.client.getBestBlocks())[0]!.hash
          : (await this.chain.access.client.getFinalizedBlock()).hash,
    };
    const group = await Promise.all(
      actors.map((_, index) =>
        api.query.Game.IndexToPlayer.getValue([0, index], at),
      ),
    );
    return group.map((entry) => {
      if (
        entry?.type !== "Account" ||
        !actors.some((actor) => addressesEqual(actor.address, entry.value))
      ) {
        throw new Error("Unexpected participant in shuffled group");
      }
      return entry.value;
    });
  }

  /** One participant's attendance report on everyone else in its group:
   * `NotPerson` for the absent participants, `Person` for the others. */
  async reportFrom(
    reporter: GameParticipant,
    group: readonly string[],
    absent: readonly GameParticipant[] = [],
  ): Promise<void> {
    if (absent.includes(reporter))
      throw new Error(`${reporter.name} is absent and cannot report`);
    await this.transactions.submitIntermediate(
      `Report attendance from ${reporter.name}`,
      this.chain.api.tx.Game.report({
        full_report: [
          group
            .filter((address) => !addressesEqual(address, reporter.address))
            .map((address) =>
              Enum(
                absent.some((actor) => addressesEqual(address, actor.address))
                  ? "NotPerson"
                  : "Person",
              ),
            ),
        ],
      }),
      reporter.signer,
    );
  }

  async report(
    actors: readonly GameParticipant[],
    absent?: GameParticipant | readonly GameParticipant[],
  ): Promise<void> {
    const missing: readonly GameParticipant[] =
      absent === undefined ? [] : Array.isArray(absent) ? absent : [absent as GameParticipant];
    const group = await this.shuffledGroup(actors);
    const reporters = actors.filter((actor) => !missing.includes(actor));
    await Promise.all(
      reporters.map((actor) => this.reportFrom(actor, group, missing)),
    );
  }

  async complete(
    hasAbsentParticipant: boolean,
    gameIndex: number,
  ): Promise<void> {
    const api = this.chain.api;
    // Full attendance completes naturally. An absent reporter needs the timeout.
    if (
      hasAbsentParticipant &&
      (await api.query.Game.Game.getValue({ at: this.head }))?.state.type ===
        "Reporting"
    ) {
      const call = api.tx.Sudo.sudo({
        call: api.tx.Game.testnet_force_end_reporting().decodedCall,
      });
      await this.transactions.submitIntermediate(
        "End reporting for registered no-show",
        call,
        this.authority.signer,
        new SudoDispatchValidator(async (error, receipt) => {
          const at = { at: receipt.block.hash };
          const [game, events] = await Promise.all([
            api.query.Game.Game.getValue(at),
            api.query.System.Events.getValue(at),
          ]);
          const ended = events.flatMap(({ event }) =>
            event.type === "Game" && event.value.type === "GameEnded"
              ? [event.value.value.index]
              : [],
          );
          return reportingAlreadyCompleted(error, game, gameIndex, ended);
        }),
      );
    }
    // No game or app checkpoint can accept merely best-block state. In particular,
    // an old finalized "no game" value must not satisfy completion before our calls.
    await this.transactions.finalizePending();
    await this.chain.waitFor("Completed game processing", async (at) =>
      (await api.query.Game.Game.getValue(at)) === undefined ? true : undefined,
    );
  }
}
