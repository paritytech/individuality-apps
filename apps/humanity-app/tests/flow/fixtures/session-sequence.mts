// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// Exercise the real reloaded config and ESM custom-step loaders without a fork.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { ModuleLabSource } from '@parity/product-lab/lab-module';
import { customSteps } from '@parity/product-lab/steps';
import { flow, flowState, flowSessions, type Flow } from '../../../lab/flows/session.ts';
import '../../../lab/flows/steps.ts';

const source = new ModuleLabSource(fileURLToPath(new URL('../../../lab.flow.config.ts', import.meta.url)), { reload: true });
await source.load();
const config = await source.load();
const configModule = await import(new URL('../../../lab/flows/session.ts?product-lab-generation=1', import.meta.url).href) as typeof import('../../../lab/flows/session.ts');
assert.equal(config.sessions, configModule.flowSessions);
assert.notEqual(config.sessions, flowSessions);
const step = customSteps().find(step => step.pattern.text === 'the three fresh fork players have zero PAS and no prior credits');
assert.ok(step);
const attached: unknown[] = [];
let balanceCase: 'absent' | 'nonzero' | 'error' = 'absent';
const access = { finalizedHead: async () => ({ hash: 'offline-finalized', number: 1 }),
  historicalStorage: async (_pallet: string, item: string) => {
    if (item !== 'Account') return undefined;
    if (balanceCase === 'error') throw new Error('offline account RPC error');
    return balanceCase === 'nonzero' ? { data: { free: 1n, reserved: 0n } } : undefined;
  } };
const actors = ['Alice', 'Bob', 'Carol'].map((name, i) => ({ id: name.toLowerCase(), name, account: `offline-${i}`, appUrl: `http://127.0.0.1:${3000 + i}/` }));
const state = { actors, people: { access }, hub: access, identities: new Map(actors.map(a => [a.id, { address: a.account, game: a.account }])),
  context: { signal: new AbortController().signal }, cleanups: [], pages: new Map() } as unknown as Flow;
const context = { lab: { scenario: 'mixed module control', attach: async (evidence: unknown) => { attached.push(evidence); } } } as Parameters<typeof step.run>[0];
try {
  configModule.flowState.active = state;
  assert.equal(flow(), state);
  await step.run(context);
  assert.equal(attached.length, 2);
  assert.ok(JSON.stringify(attached).includes('"account":"absent"'));
  assert.equal(flowState, configModule.flowState);
  console.log('actual zero-PAS step shares config/ESM owned state; synthetic reads only');
} finally {
  for (const cleanup of [...state.cleanups].reverse()) await cleanup();
  delete configModule.flowState.active;
}
configModule.flowState.active = state;
try {
  balanceCase = 'nonzero'; await assert.rejects(step.run(context), /has native PAS/);
  balanceCase = 'error'; await assert.rejects(step.run(context), /offline account RPC error/);
  console.log('actual zero-PAS step: absent passes, nonzero and RPC errors fail');
} finally { delete configModule.flowState.active; }
await assert.rejects(step.run(context), /No owned flow session/);
console.log('missing or closed owned flow still rejected');
