// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { expect, it } from 'vitest';
import { Sr25519KeyDerivation } from '@parity/product-lab/keys-sr25519';
import type { FinalizedExtrinsic } from '@parity/product-lab/ports/chain';
import type { ScenarioChain } from '../../../../lab/shared/chain.ts';
import { registrationCall, registrationDispatch, assertRegistrationTable, readRegistrationRoute, seatRoute, assertNoDepositReserved, readFreeRouteReserve } from '../../lab/scenarios/registration.ts';
import { fundGame, fundingTarget } from '../../lab/scenarios/setup.ts';
import { fundingHeadroom } from '../../../../lab/shared/chain-plan.ts';
const ada = new Sr25519KeyDerivation().derive('//Alice').address;
const other = new Sr25519KeyDerivation().derive('//Bob').address;
const entry = (route = 'free', signer = ada): FinalizedExtrinsic => ({ index: 2, hash: '0xaa', decoded: 'complete', signer,
  call: { pallet: 'Game', name: route === 'free' ? 'sign_up_with_account_lite_invite' : 'sign_up_with_account' }, callArguments: { account: ada } });
it.each(['free', 'deposit'] as const)('checks the finalized %s route, and rejects the opposite call', route => {
  expect(seatRoute(route)).toBe(route);
  expect(registrationCall(entry(route), ada, route)).toBe(true);
  expect(registrationCall(entry(route), ada, route === 'free' ? 'deposit' : 'free')).toBe(false);
});
it('negative control rejects partial decode, an unrelated signer and an undeclared wrapper', () => {
  expect(registrationCall({ ...entry(), decoded: 'partial' }, ada, 'free')).toBe(false);
  expect(registrationCall({ ...entry('deposit', other) }, ada, 'deposit')).toBe(false);
  expect(registrationCall({ ...entry(), signer: other, callArguments: { account: other } }, ada, 'free')).toBe(false);
  expect(registrationCall({ ...entry(), call: { pallet: 'Proxy', name: 'proxy' } }, ada, 'free')).toBe(false);
});
it('accepts a decoded Utility batch only when it contains this actor and route', () => {
  const batched: FinalizedExtrinsic = { ...entry('deposit'), call: { pallet: 'Utility', name: 'batch_all' },
    callArguments: { calls: [{ type: 'Game', value: { type: 'sign_up_with_account' } }] } };
  expect(registrationCall(batched, ada, 'deposit')).toBe(true);
  expect(registrationCall(batched, other, 'deposit')).toBe(false);
  expect(registrationCall(batched, ada, 'free')).toBe(false);
});
it('requires the whole registration table and a known seat route', () => {
  expect(() => assertRegistrationTable([['registered', 'true']])).not.toThrow();
  for (const rows of [[], [['registered', 'false']], [['unknown', 'true']], [['registered', 'true'], ['extra', 'row']]])
    expect(() => assertRegistrationTable(rows)).toThrow('Expected exactly');
  expect(() => seatRoute('returning')).toThrow('Unknown');
});
it('requires successful dispatch at the canonical finalized block of the selected route', async () => {
  const chain = { people: { access: { finalizedHead: async () => ({ number: 7 }), blockAt: async () => ({ number: 7, hash: '0x07' }),
    extrinsics: async () => [entry()], dispatchOutcome: async () => ({ ok: true, events: [{ type: 'Game', value: { type: 'SignedUp', value: { who: { type: 'Account', value: ada } } } }] }) } } } as unknown as ScenarioChain;
  await expect(readRegistrationRoute(chain, ada, 'free', 7)).resolves.toMatchObject({ block: { hash: '0x07' }, extrinsic: { index: 2 } });
  chain.people.access.dispatchOutcome = async () => ({ ok: false, events: [] });
  await expect(readRegistrationRoute(chain, ada, 'free', 7)).rejects.toThrow('No successful finalized free registration');
});

it('negative control rejects swallowed Utility failures and a sign-up event for another account', () => {
  const success = { ok: true, events: [{ type: 'Game', value: { type: 'SignedUp', value: { who: { type: 'Account', value: ada } } } }] };
  expect(registrationDispatch(success, ada)).toBe(true);
  expect(registrationDispatch(success, other)).toBe(false);
  expect(registrationDispatch({ ok: true, events: [] }, ada)).toBe(false);
  for (const type of ['BatchInterrupted', 'ItemFailed']) expect(registrationDispatch({ ...success, events: [...success.events, { type: 'Utility', value: { type } }] }, ada)).toBe(false);
});

const deposit = 50_000_000_000n;
it('funds the free seat with fee headroom only, below the deposit, and the deposit seat in full', async () => {
  expect(fundingTarget('fees', deposit)).toBe(fundingHeadroom);
  expect(fundingTarget('deposit', deposit)).toBe(deposit + fundingHeadroom);
  expect(() => fundingTarget('fees', fundingHeadroom)).toThrow('below the play deposit');
  const batches: unknown[] = [];
  let free = 0n;
  const chain = { authority: { address: ada }, batch: async (_label: string, calls: Array<{ value: { value: { call: { value: { value: { value: bigint } } } } } }>) => {
    batches.push(calls); free += calls[0]!.value.value.call.value.value.value; },
  read: async (pallet: string) => ({ value: pallet === 'Game' ? deposit : { data: { free } } }) } as unknown as ScenarioChain;
  await expect(fundGame(chain, ada, 'fees')).resolves.toEqual({ level: 'fees', deposit, free: fundingHeadroom });
  expect(batches).toHaveLength(1);
  free = deposit;
  await expect(fundGame(chain, ada, 'fees')).rejects.toThrow('already holds the play deposit');
});
it('negative control fails the free route when its sign-up reserved the deposit', () => {
  const at = (reserved: bigint) => ({ data: { reserved } });
  expect(assertNoDepositReserved(at(0n), at(0n), deposit)).toEqual({ reservedBefore: 0n, reservedAfter: 0n, deposit });
  expect(() => assertNoDepositReserved(at(0n), at(deposit), deposit)).toThrow('The free route reserved the play deposit');
  expect(() => assertNoDepositReserved(at(5n), at(5n + deposit), deposit)).toThrow('The free route reserved the play deposit');
  expect(() => assertNoDepositReserved(undefined, at(0n), deposit)).toThrow('Missing reserved balance');
});
it('reads the reserve at the sign-up block and its parent', async () => {
  const reads: unknown[] = [];
  const chain = { people: { access: { blockAt: async (number: number) => ({ number, hash: `0x0${number}` }),
    historicalStorage: async (pallet: string, item: string, _keys: unknown[], at: string) => { reads.push([pallet, item, at]);
      return pallet === 'Game' ? deposit : { data: { reserved: at === '0x07' ? deposit : 0n } }; } } } } as unknown as ScenarioChain;
  await expect(readFreeRouteReserve(chain, ada, { number: 7, hash: '0x07' })).rejects.toThrow('reserved the play deposit');
  expect(reads).toEqual([['System', 'Account', '0x06'], ['System', 'Account', '0x07'], ['Game', 'PlayDepositAmount', '0x06']]);
});
