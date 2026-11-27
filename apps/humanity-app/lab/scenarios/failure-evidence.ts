// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import type { ITestStepHookParameter, IWorld } from '@cucumber/cucumber';
import { PageFrameCapture } from '@parity/product-lab/browser-playwright';
import type { BrowserPage } from '@parity/product-lab/ports/browser';
import { opened } from '../opening/session.ts';
import { scenario } from '../../../../lab/shared/session.ts';
import { jsonEvidence } from '../../../../lab/shared/observations.ts';
import { consoleLimits, type ConsoleHistory } from '../../../../lab/shared/console-history.ts';

async function bounded<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([work, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(Error('Failure evidence timed out')), ms); })]); }
  finally { clearTimeout(timer); }
}

/** Cucumber's AfterStep runs even when its outer step timer, or an opening step, fails.
 * Its attachment API is the same API product-lab's lab.attach forwards to, with PNG support.
 * Diagnostic failures are recorded as gaps and never replace the original failed result.
 * The app console (bounded and sanitized when recorded, see lab/shared/console-history.ts) is attached first: an app that
 * logs its own failure, such as a refused claim, names the cause even when the page only shows a timeout.
 */
export function failureEvidenceHook(pages = () => Array.from(opened, ([id, view]) => ({ id, page: view.page })), readGame = () => scenario().chain.read('Game', 'Game'),
  consoleHistory: () => Pick<ConsoleHistory, 'attachment'> = () => scenario().network.consoleHistory) {
  return async function (this: Pick<IWorld, 'attach'>, { result, pickleStep }: Pick<ITestStepHookParameter, 'result' | 'pickleStep'>) {
    if (result?.status !== 'FAILED') return;
    const gaps: string[] = [];
    try {
      // The byte bound covers the whole attachment, wrapper included; the step text is cut so the wrapper stays small.
      const { json, pages: lines } = consoleHistory().attachment(pages => ({ productLab: 'humanity-failure-console', step: pickleStep.text.slice(0, 500),
        limits: { linesPerPage: consoleLimits.perPage, charsPerLine: consoleLimits.textChars, bytes: consoleLimits.attachBytes }, pages }));
      if (!lines.some(page => page.entries.length)) gaps.push('No app console line was recorded');
      else await this.attach(json, 'application/json');
    } catch (error) { gaps.push(`Console: ${String(error)}`); }
    try { await this.attach(JSON.stringify({ productLab: 'humanity-failure-chain', storage: 'Game.Game', read: jsonEvidence(await bounded(readGame(), 3000)) }), 'application/json'); }
    catch (error) { gaps.push(`Game.Game: ${String(error)}`); }
    try {
      const current = pages();
      if (!current.length) gaps.push('No actor page exists at this failed step');
      for (const { id, page } of current) {
        try {
          const image = await bounded(new PageFrameCapture({ pages: () => page, timeoutMs: 5000 }).capture(id), 6000);
          if (image.status === 'captured') await this.attach(Buffer.from(image.bytes), 'image/png');
          else gaps.push(image.reason);
        } catch (error) { gaps.push(`Screenshot: ${String(error)}`); }
        try {
          const view = await bounded(page.evaluate(() => ({
            url: location.href, text: document.body?.innerText ?? '',
            markers: Array.from(document.querySelectorAll('[data-testid]')).map(el => ({ id: el.getAttribute('data-testid'), state: el.getAttribute('data-card-state'), visible: Boolean(el.getClientRects().length) })),
            dialogs: Array.from(document.querySelectorAll('dialog[open], [role="dialog"]')).map(el => ({ text: (el as HTMLElement).innerText, visible: Boolean(el.getClientRects().length) })),
          }), undefined), 3000);
          await this.attach(JSON.stringify({ productLab: 'humanity-failure-page', actor: id, step: pickleStep.text, ...view }), 'application/json');
        } catch (error) { gaps.push(`Visible text: ${String(error)}`); }
        try {
          const body = page.locator('body') as ReturnType<BrowserPage['locator']> & { ariaSnapshot?: (options: { timeout: number }) => Promise<string> };
          if (body.ariaSnapshot) await this.attach(await bounded(body.ariaSnapshot({ timeout: 1500 }), 2000), 'text/plain');
          else gaps.push('Accessibility snapshot is not exposed by this browser adapter');
        } catch (error) { gaps.push(`Accessibility: ${String(error)}`); }
      }
    } catch (error) { gaps.push(`Failure evidence: ${String(error)}`); }
    try { await this.attach(JSON.stringify({ productLab: 'humanity-failure-evidence', step: pickleStep.text, gaps }), 'application/json'); }
    catch { /* Preserve the original failure even if the report attachment transport has failed. */ }
  };
}
