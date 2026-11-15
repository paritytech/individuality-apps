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
  // This package is the code both executables run - the app in a page, the
  // worker in a hidden WebView with no DOM. A React or app import here
  // is not a style question: it either fails the worker build or drags a UI
  // framework into a bundle the host loads on every boot. Hooks and
  // components that read this code live in the app, next to the screens
  // that render them.
  {
    files: ["src/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["react", "react-dom", "react-dom/*", "react/*", "@tanstack/*"],
              message:
                "shared is framework-free: React and react-query belong in the app package.",
            },
            {
              group: ["@app/*", "@app/**", "@features/*", "@features/**", "@shared/*", "@shared/**"],
              message:
                "shared may not reach back into the app; import siblings as @humanity/shared/<dir>/<file>.ts.",
            },
          ],
        },
      ],
    },
  },
  {
    ignores: ["node_modules/**", ".papi/**", "**/*.js", "**/*.mjs", "**/*.cjs"],
  },
];
