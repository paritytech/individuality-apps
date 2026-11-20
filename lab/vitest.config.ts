// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';
import { humanityRoot } from './shared/paths.ts';
export default defineConfig({
  resolve: { alias: { '@': resolve(humanityRoot, 'src'), '@app': resolve(humanityRoot, 'src/app'), '@features': resolve(humanityRoot, 'src/features'), '@shared': resolve(humanityRoot, 'src/shared') } },
  test: { include: ['cross-app/tests/**/*.test.ts', 'tests/**/*.test.ts'], maxWorkers: 2,
    env: { VITE_NETWORK: 'paseo-next-v2', VITE_DOTNS_PRODUCT_LABEL: 'peopl' } },
});
