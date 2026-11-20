// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { AfterStep, BeforeStep } from '@cucumber/cucumber';
import { customSteps, type StepContext } from '@parity/product-lab/steps';
const fixture = vi.hoisted(() => {
  const proof = { score: 'recognized', ring: { type: 'Included' } };
  const field = { fill: vi.fn(async () => undefined), waitFor: vi.fn(async () => { throw Error('stop before typing'); }) };
  const chain = { membership: vi.fn(async () => proof), score: vi.fn(async () => ({ value: { recognition: { type: 'Recognized' } } })),
    until: vi.fn(async (_label: string, read: () => Promise<unknown>) => read()), batch: vi.fn(async () => undefined), play: vi.fn(async () => undefined), current: { playsAt: 0 },
    checkpoint: vi.fn(async () => undefined), enroll: vi.fn(async () => undefined),
    read: vi.fn(async (_pallet: string, _item: string, _keys?: unknown[]): Promise<{ at: { hash: string }; value: unknown }> => ({ at: { hash: 'f0' }, value: undefined })) };
  const choice = { click: vi.fn(async () => undefined), waitFor: vi.fn(async () => undefined) };
  const actor = { game: { address: 'game-account', signer: { publicKey: new Uint8Array(32).fill(1) } }, view: { username: 'adalab.04', page: { getByLabel: vi.fn(() => field), getByRole: vi.fn((_role: string, _options?: { name?: string; exact?: boolean }) => choice), getByTestId: vi.fn((_id: string) => choice), evaluate: vi.fn(async (_fn?: unknown, _arg?: unknown) => 'Member') } } };
  const bots: Array<{ name: string; address: string }> = [];
  return { proof, field, chain, actor, choice, bots };
});
vi.mock('../../../../lab/shared/session.ts', () => ({ scenario: () => ({ chain: fixture.chain, actor: () => fixture.actor, bots: fixture.bots }) }));
vi.mock('@cucumber/cucumber', async original => ({ ...await original<object>(), Before: vi.fn(), After: vi.fn(), AfterStep: vi.fn(), BeforeStep: vi.fn(), setDefinitionFunctionWrapper: vi.fn() }));
vi.stubEnv('PRODUCT_LAB_RUNTIME_MODULE', 'offline-step-test');
await import('../../lab/scenarios/steps.ts');
const evidenceHooks = vi.mocked(AfterStep).mock.calls.slice();
const checkpointHooks = vi.mocked(BeforeStep).mock.calls.slice();
vi.unstubAllEnvs();
beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => vi.restoreAllMocks());
it('A3 attaches Included Membership proof before the 600-second name-field wait', async () => {
  const attach = vi.fn(async () => undefined);
  const context = { lab: { attach } } as unknown as StepContext;
  const claim = customSteps().find(step => step.pattern.text === "{actor} claims her member username")!;
  await expect(claim.run(context, 'Ada')).rejects.toThrow('stop before typing');
  expect(fixture.chain.membership).toHaveBeenCalledWith('game-account');
  expect(attach).toHaveBeenCalledWith({ membership: fixture.proof });
  expect(fixture.field.waitFor).toHaveBeenCalledWith({ state: 'visible', timeout: 600_000 });
  expect(fixture.chain.membership.mock.invocationCallOrder[0]).toBeLessThan(attach.mock.invocationCallOrder[0]!);
  expect(attach.mock.invocationCallOrder[0]).toBeLessThan(fixture.field.waitFor.mock.invocationCallOrder[0]!);
  expect(fixture.chain.until).toHaveBeenCalledWith('app registered personhood recognition', expect.any(Function), 600_000);
});
it('registers failure evidence after every Cucumber step, including outer timeouts and opening steps', () => {
  expect(evidenceHooks).toHaveLength(1);
  expect(evidenceHooks[0]![0]).toEqual({ timeout: 30_000 });
  expect(evidenceHooks[0]![1]).toEqual(expect.any(Function));
});
it('A3 waits for recognition and Included Membership before the name choice, within one 600-second budget', async () => {
  let now = 1000; vi.spyOn(Date, 'now').mockImplementation(() => now);
  let recognized!: () => void, included!: () => void;
  const recognitionWait = new Promise<void>(resolve => { recognized = resolve; });
  const membershipWait = new Promise<void>(resolve => { included = resolve; });
  fixture.chain.score.mockResolvedValueOnce({ value: { recognition: { type: 'NotRecognized' } } });
  fixture.chain.until.mockImplementationOnce(async (_label, read) => {
    expect(await read()).toBeUndefined(); await recognitionWait; return read();
  });
  fixture.chain.membership.mockImplementationOnce(async () => { await membershipWait; return fixture.proof; });
  const choose = customSteps().find(step => step.pattern.text === '{actor} taps "Choose your name"')!;
  const attach = vi.fn(async () => undefined);
  const pending = choose.run({ lab: { attach } } as unknown as StepContext, 'Ada');
  await Promise.resolve(); await Promise.resolve();
  expect(fixture.choice.click).not.toHaveBeenCalled(); expect(fixture.chain.membership).not.toHaveBeenCalled();
  now = 11_000; recognized();
  for (let i = 0; i < 8; i++) await Promise.resolve();
  expect(fixture.chain.membership).toHaveBeenCalledWith('game-account', 590_000);
  expect(fixture.choice.click).not.toHaveBeenCalled();
  now = 21_000; included(); await pending;
  expect(fixture.choice.click).toHaveBeenCalledWith({ timeout: 580_000 });
  expect(attach).toHaveBeenCalledWith({ recognition: expect.any(Object), membership: fixture.proof });
  expect(fixture.chain.until).toHaveBeenCalledWith('app registered personhood recognition', expect.any(Function), 600_000);
  expect(choose.timeoutMs).toBe(660_000);
});
it('member setup dismisses the promotion and claim flow, then asserts the home is visible', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(1000);
  let screen = 'promotion';
  const click = vi.fn(async () => { screen = screen === 'promotion' ? 'claim' : 'home'; return undefined; });
  const heading = vi.fn(async () => { expect(screen).toBe('claim'); return undefined; });
  const home = vi.fn(async () => { expect(screen).toBe('home'); return undefined; });
  fixture.actor.view.page.getByRole.mockImplementation((role, options) => {
    if (role === 'heading') { expect(options?.name).toBe('Choose your name'); return { click, waitFor: heading }; }
    expect(options?.name).toBe('Not now'); return { click, waitFor: heading };
  });
  fixture.actor.view.page.getByTestId.mockImplementation(id => { expect(id).toBe('humanity-home'); return { click, waitFor: home }; });
  const member = customSteps().find(step => step.pattern.text === '{actor} is a member')!;
  await member.run({ lab: { attach: vi.fn(async () => undefined) } } as unknown as StepContext, 'Ada');
  expect(click).toHaveBeenCalledTimes(2);
  expect(heading).toHaveBeenCalledWith({ state: 'visible', timeout: 600_000 });
  expect(home).toHaveBeenCalledWith({ state: 'visible', timeout: 600_000 });
  expect(screen).toBe('home');
});

it.each(['', '.paseo'])('A3 checks the actual card using the host suffix %s and keeps the chain-name step', async suffix => {
  const home = await import('../../../../lab/shared/home.ts');
  vi.spyOn(home, 'confirmNameClaim').mockResolvedValue();
  fixture.field.waitFor.mockResolvedValueOnce(undefined as never);
  const bare = 'adalab' + 'b'.repeat(16), expected = bare + suffix;
  fixture.actor.view.username = 'adalab.04' + suffix;
  fixture.actor.view.page.getByRole.mockImplementation(() => fixture.choice);
  fixture.actor.view.page.evaluate.mockImplementation(async fn => {
    const source = String(fn);
    return source.includes('card-username') ? expected : source.includes('card-label') ? 'Member' : `Your name is ${bare}`;
  });
  fixture.chain.until.mockImplementation(async (_label, read) => { const result = await read(); if (result === undefined) throw Error('not observed'); return result; });
  const attach = vi.fn(async () => undefined), context = { lab: { attach } } as unknown as StepContext;
  await customSteps().find(step => step.pattern.text === '{actor} claims her member username')!.run(context, 'Ada');
  expect(fixture.actor.view.username).toBe(expected);
  expect(attach).toHaveBeenCalledWith({ fullUsername: expected });
  await customSteps().find(step => step.pattern.text === "{actor}'s card shows her claimed member username")!.run(context, 'Ada');
  expect(customSteps().some(step => step.pattern.text === "{actor}'s full username resolves on chain")).toBe(true);
});
it('checkpoints finality before every When or Then step, never inside the Given block', async () => {
  expect(checkpointHooks).toHaveLength(1);
  expect(checkpointHooks[0]![0]).toEqual({ timeout: 240_000 });
  const hook = checkpointHooks[0]![1] as unknown as (argument: { pickleStep: { type: string; text: string } }) => Promise<void>;
  await hook({ pickleStep: { type: 'Context', text: 'Ada is a member' } });
  expect(fixture.chain.checkpoint).not.toHaveBeenCalled();
  await hook({ pickleStep: { type: 'Action', text: 'Ada opens peopl at /' } });
  await hook({ pickleStep: { type: 'Outcome', text: 'Ada sees the attendance row:' } });
  // An untyped step is treated as the journey: an extra checkpoint costs time, a missing one costs fidelity.
  await hook({ pickleStep: { type: 'Unknown', text: 'legacy step' } });
  expect(fixture.chain.checkpoint.mock.calls).toEqual([['before "Ada opens peopl at /"'], ['before "Ada sees the attendance row:"'], ['before "legacy step"']]);
});
it('@negative-control A2 checkpoints the bots\' fast sign-ups before reading their registration at the finalized head', async () => {
  const bots = [{ name: 'Bot 1', address: 'bot-1' }, { name: 'Bot 2', address: 'bot-2' }];
  fixture.bots.splice(0, fixture.bots.length, ...bots);
  try {
    // A fast enroll returns on inclusion; the finalized head shows the sign-ups only once the checkpoint has awaited them.
    let finalized = false;
    fixture.chain.checkpoint.mockImplementationOnce(async () => { finalized = true; return undefined; });
    fixture.chain.read.mockImplementation(async () => ({ at: { hash: finalized ? 'f2' : 'f1' }, value: finalized ? { registered: true } : undefined }));
    const attach = vi.fn(async () => undefined);
    const registered = customSteps().find(step => step.pattern.text === '{int} lab players are registered for the game by transaction')!;
    await registered.run({ lab: { attach } } as unknown as StepContext, 2);
    expect(fixture.chain.enroll).toHaveBeenCalledWith(bots, [fixture.actor.game, ...bots]);
    expect(fixture.chain.checkpoint).toHaveBeenCalledWith('before the lab player registration read');
    expect(fixture.chain.enroll.mock.invocationCallOrder[0]).toBeLessThan(fixture.chain.checkpoint.mock.invocationCallOrder[0]!);
    expect(fixture.chain.checkpoint.mock.invocationCallOrder[0]).toBeLessThan(fixture.chain.read.mock.invocationCallOrder[0]!);
    expect(fixture.chain.read.mock.calls.map(c => c[2])).toEqual(bots.map(b => [{ type: 'Account', value: b.address }]));
    expect(attach).toHaveBeenCalledTimes(2);
  } finally { fixture.bots.splice(0); }
});
