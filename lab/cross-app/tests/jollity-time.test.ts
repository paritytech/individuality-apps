// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { jollityGameAt } from '../jollity-time.ts';

const at = (month: number, day: number, hours: number, minutes: number) => new Date(2026, month, day, hours, minutes).getTime() / 1000;

/** A Jollity page whose device uses `locale` and reads `nowSeconds` on its clock. */
function page(locale: string, nowSeconds: number) {
  return {
    evaluate: (<A, R>(callback: (arg: A) => R, arg: A) => {
      const Original = Intl.DateTimeFormat, originalClock = Date.prototype.toLocaleTimeString;
      vi.useFakeTimers({ now: nowSeconds * 1000, toFake: ['Date'] });
      const localeClock = vi.spyOn(Date.prototype, 'toLocaleTimeString').mockImplementation(function (this: Date, requested, options) { return originalClock.call(this, requested ?? locale, options); });
      Intl.DateTimeFormat = function (requested?: string | string[], options?: Intl.DateTimeFormatOptions) { return new Original(requested ?? locale, options); } as typeof Intl.DateTimeFormat;
      try { return Promise.resolve(new Function('arg', `return (${callback.toString()})(arg)`)(arg)); } finally { localeClock.mockRestore(); Intl.DateTimeFormat = Original; vi.useRealTimers(); }
    }) as never,
  };
}

afterEach(() => vi.useRealTimers());

describe('jollityGameAt mirrors Jollity formatGameAt', () => {
  const now = at(10, 12, 9, 0);

  it('writes today as the clock alone, in the hour cycle of the device', async () => {
    expect(await jollityGameAt(page('en-GB', now), at(10, 12, 16, 5))).toBe('16:05');
    expect(await jollityGameAt(page('en-GB', now), at(10, 12, 0, 7))).toBe('00:07');
    expect(await jollityGameAt(page('en-GB', now), at(10, 12, 12, 0))).toBe('12:00');
    expect(await jollityGameAt(page('en-GB', now), at(10, 12, 7, 0))).toBe('07:00');
    expect(await jollityGameAt(page('en-US', now), at(10, 12, 16, 5))).toBe('4:05 PM');
    expect(await jollityGameAt(page('en-US', now), at(10, 12, 0, 7))).toBe('12:07 AM');
    expect(await jollityGameAt(page('en-US', now), at(10, 12, 12, 0))).toBe('12:00 PM');
  });

  it('names the month and day on another day', async () => {
    expect(await jollityGameAt(page('en-GB', now), at(10, 13, 16, 0))).toBe('Nov 13 at 16:00');
    expect(await jollityGameAt(page('en-US', now), at(0, 2, 9, 5))).toBe('Jan 2 at 9:05 AM');
  });

  it('decides "today" on the page clock, not the lab process clock', async () => {
    expect(await jollityGameAt(page('en-GB', at(10, 13, 9, 0)), at(10, 13, 16, 0))).toBe('16:00');
  });
});

it('serializes the keepNames-transformed helper into the page without a module closure', async () => {
  const source = readFileSync(new URL('../jollity-time.ts', import.meta.url), 'utf8');
  const compiled = transformSync(source.replace('export function', 'function'), { loader: 'ts', keepNames: true, target: 'es2022' }).code;
  const helper = new Function(`${compiled}; return jollityGameAt;`)() as typeof jollityGameAt;
  for (const [hour, minute, expected] of [[0, 7, '00:07'], [12, 0, '12:00']] as const)
    expect(await helper(page('en-GB', at(10, 12, 9, 0)), at(10, 12, hour, minute))).toBe(expected);
});
