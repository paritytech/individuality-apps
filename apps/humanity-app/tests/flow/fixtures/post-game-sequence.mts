// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// Exercise actual results and credit custom steps with synthetic pages/chain responses; no browser or fork.
import assert from 'node:assert/strict';
import { customSteps } from '@parity/product-lab/steps';
import { creditHash } from '../../../../../lab/shared/upstream/three-apps/chain.ts';
import { flowState, type Flow } from '../../../lab/flows/session.ts';
import '../../../lab/flows/steps.ts';
const actors = ['Alice', 'Bob', 'Carol'].map((name, i) => ({ id: name.toLowerCase(), name, account: '0x' + String(i + 1).padStart(2, '0').repeat(32) }));
const states = new Map(actors.map(a => [a.id, { path: '/', game: '', heading: false, gameLabel: false, noIdentity: false, slow: false, restart: false, scene: true, closing: false, buttons: [{ name: 'Continue', enabled: false }] }]));
let holdEntry = false, testTime = Date.now();
const navigationReads: Array<{ actor: string; phase: unknown }> = [];
const pages = new Map(actors.map(a => [a.id, { evaluate: async (read: unknown, phase: unknown) => {
  if (String(read).includes('product-lab:dim2-navigation:v1')) { navigationReads.push({ actor: a.id, phase }); return { documentAvailable: true, installedHere: phase === 2, navigationAvailable: false, storageReadable: true, storagePresent: false, dataValid: false, records: [] }; }
  if (holdEntry && String(read).includes('body?.innerText')) testTime += 180_001;
  return String(read).includes('performance.timeOrigin') ? { path: states.get(a.id)!.path, signals: { timeOrigin: 1, documentBeforePayoff: true, navigationType: 1, reloadCount: 0, reloadLatest: -1, postGamePresent: true, crashReload: 0, ringCount: 0, ringOldest: -1 } } : states.get(a.id); }, locator: () => ({ evaluate: async () => false, press: async () => {} }),
  getByRole: (role: string, options: { name: string }) => ({ waitFor: async () => {}, evaluate: async () => [], click: async () => { assert.equal(role, 'img'); assert.equal(options.name, 'Your chest opening'); states.get(a.id)!.buttons[0].enabled = true; } }) } ]));
const head = { hash: '0x' + '44'.repeat(32), number: 9 }, root = { root: '0x' + '11'.repeat(32), game_index: 308, leaf_count: 2 };
const people = { finalized: async () => head, blockAt: async () => head,
  storage: async (_p: string, item: string) => item === 'NftClaimCreditBlocks' ? [9] : root,
  runtimeCall: async (_api: string, _method: string, args: unknown[]) => { const account = (args[1] as { value: string }).value;
    return { success: true, value: actors.filter(a => a.account !== account).map((a, i) => ({ credit: creditHash(308, a.account, account), leaf_index: i })) }; } };
const assetHub = { finalized: async () => head, blockAt: async () => head, storage: async (_p: string, item: string) => item === 'ClaimedLeaves' ? undefined : root };
const balance = { finalizedHead: async () => head, historicalStorage: async () => undefined };
const opened: unknown[] = [], attachments: unknown[] = [];
const state = { actors, pages, context: { signal: new AbortController().signal }, game: { index: 308 },
  payoffStartedAt: new Map(actors.map(a => [a.id, Date.now()-1000])), hostActors: new Map(actors.map(a => [a.id, a])), navigation: { evidence: () => [], open: async (actor: { id: string }, app: string, path: string) => {
    assert.ok(attachments.some(v => (v as { postGameEntry?: { actor: string; path: string } }).postGameEntry?.actor === actor.id));assert.equal(app, 'dim2');assert.equal(path, '/chest?game=308'); opened.push({ actor: actor.id, app, path });
    Object.assign(states.get(actor.id)!, { path: holdEntry ? '/' : '/chest', game: holdEntry ? '' : '308' });
  } }, readers: { people, assetHub }, people: { access: balance }, hub: balance,
  identities: new Map(actors.map(a => [a.id, { address: a.account, game: a.account }])), warnings: [] } as unknown as Flow;
flowState.active = state;
const step = customSteps().find(s => s.pattern.text === 'the three players view the DIM2 game results together');
const credits = customSteps().find(s => s.pattern.text === '{actor} has {int} DIM2 credits to keep on chain');
assert.ok(step);assert.ok(credits);
const context = { lab: { attach: async (value: unknown) => { attachments.push(value); } } } as Parameters<typeof step.run>[0];
try {
  await step.run(context);assert.equal(opened.length, 3);assert.equal(attachments.length, 18);
  for (const actor of actors) assert.deepEqual(navigationReads.filter(r => r.actor === actor.id).map(r => r.phase), [0, 2, 0]);
  for (const actor of actors) await credits.run(context, actor.name, 2);
  await assert.rejects(credits.run(context, 'Alice', 3), /2 DIM2 credits to keep, not 3/);
  const single = customSteps().find(s => s.pattern.text === '{actor} views the DIM2 game results'); assert.ok(single);
  const originalNow = Date.now; holdEntry = true; Date.now = () => testTime;
  try {
    await assert.rejects(single.run(context, 'Alice'), /DIM2 did not open the selected game chest through its entry gates/);
    assert.equal((attachments.at(-1) as { postGameNavigation?: { actor: string } }).postGameNavigation?.actor, 'alice');
  } finally { Date.now = originalNow; }
  console.log('actual step 19 attaches navigation before reopen, installs after open, and snapshots on timeout');
  assert.ok([...states.values()].every(s => s.buttons[0].enabled));
  console.log('actual results group and all three credit steps pass; synthetic pages and chain only');
  console.log('wrong-credit actual step: 2 DIM2 credits to keep, not 3');
} finally { delete flowState.active; }
