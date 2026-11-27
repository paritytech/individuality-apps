// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { it, expect } from 'vitest';
import { TransactionExecutor, type Receipt } from '@parity/product-lab/chain';
import { clearImportedGames } from '../../shared/upstream/lab/steps/humanity/bootstrap/imported-games.ts';
import { SudoDispatchValidator } from '../../shared/upstream/lab/chain/sudo.ts';
const address = '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY', url = 'ws://127.0.0.1:27010';
const date = 1794145123;
const moduleError = (type: string) => ({ type: 'Module', value: { type: 'Game', value: { type } } });
function fixture(mode: 'promoted' | 'expired' | 'still-present' | 'bad-origin' | 'populated' | 'wrong-date' | 'late-state' | 'outer-failure') {
  let dispatched = false;
  const events: unknown[] = [];
  const receipt: Receipt = { ok: mode !== 'outer-failure', dispatchError: mode === 'outer-failure' ? moduleError('NoSuchGameScheduled') : undefined, txHash: 'tx', block: { hash: 'dispatch', number: 11, index: 0 }, events: [
    { type: 'Sudo', value: { type: 'Sudid', value: { sudo_result: { success: false, value: mode === 'bad-origin' ? { type: 'BadOrigin' } : moduleError('NoSuchGameScheduled') } } } },
  ] };
  const clock = { now: () => 0, sleep: async () => { throw Error('No retry or sleep expected'); } };
  const signal = new AbortController().signal;
  const tx = new TransactionExecutor({ async submit() { dispatched = true; return { included: Promise.resolve(receipt), finalized: Promise.resolve(receipt) }; } },
    { file: 'transactions.jsonl', record: () => {}, activity: () => {}, message: () => {} },
    { signal, chain: 'people', clock: clock as never, ordering: false, validator: new SudoDispatchValidator() });
  const target = { offer: { local: true }, endpoints: { people: url }, humanity: { network: { kind: 'owned', session: {
    schemaVersion: 1, mode: 'fork', ownership: 'owned', chains: { people: { ws: url } },
  } } } };
  const chain = { clock, signal, access: { url, finalizedHead: async () => ({ hash: dispatched ? 'dispatch' : 'snapshot', number: dispatched ? 11 : 10 }),
    storage: async (_p: string, item: string) => item === 'GameSchedules' ? (!dispatched || mode === 'still-present' ? [{ game_play_time: date }] : [])
      : item === 'Game' && dispatched && ['promoted', 'populated', 'wrong-date', 'late-state'].includes(mode) ? {
        index: 309, game_date: mode === 'wrong-date' ? date + 1 : date, report_ends: date + 300, pending_attendance: 0,
        state: { type: mode === 'late-state' ? 'Reporting' : 'Registration', value: { next_player_index: mode === 'populated' ? 1 : 0 } },
      } : undefined },
    api: { query: { Sudo: { Key: { getValue: async () => address } } }, tx: { Sudo: { sudo: (args: unknown) => args }, Game: {
      remove_scheduled_game: (args: unknown) => ({ decodedCall: args }), cancel_game: () => { throw Error('No cancellation before handoff validation'); },
    } } } };
  const invoke = () => clearImportedGames({ target: target as never, chain: chain as never, root: { address, signer: { publicKey: new Uint8Array(32) } } as never,
    transactions: tx, record: value => events.push(value) });
  return { invoke, tx, receipt, events };
}
it('reproduces the old validator failure when on_poll consumes the finalized snapshot schedule', async () => {
  expect(await new SudoDispatchValidator().validate(fixture('promoted').receipt)).toEqual({ ok: false, reason: 'inner dispatch failed' });
});
it('accepts only the already-absent schedule and hands off its empty runtime promotion without poisoning the executor', async () => {
  const f = fixture('promoted');
  expect(await f.invoke()).toMatchObject({ promoted: 309, removed: 1 }); f.tx.assertHealthy();
  expect(f.events).toContainEqual(expect.objectContaining({ kind: 'imported-schedule-runtime-consumed', schedule: date, at: f.receipt.block }));
});
it('handles an expired fork schedule consumed without a replacement game', async () => {
  const f = fixture('expired'); expect(await f.invoke()).toMatchObject({ removed: 1, cancelled: null }); f.tx.assertHealthy();
});
it.each(['still-present', 'bad-origin', 'populated', 'wrong-date', 'late-state'] as const)('@negative-control: %s still fails, without a cancellation or retry', async mode => {
  await expect(fixture(mode).invoke()).rejects.toThrow(mode === 'populated' ? 'no players' : mode === 'wrong-date' ? 'not a snapshotted schedule' : mode === 'late-state' ? 'not Registration' : 'inner dispatch failed');
});

it('@negative-control: an outer dispatch failure is never treated as a consumed schedule', async () => {
  await expect(fixture('outer-failure').invoke()).rejects.toThrow('dispatch failed');
});
