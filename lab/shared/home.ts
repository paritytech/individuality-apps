// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import type { BrowserPage } from '@parity/product-lab/ports/browser';
import { readWatchedText } from './watched-text.ts';

/** Answer only the actual urgent sheet, through its normal dismiss control. */
export async function dismissCautionSheet(page: BrowserPage): Promise<boolean> {
  const open = await readWatchedText(page, () => Boolean(document.querySelector('dialog.caution-sheet[open]')?.getClientRects().length));
  if (!open) return false;
  const later = page.locator('dialog.caution-sheet[open] button.cta-ghost');
  if ((await later.textContent({ timeout: 5000 }))?.trim() !== 'Not this week') throw Error('Unknown caution-sheet dismiss control');
  await later.click({ timeout: 5000 });
  return true;
}

/** Promotion dismissal opens the claim route; its own back control dismisses the action and returns home. */
export async function returnToHomeFromNameClaim(page: BrowserPage): Promise<void> {
  const deadline = Date.now() + 600_000;
  await page.getByRole('heading', { name: 'Choose your name', exact: true }).waitFor({ state: 'visible', timeout: Math.max(1, deadline - Date.now()) });
  await page.getByRole('button', { name: 'Not now', exact: true }).click({ timeout: Math.max(1, deadline - Date.now()) });
  await page.getByTestId('humanity-home').waitFor({ state: 'visible', timeout: Math.max(1, deadline - Date.now()) });
}

export async function confirmNameClaim(page: BrowserPage, name: string): Promise<void> {
  await page.getByRole('button', { name: `Claim ${name}`, exact: true }).click({ timeout: 600_000 });
  await page.getByText('Tap again to confirm.', { exact: true }).waitFor({ state: 'visible', timeout: 10_000 });
  // Observe in the page after arming: the app's armedAt is earlier. Its guard is 500 ms.
  const observedAt = await page.evaluate(() => Date.now(), undefined);
  await page.waitForFunction(({ observedAt, name }) => Date.now() - observedAt >= 550 &&
    document.body.innerText.includes('Tap again to confirm.') && Array.from(document.querySelectorAll<HTMLButtonElement>('.name-form button'))
      .some(button => button.textContent?.trim() === `Confirm ${name}` && !button.disabled), { observedAt, name }, { timeout: 10_000 });
  await page.getByRole('button', { name: `Confirm ${name}`, exact: true }).click();
}
