// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
const root = resolve(import.meta.dirname, '../../../..');
// lab/shared/post-game.ts keeps the browser read twice: chestObservation for Humanity's realm test and readChest's
// inline callback for the browser-body guard. Under tsx, both must read the same page the same way.
it('runs readChest inline browser read and chestObservation on the same page fixtures', () => {
  expect(execFileSync(process.execPath, ['--import', 'tsx', resolve(import.meta.dirname, 'fixtures/chest-read-parity.mts')], { cwd: root, encoding: 'utf8', timeout: 30_000 }))
    .toContain("readChest's inline read equals chestObservation on 5 page fixtures");
}, 35_000);
// chest-read-parity.mts copies Humanity's DOM fixture rather than importing Humanity at runtime. A change there must be
// copied here: update fixtures/chest-read-parity.mts to match, then this digest.
it("pins the Humanity chest-observation fixture that the parity fixture copies", () => {
  const humanity = readFileSync(resolve(root, 'apps/humanity-app/tests/flow/fixtures/chest-observation.mts'));
  expect(createHash('sha256').update(humanity).digest('hex'), 'Humanity chest fixture changed: copy it into fixtures/chest-read-parity.mts and re-pin')
    .toBe('c3912fab2a337592761077befeeaa23c0884cfb0a16b0dbe8984483a1d3ac080');
});
