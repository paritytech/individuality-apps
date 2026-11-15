// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import js from "@eslint/js";
import tsPlugin from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";

export default [
  js.configs.recommended,
  {
    files: ["src/**/*.ts", "tests/**/*.ts"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: "module",
      },
      globals: {
        console: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        crypto: "readonly",
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
  // The worker is the product's second executable: the headless Pocket card
  // renderer the host boots in a hidden WebView. There is nothing to render into, and
  // `vite.config.ts` carries no react/tailwind plugin, so a UI import here is
  // not a style question - it either fails the build or bloats a bundle the
  // host loads on every boot. Everything it composes comes from
  // `@humanity/shared`; the app package is out of reach by construction (it
  // is not a dependency), and this rule keeps it that way explicitly.
  {
    files: ["src/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["react", "react-dom", "react-dom/*", "react/*", "@tanstack/*"],
              message: "worker is headless: no React, no UI modules; compose @humanity/shared only.",
            },
            {
              group: ["@humanity/app", "@humanity/app/*", "@app/*", "@features/*", "@shared/*"],
              message: "worker is headless: no React, no UI modules; compose @humanity/shared only.",
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
