// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { addressesEqual } from '@parity/product-sdk/address';
import { fail } from '@parity/product-lab';
import type { FinalizedExtrinsic, DispatchOutcome } from '@parity/product-lab/ports/chain';
import type { ScenarioChain } from '../../../../lab/shared/chain.ts';
import { flowStorage } from '../../../../lab/shared/storage.ts';
export function seatRoute(value: string): 'free' | 'deposit' { if (value !== 'free' && value !== 'deposit') throw Error('Unknown Jollity seat route'); return value; }
export function assertRegistrationTable(rows: readonly (readonly string[])[]) {
  if (rows.length !== 1 || rows[0]?.length !== 2 || rows[0][0] !== 'registered' || rows[0][1] !== 'true') throw Error('Expected exactly registered | true');
}
/** The successful finalized extrinsic must contain the selected call, for this actor.
 * Utility batches are decoded recursively; an undeclared wrapper cannot prove registration.
 */
export function registrationCall(entry: FinalizedExtrinsic, account: string, route: 'free' | 'deposit') {
  if (entry.decoded !== 'complete' || !entry.call) return false;
  const expected = route === 'free' ? 'sign_up_with_account_lite_invite' : 'sign_up_with_account';
  const actor = entry.signer && addressesEqual(entry.signer, account);
  const contains = (pallet: string, name: string, args: unknown): boolean => {
    if (pallet === 'Game' && name === expected) {
      const value = args as { account?: string } | undefined;
      return route === 'deposit' ? Boolean(actor) : Boolean((!entry.signer || actor) && value?.account && addressesEqual(value.account, account));
    }
    const batch = args as { calls?: Array<{ type: string; value: { type: string; value?: unknown } }> } | undefined;
    return pallet === 'Utility' && ['batch_all', 'batch'].includes(name) && Array.isArray(batch?.calls) &&
      batch.calls.some(call => contains(call.type, call.value.type, call.value.value));
  };
  return contains(entry.call.pallet, entry.call.name, entry.callArguments);
}
export function registrationDispatch(outcome: DispatchOutcome | undefined, account: string) {
  if (!outcome?.ok || outcome.events.some(event => event.type === 'Utility' && ['BatchInterrupted', 'ItemFailed'].includes(event.value.type))) return false;
  const signedUp = outcome.events.filter(event => event.type === 'Game' && event.value.type === 'SignedUp');
  return signedUp.some(event => {
    const who = (event.value.value as { who?: { type?: string; value?: string } } | undefined)?.who;
    return who?.type === 'Account' && typeof who.value === 'string' && addressesEqual(who.value, account);
  });
}
type AccountData = { data?: { reserved?: bigint } } | undefined;
/** Held balance counts in `reserved`. The free route must not reserve the play deposit across its sign-up block. */
export function assertNoDepositReserved(before: AccountData, after: AccountData, deposit: bigint) {
  const was = before?.data?.reserved, now = after?.data?.reserved;
  if (typeof was !== 'bigint' || typeof now !== 'bigint' || deposit <= 0n) throw Error('Missing reserved balance or play deposit');
  if (now - was >= deposit) fail('not-on-chain', 'The free route reserved the play deposit');
  return { reservedBefore: was, reservedAfter: now, deposit };
}
/** Read the account at the sign-up block and its parent, with the deposit in force at the parent. */
export async function readFreeRouteReserve(chain: ScenarioChain, account: string, block: { number: number; hash: string }) {
  const parent = await chain.people.access.blockAt(block.number - 1); if (!parent) throw Error('Missing parent of the registration block');
  const [before, after, deposit] = await Promise.all([
    flowStorage(chain.people.access, 'System', 'Account', [account], parent.hash),
    flowStorage(chain.people.access, 'System', 'Account', [account], block.hash),
    flowStorage(chain.people.access, 'Game', 'PlayDepositAmount', [], parent.hash),
  ]);
  return assertNoDepositReserved(before as AccountData, after as AccountData, BigInt(deposit as bigint));
}
export async function readRegistrationRoute(chain: ScenarioChain, account: string, route: 'free' | 'deposit', from: number) {
  const head = await chain.people.access.finalizedHead();
  for (let number = head.number; number >= from; number--) {
    const block = await chain.people.access.blockAt(number); if (!block) throw Error('Missing finalized registration block');
    const entries = await chain.people.access.extrinsics(block.hash, { includeCallArguments: true });
    for (const entry of entries ?? []) if (registrationCall(entry, account, route)) {
      const dispatch = await chain.people.access.dispatchOutcome(block.hash, entry.index);
      if (registrationDispatch(dispatch, account)) return { block, extrinsic: entry, dispatch };
    }
  }
  fail('not-on-chain', `No successful finalized ${route} registration by this actor`);
}
