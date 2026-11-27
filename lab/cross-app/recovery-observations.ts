// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import type { DocumentMarks } from './journey-observations.ts';

/** First mark in the current uninterrupted matching interval, never a vanished flash. */
export function currentReady(views: DocumentMarks['views'], from: number, matches: (view: DocumentMarks['views'][number]['view']) => boolean) {
  let at: number | undefined;
  for (const sample of views) {
    if (sample.at < from) continue;
    if (!matches(sample.view)) at = undefined;
    else at ??= sample.at;
  }
  return at;
}
export function missedView(view: DocumentMarks['views'][number]['view'], game: number) {
  return Boolean(!view.blocked && !view.update && view.cardName && view.cardLabel === 'Member, at risk' && view.caution &&
    view.missed?.some(title => title?.startsWith('missed, ') && title.endsWith(`(game ${game})`)));
}
export function registeredView(view: DocumentMarks['views'][number]['view'], account: string) {
  return view.path === '/' && view.account === account && view.status === "You're in";
}

/** Synthetic member history must end immediately before the measured game. Never seed the measured absence. */
export function fixtureAttendanceIndex(game: number, lastAttended: number | undefined) {
  if (!Number.isSafeInteger(game) || game < 1 || lastAttended === undefined || !Number.isSafeInteger(lastAttended) || lastAttended < 0 || lastAttended >= game) throw Error('Invalid pre-game attendance fixture');
  return lastAttended === game - 1 ? undefined : game - 1;
}

/** Observer notifications can trail visible state. Preserve a signed offset, never clamp it into a latency. */
export function relativeObservation(origin: number, shown: number, finalized?: number) {
  if (![origin, shown, ...(finalized === undefined ? [] : [finalized])].every(Number.isFinite)) throw Error('Invalid observation clock');
  const offsetMs = shown - origin;
  return { offsetMs, forwardMs: offsetMs >= 0 ? offsetMs : null, finalizedOffsetMs: finalized === undefined ? null : shown - finalized };
}

/** A passive queued next-game date is already a displayed next game; an enabled Register is a later milestone. */
export function jollityNextDate(view: DocumentMarks['views'][number]['view'], account: string, date: string) {
  return view.account === account && [`Game starts at ${date}`, `Game at ${date}`, `at ${date}`].includes(view.jollity!) && !view.update;
}
