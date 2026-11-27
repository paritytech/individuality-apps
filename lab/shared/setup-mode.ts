// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { setTimeout as delay } from 'node:timers/promises';
import { BlockNotPinnedError } from 'polkadot-api';

/**
 * How the lab sets up chain state. `full` (unset) is the nightly's real setup: every lab transaction waits for
 * finality, Ada becomes a member through real games and imported games drain one call at a time. `fast` is the pull
 * request legs' setup: lab transactions wait for inclusion and one finality checkpoint closes each setup run, Ada's
 * membership comes from a forced-attendance fixture, and the imported-game drain is one root batch.
 */
export type SetupMode = 'full' | 'fast';
export const SETUP_VARIABLE = 'HUMANITY_SCENARIOS_SETUP';
export function setupMode(value: string | undefined = process.env[SETUP_VARIABLE]): SetupMode {
  if (value === undefined || value === '' || value === 'full') return 'full';
  if (value === 'fast') return 'fast';
  throw Error(`${SETUP_VARIABLE} must be fast or full`);
}

/**
 * polkadot-api's typed reads accept a block hash only while its chainHead subscription pins that block. A finalized
 * hash taken from plain RPC can already be unpinned, or not yet pinned: A4, run 2 attempt 3, failed in GameRepository's
 * "Completed game processing" wait with `BlockNotPinnedError` (chainHead.ts:138). That is the lab's read, not the chain.
 */
export function isUnpinned(error: unknown): boolean {
  return error instanceof BlockNotPinnedError || (error instanceof Error && error.name === 'BlockNotPinnedError') ||
    (error instanceof Error && /\bis not pinned\b/.test(error.message));
}
export const UNPINNED_RETRIES = 5;

/**
 * Run `work` again on an unpinned block after a short pause, at most `limit` more times; any other error, or `retryable`
 * false, throws. An abort of `signal` ends the pause at once.
 */
export async function retryUnpinned<T>(work: () => Promise<T>, options: { limit?: number; retryable?: () => boolean; pauseMs?: number; signal?: AbortSignal } = {}): Promise<T> {
  const limit = options.limit ?? UNPINNED_RETRIES;
  for (let attempt = 0; ; attempt++) {
    try { return await work(); }
    catch (error) { if (!isUnpinned(error) || attempt >= limit || options.retryable?.() === false) throw error; }
    // A block not yet pinned needs the subscription to catch up; an immediate retry would usually miss again.
    await delay(options.pauseMs ?? 1_000, undefined, { signal: options.signal });
  }
}

type Waiting = { waitFor<T>(label: string, read: (at: { at: string }) => Promise<T | undefined>, ms?: number, head?: 'best' | 'finalized'): Promise<T> };
/**
 * The same connection, except that a polled wait treats an unpinned read as "not yet" and polls again on the next,
 * newest head. More than `limit` unpinned reads in a row still fail the wait.
 */
export function unpinnedTolerant<C extends Waiting>(chain: C, limit = UNPINNED_RETRIES): C {
  return new Proxy(chain, {
    get(target, key) {
      if (key === 'waitFor') return <T>(label: string, read: (at: { at: string }) => Promise<T | undefined>, ms?: number, head?: 'best' | 'finalized') => {
        let misses = 0;
        return target.waitFor<T>(label, async at => {
          try { const value = await read(at); misses = 0; return value; }
          catch (error) { if (!isUnpinned(error) || ++misses > limit) throw error; return undefined; }
        }, ms, head);
      };
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}
