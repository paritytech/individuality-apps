// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { assertVerificationAfter, type MeasurementWindow } from './timing.ts';

/** Start immutable reads immediately, but never hold the return driver waiting for them. */
export function backgroundVerification<T>(read: () => Promise<T>, now = Date.now) {
  const readStartedAt = now();
  const result = Promise.resolve().then(read).then(
    value => ({ ok: true as const, value, readFinishedAt: now() }),
    error => ({ ok: false as const, error, readFinishedAt: now() }));
  return {
    async after(windows: readonly MeasurementWindow[]) {
      const at = now();
      assertVerificationAfter({ at, done: at }, windows);
      const settled = await result, done = now();
      assertVerificationAfter({ at, done }, windows);
      if (!settled.ok) throw settled.error;
      return { value: settled.value, verification: { at, done, readStartedAt, readFinishedAt: settled.readFinishedAt, excluded: true as const } };
    },
  };
}
