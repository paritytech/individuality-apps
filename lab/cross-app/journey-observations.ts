// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { addressesEqual } from '@parity/product-sdk/address';
export interface DocumentMarks { loaded: number | null; usable: number | null; attendance: Array<{ at: number; game: number }>; views: Array<{ at: number; view: { humanity: string | null; jollity: string | null; status?: string; enabled: Array<string | undefined>; cardName?: string | null; attendance?: Array<string | null>; missed?: Array<string | null>; cardLabel?: string | null; cardState?: string | null; cardScore?: string | null; cardAccount?: string | null; cardProgress?: string | null; caution?: string | null; update?: boolean; blocked?: boolean; jollityMissed?: boolean; path?: string; account?: string | null } }> }

export function navigationPath(url: string, product: 'dim2' | 'peopl') {
  const target = new URL(url);
  if (target.username || target.password || target.port || target.hash) throw Error('Unexpected host navigation target');
  if (product === 'peopl' && target.protocol === 'polkadotapp:' && target.hostname === 'pocket' && target.pathname === '/open' &&
      target.searchParams.get('product') === 'peopl.paseo' && target.searchParams.get('card') === 'humanity' && [...target.searchParams].length === 2) return '/';
  const protocol = target.protocol === 'polkadot:' || product === 'peopl' && target.protocol === 'https:';
  if (!protocol || target.hostname !== `${product}.paseo` || target.search) throw Error('Unexpected host navigation target');
  return target.pathname || '/';
}
export function isHumanityNavigation(url: string) {
  try { navigationPath(url, 'peopl'); return true; } catch { return false; }
}

/** Compare the actual localized dates, not countdown text. Every visible sampled date must be the scheduled date. */
export function sameTime(samples: DocumentMarks['views'], humanity: string, jollity: string) {
  const wrong = samples.filter(s => (s.view.humanity && s.view.humanity !== 'Not scheduled yet' && s.view.humanity !== humanity) ||
    (s.view.jollity && s.view.jollity !== `Game starts at ${jollity}` && s.view.jollity !== `Game at ${jollity}` && s.view.jollity !== `at ${jollity}`));
  return { checked: samples.filter(s => s.view.humanity || s.view.jollity).length, wrong };
}

/** Merge retained mutation samples. A missing date is a coverage gap, not agreement.
 * Labels are the actual locale strings for known on-chain schedules, never a parsed countdown. */
export function sharedDateTimeline(samples: Array<DocumentMarks['views'][number] & { app: 'humanity' | 'jollity' }>, labels: Array<{ date: number; humanity: string; jollity: string }>) {
  let h: number | null = null, j: number | null = null;
  const states: Array<{ at: number; humanity: number; jollity: number; same: boolean }> = [];
  for (const sample of [...samples].sort((a, b) => a.at - b.at)) {
    if (sample.app === 'humanity') h = labels.find(l => l.humanity === sample.view.humanity)?.date ?? null;
    if (sample.app === 'jollity') j = labels.find(l => [`Game starts at ${l.jollity}`, `Game at ${l.jollity}`, `at ${l.jollity}`].includes(sample.view.jollity!))?.date ?? null;
    if (h !== null && j !== null) states.push({ at: sample.at, humanity: h, jollity: j, same: h === j });
  }
  return { comparable: states.length, mismatches: states.filter(s => !s.same), states };
}

export interface CandidateReturn { score: number; threshold: number; owner: string }
/** A first game's candidate card carries progress, while the attendance row is a member surface. */
export function firstPlayCandidate(before: { score: number; last_attended_game?: number } | undefined,
  after: { score: number; last_attended_game?: number; attendance_history: number; reached_personhood: boolean },
  game: number, threshold: number, owner: string): CandidateReturn | undefined {
  if (before && (before.score !== 0 || before.last_attended_game !== undefined) || after.last_attended_game !== game ||
    !(after.attendance_history & 1) || after.score <= (before?.score ?? 0) || !Number.isInteger(threshold) || threshold < 1)
    throw Error('First-game return needs a newly attended finalized game and an increased score');
  return !after.reached_personhood && after.score < threshold ? { score: after.score, threshold, owner } : undefined;
}
function sameOwner(actual: string | null | undefined, expected: string) {
  if (!actual) return false;
  if (actual === expected) return true;
  try { return addressesEqual(actual, expected); } catch { return false; }
}
/** Observe the first-game progress without awaiting a chain proof; exact facts are checked after timing closes. */
export function observedCandidate(view: DocumentMarks['views'][number]['view'], beforeScore: number, owner: string): CandidateReturn | undefined {
  const progress = /^Progress to membership: ([0-9]+) of ([0-9]+)$/.exec(view.cardProgress ?? '');
  if (!progress || view.cardState !== 'candidate' || !sameOwner(view.cardAccount, owner)) return undefined;
  const score = Number(progress[1]), threshold = Number(progress[2]);
  return Number.isSafeInteger(score) && Number.isSafeInteger(threshold) && score > beforeScore && score < threshold &&
    view.cardScore === String(score) ? { score, threshold, owner } : undefined;
}
/** The returned card (the attendance row, or a first game's candidate progress) is Ada's `Score.Participants` row,
 * which her own game report writes, some blocks before the game ends. The lab's result mark is the first best block
 * holding that row: a mark that also waited for the game's end could come after the card it is meant to precede. */
export function returnedCardResult(row: { last_attended_game?: number } | undefined, game: number) {
  return row?.last_attended_game === game;
}
export function returnedCardReady(view: DocumentMarks['views'][number]['view'], game: number, date: string, candidate?: CandidateReturn) {
  if (view.humanity !== date || !view.cardName) return false;
  return candidate ? view.cardState === 'candidate' && view.cardScore === String(candidate.score) &&
    sameOwner(view.cardAccount, candidate.owner) && view.cardProgress === `Progress to membership: ${candidate.score} of ${candidate.threshold}`
    : Boolean(view.attendance?.some(t => t?.endsWith(`(game ${game})`)));
}

/** First mark in the current uninterrupted ready interval. A prompt or loading view invalidates an earlier flash. */
export function returnedCardMark(views: DocumentMarks['views'], game: number, date: string, from: number, candidate?: CandidateReturn) {
  let at: number | undefined;
  for (const sample of views) {
    if (sample.at < from) continue;
    const ready = returnedCardReady(sample.view, game, date, candidate);
    if (!ready) at = undefined;
    else at ??= sample.at;
  }
  return at;
}

/** A missing current date is a coverage gap, regardless of an earlier comparable equality. */
export function currentDateCoverage(humanity: DocumentMarks | null, jollity: DocumentMarks | null, expectedH: string, expectedJ: string) {
  const h = humanity?.views.at(-1)?.view.humanity, j = jollity?.views.at(-1)?.view.jollity;
  const hm = h ? h === expectedH : null;
  const jm = j ? [`Game starts at ${expectedJ}`, `Game at ${expectedJ}`, `at ${expectedJ}`].includes(j) : null;
  return { humanity: hm, jollity: jm, bothExpected: hm === null || jm === null ? null : hm && jm };
}
