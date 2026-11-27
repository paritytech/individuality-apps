// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { expect, it } from 'vitest';
import { currentReady, missedView, registeredView, fixtureAttendanceIndex, relativeObservation, jollityNextDate } from '../recovery-observations.ts';
import { assertAddsUp, journeyBreakdown, summarize } from '../timing.ts';
import type { DocumentMarks } from '../journey-observations.ts';
const view: DocumentMarks['views'][number]['view'] = { humanity: 'Saturday', jollity: null, enabled: ['Register'], cardName: 'ada', cardLabel: 'Member, at risk', caution: 'Play today to keep it.', missed: ['missed, last game (game 42)'] };
it('requires the exact missed game, card and caution, with negative controls', () => {
  expect(missedView(view, 42)).toBe(true);
  expect(missedView(view, 41)).toBe(false);
  expect(missedView({ ...view, missed: ['played, last game (game 42)'] }, 42)).toBe(false);
  expect(missedView({ ...view, caution: null }, 42)).toBe(false);
  expect(missedView({ ...view, cardName: null }, 42)).toBe(false);
});
it('never accepts another account or a registration on another route', () => {
  const registered = { ...view, path: '/', account: 'ada', status: "You're in" };
  expect(registeredView(registered, 'ada')).toBe(true);
  expect(registeredView(registered, 'eve')).toBe(false);
  expect(registeredView({ ...registered, path: '/game' }, 'ada')).toBe(false);
});
it('resets a vanished ready interval and excludes pre-foreground marks', () => {
  const good = view, bad = { ...view, caution: null };
  const samples = [{ at: 10, view: good }, { at: 20, view: bad }, { at: 30, view: good }];
  expect(currentReady(samples, 0, v => missedView(v, 42))).toBe(30);
  expect(currentReady(samples.slice(0, 2), 0, v => missedView(v, 42))).toBeUndefined();
  expect(currentReady(samples, 31, v => missedView(v, 42))).toBeUndefined();
});
it('counts every lab action once, including its overlap with an unattributed gap', () => {
  const input = { direction: 'C5' as const, run: 'control', reader: { app: 'Humanity', head: 'finalized' as const, how: 'test' }, start: 0, end: 100,
    points: [{ name: 'data', at: 50 }], actions: [{ name: 'lab dismiss', at: 40, done: 60 }] };
  const value = journeyBreakdown(input); assertAddsUp(value);
  expect(value.segments.find(s => s.name === 'wall time outside recorded lab intervals')?.ms).toBe(80);
  expect(value.segments.find(s => s.name === 'data')?.note).toContain('50 ms wall span');
  expect(value.segments.filter(s => !s.offPath)).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'data', ms: 40 }), expect.objectContaining({ name: 'render', ms: 40 }), expect.objectContaining({ name: 'lab dismiss', ms: 20 }), expect.objectContaining({ name: 'unattributed', ms: 0 })]));
  expect(() => journeyBreakdown({ ...input, actions: [{ name: 'bad', at: 60, done: 40 }] })).toThrow('Invalid');
  expect(() => journeyBreakdown({ ...input, actions: [...input.actions, { name: 'overlap', at: 50, done: 70 }] })).toThrow('overlapping');
  expect(value.segments.find(s => s.name === 'lab dismiss')?.spans).toEqual([{ start: 40, end: 60 }]);
  expect(value.segments.find(s => s.name === 'data')?.spans).toEqual([{ start: 0, end: 40 }]);
  expect(() => journeyBreakdown({ ...input, beside: [{ name: 'bad finality', ms: NaN }] })).toThrow('Invalid segment');
});

it('keeps endpoint medians separate rather than counting three endpoints as three no-show games', () => {
  const input = { direction: 'C5' as const, run: '1', reader: { app: 'Humanity', head: 'finalized' as const, how: 'test' }, start: 0, points: [] };
  const values = [journeyBreakdown({ ...input, metric: 'missed', end: 100 }), journeyBreakdown({ ...input, metric: 'next', end: 500 }), journeyBreakdown({ ...input, metric: 'missed', run: '2', end: 200 })];
  const summary = summarize(values);
  expect(summary.find(s => s.metric === 'missed')).toMatchObject({ runs: 2, medianMs: 150 });
  expect(summary.find(s => s.metric === 'next')).toMatchObject({ runs: 1, medianMs: 500 });
});

it('seeds only the prior synthetic attended game when cancellation left a fixture gap', () => {
  expect(fixtureAttendanceIndex(291, 289)).toBe(290);
  expect(fixtureAttendanceIndex(291, 290)).toBeUndefined();
  expect(() => fixtureAttendanceIndex(291, 291)).toThrow('Invalid');
  expect(() => fixtureAttendanceIndex(291, undefined)).toThrow('Invalid');
  expect(() => fixtureAttendanceIndex(NaN, 290)).toThrow('Invalid');
});

it('retains a visible lead over the independent lab mark, without a fake zero latency', () => {
  expect(relativeObservation(1000, 900, 1200)).toEqual({ offsetMs: -100, forwardMs: null, finalizedOffsetMs: -300 });
  expect(relativeObservation(1000, 1100)).toEqual({ offsetMs: 100, forwardMs: 100, finalizedOffsetMs: null });
  expect(() => relativeObservation(NaN, 1100)).toThrow('Invalid');
});

it('counts a passive next-game date without waiting for Register, with wrong-account/date controls', () => {
  const queued = { ...view, account: 'ada', jollity: 'Game at 6:00 AM', status: undefined, enabled: [] };
  expect(jollityNextDate(queued, 'ada', '6:00 AM')).toBe(true);
  expect(jollityNextDate(queued, 'eve', '6:00 AM')).toBe(false);
  expect(jollityNextDate(queued, 'ada', '7:00 AM')).toBe(false);
  expect(jollityNextDate({ ...queued, update: true }, 'ada', '6:00 AM')).toBe(false);
});
it('summarizes repeated lab action names as their per-run total without double-counting a beside copy', () => {
  const input = { direction: 'C5' as const, run: '1', reader: { app: 'Humanity', head: 'finalized' as const, how: 'test' }, start: 0, end: 100, endName: 'state wait', points: [],
    actions: [{ name: 'lab click', at: 10, done: 20 }, { name: 'lab click', at: 30, done: 50 }], beside: [{ name: 'lab click', ms: 30 }] };
  const value = journeyBreakdown(input);
  expect(value.segments.find(s => s.name === 'state wait')?.ms).toBe(70);
  expect(summarize([value])[0]!.segments['lab click']!.medianMs).toBe(30);
});

it('prints an in-window sub-millisecond lab action as an explicit zero part, never omitting it', () => {
  const value = journeyBreakdown({ direction: 'U3', run: 'zero', reader: { app: 'Jollity', head: 'best', how: 'test' }, start: 0, end: 100, points: [], actions: [{ name: 'lab version promotion', at: 20, done: 20 }] });
  expect(value.segments.find(s => s.name === 'lab version promotion')).toMatchObject({ ms: 0 });
  assertAddsUp(value);
});
