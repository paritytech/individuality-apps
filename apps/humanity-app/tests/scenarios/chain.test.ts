// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { beforeEach, it, expect, vi } from 'vitest';
import { Sr25519KeyDerivation } from '@parity/product-lab/keys-sr25519';
import type { TransactionExecutor, Receipt } from '@parity/product-lab/chain';
import { ImportedGameNotRun } from '../../../../lab/shared/imported-game-admission.ts';
import { ScenarioChain } from '../../../../lab/shared/chain.ts';
import { forcedAttendance, scoreRecord, prizeAsset, dollar, peopleDrawId, gameParticipant } from '../../../../lab/shared/chain-plan.ts';
import type { GamesPeopleConnection } from '../../../../lab/shared/upstream/lab/steps/games/chain.ts';
import { clearImportedGames, type ImportedGamesTarget } from '../../../../lab/shared/upstream/lab/steps/humanity/bootstrap/imported-games.ts';

vi.mock('../../../../lab/shared/upstream/lab/steps/humanity/bootstrap/imported-games.ts', async importOriginal => ({
  ...await importOriginal<object>(), clearImportedGames: vi.fn(async () => undefined),
}));
const root = new Sr25519KeyDerivation().derive('//Alice'), id = peopleDrawId(9n);
const target = { offer: { local: true }, endpoints: { people: 'ws://127.0.0.1:27010' }, humanity: { network: { kind: 'owned', session: {
  schemaVersion: 1, mode: 'fork', ownership: 'owned', chains: { people: { ws: 'ws://127.0.0.1:27010' } },
} } } } as unknown as ImportedGamesTarget;
function receipt(count: number): Receipt {
  return { txHash: 'tx', ok: true, block: { hash: 'h11', number: 11, index: 2 }, events: [
    ...Array.from({ length: count }, () => ({ type: 'Utility', value: { type: 'ItemCompleted' } })),
    { type: 'Utility', value: { type: 'BatchCompleted' } }, { type: 'Sudo', value: { type: 'Sudid', value: { sudo_result: { success: true } } } },
  ] };
}
function fixture() {
  const controller = new AbortController();
  const access = { url: target.endpoints!.people, finalizedHead: vi.fn(async () => ({ hash: 'h11', number: 11 })),
    blockAt: vi.fn(async (number: number) => ({ hash: `h${number}`, number })),
    historicalStorage: vi.fn(async (_pallet: string, _item: string, _keys: unknown[], _hash: string): Promise<unknown> => undefined),
    extrinsics: vi.fn(async () => [{ index: 2, hash: 'tx', decoded: 'complete', call: { pallet: 'PeopleAirdrops', name: 'claim' }, callArguments: { event_id: id, destination: root.address } }]),
  };
  const api = { tx: { Sudo: { sudo: vi.fn((args: unknown) => ({ args })) } }, query: { Sudo: { Key: { getValue: vi.fn(async () => root.address) } } } };
  const people = { signal: controller.signal, api, access } as unknown as GamesPeopleConnection;
  const submit = vi.fn(async (_label: string, tx: { args: { call: { value: { value: { calls: unknown[] } } } } }) => receipt(tx.args.call.value.value.calls.length));
  const tx = { submit, assertHealthy: vi.fn(), finalizePending: vi.fn(async () => undefined) } as unknown as TransactionExecutor;
  const record = vi.fn(), chain = new ScenarioChain(people, tx, root, target, record);
  return { chain, access, api, submit, tx, controller, record };
}
beforeEach(() => { vi.clearAllMocks(); });
it('pins every storage read to the independently acquired finalized hash', async () => {
  const f = fixture(); f.access.historicalStorage.mockResolvedValue(99);
  expect(await f.chain.read('Score', 'Participants', ['who'])).toEqual({ at: { hash: 'h11', number: 11 }, value: 99 });
  expect(f.access.historicalStorage).toHaveBeenCalledWith('Score', 'Participants', ['who'], 'h11', { orDefault: true });
});
it('validates owned-fork admission and Sudo.Key before the atomic root call', async () => {
  const f = fixture(), calls = forcedAttendance(root.address, 'AM', 3);
  await f.chain.batch('attendance', calls);
  expect(f.submit).toHaveBeenCalledOnce();
  expect(f.api.tx.Sudo.sudo).toHaveBeenCalledWith({ call: { type: 'Utility', value: { type: 'batch_all', value: { calls } } } });
  f.api.query.Sudo.Key.getValue.mockResolvedValue(new Sr25519KeyDerivation().derive('//Bob').address);
  await expect(f.chain.batch('wrong authority', calls)).rejects.toThrow(); expect(f.submit).toHaveBeenCalledOnce();
  const unowned = new ScenarioChain(f.chain.people, f.tx, root, { ...target, offer: { local: false, chains: [] } }, f.record);
  await expect(unowned.batch('unowned', calls)).rejects.toThrow(/owned local chain/); expect(f.submit).toHaveBeenCalledOnce();
});
it('drains imports in admission and never repeats that wait inside scheduling', async () => {
  const f = fixture(); let created = false;
  vi.spyOn(f.chain, 'batch').mockImplementation(async () => { created = true; return receipt(2); });
  vi.spyOn(f.chain, 'read').mockImplementation(async (pallet, item) => ({ at: { hash: 'h11', number: 11 }, value:
    pallet === 'Timestamp' ? BigInt(Date.now()) : item === 'GameSchedules' ? [] : item === 'Game' && created ? { index: 8, game_date: 1900, state: { type: 'Registration' } } : undefined }));
  await expect(f.chain.schedule(240)).rejects.toThrow(/dedicated imported-game drain/);
  await f.chain.drainImportedGames(); expect(clearImportedGames).toHaveBeenCalledOnce();
  expect(vi.mocked(clearImportedGames).mock.calls[0]![0].waitMs).toBe(180_000);
  await f.chain.schedule(240);
  expect(f.chain.current).toEqual({ index: 8, playsAt: 1900, fromBlock: 11 });
  f.chain.current = undefined; created = false; await f.chain.schedule(600, true);
  expect(clearImportedGames).toHaveBeenCalledOnce();
  expect(f.chain.next!.game_play_time).toBeGreaterThan(Date.now() / 1000);
  expect(f.chain.next!.finalizedAtMs).toEqual(expect.any(Number)); expect(f.chain.current).toBeUndefined();
});
it('classifies an import refusal as not run and leaves scheduling unadmitted', async () => {
  const f = fixture(); vi.mocked(clearImportedGames).mockRejectedValueOnce(Error('not run: imported game in Reporting'));
  await expect(f.chain.drainImportedGames()).rejects.toThrow(ImportedGameNotRun);
  await expect(f.chain.schedule(240)).rejects.toThrow(/dedicated imported-game drain/);
  expect(f.submit).not.toHaveBeenCalled();
});
it('does not classify unrelated import errors as not run or accept a non-idle handoff', async () => {
  const f = fixture(); const unexpected = Error('RPC disconnected'); vi.mocked(clearImportedGames).mockRejectedValueOnce(unexpected);
  await expect(f.chain.drainImportedGames()).rejects.toBe(unexpected);
  vi.spyOn(f.chain, 'read').mockImplementation(async (_pallet, item) => ({ at: { hash: 'h11', number: 11 }, value: item === 'GameSchedules' ? [] : { state: { type: 'Registration' } } }));
  await expect(f.chain.drainImportedGames()).rejects.toThrow(ImportedGameNotRun);
});
it('funds the three-account deposit group while enrolling only the requested player', async () => {
  const f = fixture(), players = [0, 1, 2].map(i => gameParticipant(new Uint8Array(32).fill(i + 1), 'paseo', `P${i}`));
  f.chain.current = { index: 1, playsAt: 1900, fromBlock: 10 };
  const fund = vi.spyOn(f.chain.games, 'fundLocalGameAccounts').mockResolvedValue(), enroll = vi.spyOn(f.chain.games, 'enroll').mockResolvedValue();
  vi.spyOn(f.chain, 'read').mockResolvedValue({ at: { hash: 'h11', number: 11 }, value: { registered: true } });
  await f.chain.enroll([players[0]!], players);
  expect(fund).toHaveBeenCalledWith(players.map(p => ({ name: p.name, address: p.address })));
  expect(enroll).toHaveBeenCalledWith([players[0]]); expect(f.tx.finalizePending).toHaveBeenCalledOnce();
});
it('plays real reports with a registered no-show and requires indexed GameEnded evidence', async () => {
  const f = fixture(), players = [0, 1, 2].map(i => gameParticipant(new Uint8Array(32).fill(i + 1), 'paseo', `P${i}`));
  f.chain.current = { index: 7, playsAt: 1900, fromBlock: 10 };
  vi.spyOn(f.chain, 'startReporting').mockResolvedValue(); vi.spyOn(f.chain.games, 'shuffledGroup').mockResolvedValue(players.map(p => p.address));
  const report = vi.spyOn(f.chain.games, 'reportFrom').mockResolvedValue(), complete = vi.spyOn(f.chain.games, 'complete').mockResolvedValue();
  const event = { type: 'Game', value: { type: 'GameEnded', value: { index: 7 } } };
  f.access.historicalStorage.mockResolvedValue([{ event, phase: { type: 'Initialization' } }]);
  await f.chain.play(players, players[0]);
  expect(report).toHaveBeenCalledTimes(2); expect(report.mock.calls.every(([p, , absent]) => p !== players[0] && absent?.[0] === players[0])).toBe(true);
  expect(complete).toHaveBeenCalledWith(true, 7); expect(f.chain.current).toBeUndefined(); expect(f.chain.ended!.index).toBe(7);
});
it('decodes score and verifies sequential forced calls against byte, streak and anchor', async () => {
  const f = fixture(), before = scoreRecord({ score: 6, attendance_history: 255, streak: { type: 'Attended', value: 3 }, recognition: { type: 'Recognized', value: 1n }, reached_personhood: true, last_attended_game: 2 });
  vi.spyOn(f.chain, 'read').mockResolvedValue({ at: { hash: 'h11', number: 11 }, value: before });
  expect((await f.chain.score(root.address)).value).toEqual(before);
  vi.spyOn(f.chain, 'score').mockResolvedValueOnce({ at: { hash: 'h10', number: 10 }, value: before }).mockResolvedValueOnce({ at: { hash: 'h11', number: 11 }, value: { ...before, attendance_history: 254, streak: { type: 'Absent', value: 1 } } });
  vi.mocked(f.chain.read).mockResolvedValue({ at: { hash: 'h11', number: 11 }, value: 3 });
  vi.spyOn(f.chain, 'batch').mockResolvedValue(receipt(1));
  const result = await f.chain.attendance(root.address, 'M'); expect(result.firstIndex).toBe(3);
  expect(f.chain.batch).toHaveBeenCalledWith('Set scenario attendance', forcedAttendance(root.address, 'M', 3));
  await f.chain.grace(1, 3); expect(f.chain.batch).toHaveBeenCalledWith('Set scenario absence grace', expect.any(Array));
});
it('funds a fresh daily draw and retains the pre-claim account balance', async () => {
  const f = fixture(); vi.spyOn(f.chain, 'batch').mockResolvedValue(receipt(5));
  vi.spyOn(f.chain, 'read').mockImplementation(async (pallet, item) => ({ at: { hash: 'h11', number: 11 }, value:
    pallet === 'Timestamp' ? BigInt(Date.now()) : item === 'NextDrawIndex' ? 9n : item === 'Account' ? { balance: 17n } : item === 'Events' || item === 'DrawSalts' ? {} : undefined }));
  expect(await f.chain.prepareDraw(root.address)).toEqual({ id, fromBlock: 11, destination: root.address, balanceBefore: 17n });
  expect(f.chain.batch).toHaveBeenCalledWith('Fund and schedule daily dollar', expect.arrayContaining([expect.objectContaining({ type: 'PeopleAirdrops' })]));
  vi.mocked(f.chain.read).mockResolvedValue({ at: { hash: 'h11', number: 11 }, value: { owner: root.address } });
  await expect(f.chain.prepareDraw(root.address)).rejects.toThrow(/already exists/);
});
it('proves the exact claim extrinsic and its success in the PrizeClaimed event phase', async () => {
  const f = fixture(); f.chain.draw = { id, fromBlock: 10, destination: root.address, balanceBefore: 0n };
  const claim = { type: 'Airdrop', value: { type: 'PrizeClaimed', value: { event_id: id, beneficiary: root.address, asset_id: prizeAsset, amount: dollar } } };
  const phase = { type: 'ApplyExtrinsic', value: 2 };
  f.access.historicalStorage.mockResolvedValue([{ event: claim, phase }, { event: { type: 'System', value: { type: 'ExtrinsicSuccess' } }, phase }]);
  const result = await f.chain.claim(); expect(result.prize.amount).toBe(dollar); expect(result.at.hash).toBe('h10');
  expect(f.access.extrinsics).toHaveBeenCalledWith('h10', { includeCallArguments: true });
  f.access.extrinsics.mockResolvedValue([{ index: 2, hash: 'tx', decoded: 'complete', call: { pallet: 'Game', name: 'claim_airdrop' }, callArguments: { event_id: id, destination: root.address } }]);
  await expect(f.chain.claim()).rejects.toThrow(/PeopleAirdrops.claim/);
  f.access.historicalStorage.mockResolvedValue([{ event: claim, phase }]);
  f.access.extrinsics.mockResolvedValue([{ index: 2, hash: 'tx', decoded: 'complete', call: { pallet: 'PeopleAirdrops', name: 'claim' }, callArguments: { event_id: id, destination: root.address } }]);
  await expect(f.chain.claim()).rejects.toThrow(/ExtrinsicSuccess/);
});
it('stops on abort and never accepts the absence of a requested event as proof', async () => {
  const f = fixture(); f.access.historicalStorage.mockResolvedValue([]);
  expect(await f.chain.findEvent(10, () => true)).toBeUndefined();
  f.controller.abort(Error('cancelled')); await expect(f.chain.until('cancelled', async () => true)).rejects.toThrow('cancelled');
});
it('waits for the actual Membership key to be Included, beyond mere recognition', async () => {
  const f = fixture(), participant = scoreRecord({ score: 3, attendance_history: 255, streak: { type: 'Attended', value: 2 }, recognition: { type: 'Recognized', value: 1n }, reached_personhood: true, last_attended_game: 1 });
  const read = vi.spyOn(f.chain, 'read').mockImplementation(async (pallet, item) => ({ at: { hash: 'h11', number: 11 }, value:
    pallet === 'Score' ? participant : item === 'People' ? { key: '0x' + '11'.repeat(32) } : { type: 'Included', value: { ring_index: 1 } } }));
  const result = await f.chain.membership(root.address); expect(result.ring.value).toMatchObject({ type: 'Included' });
  expect(read).toHaveBeenCalledWith('People', 'People', [1n]);
  expect(read).toHaveBeenCalledWith('Members', 'Members', [expect.stringMatching(/^0x[0-9a-f]{64}$/), '0x' + '11'.repeat(32)]);
});
it('clears only cancellable local games and drains cancellation before another setup', async () => {
  const f = fixture(), genesis = structuredClone(target) as { humanity: { network: { session: { mode: string; network: string; chains: Record<string, object> } } } };
  genesis.humanity.network.session.mode = 'genesis'; genesis.humanity.network.session.network = 'previewnet';
  genesis.humanity.network.session.chains.people = { ws: target.endpoints!.people, codeHash: '0x69e7126f098bdf708302e52b892fd76c5d2477627bce47cbfcee7fcd5db17871' };
  genesis.humanity.network.session.chains['asset-hub'] = { codeHash: '0xd1ee06e7e13dee315971e5d7c7634390e43afd802b588faefb0cc910a790d031' };
  const chain = new ScenarioChain(f.chain.people, f.tx, root, genesis as unknown as ImportedGamesTarget, f.record);
  let state: string | undefined = 'Registration';
  vi.spyOn(chain, 'read').mockImplementation(async (_pallet, item) => ({ at: { hash: 'h11', number: 11 }, value: item === 'GameSchedules' ? [{ game_play_time: 1900 }] : state ? { state: { type: state } } : undefined }));
  const batch = vi.spyOn(chain, 'batch').mockImplementation(async () => { state = undefined; return receipt(2); });
  await chain.clearLocalGames(); expect(batch.mock.calls[0]![1].map(c => c.value.type)).toEqual(['remove_scheduled_game', 'cancel_game']);
  state = 'Reporting'; await expect(chain.clearLocalGames()).rejects.toThrow(/still processing/); expect(batch).toHaveBeenCalledOnce();
});

it.each([
  "Clearing imported DIM2 games requires the lab's own local fork; attached, public and unowned targets are refused",
  'Clearing imported DIM2 games refuses a People endpoint outside the owned fork',
  'Clearing imported DIM2 games refuses a live or public People endpoint',
  "Clearing imported DIM2 games refuses a signing connection outside the owned fork's People endpoint",
  'Clearing imported DIM2 games refused: fork root People Sudo.Key mismatch',
  'Imported DIM2 game #308 completion timed out after 180000ms: finalized People head did not advance for 60000ms; state Reporting at finalized #11, chain time 100000ms, report_ends 200s. cancel_game only permits Registration or Shuffle; no storage edits are allowed',
  'Imported DIM2 game #308 has invalid finalized chain time or report_ends; cannot bound the completion wait',
  'Imported DIM2 completion wait received invalid finalized chain time',
])('keeps a safety or environment fault as a failure: %s', async message => {
  const f = fixture(), failure = Error(message);
  vi.mocked(clearImportedGames).mockRejectedValueOnce(failure);
  await expect(f.chain.drainImportedGames()).rejects.toBe(failure);
  await expect(f.chain.schedule(240)).rejects.toThrow(/dedicated imported-game drain/);
  expect(f.submit).not.toHaveBeenCalled();
});
it.each([
  'Imported DIM2 game #308 completion timed out after 180000ms: finalized chain time has not reached report_ends; state Reporting at finalized #11, chain time 100000ms, report_ends 200s. cancel_game only permits Registration or Shuffle; no storage edits are allowed',
  'Imported DIM2 game #308 completion timed out after 180000ms: runtime block processing has not removed the imported game; state PlayerProcess at finalized #11, chain time 100000ms, report_ends 200s. cancel_game only permits Registration or Shuffle; no storage edits are allowed',
  'Imported DIM2 cleanup refused replacement game #310: expected next index #309; no replacement cancellation or storage edits are allowed',
  'Imported DIM2 game #308 is in Reporting at finalized #11; cancel_game only permits Registration or Shuffle. Stop for a decision; no storage edits are allowed',
  'Imported DIM2 cleanup is incomplete at finalized #11: Game.Game must be absent and GameSchedules empty',
])('classifies only a known imported-state refusal as not run: %s', async message => {
  const f = fixture(); vi.mocked(clearImportedGames).mockRejectedValueOnce(Error(message));
  await expect(f.chain.drainImportedGames()).rejects.toThrow(ImportedGameNotRun);
  expect(f.submit).not.toHaveBeenCalled();
});
it('names the scenarios wait variable when its configured bound is invalid', async () => {
  vi.stubEnv('HUMANITY_SCENARIOS_IMPORTED_GAME_WAIT_MS', 'invalid');
  try {
    const f = fixture();
    await expect(f.chain.drainImportedGames()).rejects.toThrow(/^Invalid HUMANITY_SCENARIOS_IMPORTED_GAME_WAIT_MS$/);
    expect(clearImportedGames).not.toHaveBeenCalled(); expect(f.submit).not.toHaveBeenCalled();
  } finally { vi.unstubAllEnvs(); }
});
