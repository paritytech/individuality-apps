// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// Synthetic block hooks and real executor/validator; no connection, fork, signing or wall-clock wait.
import { it, expect } from 'vitest';
import { TransactionExecutor, type Receipt } from '@parity/product-lab/chain';
import { prepareOwnedGameBatch } from '../../../../lab/shared/upstream/lab/steps/games/fork-setup.ts';
import { planForkCleanup, planForkSetup, visiblePhases, type Call, type SetupState } from '../../../../lab/shared/upstream/lab/steps/games/fork-setup-plan.ts';
import { SudoDispatchValidator } from '../../../../lab/shared/upstream/lab/chain/sudo.ts';

const alice = '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY';
const source = '5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty';
const endpoint = 'ws://127.0.0.1:27010';
const promotedDate = 1793800800;
type Game = NonNullable<SetupState['game']> & { game_date: number; report_ends: number };
const initialGame: Game = { index: 308, game_date: promotedDate, report_ends: promotedDate + 3600,
  pending_attendance: 0, state: { type: 'Registration', value: { next_player_index: 0 } } };
const moduleError = (type: string) => ({ type: 'Module', value: { type: 'Game', value: { type } } });
function fixture(mode: 'normal' | 'stuck' | 'replacement' | 'new-schedules' | 'inner-failure' | 'outer-failure' | 'configured-phases' = 'normal', hasGame = true) {
  let now = 0, cleanupSubmitted = false, drained = false;
  let game: Game | undefined = hasGame ? structuredClone(initialGame) : undefined;
  let schedules: Array<{ game_play_time: number; rounds?: number; max_group_size?: number; airdrops?: unknown[] }> = Array.from({ length: 11 }, (_, i) => ({ game_play_time: promotedDate + (i + 1) * 3600 }));
  let phases: typeof visiblePhases | undefined = mode === 'configured-phases' ? visiblePhases : undefined;
  let asset: { owner: string; min_balance: bigint; supply: bigint } | undefined;
  let enabled = false;
  const callsByBatch: Call[][] = [], attachments: unknown[] = [], journal: unknown[] = [], failures: Array<{ item: number; call: string; error: string }> = [];
  const controller = new AbortController();
  const target = { offer: { local: true }, endpoints: { people: endpoint }, humanity: { network: { kind: 'owned', session: { schemaVersion: 1, mode: 'fork', ownership: 'owned', chains: { people: { ws: endpoint } } } } } };
  const clock = { now: () => now, date: () => new Date(1793794440000 + now), sleep: async (ms: number, signal: AbortSignal) => {
    signal.throwIfAborted(); now += ms;
    if (cleanupSubmitted && mode !== 'stuck' && now >= 2000) {
      game = mode === 'replacement' ? { ...initialGame, index: 309 } : undefined; drained = true;
      if (mode === 'new-schedules') schedules = [{ game_play_time: promotedDate + 99999 }];
    }
  } };
  const storage = async (pallet: string, item: string, _keys: unknown[], at: string) => {
    expect(at).toBe(`h${now}-${callsByBatch.length}`);
    if (pallet === 'Sudo') return alice;
    if (item === 'Now') return 1793794440000n + BigInt(now);
    if (item === 'Game') return game;
    if (item === 'GameSchedules') return schedules;
    if (item === 'StoredPhaseDurations') return phases;
    if (item === 'Asset') return asset;
    if (item === 'SupportedAssets') return enabled;
    if (item === 'Account') return undefined;
    throw Error('Unexpected storage');
  };
  // Model the pinned pallet's relevant dispatch rules. batch_all rolls back all earlier items on error.
  // cancel_game (1782-1795) always stores Cancelling; set_game_phases (1759-1773) rejects that state.
  function dispatch(calls: Call[]): Receipt {
    const saved = structuredClone({ game, schedules, phases, asset, enabled });
    const events: Receipt['events'][number][] = [];
    let error: ReturnType<typeof moduleError> | undefined;
    for (let i = 0; i < calls.length; i++) {
      const c = calls[i], name = c.value.type, args = c.value.value;
      let failed: string | undefined;
      if (c.type === 'Game' && name === 'remove_scheduled_game') {
        if (!schedules.some(s => s.game_play_time === args.game_play_time)) failed = 'NoSuchGameScheduled';
        else schedules = schedules.filter(s => s.game_play_time !== args.game_play_time);
      } else if (c.type === 'Game' && name === 'cancel_game') {
        if (!game) failed = 'NoGame';
        else if (!['Registration', 'Shuffle'].includes(game.state.type)) failed = 'InvalidGameState';
        else game = { ...game, state: { type: 'Cancelling' } };
      } else if (c.type === 'Game' && name === 'set_game_phases') {
        if (game && game.state.type !== 'Registration') failed = 'InvalidGameState';
        else phases = args.phases;
      } else if (c.type === 'Game' && name === 'schedule_games') {
        const date = args.games_schedules[0].game_play_time;
        if (game && date - visiblePhases.registration - visiblePhases.shuffle < game.report_ends + visiblePhases.player_process) failed = 'InvalidGameSetup';
        else schedules.push(...args.games_schedules);
      } else if (c.type === 'Assets' && name === 'force_create') {
        asset = { owner: alice, min_balance: 1n, supply: 0n };
      } else if (c.type === 'Utility' && name === 'dispatch_as_fallible') {
        if (!asset) throw Error('Missing synthetic asset');
        asset.supply += BigInt(args.call.value.value.amount);
      } else if (c.type === 'Airdrop' && name === 'enable_asset') enabled = true;
      else throw Error(`Unexpected batch item ${c.type}.${name}`);
      if (failed) {
        error = moduleError(failed); failures.push({ item: i + 1, call: `${c.type}.${name}`, error: `Game.${failed}` }); break;
      }
      events.push({ type: 'Utility', value: { type: 'ItemCompleted' } });
    }
    if (error) {
      ({ game, schedules, phases, asset, enabled } = saved); events.length = 0;
    } else {
      events.push({ type: 'Utility', value: { type: 'BatchCompleted' } });
      if (calls.some(c => c.value.type === 'cancel_game')) cleanupSubmitted = true;
    }
    events.push({ type: 'Sudo', value: { type: 'Sudid', value: { sudo_result: { success: !error, value: error } } } });
    return { ok: true, txHash: '0x01', block: { hash: '0x02', number: 2645518, index: 0 }, events };
  }
  const executor = new TransactionExecutor({ async submit(request) {
    const call = request.call as unknown as { decodedCall: { call: Call } };
    const calls = call.decodedCall.call.value.value.calls as Call[];
    callsByBatch.push(calls);
    let receipt = dispatch(calls);
    if (mode === 'inner-failure') receipt = { ...receipt, events: [{ type: 'Sudo', value: { type: 'Sudid', value: { sudo_result: { success: false, value: moduleError('InvalidGameState') } } } }] };
    if (mode === 'outer-failure') receipt = { ...receipt, ok: false, dispatchError: moduleError('NoSuchGameScheduled') };
    return { included: Promise.resolve(receipt), finalized: Promise.resolve(receipt) } as never;
  } }, { file: 'deleted-run/transactions.jsonl', record: e => journal.push(e), activity: () => {}, message: () => {} },
  { signal: controller.signal, chain: 'people', clock, ordering: false, mode: 'finalized', validator: new SudoDispatchValidator() });
  const chain = { signal: controller.signal, clock, api: { constants: { Game: { AirdropSource: async () => source } } }, access: {
    url: endpoint, historicalStorage: storage, finalizedHead: async () => ({ hash: `h${now}-${callsByBatch.length}`, number: 2645517 + now / 1000 + callsByBatch.length }),
    client: { getUnsafeApi: () => ({ tx: { Sudo: { sudo: (value: unknown) => ({ decodedCall: value }) } } }) },
  } };
  const invoke = () => prepareOwnedGameBatch(chain as never, executor, { address: alice, signer: { publicKey: new Uint8Array(32) } } as never, target as never, 1200, async proof => { attachments.push(proof); });
  return { invoke, callsByBatch, failures, attachments, journal, dispatch, get game() { return game; }, get schedules() { return schedules; }, get now() { return now; }, get drained() { return drained; } };
}
it('reproduces the old batch inner dispatch failure for promoted empty #308, not the consumed schedule', () => {
  const f = fixture();
  const state: SetupState = { game: initialGame, schedules: f.schedules, enabled: false, ownerBalance: 0n, sourceBalance: 0n };
  const cleanup = planForkCleanup(state), provision = planForkSetup({ ...state, game: undefined, schedules: [] }, alice, source, 1793794440, 1200);
  const receipt = f.dispatch([...cleanup.calls, ...provision.calls]);
  expect(f.failures).toEqual([{ item: 13, call: 'Game.set_game_phases', error: 'Game.InvalidGameState' }]);
  expect(receipt.events).toMatchObject([{ type: 'Sudo', value: { value: { sudo_result: { success: false, value: moduleError('InvalidGameState') } } } }]);
  expect(f.game?.state.type).toBe('Registration'); expect(f.schedules).toHaveLength(11);
  expect(cleanup.calls.some(c => c.value.type === 'remove_scheduled_game' && c.value.value.game_play_time === promotedDate)).toBe(false);
});
it('clears promoted empty #308, waits for finalized absence, then provisions in one atomic batch', async () => {
  const f = fixture(), proof = await f.invoke();
  expect(f.callsByBatch).toHaveLength(2); expect(f.drained).toBe(true); expect(f.now).toBe(2000);
  expect(f.callsByBatch[0].map(c => c.value.type)).toEqual([...Array(11).fill('remove_scheduled_game'), 'cancel_game']);
  expect(f.callsByBatch[1].some(c => c.value.type === 'cancel_game')).toBe(false);
  expect(proof.cleanup).toMatchObject({ elapsedMs: 2000 }); expect(proof.calls).toHaveLength(6);
  expect(f.failures).toEqual([]); expect(f.attachments).toEqual([]);
});
it('@negative-control: moving phase setup before cancel still cannot schedule over the Cancelling game', () => {
  const f = fixture(), state = { game: initialGame, schedules: f.schedules, enabled: false, ownerBalance: 0n, sourceBalance: 0n };
  const cleanup = planForkCleanup(state), setup = planForkSetup({ ...state, game: undefined, schedules: [] }, alice, source, 1793794440, 1200);
  const phases = setup.calls.filter(c => c.value.type === 'set_game_phases'), rest = setup.calls.filter(c => c.value.type !== 'set_game_phases');
  f.dispatch([...phases, ...cleanup.calls, ...rest]);
  expect(f.failures.at(-1)).toMatchObject({ call: 'Game.schedule_games', error: 'Game.InvalidGameSetup' });
});
it.each(['stuck', 'replacement', 'new-schedules'] as const)('@negative-control: %s after cleanup refuses provisioning', async mode => {
  const f = fixture(mode);
  await expect(f.invoke()).rejects.toThrow(mode === 'stuck' ? 'cancellation #308 did not finish within 180000ms' : mode === 'replacement' ? 'unexpected game' : 'left schedules');
  expect(f.callsByBatch).toHaveLength(1);
});
it.each(['inner-failure', 'outer-failure'] as const)('@negative-control: %s retains the private decoded error before cleanup deletes the journal', async mode => {
  const f = fixture(mode), error = mode === 'inner-failure' ? 'Game.InvalidGameState' : 'Game.NoSuchGameScheduled';
  await expect(f.invoke()).rejects.toThrow(`dispatch failed: ${error}`);
  expect(f.attachments).toHaveLength(1); expect(f.attachments[0]).toMatchObject({ dispatchError: error });
  expect(JSON.stringify(f.attachments)).not.toMatch(/deleted-run|transactions.jsonl|signerPublicKey|signedExtrinsic|secret/);
  // The executor journals successful receipts only: error retention must occur in validation, before its throw.
  expect(f.journal.some(e => (e as { type?: string }).type === 'transaction')).toBe(false);
  // This attachment is private; uploaded scenario evidence intentionally omits it.
  expect(f.callsByBatch).toHaveLength(1);
});
it('an idle fork still provisions with one batch and no cancellation wait', async () => {
  const f = fixture('normal', false); await f.invoke(); expect(f.callsByBatch).toHaveLength(1); expect(f.now).toBe(0);
});

it('already configured phases still require a finalized cancellation before scheduling', async () => {
  const f = fixture('configured-phases'); await f.invoke();
  expect(f.callsByBatch).toHaveLength(2); expect(f.drained).toBe(true);
  expect(f.callsByBatch[1].some(c => c.value.type === 'set_game_phases')).toBe(false);
});
