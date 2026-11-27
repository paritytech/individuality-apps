// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { expect, it, vi } from 'vitest';
import { ScenarioChain } from '../../../../lab/shared/chain.ts';
import { gameParticipant } from '../../../../lab/shared/chain-plan.ts';
import { Sr25519KeyDerivation } from '@parity/product-lab/keys-sr25519';
import type { TransactionExecutor, Receipt, ReceiptValidator } from '@parity/product-lab/chain';
import type { GamesPeopleConnection } from '../../../../lab/shared/upstream/lab/steps/games/chain.ts';
import type { ImportedGamesTarget } from '../../../../lab/shared/upstream/lab/steps/humanity/bootstrap/imported-games.ts';

const players = [1, 2, 3].map(i => gameParticipant(new Uint8Array(32).fill(i), 'paseo', `P${i}`));
const root = new Sr25519KeyDerivation().derive('//Alice');
function fixture(state: string, index = 7, count = 3) {
  let current = state;
  const group = players.map(p => ({ type: 'Account', value: p.address }));
  const access = { finalizedHead: vi.fn(async () => ({ hash: 'finalized', number: 11 })),
    historicalStorage: vi.fn(async (_pallet, item, keys, _hash) => item === 'Game' ? { index, state: { type: current, value: { player_count: count } } } : group[keys[0][1]]) };
  const force = vi.fn(() => ({ decodedCall: 'shuffle' }));
  const api = { query: { Sudo: { Key: { getValue: vi.fn(async () => root.address) } } }, tx: { Sudo: { sudo: vi.fn(value => value) }, Game: { testnet_force_start_shuffle: force } } };
  const receipt = { block: { hash: 'dispatch', number: 12 }, events: [{ type: 'Sudo', value: { type: 'Sudid', value: { sudo_result: { success: false, value: 'wrong-phase' } } } }] } as unknown as Receipt;
  const submit = vi.fn(async (_label, _tx, _signer, validator: ReceiptValidator) => {
    current = 'Reporting';
    const result = await validator.validate(receipt);
    if (!result.ok) throw Error(result.reason);
    return receipt;
  });
  const target = { offer: { local: true }, endpoints: { people: 'ws://127.0.0.1:27010' }, humanity: { network: { kind: 'owned', session: {
    schemaVersion: 1, ownership: 'owned', mode: 'fork', chains: { people: { ws: 'ws://127.0.0.1:27010' } },
  } } } } as unknown as ImportedGamesTarget;
  const chain = new ScenarioChain({ access, api, signal: new AbortController().signal } as unknown as GamesPeopleConnection, { submit, assertHealthy: vi.fn() } as unknown as TransactionExecutor, root, target, vi.fn());
  return { chain, submit, force, group, access, setState: (value: string) => { current = value; } };
}
it('accepts natural Reporting first with the exact indexed group and sends no force', async () => {
  const f = fixture('Reporting'); await f.chain.startReporting(7, players);
  expect(f.force).not.toHaveBeenCalled(); expect(f.submit).not.toHaveBeenCalled();
  expect(f.access.historicalStorage).toHaveBeenCalledWith('Game', 'IndexToPlayer', [[0, 2]], 'finalized', { orDefault: true });
});
it.each(['Registration', 'Shuffle'])('accepts the deadline winning after the %s read only at the dispatch block and finality', async state => {
  const f = fixture(state); await f.chain.startReporting(7, players);
  expect(f.submit).toHaveBeenCalledOnce(); expect(f.force).toHaveBeenCalledOnce();
  expect(f.access.historicalStorage).toHaveBeenCalledWith('Game', 'Game', [], 'dispatch', { orDefault: true });
  expect(f.access.historicalStorage).toHaveBeenCalledWith('Game', 'Game', [], 'finalized', { orDefault: true });
});
it('forces shuffle first successfully then waits for the exact finalized group', async () => {
  const f = fixture('Registration');
  f.submit.mockImplementationOnce(async () => { f.setState('Reporting'); return { block: { hash: 'dispatch', number: 12 } } as Receipt; });
  await f.chain.startReporting(7, players); expect(f.submit).toHaveBeenCalledOnce();
});
it.each(['Cancelling', 'Processing', 'Completed'])('refuses %s before sending a force', async state => {
  const f = fixture(state); await expect(f.chain.startReporting(7, players)).rejects.toThrow('Unexpected game'); expect(f.submit).not.toHaveBeenCalled();
});
it('refuses wrong index, player count, foreign players and duplicate group entries', async () => {
  await expect(fixture('Reporting', 8).chain.startReporting(7, players)).rejects.toThrow('Unexpected game');
  await expect(fixture('Reporting', 7, 4).chain.startReporting(7, players)).rejects.toThrow('wrong player count');
  const f = fixture('Reporting'); f.group[0]!.value = root.address;
  await expect(f.chain.startReporting(7, players)).rejects.toThrow('wrong players');
  f.group[0] = f.group[1]!;
  await expect(f.chain.startReporting(7, players)).rejects.toThrow('wrong players');
});
it('does not swallow a dispatch failure in any other state or for a foreign group', async () => {
  const f = fixture('Registration');
  f.submit.mockImplementationOnce(async (_label, _tx, _signer, validator) => {
    f.setState('Cancelling');
    const result = await validator.validate({ block: { hash: 'dispatch', number: 12 }, events: [{ type: 'Sudo', value: { type: 'Sudid', value: { sudo_result: { success: false, value: 'denied' } } } }] } as unknown as Receipt);
    if (!result.ok) throw Error(result.reason);
    return {} as Receipt;
  });
  await expect(f.chain.startReporting(7, players)).rejects.toThrow('inner dispatch failed');
  const foreign = fixture('Registration'); foreign.group[0]!.value = root.address;
  await expect(foreign.chain.startReporting(7, players)).rejects.toThrow('wrong players');
});
