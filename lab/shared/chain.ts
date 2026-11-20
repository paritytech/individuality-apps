// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { setTimeout as delay } from 'node:timers/promises';
import type { SecretSigner } from '@parity/product-lab';
import type { TransactionExecutor } from '@parity/product-lab/chain';
import type { GameParticipant } from './upstream/lab/steps/games/participant.ts';
import type { GamesPeopleConnection } from './upstream/lab/steps/games/chain.ts';
import { GameRepository, scheduleNow } from './upstream/lab/steps/games/attendance/game.repository.ts';
import { assertSetupReceipt, type Call } from './upstream/lab/steps/games/fork-setup-plan.ts';
import { clearImportedGames, importedGameWaitMs, requireOwnedGameFork, type ImportedGamesTarget } from './upstream/lab/steps/humanity/bootstrap/imported-games.ts';
import { ImportedGameNotRun, isImportedGameDrainRefusal } from './imported-game-admission.ts';
import { requireScenarioTarget } from './target.ts';
import { call } from './chain-plan.ts';
import { accountKey } from './upstream/lab/full-journey/identity.ts';
import { flowStorage } from './storage.ts';
import { SudoDispatchValidator, verifySudoKey } from './upstream/lab/chain/sudo.ts';
import { ringCollectionId } from '@parity/product-sdk/individuality';
import { toHex } from 'polkadot-api/utils';
import { rootBatch, gamePlan, scoreRecord, forcedAttendance, assertAttendance, gracePlan, drawPlan, drawWindows, prizeSource, peopleDrawId, prizeAsset, assertPrizeClaim, assertClaimExtrinsic, fundingPlan, drainPlan, memberMarks, thresholdPlan } from './chain-plan.ts';
import { retryUnpinned, unpinnedTolerant, type SetupMode } from './setup-mode.ts';
import type { Receipt, ReceiptValidator } from '@parity/product-lab/chain';

/** The member fixture's game stays in Registration through Ada's recognition, and A4's grace step, until its real miss. */
export const memberGameSeconds = 600;
export interface ScheduledGame { index: number; playsAt: number; fromBlock: number }
export class ScenarioChain {
  readonly games: GameRepository;
  current?: ScheduledGame;
  ended?: ScheduledGame;
  next?: { game_play_time: number; finalizedAtMs: number };
  private importsDrained = false;
  draw?: { id: string; fromBlock: number; destination: string; balanceBefore: bigint };
  constructor(readonly people: GamesPeopleConnection, readonly transactions: TransactionExecutor,
    readonly authority: SecretSigner, readonly target: ImportedGamesTarget, readonly record: (value: unknown) => void,
    readonly mode: SetupMode = 'full') {
    // The repository's polled waits read through polkadot-api at an RPC finalized hash; retry an unpinned one.
    this.games = new GameRepository(unpinnedTolerant(people), transactions, authority);
  }
  get fast() { return this.mode === 'fast'; }
  /** Assertions and app-facing reads: always the finalized head. */
  async read(pallet: string, item: string, keys: unknown[] = []) {
    const at = await this.people.access.finalizedHead();
    return { at, value: await flowStorage(this.people.access, pallet, item, keys, at.hash) };
  }
  /** The lab's own reads between setup rounds: the best head in fast mode, where those rounds wait only for inclusion. */
  async setupRead(pallet: string, item: string, keys: unknown[] = []) {
    if (!this.fast) return this.read(pallet, item, keys);
    const at = await this.people.access.bestHead();
    return { at, value: await flowStorage(this.people.access, pallet, item, keys, at.hash) };
  }
  /** A lab setup transaction: finalized in full mode, included in fast mode (its finality is awaited at the checkpoint). */
  submitSetup(label: string, call: Parameters<TransactionExecutor['submit']>[1], signer: SecretSigner['signer'], validator?: ReceiptValidator): Promise<Receipt> {
    return this.fast ? this.transactions.submitIntermediate(label, call, signer, validator) : this.transactions.submit(label, call, signer, validator);
  }
  /**
   * Fast mode's finality checkpoint: every setup transaction sent so far is finalized before the app is asked to show
   * its result. Full mode has nothing pending. A transaction lost with an inclusion-only block fails here.
   */
  async checkpoint(label: string) {
    if (!this.fast) return undefined;
    const started = Date.now();
    await this.transactions.finalizePending();
    const proof = { checkpoint: label, finalized: await this.people.access.finalizedHead(), waitedMs: Date.now() - started };
    this.record(proof); return proof;
  }
  async until<T>(label: string, read: () => Promise<T | undefined>, ms = 180_000): Promise<T> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      this.people.signal.throwIfAborted(); this.transactions.assertHealthy();
      const value = await read(); if (value !== undefined) return value;
      await delay(500, undefined, { signal: this.people.signal });
    }
    throw Error(`Timed out: ${label}`);
  }
  async batch(label: string, calls: Call[]) {
    requireScenarioTarget(this.target);
    const authority = await verifySudoKey(this.people.api, this.authority.address);
    if (authority !== true) throw Error(authority);
    // The executor validates both the inclusion and the finalized receipt, so a batch re-included after a reorg that then
    // fails inside sudo still fails at the checkpoint.
    const complete: ReceiptValidator = {
      async validate(receipt) {
        try { assertSetupReceipt(receipt, calls.length); return { ok: true }; }
        catch (error) { return { ok: false, reason: error instanceof Error ? error.message : String(error) }; }
      },
    };
    const receipt = await this.submitSetup(label, this.people.api.tx.Sudo.sudo(rootBatch(calls).value.value), this.authority.signer, complete);
    assertSetupReceipt(receipt, calls.length); this.record({ label, at: receipt.block, calls: calls.map(c => `${c.type}.${c.value.type}`) }); return receipt;
  }
  async clearLocalGames() {
    if (requireScenarioTarget(this.target) !== 'genesis') throw Error('Local game cleanup requires genesis ownership');
    const game = (await this.read('Game', 'Game')).value as { state: { type: string } } | undefined;
    const schedules = (await this.read('Game', 'GameSchedules')).value as Array<{ game_play_time: number }>;
    if (game && !['Registration', 'Shuffle'].includes(game.state.type)) throw Error('Previous local game is still processing; no cancellation sent');
    const calls = schedules.map(schedule => call('Game', 'remove_scheduled_game', { game_play_time: schedule.game_play_time }));
    if (game) calls.push(call('Game', 'cancel_game'));
    if (calls.length) await this.batch('Clear previous scenario game', calls);
    await this.until('local cancellation drained', async () => (await this.read('Game', 'Game')).value === undefined ? true : undefined);
  }
  /** Separate admission step: never spend a gameplay step's budget waiting for imported state. */
  async drainImportedGames() {
    this.importsDrained = false;
    const mode = requireScenarioTarget(this.target);
    let waitMs: number | undefined;
    try { waitMs = importedGameWaitMs(process.env.HUMANITY_SCENARIOS_IMPORTED_GAME_WAIT_MS ?? '180000'); }
    catch (error) {
      if (error instanceof Error && error.message === 'Invalid HUMANITY_FLOW_IMPORTED_GAME_WAIT_MS') throw Error('Invalid HUMANITY_SCENARIOS_IMPORTED_GAME_WAIT_MS');
      throw error;
    }
    let proof: unknown;
    try {
      if (mode === 'fork') proof = (this.fast ? await this.drainInOneBatch() : undefined) ?? await clearImportedGames({ target: this.target, chain: this.people, root: this.authority,
        transactions: this.transactions, record: this.record, waitMs });
      else await this.clearLocalGames();
      // A runtime promotion is validated by the drain against its snapshotted schedule and empty Registration row.
      // Remove the remaining schedules before cancelling it, so no next schedule can race that cancellation.
      if (proof && typeof proof === 'object' && 'promoted' in proof) {
        const cancellation = await this.drainInOneBatch();
        if (!cancellation) throw new ImportedGameNotRun('Validated imported promotion is no longer cancellable');
        proof = { handoff: proof, cancellation };
      }
      const game = await this.read('Game', 'Game'), schedules = await this.read('Game', 'GameSchedules');
      if (game.value !== undefined || (schedules.value as unknown[]).length) throw new ImportedGameNotRun('Imported DIM2 cleanup is incomplete: chain is not idle after its handoff');
      this.importsDrained = true;
      return { mode, waitMs, proof, game, schedules };
    } catch (error) {
      if (this.people.signal.aborted) throw error;
      if (error instanceof ImportedGameNotRun) throw error;
      if (error instanceof Error && isImportedGameDrainRefusal(error)) throw new ImportedGameNotRun(error.message, { cause: error });
      throw error;
    }
  }
  /**
   * Fast mode: every imported schedule and the imported game in one root batch, included, then the one finality
   * checkpoint and the finalized idle state. Undefined hands the drain to the sequential path (no game, so a schedule
   * may be promoted meanwhile, or a game past Shuffle).
   */
  async drainInOneBatch() {
    requireOwnedGameFork(this.target);
    const game = await this.setupRead('Game', 'Game'), schedules = await this.setupRead('Game', 'GameSchedules');
    const imported = game.value as { index: number; state: { type: string } } | undefined;
    const calls = drainPlan(imported, schedules.value as Array<{ game_play_time: number }>);
    if (!calls) { this.record({ kind: 'imported-games-batch-refused', game: imported, at: game.at }); return undefined; }
    if (calls.length) await this.batch(`Drain imported DIM2 games (${calls.length - 1} schedules, game #${imported!.index}) in one root batch`, calls);
    const checkpoint = await this.checkpoint('imported games drained');
    const idle = await this.until('finalized idle chain after the imported-game batch', async () => {
      const [after, left] = [await this.read('Game', 'Game'), await this.read('Game', 'GameSchedules')];
      return after.value === undefined && !(left.value as unknown[]).length ? after.at : undefined;
    });
    const outcome = { removed: Math.max(0, calls.length - 1), cancelled: imported?.index ?? null, finalized: idle, batched: true, checkpoint };
    this.record({ kind: 'imported-games-cleared', ...outcome }); return outcome;
  }
  /** Fast mode: root transfers topping each account up to the play deposit plus fee headroom, for a schedule's batch. */
  async fundingCalls(accounts: ReadonlyArray<{ address: string }>) {
    const deposit = BigInt((await this.setupRead('Game', 'PlayDepositAmount')).value as bigint);
    const balances = await Promise.all(accounts.map(async a => ({ address: a.address,
      free: ((await this.setupRead('System', 'Account', [a.address])).value as { data?: { free?: bigint } } | undefined)?.data?.free ?? 0n })));
    return fundingPlan(this.authority.address, deposit, balances);
  }
  /** `fund` (fast mode only) folds those accounts' funding into the schedule's batch; `extra` adds root calls to it. */
  async schedule(playsIn: number, future = false, fund: readonly GameParticipant[] = [], extra: Call[] = []) {
    requireScenarioTarget(this.target);
    if (!this.importsDrained) throw Error('Run the dedicated imported-game drain step before scheduling');
    const game = await this.read('Game', 'Game'), schedules = await this.read('Game', 'GameSchedules');
    if (game.value !== undefined || (schedules.value as unknown[]).length) throw Error('Scenario scheduling requires an idle chain; imported waits belong to the first step');
    const now = scheduleNow(Number((await this.read('Timestamp', 'Now')).value), Date.now());
    const plan = gamePlan(now, playsIn, !future);
    if ((fund.length || extra.length) && !this.fast) throw Error('Folded funding and setup calls belong to the fast setup');
    const funding = fund.length ? await this.fundingCalls(fund) : [];
    const receipt = await this.batch('Schedule Humanity scenario game', [...extra, ...plan.calls, ...funding]);
    // The app shows the next game from finalized state, so its time is counted from the schedule's finality.
    if (future) await this.checkpoint('next game scheduled');
    const finalizedAtMs = Date.now();
    if (future) { this.next = { ...plan.schedule, finalizedAtMs }; return { ...plan, finalizedAtMs, finalized: receipt.block }; }
    this.current = await this.until(this.fast ? 'game Registration' : 'finalized game Registration', async () => {
      const read = await this.setupRead('Game', 'Game');
      const game = read.value as { index: number; state: { type: string }; game_date: number } | undefined;
      if (!game || game.state.type !== 'Registration') return undefined;
      return { index: game.index, playsAt: game.game_date, fromBlock: read.at.number };
    });
    this.next = undefined;
    return { ...plan, game: this.current };
  }
  /** `funding` is the full setup's funded group; the fast setup checks only the players it enrolls. */
  async enroll(players: readonly GameParticipant[], funding = players) {
    if (!this.current) throw Error('No scenario game');
    // The deposit route is deliberate. Lab minting of attendance never stands in for A3 gameplay.
    if (this.fast) {
      // Normally folded into the schedule's batch already; an account still short gets one more root batch. A player
      // who already signed up holds the deposit and sits below deposit plus headroom, so it is never topped up again.
      const calls = await this.fundingCalls(players);
      if (calls.length) await this.batch('Fund the scenario game accounts', calls);
    } else await retryUnpinned(() => this.games.fundLocalGameAccounts(funding.map(p => ({ name: p.name, address: p.address }))), { signal: this.people.signal });
    await this.games.enroll(players);
    if (!this.fast) await this.transactions.finalizePending();
    for (const p of players) await this.until(`${p.name} ${this.fast ? '' : 'finalized '}Game.Players`, async () => {
      const read = await this.setupRead('Game', 'Players', [{ type: 'Account', value: p.address }]);
      return (read.value as { registered?: boolean } | undefined)?.registered === true ? read : undefined;
    });
  }
  /** The players not yet registered for the current game, at the setup head. */
  async unregistered(players: readonly GameParticipant[]) {
    const reads = await Promise.all(players.map(p => this.setupRead('Game', 'Players', [{ type: 'Account', value: p.address }])));
    return players.filter((_, n) => (reads[n]!.value as { registered?: boolean } | undefined)?.registered !== true);
  }
  async score(account: string) { const read = await this.read('Score', 'Participants', [{ type: 'Account', value: account }]); return { ...read, value: scoreRecord(read.value) }; }
  async startReporting(index: number, players: readonly GameParticipant[]) {
    requireScenarioTarget(this.target);
    const reporting = async (at: { hash: string }) => {
      const game = await flowStorage(this.people.access, 'Game', 'Game', [], at.hash) as
        { index: number; state: { type: string; value?: { player_count?: number } } } | undefined;
      if (game?.index !== index || game.state.type !== 'Reporting') return false;
      if (players.length !== 3 || new Set(players.map(p => accountKey(p.address))).size !== 3 || game.state.value?.player_count !== players.length) throw Error('Reporting game has the wrong player count');
      const group = await Promise.all(players.map((_, n) => flowStorage(this.people.access, 'Game', 'IndexToPlayer', [[0, n]], at.hash))) as Array<{ type?: string; value?: string } | undefined>;
      const addresses = group.map(p => p?.type === 'Account' && p.value ? accountKey(p.value) : undefined);
      if (new Set(addresses).size !== players.length || players.some(p => !addresses.includes(accountKey(p.address)))) throw Error('Reporting game has the wrong players');
      this.record({ reporting: { at, index, players: addresses } });
      return true;
    };
    const before = await this.setupRead('Game', 'Game');
    const game = before.value as { index: number; state: { type: string } } | undefined;
    if (game?.index !== index || !['Registration', 'Shuffle', 'Reporting'].includes(game.state.type)) throw Error('Unexpected game before scenario reporting');
    if (await reporting(before.at)) return;
    const authority = await verifySudoKey(this.people.api, this.authority.address);
    if (authority !== true) throw Error(authority);
    // The deadline may win after the read. Accept an inner failure only with the right Reporting
    // game and exact three-player group at the dispatch block, then independently await finality.
    await this.submitSetup('Start real shuffle', this.people.api.tx.Sudo.sudo({
      call: this.people.api.tx.Game.testnet_force_start_shuffle().decodedCall,
    }), this.authority.signer, new SudoDispatchValidator(async (_error, receipt) => reporting(receipt.block)));
    await this.until('scenario game Reporting with the right players', async () => {
      const read = await this.setupRead('Game', 'Game');
      const current = read.value as { index: number; state: { type: string } } | undefined;
      if (current?.index !== index || !['Registration', 'Shuffle', 'Reporting'].includes(current.state.type)) throw Error('Unexpected game while waiting for scenario reporting');
      return await reporting(read.at) ? true : undefined;
    });
  }
  async play(players: readonly GameParticipant[], absent?: GameParticipant, afterReporting?: () => Promise<void>) {
    const game = this.current; if (!game) throw Error('No game prepared');
    await this.startReporting(game.index, players);
    const group = await this.games.shuffledGroup(players), reporters = players.filter(p => p !== absent);
    // Fast mode sends the reports together, as upstream's GameRepository.report does; full mode keeps one per round.
    if (this.fast) await Promise.all(reporters.map(player => this.games.reportFrom(player, group, absent ? [absent] : [])));
    else for (const player of reporters) await this.games.reportFrom(player, group, absent ? [absent] : []);
    await this.transactions.finalizePending();
    await afterReporting?.();
    await this.games.complete(Boolean(absent), game.index);
    // Absence of Game alone is insufficient: retain the indexed GameEnded event from finalized blocks.
    const proof = await this.until('indexed GameEnded', () => this.findEvent(game.fromBlock, e => {
      const event = e as { type?: string; value?: { type?: string; value?: { index?: number } } };
      return event.type === 'Game' && event.value?.type === 'GameEnded' && event.value.value?.index === game.index;
    }));
    this.record({ gameEnded: proof }); this.ended = game; this.current = undefined;
    return proof;
  }
  async findEvent(from: number, matches: (event: unknown) => boolean) {
    const head = await this.people.access.finalizedHead();
    for (let number = from; number <= head.number; number++) {
      const at = await this.people.access.blockAt(number); if (!at) throw Error('Missing finalized evidence block');
      const events = await this.people.access.historicalStorage('System', 'Events', [], at.hash) as Array<{ event: unknown; phase: { type: string; value?: number } }>;
      const found = events.filter(e => matches(e.event));
      if (found.length) return { at, events: found.map(e => e.event), phases: found.map(e => e.phase), allEvents: events };
    }
    return undefined;
  }
  async grace(misses: number, window: number) { return this.batch('Set scenario absence grace', [gracePlan(misses, window)]); }
  async attendance(account: string, pattern: string) {
    const before = await this.score(account);
    const next = Number((await this.read('Game', 'GameIndex')).value);
    const first = Math.max(next, (before.value.last_attended_game ?? 0) + 1);
    // Every call opens/closes its own Score report session. Submit sequentially so ring mutations settle.
    for (const call of forcedAttendance(account, pattern, first)) await this.batch('Set scenario attendance', [call]);
    await this.checkpoint('forced attendance');
    const after = await this.score(account); assertAttendance(before.value, after.value, pattern, first);
    this.record({ attendance: { before, after, pattern, firstIndex: first } }); return { before, after, firstIndex: first, pattern };
  }
  /**
   * Fast mode's member (efficiency study (a)): one root batch (threshold, phases, a game open for registration, the
   * players' funding), Ada's real sign-up, which creates her Score record as production does, then one root batch of
   * forced attended marks below that game's index. Ada is not yet recognised, so the batched marks touch no ring. The
   * app's own Score.register and the ring inclusion stay real. A4 keeps the game for its real miss; otherwise the
   * same batch cancels it, so it never plays with Ada alone.
   */
  async memberFixture(ada: GameParticipant, players: readonly GameParticipant[], attended: number, keepGame: boolean) {
    if (!this.fast) throw Error('The member fixture belongs to the fast setup');
    await this.schedule(memberGameSeconds, false, players, [thresholdPlan()]);
    await this.enroll([ada], players);
    const game = this.current!;
    const before = await this.setupRead('Score', 'Participants', [{ type: 'Account', value: ada.address }]);
    const record = scoreRecord(before.value), marks = memberMarks(ada.address, attended, game.index);
    await this.batch(`Force ${attended} attended games for the member fixture${keepGame ? '' : ' and cancel its game'}`, keepGame ? marks.calls : [...marks.calls, call('Game', 'cancel_game')]);
    const checkpoint = await this.checkpoint('member fixture');
    const after = await this.score(ada.address);
    // The seeding self-check: the record two (or three) real attended games would leave, and personhood reached.
    assertAttendance(record, after.value, 'A'.repeat(attended), marks.firstIndex);
    if (!after.value.reached_personhood || after.value.recognition.type !== 'NotRecognized') throw Error('Member fixture did not reach personhood before the app registers');
    if (!keepGame) {
      this.current = undefined;
      await this.until('member fixture game cancelled', async () => (await this.read('Game', 'Game')).value === undefined ? true : undefined);
    }
    const proof = { memberFixture: { game: game.index, attended, firstIndex: marks.firstIndex, keptGame: keepGame, before: record, after, checkpoint } };
    this.record(proof); return proof;
  }
  async membership(account: string, ms = 600_000) {
    return this.until('included Membership key', async () => {
      const score = await this.score(account);
      if (score.value.recognition.type !== 'Recognized') return undefined;
      const person = await this.read('People', 'People', [score.value.recognition.value]);
      const key = (person.value as { key?: string } | undefined)?.key;
      if (!key) throw Error('Recognized participant has no People key');
      const ring = await this.read('Members', 'Members', [toHex(ringCollectionId('people')), key]);
      return (ring.value as { type?: string } | undefined)?.type === 'Included' ? { score, person, ring } : undefined;
    }, ms);
  }
  async prepareDraw(destination: string) {
    if ((await this.read('Assets', 'Asset', [prizeAsset])).value) throw Error('Scenario prize asset already exists; use a clean copy');
    const parameter = await this.read('Parameters', 'Parameters', [{ type: 'PeopleAirdrops', value: { type: 'PrizeSource', value: undefined } }]);
    const source = prizeSource(parameter.value);
    const now = BigInt(scheduleNow(Number((await this.read('Timestamp', 'Now')).value), Date.now()));
    const index = BigInt((await this.read('PeopleAirdrops', 'NextDrawIndex')).value as bigint);
    const plan = drawPlan(now, this.authority.address, source, drawWindows[this.mode]);
    const receipt = await this.batch('Fund and schedule daily dollar', plan.calls);
    await this.checkpoint('daily draw scheduled');
    const id = peopleDrawId(index);
    const before = await this.read('Assets', 'Account', [prizeAsset, destination]);
    this.draw = { id, fromBlock: receipt.block.number, destination, balanceBefore: (before.value as { balance?: bigint } | undefined)?.balance ?? 0n };
    const event = await this.read('Airdrop', 'Events', [id]), salt = await this.read('PeopleAirdrops', 'DrawSalts', [id]);
    if (!event.value || !salt.value) throw Error('Scheduled daily draw or salt missing at finality');
    this.record({ dailyDraw: { ...this.draw, source, parameter, info: plan.info, event, salt } }); return this.draw;
  }
  async claim() {
    const draw = this.draw; if (!draw) throw Error('No daily draw');
    return this.until('finalized Airdrop.PrizeClaimed', async () => {
      const proof = await this.findEvent(draw.fromBlock, e => {
        const event = e as { type?: string; value?: { type?: string; value?: { event_id?: string } } };
        return event.type === 'Airdrop' && event.value?.type === 'PrizeClaimed' && event.value.value?.event_id === draw.id;
      });
      if (!proof) return undefined;
      const phase = proof.phases[0];
      if (phase?.type !== 'ApplyExtrinsic' || phase.value === undefined) throw Error('PrizeClaimed has no extrinsic phase');
      const extrinsics = await this.people.access.extrinsics(proof.at.hash, { includeCallArguments: true });
      const extrinsic = extrinsics?.find(e => e.index === phase.value);
      if (!extrinsic) throw Error('Finalized claim extrinsic missing');
      assertClaimExtrinsic(extrinsic, draw.id, draw.destination);
      const success = proof.allEvents.some(e => e.phase.type === 'ApplyExtrinsic' && e.phase.value === phase.value &&
        (e.event as { type: string; value: { type: string } }).type === 'System' && (e.event as { value: { type: string } }).value.type === 'ExtrinsicSuccess');
      if (!success) throw Error('Finalized claim has no System.ExtrinsicSuccess');
      return { at: proof.at, extrinsic, prize: assertPrizeClaim(proof.events, draw.id, draw.destination) };
    }, 600_000);
  }
}
