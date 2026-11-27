// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { beforeEach, expect, it, vi } from 'vitest';
import { customSteps, type StepContext } from '@parity/product-lab/steps';
const f = vi.hoisted(() => ({ checkpoint: vi.fn(async () => undefined), read: vi.fn(), batch: vi.fn(), fundingCalls: vi.fn(async () => ['transfer']), log: [] as Array<{ at: number; url: string; text: string }>,
  until: vi.fn(async (_label: string, read: () => Promise<unknown>, _ms?: number): Promise<unknown> => { const value = await read(); if (!value) throw Error('Expected funding state not observed'); return value; }) }));
vi.mock('../../shared/session.ts', () => ({ scenario: () => ({ actor: () => ({ game: { address: 'Ada' } }), apps: { humanity: 'http://127.0.0.1:1' }, crossAppLog: f.log,
  chain: { checkpoint: f.checkpoint, read: f.read, batch: f.batch, fundingCalls: f.fundingCalls, until: f.until } }) }));
import '../steps.ts';
const context = { lab: { attach: vi.fn(async () => undefined) } } as unknown as StepContext;
const step = (name: string) => { const found = customSteps().find(s => s.pattern.text === name); if (!found) throw Error('Missing funding readiness step'); return found; };
beforeEach(() => { vi.clearAllMocks(); f.log.length = 0; f.read.mockImplementation(async (p: string) => ({ at: { hash: 'finalized', number: 10 }, value: p === 'System' ? { data: { free: 100n } } : 50n })); });
it('finalizes the funding transaction before leaving the funding step', async () => {
  await step("the lab funds {actor}'s game account").run(context, 'Ada');
  expect(f.checkpoint).toHaveBeenCalledWith('Ada game-account funding');
  expect(f.batch.mock.invocationCallOrder[0]).toBeLessThan(f.checkpoint.mock.invocationCallOrder[0]!);
});
it('waits for finalized funds and Humanity own name-gate readiness before Register', async () => {
  f.until.mockImplementationOnce(async (_label, read) => {
    expect(await read()).toBeUndefined();
    f.log.push({ at: 1, url: 'http://127.0.0.1:1/', text: 'name "linked": Register may go' });
    return read();
  });
  await step("the lab waits for Humanity to see Ada's finalized funding").run(context);
  expect(f.read).toHaveBeenCalledWith('System', 'Account', ['Ada']);
  expect(f.until).toHaveBeenCalledWith('Humanity sees finalized Ada funding and a ready name link', expect.any(Function), 180_000);
});
it.each(['unfunded', 'other-app', 'insufficient-chain-funds'])('@negative-control: refuses %s before Register', async problem => {
  f.log.push({ at: 1, url: problem === 'other-app' ? 'http://127.0.0.1:2/' : 'http://127.0.0.1:1/', text: problem === 'unfunded' ? 'name link unfunded' : 'name already-linked: Register may go' });
  if (problem === 'insufficient-chain-funds') f.read.mockImplementation(async (p: string) => ({ value: p === 'System' ? { data: { free: 0n } } : 50n }));
  await expect(step("the lab waits for Humanity to see Ada's finalized funding").run(context)).rejects.toThrow('funding state');
});
