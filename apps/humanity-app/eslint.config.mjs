// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import js from "@eslint/js";
import tsPlugin from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";

export default [
  js.configs.recommended,
  {
    files: ["src/**/*.{ts,tsx}", "tests/**/*.{ts,tsx}", "tests/flow/*.test.mts", "lab/**/*.ts", "lab.opening.config.ts", "lab.flow.config.ts", "lab.scenarios.config.ts", "scripts/lab/**/*.mts"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: "module",
        ecmaFeatures: { jsx: true },
      },
      globals: {
        window: "readonly",
        document: "readonly",
        navigator: "readonly",
        localStorage: "readonly",
        crypto: "readonly",
        console: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        TextEncoder: "readonly",
        TextDecoder: "readonly",
        fetch: "readonly",
      },
    },
    plugins: {
      "@typescript-eslint": tsPlugin,
    },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
      "no-undef": "off",
    },
  },
  // The imported runtime metadata code has dynamic pallet shapes; retain upstream's explicit types.
  { files: ["tests/flow/speedups.test.ts"], rules: { "@typescript-eslint/no-explicit-any": "off" } },
  // What is left of the app's own `shared/` is UI: components, hooks, motion,
  // navigation, store, styles and the react-query wrappers. Everything
  // framework-free moved to `@humanity/shared`, but the direction of the
  // dependency is unchanged — shared UI is imported by features and the app
  // shell, never the reverse.
  {
    files: ["src/shared/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@features/*", "@features/**", "**/features/**"],
              message: "shared may not import from features.",
            },
            {
              group: ["@app/*", "@app/**", "**/app/**"],
              message: "shared may not import from app.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/features/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@app/*", "@app/**", "**/app/**"],
              message: "features may not import from app.",
            },
          ],
        },
      ],
    },
  },
  // Layering: prize builds on card, never the reverse — card/ may not import
  // prize/, status/, or app/; prize/ may import card/ but not status/ or app/.
  {
    files: ["src/features/card/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@features/prize/*", "@features/prize/**", "**/features/prize/**"],
              message: "card may not import prize: prize builds on card, never the reverse.",
            },
            {
              group: ["@features/status/*", "@features/status/**", "**/features/status/**"],
              message: "features must not import other features; move shared code to shared/.",
            },
            {
              group: ["@app/*", "@app/**", "**/app/**"],
              message: "features may not import from app.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/features/prize/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@features/status/*", "@features/status/**", "**/features/status/**"],
              message: "features must not import other features; move shared code to shared/.",
            },
            {
              group: ["@app/*", "@app/**", "**/app/**"],
              message: "features may not import from app.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/features/status/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@features/prize/*", "@features/prize/**", "**/features/prize/**"],
              message: "features must not import other features; move shared code to shared/.",
            },
            {
              group: ["@app/*", "@app/**", "**/app/**"],
              message: "features may not import from app.",
            },
          ],
        },
      ],
    },
  },
  // domain/ is the base layer. The upper-layer and app bans are identical for
  // every feature, but the cross-feature ban must name the OTHER feature only
  // — a single shared block listing both would ban a feature's domain from
  // importing its own domain siblings.
  {
    files: ["src/features/prize/**/domain/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["react"],
              message: "domain/ is pure logic — no React, no I/O, and no imports from upper layers.",
            },
            {
              group: [
                "@features/*/pages/*",
                "@features/*/pages/**",
                "**/features/**/pages/**",
                "@features/*/components/*",
                "@features/*/components/**",
                "**/features/**/components/**",
                "@features/*/hooks/*",
                "@features/*/hooks/**",
                "**/features/**/hooks/**",
                "@features/*/chain/*",
                "@features/*/chain/**",
                "**/features/**/chain/**",
              ],
              message: "domain/ is pure logic — no React, no I/O, and no imports from upper layers.",
            },
            {
              group: ["@features/status/*", "@features/status/**", "**/features/status/**"],
              message: "features must not import other features; move shared code to shared/.",
            },
            {
              group: ["@app/*", "@app/**", "**/app/**"],
              message: "features may not import from app.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/features/status/**/domain/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["react"],
              message: "domain/ is pure logic — no React, no I/O, and no imports from upper layers.",
            },
            {
              group: [
                "@features/*/pages/*",
                "@features/*/pages/**",
                "**/features/**/pages/**",
                "@features/*/components/*",
                "@features/*/components/**",
                "**/features/**/components/**",
                "@features/*/hooks/*",
                "@features/*/hooks/**",
                "**/features/**/hooks/**",
                "@features/*/chain/*",
                "@features/*/chain/**",
                "**/features/**/chain/**",
              ],
              message: "domain/ is pure logic — no React, no I/O, and no imports from upper layers.",
            },
            {
              group: ["@features/prize/*", "@features/prize/**", "**/features/prize/**"],
              message: "features must not import other features; move shared code to shared/.",
            },
            {
              group: ["@app/*", "@app/**", "**/app/**"],
              message: "features may not import from app.",
            },
          ],
        },
      ],
    },
  },
  // The worker is the product's second executable, built from its own
  // package: a headless executable the host boots in a hidden WebView.
  // The app never composes it — the two meet in `@humanity/shared` — so an
  // import of the worker here would pull a whole second executable into the
  // page bundle. This one ban applies to every app file, and flat config
  // replaces a rule's options rather than merging them, so it rides on the
  // typescript-eslint variant: sharing `no-restricted-imports` with the
  // layering blocks above would silently switch them off.
  {
    files: ["src/**/*.{ts,tsx}"],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@humanity/worker", "@humanity/worker/**"],
              message: "the app never composes the worker: share code through @humanity/shared.",
            },
          ],
        },
      ],
    },
  },
  {
    ignores: ["node_modules/**", "dist/**", "**/*.js", "**/*.mjs", "**/*.cjs"],
  },
];
