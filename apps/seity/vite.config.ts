// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

/**
 * Dev-only bridge to a local `truapi-host`, as in Humanity's vite config: the
 * host serves a bootstrap script that parks a MessagePort on
 * `window.__HOST_API_PORT__`, which `@parity/product-sdk/host` picks up as it
 * would inside a real host. `scripts/dev-host.mjs` points it at its host.
 * `VITE_HOST_BRIDGE_URL=off` runs plain dev without it.
 */
function hostBridge(): Plugin {
  return {
    name: "seity:host-bridge",
    apply: "serve",
    transformIndexHtml() {
      const url = process.env["VITE_HOST_BRIDGE_URL"]?.trim() || "http://127.0.0.1:9965/bootstrap.js";
      if (url === "off") return [];
      return [{ tag: "script", attrs: { src: url }, injectTo: "head-prepend" }];
    },
  };
}

export default defineConfig({
  base: "./",
  appType: "mpa",
  define: { global: "globalThis" },
  plugins: [react(), hostBridge()],
  build: { target: "es2022" },
});
