// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// The returned card's start mark. Ada's own game report writes her Score.Participants row; the game ends some blocks
// later (five or six on the CI copies since 2026-11-12). Humanity's card shows only that row, read at finality on a
// 12 s poll, so it can appear before the game-end block exists. A start mark that also waited for the game's end then
// came after the card, and the C4 return step threw "Finalized verification must be outside and after every measured
// window" (#1988, C4 and C6 on cross-app run 43354868868).
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { RegistrationWatch, type ChainMarks } from '../chain-watch.ts';
import { returnedCardResult } from '../journey-observations.ts';
import { assertVerificationAfter, journeyBreakdown } from '../timing.ts';

type Head = { number: number; hash: string };
type State = { score: { last_attended_game?: number }; current: { index: number } };
const game = 336;
const report: Head = { number: 206, hash: '0x' + 'aa'.repeat(32) }; // Ada's report: her row says game 336, game 336 still current
const ended: Head = { number: 212, hash: '0x' + 'bb'.repeat(32) }; // GameEnded: the next game is current
const state: Record<string, State> = {
  [report.hash]: { score: { last_attended_game: game }, current: { index: game } },
  [ended.hash]: { score: { last_attended_game: game }, current: { index: game + 1 } },
};

function subject<T>() {
  const subs = new Set<(value: T) => void>();
  return { observable: { subscribe: (o: { next: (value: T) => void }) => { subs.add(o.next); return { unsubscribe: () => subs.delete(o.next) }; } },
    emit: (value: T) => subs.forEach(next => next(value)) };
}
function chain() {
  const best = subject<Head[]>(), finalized = subject<Head>();
  const client = { bestBlocks$: best.observable, finalizedBlock$: finalized.observable, async _request(method: string) {
    if (method === 'author_pendingExtrinsics') return [];
    if (method === 'chain_getBlock') return { block: { extrinsics: ['0x0102'] } };
    throw Error(`unexpected ${method}`);
  } };
  return { people: { access: { client } } as never, best: best.emit, finalized: finalized.emit };
}
const sleep = (ms: number) => new Promise(done => setTimeout(done, ms));

/** The CI order: report at best, report finalized, Humanity's card shows the row, then the game-end block. */
async function returnRun(qualifies: (hash: string) => Promise<boolean>) {
  const c = chain(), watch = new RegistrationWatch(c.people, 'ada', 20, qualifies).start();
  const exitTap = Date.now();
  let shown = 0;
  setTimeout(() => c.best([report]), 40);
  setTimeout(() => c.finalized(report), 140);
  setTimeout(() => { shown = Date.now(); }, 240); // Humanity's next 12 s card read lands on the finalized report
  setTimeout(() => c.best([ended]), 400);
  setTimeout(() => c.finalized(ended), 500);
  await sleep(600);
  const chainMarks: ChainMarks = await watch.marks(new AbortController().signal, 5_000, 5_000);
  const windows = [{ start: chainMarks.included, end: shown }, { start: exitTap, end: shown }];
  const at = Date.now();
  return { chainMarks, shown, exitTap, windows, verify: () => assertVerificationAfter({ at, done: at }, windows) };
}

/** journeys.ts's C4 predicate, read through the shared helper. */
const fixed = async (hash: string) => returnedCardResult(state[hash]!.score, game);
/** The predicate before this change (journeys.ts C4 step): the row and the game's end. */
const waitsForGameEnd = async (hash: string) => state[hash]!.score.last_attended_game === game && state[hash]!.current.index !== game;

it('marks the result at Ada\'s report block, which comes before the card it shows', async () => {
  const run = await returnRun(fixed);
  expect(run.verify).not.toThrow(); // first, so the old start rule fails here with the CI message
  expect(run.chainMarks.includedBlock).toBe(report.number);
  expect(run.chainMarks.included).toBeLessThan(run.shown);
  const value = journeyBreakdown({ direction: 'C4', run: '1', reader: { app: 'Humanity', head: 'finalized', how: 'test' }, start: run.chainMarks.included, end: run.shown,
    points: [{ name: 'best attendance record', at: run.chainMarks.included }, { name: 'lab-observed finality, upper bound', at: run.chainMarks.finalized }] });
  expect(value.totalMs).toBe(run.shown - run.chainMarks.included);
});

it('keeps a row from an earlier game from counting', () => {
  expect(returnedCardResult({ last_attended_game: game - 1 }, game)).toBe(false);
  expect(returnedCardResult(undefined, game)).toBe(false);
  expect(returnedCardResult({ last_attended_game: game }, game)).toBe(true);
});

it('the C4 watch in journeys.ts uses the shared predicate and no longer waits for the game to end', () => {
  const source = readFileSync(new URL('../journeys.ts', import.meta.url), 'utf8');
  const c4 = source.slice(source.indexOf("step('Ada plays in Jollity and returns"), source.indexOf('let raw: Record<string, unknown> = {};', source.indexOf("step('Ada plays in Jollity and returns")));
  expect(c4).toContain('returnedCardResult(');
  expect(c4).not.toContain("'Game', 'Game'");
  // The start no longer waits for the game's end, so the step itself must wait for the finalized GameEnded event.
  const stepStart = source.indexOf("step('Ada plays in Jollity and returns");
  const step = source.slice(stepStart, source.indexOf('\nstep(', stepStart + 1));
  expect(step).toMatch(/const gameEnded = await state\.chain\.until\('indexed finalized GameEnded for measured game', \(\) => state\.chain\.findEvent\(/);
});

it('@negative-control: waiting for the game\'s end puts the start after the card and throws the CI message', async () => {
  const run = await returnRun(waitsForGameEnd);
  expect(run.chainMarks.includedBlock).toBe(ended.number);
  expect(run.chainMarks.included).toBeGreaterThan(run.shown);
  expect(run.verify).toThrow('Finalized verification must be outside and after every measured window');
});
