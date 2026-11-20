// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import type { BrowserContext } from 'playwright';
import type { DocumentMarks } from './journey-observations.ts';

/** Read-only recorder installed before any navigation, including app iframes. */
export async function installJourneyMarks(context: BrowserContext) {
  await context.addInitScript(() => {
  const marks: DocumentMarks = { loaded: null, usable: null, attendance: [], views: [] };
  (window as unknown as { __crossJourney: DocumentMarks }).__crossJourney = marks;
  addEventListener('DOMContentLoaded', () => { marks.loaded = Date.now(); });
  const sample = [() => {
    const home = document.querySelector('[data-testid="home"]');
    const status = document.querySelector('[data-testid="home-status"]')?.textContent?.trim();
    const enabled = [...document.querySelectorAll('button')].filter(b => !(b as HTMLButtonElement).disabled && b.getClientRects().length).map(b => b.textContent?.trim());
    const usable = home?.getAttribute('data-account') && status === 'Next game' && enabled.includes('Register') && location.pathname === '/';
    if (!usable) marks.usable = null;
    else marks.usable ??= Date.now();
    for (const mark of document.querySelectorAll('section.attendance-row .mark.is-attended')) {
      const game = /\(game (\d+)\)/.exec(mark.getAttribute('title') || '');
      if (game && !marks.attendance.some(m => m.game === Number(game[1]))) marks.attendance.push({ at: Date.now(), game: Number(game[1]) });
    }
    const h = document.querySelector('section[aria-label="Next game"] .card-value')?.textContent?.trim() || null;
    const j = [...document.querySelectorAll('h1, p')].map(e => e.textContent?.trim()).find(t => /^(?:Game (?:starts at|at) |at \d)/.test(t || '')) || null;
    const cardName = document.querySelector('[data-testid="card-username"]')?.textContent?.trim() || null;
    const attendance = [...document.querySelectorAll('section.attendance-row .mark.is-attended')].map(e => e.getAttribute('title'));
    const missed = [...document.querySelectorAll('section.attendance-row .mark.is-missed')].map(e => e.getAttribute('title'));
    const cardRoot = document.querySelector('[data-testid="membership-card"]');
    const cardState = cardRoot?.getAttribute('data-card-state') ?? null;
    const cardScore = cardRoot?.getAttribute('data-score') ?? null;
    const cardAccount = cardRoot?.getAttribute('data-account') ?? null;
    const cardProgress = cardRoot?.querySelector('[role="img"][data-hint="stripe"]')?.getAttribute('aria-label') ?? null;
    const cardLabel = document.querySelector('[data-testid="card-label"]')?.textContent?.trim() ?? null;
    const caution = /Play (?:the next game|today|tomorrow|this \w+|on [^.]+) to keep it\./.exec(document.body?.innerText ?? '')?.[0] ?? null;
    const view = { humanity: h, jollity: j, status, enabled, cardName, attendance, missed, cardLabel, cardState, cardScore, cardAccount, cardProgress, caution,
      update: /A new version is out/i.test(document.body?.innerText ?? ''), blocked: Boolean(document.querySelector('dialog[open]')?.getClientRects().length), jollityMissed: [...document.querySelectorAll('h1')].some(e => e.getClientRects().length && e.textContent?.trim() === 'You missed this one'), path: location.pathname, account: home?.getAttribute('data-account') ?? null };
    if (JSON.stringify(marks.views.at(-1)?.view) !== JSON.stringify(view)) marks.views.push({ at: Date.now(), view });
    if (marks.views.length > 2000) marks.views.shift();
  }][0]!;
  new MutationObserver(sample).observe(document, { subtree: true, childList: true, characterData: true, attributes: true });
  });
}
