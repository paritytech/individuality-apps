// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { expect, it } from 'vitest';
import { TransactionExecutor, type Receipt } from '@parity/product-lab/chain';
import { SudoDispatchValidator } from '../../shared/upstream/lab/chain/sudo.ts';
import { observedSubmitter, transactionEvidence } from '../transactions.ts';
const error = { type: 'Module', value: { type: 'Game', value: { type: 'NoSuchGameScheduled' } } };
const receipt: Receipt = { ok: true, txHash: '0x' + 'ab'.repeat(32), block: { hash: '0x' + 'cd'.repeat(32), number: 12, index: 0 },
  events: [{ type: 'Sudo', value: { type: 'Sudid', value: { sudo_result: { success: false, value: error } } } }] };
it('retains decoded failed inner dispatches at inclusion and finality before callers validate them', async () => {
  const writes: unknown[] = [];
  const nonces = { chain: async () => 'chain', next: async () => 1 };
  const submitter = observedSubmitter({ nonces, submit: async () => ({ included: Promise.resolve(receipt), finalized: Promise.resolve(receipt) }) }, v => writes.push(v));
  const tracked = await submitter.submit({ label: 'Remove imported DIM2 schedule 123', call: {}, signer: {} as never, signal: new AbortController().signal });
  expect(await tracked.included).toBe(receipt); expect(await tracked.finalized).toBe(receipt);
  expect(submitter.nonces).toBe(nonces);
  expect(writes).toHaveLength(2); expect(writes).toMatchObject([{ stage: 'included', events: [{ success: false, error }] }, { stage: 'finalized', events: [{ success: false, error }] }]);
});
it('@negative-control: unknown payloads, signing material, paths and event data cannot enter the artifact', () => {
  const dirty = { ...receipt, mnemonic: 'redact-me', signedExtrinsic: 'redact-me', signer: 'redact-me',
    events: [...receipt.events, { type: 'Balances', value: { type: 'Transfer', value: { secret: 'redact-me' } } }] };
  const text = JSON.stringify(transactionEvidence('https://example.invalid/private?token=redact-me', 'included', dirty));
  expect(text).toContain('NoSuchGameScheduled'); expect(text).not.toMatch(/redact-me|signedExtrinsic|mnemonic|secret|https:|private/);
});
it('@negative-control: a submission rejection remains a rejection', async () => {
  const submitter = observedSubmitter({ submit: async () => { throw Error('submission refused'); } }, () => { throw Error('no receipt'); });
  await expect(submitter.submit({} as never)).rejects.toThrow('submission refused');
});

it('keeps failing receipts when the real executor rejects them before its successful-transaction journal', async () => {
  const writes: unknown[] = [], journal: unknown[] = [];
  const executor = new TransactionExecutor(observedSubmitter({ submit: async () => ({ included: Promise.resolve(receipt), finalized: Promise.resolve(receipt) }) }, v => writes.push(v)),
    { file: 'transactions.jsonl', record: v => journal.push(v), activity: () => {}, message: () => {} },
    { chain: 'people', signal: new AbortController().signal, clock: { now: () => 0 } as never, ordering: false, validator: new SudoDispatchValidator() });
  await expect(executor.submit('Remove imported DIM2 schedule 123', {}, { publicKey: new Uint8Array(32) } as never)).rejects.toThrow('inner dispatch failed');
  expect(writes).toHaveLength(2); expect(journal).toEqual([]);
});
