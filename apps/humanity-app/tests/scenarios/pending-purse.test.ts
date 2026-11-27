// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { it, expect, vi } from 'vitest';
import { supportCodeLibraryBuilder, setDefinitionFunctionWrapper, defineStep, Before } from '@cucumber/cucumber';
import { pendingPurseWrapper, purseStep, purseReason } from '../../lab/scenarios/pending-purse.ts';

it('the actual Cucumber definition returns pending only after the final purse attachment', async () => {
  supportCodeLibraryBuilder.reset(process.cwd(), () => 'offline-id');
  setDefinitionFunctionWrapper(pendingPurseWrapper);
  Before(async () => undefined);
  const run = vi.fn(async function (_name: string) { return undefined; });
  defineStep(/^Ada's Coinage purse grows by the prize within 60 seconds$/, { wrapperOptions: { 'product-lab:custom': purseStep } }, run);
  defineStep(/^product account 0 grew by the PrizeClaimed amount$/, { wrapperOptions: { 'product-lab:custom': 'product account 0 grew by the PrizeClaimed amount' } }, async () => 'passed');
  const library = supportCodeLibraryBuilder.finalize();
  expect(await library.stepDefinitions[0]!.code.call({}, 'Ada')).toBe('pending');
  expect(run).toHaveBeenCalledOnce();
  expect(await library.stepDefinitions[1]!.code.call({})).toBe('passed');
  expect(purseReason).toBe('host coinage purse unsupported');
});
it('propagates a failed chain leg instead of converting it to pending', async () => {
  const fail = pendingPurseWrapper(async () => { throw Error('missing finalized claim'); }, { 'product-lab:custom': purseStep });
  await expect(fail()).rejects.toThrow('missing finalized claim');
});

it('leaves Cucumber hooks without wrapperOptions alone', () => {
  const hook = () => undefined; expect(pendingPurseWrapper(hook)).toBe(hook);
});
