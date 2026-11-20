// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// Run the actual three-player play step with synthetic screens/chain; no browser, host or fork.
import assert from 'node:assert/strict';
import { createContext, runInContext } from 'node:vm';
import { customSteps } from '@parity/product-lab/steps';
import { flowState, type Flow } from '../../../lab/flows/session.ts';
import '../../../lab/flows/steps.ts';
const actors = ['Alice', 'Bob', 'Carol'].map((name, i) => ({ name, id: name.toLowerCase(), account: '0x' + String(i + 1).padStart(2, '0').repeat(32) }));
const captures: Array<{ actor: string; phase: unknown }> = [];
const pages = new Map(actors.map(a => {
  let voted = false, done = false;
  const storage = new Map<string, string>();
  const window = new EventTarget(), location = new URL('http://flow.invalid/prize-draw'), performance = { timeOrigin: 100 };
  const realm = createContext({ window, location, performance, URL, Date, Symbol,
    sessionStorage: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => { storage.set(k, v); } } });
  return [a.id, { evaluate: async (read: unknown, phase: unknown) => {
    if (String(read).includes('product-lab:dim2-navigation:v1')) { assert.equal(done, true); captures.push({ actor: a.id, phase }); return runInContext(`(${String(read)})(${JSON.stringify(phase)})`, realm); }
    return { text: '', markers: [], buttons: [] };
  }, locator: () => ({ click: async () => { voted = true; }, evaluate: async () => ({ path: done ? '/prize-draw' : '/game', headings: [], buttons: [], debugOpen: false,
    slots: 1, confirm: !done && voted ? { label: 'Confirm votes', disabled: false } : null,
    tiles: done ? [] : [{ id: 'peer', verdict: voted ? 'approve' : 'pending', voted, votable: true, ready: true }] }) }),
  getByRole: () => ({ click: async () => { done = true; } }) }];
}));
const access = { finalizedHead: async () => ({ number: 1, hash: 'offline-finalized' }), historicalStorage: async (_p: string, item: string, keys: number[][]) => {
  if (item === 'Game') return { index: 308, game_date: 1, state: { type: 'Reporting' } };
  if (item === 'IndexToPlayer') return actors[keys[0][1]] ? { type: 'Account', value: actors[keys[0][1]].account } : undefined;
  return undefined;
} };
const state = { actors, pages, people: { access }, game: { index: 308 }, payoffStartedAt: new Map(), context: { signal: new AbortController().signal }, log: () => {} } as unknown as Flow;
const step = customSteps().find(s => s.pattern.text === 'the three players play and vote in DIM2 together'); assert.ok(step);
const attached: unknown[] = [];
flowState.active = state;
try {
  await step.run({ lab: { attach: async (v: unknown) => { attached.push(v); } } } as never);
  assert.deepEqual(captures.sort((a, b) => a.actor.localeCompare(b.actor)), actors.map(a => ({ actor: a.id, phase: 1 })).sort((a, b) => a.actor.localeCompare(b.actor)));
  assert.equal(state.payoffStartedAt.size, 3); assert.equal(attached.length, 3);
  for (const v of attached) assert.equal((v as { navigationCapture: { records: Array<{ phase: number }> } }).navigationCapture.records[0].phase, 1);
  console.log('actual step 12 installs once per actor after payoff; three UI journeys complete');
} finally { delete flowState.active; }
