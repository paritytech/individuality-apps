// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { setTimeout as delay } from 'node:timers/promises';
import type { BrowserPage } from '@parity/product-lab/ports/browser';
import { readWatchedText } from './watched-text.ts';

/** Self-contained for page serialization; read the current chest and its usable exit together. */
export function chestObservation() {
  const body = document.body, text = body?.innerText ?? '';
  const game = new URLSearchParams(location.search).get('game');
  // Object methods survive tsx serialization without an external function-naming helper.
  const helpers = {
    visible(el: Element) { return el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden'; },
    usable(el: HTMLButtonElement) {
      if (el.disabled || getComputedStyle(el).pointerEvents === 'none') return false;
      for (let parent: Element | null = el; parent; parent = parent.parentElement)
        if (getComputedStyle(parent).opacity === '0') return false;
      return true;
    },
  };
  // The shut Pocket is the album of this build: its Continue is the only usable exit once the pieces are in.
  const album = document.querySelector('.album-close, .pocket-claim[data-shut="true"]');
  return { path: location.pathname, game,
    noIdentity: /No player identity here/.test(text),
    slow: Array.from(document.querySelectorAll('[data-testid="chest-slow"]')).some(helpers.visible),
    restart: Array.from(document.querySelectorAll('[data-testid="chest-restart"]')).some(helpers.visible),
    heading: Array.from(document.querySelectorAll('h1')).some(el => helpers.visible(el) && el.textContent?.trim() === 'The chest'),
    gameLabel: game !== null && /^\d{1,10}$/.test(game) && Number(game) <= 0xffff_ffff && new RegExp('(?:^|\\n)Game #' + game + '(?:\\n|$)', 'i').test(text),
    scene: Array.from(document.querySelectorAll('[role="img"][aria-label="Your chest opening"]')).some(helpers.visible),
    closing: album !== null,
    // The overlay and the footer both say Continue. Only the album's button is usable while closing.
    buttons: Array.from((album ?? document).querySelectorAll('button')).filter(helpers.visible).map(el => ({
      name: el.textContent?.trim() ?? '',
      enabled: helpers.usable(el),
    })).filter(b => ['Continue', 'Claim all', 'Allow access', 'Done'].includes(b.name)) };
}
/** The Pocket offers Claim all where the album build offered Continue, and both lead on from an opened chest. */
export const CHEST_EXITS = ['Continue', 'Claim all'];
/** A scene is mounted before claims arrive; only an enabled Continue or Claim all proves a way on. */
export async function readChest(page: BrowserPage) {
  return readWatchedText(page, () => {
  const body = document.body, text = body?.innerText ?? '';
  const game = new URLSearchParams(location.search).get('game');
  // Object methods survive tsx serialization without an external function-naming helper.
  const helpers = {
    visible(el: Element) { return el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden'; },
    usable(el: HTMLButtonElement) {
      if (el.disabled || getComputedStyle(el).pointerEvents === 'none') return false;
      for (let parent: Element | null = el; parent; parent = parent.parentElement)
        if (getComputedStyle(parent).opacity === '0') return false;
      return true;
    },
  };
  // The shut Pocket is the album of this build: its Continue is the only usable exit once the pieces are in.
  const album = document.querySelector('.album-close, .pocket-claim[data-shut="true"]');
  return { path: location.pathname, game,
    noIdentity: /No player identity here/.test(text),
    slow: Array.from(document.querySelectorAll('[data-testid="chest-slow"]')).some(helpers.visible),
    restart: Array.from(document.querySelectorAll('[data-testid="chest-restart"]')).some(helpers.visible),
    heading: Array.from(document.querySelectorAll('h1')).some(el => helpers.visible(el) && el.textContent?.trim() === 'The chest'),
    gameLabel: game !== null && /^\d{1,10}$/.test(game) && Number(game) <= 0xffff_ffff && new RegExp('(?:^|\\n)Game #' + game + '(?:\\n|$)', 'i').test(text),
    scene: Array.from(document.querySelectorAll('[role="img"][aria-label="Your chest opening"]')).some(helpers.visible),
    closing: album !== null,
    // The overlay and the footer both say Continue. Only the album's button is usable while closing.
    buttons: Array.from((album ?? document).querySelectorAll('button')).filter(helpers.visible).map(el => ({
      name: el.textContent?.trim() ?? '',
      enabled: helpers.usable(el),
    })).filter(b => ['Continue', 'Claim all', 'Allow access', 'Done'].includes(b.name)) };
  });
}
export type ChestView = NonNullable<Awaited<ReturnType<typeof readChest>>>;
/** Jollity's backstop (lib/slow-payoff SLOW_PAYOFF_MS), armed when the chest page opens: past it, Continue
 *  is offered even on a bubble that never opened (chest-screen C9/C11). */
export const CHEST_BACKSTOP_MS = 60_000;
/** While the long-wait notice shows, a results walk may run this long: past Jollity's third pending reread, about
 *  210 s after the first read (apps/jollity-app/lib/chest-reread.ts: 30 s, 60 s, then every 120 s). */
export const LONG_WAIT_BOUND_MS = 240_000;
export type ChestReveal = 'opened' | 'backstop-or-late' | 'nothing-screen';
/** Reopen and reveal the selected payoff; reject identity loss, never take the long-wait skip, and never claim or leave it. */
export async function viewGameResults(page: BrowserPage, game: number, open: (path: string) => Promise<unknown>,
  options: { timeoutMs?: number; signal?: AbortSignal; attach?: (view: ChestView) => Promise<unknown> } = {}) {
  if (!Number.isSafeInteger(game) || game < 0) throw new Error('Invalid results game index');
  const requestedPath = `/chest?game=${game}`, started = Date.now();
  let deadline = started + (options.timeoutMs ?? 180_000), longWait: number | undefined;
  const entryPaths: string[] = [], permissions: string[] = [];
  let permissionTapped = false, previous = '', openingTaps = 0, nextOpeningTap = 0;
  let reason = 'no readable DIM2 view';
  options.signal?.throwIfAborted();
  // The lab enters before the page mounts, so the page's backstop cannot fire before this mark plus its wait.
  const entered = Date.now();
  await open(requestedPath);
  while (Date.now() < deadline) {
    options.signal?.throwIfAborted();
    const current = await readChest(page);
    if (current === null) {
      reason = 'document replacement; no readable DIM2 view';
      await delay(Math.min(250, Math.max(0, deadline - Date.now())), undefined, { signal: options.signal }); continue;
    }
    if (entryPaths.at(-1) !== current.path) entryPaths.push(current.path);
    // Only declared UI facts are attached; raw body text, URLs and arbitrary messages never leave the page.
    const safe = { ...current, path: ['/', '/permissions', '/chest'].includes(current.path) ? current.path : '[other route]', game: /^\d{1,10}$/.test(current.game ?? '') && Number(current.game) <= 0xffff_ffff ? current.game : null };
    if (JSON.stringify(safe) !== previous) { await options.attach?.(safe); previous = JSON.stringify(safe); }
    if (current.path === '/chest') {
      if (current.game !== String(game)) throw new Error('DIM2 opened results for a different game');
      if (current.noIdentity) throw new Error('DIM2 chest has no player identity');
      if (current.slow) {
        // Since Jollity's chest state machine, the long-wait notice also covers results that are still settling,
        // and its footer Continue is the skip. Never take it: wait for the claims, which replace the notice.
        reason = 'chest offers the long-wait skip while its results settle; waiting for them, never taking the skip';
        longWait ??= Date.now() - entered;
        deadline = Math.max(deadline, started + LONG_WAIT_BOUND_MS);
        await delay(Math.min(250, Math.max(0, deadline - Date.now())), undefined, { signal: options.signal });
        continue;
      }
      if (current.restart) throw new Error('DIM2 chest requires a connection restart');
      if (current.closing) throw new Error('DIM2 chest album is already closing');
      const backed = current.scene || (current.heading && current.gameLabel);
      const exit = current.buttons.some(b => b.enabled && CHEST_EXITS.includes(b.name));
      if (backed && exit) {
        // Continue comes when the bubble opens, or from the backstop. Popping pieces is optional play, so the
        // DOM has no opened marker. A Continue first seen inside the backstop window is a real opening; a later
        // one may be the backstop or a late opening, and is recorded as such rather than as a revealed chest.
        // After the long-wait notice, Continue is usable on a bubble that may never have opened: not a revealed chest.
        const reveal: ChestReveal = !current.scene ? 'nothing-screen'
          : longWait === undefined && Date.now() - entered < CHEST_BACKSTOP_MS ? 'opened' : 'backstop-or-late';
        return { requestedPath, entryPaths, permissions, openingTaps, reveal, longWaitShownMs: longWait ?? null, visibleChest: safe, results: { controls: [] } };
      }
      reason = current.scene ? 'chest is collecting or opening; waiting for an enabled Continue or Claim all'
        : backed ? 'identity-backed chest has no enabled exit' : 'selected chest has not shown identity-backed results';
      // The bubble can open automatically after collection, or early on a tap once a claim is in.
      // Empty/early taps are ignored. Retry only this gesture, at most once per second. A usable Continue
      // returned above, so an opened chest (which takes taps as piece input) is never tapped. Never tap Continue.
      if (current.scene && Date.now() >= nextOpeningTap) {
        options.signal?.throwIfAborted();
        if (Date.now() >= deadline) break;
        openingTaps++; nextOpeningTap = Date.now() + 1000;
        try {
          await page.getByRole('img', { name: 'Your chest opening', exact: true })
            .click({ timeout: Math.max(1, Math.min(1000, deadline - Date.now())) });
        } catch (error) {
          options.signal?.throwIfAborted();
          if (!(error instanceof Error) || (error.name !== 'TimeoutError' && !/Execution context was destroyed|Element is not attached|element was detached/.test(error.message))) throw error;
          reason = 'chest opening input raced a document or scene change';
        }
      }
    } else if (current.path === '/permissions') {
      reason = permissionTapped ? 'permission click attempted; permission gate has not completed' : 'permission gate has no enabled Allow access';
      if (!permissionTapped && current.buttons.some(b => b.enabled && b.name === 'Allow access')) {
        permissionTapped = true; permissions.push('Allow access');
        await page.getByRole('button', { name: 'Allow access', exact: true }).click({ timeout: Math.max(1, Math.min(1000, deadline - Date.now())) });
      }
    } else if (current.path !== '/') throw new Error('DIM2 results entry left the supported path');
    else reason = 'home has not sent the selected chest through its entry gates';
    await delay(Math.min(250, Math.max(0, deadline - Date.now())), undefined, { signal: options.signal });
  }
  options.signal?.throwIfAborted();
  throw new Error(`DIM2 did not open the selected game chest through its entry gates: ${reason} (${openingTaps} opening taps)`);
}
