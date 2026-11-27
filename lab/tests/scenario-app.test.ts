// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { AppDevServer } from '@parity/product-lab/domain/apps';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { humanityRoot, repositoryRoot } from '../shared/paths.ts';
import { scenarioApp } from '../shared/scenario-app.ts';

// The Humanity scenario session serves this declaration from humanityRoot; product-lab refuses an absolute cwd.
it('declares a dev server product-lab accepts, run from the repository root', () => {
  expect(() => AppDevServer.parse('peopl', scenarioApp)).not.toThrow();
  expect(resolve(humanityRoot, scenarioApp.cwd)).toBe(resolve(repositoryRoot));
});
