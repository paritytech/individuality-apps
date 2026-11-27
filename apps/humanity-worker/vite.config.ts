// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/// <reference types="vitest" />
import { loadEnv, defineConfig } from "vite";
import { fileURLToPath, URL } from "node:url";

import { resolveLocalNetwork } from "@humanity/shared/config/local-network.ts";

import { appRelease } from "../humanity-app/scripts/app-release.mjs";

// Both executables ship together and must read the same network settings.
const envDir = fileURLToPath(new URL("../humanity-app", import.meta.url));

/**
 * Build config for the worker - the SECOND executable the deploy
 * manifest ships (`apps/humanity-app/deploy/bulletin-deploy.config.ts`), alongside the app's
 * `dist/`. The host boots it to draw the Pocket card, in a hidden
 * WebView: no DOM to render into, no user gesture, just the host API.
 *
 * Five properties are load-bearing:
 *
 *  - **A plain build, NOT `build.lib`.** Lib mode is the obvious fit for a
 *    single-entry bundle, and it is the wrong one here. Vite deliberately
 *    skips whitespace minification for lib `es` output (it assumes a consumer
 *    bundler will do it), so every source comment shipped to the host, and it
 *    does not apply the app-build `process.env.NODE_ENV` replacement. The
 *    second one is fatal: `process` is undefined in the host WebView, so a
 *    dependency's `if (process.env.NODE_ENV === "production")` throws at
 *    module init and kills the worker on boot. A regular build with an
 *    explicit `rolldownOptions.input`/`output` minifies and substitutes
 *    NODE_ENV while still producing the same single file.
 *  - **One entry, one file.** `src/main.ts` -> `dist/index.js`. The manifest
 *    names the file by path (`entrypoint: "index.js"`), and the host fetches
 *    exactly that one path, so the bundle must be a SINGLE ESM file:
 *    `entryFileNames` + `codeSplitting: false` leave no sibling chunk behind,
 *    which a chunked build would silently need and fail to load.
 *  - **ASCII output.** The host reads worker JS as Latin-1, which mangles any
 *    multi-byte character. `charset: "ascii"` escapes them instead, and
 *    `legalComments: "none"` drops dependency banners that would otherwise
 *    survive minification. Worker source is plain ASCII by convention; this is
 *    the backstop for anything a dependency drags in. Both are esbuild
 *    options, so the worker keeps `minify: "esbuild"` (and declares `esbuild`
 *    itself, an optional peer of Vite 8): Vite 8's default Oxc minifier has
 *    no ASCII mode and leaves multi-byte characters in the output.
 *  - **No plugins, no aliases.** The worker is headless, so JSX and CSS have
 *    no business in its bundle, and everything it composes is imported from
 *    `@humanity/shared` as a workspace dependency - Vite follows the
 *    workspace symlink and compiles that package's TypeScript source in
 *    place, so there is nothing to alias.
 *  - **`@novasamatech/host-api-wrapper` stays external.** product-sdk-host's
 *    `getChatManager` falls back to `import("@novasamatech/host-api-wrapper")`
 *    for a native host with no truAPI client. `codeSplitting: false` would
 *    pull that module into the file and evaluate it at bundle load, not at
 *    the `import()`, and the wrapper's module scope builds a sandbox
 *    transport that, on a host that marks the WebView
 *    (`__HOST_WEBVIEW_MARK__`), assigns the host's MessagePort `onmessage`
 *    (`dist/sandboxTransport.js`). That replaces truAPI's handler on the same
 *    port, so every host answer is dropped: on Polkadot Desktop and the
 *    native containers `drawCard` never settles and the Pocket card is never
 *    drawn. Kept external, the `import()` stays a real lazy import of a
 *    bare specifier that runs only if that fallback is ever chosen, which a
 *    host that hands over a port or injects a client never reaches. Nothing
 *    in the worker imports the wrapper statically; one that did would leave
 *    a top-level bare `import` the host cannot resolve, killing the module.
 */
const config = defineConfig({
  base: "./",
  envDir,

  define: {
    global: "globalThis",
    // Stamped into Sentry events (`envConfig.telemetry.release`).
    __APP_RELEASE__: JSON.stringify(appRelease(new URL("./package.json", import.meta.url))),
  },

  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
    sourcemap: true,
    minify: "esbuild",
    rolldownOptions: {
      input: fileURLToPath(new URL("./src/main.ts", import.meta.url)),
      external: ["@novasamatech/host-api-wrapper"],
      output: {
        entryFileNames: "index.js",
        codeSplitting: false,
        format: "es",
      },
    },
  },

  esbuild: {
    target: "es2022",
    charset: "ascii",
    legalComments: "none",
  },

  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    env: {
      VITE_NETWORK: "paseo-next-v2",
      VITE_DOTNS_PRODUCT_LABEL: "peopl",
    },
  },
});

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, envDir, "VITE_");
  if (mode !== "test" && env["VITE_NETWORK"]?.trim() === "local") resolveLocalNetwork(env);
  const network = env["VITE_NETWORK"]?.trim() || "paseo-next-v2";
  return {
    ...config,
    define: { ...config.define, __WORKER_PASEO__: JSON.stringify(network === "paseo-next-v2") },
  };
});
