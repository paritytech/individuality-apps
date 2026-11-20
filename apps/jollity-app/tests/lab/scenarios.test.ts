// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { expect, it } from 'vitest';
import { getTypedCodecs } from 'polkadot-api';
import { people } from '../../../../lab/shared/upstream/lab/chain/descriptors.ts';
import { homeSetup, blockedAlias, blockFreeSeat } from '../../lab/scenarios/setup.ts';
import { assertHome, assertHomeChain, observeHome, type HomeObservation } from '../../lab/scenarios/home.ts';
import { requireNavigation, precompileRoutes, precompiledPaths } from '../../lab/scenarios/session.ts';
import type { ScenarioChain } from '../../../../lab/shared/chain.ts';
import type { BrowserPage } from '@parity/product-lab/ports/browser';
import { runInNewContext } from 'node:vm';
const cases = [
  ['no-game', 'none', 'No game scheduled', false], ['register', 'registration', 'Next game', false],
  ['unfunded', 'registration', 'Top up to play', false], ['registered', 'registration', "You're in", true],
  ['missed', 'starting', 'You missed this one', false], ['wrapping-up', 'processing', 'Wrapping up', false],
] as const;
it.each(cases)('checks %s with host identity, phase, registration and visible copy', (expected, phase, copy, registered) => {
  const good: HomeObservation = { visible: true, source: 'host', account: 'Ada', phase, registered: String(registered), copy: [copy] };
  expect(() => assertHome(good, 'Ada', expected)).not.toThrow();
  for (const change of [{ visible: false }, { source: 'mock' }, { account: 'other' }, { registered: String(!registered) }, { phase: 'loading' }, { copy: ['invented'] }]) {
    expect(() => assertHome({ ...good, ...change }, 'Ada', expected), JSON.stringify(change)).toThrow('DIM2 home does not show');
  }
});
it('negative control rejects another registration screen under the same chain status', () => {
  expect(() => assertHome({ visible: true, source: 'host', account: 'Ada', phase: 'registration', registered: 'false', copy: ['Top up to play'] }, 'Ada', 'register')).toThrow('DIM2 home does not show register');
});
it('pins the six setup rows and refuses an unknown setup', () => {
  expect(homeSetup('game in PlayerProcess')).toBe('wrapping-up');
  expect(() => homeSetup('invented')).toThrow('Unknown DIM2');
});
it('requires finalized chain state, including an idle schedule and the funding difference', () => {
  const rich = { data: { free: 100n } }, poor = { data: { free: 0n } }, game = { state: { type: 'Registration' } };
  expect(() => assertHomeChain('no-game', undefined, undefined, [], poor, 5n)).not.toThrow();
  expect(() => assertHomeChain('no-game', undefined, undefined, [1], poor, 5n)).toThrow('does not back');
  expect(() => assertHomeChain('register', game, undefined, [], rich, 5n)).not.toThrow();
  expect(() => assertHomeChain('unfunded', game, undefined, [], poor, 5n)).not.toThrow();
  for (const [expected, balance, player] of [['register', poor, undefined], ['unfunded', rich, undefined], ['registered', rich, undefined], ['register', rich, { registered: true }]] as const)
    expect(() => assertHomeChain(expected, game, player, [], balance, 5n)).toThrow('does not back');
  // The deposit route holds the deposit out of a deposit-plus-headroom account: registered stands below the deposit.
  expect(() => assertHomeChain('registered', game, { registered: true }, [], poor, 5n)).not.toThrow();
  expect(() => assertHomeChain('registered', game, { registered: true }, [], rich, 5n)).not.toThrow();
  expect(() => assertHomeChain('registered', game, { registered: false }, [], poor, 5n)).toThrow('does not back registered');
  expect(() => assertHomeChain('registered', { state: { type: 'Shuffle' } }, { registered: true }, [], poor, 5n)).toThrow('does not back registered');
  expect(() => assertHomeChain('missed', { state: { type: 'Reporting' } }, undefined, [], rich, 5n)).not.toThrow();
  expect(() => assertHomeChain('missed', game, undefined, [], rich, 5n)).toThrow('does not back');
});
it('encodes the deposit blocker against the committed People metadata', async () => {
  const codecs = await getTypedCodecs(people);
  expect(codecs.query.PeopleLite.AccountToAlias.value.dec(codecs.query.PeopleLite.AccountToAlias.value.enc(blockedAlias()))).toEqual(blockedAlias());
});
it('negative control rejects a swallowed or changed blocker setup', async () => {
  const chain = { people: { api: { query: { PeopleLite: { AccountToAlias: { getKey: async () => '0x00' } } } } }, batch: async () => undefined,
    read: async () => ({ value: undefined }) } as unknown as ScenarioChain;
  await expect(blockFreeSeat(chain, 'Ada')).rejects.toThrow('did not finalize');
});
it('serves only Jollity navigation and refuses a Humanity route, a URL or traversal', () => {
  for (const path of ['/', '/chest?game=3', '/prize-draw']) expect(() => requireNavigation('dim2', path)).not.toThrow();
  for (const [app, path] of [['peopl', '/'], ['dim2', 'https://outside.test/'], ['dim2', '/../'], ['dim2', '/chest?game=3&secret=1']])
    expect(() => requireNavigation(app!, path!)).toThrow('Jollity scenarios allow only');
});
it('serializes the home read with no outer lexical dependencies', async () => {
  const attributes = { 'data-source': 'host', 'data-account': 'Ada', 'data-state': 'registration', 'data-registered': 'false' };
  const page = { evaluate: async (fn: () => unknown) => runInNewContext(`(${fn.toString()})()`, {
    document: { querySelector: () => ({ getClientRects: () => [1], getAttribute: (key: keyof typeof attributes) => attributes[key],
      querySelectorAll: () => [{ getClientRects: () => [1], textContent: 'Next game' }] }) },
  }) } as unknown as BrowserPage;
  expect(JSON.parse(JSON.stringify(await observeHome(page)))).toEqual({ visible: true, source: 'host', account: 'Ada', phase: 'registration', registered: 'false', copy: ['Next game'] });
});
it('compiles home and the permission route on the fresh dev server, and refuses a compile failure', async () => {
  const asked: string[] = [];
  const fetcher = (async (url: URL) => { asked.push(url.pathname); return new Response('ok', { status: 200 }); }) as typeof fetch;
  await precompileRoutes('http://127.0.0.1:4000', new AbortController().signal, fetcher);
  expect(asked).toEqual([...precompiledPaths]); expect(asked).toEqual(['/', '/permissions']);
  const broken = (async (url: URL) => new Response('', { status: url.pathname === '/permissions' ? 500 : 200 })) as typeof fetch;
  await expect(precompileRoutes('http://127.0.0.1:4000', new AbortController().signal, broken)).rejects.toThrow('could not compile /permissions (500)');
  const session = (await import('node:fs')).readFileSync(new URL('../../lab/scenarios/session.ts', import.meta.url), 'utf8');
  expect(session.indexOf('await precompileRoutes(app.devServerUrl, signal)')).toBeGreaterThan(session.indexOf('const app = await serveApp('));
  expect(session.indexOf('await precompileRoutes(app.devServerUrl, signal)')).toBeLessThan(session.indexOf('await provider.createSession('));
});
