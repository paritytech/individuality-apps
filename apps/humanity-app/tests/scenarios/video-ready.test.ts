// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { expect, it, vi } from 'vitest';
import type { BrowserPage } from '@parity/product-lab/ports/browser';
import { paintVideoFrames, waitForVideo } from './video-ready.ts';
it('draws frames before closing and waits for delayed encoder output', async () => {
  let painted = false, polls = 0;
  const evaluate = vi.fn(async (body: () => Promise<void>) => {
    // Exercise the actual browser callback with a compositor clock, not a source-text assertion.
    let time = 0;
    vi.stubGlobal('performance', { now: () => time });
    const fillRect = vi.fn();
    vi.stubGlobal('document', { createElement: () => ({ getContext: () => ({ fillRect }) }), body: { append: vi.fn() } });
    vi.stubGlobal('requestAnimationFrame', (frame: () => void) => { time += 100; queueMicrotask(frame); });
    try { await body(); expect(fillRect.mock.calls.length).toBeGreaterThanOrEqual(3); painted = true; }
    finally { vi.unstubAllGlobals(); }
  });
  await paintVideoFrames({ evaluate } as unknown as BrowserPage);
  const files = await waitForVideo(() => [{ bytes: painted && ++polls >= 3 ? 42 : 0 }]);
  expect(evaluate).toHaveBeenCalledOnce(); expect(polls).toBe(3); expect(files[0]!.bytes).toBeGreaterThan(0);
});
it('@negative-control: empty output and absent output still fail within a bound', async () => {
  await expect(waitForVideo(() => [{ bytes: 0 }], 30)).rejects.toThrow('non-empty');
  await expect(waitForVideo(() => [], 30)).rejects.toThrow('non-empty');
});
