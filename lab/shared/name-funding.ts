// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// Fund only the owned copy's game account; the app still discovers the balance and links its own name.
import { TransactionExecutor, type ReceiptValidator } from '@parity/product-lab/chain';
import { PapiTransactionSubmitter } from '@parity/product-lab/chain-papi';
import type { ScenarioChain } from './chain.ts';
import type { PapiChainAccess } from '@parity/product-lab/chain-papi';
import { call } from './chain-plan.ts';
import { requireScenarioTarget } from './target.ts';
import { flowStorage, zeroPasAccount } from './storage.ts';
import { PEOPLE_SIGNING } from './upstream/lab/chain/people.ts';
import { verifySudoKey } from './upstream/lab/chain/sudo.ts';
import { observedSubmitter, transactionWriter } from './transactions.ts';

// Two local PGAS cover the name store, note and fee headroom; no native PAS goes to Ada on Asset Hub.
export const nameLinkFunding = 20_000_000_000n;
export function nameLinkFundingCall(asset: number, issuer: string, account: string, balance: bigint) {
  if (!Number.isSafeInteger(asset) || asset < 0 || !issuer || !account || balance < 0n) throw Error('Invalid local name-link funding plan');
  return balance >= nameLinkFunding ? undefined : call('Sudo', 'sudo_as', { who: { type: 'Id', value: issuer },
    call: call('Assets', 'mint', { id: asset, beneficiary: { type: 'Id', value: account }, amount: nameLinkFunding - balance }) });
}
export const nameFundingValidator: ReceiptValidator = { async validate(receipt) {
  const result = receipt.events.find(e => e.type === 'Sudo' && e.value.type === 'SudoAsDone');
  if (!result || (result.value.value as { sudo_result: { success: boolean } }).sudo_result.success !== true) return { ok: false, reason: 'Asset Hub name-link funding inner dispatch failed' };
  return { ok: true };
} };
/** The caller names its actor, its journal and, optionally, the receipt log; shared code holds no lab's names or paths. */
export interface NameLinkFundingRecord { actor: string; journal: string; transactions?: string }
export async function fundNameLink(state: { chain: ScenarioChain; hub: PapiChainAccess; people: ScenarioChain['people']; evidence: unknown[]; actor(): { game: { address: string } } },
  record: NameLinkFundingRecord) {
  if (!/^[A-Za-z][A-Za-z0-9 ]{0,39}$/.test(record.actor) || !record.journal) throw Error('Invalid name-link funding record');
  requireScenarioTarget(state.chain.target);
  const access = state.hub, account = state.actor().game.address, head = await access.finalizedHead();
  const authority = await verifySudoKey(access.api, state.chain.authority.address, { at: head.hash, label: 'Owned Asset Hub Sudo.Key' });
  if (authority !== true) throw Error(authority);
  const asset = Number(await access.constant('Pgas', 'PgasAssetId'));
  const details = await flowStorage(access, 'Assets', 'Asset', [asset], head.hash) as { issuer?: string } | undefined;
  if (!details?.issuer) throw Error('Owned Asset Hub has no PGAS issuer');
  const before = (await flowStorage(access, 'Assets', 'Account', [asset, account], head.hash) as { balance?: bigint } | undefined)?.balance ?? 0n;
  const planned = nameLinkFundingCall(asset, details.issuer, account, before);
  const journal = { file: record.journal, record: (value: unknown) => { state.evidence.push(value); }, activity: (value: unknown) => { state.evidence.push(value); }, message: (value: string) => { state.evidence.push({ message: value }); } };
  const submitter = new PapiTransactionSubmitter(access, { signing: PEOPLE_SIGNING });
  const executor = new TransactionExecutor(record.transactions ? observedSubmitter(submitter, transactionWriter(record.transactions)) : submitter,
    journal, { signal: state.people.signal, chain: 'asset-hub', clock: state.people.clock, mode: 'finalized', validator: nameFundingValidator });
  const mintAs = access.api.tx.Sudo?.sudo_as;
  if (!mintAs) throw Error('Owned Asset Hub has no sudo_as funding call');
  const receipt = planned ? await executor.submit(`Fund ${record.actor} name-link deposit on owned Asset Hub`, mintAs(planned.value.value), state.chain.authority.signer) : undefined;
  const finalized = await access.finalizedHead();
  const nativePas = await zeroPasAccount(access, account, finalized.hash, `${record.actor} game account on owned Asset Hub`);
  const after = (await flowStorage(access, 'Assets', 'Account', [asset, account], finalized.hash) as { balance?: bigint } | undefined)?.balance ?? 0n;
  if (after < 7_000_000_000n) throw Error('Finalized Asset Hub funding cannot cover the name-link deposit');
  return { asset, account, before, after, finalized, nativePas, ...(receipt ? { minted: nameLinkFunding - before, transaction: receipt.txHash } : { minted: 0n }) };
}
