// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/// <reference types="vite/client" />
// @vitest-environment jsdom
import { afterEach, beforeEach, it, expect, vi } from 'vitest';
import type { BrowserPage } from '@parity/product-lab/ports/browser';
import { nextGame, attendanceView, assertAttendanceView, watchNextGame, watchedNextGame, assertNextGameHistory, gameMode, chainText, fullUsernameMatches, hasCautionDeadline } from '../../../../lab/shared/observations.ts';
import { Binary } from 'polkadot-api';

const page = { evaluate: async (fn: (arg: unknown) => unknown, arg: unknown) => fn(arg) } as BrowserPage;
beforeEach(() => { vi.spyOn(Element.prototype, 'getClientRects').mockReturnValue([{ width: 1 }] as unknown as DOMRectList); });
afterEach(() => { document.body.innerHTML = ''; vi.restoreAllMocks(); });
it('reads real next-game accessible copy and the rendered scheduled time', async () => {
  document.body.innerHTML = '<section aria-label="Next game"><div class="card-value">Thursday 2:00 PM</div><button aria-label="Registered, open the game">Registered</button></section>';
  expect(await nextGame(page)).toMatchObject({ mode: 'confirmed', value: 'Thursday 2:00 PM' });
  expect(gameMode('Registration opens Thursday', [])).toBe('upcoming');
  expect(gameMode('Not scheduled yet', [])).toBe('no-game');
  expect(gameMode('results', ['Game results pending'])).toBe('results-pending');
  expect(gameMode('game', ['Play now, open the game'])).toBe('play-now');
  expect(gameMode('registration', ['Register'])).toBe('registration-open');
  expect(gameMode('wrapping up', [])).toBe('closed');
  expect(gameMode('loading', [])).toBe('unknown');
});
it('records transient DOM mutations, including an incorrect date that later recovers', async () => {
  document.body.innerHTML = '<section aria-label="Next game"><div class="card-value">old</div><div class="note">Registration opens soon.</div></section>';
  await watchNextGame(page);
  document.querySelector('section')!.innerHTML = '<div class="card-value">new</div><button>Register</button>';
  await Promise.resolve();
  const samples = await watchedNextGame(page);
  expect(samples.map(s => s.value)).toEqual(['old', 'new']);
  expect(() => assertNextGameHistory(samples, 'old', 'new', 0)).toThrow(/Finished game's time/);
  expect(() => assertNextGameHistory([{ at: 90, mode: 'confirmed', value: 'old' }, { at: 120, mode: 'registration-open', value: 'new' }], 'old', 'new', 100)).not.toThrow();
  const state = window as typeof window & { __humanityNextGameWatch?: { observer: MutationObserver } };
  state.__humanityNextGameWatch!.observer.disconnect(); delete state.__humanityNextGameWatch;
});
function renderAttendance() {
  document.body.innerHTML = `<section class="attendance-row" aria-label="Played 6 of the last 8 games, missed the last one"><div class="card-value">Missed the last game</div><div class="marks-row">${Array.from({ length: 8 }, (_, i) => `<i class="mark ${i < 6 ? 'is-attended' : 'is-missed'}" title="${i < 6 ? 'played' : 'missed'}, ${i === 7 ? 'last game' : `${7 - i} games ago`} (game ${i})"></i>`).join('')}</div></section>`;
}
it('compares mark classes, value, summary and every anchored game index with the byte', async () => {
  renderAttendance(); const seen = await attendanceView(page);
  expect(() => assertAttendanceView(seen, { value: 'Missed the last game', attended: 6, missed: 2 }, 252, 5)).not.toThrow();
  const mark = document.querySelectorAll('.mark')[0]!; mark.setAttribute('title', 'played, 7 games ago (game 99)');
  expect(() => assertAttendanceView({ ...seen!, marks: [{ classes: 'mark is-attended', title: mark.getAttribute('title')! }, ...seen!.marks.slice(1)] }, { value: 'Missed the last game', attended: 6, missed: 2 }, 252, 5)).toThrow(/game index/);
});
it('@negative-control: a wrong played count fails at the attendance assertion', async () => {
  renderAttendance(); const seen = await attendanceView(page);
  expect(() => assertAttendanceView(seen, { value: 'Missed the last game', attended: 7, missed: 2 }, 252, 5)).toThrow('Attendance row differs from finalized chain record');
});
it('decodes Resources/consumer bytes in both PAPI representations', () => {
  expect(chainText(new TextEncoder().encode('adalovelace'))).toBe('adalovelace');
  expect(chainText(Binary.fromText('adalovelace'))).toBe('adalovelace');
  expect(chainText(undefined)).toBeUndefined();
});

it('checks both name directions on the linked identity rather than the signing product account', () => {
  const identity = '0x' + '11'.repeat(32), submitter = '0x' + '22'.repeat(32);
  const consumer = { full_username: Binary.fromText('adalovelace') }, names = { full: { label: new TextEncoder().encode('adalovelace') } };
  expect(fullUsernameMatches(identity, consumer, names, identity, 'adalovelace')).toBe(true);
  expect(fullUsernameMatches(submitter, consumer, names, identity, 'adalovelace')).toBe(false);
  expect(fullUsernameMatches(identity, consumer, names, identity, 'different')).toBe(false);
});

it('caution deadline rejects the no-deadline fallback', () => {
  expect(hasCautionDeadline("Play the next game to keep it.")).toBe(false);
  expect(hasCautionDeadline('Play today to keep it.')).toBe(true);
  expect(hasCautionDeadline('Play tomorrow to keep it.')).toBe(true);
  expect(hasCautionDeadline('Play someday to keep it.')).toBe(false);
});
it('rejects the old date in every mode after the next schedule finalized', () => {
  const current = { at: 120, mode: 'registration-open', value: 'new' };
  for (const mode of ['results-pending', 'closed', 'play-now', 'confirmed', 'registration-open', 'unknown']) {
    expect(() => assertNextGameHistory([{ at: 110, mode, value: 'old' }, current], 'old', 'new', 100)).toThrow(/Finished game's time/);
    expect(() => assertNextGameHistory([{ at: 90, mode, value: 'old' }, current], 'old', 'new', 100)).not.toThrow();
  }
  expect(() => assertNextGameHistory([current], 'old', 'new', NaN)).toThrow(/Missing distinct dates/);
});

it('rejects a history whose only new-date sample is upcoming', () => {
  expect(() => assertNextGameHistory([{ at: 120, mode: 'upcoming', value: 'new' }], 'old', 'new', 100)).toThrow('Watch did not record the next scheduled game');
});

it.each(['adalab.04', 'adalab.04.paseo', 'adalab.04.testnet', 'adalab.04.dot'])('keeps the host suffix convention after a claim for %s', async host => {
  const { claimedCardName } = await import('../../../../lab/shared/observations.ts');
  const { linkedCardIdentity } = await import('@humanity/shared/card/linked-card-identity.ts');
  const { memberDisplayName } = await import('../../src/features/card/components/MemberCard.tsx');
  const expected = linkedCardIdentity({ primaryUsername: host, username: 'adalab.04', isUpgraded: false }, new TextEncoder().encode('adalabclaimed')).primaryUsername;
  expect(claimedCardName(host, 'adalabclaimed')).toBe(expected);
  expect(memberDisplayName({ kind: 'member', activeWeeks: 2 } as Parameters<typeof memberDisplayName>[0], expected)).toBe(expected);
});
