// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/// <reference types="vitest" />
import { defineConfig } from "vite";

/**
 * Vitest only: `@humanity/shared` is consumed as TypeScript source by the
 * app and the worker, each of which bundles it with its own Vite
 * config. Nothing here is built.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    setupFiles: ["tests/setup.ts"],
    // Unit tests are hermetic: they assert logic, not the deploy target. CI
    // exports a branch-derived `VITE_NETWORK` for the *build*, and without
    // this pin that value leaks into `envConfig` and flips every derived
    // DotNS name from `.paseo` to `.testnet` mid-suite. Network-specific
    // behaviour is covered explicitly in `tests/chain/networks.test.ts`.
    env: {
      VITE_NETWORK: "paseo-next-v2",
      VITE_DOTNS_PRODUCT_LABEL: "peopl",
    },
  },
});
