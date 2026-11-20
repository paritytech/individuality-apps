// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import type { BrowserPage } from '@parity/product-lab/ports/browser';
import type { View } from '../../apps/humanity-app/lab/flows/guards.mjs';

/** Defer one observation during document replacement; preserve every other browser error. */
export async function readWatchedText<T>(page: Pick<BrowserPage, 'evaluate'>, read: () => T): Promise<T | null> {
  try { return await page.evaluate(read, undefined); }
  catch (error) {
    const message = error && typeof error === 'object' && 'message' in error ? error.message : undefined;
    if (typeof message === 'string' && /^page\.evaluate: Execution context was destroyed, most likely because of a navigation/.test(message)) return null;
    throw error;
  }
}
export async function readFlowView(page: Pick<BrowserPage, 'evaluate'>): Promise<View | null> {
  return readWatchedText(page, () => ({ text: document.body?.innerText ?? '',
    markers: Array.from(document.querySelectorAll('[data-testid]')).map(el => ({ id: el.getAttribute('data-testid') ?? '', attrs: { 'data-card-state': el.getAttribute('data-card-state') ?? '' } })),
    buttons: Array.from(document.querySelectorAll('button')).filter(b => b.getClientRects().length > 0).map(b => ({ text: b.textContent?.trim() ?? '', aria: b.getAttribute('aria-label') ?? '', disabled: b.disabled })),
    card: { status: document.querySelector('[data-testid="card-label"]')?.textContent?.trim() },
  }));
}
