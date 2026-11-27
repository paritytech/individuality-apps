// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { expect, it, vi } from 'vitest';
import type { BrowserPage } from '@parity/product-lab/ports/browser';
import { confirmNameClaim, returnToHomeFromNameClaim } from '../../../../lab/shared/home.ts';
const { JSDOM } = createRequire(import.meta.url)('jsdom') as { JSDOM: new (html: string) => { window: Window & typeof globalThis } };

it('confirms only after the armed hint and the page-clock guard pass, without a bare sleep', async () => {
  const dom = new JSDOM('<body><form class="name-form"><button>Claim adalab</button></form></body>');
  const document = dom.window.document;
  let now = 1000, armedAt = 0, submitted = false;
  const clicks: string[] = [];
  const waitFor = vi.fn(async () => { expect(document.body.textContent).toContain('Tap again to confirm.'); });
  const page = {
    getByRole: (_role: string, options: { name: string }) => ({ click: async () => {
      clicks.push(options.name);
      if (options.name === 'Claim adalab') { armedAt = now; document.body.innerHTML = '<form class="name-form"><p>Tap again to confirm.</p><button>Confirm adalab</button></form>'; }
      else if (now - armedAt >= 500) submitted = true; // The app's real CONFIRM_GUARD_MS.
    } }), getByText: () => ({ waitFor }),
    evaluate: async () => now,
    waitForFunction: vi.fn(async (fn: (arg: unknown) => boolean, arg: unknown) => {
      Object.defineProperty(document.body, 'innerText', { get: () => document.body.textContent });
      const sample = () => runInNewContext(`(${fn.toString()})(arg)`, { arg, document, Date: { now: () => now } });
      expect(sample()).toBe(false); now = armedAt + 499; expect(sample()).toBe(false);
      now = armedAt + 550; expect(sample()).toBe(true);
      document.querySelector('p')!.textContent = 'The form is no longer armed'; expect(sample()).toBe(false);
      document.querySelector('p')!.textContent = 'Tap again to confirm.'; expect(sample()).toBe(true);
    }),
  } as unknown as BrowserPage;
  await confirmNameClaim(page, 'adalab');
  expect(waitFor).toHaveBeenCalledWith({ state: 'visible', timeout: 10_000 });
  expect(page.waitForFunction).toHaveBeenCalledOnce();
  expect(clicks).toEqual(['Claim adalab', 'Confirm adalab']); expect(submitted).toBe(true);
});

it('shares 600 seconds across claim-heading, back and home waits', async () => {
  let now = 1000;
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
  const heading = vi.fn(async () => { now += 400_000; });
  const back = vi.fn(async () => { now += 1000; });
  const home = vi.fn(async () => undefined);
  const page = { getByRole: (role: string) => role === 'heading' ? { waitFor: heading } : { click: back }, getByTestId: () => ({ waitFor: home }) } as unknown as BrowserPage;
  try {
    await returnToHomeFromNameClaim(page);
    expect(heading).toHaveBeenCalledWith({ state: 'visible', timeout: 600_000 });
    expect(back).toHaveBeenCalledWith({ timeout: 200_000 });
    expect(home).toHaveBeenCalledWith({ state: 'visible', timeout: 199_000 });
    expect(heading.mock.invocationCallOrder[0]).toBeLessThan(back.mock.invocationCallOrder[0]!);
  } finally { clock.mockRestore(); }
});
