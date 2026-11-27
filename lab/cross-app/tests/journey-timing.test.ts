// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, it, expect } from 'vitest';
import { journeyBreakdown, assertAddsUp, commentSection, summarize } from '../timing.ts';
const reader = { app: 'Jollity', head: 'best' as const, how: 'subscription' };
const entry = () => journeyBreakdown({ direction: 'C3', run: '1', reader, start: 1000, end: 2000,
  points: [{ name: 'tap to navigation', at: 1010 }, { name: 'lab overhead', at: 1100 }, { name: 'navigation to load', at: 1500 }, { name: 'load to data', at: 1950 }] });
describe('entry and return recorder', () => {
  it('keeps lab overhead separate while parts sum to wall time', () => {
    const value = entry(); assertAddsUp(value); expect(value.totalMs).toBe(1000);
    expect(value.segments.filter(s => !s.offPath).map(s => s.ms)).toEqual([10, 90, 400, 450, 50, 0]);
    expect(commentSection([value])).toContain('two-host topology');
    expect(commentSection([value])).toContain('| tap to navigation | 0.010 s |');
    expect(summarize([value])[0]?.segments['lab overhead']?.medianMs).toBe(90);
  });
  it('leaves missing or inverted data marks unattributed', () => {
    for (const at of [undefined, 900, 2100, Number.NaN]) {
      const value = journeyBreakdown({ direction: 'C3', run: 'bad-data', reader, start: 1000, end: 2000, points: [{ name: 'load', at: 1500 }, { name: 'data', at }] });
      assertAddsUp(value); expect(value.segments.find(s => s.name === 'unattributed')?.ms).toBe(500);
    }
  });
  it('counts finality once and prints alternate origins beside the return path', () => {
    const value = journeyBreakdown({ direction: 'C4', run: '1', reader: { ...reader, head: 'finalized' }, start: 0, end: 100000,
      points: [{ name: 'best result', at: 1000 }, { name: 'finality', at: 30000 }, { name: 'chain to data', at: 99000 }], beside: [{ name: 'screen to Humanity', ms: 95000 }] });
    expect(value.label).toBe('too slow'); assertAddsUp(value); expect(value.segments.find(s => s.name === 'screen to Humanity')?.offPath).toBe(true);
  });
  it('negative control: altered overhead or threshold label is refused', () => {
    const value = entry();
    expect(() => commentSection([{ ...value, segments: value.segments.map(s => s.name === 'lab overhead' ? { ...s, ms: 9000 } : s) }])).toThrow(/parts add up/);
    expect(() => commentSection([{ ...value, label: 'slow' }])).toThrow(/label/);
    expect(() => journeyBreakdown({ direction: 'C4', run: '1', reader, start: 1000, end: 999, points: [] })).toThrow();
  });

});

import { navigationPath, sameTime } from '../journey-observations.ts';
describe('navigation and same-next-game-time controls', () => {
  it('follows only the exact destination the host emitted', () => {
    expect(navigationPath('polkadot://dim2.paseo', 'dim2')).toBe('/');
    expect(navigationPath('polkadot://peopl.paseo/', 'peopl')).toBe('/');
    expect(navigationPath('https://peopl.paseo', 'peopl')).toBe('/');
    expect(navigationPath('polkadotapp://pocket/open?product=peopl.paseo&card=humanity', 'peopl')).toBe('/');
    expect(() => navigationPath('polkadotapp://pocket/open?product=other.paseo&card=humanity', 'peopl')).toThrow();
    expect(() => navigationPath('https://dim2.paseo/', 'dim2')).toThrow();
    expect(() => navigationPath('polkadot://other.paseo/', 'dim2')).toThrow();
    expect(() => navigationPath('polkadot://dim2.paseo/?preview=registered', 'dim2')).toThrow();
  });
  it('negative control: catches a single stale displayed time anywhere in the retained history', () => {
    const samples = [
      { at: 1, view: { humanity: 'Saturday, 4:00 AM', jollity: null, enabled: [] } },
      { at: 2, view: { humanity: null, jollity: 'Game starts at 4:00 AM', enabled: [] } },
    ];
    expect(sameTime(samples, 'Saturday, 4:00 AM', '4:00 AM').wrong).toEqual([]);
    expect(sameTime([...samples, { at: 3, view: { humanity: 'Saturday, 3:00 AM', jollity: null, enabled: [] } }], 'Saturday, 4:00 AM', '4:00 AM').wrong).toHaveLength(1);
  });
});

import { sharedDateTimeline } from '../journey-observations.ts';
it('records a temporary disagreement while the apps learn a changed schedule at different heads', () => {
  const labels = [{ date: 1, humanity: 'old-h', jollity: 'old-j' }, { date: 2, humanity: 'new-h', jollity: 'new-j' }];
  const samples: Parameters<typeof sharedDateTimeline>[0] = [
    { app: 'humanity', at: 10, view: { humanity: 'old-h', jollity: null, enabled: [] } },
    { app: 'jollity', at: 11, view: { humanity: null, jollity: 'Game at old-j', enabled: [] } },
    { app: 'jollity', at: 20, view: { humanity: null, jollity: 'Game at new-j', enabled: [] } },
    { app: 'humanity', at: 30, view: { humanity: 'new-h', jollity: null, enabled: [] } },
  ];
  const result = sharedDateTimeline(samples, labels);
  expect(result.states.at(-1)?.same).toBe(true);
  expect(sharedDateTimeline([{ app: 'humanity', at: 1, view: { humanity: null, jollity: null, enabled: [] } }], labels).comparable).toBe(0);
  expect(result.mismatches).toEqual([{ at: 20, humanity: 1, jollity: 2, same: false }]);
});

import { returnedCardMark } from '../journey-observations.ts';
it('a temporary card flash before an optional prompt cannot end the return timer', () => {
  const ready = { humanity: 'next date', jollity: null, cardName: 'Ada', attendance: ['played, last game (game 42)'], enabled: [] };
  const gap = { humanity: null, jollity: null, cardName: null, attendance: [], enabled: [] };
  expect(returnedCardMark([{ at: 1, view: ready }, { at: 2, view: gap }], 42, 'next date', 0)).toBeUndefined();
  expect(returnedCardMark([{ at: 1, view: ready }, { at: 2, view: gap }, { at: 3, view: ready }], 42, 'next date', 0)).toBe(3);
  expect(returnedCardMark([{ at: 3, view: ready }], 43, 'next date', 0)).toBeUndefined();
  expect(returnedCardMark([{ at: 3, view: ready }], 42, 'different date', 0)).toBeUndefined();
});

import { FrameProbe } from '../chain-watch.ts';
it('a finalized return excludes the old state frame received just after page load', () => {
  const probe = new FrameProbe('http://127.0.0.1:4000', '0x' + 'ab'.repeat(32));
  probe.hits.push(150, 250);
  const load = 100, finalized = 200;
  const data = probe.first(Math.max(load, finalized));
  const value = journeyBreakdown({ direction: 'C4', run: 'return', reader: { ...reader, head: 'finalized' }, start: 0, end: 260,
    points: [{ name: 'load', at: load }, { name: 'data', at: data }] });
  expect(value.segments.find(s => s.name === 'data')?.ms).toBe(150);
  expect(value.segments.find(s => s.name === 'render')?.ms).toBe(10);
  expect(probe.first(Math.max(load, 300))).toBeUndefined();
  assertAddsUp(value);
});

import { currentDateCoverage } from '../journey-observations.ts';
it('does not turn a dateless post-game page into next-date agreement', () => {
  const document = (humanity: string | null, jollity: string | null) => ({ loaded: 0, usable: null, attendance: [], views: [{ at: 1, view: { humanity, jollity, enabled: [] } }] });
  expect(currentDateCoverage(document('next-h', null), document(null, 'Game at next-j'), 'next-h', 'next-j').bothExpected).toBe(true);
  expect(currentDateCoverage(document('next-h', null), document(null, null), 'next-h', 'next-j').bothExpected).toBeNull();
  expect(currentDateCoverage(document('old-h', null), document(null, 'Game at next-j'), 'next-h', 'next-j').bothExpected).toBe(false);
});

import { firstPlayCandidate, returnedCardReady } from '../journey-observations.ts';
it('qualifies a first-game candidate by exact finalized score, owner and rendered progress, without a member attendance row', () => {
  const expected = firstPlayCandidate(undefined, { score: 1, last_attended_game: 42, attendance_history: 1, reached_personhood: false }, 42, 7, 'owner');
  const view = { humanity: 'next', jollity: null, enabled: [], cardName: 'Ada', cardState: 'candidate', cardScore: '1', cardAccount: 'owner', cardProgress: 'Progress to membership: 1 of 7' };
  expect(returnedCardMark([{ at: 3, view }], 42, 'next', 0, expected)).toBe(3);
  expect(returnedCardReady(view, 42, 'next')).toBe(false);
  for (const wrong of [{ cardScore: '0' }, { cardAccount: 'other' }, { cardState: 'member' }, { cardProgress: 'Progress to membership: 1 of 8' }, { cardName: null }, { humanity: 'old' }])
    expect(returnedCardReady({ ...view, ...wrong }, 42, 'next', expected)).toBe(false);
  expect(returnedCardMark([{ at: 3, view }, { at: 4, view: { ...view, cardScore: '0' } }], 42, 'next', 0, expected)).toBeUndefined();
});
it('@negative-control: a stale score or an attendance record for another game cannot authorize the candidate return branch', () => {
  const after = { score: 1, last_attended_game: 42, attendance_history: 1, reached_personhood: false };
  for (const wrong of [{ score: 0 }, { last_attended_game: 41 }, { attendance_history: 0 }])
    expect(() => firstPlayCandidate(undefined, { ...after, ...wrong }, 42, 7, 'owner')).toThrow('newly attended finalized game');
  expect(() => firstPlayCandidate({ score: 1, last_attended_game: 41 }, after, 42, 7, 'owner')).toThrow();
  expect(firstPlayCandidate(undefined, { ...after, reached_personhood: true }, 42, 1, 'owner')).toBeUndefined();
});
