// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { accountKey } from './upstream/lab/full-journey/identity.ts';
import type { BrowserPage } from '@parity/product-lab/ports/browser';
import { readWatchedText } from './watched-text.ts';

export interface GameView { mode: string; value: string; text: string }
export function gameMode(text: string, buttons: string[]): string {
  if (buttons.includes('Registered, open the game')) return 'confirmed';
  if (buttons.includes('Register')) return 'registration-open';
  if (buttons.includes('Game results pending')) return 'results-pending';
  if (buttons.includes('Play now, open the game')) return 'play-now';
  if (text.includes('Registration opens')) return 'upcoming';
  if (text.includes('Not scheduled yet')) return 'no-game';
  if (/closed|wrapping up|under way|shuffling/i.test(text)) return 'closed';
  return 'unknown';
}
export async function nextGame(page: BrowserPage): Promise<GameView | undefined> {
  const seen = await readWatchedText(page, () => {
    const block = document.querySelector('section[aria-label="Next game"]');
    return block && block.getClientRects().length ? { text: block.textContent ?? '', value: block.querySelector('.card-value')?.textContent?.trim() ?? '',
      buttons: Array.from(block.querySelectorAll('button')).map(b => b.getAttribute('aria-label') ?? b.textContent?.trim() ?? '') } : null;
  });
  return seen ? { mode: gameMode(seen.text, seen.buttons), value: seen.value, text: seen.text } : undefined;
}
export interface AttendanceView { value: string; summary: string; marks: { classes: string; title: string }[] }
export async function attendanceView(page: BrowserPage) {
  return readWatchedText(page, () => {
    const block = document.querySelector('section.attendance-row');
    if (!block || !block.getClientRects().length) return null;
    return { value: block.querySelector('.card-value')?.textContent?.trim() ?? '', summary: block.getAttribute('aria-label') ?? '',
      marks: Array.from(block.querySelectorAll('.mark')).map(m => ({ classes: m.className, title: m.getAttribute('title') ?? '' })) };
  });
}
export function assertAttendanceView(seen: AttendanceView | null, expected: { value: string; attended: number; missed: number }, history: number, lastAttendedGame: number | undefined) {
  if (!seen) throw Error('Attendance row missing');
  const played = seen.marks.filter(m => m.classes.split(' ').includes('is-attended')).length;
  const missed = seen.marks.filter(m => m.classes.split(' ').includes('is-missed')).length;
  if (seen.value !== expected.value || played !== expected.attended || missed !== expected.missed ||
    !seen.summary.includes(`Played ${played} of the last ${played + missed} games`)) throw Error('Attendance row differs from finalized chain record');
  if (seen.marks.length !== 8) throw Error('Attendance row must contain eight marks');
  const low = history === 0 ? undefined : Math.log2(history & -history);
  const anchor = low === undefined || lastAttendedGame === undefined ? undefined : lastAttendedGame + low;
  for (let i = 0; i < 8; i++) {
    const mark = seen.marks[i]!;
    if (mark.classes.includes('is-before')) continue;
    const ago = 7 - i, attended = ((history >> ago) & 1) === 1;
    if (!mark.classes.includes(attended ? 'is-attended' : 'is-missed') ||
      !mark.title.startsWith(attended ? 'played, ' : 'missed, ') || (anchor !== undefined && !mark.title.endsWith(`(game ${anchor - ago})`))) throw Error('Attendance mark or game index differs from finalized history');
  }
}

/** A5 has eight recorded games. Match the entire finalized byte, streak, summary and anchors
 * before applying the requested expectation; a lagging row cannot qualify a wrong-count control. */
export function attendanceMatchesChain(seen: AttendanceView | null, record: { attendance_history: number; streak: { type: string; value: number }; last_attended_game?: number }) {
  const attended = Array.from({ length: 8 }, (_, i) => (record.attendance_history >> i) & 1).reduce((sum, bit) => sum + bit, 0);
  const value = record.streak.type === 'Attended' ? `${record.streak.value} in a row` : 'Missed the last game';
  if (!seen || seen.marks.some(mark => mark.classes.split(' ').includes('is-before')) ||
    seen.summary !== `Played ${attended} of the last 8 games, ${record.streak.type === 'Attended' ? `${record.streak.value} in a row` : 'missed the last one'}`) return false;
  try { assertAttendanceView(seen, { value, attended, missed: 8 - attended }, record.attendance_history, record.last_attended_game); return true; }
  catch { return false; }
}

/** Same suffix rule as linkedCardIdentity: preserve the host's suffix, including its absence. */
export function claimedCardName(hostName: string, bare: string) {
  return bare + (/\.(?:dot|paseo|test|testnet)$/i.exec(hostName)?.[0] ?? '');
}

/** Observation only: retain mutations before and throughout game completion and the next schedule. */
export async function watchNextGame(page: BrowserPage) {
  await page.evaluate(() => {
    const state = window as typeof window & { __humanityNextGameWatch?: { samples: { at: number; value: string; text: string; buttons: string[] }[]; observer: MutationObserver } };
    if (state.__humanityNextGameWatch) throw Error('Next game watch already installed');
    const samples: { at: number; value: string; text: string; buttons: string[] }[] = [];
    // Keep this arrow anonymous through tsx/esbuild serialization (no page-side __name helper).
    const sample = [() => {
      const block = document.querySelector('section[aria-label="Next game"]'); if (!block || !block.getClientRects().length) return;
      const value = block.querySelector('.card-value')?.textContent?.trim() ?? '', text = block.textContent ?? '';
      const buttons = Array.from(block.querySelectorAll('button')).map(b => b.getAttribute('aria-label') ?? b.textContent?.trim() ?? '');
      const last = samples.at(-1); if (last?.text === text && last.value === value) return;
      samples.push({ at: Date.now(), value, text, buttons });
    }][0]!;
    const observer = new MutationObserver(sample); observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
    sample(); state.__humanityNextGameWatch = { samples, observer };
  }, undefined);
}
export async function watchedNextGame(page: BrowserPage) {
  const samples = await page.evaluate(() => {
    const state = window as typeof window & { __humanityNextGameWatch?: { samples: { at: number; value: string; text: string; buttons: string[] }[]; observer: MutationObserver } };
    if (!state.__humanityNextGameWatch) throw Error('Next game watch was lost during navigation');
    return state.__humanityNextGameWatch.samples;
  }, undefined);
  return samples.map(s => ({ ...s, mode: gameMode(s.text, s.buttons) }));
}
export function assertNextGameHistory(samples: Array<{ at: number; mode: string; value: string }>, oldDate: string, newDate: string, nextFinalizedAtMs: number) {
  if (!samples.length || !oldDate || !newDate || oldDate === newDate || !Number.isFinite(nextFinalizedAtMs) || samples.some(s => !Number.isFinite(s.at))) throw Error('Missing distinct dates or next-game watch evidence');
  if (!samples.some(s => s.at >= nextFinalizedAtMs && s.mode === 'registration-open' && s.value === newDate)) throw Error('Watch did not record the next scheduled game');
  if (samples.some(s => s.value === oldDate && (s.mode === 'upcoming' || s.at > nextFinalizedAtMs))) throw Error("Finished game's time appeared as the next game");
}
export async function formattedDate(page: BrowserPage, seconds: number) {
  return page.evaluate(date => new Date(date * 1000).toLocaleString(undefined, { weekday: 'long', hour: 'numeric', minute: '2-digit' }), seconds);
}
export function chainText(value: unknown): string | undefined {
  if (ArrayBuffer.isView(value) && 'BYTES_PER_ELEMENT' in value && value.BYTES_PER_ELEMENT === 1) return new TextDecoder().decode(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
  if (value && typeof value === 'object' && 'asText' in value && typeof value.asText === 'function') return value.asText();
  return undefined;
}

/** Chain evidence uses bigint; Cucumber attachments are JSON rather than SCALE objects. */
export function jsonEvidence(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, (_key, v) => typeof v === 'bigint' ? v.toString() : v));
}

/** Resources and the DotNS gateway keep the name on the linked identity, not the submitter. */
export function fullUsernameMatches(owner: unknown, consumer: unknown, names: unknown, identity: string, bare: string): boolean {
  const full = (consumer as { full_username?: unknown } | undefined)?.full_username;
  const gateway = (names as { full?: { label?: unknown } } | undefined)?.full?.label;
  return typeof owner === 'string' && accountKey(owner) === accountKey(identity) && chainText(full) === bare && chainText(gateway) === bare;
}

/** A4 has a scheduled near-term game; the no-deadline fallback is not evidence of its deadline. */
export function hasCautionDeadline(text: string): boolean {
  return /\bPlay (?:today|tomorrow) to keep it\./.test(text);
}
