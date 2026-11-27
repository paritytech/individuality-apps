// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { expect, it, vi } from 'vitest';
import { customSteps, type StepContext } from '@parity/product-lab/steps';
const fixture = vi.hoisted(() => {
  const registering = { at: { hash: 'h1', number: 1 }, value: { status: { type: 'Registering', value: { total_participants: 0 } }, info: { prize: 1n } } };
  const cancellation = { at: { hash: 'h2', number: 2 }, events: [{ type: 'Airdrop', value: { type: 'EventCanceled', value: { event_id: 'draw' } } }] };
  const read = vi.fn().mockResolvedValueOnce(registering).mockResolvedValue({ at: { hash: 'h2', number: 2 }, value: undefined });
  return { registering, cancellation, read };
});
vi.mock('../../../../lab/shared/session.ts', () => ({ scenario: () => ({
  actor: () => ({ product: 'product-zero', game: { address: 'game-account' } }),
  chain: { membership: async () => ({}), prepareDraw: async () => ({}), draw: { id: 'draw', fromBlock: 1 },
    read: fixture.read,
    findEvent: async () => fixture.cancellation,
    until: async (_label: string, read: () => Promise<unknown>) => { await read(); return read(); },
  },
}) }));
import '../../lab/scenarios/steps.ts';
it('keeps the missing-draw failure and attaches the prior registration state and indexed cancellation', async () => {
  const attach = vi.fn(async (_value: unknown) => undefined);
  const prepare = customSteps().find(step => step.pattern.text === "the lab opens today's draw with a 1 dollar prize that {actor} wins")!;
  await expect(prepare.run({ lab: { attach } } as unknown as StepContext, 'Ada')).rejects.toThrow('Daily draw disappeared');
  expect(attach).toHaveBeenCalledWith({ dailyDrawMissing: { id: 'draw', lastObserved: { ...fixture.registering, value: { ...fixture.registering.value, info: { prize: '1' } } }, cancellation: fixture.cancellation } });
});
