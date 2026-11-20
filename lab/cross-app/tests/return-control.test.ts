// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { expect, it, vi } from 'vitest';
import type { BrowserPage } from '@parity/product-lab/ports/browser';
import { returnFromDim2 } from '../../shared/upstream/lab/steps/dim2/results.ts';

it('records the trusted exit tap before the click and only after it succeeded', async () => {
  let clock = 1000, returned = false, clickedAt = 0;
  const marks: Array<{ at: number; path: string; name: string }> = [];
  vi.spyOn(Date, 'now').mockImplementation(() => clock++);
  const page = {
    locator: () => ({ evaluate: async (_fn: unknown, query?: unknown) => query ? [] : { path: '/chest', buttons: [{ name: 'Continue', enabled: true }] } }),
    getByRole: () => ({ click: async () => { clickedAt = Date.now(); returned = true; } }),
  } as unknown as BrowserPage;
  try {
    await returnFromDim2(page, () => returned, undefined, { onControl: mark => marks.push(mark) });
    expect(marks).toEqual([{ at: expect.any(Number), path: '/chest', name: 'Continue' }]);
    expect(marks[0]!.at).toBeLessThan(clickedAt);
  } finally { vi.restoreAllMocks(); }
});

it('negative control: a failed click cannot create a trusted tap mark', async () => {
  const marks: unknown[] = [];
  let clock = 1000, attempts = 0;
  vi.spyOn(Date, 'now').mockImplementation(() => clock++);
  const page = {
    locator: () => ({ evaluate: async (_fn: unknown, query?: unknown) => query ? [] : { path: '/chest', buttons: [{ name: 'Continue', enabled: true }] } }),
    getByRole: () => ({ click: async () => { attempts++; throw Error('click failed'); } }),
  } as unknown as BrowserPage;
  try {
    await expect(returnFromDim2(page, () => false, undefined, { timeoutMs: 3, onControl: mark => marks.push(mark) })).rejects.toThrow('did not return');
    expect(attempts).toBe(1); expect(marks).toEqual([]);
  } finally { vi.restoreAllMocks(); }
});
