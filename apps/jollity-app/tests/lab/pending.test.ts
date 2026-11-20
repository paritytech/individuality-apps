// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { expect, it } from 'vitest';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { pendingWrapper, resetPending, markPending, permissionRefusalReason, playReason, prizeReason } from '../../lab/scenarios/pending.ts';
it('returns pending only for a step that recorded a missing capability', async () => {
  resetPending();
  const fn = async () => undefined;
  const wrapped = pendingWrapper(fn, { 'product-lab:custom': 'refuse' });
  await expect(wrapped()).resolves.toBeUndefined();
  markPending('refuse'); await expect(wrapped()).resolves.toBe('pending');
  await expect(pendingWrapper(fn, { 'product-lab:custom': 'another step' })()).resolves.toBeUndefined();
  resetPending(); await expect(wrapped()).resolves.toBeUndefined();
});
it('negative control preserves failures instead of hiding them under pending', async () => {
  markPending('refuse');
  await expect(pendingWrapper(async () => { throw Error('setup failed'); }, { 'product-lab:custom': 'refuse' })()).rejects.toThrow('setup failed');
  resetPending();
});
it('documents the exact fixed-policy host limitation without changing its selection', () => {
  expect(permissionRefusalReason).toContain('request-decisions');
  const session = readFileSync(resolve(import.meta.dirname, '../../lab/scenarios/session.ts'), 'utf8');
  expect(session).toContain('host: hostSelection, patches: []');
  expect(session).not.toContain("approvals: 'per-request'");
});
it('the real unsupported steps record pending and cannot silently pass later actions', async () => {
  const { customSteps } = await import('@parity/product-lab/steps');
  await import('../../lab/scenarios/steps.ts');
  const attached: unknown[] = [];
  const declarations = [
    ['Alice, Bob and Carol are new actors registered for the game by transaction', playReason],
    ['{actor} opens dim2 at / and refuses access once', permissionRefusalReason],
    ['{actor} attended the last game and has reached personhood', prizeReason],
  ];
  const context = { lab: { attach: async (value: unknown) => { attached.push(value); } } } as Parameters<ReturnType<typeof customSteps>[number]['run']>[0];
  for (const [pattern, reason] of declarations) {
    const definition = customSteps().find(step => step.pattern.text === pattern);
    if (!definition) throw Error('Missing pending binding');
    resetPending();
    await expect(pendingWrapper(() => definition.run(context), { 'product-lab:custom': definition.pattern.text })()).resolves.toBe('pending');
    expect(attached.at(-1)).toEqual({ pending: reason });
  }
  const play = customSteps().find(step => step.pattern.text === 'Alice, Bob and Carol play and vote in the DIM2 app together');
  await expect(play!.run(context)).rejects.toThrow('Transaction enrollment uses a synthetic communication key');
  resetPending();
});
