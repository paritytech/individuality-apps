// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import type { NextConfig } from "next";
import { resolveLocalNetwork } from "../../packages/jollity-protocol/src/local-network.mjs";

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

if (process.env.NEXT_PUBLIC_NETWORK_NAME === "local") resolveLocalNetwork(process.env);

// Build stamp for the debug log (lib/debug) — baked from package.json so every
// exported log entry says which build produced it.
const { version } = createRequire(import.meta.url)("./package.json") as { version: string }

// Optional base path — set NEXT_PUBLIC_BASE_PATH when this app is served under
// a sub-path (lib/asset.ts prefixes raw asset paths with it). Unset in normal
// dev/deploy, so this is a no-op there.
const basePath = process.env.NEXT_PUBLIC_BASE_PATH?.replace(/\/$/, "") || undefined

// The npm workspace root (apps/jollity-app is one workspace of it): the
// @jollity/* packages Next transpiles live outside this folder and the
// lockfile and hoisted node_modules sit there, so Turbopack has to see it.
const workspaceRoot = resolve(import.meta.dirname, "../..")

// Next reads .env files from this folder only. An env file at the repository
// root is skipped without a word, and every page then answers 500 for want of
// NEXT_PUBLIC_NETWORK_NAME. Say so (once: build workers load this config again
// and inherit the flag).
if (!process.env.JOLLITY_ROOT_ENV_CHECKED) {
  process.env.JOLLITY_ROOT_ENV_CHECKED = "1"
  const envFiles = [".env", ".env.local", ".env.development", ".env.development.local", ".env.production", ".env.production.local"]
  for (const name of envFiles) {
    if (existsSync(resolve(workspaceRoot, name)) && !existsSync(resolve(import.meta.dirname, name))) {
      console.warn(
        `⚠ found ${resolve(workspaceRoot, name)}; since the jollity move, Next reads env from apps/jollity-app/ — move it there`,
      )
    }
  }
}

const nextConfig: NextConfig = {
  turbopack: { root: workspaceRoot },
  outputFileTracingRoot: workspaceRoot,
  // Static export — the deploy manifest (deploy/bulletin-deploy.config.ts) ships
  // out/ as the app executable; there is no server in the Polkadot host.
  output: "export",
  // The build id names the _next/static/<id>/ folder and is baked into every
  // page. Next picks a random one, so two builds of the same sources would
  // differ. A release build can pass the source hash as
  // NEXT_PUBLIC_APP_VERSION; unset (a local build), Next keeps its random id.
  generateBuildId: async () => process.env.NEXT_PUBLIC_APP_VERSION || null,
  // NEXT_PUBLIC_APP_VERSION defaults to the package version; an env override
  // still wins (set it in CI to stamp a git sha, say).
  env: { NEXT_PUBLIC_APP_VERSION: process.env.NEXT_PUBLIC_APP_VERSION ?? version },
  ...(basePath ? { basePath, assetPrefix: basePath } : {}),
  // isolate build intermediates when asked, so a one-off bundle build does
  // not clobber a running dev server's .next
  ...(process.env.NEXT_DIST_DIR ? { distDir: process.env.NEXT_DIST_DIR } : {}),
  // …and `next dev` writes `<distDir>/types/**` into the tsconfig's `include`
  // (exact-string check, whole file re-serialized), so an isolated dist dir
  // would dirty tsconfig.json on every run. scripts/dev-host.mjs hands each
  // session a generated tsconfig that `extends` the real one and takes the
  // rewrite instead.
  ...(process.env.NEXT_TSCONFIG ? { typescript: { tsconfigPath: process.env.NEXT_TSCONFIG } } : {}),
  // Workspace engines are consumed as TypeScript source (their `main` points
  // at src/), so Next must transpile them.
  transpilePackages: [
    "@individuality/people-chain",
    "@individuality/name-link",
    "@individuality/sign-up",
    "@individuality/game-outcome",
    "@individuality/prize",
    "@jollity/game-chain",
    "@jollity/statement-core",
    "@jollity/protocol",
    "@jollity/collectables",
    "@jollity/worker",
  ],
};

export default nextConfig;
