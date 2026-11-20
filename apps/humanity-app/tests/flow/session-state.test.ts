// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('shares the owned flow between the real config loader and the next custom step', () => {
  const fixture = fileURLToPath(new URL('./fixtures/session-sequence.mts', import.meta.url));
  const output = execFileSync('node', ['--import', 'tsx', fixture], { encoding: 'utf8', timeout: 30_000 });
  expect(output).toContain('actual zero-PAS step shares config/ESM owned state');
  expect(output).toContain('missing or closed owned flow still rejected');
}, 35_000);
