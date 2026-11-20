// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { beforeEach, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { BlockNotPinnedError } from 'polkadot-api';
import { decAnyMetadata, unifyMetadata } from '@polkadot-api/substrate-bindings';
import { getDynamicBuilder, getLookupFn } from '@polkadot-api/metadata-builders';
import { Sr25519KeyDerivation } from '@parity/product-lab/keys-sr25519';
import { TransactionExecutor, type Receipt } from '@parity/product-lab/chain';
import { SudoDispatchValidator } from '../../../../lab/shared/upstream/lab/chain/sudo.ts';
import { ScenarioChain, memberGameSeconds } from '../../../../lab/shared/chain.ts';
import { setupMode, SETUP_VARIABLE, isUnpinned, retryUnpinned, unpinnedTolerant } from '../../../../lab/shared/setup-mode.ts';
import { fundingPlan, fundingHeadroom, drainPlan, memberMarks, drawPlan, drawWindows, prizeSource, rootBatch, scoreRecord, gameParticipant, thresholdPlan, call } from '../../../../lab/shared/chain-plan.ts';
import { jsonEvidence } from '../../../../lab/shared/observations.ts';
import type { GamesPeopleConnection } from '../../../../lab/shared/upstream/lab/steps/games/chain.ts';
import { clearImportedGames, type ImportedGamesTarget } from '../../../../lab/shared/upstream/lab/steps/humanity/bootstrap/imported-games.ts';

vi.mock('../../../../lab/shared/upstream/lab/steps/humanity/bootstrap/imported-games.ts', async importOriginal => ({
  ...await importOriginal<object>(), clearImportedGames: vi.fn(async () => ({ sequential: true })),
}));
const root = new Sr25519KeyDerivation().derive('//Alice');
const metadata = unifyMetadata(decAnyMetadata(gunzipSync(readFileSync(new URL('../flow/fixtures/people-3004000.metadata16.scale.gz', import.meta.url)))));
const codec = getDynamicBuilder(getLookupFn(metadata)).buildCall('Sudo', 'sudo').codec;
const target = { offer: { local: true }, endpoints: { people: 'ws://127.0.0.1:27010' }, humanity: { network: { kind: 'owned', session: {
  schemaVersion: 1, mode: 'fork', ownership: 'owned', chains: { people: { ws: 'ws://127.0.0.1:27010' } },
} } } } as unknown as ImportedGamesTarget;
const unpinned = () => new BlockNotPinnedError('0xab', 'storage');
const players = [0, 1, 2].map(i => gameParticipant(new Uint8Array(32).fill(i + 1), 'paseo', `P${i}`));
const fresh = { score: 0, attendance_history: 255, streak: { type: 'Attended', value: 0 }, recognition: { type: 'NotRecognized' }, reached_personhood: false };
function receipt(count: number): Receipt {
  return { txHash: 'tx', ok: true, block: { hash: 'h11', number: 11, index: 2 }, events: [
    ...Array.from({ length: count }, () => ({ type: 'Utility', value: { type: 'ItemCompleted' } })),
    { type: 'Utility', value: { type: 'BatchCompleted' } }, { type: 'Sudo', value: { type: 'Sudid', value: { sudo_result: { success: true } } } },
  ] };
}
function fixture(mode: 'fast' | 'full' = 'fast', executor?: TransactionExecutor) {
  const controller = new AbortController();
  const access = { url: target.endpoints!.people, finalizedHead: vi.fn(async () => ({ hash: 'h11', number: 11 })), bestHead: vi.fn(async () => ({ hash: 'b14', number: 14 })),
    blockAt: vi.fn(async (number: number) => ({ hash: `h${number}`, number })),
    historicalStorage: vi.fn(async (_pallet: string, _item: string, _keys: unknown[], _hash: string): Promise<unknown> => undefined) };
  const api = { tx: { Sudo: { sudo: vi.fn((args: unknown) => ({ args })) }, Game: { testnet_force_start_shuffle: () => ({ decodedCall: 'shuffle' }) } },
    query: { Sudo: { Key: { getValue: vi.fn(async () => root.address) } } } };
  const people = { signal: controller.signal, api, access, waitFor: vi.fn() } as unknown as GamesPeopleConnection;
  const sent = (_label: string, tx: { args: { call: { value: { value: { calls: unknown[] } } } } }) => receipt(tx.args.call?.value?.value?.calls?.length ?? 0);
  const submit = vi.fn(async (label: string, tx: never) => sent(label, tx)), submitIntermediate = vi.fn(async (label: string, tx: never) => sent(label, tx));
  const tx = executor ?? { submit, submitIntermediate, count: 0, assertHealthy: vi.fn(), finalizePending: vi.fn(async () => undefined) } as unknown as TransactionExecutor;
  const record = vi.fn(), chain = new ScenarioChain(people, tx, root, target, record, mode);
  return { chain, access, api, people, submit, submitIntermediate, tx, record };
}
beforeEach(() => { vi.clearAllMocks(); });

it('selects the setup from HUMANITY_SCENARIOS_SETUP: unset is the nightly full setup, anything unknown is refused', () => {
  // An undefined argument reads the variable, which a CI leg sets: unset it here, then set it.
  vi.stubEnv(SETUP_VARIABLE, undefined);
  try { expect(setupMode(undefined)).toBe('full'); vi.stubEnv(SETUP_VARIABLE, 'fast'); expect(setupMode()).toBe('fast'); } finally { vi.unstubAllEnvs(); }
  expect(setupMode('')).toBe('full'); expect(setupMode('full')).toBe('full'); expect(setupMode('fast')).toBe('fast');
  expect(() => setupMode('Fast')).toThrow(/fast or full/); expect(() => setupMode('true')).toThrow(/fast or full/);
});

it('retries only an unpinned block, within its limit, and never after a submission', async () => {
  expect(isUnpinned(unpinned())).toBe(true); expect(isUnpinned(Error('Block 0xac0046…868a is not pinned (storage)'))).toBe(true);
  expect(isUnpinned(Error('RPC disconnected'))).toBe(false); expect(isUnpinned('is not pinned')).toBe(false);
  const flaky = vi.fn().mockRejectedValueOnce(unpinned()).mockRejectedValueOnce(unpinned()).mockResolvedValue('read');
  expect(await retryUnpinned(flaky, { pauseMs: 0 })).toBe('read'); expect(flaky).toHaveBeenCalledTimes(3);
  // Negative controls: another error, a spent limit, and a retry after the work already submitted all throw.
  const other = Error('RPC disconnected'), failing = vi.fn().mockRejectedValue(other);
  await expect(retryUnpinned(failing)).rejects.toBe(other); expect(failing).toHaveBeenCalledOnce();
  const always = vi.fn().mockRejectedValue(unpinned());
  await expect(retryUnpinned(always, { limit: 2, pauseMs: 0 })).rejects.toBeInstanceOf(BlockNotPinnedError); expect(always).toHaveBeenCalledTimes(3);
  const submitted = vi.fn().mockRejectedValue(unpinned());
  await expect(retryUnpinned(submitted, { retryable: () => false })).rejects.toBeInstanceOf(BlockNotPinnedError); expect(submitted).toHaveBeenCalledOnce();
});

it('@negative-control ends the unpinned pause at once when the run is aborted', async () => {
  const controller = new AbortController(), always = vi.fn().mockRejectedValue(unpinned());
  const retry = retryUnpinned(always, { pauseMs: 1_000, signal: controller.signal }); void retry.catch(() => undefined);
  await vi.waitFor(() => expect(always).toHaveBeenCalledOnce());
  controller.abort();
  const settled = await Promise.race([retry.then(() => 'resolved', (error: unknown) => error), new Promise(resolve => setTimeout(resolve, 200, 'still paused'))]);
  expect(settled).toMatchObject({ name: 'AbortError' }); expect(always).toHaveBeenCalledOnce();
});

it('polls again on the newest head after an unpinned read, and keeps every other property of the connection', async () => {
  const heads = ['h1', 'h2', 'h3', 'h4'];
  const connection = {
    marker: 7, get api() { return this.marker; }, close() { return this.marker; },
    async waitFor<T>(_label: string, read: (at: { at: string }) => Promise<T | undefined>) {
      for (const at of heads) { const value = await read({ at }); if (value !== undefined) return value; }
      throw Error('state did not arrive');
    },
  };
  const tolerant = unpinnedTolerant(connection, 2);
  const seen: string[] = [];
  expect(await tolerant.waitFor('Completed game processing', async ({ at }) => { seen.push(at); if (at !== 'h3') throw unpinned(); return true; })).toBe(true);
  expect(seen).toEqual(['h1', 'h2', 'h3']); expect(tolerant.api).toBe(7); expect(tolerant.close()).toBe(7);
  // Negative controls: an unrelated error is not swallowed, and more unpinned reads in a row than the limit fail.
  await expect(tolerant.waitFor('x', async () => { throw Error('decode failed'); })).rejects.toThrow('decode failed');
  await expect(tolerant.waitFor('x', async () => { throw unpinned(); })).rejects.toBeInstanceOf(BlockNotPinnedError);
  // The untouched connection still fails on the first unpinned read: the A4 failure.
  await expect(connection.waitFor('x', async ({ at }) => { if (at === 'h1') throw unpinned(); return true; })).rejects.toBeInstanceOf(BlockNotPinnedError);
});

it('encodes the drain, funding and member-fixture batches against People spec 3004000', () => {
  const plans = [
    drainPlan({ state: { type: 'Registration' } }, [{ game_play_time: 1_793_900_000 }, { game_play_time: 1_794_500_000 }])!,
    fundingPlan(root.address, 5_000_000_000n, players.map((p, n) => ({ address: p.address, free: BigInt(n) * 10_000_000_000n }))),
    [thresholdPlan(), ...memberMarks(players[0]!.address, 3, 316).calls, call('Game', 'cancel_game')],
    drawPlan(1_793_800_000n, root.address, prizeSource(undefined), drawWindows.fast).calls,
  ];
  for (const calls of plans) {
    const args = rootBatch(calls).value.value;
    expect(jsonEvidence(codec.dec(codec.enc(args)))).toEqual(jsonEvidence(args));
  }
});

it('funds only accounts short of the play deposit plus headroom, by exactly their shortfall', () => {
  const deposit = 5_000_000_000n, minimum = deposit + fundingHeadroom;
  const calls = fundingPlan(root.address, deposit, [{ address: players[0]!.address, free: 0n }, { address: players[1]!.address, free: minimum }, { address: players[2]!.address, free: minimum - 1n }]);
  expect(calls.map(c => (c.value.value as { dest: { value: string }; value: bigint })).map(v => [v.dest.value, v.value]))
    .toEqual([[players[0]!.address, minimum], [players[2]!.address, 1n]]);
  expect(calls.every(c => c.type === 'Balances' && c.value.type === 'force_transfer' && (c.value.value as { source: { value: string } }).source.value === root.address)).toBe(true);
  expect(() => fundingPlan(root.address, deposit, [{ address: 'a', free: 0n }, { address: 'a', free: 0n }])).toThrow(/Invalid/);
});

it('batches the drain only when no schedule can be promoted meanwhile and the game is cancellable', () => {
  const schedules = [{ game_play_time: 10 }, { game_play_time: 20 }];
  expect(drainPlan({ state: { type: 'Registration' } }, schedules)!.map(c => `${c.value.type}:${JSON.stringify(c.value.value ?? null)}`))
    .toEqual(['remove_scheduled_game:{"game_play_time":10}', 'remove_scheduled_game:{"game_play_time":20}', 'cancel_game:null']);
  expect(drainPlan({ state: { type: 'Shuffle' } }, [])!.map(c => c.value.type)).toEqual(['cancel_game']);
  expect(drainPlan(undefined, [])).toEqual([]);
  // Negative controls: the sequential drain keeps these.
  expect(drainPlan(undefined, schedules)).toBeUndefined();
  for (const state of ['Reporting', 'PlayerProcess', 'Cancelling']) expect(drainPlan({ state: { type: state } }, schedules)).toBeUndefined();
});

it('places the member marks just below the fixture game and refuses impossible fixtures', () => {
  const marks = memberMarks(root.address, 2, 316);
  expect(marks.firstIndex).toBe(314);
  expect(marks.calls.map(c => (c.value.value as { game_index: number; attended: boolean })).map(v => [v.game_index, v.attended])).toEqual([[314, true], [315, true]]);
  for (const [attended, index] of [[1, 316], [9, 316], [3, 2], [2.5, 316]] as const) expect(() => memberMarks(root.address, attended, index)).toThrow(/Invalid member fixture/);
});

it('shortens only the fast draw window and refuses an inverted one', () => {
  const full = drawPlan(1000n, root.address, prizeSource(undefined)).info, fast = drawPlan(1000n, root.address, prizeSource(undefined), drawWindows.fast).info;
  expect([full.registration_starts, full.draw_time]).toEqual([1060n, 1240n]);
  expect([fast.registration_starts, fast.draw_time]).toEqual([1015n, 1090n]);
  expect(() => drawPlan(1000n, root.address, prizeSource(undefined), { registration: 90n, draw: 15n })).toThrow(/Invalid draw time/);
});

it('fast setup submits setup batches for inclusion and checkpoints their finality; full setup waits for each', async () => {
  const fast = fixture('fast'), calls = [thresholdPlan()];
  await fast.chain.batch('threshold', calls);
  expect(fast.submitIntermediate).toHaveBeenCalledOnce(); expect(fast.submit).not.toHaveBeenCalled();
  expect(await fast.chain.checkpoint('before "Ada opens peopl at /"')).toMatchObject({ checkpoint: 'before "Ada opens peopl at /"', finalized: { hash: 'h11', number: 11 } });
  expect(fast.tx.finalizePending).toHaveBeenCalledOnce();
  const full = fixture('full');
  await full.chain.batch('threshold', calls);
  expect(full.submit).toHaveBeenCalledOnce(); expect(full.submitIntermediate).not.toHaveBeenCalled();
  expect(await full.chain.checkpoint('x')).toBeUndefined(); expect(full.tx.finalizePending).not.toHaveBeenCalled();
});

const good = receipt(1), failed = (events: Receipt['events']): Receipt => ({ ...good, events });
const sudid = (success: boolean) => ({ type: 'Sudo', value: { type: 'Sudid', value: { sudo_result: { success, value: success ? undefined : { type: 'BadOrigin' } } } } });
it.each([
  ['ItemFailed', failed([{ type: 'Utility', value: { type: 'ItemFailed', value: { error: { type: 'Other' } } } }, { type: 'Utility', value: { type: 'BatchCompleted' } }, sudid(true)])],
  ['BatchInterrupted', failed([{ type: 'Utility', value: { type: 'BatchInterrupted', value: { index: 0 } } }, sudid(true)])],
  ['a failed Sudid', failed([sudid(false)])],
  ['a short ItemCompleted count', failed([{ type: 'Utility', value: { type: 'BatchCompleted' } }, sudid(true)])],
])('@negative-control fails a fast batch at the checkpoint when its finalized receipt shows %s, after a good inclusion', async (_name, finalized) => {
  // product-lab's executor in the fast setup's checkpoint mode, with the People default validator. The inclusion receipt
  // is complete; the finalized one (a re-inclusion after a reorg, say) arrives only after the batch has returned.
  let finalize!: (receipt: Receipt) => void;
  const executor = new TransactionExecutor({ async submit() {
    return { included: Promise.resolve(good), finalized: new Promise<Receipt>(resolve => { finalize = resolve; }) } as never;
  } }, { file: 'transactions.jsonl', record: () => {}, activity: () => {}, message: () => {} } as never,
  { signal: new AbortController().signal, chain: 'people', clock: { now: () => 0 } as never, ordering: false, mode: 'checkpoint', validator: new SudoDispatchValidator() });
  const f = fixture('fast', executor);
  expect(await f.chain.batch('threshold', [thresholdPlan()])).toBe(good);
  finalize(finalized);
  await expect(f.chain.checkpoint('before "Ada opens peopl at /"')).rejects.toThrow(/threshold: Atomic fork setup failed or lacks complete inner dispatch evidence/);
});

it('reads setup state at the best head only in fast setup; assertions stay finalized', async () => {
  const fast = fixture('fast'), full = fixture('full');
  await fast.chain.setupRead('Game', 'Game'); await fast.chain.read('Game', 'Game');
  expect(fast.access.historicalStorage.mock.calls.map(c => c[3])).toEqual(['b14', 'h11']);
  await full.chain.setupRead('Game', 'Game');
  expect(full.access.historicalStorage.mock.calls.map(c => c[3])).toEqual(['h11']); expect(full.access.bestHead).not.toHaveBeenCalled();
});

it('drains the imported game and its schedules in one batch, one checkpoint and a finalized idle check', async () => {
  const f = fixture('fast'); let drained = false;
  f.access.historicalStorage.mockImplementation(async (_pallet, item, _keys, hash) => {
    if (item === 'Game') return hash === 'h11' && drained ? undefined : { index: 314, state: { type: 'Registration' } };
    return hash === 'h11' && drained ? [] : Array.from({ length: 10 }, (_, n) => ({ game_play_time: 1000 + n }));
  });
  const batch = vi.spyOn(f.chain, 'batch').mockImplementation(async (_label, calls) => { drained = true; return receipt(calls.length); });
  const outcome = await f.chain.drainImportedGames();
  expect(batch).toHaveBeenCalledOnce(); expect(batch.mock.calls[0]![1]).toHaveLength(11);
  expect(f.tx.finalizePending).toHaveBeenCalledOnce(); expect(clearImportedGames).not.toHaveBeenCalled();
  expect(outcome.proof).toMatchObject({ removed: 10, cancelled: 314, batched: true });
  // Negative control: with no game, a schedule may be promoted meanwhile, so the sequential drain runs instead.
  const g = fixture('fast');
  g.access.historicalStorage.mockImplementation(async (_pallet, item) => item === 'Game' ? undefined : [{ game_play_time: 1000 }]);
  const none = vi.spyOn(g.chain, 'batch');
  await expect(g.chain.drainImportedGames()).rejects.toThrow(/not idle/);
  expect(none).not.toHaveBeenCalled(); expect(clearImportedGames).toHaveBeenCalledOnce();
  expect(g.record).toHaveBeenCalledWith(expect.objectContaining({ kind: 'imported-games-batch-refused' }));
  // The full setup never batches its drain.
  const h = fixture('full'); h.access.historicalStorage.mockImplementation(async (_pallet, item) => item === 'Game' ? undefined : []);
  const fullBatch = vi.spyOn(h.chain, 'batch'); await h.chain.drainImportedGames();
  expect(fullBatch).not.toHaveBeenCalled(); expect(clearImportedGames).toHaveBeenCalledTimes(2);
});

it('folds the players\' funding and extra root calls into the schedule batch, only in fast setup', async () => {
  const f = fixture('fast'); let created = false;
  vi.spyOn(f.chain, 'drainInOneBatch').mockResolvedValue({ removed: 0, cancelled: null, finalized: { hash: 'h11', number: 11 }, batched: true, checkpoint: undefined });
  f.access.historicalStorage.mockImplementation(async (pallet, item) => pallet === 'Timestamp' ? BigInt(Date.now()) : item === 'GameSchedules' ? [] :
    item === 'PlayDepositAmount' ? 5n : item === 'Account' ? { data: { free: 0n } } : item === 'Game' && created ? { index: 8, game_date: 1900, state: { type: 'Registration' } } : undefined);
  await f.chain.drainImportedGames();
  const batch = vi.spyOn(f.chain, 'batch').mockImplementation(async () => { created = true; return receipt(6); });
  await f.chain.schedule(240, false, players, [thresholdPlan()]);
  expect(batch.mock.calls[0]![1].map(c => `${c.type}.${c.value.type}`)).toEqual(['Score.set_personhood_threshold_schedule', 'Game.set_game_phases', 'Game.schedule_games',
    'Balances.force_transfer', 'Balances.force_transfer', 'Balances.force_transfer']);
  expect(f.chain.current).toEqual({ index: 8, playsAt: 1900, fromBlock: 14 });
  // Negative control: the full setup refuses folded calls before sending anything.
  const g = fixture('full'); vi.spyOn(g.chain, 'read').mockResolvedValue({ at: { hash: 'h11', number: 11 }, value: undefined });
  (g.chain as unknown as { importsDrained: boolean }).importsDrained = true;
  vi.spyOn(g.chain, 'read').mockImplementation(async (pallet, item) => ({ at: { hash: 'h11', number: 11 }, value: pallet === 'Timestamp' ? BigInt(Date.now()) : item === 'GameSchedules' ? [] : undefined }));
  await expect(g.chain.schedule(240, false, players)).rejects.toThrow(/fast setup/); expect(g.submit).not.toHaveBeenCalled();
});

it('sends the reports together in fast setup and one after another in full setup', async () => {
  for (const mode of ['fast', 'full'] as const) {
    const f = fixture(mode); f.chain.current = { index: 7, playsAt: 1900, fromBlock: 10 };
    vi.spyOn(f.chain, 'startReporting').mockResolvedValue(); vi.spyOn(f.chain.games, 'shuffledGroup').mockResolvedValue(players.map(p => p.address));
    vi.spyOn(f.chain.games, 'complete').mockResolvedValue();
    let open = 0, overlap = 0;
    vi.spyOn(f.chain.games, 'reportFrom').mockImplementation(async () => { open++; overlap = Math.max(overlap, open); await new Promise(resolve => setTimeout(resolve, 5)); open--; });
    f.access.historicalStorage.mockResolvedValue([{ event: { type: 'Game', value: { type: 'GameEnded', value: { index: 7 } } }, phase: { type: 'Initialization' } }]);
    vi.spyOn(f.access, 'finalizedHead').mockResolvedValue({ hash: 'h10', number: 10 });
    await f.chain.play(players);
    expect([mode, overlap]).toEqual([mode, mode === 'fast' ? 3 : 1]);
    expect(f.tx.finalizePending).toHaveBeenCalled();
  }
});

it('builds the member fixture from a real sign-up and forced marks, and checks the record it leaves', async () => {
  const f = fixture('fast');
  vi.spyOn(f.chain, 'schedule').mockImplementation(async () => { f.chain.current = { index: 316, playsAt: 1900, fromBlock: 14 }; return {} as never; });
  const enroll = vi.spyOn(f.chain, 'enroll').mockResolvedValue();
  vi.spyOn(f.chain, 'setupRead').mockResolvedValue({ at: { hash: 'b14', number: 14 }, value: fresh });
  const after = scoreRecord({ ...fresh, score: 3, streak: { type: 'Attended', value: 2 }, reached_personhood: true, last_attended_game: 315 });
  const score = vi.spyOn(f.chain, 'score').mockResolvedValue({ at: { hash: 'h11', number: 11 }, value: after });
  vi.spyOn(f.chain, 'read').mockResolvedValue({ at: { hash: 'h11', number: 11 }, value: undefined });
  const batch = vi.spyOn(f.chain, 'batch').mockResolvedValue(receipt(3));
  const proof = await f.chain.memberFixture(players[0]!, players, 2, false);
  expect(f.chain.schedule).toHaveBeenCalledWith(memberGameSeconds, false, players, [thresholdPlan()]);
  expect(enroll).toHaveBeenCalledWith([players[0]], players);
  expect(batch.mock.calls[0]![1].map(c => `${c.value.type}:${(c.value.value as { game_index?: number } | undefined)?.game_index ?? ''}`)).toEqual(['force_set_attendance:314', 'force_set_attendance:315', 'cancel_game:']);
  expect(f.tx.finalizePending).toHaveBeenCalledOnce(); expect(f.chain.current).toBeUndefined();
  expect(proof.memberFixture).toMatchObject({ game: 316, attended: 2, firstIndex: 314, keptGame: false });
  // A4 keeps its game for the real miss, with no cancellation in the batch.
  f.chain.current = undefined; batch.mockClear();
  score.mockResolvedValue({ at: { hash: 'h11', number: 11 }, value: { ...after, score: 6, streak: { type: 'Attended', value: 3 } } });
  await f.chain.memberFixture(players[0]!, players, 3, true);
  expect(batch.mock.calls[0]![1].map(c => c.value.type)).toEqual(['force_set_attendance', 'force_set_attendance', 'force_set_attendance']);
  expect(f.chain.current).toEqual({ index: 316, playsAt: 1900, fromBlock: 14 });
  // Negative controls: a record the marks did not produce, a participant without personhood, and the full setup.
  score.mockResolvedValue({ at: { hash: 'h11', number: 11 }, value: { ...after, streak: { type: 'Attended', value: 1 } } });
  await expect(f.chain.memberFixture(players[0]!, players, 2, false)).rejects.toThrow(/differs from pattern/);
  score.mockResolvedValue({ at: { hash: 'h11', number: 11 }, value: { ...after, reached_personhood: false } });
  await expect(f.chain.memberFixture(players[0]!, players, 2, false)).rejects.toThrow(/did not reach personhood/);
  await expect(fixture('full').chain.memberFixture(players[0]!, players, 2, false)).rejects.toThrow(/fast setup/);
});

it('@negative-control tops up only the players a fast enroll signs up, never one already holding its deposit', async () => {
  const f = fixture('fast'), deposit = 5_000_000_000n, minimum = deposit + fundingHeadroom;
  f.chain.current = { index: 8, playsAt: 1900, fromBlock: 14 };
  // Ada signed up earlier: her deposit is reserved, so her free balance is the headroom alone.
  const free = new Map([[players[0]!.address, fundingHeadroom], [players[1]!.address, minimum], [players[2]!.address, minimum]]);
  f.access.historicalStorage.mockImplementation(async (_pallet, item, keys) => item === 'PlayDepositAmount' ? deposit :
    item === 'Account' ? { data: { free: free.get(keys[0] as string) } } : item === 'Players' ? { registered: true } : undefined);
  const batch = vi.spyOn(f.chain, 'batch').mockResolvedValue(receipt(1)), enroll = vi.spyOn(f.chain.games, 'enroll').mockResolvedValue(undefined as never);
  await f.chain.enroll([players[1]!, players[2]!], players);
  expect(enroll).toHaveBeenCalledWith([players[1], players[2]]); expect(batch).not.toHaveBeenCalled();
  // A bot still short gets its one root batch, for its shortfall only.
  free.set(players[2]!.address, minimum - 1n);
  await f.chain.enroll([players[1]!, players[2]!], players);
  expect(batch.mock.calls.map(c => c[1].map(t => [(t.value.value as { dest: { value: string } }).dest.value, (t.value.value as { value: bigint }).value]))).toEqual([[[players[2]!.address, 1n]]]);
});

it('lists the players still unregistered for the current game at the setup head', async () => {
  const f = fixture('fast');
  f.access.historicalStorage.mockImplementation(async (_pallet, _item, keys) => (keys[0] as { value: string }).value === players[0]!.address ? { registered: true } : { registered: false });
  expect(await f.chain.unregistered(players)).toEqual([players[1], players[2]]);
  expect(f.access.historicalStorage.mock.calls.every(c => c[3] === 'b14')).toBe(true);
});

it('finishes a validated sequential promotion handoff with one cleanup batch and finalized idle proof', async () => {
  const f = fixture('fast'); let promoted = false, drained = false;
  f.access.historicalStorage.mockImplementation(async (_pallet, item) => item === 'Game'
    ? promoted && !drained ? { index: 315, state: { type: 'Registration' } } : undefined
    : drained ? [] : [{ game_play_time: 1000 }]);
  vi.mocked(clearImportedGames).mockImplementationOnce(async () => { promoted = true; return { promoted: 315 } as never; });
  const batch = vi.spyOn(f.chain, 'batch').mockImplementation(async (_label, calls) => { drained = true; return receipt(calls.length); });
  const proof = await f.chain.drainImportedGames();
  expect(batch).toHaveBeenCalledOnce();
  expect(batch.mock.calls[0]![1].map(c => c.value.type)).toEqual(['remove_scheduled_game', 'cancel_game']);
  expect(proof.proof).toMatchObject({ handoff: { promoted: 315 }, cancellation: { cancelled: 315, batched: true } });
});
