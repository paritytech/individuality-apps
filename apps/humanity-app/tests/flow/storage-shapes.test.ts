// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { expect, it, vi } from 'vitest';
import { PapiChainAccess } from '@parity/product-lab/chain-papi';
import { zeroPasAccount, flowStorage, creditBlocks, requiredGame, registrationGame } from '../../../../lab/shared/storage.ts';

const at = `0x${'11'.repeat(32)}`;
const address = '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY';
const metadata = `0x${gunzipSync(readFileSync(new URL('./fixtures/people-3004000.metadata16.scale.gz', import.meta.url))).toString('hex')}`;

for (const [chain, port] of [['people', 27010], ['asset-hub', 27020]] as const) {
  it(`${chain}: real adapter returns undefined for raw absence, metadata defaults only when requested`, async () => {
    // The adapter is chain-independent. People metadata exercises its fallback contract;
    // this does not claim to validate Asset Hub's live runtime metadata offline.
    const access = new PapiChainAccess(`ws://127.0.0.1:${port}`);
    let readError = false;
    vi.spyOn(access as unknown as { request(method: string): Promise<unknown> }, 'request').mockImplementation(async method => {
      if (method === 'state_getRuntimeVersion') return { specVersion: 3004000 };
      if (method === 'state_getStorageHash') return at;
      if (method === 'state_getMetadata') return metadata;
      if (method === 'state_getStorage') { if (readError) throw new Error('offline RPC failure'); return null; }
      throw new Error(`Unexpected offline RPC ${method}`);
    });
    expect(await access.historicalStorage('System', 'Account', [address], at)).toBeUndefined();
    const oldRead = async () => {
      const account = await access.historicalStorage('System', 'Account', [address], at) as { data: { free: bigint } };
      return account.data.free;
    };
    await expect(oldRead()).rejects.toThrow("Cannot read properties of undefined (reading 'data')");
    expect(await zeroPasAccount(access, address, at, chain)).toEqual({ account: 'absent', free: '0', reserved: '0' });
    expect(await flowStorage(access, 'System', 'Account', [address], at)).toMatchObject({ data: { free: 0n, reserved: 0n } });
    expect(await flowStorage(access, 'Game', 'GameSchedules', [], at)).toEqual([]);
    expect(await flowStorage(access, 'NftCredits', 'NftClaimCreditBlocks', [{ type: 'Account', value: address }], at)).toEqual([]);
    expect(await flowStorage(access, 'Game', 'Game', [], at)).toBeUndefined();
    expect(await flowStorage(access, 'PeopleLite', 'AccountToAlias', [address], at)).toBeUndefined();
    readError = true;
    await expect(zeroPasAccount(access, address, at, chain)).rejects.toThrow('offline RPC failure');
    await expect(flowStorage(access, 'Game', 'GameSchedules', [], at)).rejects.toThrow('offline RPC failure');
  });
}
it('requires exact zero bigint balances on present records and rejects malformed values', async () => {
  for (const data of [{ free: 1n, reserved: 0n }, { free: 0n, reserved: 1n }]) {
    const access = { historicalStorage: async () => ({ data }) };
    await expect(zeroPasAccount(access, address, at, 'Alice on people')).rejects.toThrow('has native PAS');
  }
  for (const record of [null, {}, { value: { data: { free: 0n, reserved: 0n } } }, { data: { free: 0n } }, { data: { free: '0', reserved: 0n } }])
    await expect(zeroPasAccount({ historicalStorage: async () => record }, address, at, 'people')).rejects.toThrow('Unreadable System.Account');
  expect(await zeroPasAccount({ historicalStorage: async () => ({ data: { free: 0n, reserved: 0n } }) }, address, at, 'people'))
    .toEqual({ account: 'present', free: '0', reserved: '0' });
});
it('distinguishes absent credits and game from corrupt shapes and malformed registration', () => {
  expect(creditBlocks(undefined)).toEqual([]); expect(creditBlocks([1, 2])).toEqual([1, 2]);
  for (const value of [null, {}, { length: 0 }, [NaN], ['1']]) expect(() => creditBlocks(value)).toThrow('Unreadable');
  for (const value of [undefined, {}, { value: {} }]) expect(() => requiredGame(value)).toThrow('absent or unreadable');
  const game = { index: 1, game_date: 100, state: { type: 'Registration', value: { next_player_index: 3 } } };
  expect(registrationGame(game).registered).toBe(3);
  expect(() => registrationGame({ ...game, state: { type: 'Registration' } })).toThrow('registration is unreadable');
});
it('keeps absent credit entries separate from unreadable roots and failed reads', async () => {
  const { readCredits, mintable } = await import('../../../../lab/shared/upstream/three-apps/chain.ts');
  const head = { number: 1, hash: at };
  let blocks: unknown = undefined, root: unknown = undefined, broken = false;
  const people = { finalized: async () => head, blockAt: async () => head,
    storage: async (_pallet: string, item: string) => { if (broken) throw new Error('credit RPC error'); return item === 'NftClaimCreditBlocks' ? blocks : root; },
    runtimeCall: async () => ({ success: true, value: [{ credit: `0x${'22'.repeat(32)}`, leaf_index: 0 }] }) };
  const assetHub = { finalized: async () => head, blockAt: async () => head, storage: async () => undefined };
  const read = () => readCredits({ people, assetHub, account: address });
  expect((await read()).credits).toEqual([]);
  blocks = {}; await expect(read()).rejects.toThrow('credit blocks are unreadable');
  blocks = [1]; await expect(read()).rejects.toThrow('People credit root is unreadable');
  root = { root: `0x${'33'.repeat(32)}`, game_index: 1, leaf_count: 1 };
  const pending = await read(); expect(pending.credits[0]!.delivered).toBe(false); expect(mintable(pending)).toEqual([]);
  broken = true; await expect(read()).rejects.toThrow('credit RPC error');
});
