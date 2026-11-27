// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// Run the actual step against synthetic pages/alias reads, real navigation and the real static-server handler.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { LabNavigation, type HostProvider, type HostSession } from '@parity/product-lab';
import { navigationRequest } from '@parity/product-lab/domain/navigation';
import { customSteps } from '@parity/product-lab/steps';
import { flowState, type Flow } from '../../../lab/flows/session.ts';
import { navigationApps } from '../../../lab/flows/actor-session.ts';
import { staticHandler } from './static-handler.ts';
import config from '../../../lab.flow.config.ts';
import { sourceAppDeclarations } from '../../../../../lab/shared/apps.ts';
import '../../../lab/flows/steps.ts';
assert.deepEqual(Object.keys(config.apps!).sort(), Object.keys(sourceAppDeclarations()).sort());
let source = readFileSync(new URL('../../../../../lab/shared/static-server.mjs', import.meta.url), 'utf8');
if (process.env.FLOW_STATIC_MUTATE) source = source.replace("selected = resolve(file, 'index.html'); await stat(selected);", "selected = resolve(file, 'index.html');");
const serve = staticHandler(source, { 'index.html': 'home', 'permissions.html': 'permission page', 'permissions/__next._full.txt': 'RSC' });
const step = customSteps().find(step => step.pattern.text === '{actor} taps "Open the game" in Humanity');
assert.ok(step);
const actors = ['Alice', 'Bob', 'Carol'].map(name => ({ id: name.toLowerCase(), name, account: `offline-${name}` }));
const sessions: HostSession[] = [], pages = new Map();
let time = Date.now(); const originalNow = Date.now;
Date.now = () => time;
const card = { text: 'Person\nRegister', markers: [{ id: 'humanity-home', attrs: { 'data-card-state': 'devicehood' } }], buttons: [{ text: 'Register', aria: 'Register', disabled: false }], card: { status: 'Person' } };
let navigation: LabNavigation;
const provider = { id: 'truapi-cli', async createSession(request: Parameters<HostProvider['createSession']>[0]) {
  let destinationStatus = 0;
  if (request.app.id === 'dim2') destinationStatus = (await serve('/permissions')).status;
  const control = { waitFor: async () => {}, press: async () => {}, getAttribute: async () => '',
    click: async () => {
      if (request.app.id === 'peopl') await navigation.bridge.handle(session, navigationRequest('polkadot://dim2.paseo/permissions', time));
    } };
  const page = { url: () => 'http://127.0.0.1:3000/', locator: () => control, getByText: () => control, getByRole: () => ({ click: async () => {} }), getByTestId: () => control,
    evaluate: async () => {
      if (request.app.id === 'peopl') return card;
      if (destinationStatus === 404) { time += 180_001; return { text: 'Not found', markers: [], buttons: [] }; }
      return { text: 'Register', markers: [], buttons: [{ text: 'Register', aria: 'Register', disabled: false }] };
    } };
  const session = { actor: request.actor, app: request.app, page: async () => page, open: async () => {}, stop: async () => {} } as unknown as HostSession;
  sessions.push(session); pages.set(request.actor.id, page); return session;
} } as unknown as HostProvider;
navigation = new LabNavigation({ provider, apps: navigationApps, namespace: 'paseo', clock: { date: () => new Date(time), now: () => time, sleep: async () => {} } as never });
const state = { actors, navigation, sessions, pages, hostActors: new Map(actors.map(a => [a.id, a])),
  context: { signal: new AbortController().signal }, people: { access: { finalizedHead: async () => ({ hash: 'synthetic', number: 1 }),
    historicalStorage: async () => ({ ca: { context: 'synthetic-alias' } }) } } } as unknown as Flow;
flowState.active = state;
const context = { lab: { attach: async () => {} } } as Parameters<typeof step.run>[0];
try {
  if (process.env.FLOW_STATIC_EXPECT_FAILURE) {
    await assert.rejects(step.run(context, 'Alice'), { message: 'The bounded flow wait expired' });
    console.log('original handler + actual step: The bounded flow wait expired');
  } else {
    for (const actor of actors) await step.run(context, actor.name);
    assert.equal(navigation.evidence().filter(row => row.outcome === 'opened' && row.toApp === 'dim2').length, 3);
    console.log('actual navigation steps pass for Alice, Bob and Carol; synthetic pages/chain only');
  }
} finally { Date.now = originalNow; delete flowState.active; await navigation.close(); }
