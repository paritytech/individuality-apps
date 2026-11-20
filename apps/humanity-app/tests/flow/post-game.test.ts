// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { LONG_WAIT_BOUND_MS, viewGameResults } from '../../lab/flows/post-game.ts';
import { continueToDim2Results } from '../../../../lab/shared/upstream/lab/steps/dim2/results.ts';
import type { BrowserPage } from '@parity/product-lab/ports/browser';
function surface(state: { path: string; game?: string; buttons: Array<{ name: string; enabled: boolean }>; noIdentity?: boolean; slow?: boolean }) {
  return { evaluate: async () => ({ heading: true, gameLabel: true, scene: false, noIdentity: false, slow: false, restart: false, ...state }), locator: () => ({ evaluate: async (_read: unknown, query?: unknown) => query ? [] : state }),
    getByRole: () => ({ click: async () => { throw new Error('Results must not claim or leave the chest'); } }) } as unknown as BrowserPage;
}
it('@negative-control reproduces the exact original root-path error', async () => {
  await expect(continueToDim2Results(surface({ path: '/', buttons: [] }))).rejects.toThrow("DIM2 left the post-game path at /; expected /results + Done or the chest's Continue");
});
it('opens the selected game chest and stops before Continue', async () => {
  const state = { path: '/', game: undefined as string | undefined, buttons: [{ name: 'Continue', enabled: true }] }, paths: string[] = [];
  const result = await viewGameResults(surface(state), 308, async path => { paths.push(path); Object.assign(state, { path: '/chest', game: '308' }); });
  expect(paths).toEqual(['/chest?game=308']); expect(result.results.controls).toEqual([]); expect(result.entryPaths).toEqual(['/chest']);
  expect(result.reveal).toBe('nothing-screen');
});
it('@negative-control refuses a different game, unsupported route and a home page that never reaches the chest', async () => {
  await expect(viewGameResults(surface({ path: '/chest', game: '307', buttons: [] }), 308, async () => {})).rejects.toThrow('different game');
  await expect(viewGameResults(surface({ path: '/missing', buttons: [] }), 308, async () => {})).rejects.toThrow('supported path');
  await expect(viewGameResults(surface({ path: '/', buttons: [] }), 308, async () => {}, { timeoutMs: 0 })).rejects.toThrow('did not open the selected game chest');
});
it('runs actual results and final credit steps for all actors and preserves the exact wrong-credit mismatch', () => {
  const fixture = fileURLToPath(new URL('./fixtures/post-game-sequence.mts', import.meta.url));
  const output = execFileSync('node', ['--import', 'tsx', fixture], { encoding: 'utf8', timeout: 30_000 });
  expect(output).toContain('actual results group and all three credit steps pass');
  expect(output).toContain('actual step 19 attaches navigation before reopen, installs after open, and snapshots on timeout');
  expect(output).toContain('2 DIM2 credits to keep, not 3');
}, 35_000);

it('waits through the real front-door home transition and the known document-replacement race', async () => {
  const page = surface({ path: '/chest', game: '308', buttons: [{ name: 'Continue', enabled: true }] });
  let reads = 0;
  page.evaluate = (async () => {
    if (++reads === 1) throw new Error('page.evaluate: Execution context was destroyed, most likely because of a navigation');
    return reads === 2 ? { path: '/', game: null } : { path: '/chest', game: '308', heading: true, gameLabel: true, scene: false, noIdentity: false, slow: false, restart: false, buttons: [{ name: 'Continue', enabled: true }] };
  }) as typeof page.evaluate;
  expect((await viewGameResults(page, 308, async () => {})).entryPaths).toEqual(['/', '/chest']);
});

it('@negative-control rejects noIdentity even with an enabled Continue', async () => {
  const attached: unknown[] = [];
  await expect(viewGameResults(surface({ path: '/chest', game: '308', buttons: [{ name: 'Continue', enabled: true }], noIdentity: true }), 308, async () => {},
    { attach: async view => { attached.push(view); } })).rejects.toThrow('no player identity');
  expect(attached).toHaveLength(1);
});
it('@negative-control never counts the long-wait skip as results, and waits for it only up to the long-wait bound', async () => {
  const attached: unknown[] = [], seen: number[] = [];
  let now = 1_000_000;
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => (now += 10_000));
  try {
    const page = surface({ path: '/chest', game: '308', buttons: [{ name: 'Continue', enabled: true }], slow: true });
    const read = page.evaluate; page.evaluate = (async (...args: unknown[]) => { seen.push(now); return (read as (...a: unknown[]) => unknown)(...args); }) as typeof page.evaluate;
    await expect(viewGameResults(page, 308, async () => {}, { timeoutMs: 30_000, attach: async view => { attached.push(view); } }))
      .rejects.toThrow('long-wait skip while its results settle');
    expect(attached).toHaveLength(1);
    // The 30 s bound grew to the long-wait bound once the notice showed, and no further.
    expect(seen.at(-1)! - 1_000_000).toBeGreaterThan(LONG_WAIT_BOUND_MS - 60_000);
    expect(now - 1_000_000).toBeLessThan(LONG_WAIT_BOUND_MS + 60_000);
  } finally { clock.mockRestore(); }
}, 20_000);
it('waits through the long-wait notice until the claims replace it', async () => {
  const page = surface({ path: '/chest', game: '308', buttons: [{ name: 'Continue', enabled: true }] });
  let reads = 0;
  page.evaluate = (async () => ({ path: '/chest', game: '308', heading: true, gameLabel: true, scene: true, noIdentity: false, restart: false,
    slow: ++reads <= 3, buttons: [{ name: 'Continue', enabled: true }] })) as typeof page.evaluate;
  const result = await viewGameResults(page, 308, async () => {});
  // Continue after the notice may be on a bubble that never opened, so it is not recorded as a revealed chest.
  expect(reads).toBe(4); expect(result.results.controls).toEqual([]); expect(result.reveal).toBe('backstop-or-late');
  expect(result.longWaitShownMs).not.toBeNull();
});
it('handles the permission entry with one real Allow access UI tap', async () => {
  const page = surface({ path: '/chest', game: '308', buttons: [{ name: 'Continue', enabled: true }] });
  let tapped = 0;
  page.evaluate = (async () => tapped ? { path: '/chest', game: '308', heading: true, gameLabel: true, buttons: [{ name: 'Continue', enabled: true }] }
    : { path: '/permissions', game: null, buttons: [{ name: 'Allow access', enabled: true }] }) as typeof page.evaluate;
  page.getByRole = ((role: string, options: { name: string }) => { expect(role).toBe('button'); expect(options.name).toBe('Allow access'); return { click: async () => { tapped++; } }; }) as typeof page.getByRole;
  expect((await viewGameResults(page, 308, async () => {})).permissions).toEqual(['Allow access']); expect(tapped).toBe(1);
});

it('serializes the actual tsx-loaded chest reader into a page realm without compiler helpers', () => {
  const fixture = fileURLToPath(new URL('./fixtures/chest-observation.mts', import.meta.url));
  expect(execFileSync('node', ['--import', 'tsx', fixture], { encoding: 'utf8', timeout: 30_000 }))
    .toContain('tsx-loaded chest observation executes in the page realm without compiler helpers');
}, 35_000);
