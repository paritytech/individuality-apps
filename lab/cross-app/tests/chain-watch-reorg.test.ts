// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// A reorg of the result block: the first best block that showed the registration loses to a sibling at the same
// height, the sibling is finalized and the node prunes the loser, so chain_getBlock on its hash answers null. Before the
// guard, marks() threw "Cannot read properties of null (reading 'block')" (C4 on #1982, C6 on #1972).
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { afterEach, expect, it } from 'vitest';
import { RegistrationWatch, type ChainMarks } from '../chain-watch.ts';
import { configKeys, renderReport, type RunConfig } from '../report.ts';
import { breakdown, commentSection, journeyBreakdown } from '../timing.ts';

type Head = { number: number; hash: string };
type Watch = new (...args: ConstructorParameters<typeof RegistrationWatch>) => { start(): { marks(signal: AbortSignal, capMs: number, finalityMs?: number): Promise<ChainMarks> } };
const A: Head = { number: 100, hash: '0x' + 'aa'.repeat(32) }; // first best block with the result: later retracted
const B: Head = { number: 100, hash: '0x' + 'bb'.repeat(32) }; // its sibling at the same height: the one finalized
const body = ['0x0102'];

function subject<T>() {
  const subs = new Set<(value: T) => void>();
  return { observable: { subscribe: (o: { next: (value: T) => void }) => { subs.add(o.next); return { unsubscribe: () => subs.delete(o.next) }; } },
    emit: (value: T) => subs.forEach(next => next(value)) };
}

/** A People chain double: best and finalized subscriptions, a pool that shows the transaction from its second poll, and a pruned set. */
function chain() {
  const best = subject<Head[]>(), finalized = subject<Head>(), pruned = new Set<string>();
  let polls = 0;
  const client = { bestBlocks$: best.observable, finalizedBlock$: finalized.observable, async _request(method: string, params: unknown[]) {
    if (method === 'author_pendingExtrinsics') return polls++ === 0 ? [] : body;
    if (method === 'chain_getBlock') return pruned.has(params[0] as string) ? null : { block: { extrinsics: body } };
    throw Error(`unexpected ${method}`);
  } };
  return { people: { access: { client } } as never, best: best.emit, finalized: finalized.emit, pruned };
}

const at = (ms: number, act: () => void) => setTimeout(act, ms);

/** Best A, then best B at the same height, then B finalized and A pruned. */
async function reorg(Watch: Watch) {
  const c = chain();
  const watch = new Watch(c.people, 'ada', 20, async () => true).start();
  at(80, () => c.best([A]));
  at(120, () => c.best([B]));
  at(160, () => { c.pruned.add(A.hash); c.finalized(B); });
  return watch.marks(new AbortController().signal, 5_000, 5_000);
}

it('keeps the best-head time and says the block lost a reorg when the first best block was pruned', async () => {
  const marks = await reorg(RegistrationWatch);
  expect(marks).toMatchObject({ includedBlock: 100, includedHash: A.hash, includedRetracted: true, finalizedBlock: 100 });
  expect(marks.submitted).toBeUndefined();
  expect(typeof marks.included).toBe('number');
});

it('control: with no reorg the block is read, signing is measured and nothing is flagged', async () => {
  const c = chain();
  const watch = new RegistrationWatch(c.people, 'ada', 20, async () => true).start();
  at(80, () => c.best([A]));
  at(120, () => c.finalized(A));
  const marks = await watch.marks(new AbortController().signal, 5_000, 5_000);
  expect(marks.includedRetracted).toBeUndefined();
  expect(typeof marks.submitted).toBe('number');
  expect(marks).toMatchObject({ includedHash: A.hash, finalizedBlock: 100 });
});

it('says in plain words that signing is unmeasured because the best block lost a reorg', () => {
  const reader = { app: 'Humanity', head: 'best', how: 'poll' } as const;
  const retracted = breakdown({ direction: 'C1', run: '1', reader, tap: 1000, included: 1600, includedBlock: 100, includedRetracted: true, finalized: 2000, finalizedBlock: 100, rendered: 1800 });
  expect(retracted.includedRetracted).toBe(true);
  expect(retracted.segments.find(s => s.name === 'signing')).toMatchObject({ ms: null, note: expect.stringContaining('lost a reorg') });
  expect(commentSection([retracted])).toContain('Included in best block #100 (that block later lost a reorg to a sibling at the same height), finalized by #100.');
  const config = Object.fromEntries(configKeys.map(key => [key, { value: 'value', basis: 'declared', ref: 'source.ts:1' }])) as RunConfig;
  const { html } = renderReport([{ source: 'local', command: 'run c1', verdict: 'passed', config, rows: [{ breakdown: retracted, raw: { tap: 1000 } }] }]);
  expect(html).toContain('Lab best block: #100 (lost a reorg to a sibling at the same height)');
  // Without the flag nothing changes: an unmeasured pool sighting stays a plain "not measured".
  const plain = breakdown({ direction: 'C1', run: '1', reader, tap: 1000, included: 1600, includedBlock: 100, rendered: 1800 });
  expect(plain.includedRetracted).toBeUndefined();
  expect(plain.segments.find(s => s.name === 'signing')).toMatchObject({ ms: null, note: 'not measured' });
  expect(commentSection([plain])).not.toContain('reorg');
  const journey = (includedRetracted?: true) => journeyBreakdown({ direction: 'C4', run: '1', reader: { ...reader, head: 'finalized' }, start: 1000, end: 1800,
    points: [{ name: 'best result', at: 1000 }], includedBlock: 100, ...(includedRetracted ? { includedRetracted } : {}) });
  expect(journey(true).includedRetracted).toBe(true);
  expect(journey().includedRetracted).toBeUndefined();
});

const unguarded = new URL('../chain-watch.unguarded-control.ts', import.meta.url);
afterEach(() => rmSync(unguarded, { force: true }));

it('@negative-control: without the null guard the reorg fails with the CI message', async () => {
  const source = readFileSync(new URL('../chain-watch.ts', import.meta.url), 'utf8');
  const guarded = 'const submitted = block ? submittedMark(block.block.extrinsics, this.pool) : undefined;';
  expect(source).toContain(guarded);
  writeFileSync(unguarded, source.replace(guarded, 'const submitted = submittedMark(block!.block.extrinsics, this.pool);'));
  const { RegistrationWatch: Unguarded } = await import(/* @vite-ignore */ unguarded.href) as { RegistrationWatch: Watch };
  await expect(reorg(Unguarded)).rejects.toThrow("Cannot read properties of null (reading 'block')");
});
