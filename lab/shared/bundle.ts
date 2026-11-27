// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/** npm 0.1.0 otherwise prefetches a newer bundle even when a local run asks to keep it.
 * This explicit consumer shim blocks only Engine asset reads, never application traffic.
 * Remove after the released framework honours PRODUCT_LAB_FORK_BUNDLE=keep.
 */
export function bundleAsset(input: string | URL | Request): boolean {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  const path = decodeURIComponent(url.pathname).toLowerCase();
  return ["objects.githubusercontent.com", "release-assets.githubusercontent.com"].includes(host) ||
    (host === "github.com" && path.startsWith("/paritytech/previewnet-engine/releases/download/")) ||
    (host === "api.github.com" && path.startsWith("/repos/paritytech/previewnet-engine/releases/assets/"));
}
export function keepBundle(): void {
  if (process.env.PRODUCT_LAB_FORK_BUNDLE !== "keep") return;
  const original = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    if (bundleAsset(input)) return Promise.reject(new Error("Kept Engine bundle: no newer asset is read"));
    return original(input, init);
  };
}
