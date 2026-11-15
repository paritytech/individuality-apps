// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { defineConfig } from "vitest/config"

// The state-machine explorer's own runs (lib/explorer): on demand only, never
// in PR CI. vitest.lib.config.ts excludes lib/explorer/**, so test:lib never
// picks these up; they run only through this file.
export default defineConfig({
  test: {
    include: ["lib/explorer/**/*.{test,explore}.ts"],
    env: { NEXT_PUBLIC_NETWORK_NAME: "paseo" },
    // No per-test timeout: a deep search runs for hours, and --budget-min (or
    // no budget at all) decides when it stops. A 3 h cap here silently killed
    // shards of a --budget-min 600 run on 29 Oct.
    testTimeout: 0,
    hookTimeout: 10 * 60 * 1000,
  },
})
