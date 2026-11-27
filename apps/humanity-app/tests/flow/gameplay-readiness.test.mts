// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { LocatorRoot } from '@parity/product-lab/ports/browser';
import { playDim2InApp } from '../../../../lab/shared/upstream/lab/steps/dim2/live-game.ts';

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(100_000); window.history.replaceState(null, '', '/game'); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
function harness(kind: 'disabled' | 'verdict', permanent = false) {
  const started = Date.now(); let voted = false, completed = false;
  const page = { locator: (selector: string) => ({
    evaluate: async (read: (body: HTMLElement) => unknown) => {
      const blocked = permanent || Date.now() - started < 2000;
      document.body.innerHTML = completed ? '<canvas role="img" aria-label="Your chest opening"></canvas><footer style="opacity:0;pointer-events:none"><button>Continue</button></footer>' : `<div data-id="peer" data-tile-slot><div class="cursor-pointer" ${kind === 'verdict' && blocked ? '' : `data-tile-verdict="${voted ? 'approve' : 'pending'}"`}></div></div>`
        + (voted ? `<button ${kind === 'disabled' && blocked ? 'disabled' : ''}>Confirm votes</button>` : '');
      window.history.replaceState(null, '', completed ? '/chest' : '/game');
      return new Function('body', `return (${read.toString()})(body)`)(document.body);
    }, click: async () => { expect(selector).toContain('data-tile-verdict'); voted = true; },
  }), getByRole: () => ({ click: async () => { completed = true; } }) } as unknown as LocatorRoot;
  return { page, run: () => playDim2InApp(page, undefined, new AbortController().signal) };
}
it.each(['disabled', 'verdict'] as const)('waits for a transient %s UI condition, then votes and reaches the chest', async kind => {
  const h = harness(kind); const task = h.run().then(value => ({ value }), error => ({ error }));
  await vi.advanceTimersByTimeAsync(10_000);
  expect(await task).toMatchObject({ value: { sawGame: true, sawChest: true, votes: { views: expect.arrayContaining([expect.objectContaining({ view: expect.stringMatching(/^\/chest,/) })]) } } });
});
it.each([['disabled', 'leaves Confirm votes disabled'], ['verdict', 'tile has no displayed verdict']] as const)('@negative-control a persistent %s condition fails with its bounded reason', async (kind, message) => {
  const h = harness(kind, true); const task = h.run().then(() => null, error => error as Error);
  await vi.advanceTimersByTimeAsync(20_000);
  expect((await task)?.message).toMatch(new RegExp(`${message}.*UI condition timed out after 15000 ms`));
});
