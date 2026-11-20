// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { journeyBreakdown } from '../timing.ts';
vi.mock('../../shared/session.ts', () => ({ scenario: () => ({ context: { root: '.' } }) }));
const { save } = await import('../steps.ts');

it('saves real receipt bigint fields and rejects a malformed negative control before writing', () => {
  const directory = mkdtempSync(join(process.cwd(), '.cross-app-save-'));
  vi.stubEnv('CROSS_APP_TIMINGS_DIR', directory);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    const value = journeyBreakdown({ direction: 'C4', run: '1', reader: { app: 'Humanity', head: 'finalized', how: 'poll' }, start: 100, end: 200, points: [] });
    save(value, { chainEvent: { ref_time: 123456789n }, rendered: 200 });
    const file = join(directory, 'timings.jsonl'), before = readFileSync(file, 'utf8');
    expect(JSON.parse(before).raw).toEqual({ chainEvent: { ref_time: '123456789' }, rendered: 200 });
    expect(readFileSync(join(directory, 'comment.md'), 'utf8')).toContain('0.100 s (ok)');
    expect(() => save({ ...value, totalMs: 101 }, {})).toThrow('parts add up');
    expect(() => save(value, { finalized: Infinity })).toThrow('Non-finite');
    expect(readFileSync(file, 'utf8')).toBe(before);
  } finally {
    vi.unstubAllEnvs(); vi.restoreAllMocks(); rmSync(directory, { recursive: true, force: true });
  }
});
