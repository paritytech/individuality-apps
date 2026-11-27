// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { step } from '@parity/product-lab/steps';
import { scenario } from '../shared/session.ts';
import { readWatchedText } from '../shared/watched-text.ts';
import { flowStorage } from '../shared/storage.ts';
import { jsonEvidence } from '../shared/observations.ts';
import type { DocumentMarks } from './journey-observations.ts';
import { navigationPath } from './journey-observations.ts';
import { currentReady } from './recovery-observations.ts';
import { journeyBreakdown } from './timing.ts';
import { output, save, capMs } from './steps.ts';

step('Ada meets the local update gate during entry, U3 run {string}', async ({ lab }, run) => {
  const state = scenario(), actor = state.actor(), version = state.versionFile, game = state.chain.current;
  if (!game) throw Error('No measured hand-off game');
  if (!version || !state.apps.jollity || !actor.jollity) throw Error('Update experiment requires the owned local version-file server');
  // The session already proved owned Engine routes, and the browser guard still denies every outside request.
  for (const url of [state.apps.humanity, state.apps.jollity, version.url]) if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname)) throw Error('Update experiment requires loopback apps');
  const actions: Array<{ name: string; at: number; done: number }> = [];
  let raw: Record<string, unknown> = {};
  try {
    await state.chain.until('Humanity real hand-off prerequisite', async () => state.crossAppLog.some(m => new URL(m.url).origin === new URL(state.apps.humanity).origin && /name link.*(?:unfunded|skipped)|no sign-up:|the sign-up could not start/i.test(m.text)) ? true : undefined, 120_000);
    const tap = Date.now(); await actor.view.page.getByRole('button', { name: 'Register', exact: true }).click({ timeout: 5000 });
    actions.push({ name: 'lab Register click', at: tap, done: Date.now() });
    const directory = (actor.session.evidence as unknown as { runDir: string }).runDir;
    const navigation = await state.chain.until('Humanity real host navigation', async () => {
      try { return readFileSync(join(directory, 'navigations.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l) as { at: number; url: string }).find(n => n.at >= tap); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
    }, 120_000);
    const newerAt = Date.now(); version.set(true); const newerDone = Date.now(); actions.push({ name: 'lab version file promotion', at: newerAt, done: newerDone });
    const followAt = Date.now(); await actor.jollity.session.open!(navigationPath(navigation.url, 'dim2')); actor.jollity.page = await actor.jollity.session.page(); const followed = Date.now();
    actions.push({ name: 'lab navigation follow', at: followAt, done: followed });
    let allowed = false;
    let shown = await state.chain.until('real local update gate', async () => {
      const view = await readWatchedText(actor.jollity!.page, () => ({ path: location.pathname, text: document.body.innerText }));
      if (/native PAS|request.*PAS/i.test(view?.text ?? '')) throw Error('Native PAS request');
      if (view?.path === '/permissions' && !allowed) {
        allowed = true; const at = Date.now(); await actor.jollity!.page.getByRole('button', { name: 'Allow access', exact: true }).click({ timeout: 5000 });
        actions.push({ name: 'lab permission click', at, done: Date.now() }); return undefined;
      }
      const doc = await readWatchedText(actor.jollity!.page, () => (window as unknown as { __crossJourney: DocumentMarks }).__crossJourney);
      const at = doc ? currentReady(doc.views, tap, v => v.update === true) : undefined;
      return at === undefined ? undefined : { at, document: doc!, text: view?.text };
    }, 120_000);
    let allowedAgain = false, heldSince: number | undefined;
    const gate = await state.chain.until('blocked local entry retains Ada account', async () => {
      const gate = await readWatchedText(actor.jollity!.page, () => ({ path: location.pathname, text: document.body.innerText, account: document.querySelector('[data-testid="home-update"]')?.getAttribute('data-account'), buttons: [...document.querySelectorAll('button')].filter(b => b.getClientRects().length).map(b => b.textContent?.trim()), register: Boolean([...document.querySelectorAll('button')].find(b => b.textContent?.trim() === 'Register' && !b.disabled)) }));
      if (/native PAS|request.*PAS/i.test(gate?.text ?? '')) throw Error('Native PAS request');
      if (gate?.path === '/permissions' && !allowedAgain) {
        allowedAgain = true; heldSince = undefined;
        const at = Date.now(); await actor.jollity!.page.getByRole('button', { name: 'Allow access', exact: true }).click({ timeout: 5000 });
        actions.push({ name: 'lab permission click after gate', at, done: Date.now() }); return undefined;
      }
      if (gate?.path !== '/' || gate.account !== actor.game.address || gate.register) { heldSince = undefined; return undefined; }
      // A transient gate before a permissions redirect is not the endpoint. Require it to hold after recovery.
      const doc = await readWatchedText(actor.jollity!.page, () => (window as unknown as { __crossJourney: DocumentMarks }).__crossJourney);
      const ready = doc ? currentReady(doc.views, tap, v => v.update === true) : undefined;
      if (ready === undefined) { heldSince = undefined; return undefined; }
      // Polls are sampled, so also count from the page's own mark: a gate that dropped and came back between polls has a later ready time.
      heldSince ??= Date.now();
      if (Date.now() - Math.max(heldSince, ready) < 1000) return undefined;
      shown = { at: ready, document: doc!, text: gate.text };
      return gate;
    }, 30_000);
    const at = await state.people.access.bestHead();
    const currentGame = await flowStorage(state.people.access, 'Game', 'Game', [], at.hash) as { index: number; game_date: number } | undefined;
    if (currentGame?.index !== game.index || currentGame.game_date !== game.playsAt) throw Error('Local gate did not retain the selected game');
    const player = await flowStorage(state.people.access, 'Game', 'Players', [{ type: 'Account', value: actor.game.address }], at.hash) as { registered?: boolean } | undefined;
    if (gate?.register || gate?.path !== '/' || gate.account !== actor.game.address || player?.registered) throw Error('Update gate did not retain the intended unregistered entry');
    raw = { game: { ...game }, currentGame, at, tap, navigation, newerAt, newerDone, followAt, followed, shown, gate, expectedAccount: actor.game.address, playerRegistered: player?.registered ?? false, version: { url: version.url, build: version.build, requests: version.requests }, actions, updateAction: 'No update control exists on this screen; the app instructs a host restart. The experiment ends at the gate.' };
    const value = journeyBreakdown({ direction: 'U3', run: String(run), reader: { app: 'Jollity', head: 'best', how: 'unchanged useStaleBuild, real loopback version file; endpoint is the blocking update screen' }, start: tap, end: shown.at,
      points: [{ name: 'tap to navigation', at: navigation.at }, { name: 'navigation to document load', at: shown.document.loaded ?? undefined }], actions });
    save(value, raw); await lab.attach(jsonEvidence(raw));
  } catch (error) { writeFileSync(join(output(), `failed-U3-${run}.json`), JSON.stringify(jsonEvidence({ ...raw, error: String(error), requests: version.requests }), null, 2)); throw error; }
}, { timeoutMs: capMs });
