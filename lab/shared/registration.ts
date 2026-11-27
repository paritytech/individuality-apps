// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { setTimeout as delay } from 'node:timers/promises';
import type { BrowserPage } from '@parity/product-lab/ports/browser';
import { readWatchedText } from './watched-text.ts';

/** Only named UI facts leave the page; never attach body text, identity or a URL query. */
export async function readRegistrationView(page: BrowserPage) {
  return readWatchedText(page, () => {
    const text = document.body?.innerText ?? '';
    return {
      path: ['/', '/permissions'].includes(location.pathname) ? location.pathname : '[other route]',
      nativePasRequested: /insufficient.*PAS|deposit required|fund your/i.test(text),
      buttons: Array.from(document.querySelectorAll('button'))
        .filter(b => b.getClientRects().length > 0 && getComputedStyle(b).visibility !== 'hidden')
        .map(b => ({ name: (b.getAttribute('aria-label') || b.textContent || '').trim(), disabled: b.disabled }))
        .filter(b => /^(I'll be there|Register|Sign up|Join game|Allow access|Requesting…|Joining…|Saving your seat…)$/.test(b.name)),
    };
  });
}
function inputRace(error: unknown, signal: AbortSignal): void {
  signal.throwIfAborted();
  if (!(error instanceof Error) || (error.name !== 'TimeoutError' && !/Execution context was destroyed|Element is not attached|element was detached/.test(error.message))) throw error;
}
export type RegistrationView = NonNullable<Awaited<ReturnType<typeof readRegistrationView>>>;

/**
 * One input the helper sent, or withheld after its guard, with the view it decided on (named UI facts only).
 * `clicked`: the click returned. `maybe`: the click threw, so it may have dispatched (a race is waited out, any other error is rethrown).
 * `withheld`: no input was sent, for `reason`.
 */
export interface RegistrationInput {
  control: string; at: number; sent: 'clicked' | 'maybe' | 'withheld'; reason?: string; view: RegistrationView | null;
}
const permissionControl = 'Allow access';
/** A registration click the page may have received. A withheld attempt and the permission click are not. */
export const sentRegistrationClick = (input: RegistrationInput) => input.control !== permissionControl && input.sent !== 'withheld';

/**
 * A UI observation is not a durable promise. One registration click attempt, then finalized proof only.
 * `beforeClick` is a guard run before each registration attempt; the attempt can still be withheld after it,
 * so it never counts clicks. Count clicks from `input`, which hears every input sent or withheld.
 */
export async function registerWhenReady<T>(page: BrowserPage, options: {
  actor: string; signal: AbortSignal; check: () => void | Promise<void>;
  registered: () => Promise<T | undefined>; beforeClick: () => Promise<void>;
  attach: (view: RegistrationView | null) => Promise<unknown>; timeoutMs?: number; pollMs?: number;
  input?: (input: RegistrationInput) => void;
}): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 180_000, deadline = Date.now() + timeoutMs;
  const send = async (control: string, view: RegistrationView | null) => {
    const at = Date.now();
    try { await page.getByRole('button', { name: control, exact: true }).click({ timeout: Math.max(1, Math.min(1000, deadline - Date.now())) }); }
    catch (error) { options.input?.({ control, at, sent: 'maybe', view }); inputRace(error, options.signal); return; }
    options.input?.({ control, at, sent: 'clicked', view });
  };
  const withhold = (control: string, reason: string, view: RegistrationView | null) => options.input?.({ control, at: Date.now(), sent: 'withheld', reason, view });
  let permissionAttempted = false, registrationAttempted = false;
  let last: RegistrationView | null = null, reason = 'no readable DIM2 view';
  while (Date.now() < deadline) {
    options.signal.throwIfAborted(); await options.check();
    last = await readRegistrationView(page);
    if (last?.nativePasRequested) throw new Error(`${options.actor}: Native PAS was requested`);
    const proof = await options.registered();
    if (proof !== undefined) return proof;
    if (last === null) reason = 'document replacement; no readable DIM2 view';
    else if (registrationAttempted) reason = 'registration click attempted; no finalized registration (no second click)';
    else if (last.path === '/permissions') {
      reason = permissionAttempted ? 'permission click attempted; permission gate has not completed' : 'permission gate has no enabled Allow access control';
      if (!permissionAttempted && last.buttons.some(b => b.name === permissionControl && !b.disabled)) {
        // A thrown click may already have dispatched. Never repeat an ambiguous input.
        permissionAttempted = true;
        await send(permissionControl, last);
        reason = 'permission click attempted; permission gate has not completed';
      }
    } else if (last.path === '/') {
      // "I'll be there" is the home's sign-up button since PR 70 (it hides on the tap); the older names stay for older builds.
      const controls = last.buttons.filter(b => /^(I'll be there|Register|Sign up|Join game)$/.test(b.name)), button = controls.find(b => !b.disabled);
      reason = !button && controls.length ? 'lite registration control is still disabled'
        : last.buttons.some(b => /^(Joining…|Saving your seat…)$/.test(b.name)) ? 'sign-up is already in progress; waiting for finalized registration'
        : 'no enabled lite registration control on DIM2 home';
      if (button && !button.disabled) {
        await options.beforeClick(); options.signal.throwIfAborted(); await options.check();
        if (Date.now() >= deadline) { withhold(button.name, 'deadline reached after the guard', last); break; }
        const alreadyRegistered = await options.registered();
        if (alreadyRegistered !== undefined) { withhold(button.name, 'registration found before the click', last); return alreadyRegistered; }
        const fresh = await readRegistrationView(page);
        if (fresh?.nativePasRequested) throw new Error(`${options.actor}: Native PAS was requested`);
        if (fresh?.path !== '/' || !fresh.buttons.some(b => b.name === button.name && !b.disabled)) {
          withhold(button.name, 'view changed before the click', fresh);
          reason = 'registration view changed before click; waiting for an enabled control or finalized registration';
        } else {
          registrationAttempted = true;
          // The locator re-resolves the enabled control at input time. A changed UI may make the click time out;
          // only finalized registration can then complete the wait, because dispatch may have preceded the error.
          await send(button.name, fresh);
          reason = 'registration click attempted; no finalized registration (no second click)';
        }
      }
    } else reason = 'DIM2 is outside the registration entry paths';
    await delay(Math.min(options.pollMs ?? 250, Math.max(0, deadline - Date.now())), undefined, { signal: options.signal });
  }
  options.signal.throwIfAborted(); await options.check();
  await options.attach(last);
  throw new Error(`${options.actor}: DIM2 registration timed out after ${timeoutMs} ms: ${reason}`);
}
