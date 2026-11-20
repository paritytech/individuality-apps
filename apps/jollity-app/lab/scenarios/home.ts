// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { setTimeout as delay } from 'node:timers/promises';
import { fail } from '@parity/product-lab';
import type { BrowserPage } from '@parity/product-lab/ports/browser';
import { readWatchedText } from '../../../../lab/shared/watched-text.ts';
export interface HomeObservation { visible: boolean; source: string | null; account: string | null; phase: string | null; registered: string | null; copy: string[] }
export async function observeHome(page: BrowserPage): Promise<HomeObservation | null> {
  return readWatchedText(page, () => {
    const home = document.querySelector('[data-testid="home"]');
    return { visible: Boolean(home?.getClientRects().length), source: home?.getAttribute('data-source') ?? null,
      account: home?.getAttribute('data-account') ?? null, phase: home?.getAttribute('data-state') ?? null,
      registered: home?.getAttribute('data-registered') ?? null,
      copy: Array.from(home?.querySelectorAll('h1, [data-testid="home-status"]') ?? []).filter(el => el.getClientRects().length).map(el => el.textContent?.trim() ?? '') };
  });
}
const states: Record<string, { phases: string[]; copy: string; registered: boolean }> = {
  'no-game': { phases: ['none'], copy: 'No game scheduled', registered: false },
  register: { phases: ['registration'], copy: 'Next game', registered: false },
  unfunded: { phases: ['registration'], copy: 'Top up to play', registered: false },
  registered: { phases: ['registration', 'starting'], copy: "You're in", registered: true },
  missed: { phases: ['starting', 'live'], copy: 'You missed this one', registered: false },
  'wrapping-up': { phases: ['processing'], copy: 'Wrapping up', registered: false },
};
export function assertHome(seen: HomeObservation | null, account: string, expected: string) {
  const rule = states[expected]; if (!rule) throw Error('Unknown DIM2 home state');
  if (!seen?.visible || seen.source !== 'host' || seen.account !== account || !rule.phases.includes(seen.phase ?? '') ||
    seen.registered !== String(rule.registered) || !seen.copy.includes(rule.copy)) fail('screen-mismatch', `DIM2 home does not show ${expected} for its host account`);
}
export function assertHomeChain(expected: string, game: unknown, player: unknown, schedules: unknown, balance: unknown, deposit: unknown) {
  const g = game as { state: { type: string } } | undefined, p = player as { registered?: boolean } | undefined;
  const free = (balance as { data: { free: bigint } }).data.free;
  const matches = expected === 'no-game' ? !g && Array.isArray(schedules) && !schedules.length
    : expected === 'wrapping-up' ? g?.state.type === 'PlayerProcess'
    : expected === 'missed' ? ['Shuffle', 'Reporting'].includes(g?.state.type ?? '') && p?.registered !== true
    // A registered player has paid or holds its deposit, so its free balance says nothing about the seat.
    : expected === 'registered' ? g?.state.type === 'Registration' && p?.registered === true
    : g?.state.type === 'Registration' && p?.registered !== true &&
      (expected === 'unfunded' ? free < BigInt(deposit as bigint) : free >= BigInt(deposit as bigint));
  if (!matches) fail('not-on-chain', `Finalized DIM2 setup does not back ${expected}`);
}
/** The home after a successful sign-up: "You're in" for the host account, registered, with no Register screen copy.
 * The opening's registered check waits for the Register control, which this screen never shows. */
export function isRegisteredHome(seen: HomeObservation | null, account: string) {
  return Boolean(seen?.visible && seen.source === 'host' && seen.account === account && seen.registered === 'true' &&
    seen.copy.includes("You're in") && !seen.copy.includes('Next game') && !seen.copy.includes('Top up to play'));
}
export async function awaitRegisteredHome(observe: () => Promise<HomeObservation | null>, account: string,
  options: { timeoutMs?: number; pollMs?: number; signal?: AbortSignal } = {}) {
  const deadline = Date.now() + (options.timeoutMs ?? 120_000);
  let seen: HomeObservation | null = null;
  do {
    options.signal?.throwIfAborted();
    seen = await observe(); if (isRegisteredHome(seen, account)) return seen!;
    await delay(options.pollMs ?? 500, undefined, { signal: options.signal });
  } while (Date.now() < deadline);
  fail('screen-mismatch', "DIM2 home does not show You're in, registered, for its host account");
}
