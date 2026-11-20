// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { beforeEach, expect, it, vi } from 'vitest';
import { customSteps, type StepContext } from '@parity/product-lab/steps';
const fixture = vi.hoisted(() => ({ game: { at: { hash: 'finalized', number: 20 }, value: { state: { type: 'Registration' }, game_date: 1000 } }, read: vi.fn(), view: { mode: 'registration-open', value: 'Thursday 10:29 AM' }, page: { evaluate: vi.fn() }, watch: vi.fn(), checkpoint: vi.fn(async () => undefined),
  until: vi.fn(async (_label: string, read: () => Promise<unknown>, _ms?: number): Promise<unknown> => { const value = await read(); if (!value) throw Error('Expected state not observed'); return value; }),
}));
vi.mock('../../../../lab/shared/session.ts', () => ({ scenario: () => ({
  actor: () => ({ view: { page: fixture.page } }), chain: { current: { playsAt: 1000 }, next: { game_play_time: 1000 }, read: fixture.read, until: fixture.until, checkpoint: fixture.checkpoint },
}) }));
vi.mock('../../../../lab/shared/observations.ts', async original => ({ ...await original<object>(), formattedDate: async () => 'Thursday 10:29 AM',
  nextGame: async () => fixture.view, watchNextGame: fixture.watch,
}));
import '../../lab/scenarios/steps.ts';
beforeEach(() => { vi.clearAllMocks(); fixture.read.mockResolvedValue(fixture.game); fixture.view = { mode: 'registration-open', value: 'Thursday 10:29 AM' }; });
it('requires finalized Game.Registration and the matching registration-open UI after scheduling on an idle chain', async () => {
  fixture.read.mockResolvedValue(fixture.game);
  const attach = vi.fn(async () => undefined);
  const check = customSteps().find(step => step.pattern.text === '{actor} sees the next-game block in mode "registration-open" with the scheduled time')!;
  await check.run({ lab: { attach } } as unknown as StepContext, 'Ada');
  expect(fixture.read).toHaveBeenCalledWith('Game', 'Game');
  expect(attach).toHaveBeenCalledWith({ nextGameRegistration: fixture.game });
  fixture.read.mockResolvedValue({ ...fixture.game, value: { ...fixture.game.value, state: { type: 'Shuffle' } } });
  await expect(check.run({ lab: { attach } } as unknown as StepContext, 'Ada')).rejects.toThrow('Expected state not observed');
});

it.each(['chain-date', 'ui-date', 'upcoming'])('rejects incorrect A2 evidence: %s', async problem => {
  if (problem === 'chain-date') fixture.read.mockResolvedValue({ ...fixture.game, value: { ...fixture.game.value, game_date: 999 } });
  if (problem === 'ui-date') fixture.view.value = 'Thursday 10:28 AM';
  if (problem === 'upcoming') fixture.view.mode = 'upcoming';
  const check = customSteps().find(step => step.pattern.text === '{actor} sees the next-game block in mode "registration-open" with the scheduled time')!;
  await expect(check.run({ lab: { attach: vi.fn(async () => undefined) } } as unknown as StepContext, 'Ada')).rejects.toThrow('Expected state not observed');
});

it('starts the continuous game watch only after the app has confirmed this game', async () => {
  // CI first rendered a future game from its schedule, before the next current-game poll.
  fixture.view = { mode: 'upcoming', value: 'Thursday 10:29 AM' };
  fixture.until.mockImplementationOnce(async (_label, read) => {
    expect(await read()).toBeUndefined();
    expect(fixture.watch).not.toHaveBeenCalled();
    fixture.view = { mode: 'confirmed', value: 'Thursday 10:29 AM' };
    return read();
  });
  const watch = customSteps().find(step => step.pattern.text === 'the lab watches the next-game block throughout the game')!;
  await watch.run({ lab: { attach: vi.fn(async () => undefined) } } as unknown as StepContext);
  expect(fixture.checkpoint).toHaveBeenCalledWith('before watching the game');
  expect(fixture.until).toHaveBeenCalledWith('app confirmed the watched game', expect.any(Function), 45_000);
  expect(fixture.checkpoint.mock.invocationCallOrder[0]).toBeLessThan(fixture.until.mock.invocationCallOrder[0]!);
  expect(fixture.watch).toHaveBeenCalledExactlyOnceWith(fixture.page);
  expect(watch.timeoutMs).toBe(240_000);
});

it.each(['upcoming', 'wrong-date'])('@negative-control refuses to start the game watch from %s', async problem => {
  fixture.view = problem === 'upcoming' ? { mode: 'upcoming', value: 'Thursday 10:29 AM' } : { mode: 'confirmed', value: 'Thursday 10:28 AM' };
  const watch = customSteps().find(step => step.pattern.text === 'the lab watches the next-game block throughout the game')!;
  await expect(watch.run({ lab: { attach: vi.fn(async () => undefined) } } as unknown as StepContext)).rejects.toThrow('Expected state not observed');
  expect(fixture.watch).not.toHaveBeenCalled();
});
