// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { getTypedCodecs } from 'polkadot-api';
import { fromHex } from 'polkadot-api/utils';
import { call, fundingHeadroom } from '../../../../lab/shared/chain-plan.ts';
import { people } from '../../../../lab/shared/upstream/lab/chain/descriptors.ts';
import type { ScenarioChain } from '../../../../lab/shared/chain.ts';
export const homeSetups = {
  'no game scheduled': 'no-game', 'registration open, Ada funded': 'register',
  'registration open, Ada unfunded': 'unfunded', 'Ada registered by transaction': 'registered',
  'registration closed, Ada not in it': 'missed', 'game in PlayerProcess': 'wrapping-up',
} as const;
export function homeSetup(value: string) { if (!Object.hasOwn(homeSetups, value)) throw Error('Unknown DIM2 home setup'); return homeSetups[value as keyof typeof homeSetups]; }
export const wrappingReason = 'PlayerProcess is transient: existing game helpers wait through processing to completion; no supported helper holds this phase long enough for a finalized home observation';
/** An owned-chain root storage transaction supplies an independent foreign-context alias blocker.
 * It consumes no real person's invitation and cannot change host keys or username ownership.
 */
export function blockedAlias() { return { revision: 0, ring: 0, ca: { context: `0x${'00'.repeat(32)}`, alias: `0x${'01'.repeat(32)}` } }; }
export async function blockFreeSeat(chain: ScenarioChain, account: string) {
  const codecs = await getTypedCodecs(people), key = await chain.people.api.query.PeopleLite.AccountToAlias.getKey(account);
  await chain.batch('Set a foreign-context lite alias on the owned game account', [call('System', 'set_storage', {
    items: [[fromHex(key), codecs.query.PeopleLite.AccountToAlias.value.enc(blockedAlias())]],
  })]);
  const proof = await chain.read('PeopleLite', 'AccountToAlias', [account]);
  const binding = proof.value as ReturnType<typeof blockedAlias> | undefined;
  if (!binding || binding.revision !== 0 || binding.ring !== 0 || binding.ca.context !== blockedAlias().ca.context || binding.ca.alias !== blockedAlias().ca.alias) throw Error('Foreign-context alias blocker did not finalize');
  return proof;
}
/** `deposit` funds the play deposit plus fee headroom. `fees` funds the headroom only, so the account cannot
 * pay the deposit: a free seat that registers proves the free route rather than a deposit fallback. */
export function fundingTarget(level: 'deposit' | 'fees', deposit: bigint) {
  if (deposit <= fundingHeadroom) throw Error('Fee headroom must stay below the play deposit');
  return level === 'deposit' ? deposit + fundingHeadroom : fundingHeadroom;
}
export async function fundGame(chain: ScenarioChain, account: string, level: 'deposit' | 'fees' = 'deposit') {
  const balance = await chain.read('System', 'Account', [account]), deposit = BigInt((await chain.read('Game', 'PlayDepositAmount')).value as bigint);
  const minimum = fundingTarget(level, deposit);
  const free = (balance.value as { data: { free: bigint } }).data.free;
  if (level === 'fees' && free >= deposit) throw Error('A fee-only seat account already holds the play deposit');
  if (free < minimum) await chain.batch('Fund Jollity game account on the owned People copy', [call('Utility', 'dispatch_as_fallible', {
    as_origin: { type: 'system', value: { type: 'Signed', value: chain.authority.address } },
    call: call('Balances', 'transfer_keep_alive', { dest: { type: 'Id', value: account }, value: minimum - free }),
  })]);
  const funded = (await chain.read('System', 'Account', [account])).value as { data: { free: bigint } };
  if (level === 'fees' && funded.data.free >= deposit) throw Error('Fee-only funding reached the play deposit');
  return { level, deposit, free: funded.data.free };
}
