// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { createRequire } from 'node:module';
const { JSDOM } = createRequire(import.meta.url)('jsdom') as { JSDOM: new (html: string) => { window: Window & typeof globalThis } };
import { runInNewContext } from 'node:vm';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import type { BrowserPage } from '@parity/product-lab/ports/browser';
import { customSteps, type StepContext } from '@parity/product-lab/steps';
import { AttendanceRow } from '../../src/features/card/components/AttendanceRow.tsx';
import { dismissCautionSheet } from '../../../../lab/shared/home.ts';

const fixture = vi.hoisted(() => ({ page: undefined as unknown as BrowserPage, polls: 1, beforePoll: (_i: number) => undefined as void, score: {
  value: { attendance_history: 252, streak: { type: 'Absent', value: 2 }, last_attended_game: 5 },
} }));
vi.mock('../../../../lab/shared/session.ts', () => ({ scenario: () => ({
  actor: () => ({ game: { address: 'game-account' }, view: { page: fixture.page } }),
  chain: { score: async () => fixture.score, until: async (_label: string, read: () => Promise<unknown>) => {
    for (let i = 0; i < fixture.polls; i++) { fixture.beforePoll(i); const value = await read(); if (value) return value; } throw Error('Timed out: attendance row matches chain');
  } },
}) }));
import '../../lab/scenarios/steps.ts';
const dom = new JSDOM('<body></body>');
const document = dom.window.document;
beforeEach(() => vi.spyOn(dom.window.Element.prototype, 'getClientRects').mockReturnValue([{}] as unknown as DOMRectList));
afterEach(() => { fixture.polls = 1; fixture.beforePoll = () => undefined; vi.restoreAllMocks(); document.body.innerHTML = ''; });
it.each([6, 9])('dismisses only the urgent sheet and reaches the real attendance comparison with requested played=%s', async played => {
  document.body.innerHTML = '<dialog class="caution-sheet" open><button class="cta-ghost">Not this week</button></dialog>' + renderToStaticMarkup(createElement(AttendanceRow, {
    state: { kind: 'member', activeWeeks: 0, attendanceHistory: 252, lastAttendedGame: 5, window: 8 },
  }));
  const click = vi.fn(async () => document.querySelector('dialog')!.removeAttribute('open'));
  fixture.page = { evaluate: async (fn: (arg: unknown) => unknown, arg: unknown) => runInNewContext(`(${fn.toString()})(arg)`, { arg, document }), locator: (selector: string) => ({
    textContent: async () => document.querySelector(selector)?.textContent, click,
  }) } as unknown as BrowserPage;
  const attach = vi.fn(async () => undefined);
  const check = customSteps().find(step => step.pattern.text === '{actor} sees the attendance row:')!;
  const result = check.run({ lab: { attach } } as unknown as StepContext, 'Ada', [['value', 'Missed the last game'], ['attended', String(played)], ['missed', '2']]);
  if (played === 6) await expect(result).resolves.toBeUndefined();
  else await expect(result).rejects.toThrow('Attendance row differs from finalized chain record');
  expect(click).toHaveBeenCalledOnce();
  expect(attach).toHaveBeenCalledWith({ cautionSheetDismissed: true });
  expect(attach).toHaveBeenCalledWith(expect.objectContaining({ seen: expect.objectContaining({ value: 'Missed the last game' }) }));
});
it.each(['absent', 'closed', 'hidden'])('does not dismiss anything when the urgent sheet is %s', async state => {
  document.body.innerHTML = state === 'absent' ? '<button>Not this week</button>' : `<dialog class="caution-sheet" ${state === 'hidden' ? 'open' : ''}><button class="cta-ghost">Not this week</button></dialog>`;
  const dialog = document.querySelector('dialog');
  if (state === 'hidden') vi.spyOn(dialog!, 'getClientRects').mockReturnValue([] as unknown as DOMRectList);
  const locator = vi.fn();
  const page = { evaluate: async (fn: (arg: unknown) => unknown, arg: unknown) => runInNewContext(`(${fn.toString()})(arg)`, { arg, document }), locator } as unknown as BrowserPage;
  expect(await dismissCautionSheet(page)).toBe(false); expect(locator).not.toHaveBeenCalled();
});
it('records no sheet dismissal before the wrong-count comparison when the home has no sheet', async () => {
  document.body.innerHTML = renderToStaticMarkup(createElement(AttendanceRow, {
    state: { kind: 'member', activeWeeks: 0, attendanceHistory: 252, lastAttendedGame: 5, window: 8 },
  }));
  const locator = vi.fn();
  fixture.page = { evaluate: async (fn: (arg: unknown) => unknown, arg: unknown) => runInNewContext(`(${fn.toString()})(arg)`, { arg, document }), locator } as unknown as BrowserPage;
  const attach = vi.fn(async () => undefined), check = customSteps().find(step => step.pattern.text === '{actor} sees the attendance row:')!;
  await expect(check.run({ lab: { attach } } as unknown as StepContext, 'Ada', [['value', 'Missed the last game'], ['attended', '9'], ['missed', '2']])).rejects.toThrow('Attendance row differs from finalized chain record');
  expect(attach).toHaveBeenCalledWith({ cautionSheetDismissed: false }); expect(locator).not.toHaveBeenCalled();
});

function renderRow(history: number, lastAttendedGame = 5) {
  document.body.innerHTML = renderToStaticMarkup(createElement(AttendanceRow, {
    state: { kind: 'member', activeWeeks: 0, attendanceHistory: history, lastAttendedGame, window: 8 },
  }));
  fixture.page = { evaluate: async (fn: (arg: unknown) => unknown, arg: unknown) => runInNewContext(`(${fn.toString()})(arg)`, { arg, document }) } as unknown as BrowserPage;
}
it.each([6, 9])('waits through the stale consecutive-miss row before checking requested played=%s', async played => {
  renderRow(254); fixture.polls = 2;
  const snapshots: string[] = [];
  fixture.beforePoll = i => { if (i === 1) renderRow(252); snapshots.push(document.body.innerHTML); };
  const attach = vi.fn(async () => undefined), check = customSteps().find(step => step.pattern.text === '{actor} sees the attendance row:')!;
  const result = check.run({ lab: { attach } } as unknown as StepContext, 'Ada', [['value', 'Missed the last game'], ['attended', String(played)], ['missed', '2']]);
  if (played === 6) await expect(result).resolves.toBeUndefined();
  else await expect(result).rejects.toThrow('Attendance row differs from finalized chain record');
  expect(snapshots).toHaveLength(2);
  expect(attach).toHaveBeenCalledWith(expect.objectContaining({ seen: expect.objectContaining({ summary: 'Played 6 of the last 8 games, missed the last one' }) }));
});
it.each(['stale-history', 'wrong-anchor'])('times out on %s and attaches the last complete row instead of reaching the expectation', async mode => {
  renderRow(mode === 'stale-history' ? 254 : 252, mode === 'wrong-anchor' ? 6 : 5);
  const attach = vi.fn(async () => undefined), check = customSteps().find(step => step.pattern.text === '{actor} sees the attendance row:')!;
  await expect(check.run({ lab: { attach } } as unknown as StepContext, 'Ada', [['value', 'Missed the last game'], ['attended', '9'], ['missed', '2']])).rejects.toThrow('Timed out: attendance row matches chain');
  expect(attach).toHaveBeenCalledWith(expect.objectContaining({ lastSeen: expect.objectContaining({ marks: expect.any(Array) }), attendanceReadiness: 'timed-out-or-failed' }));
});
