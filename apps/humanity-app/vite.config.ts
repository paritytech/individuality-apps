// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/// <reference types="vitest" />
import { loadEnv, defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";

import { resolveLocalNetwork } from "@humanity/shared/config/local-network.ts";

import { appRelease } from "./scripts/app-release.mjs";
import { sentrySourceMaps } from "./scripts/sourcemaps.ts";

const release = appRelease(new URL("./package.json", import.meta.url));

const srcPath = (path: string): string =>
  fileURLToPath(new URL(path, import.meta.url));

/**
 * Dev-only bridge to a local `truapi-host` (the truapi CLI's `dev` flow,
 * installed from paritytech/trinity-user-agents). The host serves a bootstrap snippet that opens a WebSocket to
 * itself, wraps it as a MessagePort and parks it on `window.__HOST_API_PORT__`,
 * which `@parity/product-sdk/host` picks up exactly as inside a real host. The
 * tag is only emitted by `vite dev`, never by a build. Set
 * `VITE_HOST_BRIDGE_URL=off` to run plain dev without it (the SDK then falls
 * back to the public WS endpoint).
 */
function hostBridge(): Plugin {
  return {
    name: "humanity:host-bridge",
    apply: "serve",
    transformIndexHtml() {
      const url =
        process.env["VITE_HOST_BRIDGE_URL"]?.trim() ||
        "http://127.0.0.1:9955/bootstrap.js";
      if (url === "off") return [];
      return [{ tag: "script", attrs: { src: url }, injectTo: "head-prepend" }];
    },
  };
}

/**
 * The generated descriptors' `<chain>_metadata-*.js` files only serve
 * `getTypedCodecs`/`getOfflineApi`, which nothing here calls: the client reads
 * live metadata over the host bridge. The host downloads the tree as one
 * uncompressed archive, so they cost ~6 MB per install for nothing.
 */
function stripStaticMetadata(): Plugin {
  const metadataModule = /\/[a-z_]+_metadata-[\w-]+\.js$/;
  return {
    name: "humanity:strip-static-metadata",
    apply: "build",
    enforce: "pre",
    load(id) {
      if (!metadataModule.test(id)) return null;
      return `throw new Error("static chain metadata is stripped from the Humanity build: ${id
        .split("/")
        .pop()}");`;
    },
  };
}

const config = defineConfig({
  base: "./",
  // Hash routing keeps routes in the URL fragment, so no server-side path
  // fallback is needed; 'mpa' stops Vite from returning HTML for missing
  // hashed asset requests (the default 'spa' fallback would 200 them).
  appType: "mpa",

  define: {
    global: "globalThis",
    // Stamped into Sentry events (`envConfig.telemetry.release`).
    __APP_RELEASE__: JSON.stringify(release),
  },

  plugins: [
    tailwindcss(),
    react(),
    hostBridge(),
    stripStaticMetadata(),
    ...sentrySourceMaps(release),
  ],

  resolve: {
    alias: {
      "@": srcPath("./src"),
      "@app": srcPath("./src/app"),
      "@features": srcPath("./src/features"),
      "@shared": srcPath("./src/shared"),
    },
  },

  build: {
    target: "es2022",
    // Sentry uploads the maps before removing them from the published tree.
    sourcemap: "hidden",
  },

  test: {
    environment: "node",
    include: ["tests/**/*.test.{ts,tsx,mts}"],
    setupFiles: ["tests/setup.ts"],
    // Unit tests are hermetic: they assert logic, not the deploy target. CI
    // exports `VITE_NETWORK=previewnet` for the *build*, and without this pin
    // that value leaks into `envConfig` and flips every derived DotNS name
    // from `.paseo` to `.testnet` mid-suite — green locally, red in CI only.
    // Network-specific behaviour is covered explicitly in
    // `packages/humanity-shared/tests/chain/networks.test.ts`, which passes
    // configs directly.
    env: {
      VITE_NETWORK: "paseo-next-v2",
      VITE_DOTNS_PRODUCT_LABEL: "peopl",
    },
  },
});

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, fileURLToPath(new URL(".", import.meta.url)), "VITE_");
  if (mode !== "test" && env["VITE_NETWORK"]?.trim() === "local") resolveLocalNetwork(env);
  return config;
});
