// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { browserAvailable } from '../../../apps/humanity-app/tests/chromium.ts';
import { chromium } from 'playwright';
import { expect, it } from 'vitest';
import { installJourneyMarks } from '../document-marks.ts';
import type { DocumentMarks } from '../journey-observations.ts';

it.skipIf(!browserAvailable(chromium.executablePath()))('records actual document/DOM marks and rejects a disabled or unrelated next action', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext(); await installJourneyMarks(context);
    const page = await context.newPage();
    await page.route('http://127.0.0.1:47999/', route => route.fulfill({ contentType: 'text/html', body: '<main data-testid="home" data-account="ada"><span data-testid="home-status">Next game</span><h1>Game starts at 4:00 AM</h1><button>Debug</button><button id="register" disabled>Register</button></main>' }));
    await page.goto('http://127.0.0.1:47999/');
    const read = () => page.evaluate(() => (window as unknown as { __crossJourney: DocumentMarks }).__crossJourney);
    expect((await read()).loaded).toBeTypeOf('number');
    expect((await read()).usable).toBeNull();
    await page.locator('#register').evaluate(button => { (button as HTMLButtonElement).disabled = false; });
    expect((await read()).usable).toBeTypeOf('number');
    await page.locator('#register').evaluate(button => { (button as HTMLButtonElement).disabled = true; });
    expect((await read()).usable).toBeNull();
    await page.goto('data:text/html,' + encodeURIComponent('<section class="attendance-row"><i class="mark is-attended" title="played, last game (game 42)"></i></section><span data-testid="card-username">ada.paseo</span><section aria-label="Next game"><div class="card-value">Saturday, 4:00 AM</div></section>'));
    const next = await read();
    expect(next.usable).toBeNull();
    expect(next.attendance).toEqual([{ game: 42, at: expect.any(Number) }]);
    expect(next.views.at(-1)?.view).toMatchObject({ humanity: 'Saturday, 4:00 AM', cardName: 'ada.paseo' });
    await page.evaluate(() => { const note = document.createElement('p'); note.id = 'caution'; note.textContent = 'Play the next game to keep it.'; document.body.append(note); });
    expect((await read()).views.at(-1)?.view.caution).toBe('Play the next game to keep it.');
    await page.evaluate(() => {
      const card = document.createElement('div'); card.setAttribute('data-testid', 'membership-card');
      card.setAttribute('data-card-state', 'candidate'); card.setAttribute('data-score', '1'); card.setAttribute('data-account', 'owner');
      card.innerHTML = '<div role="img" data-hint="stripe" aria-label="Progress to membership: 1 of 7"></div>';
      document.body.append(card);
    });
    expect((await read()).views.at(-1)?.view).toMatchObject({ cardState: 'candidate', cardScore: '1', cardAccount: 'owner', cardProgress: 'Progress to membership: 1 of 7' });
    await page.locator('#caution').evaluate(note => { note.textContent = 'Play an unrelated clip.'; });
    expect((await read()).views.at(-1)?.view.caution).toBeNull();
  } finally { await browser.close(); }
}, 30000);
