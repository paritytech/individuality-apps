// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// Exercise the actual group step; only UI and chain responses are synthetic. No fork, browser or host.
import assert from 'node:assert/strict';
import { customSteps } from '@parity/product-lab/steps';
import { flowState, type Flow } from '../../../lab/flows/session.ts';
import '../../../lab/flows/steps.ts';
const step = customSteps().find(s => s.pattern.text === 'the three players register for the game in DIM2 together'); assert.ok(step);
const actors = ['Alice', 'Bob', 'Carol'].map(name => ({ name, id: name.toLowerCase(), account: `offline-${name}` }));
let time = 10_000; const originalNow = Date.now; Date.now = () => time;
const attempts = new Map<string, number>(), permitted = new Set<string>(), proven = new Set<string>(), views = new Map<string, number>();
const pages = new Map(actors.map(a => [a.id, { evaluate: async () => {
  const n = (views.get(a.id) ?? 0) + 1; views.set(a.id, n); time += 100;
  const needsPermission = a.name === 'Alice' && !permitted.has(a.id), disabled = n < 4;
  const name = needsPermission ? 'Allow access' : 'Register';
  return { path: needsPermission ? '/permissions' : '/', nativePasRequested: false, text: name, markers: [],
    buttons: [{ name, text: name, aria: name, disabled: needsPermission ? false : disabled }] };
}, getByRole: (_role: unknown, options: { name: string }) => ({ click: async () => {
  if (options.name === 'Allow access') permitted.add(a.id);
  else { attempts.set(a.id, (attempts.get(a.id) ?? 0) + 1); proven.add(a.account); }
} }) }]));
const access = { finalizedHead: async () => ({ number: 1, hash: 'offline-finalized' }), historicalStorage: async (_p: string, item: string, keys: Array<{ value: string }>) => {
  if (item === 'Game') return { index: 308, game_date: 20, state: { type: 'Registration', value: { next_player_index: 0 } } };
  if (item === 'Players') return { registered: proven.has(keys[0].value) }; return undefined;
} };
flowState.active = { actors, pages, people: { access }, context: { signal: new AbortController().signal }, game: { index: 308 } } as unknown as Flow;
try {
  if (process.env.FLOW_REGISTRATION_EXPECT_ORIGINAL) {
    await assert.rejects(step.run({ lab: { attach: async () => {} } } as never), { message: 'No enabled lite registration control' });
    console.log('original actual registration group: No enabled lite registration control');
  } else {
    await step.run({ lab: { attach: async () => {} } } as never);
    assert.deepEqual([...attempts].sort(), actors.map(a => [a.id, 1]).sort()); assert.equal(proven.size, 3);
    console.log('actual registration group: delayed permission and enabled control pass; one registration click per actor');
  }
} finally { Date.now = originalNow; delete flowState.active; }
