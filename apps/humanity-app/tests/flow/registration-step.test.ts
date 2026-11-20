// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
it('executes the real three-player registration step against delayed synthetic UI and finalized reads', () => {
  const fixture = fileURLToPath(new URL('./fixtures/registration-sequence.mts', import.meta.url));
  expect(execFileSync('node', ['--import', 'tsx', fixture], { encoding: 'utf8', timeout: 30_000 })).toContain('actual registration group: delayed permission and enabled control pass; one registration click per actor');
}, 35_000);
