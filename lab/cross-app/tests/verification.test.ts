// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { expect, it } from 'vitest';
import { backgroundVerification } from '../verification.ts';
import { assertVerificationAfter, journeyBreakdown } from '../timing.ts';
import { browserAvailable } from '../../../apps/humanity-app/tests/chromium.ts';
import { observedCandidate, returnedCardReady } from '../journey-observations.ts';
const reader = { app: 'Humanity', head: 'finalized' as const, how: 'test endpoint' };
it('starts reads without delaying a return, then validates after all endpoint clocks have closed', async () => {
  let clock = 10, resolve!: (value: number) => void;
  const proof = backgroundVerification(() => new Promise<number>(done => { resolve = done; }), () => clock);
  await Promise.resolve();
  const primary = { start: 0, end: 100 }, cta = { start: 50, end: 100 }, recovery = { start: 20, end: 80 };
  clock = 100; const checked = proof.after([primary, cta, recovery]); clock = 150; resolve(42);
  const result = await checked;
  expect(result).toMatchObject({ value: 42, verification: { at: 100, done: 150, readStartedAt: 10, excluded: true } });
  const measured = journeyBreakdown({ direction: 'C4', run: '1', reader, ...primary, points: [], verification: result.verification });
  expect(measured.totalMs).toBe(100); expect(measured.segments.some(s => /verification/.test(s.name))).toBe(false);
});
it('@negative-control: a verification overlap or pre-return wait cannot enter a measured endpoint', () => {
  for (const verification of [{ at: 90, done: 120 }, { at: -30, done: -10 }])
    expect(() => journeyBreakdown({ direction: 'C4', run: '1', reader, start: 0, end: 100, points: [], verification })).toThrow('outside and after');
  expect(() => assertVerificationAfter({ at: 100, done: 110 }, [{ start: 0, end: 105 }])).toThrow('outside and after');
});
it('@negative-control: an early read rejection is retained and fails the row after measurement', async () => {
  let clock = 10;
  const proof = backgroundVerification(async () => { throw Error('bad finalized votes'); }, () => clock);
  await Promise.resolve(); clock = 100;
  await expect(proof.after([{ start: 0, end: 100 }])).rejects.toThrow('bad finalized votes');
});
it('observes first-game progress immediately but still rejects a different finalized threshold afterward', () => {
  const view = { humanity: 'next', jollity: null, enabled: [], cardName: 'Ada', cardState: 'candidate', cardScore: '1', cardAccount: 'owner', cardProgress: 'Progress to membership: 1 of 7' };
  expect(observedCandidate(view, 0, 'owner')).toEqual({ score: 1, threshold: 7, owner: 'owner' });
  expect(returnedCardReady(view, 42, 'next', { score: 1, threshold: 8, owner: 'owner' })).toBe(false);
  expect(observedCandidate(view, 1, 'owner')).toBeUndefined(); expect(observedCandidate(view, 0, 'other')).toBeUndefined();
});
it('@negative-control: prepared CI controls fail if Chromium is missing; source-only jobs retain optional browser tests', () => {
  expect(() => browserAvailable('missing-chromium-control', { ci: 'true', required: '1' })).toThrow('require installed Chromium');
  expect(browserAvailable('missing-chromium-control', { ci: 'true', required: '' })).toBe(false);
});
