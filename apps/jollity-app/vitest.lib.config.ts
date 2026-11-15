// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { fileURLToPath } from "node:url"
import { configDefaults, defineConfig } from "vitest/config"

// `npm run test:lib` passes this file with --config. It is NOT named
// vitest.config.ts on purpose: vitest walks up from a workspace package with no
// config of its own and would pick that file up, scoping its tests to lib/.
// The packages run with -w; this one only serves the app's lib/.
export default defineConfig({
  // the app's own `@/` (tsconfig.json paths), for a test that renders a page or
  // a component, which import through it
  resolve: { alias: { "@": fileURLToPath(new URL(".", import.meta.url)) } },
  test: {
    include: ["lib/**/*.test.{ts,tsx}"],
    // the state-machine explorer runs on demand only (vitest.explore.config.ts)
    exclude: [...configDefaults.exclude, "lib/explorer/**"],
    // @jollity/protocol throws at import without a network; pinned here so a
    // build variable in the environment (CI, a dev shell) cannot change what
    // the tests see.
    env: { NEXT_PUBLIC_NETWORK_NAME: "paseo" },
  },
})
