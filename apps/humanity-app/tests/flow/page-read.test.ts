// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, it, expect, vi } from 'vitest';
import type { BrowserPage } from '@parity/product-lab/ports/browser';
import { readWatchedText, readFlowView } from '../../../../lab/shared/watched-text.ts';
afterEach(() => vi.unstubAllGlobals());
const navigating = 'page.evaluate: Execution context was destroyed, most likely because of a navigation';
it('skips exactly one interrupted observation and reads the next document', async () => {
  const evaluate = vi.fn().mockRejectedValueOnce(new Error(navigating)).mockResolvedValueOnce('ready');
  const page = { evaluate } as unknown as BrowserPage;
  expect(await readWatchedText(page, () => 'unread')).toBeNull();
  expect(await readWatchedText(page, () => 'unread')).toBe('ready');
  expect(evaluate).toHaveBeenCalledTimes(2);
});
it('@negative-control: preserves every other browser error', async () => {
  for (const message of ['page.evaluate: Target page has been closed', 'Cannot read properties of null', 'Execution context was destroyed', 'page.evaluate: Timeout 30000ms exceeded']) {
    const error = new Error(message), page = { evaluate: vi.fn().mockRejectedValue(error) } as unknown as BrowserPage;
    await expect(readWatchedText(page, () => '')).rejects.toBe(error);
  }
});
it('uses the navigation-tolerant read for the complete flow view', async () => {
  const evaluate = vi.fn().mockRejectedValueOnce(new Error(navigating)).mockResolvedValueOnce({text:'ready',markers:[],buttons:[]});
  const page = { evaluate } as unknown as BrowserPage;
  expect(await readFlowView(page)).toBeNull(); expect(await readFlowView(page)).toMatchObject({text:'ready'});
});
it('treats an absent body during loading as an empty observation', async () => {
  vi.stubGlobal('document', { body:null, querySelectorAll:()=>[], querySelector:()=>null });
  const page = { evaluate: async (read: () => unknown) => read() } as unknown as BrowserPage;
  expect(await readFlowView(page)).toMatchObject({text:'',markers:[],buttons:[]});
});
