// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import architecture from "./tools/eslint-plugin-architecture/index.mjs";
import allowlist from "./tools/eslint-plugin-architecture/allowlist.mjs";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // the Next app is not at the root: @next/next rules look for its pages here
  { settings: { next: { rootDir: "apps/jollity-app/" } } },
  // The architecture rules (apps/jollity-app/AGENTS.md, Architecture rules 0,
  // 1, 5 and 7). They
  // are scoped to the APP surface — app/, components/, lib/ — because that is
  // what the rules govern: scripts/ and packages/ are node tooling and the
  // engines, where papi is the point (so packages/** is deliberately NOT in
  // `files`, and no `allow` entry pretends it is). `allow` names the files a
  // rule applies to; `allowlist` holds the violations we tolerate today, each
  // with a reason.
  {
    files: ["apps/jollity-app/app/**/*.{ts,tsx}", "apps/jollity-app/components/**/*.{ts,tsx}", "apps/jollity-app/lib/**/*.{ts,tsx}"],
    plugins: { architecture },
    rules: {
      "architecture/no-game-chain-value-import": ["error", {
        allow: ["apps/jollity-app/lib/engine.ts"],
        allowlist,
      }],
      "architecture/no-host-sdk-outside-doorways": ["error", {
        // Architecture rule 5's doorways, one for one: lib/host/**,
        // lib/permissions.ts, lib/collectable-art.ts (preimages) and
        // lib/game-source.ts (the one doorway to chain state).
        allow: ["apps/jollity-app/lib/host/**", "apps/jollity-app/lib/permissions.ts", "apps/jollity-app/lib/collectable-art.ts", "apps/jollity-app/lib/game-source.ts"],
        allowlist,
      }],
      "architecture/no-papi-outside-engine": ["error", {
        allow: ["apps/jollity-app/lib/engine.ts"],
        allowlist,
      }],
    },
  },
  {
    // Rule 7 is about TIMED UI, and rule 6 puts the timed UI's brains in lib/:
    // game-session decides the screen, the use-* hooks tick the countdowns. A
    // scope of app/ + components/ alone would watch the pixels and not the
    // brains, so the rule also covers those lib/ modules. It deliberately does
    // NOT cover lib/ as a whole: that is where the clocks themselves live
    // (lib/device-clock.ts, the chain anchor, the rule-3 waits and rule-4
    // reload stamps), and a blanket ban there would flag the code that defines
    // the source clock. See the rule's header and docs/time-and-clocks.md.
    files: [
      "apps/jollity-app/app/**/*.{ts,tsx}",
      "apps/jollity-app/components/**/*.{ts,tsx}",
      "apps/jollity-app/lib/game-session.ts",
      "apps/jollity-app/lib/home-gate.ts",
      // the draw screen's pure reducer: time reaches it only as events
      "apps/jollity-app/lib/draw/draw-screen.ts",
      "apps/jollity-app/lib/use-*.ts",
      "apps/jollity-app/lib/*/use-*.ts",
    ],
    // A test may stamp its own fixtures with the device clock.
    ignores: ["**/*.test.{ts,tsx}"],
    plugins: { architecture },
    rules: {
      "architecture/no-device-clock": ["error", { allowlist }],
    },
  },
  {
    // The prize draw's UI renders and nothing more: the chain, the journey,
    // the idle and telemetry are its host's (lib/draw/draw-screen-host).
    files: ["apps/jollity-app/app/prize-draw/**/*.{ts,tsx}", "apps/jollity-app/components/draw/**/*.{ts,tsx}"],
    plugins: { architecture },
    rules: {
      "architecture/no-chain-in-draw-ui": ["error", { allowlist }],
    },
  },
  {
    // The collectables screen's UI renders and nothing more: the chain, the payoff's
    // journey, storage and telemetry are its host's (lib/collectables/collectables-screen-host).
    files: ["apps/jollity-app/app/collectables/**/*.{ts,tsx}", "apps/jollity-app/components/collectables/**/*.{ts,tsx}"],
    plugins: { architecture },
    rules: {
      "architecture/no-chain-in-collectables-ui": ["error", { allowlist }],
    },
  },
  {
    files: ["apps/jollity-app/lab/**/*.ts", "apps/jollity-app/lab.opening.config.ts", "apps/jollity-app/scripts/lab/**/*.mts", "apps/jollity-app/tests/lab/**/*.ts"],
    rules: { "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }] },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next, at the Next app:
    "apps/jollity-app/.next/**",
    "apps/jollity-app/.next-host-productlab-*/**",
    "apps/jollity-app/out/**",
    "apps/jollity-app/build/**",
    "apps/jollity-app/next-env.d.ts",
    // The worker's build output (git-ignored), written by `npm run build:chat`.
    "apps/jollity-worker/dist/**",
    // The lab's local forks, caches and reports, written at run time.
    "apps/jollity-app/.product-lab/**",
    // The lab has its own Node/TypeScript lint, chained by the root lint script.
    "lab/**",
    // Humanity: its own workspaces and eslint configs (`npm run humanity:lint`).
    "apps/humanity-app/**",
    "apps/humanity-worker/**",
    "packages/humanity-shared/**",
    // the prize draw's own JavaScript, kept in its original style
    // (lib/draw/wheel/proto/README.md); not linted
    "apps/jollity-app/lib/draw/wheel/proto/**",
    // the state-machine explorer's mutants: run-time sibling copies (lib/explorer/mutants/load.ts)
    "apps/jollity-app/lib/**/*.mutant-*.ts",
  ]),
]);

export default eslintConfig;
